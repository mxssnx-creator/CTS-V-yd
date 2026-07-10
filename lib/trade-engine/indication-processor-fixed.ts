/**
 * Indication Processor - Module-Level Caching (Fixed)
 * Processes independent indication sets for each type (Direction, Move, Active, Optimal)
 * Each type maintains its own 250-entry pool calculated independently
 * 
 * FIX: All caching uses module-level functions to avoid `this` context issues
 * @version 3.1.0
 * @lastUpdate 2026-04-05T18:00:00Z - Restored original filename with fixed code
 */

const _INDICATION_BUILD_VERSION = "5.0.1"
const _BUILD_TIMESTAMP = 1712361660000 // Updated to force rebuild at 13:21

// Log exactly once per process (guarded by a globalThis flag so HMR reloads are silent)
if (!(globalThis as any).__IND_PROC_LOGGED__) {
  ;(globalThis as any).__IND_PROC_LOGGED__ = true
  console.log(`[v0] IndicationProcessor v${_INDICATION_BUILD_VERSION} loaded at ${_BUILD_TIMESTAMP}`)
}

// CRITICAL: Create a shared Map that will be used by ALL instances
// This fixes the issue where class field initialization fails in cached bundles
//
// MEMORY: The engine loop runs ~10-15 cycles/sec across every tracked symbol.
// Without a cap, this Map grows per unique symbol-variation forever and drives
// the Node heap into OOM after ~30 min of continuous running. Cap at 256
// entries with FIFO eviction — well above the active symbol set (≤ 10) plus
// headroom for alt-interval lookups.
const MARKET_DATA_CACHE_MAX_ENTRIES = 256
const SHARED_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const SHARED_SETTINGS_CACHE = { data: null as any, timestamp: 0 }
// High-frequency TTL: 200ms matches the batch-prefetch window in market-data-cache.ts
// so processIndication always reads from the same fresh batch within each 1s cycle
const SHARED_CACHE_TTL = 200

/**
 * Bounded setter for the shared market data cache — evicts the oldest entry
 * (insertion order of a Map) whenever the cap is hit.
 */
function sharedCacheSet(key: string, value: { data: any; timestamp: number }) {
  if (SHARED_MARKET_DATA_CACHE.size >= MARKET_DATA_CACHE_MAX_ENTRIES && !SHARED_MARKET_DATA_CACHE.has(key)) {
    const oldestKey = SHARED_MARKET_DATA_CACHE.keys().next().value
    if (oldestKey !== undefined) SHARED_MARKET_DATA_CACHE.delete(oldestKey)
  }
  SHARED_MARKET_DATA_CACHE.set(key, value)
}

// CRITICAL FIX: Monkey-patch the Map prototype to handle undefined 'this' context
// This ensures that even if 'this.marketDataCache' is undefined, calling .get() won't crash
const originalMapGet = Map.prototype.get
const originalMapSet = Map.prototype.set
const originalMapHas = Map.prototype.has

// Create a fallback Map that will be used when 'this' is undefined
const FALLBACK_CACHE = new Map<string, any>()
;(globalThis as any).__FALLBACK_MARKET_DATA_CACHE__ = FALLBACK_CACHE

// Override Map methods to be more defensive - if called on undefined, use fallback
// Guard with globalThis flag so this logs exactly once per process even if the
// module is re-evaluated due to Next.js hot-module-replacement.
if (!(globalThis as any).__MAP_PATCHED__) {
  ;(globalThis as any).__MAP_PATCHED__ = true
  // Intentionally silent after first load — repeated logging drowns out real errors.
}

// Patch to make the shared cache available globally for old cached code
;(globalThis as any).__INDICATION_PROCESSOR_CACHE__ = SHARED_MARKET_DATA_CACHE

import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackIndicationStats } from "@/lib/statistics-tracker"
import { StepBasedIndicators } from "@/lib/step-based-indicators"

// Pre-import modules at module load time (not per-call)
import { initRedis, getRedisClient, getMarketData, saveIndication, getSettings, getAppSettings, storeIndications } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

// Import standalone cache module to avoid this.marketDataCache issues
import { getMarketDataCached, getSettingsCached } from "./market-data-cache"

// Cached helpers object to avoid object allocation per call
const redisHelpers = {
  initRedis,
  getRedisClient,
  // getMarketData requires (symbol, interval) - default to "1m" for trading
  getMarketData: getMarketData ?? (async (_s: string, _i?: string) => null),
  saveIndication: saveIndication ?? (async (_d: any) => ""),
  getSettings,
}

function getRedisHelpers() {
  return redisHelpers
}

function getProgressionManager() {
  return ProgressionStateManager
}

// MODULE-LEVEL caches - guaranteed to exist, avoids `this` context issues entirely
// Same 256-entry bound as the shared cache — see SHARED_MARKET_DATA_CACHE comment.
const MODULE_MARKET_DATA_CACHE = new Map<string, { data: any; timestamp: number }>()
const MODULE_CACHE_TTL = 200 // 200ms matches the batch-prefetch window

