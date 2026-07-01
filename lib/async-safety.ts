/**
 * Async Safety Wrapper
 * 
 * Provides comprehensive error handling, retry logic, and timeout protection
 * for async operations throughout the system
 */

import ProductionErrorHandler from './error-handling-production'

export interface AsyncSafetyOptions {
  name: string
  retries?: number
  timeoutMs?: number
  backoffMultiplier?: number
  onError?: (error: Error) => void | Promise<void>
  fallback?: any
  logErrors?: boolean
}

export interface AsyncSafetyResult<T> {
  success: boolean
  data?: T
  error?: Error
  attempts: number
  duration: number
  fallbackUsed: boolean
}

/**
 * Safe async execution with error handling, retries, and timeout
 * 
 * @example
 * ```typescript
 * const result = await safeAsync(
 *   () => fetchData(),
 *   {
 *     name: 'fetchData',
 *     retries: 3,
 *     timeoutMs: 5000,
 *     fallback: { data: [] }
 *   }
 * )
 * ```
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  options: AsyncSafetyOptions
): Promise<AsyncSafetyResult<T>> {
  const {
    name,
    retries = 1,
    timeoutMs = 30000,
    backoffMultiplier = 2,
    onError,
    fallback,
    logErrors = true
  } = options

  const startTime = Date.now()
  let lastError: Error | null = null
  let attempts = 0

  for (let attempt = 0; attempt <= retries; attempt++) {
    attempts++

    try {
      // Wrap in Promise.race for timeout protection
      const result = await Promise.race([
        fn(),
        new Promise<T>((_, reject) =>
          setTimeout(
            () => reject(new Error(`[${name}] Timeout after ${timeoutMs}ms`)),
            timeoutMs
          )
        )
      ])

      if (logErrors && attempt > 0) {
        console.log(
          `[ASYNC] ${name} succeeded on attempt ${attempt + 1} after ${Date.now() - startTime}ms`
        )
      }

      return {
        success: true,
        data: result,
        attempts,
        duration: Date.now() - startTime,
        fallbackUsed: false
      }
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (logErrors) {
        console.warn(
          `[ASYNC] ${name} attempt ${attempt + 1}/${retries + 1} failed:`,
          lastError.message
        )
      }

      // If this was the last attempt, check for fallback
      if (attempt === retries) {
        // Log to console (ProductionErrorHandler will catch it if needed)
        console.error(`[ASYNC_SAFETY] ${name} failed after retries:`, {
          message: lastError.message,
          stack: lastError.stack,
          severity: 'high'
        })

        // Call error callback if provided
        if (onError) {
          try {
            await onError(lastError)
          } catch (callbackError) {
            console.error(`[ASYNC] Error callback for ${name} failed:`, callbackError)
          }
        }

        // Use fallback if available
        if (fallback !== undefined) {
          if (logErrors) {
            console.warn(`[ASYNC] ${name} using fallback value`)
          }
          return {
            success: false,
            data: fallback,
            error: lastError,
            attempts,
            duration: Date.now() - startTime,
            fallbackUsed: true
          }
        }

        // Throw error if no fallback
        return {
          success: false,
          error: lastError,
          attempts,
          duration: Date.now() - startTime,
          fallbackUsed: false
        }
      }

      // Exponential backoff before retry (reduced from 1000ms base for second-trading)
      if (attempt < retries) {
        const backoffMs = Math.min(100 * Math.pow(backoffMultiplier, attempt), 500)
        if (logErrors) {
          console.log(`[ASYNC] ${name} waiting ${backoffMs}ms before retry...`)
        }
        await new Promise(r => setTimeout(r, backoffMs))
      }
    }
  }

  // Fallback case (should not reach here)
  return {
    success: false,
    error: lastError || new Error(`[${name}] Unknown error`),
    attempts,
    duration: Date.now() - startTime,
    fallbackUsed: false
  }
}

/**
 * Safer async execution - returns null on error instead of throwing
 */
export async function safeSilent<T>(
  fn: () => Promise<T>,
  options: Omit<AsyncSafetyOptions, 'onError'>
): Promise<T | null> {
  const result = await safeAsync(fn, { ...options, onError: undefined })
  return result.success ? result.data ?? null : null
}

/**
 * Batch execution with concurrency control
 * Processes items with a maximum number of concurrent operations
 */
