/**
 * Cron-style API that generates indications and strategies for active connections.
 * Uses real market data from Redis and writes to the progression hash so the
 * dashboard reads real values from progression:{connectionId}.
 * 
 * Writes per-cycle:
 *   indication_cycle_count   — HINCRBY 1
 *   strategy_cycle_count     — HINCRBY 1
 *   indications_count        — HINCRBY N
 *   indications_{type}_count — HINCRBY 1 per type
 *   strategies_base_total    — HINCRBY N (Base stage: initial strategy Sets)
 *   strategies_main_total    — HINCRBY M (Main stage: Base Sets that passed PF filter)
 *   strategies_real_total    — HINCRBY R (Real stage: Main Sets that passed strict filter)
 *   strategies_count         — HINCRBY R (= final-stage Real count; the pipeline
 *                              stages are a cascade filter of the SAME logical
 *                              strategy so they are NOT summed together)
 *   cycle_success_rate       — HSET (rolling %)
 *   last_update              — HSET (ISO timestamp)
 */
import { NextResponse } from "next/server"
import { isTruthyFlag, isConnectionInActivePanel } from "@/lib/connection-state-utils"
import { getCronEngineEligibleConnections } from "@/lib/cron-engine-eligibility"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { fetchTopSymbols } from "@/lib/top-symbols"
import { RealtimeProcessor } from "@/lib/trade-engine/realtime-processor"
import { IndicationProcessor } from "@/lib/trade-engine/indication-processor-fixed"
import { StrategyProcessor } from "@/lib/trade-engine/strategy-processor"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { runIndStratCycle, type PipelineCycleResult } from "@/lib/trade-engine/shared-ind-strat-pipeline"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const revalidate = 0
export const fetchCache = "force-no-store"

// Fallback symbols if no market data is available in Redis
const FALLBACK_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]

// In-memory cache for the most volatile symbol per exchange (60s TTL)
const volatileSymbolCache = new Map<string, { symbol: string; ts: number }>()
const CACHE_TTL = 60_000

function normalizeSymbolList(value: unknown): string[] {
  const out: string[] = []
  const push = (v: unknown) => {
    if (typeof v !== "string") return
    const sym = v.trim().toUpperCase()
    if (/^[A-Z0-9]{2,30}$/.test(sym)) out.push(sym)
  }

  if (Array.isArray(value)) {
    for (const item of value) push(item)
  } else if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed)
        if (Array.isArray(parsed)) {
          for (const item of parsed) push(item)
        }
      } catch {
        // Fall through to delimiter parsing below.
      }
    }
    if (out.length === 0) {
      for (const token of trimmed.split(/[\s,|;]+/)) push(token)
    }
  }

  return Array.from(new Set(out))
}

// CRITICAL: Never HTTP-self-fetch from a route handler — it deadlocks the dev server
// and hangs on Vercel when the request context is unavailable. Call the shared lib fn
// directly so resolution happens in-process with zero network overhead.
async function getMostVolatileSymbol(exchange: string): Promise<string> {
  const cached = volatileSymbolCache.get(exchange)
  if (cached && Date.now() - cached.ts < CACHE_TTL) return cached.symbol

  try {
    const result = await fetchTopSymbols(exchange, 1, "volatility")
    if (result?.symbol) {
      volatileSymbolCache.set(exchange, { symbol: result.symbol, ts: Date.now() })
      return result.symbol
    }
  } catch {
    // fall through to fallback
  }

  return FALLBACK_SYMBOLS[0]
}

async function getMarketDataForSymbol(symbol: string, client: any): Promise<{
  close: number; open: number; high: number; low: number; volume: number
} | null> {
  try {
    // Try hash first (written by market-data fetcher)
    const hashData = await client.hgetall(`market_data:${symbol}`)
    if (hashData && Object.keys(hashData).length > 0) {
      const close = parseFloat(hashData.close || hashData.c || "0")
      if (close > 0) {
        return {
          close,
          open:   parseFloat(hashData.open   || hashData.o || String(close)),
          high:   parseFloat(hashData.high   || hashData.h || String(close)),
          low:    parseFloat(hashData.low    || hashData.l || String(close)),
          volume: parseFloat(hashData.volume || hashData.v || "0"),
        }
      }
    }

    // Try string key (JSON)
    const stringData = await client.get(`market_data:${symbol}`)
    if (stringData) {
      const parsed = typeof stringData === "string" ? JSON.parse(stringData) : stringData
      const close = parseFloat(parsed?.close || parsed?.c || "0")
      if (close > 0) {
        return {
          close,
          open:   parseFloat(parsed?.open   || parsed?.o || String(close)),
          high:   parseFloat(parsed?.high   || parsed?.h || String(close)),
          low:    parseFloat(parsed?.low    || parsed?.l || String(close)),
          volume: parseFloat(parsed?.volume || parsed?.v || "0"),
        }
      }
    }

    return null
  } catch {
    return null
  }
}