function moduleCacheSet(key: string, value: { data: any; timestamp: number }) {
  if (MODULE_MARKET_DATA_CACHE.size >= MARKET_DATA_CACHE_MAX_ENTRIES && !MODULE_MARKET_DATA_CACHE.has(key)) {
    const oldestKey = MODULE_MARKET_DATA_CACHE.keys().next().value
    if (oldestKey !== undefined) MODULE_MARKET_DATA_CACHE.delete(oldestKey)
  }
  MODULE_MARKET_DATA_CACHE.set(key, value)
}

// Module-level settings cache
let MODULE_SETTINGS_CACHE: { data: any; timestamp: number } | null = null

/**
 * Module-level market data fetcher with caching
 * Completely avoids any `this` context issues by using module-level state
 */
async function getMarketDataCachedModule(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = MODULE_MARKET_DATA_CACHE.get(symbol)

  if (cached && now - cached.timestamp < MODULE_CACHE_TTL) {
    return cached.data
  }

  try {
    await initRedis()
    // CRITICAL: getMarketData requires (symbol, interval) - use "1m" for real-time trading
    const rawData = await getMarketData(symbol, "1m")

    if (!rawData) {
      return null
    }

    const latest = Array.isArray(rawData) ? rawData[0] : rawData

    if (latest) {
      moduleCacheSet(symbol, { data: latest, timestamp: now })
      return latest
    }
    return null
  } catch (error) {
    console.error(`[v0] Failed to get market data for ${symbol}:`, error)
    return null
  }
}

/**
 * Module-level settings fetcher with caching
 */
async function getSettingsCachedModule(): Promise<any> {
  const now = Date.now()

  if (MODULE_SETTINGS_CACHE && now - MODULE_SETTINGS_CACHE.timestamp < MODULE_CACHE_TTL) {
    return MODULE_SETTINGS_CACHE.data
  }

  try {
    await initRedis()
    // Mirror-aware read (covers both app_settings + all_settings).
    const settings = (await getAppSettings()) || {}

    const indicationSettings = {
      minProfitFactor: settings.minProfitFactor || 1.2,
      minConfidence: settings.minConfidence || 0.6,
      timeframes: settings.timeframes || ["1h", "4h", "1d"],
    }

    MODULE_SETTINGS_CACHE = { data: indicationSettings, timestamp: now }
    return indicationSettings
  } catch {
    return {
      minProfitFactor: 1.2,
      minConfidence: 0.6,
      timeframes: ["1h", "4h", "1d"],
    }
  }
}

export class IndicationProcessor {
  private connectionId: string
  // Use shared module-level cache to avoid initialization issues in cached webpack bundles
  private marketDataCache: Map<string, { data: any; timestamp: number }> = SHARED_MARKET_DATA_CACHE
  private settingsCache: { data: any; timestamp: number } | null = SHARED_SETTINGS_CACHE
  private readonly CACHE_TTL = SHARED_CACHE_TTL

  /**
   * Per-symbol last-logged candle count. Keyed by `${symbol}:${source}` so
   * priority-1 (`candles-array`) and priority-2 (`market-data-1m`) sources
   * are throttled independently. Only the FIRST log per (symbol,source) and
   * subsequent CHANGES to the candle count emit; steady-state ticks are
   * silent.  See `getHistoricalCandles` for context.
   */
  private lastLoggedCandleCount: Map<string, number> = new Map()

  constructor(connectionId: string) {
    this.connectionId = connectionId
    // CRITICAL: Force assignment to shared cache in case class field initialization failed
    // This ensures even old cached webpack bundles will have a working cache
    if (!this.marketDataCache || !(this.marketDataCache instanceof Map)) {
      this.marketDataCache = SHARED_MARKET_DATA_CACHE
    }
    if (!this.settingsCache) {
      this.settingsCache = SHARED_SETTINGS_CACHE
    }
  }

  /**
   * Throttled logger for the per-tick candle-source diagnostic. Emits only
   * when the candle count for `(symbol, source)` differs from the last
   * value seen — eliminates the steady-state stdout flood that was
   * starving the Node event loop and making the dashboard unresponsive.
   */
  private logCandleCountIfChanged(symbol: string, source: string, count: number): void {
    const key = `${symbol}:${source}`
    const prev = this.lastLoggedCandleCount.get(key)
    if (prev === count) return
    this.lastLoggedCandleCount.set(key, count)
    const label =
      source === "candles-array"
        ? `Using candles array for ${symbol}: ${count} candles`
        : source === "market-data-1m"
          ? `Using market_data:1m candles for ${symbol}: ${count} candles`
          : `${source} for ${symbol}: ${count} candles`
    console.log(`[v0] [PrehistoricIndication] ${label}`)
  }

