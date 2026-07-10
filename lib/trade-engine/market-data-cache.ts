/**
 * Market Data Cache Module
 * Standalone module-level caching for market data to avoid class context issues
 * Optimized for high-frequency, high-performance processing:
 *   - 200ms TTL per symbol (covers 1s indication cycle with headroom)
 *   - Batch prefetch for multiple symbols in one Redis pipeline call
 *   - In-flight deduplication to prevent concurrent fetches for the same symbol
 * @version 2.0.0
 */

import { initRedis, getMarketData, getRedisClient } from "@/lib/redis-db"

// Module-level cache - guaranteed to exist, no class context issues
const CACHE = new Map<string, { data: any; timestamp: number }>()
// High-frequency TTL: 200ms ensures fresh data each indication cycle (1000ms interval)
// but avoids redundant Redis round-trips within the same cycle across parallel symbol processing
const CACHE_TTL = 200 // ms

// In-flight deduplication: if a fetch is already in-progress for a symbol, await the same promise
const IN_FLIGHT = new Map<string, Promise<any>>()

/**
 * Get market data with caching - module-level function
 * No class context needed - works reliably across webpack bundle reloads
 */
export async function getMarketDataCached(symbol: string): Promise<any> {
  const now = Date.now()
  const cached = CACHE.get(symbol)

  if (cached && now - cached.timestamp < CACHE_TTL) {
    return cached.data
  }

  // Deduplicate concurrent fetches for the same symbol
  const inFlight = IN_FLIGHT.get(symbol)
  if (inFlight) return inFlight

  const fetchPromise = (async () => {
    try {
      await initRedis()
      const rawData = await getMarketData(symbol, "1m")

      if (!rawData) {
        return null
      }

      const latest = Array.isArray(rawData) ? rawData[0] : rawData

      if (latest) {
        CACHE.set(symbol, { data: latest, timestamp: Date.now() })
        return latest
      }
      return null
    } catch (error) {
      // Return stale cache entry rather than null on transient Redis errors
      return CACHE.get(symbol)?.data ?? null
    } finally {
      IN_FLIGHT.delete(symbol)
    }
  })()

  IN_FLIGHT.set(symbol, fetchPromise)
  return fetchPromise
}

/**
 * Batch prefetch market data for multiple symbols in a single Redis pipeline
 * Call this at the start of each indication cycle to warm the cache for all symbols
 * so individual processIndication calls hit cache (zero Redis round-trips).
 */
export async function prefetchMarketDataBatch(symbols: string[]): Promise<void> {
  if (!symbols || symbols.length === 0) return
  try {
    await initRedis()
    const client = getRedisClient()
    const now = Date.now()

    // Filter to only symbols whose cache is stale
    const stale = symbols.filter((s) => {
      const c = CACHE.get(s)
      return !c || now - c.timestamp >= CACHE_TTL
    })
    if (stale.length === 0) return

    // Use Redis pipeline for minimal round-trips
    const pipeline = client.multi()
    for (const symbol of stale) {
      pipeline.hgetall(`market_data:${symbol}`)
    }
    const results = await pipeline.exec()

    if (Array.isArray(results)) {
      for (let i = 0; i < stale.length; i++) {
        const data = results[i]
        if (data && typeof data === "object" && Object.keys(data).length > 0) {
          CACHE.set(stale[i], { data, timestamp: Date.now() })
        }
      }
    }
    } catch (e) {
      // Log the failure so operators can see when prefetch is broken —
      // individual getMarketDataCached calls downstream each pay a full
      // Redis round-trip when prefetch silently fails.
      console.warn(
        `[v0] [MarketDataCache] Prefetch batch failed for ${symbols.length} symbols:`,
        e instanceof Error ? e.message : String(e),
      )
    }
}

// Settings cache - 5s TTL (settings change rarely)
let SETTINGS_CACHE: { data: any; timestamp: number } | null = null
const SETTINGS_CACHE_TTL = 5000 // ms

// ── Parsed prehistoric-candles cache (OOM-protection) ─────────────────────
// The prehistoric replay loop (engine-manager) previously did
// `client.get(market_data:{sym}:candles)` + `JSON.parse` of the FULL ~86,400
// candle blob (~10 MB of JSON) PER SYMBOL on EVERY cycle (~1/sec), then
// `.filter().sort()` allocated several more copies. Across 5–15 symbols this
// transient garbage outpaced GC and OOM-killed next-server minutes after the
// engine became active (verified: FATAL "Ineffective mark-compacts near heap
// limit", RSS jumping ~1.5GB → ~5GB in a single 30s window).
//
// Prehistoric candles are STATIC for a session, so parse each blob at most
// once and reuse the parsed+sorted array across cycles. The cache key is the
// symbol; a cheap length signature (raw string length) invalidates the entry
// only when the underlying blob actually changes (e.g. a reload writes a
// different candle count). Bounded to a handful of symbols — the engine only
// ever replays its configured symbol set.
const PARSED_CANDLES_CACHE = new Map<
  string,
  { candles: any[]; sig: number; timestamp: number }
