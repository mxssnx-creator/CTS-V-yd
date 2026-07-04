/**
 * Market Data Loader
 * Populates Redis with REAL OHLCV data from exchanges for trading engine
 *
 * ── KEY ARCHITECTURE (post spec §7 migration) ──────────────────────
 *
 *   market_data:{symbol}:1s       → JSON envelope, MarketData with 1s
 *                                   OHLCV buckets (default 1-day window,
 *                                   up to 86,400 buckets). Authoritative
 *                                   prehistoric source. Replaces the
 *                                   legacy `:1m` envelope which is no
 *                                   longer populated.
 *   market_data:{symbol}:candles  → JSON string, raw candles array
 *                                   (mirrors the 1s array; used by the
 *                                   indication processor for history
 *                                   access without parsing the envelope).
 *   market_data:{symbol}          → Redis hash, single latest candle
 *                                   (used by getMarketData() in
 *                                   redis-db for ticker snapshots).
 *
 * Why we changed timeframe everywhere:
 *   The operator spec explicitly says "Interval / Timeframe has to be
 *   1s as in Settings, change everywhere for Main Engine ... actually
 *   1 day." All callers now pass timeframe="1s" and the connector
 *   either uses native 1s klines (Binance spot) or aggregates from
 *   public-trade endpoints (see lib/exchange-connectors/aggregate-1s.ts).
 */

import { getClient, initRedis, getAllConnections } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors"