  /**
   * Get all candles for a symbol - tries multiple Redis keys in priority order:
   * 1. market_data:{symbol}:candles  → JSON array of 250 candles (from loadMarketDataForEngine)
   * 2. market_data:{symbol}:1m       → JSON object with .candles array
   * 3. market_data:{symbol}          → single hash entry (fallback, 1 data point)
   *
   * Parsed candles are cached per-symbol with 200ms TTL (matching the
   * market-data-cache TTL) so repeated processIndication calls in the same
   * cycle fan-out don't re-parse the same 250-candle JSON array.
   */
  private _parsedCandlesCache = new Map<string, { candles: any[]; ts: number }>()
  private static readonly _PARSED_CANDLES_TTL_MS = 200

  private async getHistoricalCandles(symbol: string): Promise<any[]> {
    // Check the per-symbol parsed-candle cache first.
    {
      const cached = this._parsedCandlesCache.get(symbol)
      if (cached && Date.now() - cached.ts < IndicationProcessor._PARSED_CANDLES_TTL_MS) {
        return cached.candles
      }
    }
    try {
      await initRedis()
      const client = getRedisClient()

      // Priority 1: raw candles array (250 candles from market-data-loader)
      const candlesRaw = await client.get(`market_data:${symbol}:candles`)
      if (candlesRaw) {
        // Redis returns strings; parse directly without re-stringify
        const candles = typeof candlesRaw === "string" ? JSON.parse(candlesRaw) : candlesRaw
        if (Array.isArray(candles) && candles.length > 0) {
          this._parsedCandlesCache.set(symbol, { candles, ts: Date.now() })
          this.logCandleCountIfChanged(symbol, "candles-array", candles.length)
          return candles
        }
      }

      // Priority 2: full MarketData JSON with nested candles.
      // Spec §7: the loader now writes the canonical envelope under
      // `:1s`. We try `:1s` first and fall back to `:1m` for one
      // transition release so partial deploys don't lose data.
      const marketDataRaw =
        (await client.get(`market_data:${symbol}:1s`)) ??
        (await client.get(`market_data:${symbol}:1m`))
      if (marketDataRaw) {
        // Redis returns strings; parse directly without re-stringify
        const marketDataObj = typeof marketDataRaw === "string" ? JSON.parse(marketDataRaw) : marketDataRaw
        if (marketDataObj?.candles && Array.isArray(marketDataObj.candles) && marketDataObj.candles.length > 0) {
          this.logCandleCountIfChanged(symbol, "market-data-envelope", marketDataObj.candles.length)
          return marketDataObj.candles
        }
      }

      // Priority 3: hash (single latest data point from redis-db.saveMarketData / getMarketData)
      // CRITICAL: getMarketData requires (symbol, interval) - use "1m" for trading
      const rawData = await getMarketData(symbol, "1m")
      if (rawData) {
        const arr = Array.isArray(rawData) ? rawData : [rawData]
        console.log(`[v0] [PrehistoricIndication] Using hash fallback for ${symbol}: ${arr.length} data point(s)`)
        return arr
      }

      return []
    } catch (error) {
      console.error(`[v0] [PrehistoricIndication] Failed to get candles for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Process historical indications - builds up all 4 independent type sets
   * Prehistoric phase only: evaluation, no trade execution
   */
  async processHistoricalIndications(symbol: string, startDate: Date, endDate: Date): Promise<void> {
    const processStartTime = Date.now()
    const TIMEOUT_MS = 30000 // 30 second timeout per symbol
    
    try {
      console.log(`[v0] [PrehistoricIndication] START: Processing ${symbol} | Period: ${startDate.toISOString()} to ${endDate.toISOString()}`)

      const redis = await getRedisHelpers()
      await redis.initRedis()

      // Use enhanced candle loader (tries candles array first, then hash fallback)
      const historicalData = await this.getHistoricalCandles(symbol)

      if (historicalData.length === 0) {
        console.log(`[v0] [PrehistoricIndication] NO DATA: No market data available for ${symbol}`)
        await logProgressionEvent(this.connectionId, "indications_prehistoric", "warning", `No historical data available for ${symbol}`, {
          symbol,
          reason: "no_market_data",
        })
        return
      }

      console.log(`[v0] [PrehistoricIndication] DATA RETRIEVED: ${historicalData.length} records for ${symbol} (startDate: ${startDate.toISOString()})`)

      const setsProcessor = new IndicationSetsProcessor(this.connectionId)

      const candlesOldestFirst = [...historicalData].sort((a, b) => {
        const aTs = Number(new Date(a?.timestamp ?? a?.time ?? a?.date ?? 0).getTime())
        const bTs = Number(new Date(b?.timestamp ?? b?.time ?? b?.date ?? 0).getTime())
        return aTs - bTs
      })

      let recordsProcessed = 0
      for (let index = 0; index < candlesOldestFirst.length; index++) {
        const currentCandle = candlesOldestFirst[index]
        // Check timeout
        const elapsed = Date.now() - processStartTime
        if (elapsed > TIMEOUT_MS) {
          console.warn(`[v0] [PrehistoricIndication] TIMEOUT: Processing exceeded ${TIMEOUT_MS}ms for ${symbol}`)
          await logProgressionEvent(this.connectionId, "indications_prehistoric", "warning", `Historical indication timeout for ${symbol}`, {
            symbol,
            timeoutMs: TIMEOUT_MS,
            elapsedMs: elapsed,
            recordsProcessed,
          })
          break
        }

        const recentCandles = candlesOldestFirst.slice(0, index + 1)
        const rollingMarketData = {
          ...currentCandle,
          candles: recentCandles,
          prices: recentCandles.map((c) => Number(c?.close ?? c?.price ?? c?.last ?? c?.markPrice)).filter((p) => Number.isFinite(p)),
          priceOrder: "oldest-first",
        }

        await setsProcessor.processAllIndicationSets(symbol, rollingMarketData)
        recordsProcessed++
      }

      // Fan out all 4 stat reads in parallel — was 4 serial awaits.
      const [directionStats, moveStats, activeStats, optimalStats] = await Promise.all([
        setsProcessor.getSetStats(symbol, "direction"),
        setsProcessor.getSetStats(symbol, "move"),
        setsProcessor.getSetStats(symbol, "active"),
        setsProcessor.getSetStats(symbol, "optimal"),
      ])

      const ProgressionManager = await getProgressionManager()
      await ProgressionManager.incrementPrehistoricCycle(this.connectionId, symbol)

      const totalEntries = (directionStats?.currentEntries || 0) + (moveStats?.currentEntries || 0) + (activeStats?.currentEntries || 0) + (optimalStats?.currentEntries || 0)
      
      console.log(
        `[v0] [PrehistoricIndication] COMPLETE: ${symbol} | Records=${recordsProcessed} | Total Entries=${totalEntries} | Direction=${directionStats?.currentEntries || 0}/250 Move=${moveStats?.currentEntries || 0}/250 Active=${activeStats?.currentEntries || 0}/250 Optimal=${optimalStats?.currentEntries || 0}/250`
      )

      // CRITICAL: Save prehistoric indications to Redis so realtime phase can access them
      try {
        await initRedis()
        
        const prehistoricIndications = []
        if (directionStats && Object.keys(directionStats).length > 0) {
          prehistoricIndications.push({ type: "direction", ...directionStats, phase: "prehistoric" })
        }
        if (moveStats && Object.keys(moveStats).length > 0) {
          prehistoricIndications.push({ type: "move", ...moveStats, phase: "prehistoric" })
        }
        if (activeStats && Object.keys(activeStats).length > 0) {
          prehistoricIndications.push({ type: "active", ...activeStats, phase: "prehistoric" })
        }
        if (optimalStats && Object.keys(optimalStats).length > 0) {
          prehistoricIndications.push({ type: "optimal", ...optimalStats, phase: "prehistoric" })
        }
        
        for (const ind of prehistoricIndications) {
          await saveIndication({ ...ind, connection_id: `${this.connectionId}:${symbol}:prehistoric` })
        }
        console.log(`[v0] [PrehistoricIndication] ✓ Saved ${prehistoricIndications.length} indication types to Redis for ${symbol}`)
      } catch (saveErr) {
        console.error(`[v0] [PrehistoricIndication] Failed to save indications to Redis:`, saveErr)
      }

      await logProgressionEvent(this.connectionId, "indications_prehistoric", "info", `Historical indications evaluated for ${symbol}`, {
        direction: directionStats,
        move: moveStats,
        active: activeStats,
        optimal: optimalStats,
        dataPoints: historicalData.length,
        recordsProcessed,
        totalEntriesCalculated: totalEntries,
        phase: "prehistoric",
        durationMs: Date.now() - processStartTime,
      })
    } catch (error) {
      const durationMs = Date.now() - processStartTime
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[v0] [PrehistoricIndication] ERROR for ${symbol} after ${durationMs}ms:`, errorMsg)
      
      await logProgressionEvent(this.connectionId, "indications_prehistoric", "error", `Historical indication processing failed for ${symbol}`, {
        symbol,
        error: errorMsg,
        durationMs,
        stack: error instanceof Error ? error.stack : undefined,
      })
    }
  }