export async function batchAsyncWithConcurrency<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  options: {
    concurrency?: number
    name: string
    timeoutMs?: number
    continueOnError?: boolean
  }
): Promise<AsyncSafetyResult<R[]>> {
  const { concurrency = 5, name, timeoutMs = 30000, continueOnError = false } = options

  const results: R[] = []
  const errors: Error[] = []
  const startTime = Date.now()

  // Process in batches
  for (let i = 0; i < items.length; i += concurrency) {
    const batch = items.slice(i, i + concurrency)

    const batchPromises = batch.map(async (item, idx) => {
      try {
        const result = await Promise.race([
          fn(item),
          new Promise<R>((_, reject) =>
            setTimeout(
              () => reject(new Error(`[${name}] Item ${i + idx} timeout after ${timeoutMs}ms`)),
              timeoutMs
            )
          )
        ])
        results.push(result)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        errors.push(err)

        if (!continueOnError) {
          throw error
        }
      }
    })

    try {
      await Promise.all(batchPromises)
    } catch (error) {
      if (!continueOnError) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
          attempts: 1,
          duration: Date.now() - startTime,
          fallbackUsed: false
        }
      }
    }
  }

  if (errors.length > 0 && !continueOnError) {
    return {
      success: false,
      error: errors[0],
      attempts: 1,
      duration: Date.now() - startTime,
      fallbackUsed: false
    }
  }

  return {
    success: errors.length === 0,
    data: results,
    error: errors.length > 0 ? errors[0] : undefined,
    attempts: 1,
    duration: Date.now() - startTime,
    fallbackUsed: false
  }
}

/**
 * Retry async operation with exponential backoff
 */
export async function retryAsync<T>(
  fn: () => Promise<T>,
  maxAttempts: number = 3,
  delayMs: number = 1000
): Promise<T> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))

      if (attempt < maxAttempts - 1) {
        const delay = delayMs * Math.pow(2, attempt)
        await new Promise(r => setTimeout(r, delay))
      }
    }
  }

  throw lastError || new Error('Max retry attempts exceeded')
}

/**
 * Promise with timeout
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operationName: string = 'operation'
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(
        () => reject(new Error(`[${operationName}] Timeout after ${timeoutMs}ms`)),
        timeoutMs
      )
    )
  ])
}

/**
 * Debounce async function
 */
export function debounceAsync<T extends any[], R>(
  fn: (...args: T) => Promise<R>,
  delayMs: number = 300
): (...args: T) => Promise<R | null> {
  let timeoutId: NodeJS.Timeout | null = null
  let lastPromise: Promise<R | null> | null = null

  return async (...args: T) => {
    // Cancel previous timeout
    if (timeoutId) {
      clearTimeout(timeoutId)
    }

    return new Promise<R | null>((resolve) => {
      timeoutId = setTimeout(async () => {
        try {
          const result = await fn(...args)
          lastPromise = Promise.resolve(result)
          resolve(result)
        } catch (error) {
          console.error('[DEBOUNCE] Async function error:', error)
          resolve(null)
        }
      }, delayMs)
    })
  }
}

/**
 * Async queue processor
 * Processes items one at a time in order
 */
export class AsyncQueue<T, R> {
  private queue: T[] = []
  private processing = false
  private results: R[] = []

  constructor(
    private processor: (item: T) => Promise<R>,
    private onError: (error: Error, item: T) => void = () => {}
  ) {}

  /**
   * Add item to queue
   */
  async enqueue(item: T): Promise<void> {
    this.queue.push(item)
    await this.process()
  }

  /**
   * Add multiple items
   */
  async enqueueMultiple(items: T[]): Promise<void> {
    this.queue.push(...items)
    await this.process()
  }

  /**
   * Process queue
   */
  private async process(): Promise<void> {
    if (this.processing) return

    this.processing = true

    while (this.queue.length > 0) {
      const item = this.queue.shift()!

      try {
        const result = await this.processor(item)
        this.results.push(result)
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error))
        this.onError(err, item)
      }
    }

    this.processing = false
  }

  /**
   * Get results
   */
  getResults(): R[] {
    return [...this.results]
  }

  /**
   * Clear results
   */
  clearResults(): void {
    this.results = []
  }

  /**
   * Get queue size
   */
  getQueueSize(): number {
    return this.queue.length
  }

  /**
   * Is processing
   */
  isProcessing(): boolean {
    return this.processing
  }
}

export default safeAsync
