/**
 * Prehistoric Progress Tracker
 * Provides stable, consistent, non-blocking progress reporting for prehistoric data loading
 */

import { getRedisClient } from "@/lib/redis-db"

export interface PrehistoricProgress {
  connectionId: string
  totalSymbols: number
  processedSymbols: number
  currentSymbol: string | null
  currentProgress: number // 0-100
  remainingSymbols: string[]
  completedSymbols: string[]
  errorSymbols: { symbol: string; error: string }[]
  totalCandles: number
  totalCandesProcessed: number
  startTime: number
  estimatedTimeRemaining: number // ms
  isComplete: boolean
  dataSource: "live" | "synthetic" | "cache"
  lastUpdate: number
}

export class PrehistoricProgressTracker {
  private connectionId: string
  private trackingKey: string
  private lastUpdateTime = Date.now()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.trackingKey = `prehistoric:progress:${connectionId}`
  }

  /**
   * Initialize prehistoric progress tracking
   */
  async initialize(totalSymbols: string[]): Promise<void> {
    const now = Date.now()
    const client = getRedisClient()
    if (!client) return

    try {
      await client.hset(this.trackingKey, {
        total_symbols: String(totalSymbols.length),
        processed_symbols: "0",
        current_symbol: "",
        completed_symbols: "[]",
        error_symbols: "[]",
        total_candles: "0",
        total_candles_processed: "0",
        start_time: String(now),
        is_complete: "0",
        data_source: "live",
        last_update: String(now),
      })
      // Set 24-hour expiration
      await client.expire(this.trackingKey, 86400)
    } catch (err) {
      console.warn(`[v0] Failed to initialize prehistoric progress tracker: ${err}`)
    }
  }

  /**
   * Mark a symbol as currently being processed
   */
  async startSymbol(symbol: string): Promise<void> {
    const now = Date.now()
    const client = getRedisClient()
    if (!client) return

    try {
      await client.hset(this.trackingKey, {
        current_symbol: symbol,
        last_update: String(now),
      })
    } catch (err) {
      console.warn(`[v0] Failed to update current symbol: ${err}`)
    }
  }

  /**
   * Mark a symbol as completed with candle count
   */
  async completeSymbol(symbol: string, candleCount: number): Promise<void> {
    const now = Date.now()
    const client = getRedisClient()
    if (!client) return

    try {
      // Get current state
      const state = await client.hgetall(this.trackingKey)
      const completedStr = state?.completed_symbols || "[]"
      const processedCount = parseInt(state?.processed_symbols || "0") + 1
      const totalCandles = parseInt(state?.total_candles || "0") + candleCount

      let completed: string[] = []
      try {
        completed = JSON.parse(completedStr)
      } catch {
        completed = []
      }
      completed.push(symbol)

      // Update atomically
      await client.hset(this.trackingKey, {
        processed_symbols: String(processedCount),
        completed_symbols: JSON.stringify(completed),
        total_candles: String(totalCandles),
        current_symbol: "",
        last_update: String(now),
      })
    } catch (err) {
      console.warn(`[v0] Failed to complete symbol: ${err}`)
    }
  }

  /**
   * Mark a symbol as errored
   */
  async errorSymbol(symbol: string, error: string): Promise<void> {
    const now = Date.now()
    const client = getRedisClient()
    if (!client) return

    try {
      const state = await client.hgetall(this.trackingKey)
      const errorStr = state?.error_symbols || "[]"
      const processedCount = parseInt(state?.processed_symbols || "0") + 1

      let errors: { symbol: string; error: string }[] = []
      try {
        errors = JSON.parse(errorStr)
      } catch {
        errors = []
      }
      errors.push({ symbol, error })

      await client.hset(this.trackingKey, {
        processed_symbols: String(processedCount),
        error_symbols: JSON.stringify(errors),
        current_symbol: "",
        last_update: String(now),
      })
    } catch (err) {
      console.warn(`[v0] Failed to record symbol error: ${err}`)
    }
  }

  /**
   * Mark prehistoric load as complete - writes the critical realtime gate flag
   * also updates tracker for UI reporting. Retries on failure to ensure durability.
   */
  async markComplete(dataSource: "live" | "synthetic" | "cache" = "live"): Promise<void> {
    const now = Date.now()
    const client = getRedisClient()
    if (!client) return

    const doneKey = `prehistoric:${this.connectionId}:done`
    let retries = 3
    let success = false

    while (retries > 0 && !success) {
      try {
        // Update progress tracker
        await client.hset(this.trackingKey, {
          is_complete: "1",
          current_symbol: "",
          data_source: dataSource,
          last_update: String(now),
        })
        
        // Write the critical realtime gate flag — must be durable
        await client.set(doneKey, "1")
        await client.expire(doneKey, 86400) // 24h ttl
        
        success = true
        if (process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
          console.log(`[v0] Prehistoric complete for ${this.connectionId} at ${new Date(now).toISOString()}`)
        }
      } catch (err) {
        retries--
        if (retries === 0) {
          console.error(`[v0] CRITICAL: Failed to mark prehistoric complete after retries: ${err}`)
        } else {
          console.warn(`[v0] Retry marking prehistoric complete (${retries} left): ${err}`)
          await new Promise(resolve => setTimeout(resolve, 500)) // backoff
        }
      }
    }
  }

  /**
   * Get current progress (non-blocking)
   */
  async getProgress(): Promise<PrehistoricProgress> {
    const client = getRedisClient()
    const now = Date.now()

    const defaultProgress: PrehistoricProgress = {
      connectionId: this.connectionId,
      totalSymbols: 0,
      processedSymbols: 0,
      currentSymbol: null,
      currentProgress: 0,
      remainingSymbols: [],
      completedSymbols: [],
      errorSymbols: [],
      totalCandles: 0,
      totalCandesProcessed: 0,
      startTime: now,
      estimatedTimeRemaining: 0,
      isComplete: false,
      dataSource: "live",
      lastUpdate: now,
    }

    if (!client) return defaultProgress

    try {
      // Use HGETALL with timeout to prevent hanging.
      // The Promise.race union collapses to `{}` under TS inference, so we
      // explicitly type the resolved hash as a string record. Every field
      // below is read as a string and parsed defensively.
      const state = (await Promise.race([
        client.hgetall(this.trackingKey),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Progress fetch timeout")), 1000)),
      ]).catch(() => null)) as Record<string, string> | null

      if (!state || Object.keys(state).length === 0) return defaultProgress

      const total = parseInt(state.total_symbols as string) || 0
      const processed = parseInt(state.processed_symbols as string) || 0
      const totalCandles = parseInt(state.total_candles as string) || 0
      const startTime = parseInt(state.start_time as string) || now
      const isComplete = (state.is_complete as string) === "1"

      let completed: string[] = []
      let errors: { symbol: string; error: string }[] = []

      try {
        completed = JSON.parse(state.completed_symbols as string) || []
      } catch {
        completed = []
      }

      try {
        errors = JSON.parse(state.error_symbols as string) || []
      } catch {
        errors = []
      }

      // Calculate remaining
      const remaining = total - processed
      const elapsed = now - startTime
      const estimatedPerSymbol = elapsed / Math.max(processed, 1)
      const estimatedTimeRemaining = Math.max(0, remaining * estimatedPerSymbol)

      return {
        connectionId: this.connectionId,
        totalSymbols: total,
        processedSymbols: processed,
        currentSymbol: (state.current_symbol as string) || null,
        currentProgress: total > 0 ? Math.round((processed / total) * 100) : 0,
        remainingSymbols: [],
        completedSymbols: completed,
        errorSymbols: errors,
        totalCandles,
        totalCandesProcessed: processed > 0 ? Math.round(totalCandles / processed) * processed : 0,
        startTime,
        estimatedTimeRemaining: Math.round(estimatedTimeRemaining),
        isComplete,
        dataSource: (state.data_source as "live" | "synthetic" | "cache") || "live",
        lastUpdate: parseInt(state.last_update as string) || now,
      }
    } catch (err) {
      console.warn(`[v0] Error fetching prehistoric progress: ${err}`)
      return defaultProgress
    }
  }
}

/**
 * Get or create singleton tracker for a connection
 */
const trackers = new Map<string, PrehistoricProgressTracker>()

export function getPrehistoricProgressTracker(connectionId: string): PrehistoricProgressTracker {
  if (!trackers.has(connectionId)) {
    trackers.set(connectionId, new PrehistoricProgressTracker(connectionId))
  }
  return trackers.get(connectionId)!
}