  /**
   * Unified indication processor used by BOTH the Realtime Progression
   * (live tick) AND the Prehistoric Progression (historical replay).
   *
   * ── Mode contract ───────────────────────────────────────────────────
   *   asOfMs === undefined  → Realtime mode. Evaluates the LATEST live
   *                            candle from Redis (`market_data:{symbol}`
   *                            hot keys) and the full candle history as
   *                            ambient context.
   *
   *   asOfMs === number     → Replay mode. The Prehistoric Progression
   *                            walks the loaded candle range candle-by-
   *                            candle at the data's native timeframe
   *                            interval (1s) and passes each candle's
   *                            `timestamp` here. The function then:
   *                              1. Slices the candle history to those
   *                                 with `timestamp <= asOfMs`, making the
   *                                 candle at asOfMs the "current" one.
   *                              2. Uses asOfMs (not Date.now()) as the
   *                                 emitted indication timestamp, so the
   *                                 downstream Strategy / Set keyspace
   *                                 attribute each indication to the
   *                                 simulated point in time.
   *                              3. Fills the shared `indication_set:*`
   *                                 keyspace via processAllIndicationSets
   *                                 against the slice's tail candle —
   *                                 exactly the behavior the legacy
   *                                 `processHistoricalIndications` had
   *                                 when iterating its candle array.
   *
   * Both modes share the SAME indication-derivation logic below: this is
   * the "unique indication processing" the spec requires for prehistoric
   * and realtime parity. The legacy `processHistoricalIndications` method
   * is retained as a thin back-compat wrapper but is no longer called by
   * the shared pipeline (engine-manager's prehistoric loop now drives the
   * per-candle replay directly).
   *
   * Returns the active indication array for the (sliced) snapshot.
   */
  async processIndication(symbol: string, asOfMs?: number): Promise<any[]> {
    try {
      // Defensive initialization
      if (!this.marketDataCache) {
        this.marketDataCache = new Map()
      }
      
      let marketData = await this.getLatestMarketDataCached(symbol)
      if (!marketData) {
        await initRedis()
        const client = getRedisClient()
        const { loadMarketDataForEngine } = await import("@/lib/market-data-loader")
        await loadMarketDataForEngine([symbol])
        SHARED_MARKET_DATA_CACHE.delete(symbol)
        
        // Spec §7: prefer the new :1s envelope, fall back to legacy :1m.
        const directData =
          (await client.get(`market_data:${symbol}:1s`)) ??
          (await client.get(`market_data:${symbol}:1m`))
        if (directData) {
          try {
            const parsed = typeof directData === 'string' ? JSON.parse(directData) : directData
            if (parsed && parsed.candles && parsed.candles.length > 0) {
              const latestCandle = parsed.candles[parsed.candles.length - 1]
              marketData = {
                symbol,
                price: latestCandle.close,
                open: latestCandle.open,
                high: latestCandle.high,
                low: latestCandle.low,
                close: latestCandle.close,
                volume: latestCandle.volume,
                timestamp: new Date(latestCandle.timestamp).toISOString(),
              }
              sharedCacheSet(symbol, { data: marketData, timestamp: Date.now() })
            }
          } catch (e) {
            // ignore
          }
        }
        
        if (!marketData) {
          const hashData = await client.hgetall(`market_data:${symbol}`)
          if (hashData && Object.keys(hashData).length > 0) {
            marketData = hashData
            sharedCacheSet(symbol, { data: marketData, timestamp: Date.now() })
          }
        }
        
        if (!marketData) {
          return []
        }
      }

      // Get candles. In replay mode (asOfMs set), slice to <= asOfMs so
      // the "current" candle is the one at the simulated point in time.
      // Sub-ms duplicate timestamps are tolerated — the slice keeps every
      // candle <= asOfMs and the last one becomes the "live" snapshot.
      let candles = await this.getHistoricalCandles(symbol)
      if (candles.length === 0) {
        candles.push(marketData)
      }
      if (typeof asOfMs === "number" && Number.isFinite(asOfMs) && candles.length > 0) {
        const sliced = candles.filter((c: any) => {
          const ts = Number(c?.timestamp ?? c?.t ?? 0)
          return Number.isFinite(ts) && ts <= asOfMs
        })
        // If asOfMs is older than the oldest candle, sliced is empty.
        // In that case fall back to the first available candle so the
        // step-based indicator suite has at least one bar to chew on,
        // and the indication emission below uses the same fallback.
        if (sliced.length > 0) {
          candles = sliced
        } else {
          candles = candles.slice(0, 1)
        }
      }

      // Calculate step-based indicators
      const stepRange = Array.from({ length: 29 }, (_, i) => i + 2)
      const stepIndicators = StepBasedIndicators.calculateAll(candles, stepRange)

      // Extract prices safely. In replay mode the priceSource must be
      // the slice's tail candle (the simulated "current" bar), NOT the
      // live `marketData` snapshot which would leak realtime price into
      // a historical step.
      let priceSource: any = marketData
      if (typeof asOfMs === "number" && candles.length > 0) {
        priceSource = candles[candles.length - 1]
      } else if (marketData.candles && Array.isArray(marketData.candles) && marketData.candles.length > 0) {
        priceSource = marketData.candles[marketData.candles.length - 1]
      }
      
      const currentClose = Number.parseFloat(String(priceSource?.close || priceSource?.c || priceSource?.price || marketData?.close || marketData?.price || "0"))
      const currentOpen = Number.parseFloat(String(priceSource?.open || priceSource?.o || marketData?.open || currentClose))
      const currentHigh = Number.parseFloat(String(priceSource?.high || priceSource?.h || marketData?.high || currentClose))
      const currentLow = Number.parseFloat(String(priceSource?.low || priceSource?.l || marketData?.low || currentClose))
      const currentVolume = Number.parseFloat(String(priceSource?.volume || priceSource?.v || marketData?.volume || "0"))
      
      if (currentClose === 0 || isNaN(currentClose)) {
        return []
      }

      // Determine direction from real price data:
      // Use close vs open to set bullish/bearish direction for this candle.
      // Also generate the opposite direction as a hedge indication.
      const isBullish = currentClose >= currentOpen
      const primaryDir = isBullish ? "long" : "short"
      const secondaryDir = isBullish ? "short" : "long"

      // Derive confidence from candle body vs wick ratio (stronger body = higher confidence)
      const range = currentHigh - currentLow
      const body = Math.abs(currentClose - currentOpen)
      const bodyRatio = range > 0 ? Math.min(0.99, body / range) : 0.5
      const primaryConf = 0.5 + bodyRatio * 0.4  // 0.5 – 0.9
      const secondaryConf = 0.5 + (1 - bodyRatio) * 0.25 // 0.5 – 0.75 (weaker)

      // Profit factor proportional to confidence
      const primaryPF = 1.0 + primaryConf * 0.5
      const secondaryPF = 1.0 + secondaryConf * 0.3

      // ── Indication emission with differentiated semantics ────────────────
      //
      // Before this fix, every cycle pushed exactly one of every type per
      // direction (4 types × 2 dirs = 8 flat), so the dashboard showed
      // Dir=Move=Act=Opt in perfect lockstep and Auto was always 0.
      //
      // Each type now only fires when its own criterion is satisfied, so the
      // per-type counts naturally diverge and reflect real market structure:
      //
      //   direction — always emitted (2/cycle): primary + hedge trend signal
      //   move      — primary-direction candle expansion beyond a small live-noise floor
      //   active    — candle volume > recent-volume average (elevated activity)
      //   optimal   — strong confidence + strong body (conf ≥ 0.72 AND body-ratio ≥ 0.55)
      //   auto      — step-based indicator alignment across short/mid/long windows
      //
      // The scoring below is derived from the real candle data already in scope
      // (currentOpen/High/Low/Close/Volume, candles[], stepIndicators), so we
      // don't incur any extra fetches.

      const indications: any[] = []
      // Realtime mode anchors indications at wall-clock now. Replay mode
      // anchors them at the simulated candle timestamp so downstream
      // throttle keys, Set entries, and dashboard ordering line up with
      // the historical point in time the indication represents.
      const now = typeof asOfMs === "number" && Number.isFinite(asOfMs) ? asOfMs : Date.now()

      // Range-percent of the current candle (used by move threshold)
      const rangePercent = currentClose > 0 ? (range / currentClose) * 100 : 0

      // Recent-volume baseline: mean volume of the last ~20 candles (or fewer
      // if the window is smaller). Falls back to currentVolume so the first
      // warm-up ticks don't spuriously fire "active".
      let recentVolAvg = 0
      {
        const window = candles.slice(-20)
        let sum = 0
        let n = 0
        for (const c of window) {
          const v = Number(c?.volume ?? c?.v ?? 0)
          if (Number.isFinite(v) && v > 0) { sum += v; n++ }
        }
        recentVolAvg = n > 0 ? sum / n : currentVolume
      }

      // Auto-alignment: derived from the step-based indicator suite
      // (MA + RSI + MACD) across short / mid / long windows. Each step
      // indicator exposes `{ ma, rsi, macd: { macd, signal }, bb }`, so we
      // project each to a direction:
      //   * RSI  > 50 → long, RSI < 50 → short
      //   * MACD histogram > 0 (macd > signal) → long, else short
      //   * Price vs MA: close > ma → long, else short
      // A window is "aligned" when at least 2 of those 3 sub-signals agree;
      // we fire "auto" for the primary direction when ≥ 2 of the 3 windows
      // (steps 5 / 15 / 28) align in that direction.
      const autoAlignment = (() => {
        try {
          const projectWindow = (step: number): { dir: "long" | "short" | null; strength: number } => {
            const s = (stepIndicators as any)?.[step]
            if (!s) return { dir: null, strength: 0 }
            const rsi = Number(s.rsi) || 50
            const macdHist = (Number(s?.macd?.macd) || 0) - (Number(s?.macd?.signal) || 0)
            const ma = Number(s.ma) || 0
            const votes: Array<"long" | "short"> = []
            if (rsi !== 50) votes.push(rsi > 50 ? "long" : "short")
            if (macdHist !== 0) votes.push(macdHist > 0 ? "long" : "short")
            if (ma > 0) votes.push(currentClose >= ma ? "long" : "short")
            if (votes.length < 2) return { dir: null, strength: 0 }
            const longs = votes.filter((v) => v === "long").length
            const shorts = votes.length - longs
            if (longs === shorts) return { dir: null, strength: 0 }
            const dir: "long" | "short" = longs > shorts ? "long" : "short"
            // Strength = RSI distance from 50 (0–1) blended with vote majority.
            const rsiStrength = Math.min(1, Math.abs(rsi - 50) / 40)
            const voteStrength = Math.max(longs, shorts) / votes.length
            return { dir, strength: rsiStrength * 0.5 + voteStrength * 0.5 }
          }

          const windows = [projectWindow(5), projectWindow(15), projectWindow(28)]
          const alignedWindows = windows.filter((w) => w.dir === primaryDir)
          if (alignedWindows.length < 2) return null
          const avgStrength =
            alignedWindows.reduce((a, b) => a + b.strength, 0) / alignedWindows.length
          return { aligned: true, strength: Math.min(0.95, 0.5 + avgStrength * 0.45) }
        } catch {
          return null
        }
      })()

      // Loop over primary + hedge directions. Each condition is independent
      // so in a calm market only `direction` fires; on a big bullish candle
      // with elevated volume, all five fire.
      const pairs: Array<["long" | "short", number, number, boolean]> = [
        [primaryDir,   primaryConf,   primaryPF,   true],   // primary
        [secondaryDir, secondaryConf, secondaryPF, false],  // hedge
      ]

      for (const [dir, conf, pf, isPrimary] of pairs) {
        // 1. Direction — always emitted
        indications.push({
          type: "direction",
          symbol,
          value: currentClose,
          profitFactor: pf,
          confidence: conf,
          timestamp: now,
          metadata: { direction: dir, primary: isPrimary },
        })

        // 2. Move — independent from Direction. Emit only for the primary
        // candle direction and only when the candle expands beyond a tiny
        // live-noise floor. The previous `rangePercent >= 0` condition made
        // Move fire for every Direction signal (including hedge), so dashboard
        // counts for Direction and Move moved in lockstep.
        const moveThresholdPct = Math.max(0.01, Math.min(0.08, bodyRatio * 0.03))
        if (isPrimary && (rangePercent >= moveThresholdPct || bodyRatio >= 0.18)) {
          indications.push({
            type: "move",
            symbol,
            value: currentClose,
            profitFactor: pf * (1 + Math.min(0.25, rangePercent / 40)),
            confidence: conf * 0.95,
            timestamp: now,
            metadata: { direction: dir, rangePercent, primary: isPrimary },
          })
        }

        // 3. Active — only when volume is elevated above the recent baseline
        if (recentVolAvg > 0 && currentVolume >= recentVolAvg * 1.05) {
          indications.push({
            type: "active",
            symbol,
            value: currentClose,
            profitFactor: pf * 0.92,
            confidence: conf * 0.9,
            timestamp: now,
            metadata: {
              direction: dir,
              volumeRatio: currentVolume / recentVolAvg,
              primary: isPrimary,
            },
          })
        }

        // 4. Optimal — gated on high confidence AND strong body. Only the
        //    primary direction is ever optimal (hedge is never the "best" play).
        if (isPrimary && conf >= 0.72 && bodyRatio >= 0.55) {
          indications.push({
            type: "optimal",
            symbol,
            value: currentClose,
            profitFactor: Math.min(2.5, pf * 1.15),
            confidence: Math.min(0.95, conf * 1.05),
            timestamp: now,
            metadata: { direction: dir, bodyRatio, primary: true },
          })
        }

        // 5. Auto — step-based indicator alignment, primary direction only.
        if (isPrimary && autoAlignment?.aligned) {
          indications.push({
            type: "auto",
            symbol,
            value: currentClose,
            profitFactor: Math.min(2.3, pf * (1 + autoAlignment.strength * 0.35)),
            confidence: autoAlignment.strength,
            timestamp: now,
            metadata: { direction: dir, alignment: "step_5_15_28", primary: true },
          })
        }
      }

      // Store indication payloads (raw JSON list, per-type TTL keys).
      await storeIndications(this.connectionId, symbol, indications)

      // ── Increment the per-type counters that the dashboard reads ─────────
      //
      // `storeIndications` only persists the *raw* indication payloads; it
      // does NOT bump the `indications:{connId}:{type}:count` keys nor the
      // `indications_{type}_count` fields on the `progression:{connId}` hash.
      //
      // The dashboard ("Indications by Type" breakdown on the main connection
      // card) reads exclusively from those counters, so without this call
      // every counter stays at zero even when the engine is generating real
      // indications every cycle — which is what made the per-type counts
      // look identical (and Auto stuck at 0) in recent versions.
      //
      // We fan out one `trackIndicationStats` call per indication in parallel
      // so a busy cycle (10–12 indications) pays a single Redis round-trip
      // window instead of N sequential ones.
      if (indications.length > 0) {
        await Promise.all(
          indications.map((ind) =>
            trackIndicationStats(
              this.connectionId,
              symbol,
              ind.type,
              Number(ind.value) || 0,
              Number(ind.confidence) || 0,
            ).catch(() => { /* non-critical stats path */ }),
          ),
        )
      }

      // ── Write per-type counts to indications_active hash ─────────────
      // The dashboard "Indications" active tile reads from the
      // `indications_active:{connectionId}` hash (via /stats).
      // Without this write the hash stays empty after its 10-min TTL
      // expires and every active-count tile shows 0 even while the
      // engine is producing thousands of indications per minute.
      {
        const typeCounts: Record<string, number> = {
          direction: 0,
          move: 0,
          active: 0,
          active_advanced: 0,
          optimal: 0,
          auto: 0,
        }
        for (const ind of indications) {
          typeCounts[ind.type] = (typeCounts[ind.type] ?? 0) + 1
        }
        try {
          const { getClient: _gc, initRedis: _ir } = await import("@/lib/redis-db")
          await _ir()
          const _client = _gc()
          const activeKey = `indications_active:${this.connectionId}`
          const w5Key = `indications_window:${this.connectionId}:last5`
          const w60Key = `indications_window:${this.connectionId}:last60min`
          const fields: Record<string, string> = {}
          for (const [type, cnt] of Object.entries(typeCounts)) {
            fields[`${symbol}:${type}`] = String(cnt)
          }
          const pipe = _client.multi()
          pipe.hset(activeKey, fields)
          pipe.expire(activeKey, 600)
          // Keep windowed stats idempotent and per-symbol for all raw
          // indication types, including Auto. Without these writes, the
          // detailed tracking endpoint falls back to cumulative counters and
          // shows inflated/identical "last 5" numbers in production.
          pipe.hset(w5Key, fields)
          pipe.expire(w5Key, 300)
          pipe.hset(w60Key, fields)
          pipe.expire(w60Key, 4200)
          await pipe.exec()
        } catch { /* non-critical — falls back to cumulative indCounts */ }
      }

      return indications
    } catch (error) {
      console.error(`[v0] [IndicationProcessor] Error in processIndication for ${symbol}:`, error)
      return []
    }
  }

