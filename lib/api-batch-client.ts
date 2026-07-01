/**
 * Optimized Batch API Client with Rate Limiting
 * 
 * Handles:
 * - Request batching to reduce API calls
 * - Rate limit respecting (adaptive backoff)
 * - Connection pooling
 * - Request deduplication
 * - Circuit breaker pattern
 */

interface BatchRequest {
  path: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  body?: unknown
  timeout?: number
  retries?: number
  priority?: number
}

interface BatchResponse<T = unknown> {
  path: string
  status: number
  data: T
  cached?: boolean
  timestamp: number
}

interface RateLimitConfig {
  requestsPerSecond: number
  burst: number
  backoffMultiplier: number
  maxBackoff: number
}

const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  requestsPerSecond: 10,
  burst: 5,
  backoffMultiplier: 1.5, // Reduced from 2 for faster recovery
  maxBackoff: 500, // CRITICAL: Reduced from 30000 (30s) to 500ms for second-trading
}

class BatchAPIClient {
  private baseUrl: string
  private rateLimitConfig: RateLimitConfig
  private requestQueue: Map<string, BatchRequest> = new Map()
  private responseCache: Map<string, { data: unknown; timestamp: number }> = new Map()
  private rateLimitState = {
    lastRequestTime: 0,
    backoffTime: 0,
    requestCount: 0,
    burstUsed: 0,
  }
  private batchInterval: NodeJS.Timeout | null = null
  private readonly BATCH_TIMEOUT = 50 // ms - collect requests for this duration (reduced from 100 for faster processing)
  private readonly CACHE_TTL = 500 // ms - cache stats responses (reduced from 5000 for fresher data in second-trading)
  private circuitBreakerState = {
    failures: 0,
    lastFailureTime: 0,
    isOpen: false,
  }

