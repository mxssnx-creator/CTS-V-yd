/**
 * Rate Limiter for Exchange API Calls
 * Prevents API rate limit violations with intelligent queuing.
 *
 * Key fixes (session 35):
 * - processQueue is now concurrent: fires up to maxConcurrent requests
 *   simultaneously instead of serial await.
 * - Per-request executeTimeout: applied from dispatch time (when the request
 *   leaves the queue and starts running), NOT from enqueue time. This prevents
 *   the abort signal from firing during legitimate queue-wait time.
 * - Caller AbortSignal: still supported for cancelling while queued. It only
 *   removes the request from the queue; it does NOT cancel the HTTP fetch once
 *   execution has started (use executeTimeoutMs for that).
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
  /** Timeout (ms) applied from dispatch time — covers only actual HTTP time. */
  executeTimeoutMs?: number
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
      // BingX actual limits: 100 req/10s per IP for reads, 20 req/s for orders.
      // With exchange-close retries eliminated (session 36), queue pressure is
      // much lower. Raise to 10 req/s and 5 concurrent so getPositions,
      // getOpenOrders, and placeOrder can pipeline without starving each other.
      // __STOP_SEM_LIMIT=6 in live-stage prevents SL/TP from monopolising all slots.
      requestsPerSecond: 10,
      requestsPerMinute: 300,
      maxConcurrent: 5,
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

  /**
   * Execute a request through the rate limiter.
   *
   * @param request - The async function to execute (the actual HTTP call).
   * @param signal  - Optional caller AbortSignal. Removes the request from the
   *                  queue if it fires while waiting. Does NOT cancel an
   *                  in-flight fetch — use executeTimeoutMs for that.
   * @param executeTimeoutMs - Optional timeout applied from dispatch time.
   *                  Wraps request() in a Promise.race so it rejects if the
   *                  exchange call itself takes too long. Does not count queue
   *                  wait time. Defaults to no timeout (connector's own fetch
   *                  timeout applies instead).
   */
  async execute<T>(
    request: () => Promise<T>,
    signal?: AbortSignal,
    executeTimeoutMs?: number,
  ): Promise<T> {
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
        executeTimeoutMs,
      }

      // Remove from queue if the caller aborts while still waiting for a slot.
      // This does NOT cancel an already-dispatched request.
      if (signal) {
        signal.addEventListener(
          "abort",
          () => {
            const idx = this.queue.indexOf(queuedRequest)
            if (idx !== -1) {
              this.queue.splice(idx, 1)
              reject(new DOMException("Aborted while queued", "AbortError"))
            }
            // If already dispatched (not in queue), the reject above is a no-op
            // and the request runs to completion (or times out via executeTimeoutMs).
          },
          { once: true },
        )
      }

      this.queue.push(queuedRequest)
      this.drainQueue()
    })
  }

  /**
   * Drain the queue: fire as many requests as rate limits allow,
   * concurrently up to maxConcurrent. Each slot calls drainQueue again
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

          // Apply per-request execute timeout (measured from dispatch, not enqueue).
          // This is the right place to enforce HTTP-level timeouts: the request
          // has a slot and is about to make the actual exchange call.
          let result: any
          if (request.executeTimeoutMs && request.executeTimeoutMs > 0) {
            const timeoutPromise = new Promise<never>((_, rej) =>
              setTimeout(
                () => rej(new Error(`Execute timeout after ${request.executeTimeoutMs}ms`)),
                request.executeTimeoutMs,
              ),
            )
            result = await Promise.race([request.execute(), timeoutPromise])
          } else {
            result = await request.execute()
          }

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