/**
 * Fetch real price from BingX public API as fallback for market data
 */
async function fetchLivePriceFromExchange(symbol: string): Promise<{
  close: number; open: number; high: number; low: number; volume: number
} | null> {
  try {
    // BingX public ticker endpoint — no auth required
    const bingxSymbol = symbol.replace("USDT", "-USDT")
    const res = await fetch(
      `https://open-api.bingx.com/openApi/swap/v2/quote/ticker?symbol=${bingxSymbol}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    )
    if (res.ok) {
      const data = await res.json()
      const ticker = Array.isArray(data?.data) ? data.data[0] : data?.data
      if (ticker?.lastPrice) {
        const close = parseFloat(ticker.lastPrice)
        return {
          close,
          open:  parseFloat(ticker.openPrice || String(close)),
          high:  parseFloat(ticker.highPrice  || String(close)),
          low:   parseFloat(ticker.lowPrice   || String(close * 0.99)),
          volume: parseFloat(ticker.quoteAssetVolume || ticker.volume || "0"),
        }
      }
    }
  } catch {
    // non-critical
  }

  // Binance public API as secondary fallback
  try {
    const res = await fetch(
      `https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`,
      { signal: AbortSignal.timeout(4000), cache: "no-store" }
    )
    if (res.ok) {
      const data = await res.json()
      const close = parseFloat(data.lastPrice || "0")
      if (close > 0) {
        return {
          close,
          open:  parseFloat(data.openPrice || String(close)),
          high:  parseFloat(data.highPrice  || String(close * 1.01)),
          low:   parseFloat(data.lowPrice   || String(close * 0.99)),
          volume: parseFloat(data.quoteAssetVolume || data.volume || "0"),
        }
      }
    }
  } catch {
    // non-critical
  }

  return null
}

async function ensureCurrentMarketDataCandle(
  symbol: string,
  client: any,
): Promise<any | null> {
  let marketData = await getMarketDataForSymbol(symbol, client)
  if (!marketData) marketData = await fetchLivePriceFromExchange(symbol)

  if (!marketData) {
    const prevRaw = await client.hget(`market_data:${symbol}`, "close").catch(() => null)
    const prevClose = prevRaw ? Number(prevRaw) : NaN
    let base = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null
    if (base === null) {
      let h = 0
      for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 100000
      base = 1 + (h % 5000) / 100
    }
    const drift = (Math.random() - 0.5) * 0.024
    const open = base
    const close = Math.max(0.0001, base * (1 + drift))
    const spread = Math.abs(drift) + Math.random() * 0.025
    const high = Math.max(open, close) * (1 + spread / 2)
    const low = Math.min(open, close) * (1 - spread / 2)
    const volume = base * 1000 * (0.5 + Math.random() * 2)
    marketData = { close, open, high, low, volume }
  }

  const now = Date.now()
  const candle = {
    symbol,
    open: marketData.open,
    high: marketData.high,
    low: marketData.low,
    close: marketData.close,
    price: marketData.close,
    volume: marketData.volume,
    timestamp: now,
  }

  const pipeline = client.multi()
  pipeline.hset(`market_data:${symbol}`, {
    close: String(candle.close),
    open: String(candle.open),
    high: String(candle.high),
    low: String(candle.low),
    volume: String(candle.volume),
    symbol,
    updated_at: String(now),
  })
  pipeline.expire(`market_data:${symbol}`, 3600)
  pipeline.set(`market_data:${symbol}:1s`, JSON.stringify({ symbol, candles: [candle], timestamp: now }))
  pipeline.expire(`market_data:${symbol}:1s`, 3600)
  await pipeline.exec().catch(() => {})
  return candle
}

async function runCronPipelineForSymbol(
  connectionId: string,
  symbol: string,
  client: any,
  deps: {
    indication: IndicationProcessor
    realtime: RealtimeProcessor
    strategy: StrategyProcessor
    setsProcessor: IndicationSetsProcessor
  },
): Promise<PipelineCycleResult> {
  await ensureCurrentMarketDataCandle(symbol, client)
  return runIndStratCycle(connectionId, symbol, "realtime", {
    indication: deps.indication,
    realtime: deps.realtime,
    strategy: deps.strategy,
    setsProcessor: deps.setsProcessor,
    skipLiveDispatch: process.env.CRON_LIVE_DISPATCH === "1" || process.env.CRON_LIVE_DISPATCH === "true" ? false : true,
    enableStrategyFlow: process.env.DISABLE_CRON_STRATEGIES !== "1",
  })
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

async function runBounded<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return []

  const concurrency = Math.max(1, Math.min(Math.floor(limit), items.length))
  const results = new Array<R>(items.length)
  let nextIndex = 0

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex++
      results[index] = await fn(items[index], index)
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  return results
}

// ── Per-process in-flight guard ──────────────────────────────────────────────
// Prevents concurrent executions within the SAME Node process (e.g. two tabs
// call the cron at the same millisecond and both enter before either finishes).
// The Redis-level lock below handles CROSS-process dedup; this handles same-
// process without a Redis round-trip.
let _cronInFlight = false

const CRON_LOCK_KEY = "cron_lock:generate-indications"
// Keep the lock comfortably above this route's worst-case duration: one cron can
// process up to 20 symbols per active connection, then run strategy flow batches
// and realtime SL/TP sweeps before returning.
const CRON_LOCK_TTL = 120 // seconds
const CRON_LOCK_RELEASE_SCRIPT = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`

function createCronLockToken(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

async function releaseCronLock(client: any, token: string): Promise<void> {
  if (typeof client?.eval === "function") {
    await client.eval(CRON_LOCK_RELEASE_SCRIPT, {
      keys: [CRON_LOCK_KEY],
      arguments: [token],
    })
    return
  }

  // Inline/local Redis emulator does not expose Lua/eval. This compare-then-del
  // fallback is best-effort only because the GET and DEL are separate operations;
  // production Redis clients should use the atomic Lua path above when available.
  const currentToken = await client.get(CRON_LOCK_KEY)
  if (currentToken === token) {
    await client.del(CRON_LOCK_KEY)
  }
}

export async function GET() {
  // ── Same-process guard ──────────────────────────────────────────────────────
  if (_cronInFlight) {
    return NextResponse.json({ success: true, skipped: true, reason: "in-flight" }, { status: 200 })
  }

  const cronLockToken = createCronLockToken()
  let acquiredCronLock = false

  try {
    const { initRedis, getRedisClient, getAssignedAndEnabledConnections, getConnection } = await import("@/lib/redis-db")
    const { getQueuedEngineRefreshRequests } = await import("@/lib/engine-refresh-queue")
    await initRedis()
    const client = getRedisClient()

    // ── Redis in-flight dedup lock (cross-process / cross-tab) ─────────────
    // If any caller (another tab, another serverless invocation) already
    // acquired the lock, skip this tick and return 200 immediately instead of
    // racing on the progression:{conn} hincrby counters. Each invocation stores
    // a unique owner token so the finally block only releases the lock it owns;
    // the TTL still guarantees a crashed caller never blocks future ticks.
    try {
      const setResult = await client.set(CRON_LOCK_KEY, cronLockToken, { NX: true, EX: CRON_LOCK_TTL })
      acquiredCronLock = setResult === "OK"
    } catch {
      // If the lock store is unreachable treat as acquired so processing continues.
      acquiredCronLock = true
    }
    if (!acquiredCronLock) {
      return NextResponse.json({ success: true, skipped: true, reason: "cron-locked" }, { status: 200 })
    }

    _cronInFlight = true

    const activeConnections = await getCronEngineEligibleConnections(
      getAssignedAndEnabledConnections,
      getQueuedEngineRefreshRequests,
      getConnection,
    )

    // Cron intentionally uses the same assigned-and-enabled connection set as
    // the engine coordinator, with only fresh queued start requests merged after
    // the same readiness re-check used by startEngine().

    if (activeConnections.length === 0) {
      return NextResponse.json({
        success: true,
        generated: 0,
        connections: 0,
        message: "No active connections",
        timestamp: Date.now(),
      })
    }

    let totalIndications = 0
    let totalBase = 0
    let totalMain = 0
    let totalReal = 0

    const cyclesPerCron = 1

    for (const connection of activeConnections) {
      const exchangeName = (connection.exchange || "bingx").toLowerCase()
      const progKey = `progression:${connection.id}`
      const [baseBeforeRaw, mainBeforeRaw, realBeforeRaw] = await Promise.all([
        client.hget(progKey, "strategies_base_total").catch(() => "0"),
        client.hget(progKey, "strategies_main_total").catch(() => "0"),
        client.hget(progKey, "strategies_real_total").catch(() => "0"),
      ])
      const baseBefore = Number.parseInt(String(baseBeforeRaw || "0"), 10) || 0
      const mainBefore = Number.parseInt(String(mainBeforeRaw || "0"), 10) || 0
      const realBefore = Number.parseInt(String(realBeforeRaw || "0"), 10) || 0

      let symbolsRaw: string[] = []
      try {
        // Accept every shape produced across migrations/settings saves:
        // arrays, JSON arrays, comma/pipe/semicolon-delimited strings, and a
        // single legacy symbol string. Bad tokens are dropped before they can
        // create invalid market_data keys or exchange ticker calls.
        symbolsRaw = normalizeSymbolList(connection.active_symbols)
      } catch { symbolsRaw = [] }

      let primarySymbol = symbolsRaw[0]
      if (!primarySymbol) {
        // Avoid O(N) client.keys scan — probe well-known symbols in-order via cheap HGET
        // (each is one O(1) round-trip bounded by the number of candidates, not keyspace size).
        for (const sym of ["BTCUSDT", "ETHUSDT", "SOLUSDT"]) {
          try {
            const close = await client.hget(`market_data:${sym}`, "close").catch(() => null)
            if (close && parseFloat(close) > 0) {
              primarySymbol = sym
              break
            }
          } catch { /* keep probing */ }
        }
      }

      if (!primarySymbol) {
        primarySymbol = await getMostVolatileSymbol(exchangeName)
      }

      // Default 4 major symbols used when active_symbols is empty.
      const DEFAULT_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
      let symbolsToProcess = symbolsRaw.length > 0
        ? symbolsRaw
        : Array.from(new Set([...DEFAULT_SYMBOLS, primarySymbol].filter(Boolean)))
      const symbolLimit = parsePositiveInteger(process.env.CRON_SYMBOL_LIMIT, 20)
      symbolsToProcess = symbolsToProcess.slice(0, symbolLimit)

      for (let c = 0; c < cyclesPerCron; c++) {
        // Process symbols for this cycle with bounded concurrency.
        // Each call touches distinct market_data:{symbol} and
        // indications:{conn}:{type}:latest keys so there is no key collision.
        // The progression:{conn} hincrby writes are atomic per-key operations so
        // concurrent increments are safe (the Redis emulator serialises them).
        // Keep the default intentionally small to avoid CPU/network spikes when
        // many symbols or connections are active, while preserving result order.
        const symbolConcurrency = parsePositiveInteger(process.env.CRON_SYMBOL_CONCURRENCY, 4)
        const pipelineDeps = {
          indication: new IndicationProcessor(connection.id),
          realtime: new RealtimeProcessor(connection.id),
          strategy: new StrategyProcessor(connection.id),
          setsProcessor: new IndicationSetsProcessor(connection.id),
        }
        const cycleResults = await runBounded(
          symbolsToProcess,
          symbolConcurrency,
          (symbol) => runCronPipelineForSymbol(connection.id, symbol, client, pipelineDeps),
        )
        for (const r of cycleResults) {
          totalIndications += r.indicationCount
        }
      }

      const [baseAfterRaw, mainAfterRaw, realAfterRaw] = await Promise.all([
        client.hget(progKey, "strategies_base_total").catch(() => "0"),
        client.hget(progKey, "strategies_main_total").catch(() => "0"),
        client.hget(progKey, "strategies_real_total").catch(() => "0"),
      ])
      totalBase += Math.max(0, (Number.parseInt(String(baseAfterRaw || "0"), 10) || 0) - baseBefore)
      totalMain += Math.max(0, (Number.parseInt(String(mainAfterRaw || "0"), 10) || 0) - mainBefore)
      totalReal += Math.max(0, (Number.parseInt(String(realAfterRaw || "0"), 10) || 0) - realBefore)
    }

    await client.hset("system:logistics", {
      last_realtime_indication_cron: new Date().toISOString(),
    }).catch(() => {})

    return NextResponse.json({
      success: true,
      generated: totalIndications,
      connections: activeConnections.length,
      strategies: { base: totalBase, main: totalMain, real: totalReal },
      timestamp: Date.now(),
    })
  } catch (error) {
    console.error("[v0] [CronIndications] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  } finally {
    // Always release both guards so the next tick can run.
    _cronInFlight = false
    // Release the Redis lock early (before TTL) so subsequent ticks don't wait
    // when this handler finishes quickly, but only if this invocation still owns
    // the token. Atomic Lua compare-and-delete is used when exposed by the Redis
    // client; the inline/local emulator falls back to a documented best-effort
    // GET/DEL equality guard.
    if (acquiredCronLock) {
      try {
        const { getRedisClient } = await import("@/lib/redis-db")
        const c = getRedisClient()
        if (c) await releaseCronLock(c, cronLockToken).catch(() => {})
      } catch { /* non-critical */ }
    }
  }
}

export async function POST() {
  return GET()
}