export interface MarketDataCandle {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

export interface MarketData {
  symbol: string
  timeframe: string // "1m", "5m", "15m", "1h", "4h", "1d"
  candles: MarketDataCandle[]
  lastUpdated: string
  source: string // Exchange name or "synthetic"
}

/**
 * Generate synthetic market data as fallback
 * Only used when exchange fetch fails
 */
export function generateSyntheticCandles(
  symbol: string,
  basePrice: number,
  candleCount: number = 100
): MarketDataCandle[] {
  const candles: MarketDataCandle[] = []
  const now = Date.now()
  // Spec §7: timeframe is 1s, so synthetic samples step at 1-second
  // intervals (was 1 minute). Magnitude of per-bar drift is scaled
  // down 60× below so the price walk doesn't look insane.
  const candleInterval = 1000 // 1 second in ms

  let lastClose = basePrice

  for (let i = candleCount; i > 0; i--) {
    const timestamp = now - i * candleInterval
    
    // Generate realistic per-second price movement. At 1s resolution
    // a ±0.5% drift per bar would integrate to crazy intraday swings,
    // so we scale to ~±0.008% / bar — roughly 0.5% per minute on a
    // random walk basis, matching the previous behaviour at 1m.
    const change = (Math.random() - 0.5) * lastClose * 0.000167
    const open = lastClose
    const close = Math.max(lastClose * 0.8, lastClose + change)
    const high = Math.max(open, close) * (1 + Math.random() * 0.0001)
    const low = Math.min(open, close) * (1 - Math.random() * 0.0001)
    const volume = Math.random() * 1000000

    candles.push({
      timestamp,
      open,
      high,
      low,
      close,
      volume,
    })

    lastClose = close
  }

  return candles
}

/**
 * Fetch real OHLCV data from exchange
 * Uses the first available connection with valid credentials
 */
async function fetchRealMarketData(
  symbol: string,
  timeframe = "1m",
  limit = 250
): Promise<{ candles: MarketDataCandle[]; source: string } | null> {
  try {
    // Get all connections with credentials
    const connections = await getAllConnections()
    const validConnections = connections.filter((c: any) => {
      const hasCredentials = (c.api_key || c.apiKey) && (c.api_secret || c.apiSecret)
      const hasValidCredentials = hasCredentials && 
        (c.api_key || c.apiKey || "").length > 5 && 
        (c.api_secret || c.apiSecret || "").length > 5
      return hasValidCredentials
    })

    if (validConnections.length === 0) {
      console.log(`[v0] [MarketData] No valid connections for fetching real data`)
      return null
    }

    // Try each connection until we get data
    for (const conn of validConnections) {
      try {
        // Pass the original api_type - connector factory handles normalization per-exchange
        const connector = await createExchangeConnector(
          conn.exchange,
          {
            apiKey: conn.api_key || conn.apiKey || "",
            apiSecret: conn.api_secret || conn.apiSecret || "",
            apiType: (conn.api_type || "perpetual") as string,
            isTestnet: conn.is_testnet === "1" || conn.is_testnet === true,
          }
        )

        console.log(`[v0] [MarketData] Fetching ${symbol} from ${conn.exchange} (${conn.name})...`)
        
        const candles = await connector.getOHLCV(symbol, timeframe, limit)
        
        if (candles && candles.length > 0) {
          console.log(`[v0] [MarketData] ✓ Fetched ${candles.length} real candles from ${conn.exchange}`)
          return { candles, source: conn.exchange }
        }
      } catch (err) {
        console.warn(`[v0] [MarketData] Failed to fetch from ${conn.exchange}:`, err)
        continue
      }
    }

    return null
  } catch (error) {
    console.error("[v0] [MarketData] Error fetching real market data:", error)
    return null
  }
}

const DEFAULT_ENGINE_MARKET_SYMBOLS = [
  "BTCUSDT",  "ETHUSDT",  "SOLUSDT",  "BNBUSDT",  "XRPUSDT",
  "DOGEUSDT", "ADAUSDT",  "AVAXUSDT", "LINKUSDT", "DOTUSDT",
  "ATOMUSDT", "LTCUSDT",  "UNIUSDT",  "NEARUSDT", "MATICUSDT",
]

// ── In-flight deduplication ─────────────────────────────────────────
// `loadMarketDataForEngine` is called from four independent paths:
// engine boot, heartbeat (30s), prehistoric cycle (adaptive), and the
// fallback error handler. When two callers fire concurrently, they
// would each fetch+parse+write the same symbol list independently,
// doubling exchange API calls and Redis writes.
const __loadFlights = new Map<string, Promise<number>>()
let __lastDevCacheHitLogAt = 0

/**
 * Load market data for all symbols into Redis
 * Fetches REAL data from exchanges, falls back to synthetic only on failure
 */
export async function loadMarketDataForEngine(symbols: string[] = []): Promise<number> {
  const requestedSymbols = symbols.length > 0 ? symbols : DEFAULT_ENGINE_MARKET_SYMBOLS
  const uniqueSymbols = Array.from(new Set(requestedSymbols.map((s) => String(s || "").trim().toUpperCase()).filter(Boolean)))
  const flightKey = uniqueSymbols.join("|")

  // Coalesce concurrent calls — the second caller joins the first
  // promise for the exact same symbol set and receives the same result,
  // avoiding duplicate work without making a 32-symbol quickstart wait on
  // an unrelated 3-symbol heartbeat flight.
  const existingFlight = __loadFlights.get(flightKey)
  if (existingFlight) return existingFlight

  const flight = (async () => {
  try {
    await initRedis()
    const client = getClient()

    // Default symbols if none provided — matches the production set seeded by
    // migrations (ordered by 1h volatility per standing directive).
    let targetSymbols = uniqueSymbols

    // ── Dev-mode cache short-circuit ──────────────────────────────────
    // Next.js dev hot-reload can call this dozens of times per minute from
    // engine boot, heartbeat, realtime, and prehistoric loops. The old guard
    // checked only BTCUSDT, then logged on every call; that both hid missing
    // non-BTC quickstart symbols and flooded stdout enough to slow the dev
    // engine. Check the requested symbol set, only load missing symbols, and
    // throttle the "already cached" log.
    {
      const cacheKeys = targetSymbols.map((symbol) => `market_data:${symbol}:1s`)
      const cachedValues = cacheKeys.length > 0
        ? (await (client as any).mget(...cacheKeys)) as (string | null)[]
        : []
      const missingSymbols = targetSymbols.filter((_, index) => !cachedValues[index])
      if (missingSymbols.length === 0) {
        const now = Date.now()
        if (now - __lastDevCacheHitLogAt > 30_000) {
          __lastDevCacheHitLogAt = now
          console.log(`[v0] [MarketData] ${targetSymbols.length} requested symbols already cached; skipping reload`)
        }
        return 0
      }
      targetSymbols = missingSymbols
      console.log(`[v0] [MarketData] ${cachedValues.length - missingSymbols.length}/${cachedValues.length} requested symbols cached; loading ${missingSymbols.length} missing`)
    }

    // Base prices for fallback synthetic data. Used when the live exchange
    // fetch fails (no API key / rate limit). Prices are approximate Jun-2026
    // values; the synthetic generator applies ±0.5 % random walk so they
    // drift realistically over the 86,400-candle window.
    const basePrices: Record<string, number> = {
      BTCUSDT:  65000, ETHUSDT:  3500,  SOLUSDT:  165,  BNBUSDT:   620,
      XRPUSDT:  0.55,  DOGEUSDT: 0.18,  ADAUSDT:  0.90, AVAXUSDT:  40,
      LINKUSDT: 18,    DOTUSDT:  9.5,   ATOMUSDT: 11,   LTCUSDT:   95,
      UNIUSDT:  12,    NEARUSDT: 7.5,   MATICUSDT:1.1,
      // Legacy symbols kept for backward-compat with any cached keys.
      LITUSDT: 120, THETAUSDT: 2.5, APTUSDT: 10, ARBUSDT: 1.8,
    }

    let loaded = 0
    let realDataCount = 0
    let syntheticCount = 0

    console.log(`[v0] [MarketData] Loading 1s market data for ${targetSymbols.length} symbols (1-day window, parallel)...`)
    console.log(`[v0] [MarketData] Will try to fetch REAL 1s intervals from exchanges first...`)

    // ── Window: 1 day at 1s timeframe (spec §7) ─────────────────────
    // 86,400 buckets per symbol. Real connectors will return what
    // their public endpoints allow — Binance spot delivers the full
    // window via paginated 1s klines; other connectors return their
    // best-effort coverage from recent-trades aggregation.
    const ONE_DAY_SECONDS = 86_400

    // ── Per-symbol cold-boot loader ─────────────────────────────────
    // Each symbol's fetch + 4 Redis writes (set candles, expire,
    // set 1s blob, expire, hmset latest, expire) is fully independent.
    // We bound concurrency to avoid hammering exchange APIs with
    // 15+ simultaneous REST calls — pick the lower of the symbol
    // count and 6 (conservative under public rate limits).
    const SYMBOL_CONCURRENCY = Math.max(1, Math.min(targetSymbols.length, 6))
    let nextIdx = 0
    const loadOne = async (symbol: string): Promise<void> => {
      try {
        // Try to fetch real 1s data first.
        const realData = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)

        let candles: MarketDataCandle[]
        let source: string

        if (realData && realData.candles.length > 0) {
          candles = realData.candles
          source = realData.source
          realDataCount++
        } else {
          // Fall back to synthetic 1s data — same shape so downstream
          // doesn't care. We don't generate 86k synthetic buckets; a
          // 250-bucket sample is enough for cold-boot decoration
          // before real data arrives via the engine's own loader.
          const basePrice = basePrices[symbol] || 100
          candles = generateSyntheticCandles(symbol, basePrice, 250)
          source = "synthetic"
          syntheticCount++
          console.log(`[v0] [MarketData] ⚠ Using synthetic data for ${symbol} (exchange 1s fetch failed)`)
        }

        const marketData: MarketData = {
          symbol,
          timeframe: "1s",
          candles,
          lastUpdated: new Date().toISOString(),
          source,
        }

        // Authoritative key under the new :1s suffix.
        const key = `market_data:${symbol}:1s`
        const jsonData = JSON.stringify(marketData)

        // Store raw candles array for indication processor historical access.
        const candlesKey = `market_data:${symbol}:candles`

        // Also write latest bucket to hash format so getMarketData() works.
        const latestCandle = candles[candles.length - 1]

        // Fire every Redis write for this symbol in one parallel
        // batch — previously these were six chained awaits.
        const writes: Promise<unknown>[] = [
          client.set(key, jsonData),
          client.expire(key, 86400),
          client.set(candlesKey, JSON.stringify(candles)),
          client.expire(candlesKey, 86400),
        ]
        if (latestCandle) {
          const hashKey = `market_data:${symbol}`
          const flatHash: Record<string, string> = {
            symbol,
            exchange: source,
            interval: "1s",
            price: String(latestCandle.close),
            open: String(latestCandle.open),
            high: String(latestCandle.high),
            low: String(latestCandle.low),
            close: String(latestCandle.close),
            volume: String(latestCandle.volume),
            timestamp: new Date(latestCandle.timestamp).toISOString(),
            // `candles_count` field name preserved so downstream readers
            // don't need a migration; it now counts 1s INTERVALS.
            candles_count: String(candles.length),
            data_source: source,
          }
          const flatArgs: string[] = []
          for (const [k, v] of Object.entries(flatHash)) {
            flatArgs.push(k, v)
          }
          writes.push(client.hmset(hashKey, ...flatArgs))
          writes.push(client.expire(hashKey, 86400))

          const priceStr = latestCandle.close.toFixed(2)
          const sourceLabel = source === "synthetic" ? "(synthetic)" : `(real: ${source})`
          console.log(`[v0] [MarketData] ✓ ${symbol}: $${priceStr} ${sourceLabel} (${candles.length} intervals)`)
        }
        await Promise.all(writes)

        loaded++
      } catch (error) {
        console.error(`[v0] [MarketData] Failed to load ${symbol}:`, error)
      }
    }

    // Bounded worker pool — same pattern as engine-manager's
    // `mapWithConcurrency` (kept local here to avoid circular imports).
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++
        if (i >= targetSymbols.length) return
        await loadOne(targetSymbols[i])
      }
    }
    const workers: Promise<void>[] = []
    const pool = Math.min(SYMBOL_CONCURRENCY, targetSymbols.length)
    for (let w = 0; w < pool; w++) workers.push(worker())
    await Promise.all(workers)

    console.log(`[v0] [MarketData] ✅ Loaded ${loaded}/${targetSymbols.length} symbols`)
    console.log(`[v0] [MarketData]    Real data: ${realDataCount} | Synthetic: ${syntheticCount}`)
    return loaded
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load market data:", error)
    return 0
  }
  })()
  __loadFlights.set(flightKey, flight)
  flight.finally(() => { __loadFlights.delete(flightKey) })
  return flight
}