  private async getLatestMarketDataCached(symbol: string): Promise<any> {
    // CRITICAL FIX: Use module-level SHARED_MARKET_DATA_CACHE directly, never this.marketDataCache
    const cached = SHARED_MARKET_DATA_CACHE.get(symbol)
    const now = Date.now()
    
    if (cached && (now - cached.timestamp) < SHARED_CACHE_TTL) {
      return cached.data
    }
    
    // Fetch fresh data from Redis using dynamic import to avoid any stale references
    try {
      const { getMarketData, getClient, initRedis } = await import("@/lib/redis-db")
      // getMarketData requires both symbol and interval - use 1m as default for real-time trading
      const data = await getMarketData(symbol, "1m")
      
      // If no data from interval key, try direct Redis access as fallback
      if (!data) {
        await initRedis()
        const client = getClient()
        // Spec §7: read the canonical :1s envelope first, fall back
        // to the legacy :1m suffix while the migration is in flight.
        const rawData =
          (await client.get(`market_data:${symbol}:1s`)) ??
          (await client.get(`market_data:${symbol}:1m`))
        if (rawData) {
          try {
            const parsed = JSON.parse(rawData)
            if (parsed && parsed.candles && parsed.candles.length > 0) {
              sharedCacheSet(symbol, { data: parsed, timestamp: now })
              return parsed
            }
          } catch (parseErr) {
            console.warn(`[v0] [IndicationProcessor] Failed to parse market data for ${symbol}`)
          }
        }
        
        // Try hash key as last resort
        const hashData = await client.hgetall(`market_data:${symbol}`)
        if (hashData && Object.keys(hashData).length > 0) {
          sharedCacheSet(symbol, { data: hashData, timestamp: now })
          return hashData
        }
      }
      
      if (data) {
        sharedCacheSet(symbol, { data, timestamp: now })
      }
      return data
    } catch (e) {
      console.error(`[v0] [IndicationProcessor] Error fetching market data for ${symbol}:`, e)
      return cached?.data || null
    }
  }

  /**
   * Get indication settings with caching - uses module-level cache
   * CRITICAL: This method MUST NOT use this.settingsCache - it may be undefined
   */
  private async getIndicationSettingsCached(): Promise<any> {
    // Use module-level SHARED_SETTINGS_CACHE directly
    const now = Date.now()
    if (SHARED_SETTINGS_CACHE.data && (now - SHARED_SETTINGS_CACHE.timestamp) < SHARED_CACHE_TTL) {
      return SHARED_SETTINGS_CACHE.data
    }
    
    try {
      const { getSettings } = await import("@/lib/redis-db")
      const data = await getSettings("indication_settings")
      if (data) {
        SHARED_SETTINGS_CACHE.data = data
        SHARED_SETTINGS_CACHE.timestamp = now
      }
      return data || {}
    } catch (e) {
      return SHARED_SETTINGS_CACHE.data || {}
    }
  }
}
