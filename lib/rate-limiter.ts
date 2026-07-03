/**
 * Rate Limiter for Exchange API Calls
 * Prevents API rate limit violations with intelligent queuing.
 *
 * Key fix (session 35): processQueue was serial — it awaited every request
 * before dequeuing the next, so maxConcurrent=3 was never used and all
 * requests serialised.  The rewrite fires up to maxConcurrent requests
 * simultaneously; each slot releases itself when done, then the queue
 * drains as fast as BingX's per-second and per-minute limits allow.
 */

interface RateLimitConfig {
  requestsPerSecond: number
  requestsPerMinute: number
  maxConcurrent: number
}

interface QueuedRequest {
  id: string
  execute: () => Promise<any>
  resolve: (value: any) => void
  reject: (error: any) => void
  timestamp: number
  signal?: AbortSignal
}

export class RateLimiter {
  exchange: string
  config: RateLimitConfig
  queue: QueuedRequest[] = []
  requestTimestamps: number[] = []
  activeRequests = 0

  // Exchange-specific rate limits
  static readonly EXCHANGE_LIMITS: Record<string, RateLimitConfig> = {
    bybit: {
      requestsPerSecond: 10,
      requestsPerMinute: 120,
      maxConcurrent: 5,
    },
    bingx: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 5,   // raised from 3; semaphore in live-stage is the outer cap
    },
    binance: {
      requestsPerSecond: 10,
      requestsPerMinute: 1200,
      maxConcurrent: 10,
    },
    okx: {
      requestsPerSecond: 20,
      requestsPerMinute: 600,
      maxConcurrent: 10,
    },
    pionex: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    },
    orangex: {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    },
  }

  constructor(exchange: string) {
    this.exchange = exchange.toLowerCase()
    this.config = RateLimiter.EXCHANGE_LIMITS[this.exchange] || {
      requestsPerSecond: 5,
      requestsPerMinute: 100,
      maxConcurrent: 3,
    }
  }

  async execute<T>(request: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise((resolve, reject) => {
      // If the caller already aborted before we even enqueue, bail fast.
      if (signal?.aborted) {
        reject(new DOMException("Aborted before enqueue", "AbortError"))
        return
      }

      const queuedRequest: QueuedRequest = {
        id: `${Date.now()}-${Math.random()}`,
        execute: request,
        resolve,
        reject,
        timestamp: Date.now(),
        signal,
      }

      // Remove from queue if the caller aborts while waiting.
      if (signal) {
        signal.addEventListener("abort", () => {
          const idx = this.queue.indexOf(queuedRequest)
          if (idx !== -1) this.queue.splice(idx, 1)
          reject(new DOMException("Aborted while queued", "AbortError"))
        }, { once: true })
      }

      this.queue.push(queuedRequest)
      this.drainQueue()
    })
  }

  /**
   * Drain the queue: fire as many requests as rate limits allow,
   * concurrently up to maxConcurrent.  Each slot calls drainQueue again
   * when it finishes so the queue stays moving without any global loop.
   */
  private drainQueue(): void {
    while (this.queue.length > 0 && this.canMakeRequest()) {
      const request = this.queue.shift()!

      // Skip requests whose AbortSignal fired while queued.
      if (request.signal?.aborted) continue

      this.activeRequests++
      const now = Date.now()
      this.requestTimestamps.push(now)
      // Trim timestamps older than 1 minute to prevent unbounded growth.
      this.requestTimestamps = this.requestTimestamps.filter((ts) => now - ts < 60_000)

      // Fire without awaiting — the slot is released in the finally block.
      ;(async () => {
        try {
          if (request.signal?.aborted) {
            request.reject(new DOMException("Aborted before dispatch", "AbortError"))
            return
          }
          const result = await request.execute()
          request.resolve(result)
        } catch (error) {
          request.reject(error)
        } finally {
          this.activeRequests--
          // Try to drain more items now that a slot freed up.
          this.drainQueue()
        }
      })()
    }
  }

  canMakeRequest(): boolean {
    if (this.activeRequests >= this.config.maxConcurrent) return false

    const now = Date.now()
    const recentSecond = this.requestTimestamps.filter((ts) => now - ts < 1_000).length
    if (recentSecond >= this.config.requestsPerSecond) return false

    const recentMinute = this.requestTimestamps.filter((ts) => now - ts < 60_000).length
    if (recentMinute >= this.config.requestsPerMinute) return false

    return true
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  getStats() {
    const now = Date.now()
    return {
      exchange: this.exchange,
      queueLength: this.queue.length,
      activeRequests: this.activeRequests,
      requestsLastSecond: this.requestTimestamps.filter((ts) => now - ts < 1_000).length,
      requestsLastMinute: this.requestTimestamps.filter((ts) => now - ts < 60_000).length,
      config: this.config,
    }
  }
}

// Singleton rate limiters per exchange.
const rateLimiters = new Map<string, RateLimiter>()

export function getRateLimiter(exchange: string): RateLimiter {
  const key = exchange.toLowerCase()
  if (!rateLimiters.has(key)) {
    rateLimiters.set(key, new RateLimiter(key))
  }
  return rateLimiters.get(key)!
}