/**
 * Update market data for a specific symbol with REAL data from exchange
 */
export async function updateMarketDataForSymbol(symbol: string, connectionId?: string): Promise<boolean> {
  try {
    await initRedis()
    const client = getClient()

    // If connectionId provided, use that specific connection
    // Otherwise try all connections
    let candles: MarketDataCandle[] | null = null
    let source = "synthetic"

    // Spec §7: same window as the bulk loader — 1s × 1 day.
    const ONE_DAY_SECONDS = 86_400

    if (connectionId) {
      const connections = await getAllConnections()
      const conn = connections.find((c: any) => c.id === connectionId)
      if (conn) {
        const result = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)
        if (result) {
          candles = result.candles
          source = result.source
        }
      }
    } else {
      const result = await fetchRealMarketData(symbol, "1s", ONE_DAY_SECONDS)
      if (result) {
        candles = result.candles
        source = result.source
      }
    }

    // If no real data, use existing or generate synthetic
    if (!candles || candles.length === 0) {
      // Try to get existing data — :1s is now authoritative; fall back
      // to the legacy :1m envelope for one release so partial upgrades
      // don't lose data.
      const existing = (await client.get(`market_data:${symbol}:1s`)) ?? (await client.get(`market_data:${symbol}:1m`))
      if (existing) {
        const existingData: MarketData = JSON.parse(existing)
        candles = existingData.candles
        source = existingData.source || "synthetic"
      } else {
        // Generate synthetic
        candles = generateSyntheticCandles(symbol, 100, 250)
        source = "synthetic"
      }
    }

    const marketData: MarketData = {
      symbol,
      timeframe: "1s",
      candles,
      lastUpdated: new Date().toISOString(),
      source,
    }

    const key = `market_data:${symbol}:1s`
    await client.set(key, JSON.stringify(marketData))
    await client.expire(key, 86400)

    // Update candles array
    const candlesKey = `market_data:${symbol}:candles`
    await client.set(candlesKey, JSON.stringify(candles))
    await client.expire(candlesKey, 86400)

    // Update hash
    const latestCandle = candles[candles.length - 1]
    if (latestCandle) {
      const hashKey = `market_data:${symbol}`
      const flatHash: Record<string, string> = {
        symbol,
        exchange: source,
        interval: "1s",
        price: String(latestCandle.close),
        open: String(latestCandle.open),
        high: String(latestCandle.high),
        low: String(latestCandle.low),
        close: String(latestCandle.close),
        volume: String(latestCandle.volume),
        timestamp: new Date(latestCandle.timestamp).toISOString(),
        candles_count: String(candles.length),
        data_source: source,
        last_updated: new Date().toISOString(),
      }
      const flatArgs: string[] = []
      for (const [k, v] of Object.entries(flatHash)) {
        flatArgs.push(k, v)
      }
      await client.hmset(hashKey, ...flatArgs)
      await client.expire(hashKey, 86400)
    }

    console.log(`[v0] [MarketData] ✓ Updated ${symbol} with ${source} data`)
    return source !== "synthetic"
  } catch (error) {
    console.error(`[v0] [MarketData] Failed to update ${symbol}:`, error)
    return false
  }
}

