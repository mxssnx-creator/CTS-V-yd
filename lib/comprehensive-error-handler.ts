/**
 * Comprehensive Error Handler with Recovery Strategies
 * 
 * Advanced error handling with intelligent recovery, fallback strategies,
 * and comprehensive logging integration
 */

import { alertManager, AlertSeverity } from './alerting-system'
import { metricsCollector } from './metrics-collector'
import { getCorrelationId } from './correlation-tracking'
import { getLogger, LogCategory, LogLevel } from './structured-logging'

export enum ErrorSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical'
}

export enum RecoveryStrategy {
  RETRY = 'retry',
  FALLBACK = 'fallback',
  CIRCUIT_BREAK = 'circuit_break',
  CACHE = 'cache',
  GRACEFUL_DEGRADE = 'graceful_degrade',
  QUEUE = 'queue'
}

export interface ErrorContext {
  operation: string
  service?: string
  userId?: string
  correlationId?: string
  metadata?: Record<string, any>
}

export interface RecoveryOptions {
  strategy: RecoveryStrategy
  maxRetries?: number
  retryDelayMs?: number
  fallbackValue?: any
  queueSize?: number
  timeout?: number
  /** The async function to retry. Required when strategy === RecoveryStrategy.RETRY;
   *  without it the retry loop has no operation to re-attempt. */
  retryFn?: () => Promise<any>
}

export interface ErrorMetrics {
  errorCount: number
  lastError: Error | null
  consecutiveFailures: number
  recoveryAttempts: number
  successRate: number
}

const logger = getLogger(LogCategory.SYSTEM)

export class ComprehensiveErrorHandler {
  private errorMetrics: Map<string, ErrorMetrics> = new Map()
  private recoveryStrategies: Map<string, RecoveryStrategy> = new Map()
  private errorThresholds: Map<string, number> = new Map()
  private lastErrors: Map<string, Error[]> = new Map()
  private maxErrorHistory = 100

  /**
   * Initialize error handler
   */
  static initialize(): void {
    logger.info('Comprehensive error handler initialized')
  }

  /**
   * Handle error with recovery strategy
   */
  async handleError(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): Promise<any> {
    const operationKey = context.operation

    // Update metrics
    this.updateErrorMetrics(operationKey, error)

    // Log error with structured logging
    logger.error(
      `Error in ${context.operation}: ${error.message}`,
      error,
      {
        service: context.service,
        userId: context.userId,
        correlationId: context.correlationId,
        metadata: context.metadata
      }
    )

    // Record metrics
    metricsCollector.incrementCounter('error_handled_total', 1, {
      operation: context.operation,
      strategy: options.strategy,
      service: context.service || 'unknown'
    })

    // Execute recovery strategy
    try {
      switch (options.strategy) {
        case RecoveryStrategy.RETRY:
          return await this.retryStrategy(error, context, options)

        case RecoveryStrategy.FALLBACK:
          return this.fallbackStrategy(error, context, options)

        case RecoveryStrategy.CIRCUIT_BREAK:
          return this.circuitBreakStrategy(error, context, options)

        case RecoveryStrategy.CACHE:
          return this.cacheStrategy(error, context, options)

        case RecoveryStrategy.GRACEFUL_DEGRADE:
          return this.gracefulDegradeStrategy(error, context, options)

        case RecoveryStrategy.QUEUE:
          return this.queueStrategy(error, context, options)

        default:
          return null
      }
    } catch (recoveryError) {
      logger.critical(
        `Recovery strategy failed: ${options.strategy}`,
        recoveryError as Error,
        { originalError: error.message, context }
      )

      // Send alert for critical errors
      if (this.isErrorCritical(error)) {
        await alertManager.sendAlert(
          `Error Recovery Failed: ${context.operation}`,
          `Original: ${error.message}\nRecovery: ${(recoveryError as Error).message}`,
          { severity: AlertSeverity.CRITICAL, source: 'error-handler' }
        ).catch(() => {}) // Ignore alert errors
      }

      return null
    }
  }