>()
const PARSED_CANDLES_TTL = 5 * 60_000 // 5 min — defensive eviction
const PARSED_CANDLES_MAX_ENTRIES = 64

/**
 * Return the parsed candle array for a symbol, parsing the Redis JSON blob at
 * most once per data version instead of on every replay cycle. Candles are
 * returned ascending by timestamp. The returned array is SHARED — callers must
 * treat it as read-only (the replay loop only ever .filter()s a copy from it).
 */
export async function getParsedCandlesCached(symbol: string): Promise<any[]> {
  const now = Date.now()
  try {
    await initRedis()
    const client = getRedisClient()
    const raw = await client.get(`market_data:${symbol}:candles`)
    if (!raw) {
      // No prehistoric blob — fall back to the :1s envelope, also cached.
      const envelopeRaw = await client.get(`market_data:${symbol}:1s`)
      if (!envelopeRaw) return []
      const sig = typeof envelopeRaw === "string" ? envelopeRaw.length : 0
      const cached = PARSED_CANDLES_CACHE.get(symbol)
      if (cached && cached.sig === sig) {
        cached.timestamp = now
        return cached.candles
      }
      // Redis returns strings; parse directly without re-stringify
      const obj = JSON.parse(typeof envelopeRaw === "string" ? envelopeRaw : JSON.stringify(envelopeRaw))
      const arr: any[] = Array.isArray(obj?.candles) ? obj.candles : []
      arr.sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
      _storeParsedCandles(symbol, arr, sig, now)
      return arr
    }

    const sig = typeof raw === "string" ? raw.length : 0
    const cached = PARSED_CANDLES_CACHE.get(symbol)
    if (cached && cached.sig === sig) {
      // Hit — refresh recency and reuse the already-parsed+sorted array.
      cached.timestamp = now
      return cached.candles
    }

    // Redis returns strings; parse directly without re-stringify
    const parsed: any[] = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw))
    const arr = Array.isArray(parsed) ? parsed : []
    // Sort once at parse time so the replay loop never re-sorts the full set.
    arr.sort((a: any, b: any) => Number(a?.timestamp ?? 0) - Number(b?.timestamp ?? 0))
    _storeParsedCandles(symbol, arr, sig, now)
    return arr
  } catch (e) {
    // On transient Redis/parse errors, return the last good parse if present.
    return PARSED_CANDLES_CACHE.get(symbol)?.candles ?? []
  }
}

function _storeParsedCandles(symbol: string, candles: any[], sig: number, now: number) {
  PARSED_CANDLES_CACHE.set(symbol, { candles, sig, timestamp: now })
  // Evict stale / overflow entries so the Map can never grow unbounded.
  if (PARSED_CANDLES_CACHE.size > PARSED_CANDLES_MAX_ENTRIES) {
    for (const [k, v] of PARSED_CANDLES_CACHE) {
      if (now - v.timestamp > PARSED_CANDLES_TTL) PARSED_CANDLES_CACHE.delete(k)
    }
    // If still over capacity, drop the oldest entries.
    if (PARSED_CANDLES_CACHE.size > PARSED_CANDLES_MAX_ENTRIES) {
      const sorted = [...PARSED_CANDLES_CACHE.entries()].sort(
        (a, b) => a[1].timestamp - b[1].timestamp,
      )
      const drop = sorted.slice(0, PARSED_CANDLES_CACHE.size - PARSED_CANDLES_MAX_ENTRIES)
      for (const [k] of drop) PARSED_CANDLES_CACHE.delete(k)
    }
  }
}

/** Drop a symbol's parsed-candle cache (call after a forced reload). */
export function invalidateParsedCandles(symbol?: string) {
  if (symbol) PARSED_CANDLES_CACHE.delete(symbol)
  else PARSED_CANDLES_CACHE.clear()
}


/**
 * Get settings with caching - module-level function
 */
export async function getSettingsCached(): Promise<any> {
  const now = Date.now()

  if (SETTINGS_CACHE && now - SETTINGS_CACHE.timestamp < SETTINGS_CACHE_TTL) {
    return SETTINGS_CACHE.data
  }

  try {
    const { getAppSettings } = await import("@/lib/redis-db")
    await initRedis()
    // Mirror-aware read — covers both `app_settings` and `all_settings`.
    const settings = (await getAppSettings()) || {}

    const indicationSettings = {
      minProfitFactor: settings.minProfitFactor || 1.2,
      minConfidence: settings.minConfidence || 0.6,
      timeframes: settings.timeframes || ["1h", "4h", "1d"],
    }

    SETTINGS_CACHE = { data: indicationSettings, timestamp: now }
    return indicationSettings
  } catch {
    return {
      minProfitFactor: 1.2,
      minConfidence: 0.6,
      timeframes: ["1h", "4h", "1d"],
    }
  }
}