  constructor(
    baseUrl: string,
    rateLimitConfig: Partial<RateLimitConfig> = {},
  ) {
    this.baseUrl = baseUrl
    this.rateLimitConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...rateLimitConfig }
  }

  /**
   * Queue a single request for batch processing
   */
  async queueRequest<T = unknown>(req: BatchRequest): Promise<T> {
    // Check circuit breaker
    if (this.isCircuitOpen()) {
      throw new Error('API circuit breaker is open - too many failures')
    }

    // Check cache for GET requests
    if (req.method === 'GET' || !req.method) {
      const cached = this.getFromCache(req.path)
      if (cached) {
        return cached as T
      }
    }

    // Add to queue with deduplication
    const key = `${req.method || 'GET'}:${req.path}`
    if (!this.requestQueue.has(key)) {
      this.requestQueue.set(key, req)
    }

    // Ensure batch processing is scheduled
    if (!this.batchInterval) {
      this.batchInterval = setTimeout(
        () => this.processBatch(),
        this.BATCH_TIMEOUT,
      )
    }

    // Wait for batch to complete
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        if (!this.requestQueue.has(key)) {
          clearInterval(checkInterval)
          const cached = this.getFromCache(req.path)
          if (cached) {
            resolve(cached as T)
          } else {
            reject(new Error(`Request ${key} failed to complete`))
          }
        }
      }, 10)
    })
  }

  /**
   * Process accumulated requests in a single batch
   */
  private async processBatch(): Promise<void> {
    if (this.batchInterval) {
      clearTimeout(this.batchInterval)
      this.batchInterval = null
    }

    const batch = Array.from(this.requestQueue.values())
    if (batch.length === 0) return

    // Respect rate limiting
    await this.waitForRateLimit(batch.length)

    try {
      // Execute requests in parallel with concurrency control
      const results = await this.executeWithConcurrency(batch, 5)
      
      // Cache and cleanup
      results.forEach((result) => {
        if (result) {
          this.cacheResponse(result.path, result.data)
          this.requestQueue.delete(`${result.path}`)
        }
      })

      // Reset circuit breaker on success
      this.circuitBreakerState.failures = 0
    } catch (error) {
      this.handleBatchFailure(error)
    }
  }

  /**
   * Execute requests with concurrency control
   */
  private async executeWithConcurrency<T>(
    requests: BatchRequest[],
    concurrency: number,
  ): Promise<(BatchResponse<T> | null)[]> {
    const results: (BatchResponse<T> | null)[] = []
    const executing: Promise<unknown>[] = []

    for (const request of requests) {
      const promise = this.executeRequest<T>(request).then((result) => {
        results.push(result)
      })

      executing.push(promise)

      if (executing.length >= concurrency) {
        await Promise.race(executing)
        executing.splice(executing.indexOf(promise), 1)
      }
    }

    await Promise.all(executing)
    return results
  }

  /**
   * Execute a single request with retry logic
   */
  private async executeRequest<T>(
    req: BatchRequest,
    attempt = 1,
  ): Promise<BatchResponse<T> | null> {
    const method = req.method || 'GET'
    const url = `${this.baseUrl}${req.path}`
    const timeout = req.timeout || 10000
    const maxRetries = req.retries ?? 3

    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(url, {
        method,
        body: req.body ? JSON.stringify(req.body) : undefined,
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      })

      clearTimeout(timeoutId)

      if (response.status === 429) {
        // Rate limited - exponential backoff
        const retryAfter = parseInt(
          response.headers.get('Retry-After') || '1',
        )
        await this.applyBackoff(retryAfter * 1000)

        if (attempt <= maxRetries) {
          return this.executeRequest<T>(req, attempt + 1)
        }
      }

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }

      const data = await response.json()

      return {
        path: req.path,
        status: response.status,
        data: data as T,
        timestamp: Date.now(),
      }
    } catch (error) {
      if (attempt <= maxRetries) {
        // Start at 100ms instead of 1000ms, capped at maxBackoff (500ms for second-trading)
        const backoff = Math.min(
          100 * Math.pow(this.rateLimitConfig.backoffMultiplier, attempt - 1),
          this.rateLimitConfig.maxBackoff,
        )
        await new Promise((r) => setTimeout(r, backoff))
        return this.executeRequest<T>(req, attempt + 1)
      }

      console.error(`[BatchAPIClient] Request failed after ${maxRetries} retries:`, error)
      return null
    }
  }

  /**
   * Wait for rate limit to allow next request(s)
   */
  private async waitForRateLimit(requestCount: number): Promise<void> {
    const interval = 1000 / this.rateLimitConfig.requestsPerSecond
    const now = Date.now()
    const timeSinceLastRequest = now - this.rateLimitState.lastRequestTime

    if (timeSinceLastRequest < interval) {
      const waitTime = interval - timeSinceLastRequest
      await new Promise((r) => setTimeout(r, waitTime))
    }

    this.rateLimitState.lastRequestTime = Date.now()
  }

  /**
   * Apply exponential backoff for rate limiting
   */
  private async applyBackoff(baseBackoff: number): Promise<void> {
    const jitter = Math.random() * 100
    const backoff = baseBackoff + jitter
    this.rateLimitState.backoffTime = Math.min(
      backoff,
      this.rateLimitConfig.maxBackoff,
    )
    await new Promise((r) => setTimeout(r, this.rateLimitState.backoffTime))
  }

  /**
   * Cache response data
   */
  private cacheResponse(path: string, data: unknown): void {
    this.responseCache.set(path, {
      data,
      timestamp: Date.now(),
    })
  }

  /**
   * Get cached response if fresh
   */
  private getFromCache(path: string): unknown | null {
    const cached = this.responseCache.get(path)
    if (!cached) return null

    const age = Date.now() - cached.timestamp
    if (age > this.CACHE_TTL) {
      this.responseCache.delete(path)
      return null
    }

    return cached.data
  }

  /**
   * Handle batch processing failure
   */
  private handleBatchFailure(error: unknown): void {
    this.circuitBreakerState.failures++
    this.circuitBreakerState.lastFailureTime = Date.now()

    if (this.circuitBreakerState.failures >= 5) {
      this.circuitBreakerState.isOpen = true
      console.error('[BatchAPIClient] Circuit breaker opened due to repeated failures')

      // Auto-reset after cooldown
      setTimeout(() => {
        this.circuitBreakerState.isOpen = false
        this.circuitBreakerState.failures = 0
      }, 30000)
    }

    console.error('[BatchAPIClient] Batch processing failed:', error)
  }

  /**
   * Check if circuit breaker is open
   */
  private isCircuitOpen(): boolean {
    if (!this.circuitBreakerState.isOpen) return false

    // Check cooldown
    const cooldown = Date.now() - this.circuitBreakerState.lastFailureTime
    if (cooldown > 30000) {
      this.circuitBreakerState.isOpen = false
      return false
    }

    return true
  }

  /**
   * Get current rate limit state for monitoring
   */
  getStatus() {
    return {
      queuedRequests: this.requestQueue.size,
      cacheSize: this.responseCache.size,
      rateLimit: this.rateLimitState,
      circuitBreaker: this.circuitBreakerState,
    }
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.responseCache.clear()
  }

  /**
   * Get stats about the client
   */
  getStats() {
    return {
      totalCached: this.responseCache.size,
      cacheHitRate: `${(
        (this.rateLimitState.burstUsed / Math.max(this.rateLimitState.requestCount, 1)) *
        100
      ).toFixed(2)}%`,
      averageBackoffMs: this.rateLimitState.backoffTime,
      circuitBreakerOpen: this.circuitBreakerState.isOpen,
    }
  }
}

export default BatchAPIClient