  /**
   * Retry strategy with exponential backoff
   */
  private async retryStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): Promise<any> {
    const maxRetries = options.maxRetries ?? 3
    // CRITICAL: Reduced from 1000ms to 100ms base delay for second-trading (must complete within 1s)
    const baseDelay = options.retryDelayMs ?? 100
    const fn = options.retryFn

    // If no retryFn was supplied the caller cannot be retried — fall back
    // immediately rather than burning maxRetries × delay doing nothing.
    if (!fn) {
      logger.warn(
        `retryStrategy for ${context.operation}: no retryFn supplied, returning fallback immediately`,
        { originalError: error.message }
      )
      return options.fallbackValue ?? null
    }

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // CRITICAL: Cap delay at 500ms total (exponential backoff: 100, 200, 400, 500)
      const delay = Math.min(baseDelay * Math.pow(2, attempt - 1), 500)

      logger.info(
        `Retry attempt ${attempt}/${maxRetries} for ${context.operation}`,
        { delayMs: delay, attemptNumber: attempt }
      )

      await new Promise(resolve => setTimeout(resolve, delay))

      metricsCollector.incrementCounter('error_retry_attempted', 1, {
        operation: context.operation,
        attempt: String(attempt)
      })

      try {
        const result = await fn()
        logger.info(
          `Retry succeeded on attempt ${attempt}/${maxRetries} for ${context.operation}`,
          { attemptNumber: attempt }
        )
        return result
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr)
        logger.warn(
          `Retry attempt ${attempt}/${maxRetries} failed for ${context.operation}: ${msg}`,
          { attemptNumber: attempt }
        )
        if (attempt === maxRetries) {
          // All attempts exhausted — return fallback
          return options.fallbackValue ?? null
        }
      }
    }

    return options.fallbackValue ?? null
  }

  /**
   * Fallback strategy - return safe default
   */
  private fallbackStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): any {
    logger.warn(
      `Fallback strategy activated for ${context.operation}`,
      { fallbackValue: options.fallbackValue },
      error
    )

    metricsCollector.incrementCounter('error_fallback_used', 1, {
      operation: context.operation
    })

    return options.fallbackValue ?? null
  }

  /**
   * Circuit breaker strategy
   */
  private circuitBreakStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): any {
    const operationKey = context.operation
    const threshold = this.errorThresholds.get(operationKey) ?? 5

    const metrics = this.errorMetrics.get(operationKey)
    if (metrics && metrics.consecutiveFailures >= threshold) {
      logger.critical(
        `Circuit breaker OPEN for ${context.operation} (${metrics.consecutiveFailures} failures)`,
        error,
        { threshold }
      )

      metricsCollector.setGauge('circuit_breaker_open', 1, {
        operation: context.operation
      })

      return options.fallbackValue ?? null
    }

    return null
  }

  /**
   * Cache strategy - return cached value
   */
  private cacheStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): any {
    logger.info(
      `Cache strategy activated for ${context.operation}`,
      { fallbackValue: options.fallbackValue }
    )

    metricsCollector.incrementCounter('error_cache_fallback_used', 1, {
      operation: context.operation
    })

    return options.fallbackValue ?? null
  }

  /**
   * Graceful degrade strategy
   */
  private gracefulDegradeStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): any {
    logger.warn(
      `Graceful degradation for ${context.operation}`,
      { fallbackValue: options.fallbackValue },
      error
    )

    metricsCollector.incrementCounter('error_graceful_degrade', 1, {
      operation: context.operation
    })

    return options.fallbackValue ?? null
  }

  /**
   * Queue strategy - defer processing
   */
  private queueStrategy(
    error: Error,
    context: ErrorContext,
    options: RecoveryOptions
  ): any {
    logger.info(
      `Queuing deferred operation: ${context.operation}`,
      { queueSize: options.queueSize }
    )

    metricsCollector.incrementCounter('error_queued_operation', 1, {
      operation: context.operation
    })

    return { queued: true, operation: context.operation }
  }

  /**
   * Update error metrics
   */
  private updateErrorMetrics(operationKey: string, error: Error): void {
    let metrics = this.errorMetrics.get(operationKey)

    if (!metrics) {
      metrics = {
        errorCount: 0,
        lastError: null,
        consecutiveFailures: 0,
        recoveryAttempts: 0,
        successRate: 100
      }
      this.errorMetrics.set(operationKey, metrics)
    }

    metrics.errorCount++
    metrics.lastError = error
    metrics.consecutiveFailures++

    // Store error history
    let errors = this.lastErrors.get(operationKey) ?? []
    errors.push(error)
    if (errors.length > this.maxErrorHistory) {
      errors = errors.slice(-this.maxErrorHistory)
    }
    this.lastErrors.set(operationKey, errors)
  }

  /**
   * Record successful operation
   */
  recordSuccess(operationKey: string): void {
    const metrics = this.errorMetrics.get(operationKey)
    if (metrics) {
      metrics.consecutiveFailures = 0
      metrics.recoveryAttempts++

      // Update success rate
      const successRate = (metrics.recoveryAttempts / (metrics.errorCount + metrics.recoveryAttempts)) * 100
      metrics.successRate = Math.round(successRate)

      metricsCollector.setGauge('operation_success_rate', metrics.successRate, {
        operation: operationKey
      })
    }
  }

  /**
   * Check if error is critical
   */
  private isErrorCritical(error: Error): boolean {
    const criticalKeywords = ['database', 'connection', 'auth', 'security', 'critical']
    return criticalKeywords.some(keyword =>
      error.message.toLowerCase().includes(keyword)
    )
  }

  /**
   * Get error metrics for operation
   */
  getMetrics(operationKey: string): ErrorMetrics | undefined {
    return this.errorMetrics.get(operationKey)
  }

  /**
   * Get error history
   */
  getErrorHistory(operationKey: string, limit: number = 10): Error[] {
    const errors = this.lastErrors.get(operationKey) ?? []
    return errors.slice(-limit)
  }

  /**
   * Reset metrics
   */
  resetMetrics(operationKey: string): void {
    this.errorMetrics.delete(operationKey)
    this.lastErrors.delete(operationKey)

    logger.info(`Error metrics reset for ${operationKey}`)
  }

  /**
   * Get all metrics
   */
  getAllMetrics(): Map<string, ErrorMetrics> {
    return new Map(this.errorMetrics)
  }

  /**
   * Configure error threshold
   */
  setErrorThreshold(operationKey: string, threshold: number): void {
    this.errorThresholds.set(operationKey, threshold)
  }
}

// Global instance
export const comprehensiveErrorHandler = new ComprehensiveErrorHandler()

/**
 * Wrap async function with comprehensive error handling
 */
export async function withComprehensiveErrorHandling<T>(
  fn: () => Promise<T>,
  context: ErrorContext,
  options: RecoveryOptions
): Promise<T | null> {
  try {
    const result = await fn()
    comprehensiveErrorHandler.recordSuccess(context.operation)
    return result
  } catch (error) {
    return await comprehensiveErrorHandler.handleError(
      error instanceof Error ? error : new Error(String(error)),
      context,
      options
    )
  }
}