/**
 * Load market data for a specific date range
 * Fetches REAL historical data from exchanges when possible
 */
export async function loadHistoricalMarketData(
  symbol: string,
  startDate: Date,
  endDate: Date,
  timeframe: string = "1h"
): Promise<MarketDataCandle[]> {
  try {
    // Try to fetch real historical data - NO LIMIT
    const realData = await fetchRealMarketData(symbol, timeframe, 1000000)
    
    if (realData && realData.candles.length > 0) {
      console.log(`[v0] [MarketData] Using real historical data for ${symbol}: ${realData.candles.length} candles`)
      return realData.candles
    }

    // Fall back to synthetic - NO LIMIT
    console.log(`[v0] [MarketData] Generating synthetic historical data for ${symbol}`)
    const daysDiff = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24))
    const candlesPerDay = timeframe === "1h" ? 24 : timeframe === "4h" ? 6 : 1
    const totalCandles = daysDiff * candlesPerDay

    const candles = generateSyntheticCandles(symbol, 100, totalCandles)

    // Adjust timestamps to match the date range
    const startTimestamp = startDate.getTime()
    const interval = timeframe === "1h" ? 3600000 : timeframe === "4h" ? 14400000 : 86400000

    candles.forEach((candle, index) => {
      candle.timestamp = startTimestamp + index * interval
    })

    console.log(`[v0] [MarketData] Generated synthetic historical for ${symbol}: ${candles.length} candles`)
    return candles
  } catch (error) {
    console.error("[v0] [MarketData] Failed to load historical data:", error)
    return []
  }
}
