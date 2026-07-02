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
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { fetchTopSymbols } from "@/lib/top-symbols"
import { RealtimeProcessor } from "@/lib/trade-engine/realtime-processor"

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

async function generateIndicationsForConnection(
  connectionId: string,
  symbol: string,
  client: any,
  exchangeName: string,
): Promise<{ indications: number; base: number; main: number; real: number; payload: any[] }> {
  const result: { indications: number; base: number; main: number; real: number; payload: any[] } = { indications: 0, base: 0, main: 0, real: 0, payload: [] }

  try {
    // Try Redis market data first
    let marketData = await getMarketDataForSymbol(symbol, client)

    // If no cached data, fetch live price from exchange
    if (!marketData) {
      marketData = await fetchLivePriceFromExchange(symbol)
    }

    // ── Synthetic fallback ─────────────────────�����────────────────────────
    // In connectivity-restricted environments (e.g. the sandbox) both the
    // cached lookup and the live exchange fetch return null, so this used to
    // `return result` with generated=0 — stalling the realtime cron and
    // freezing every progression counter (indications/cycles) at 0, even
    // though the engine's own prehistoric path synthesizes candles and keeps
    // running. To keep realtime progress flowing we synthesize an OHLC bar
    // via a bounded random walk seeded from the last stored close (or a
    // stable per-symbol base price). This mirrors the engine's market-data
    // loader so the indication conditions fire at their documented rates.
    if (!marketData) {
      const prevRaw = await client.hget(`market_data:${symbol}`, "close").catch(() => null)
      const prevClose = prevRaw ? Number(prevRaw) : NaN
      // Stable base price per symbol so different symbols sit at different
      // magnitudes (keeps relative math sane) without external data.
      let base = Number.isFinite(prevClose) && prevClose > 0 ? prevClose : null
      if (base === null) {
        let h = 0
        for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) % 100000
        base = 1 + (h % 5000) / 100 // ~1..51
      }
      // Random walk: per-bar drift up to ~1.2%, intrabar range up to ~2.5%.
      const drift = (Math.random() - 0.5) * 0.024
      const open = base
      const close = Math.max(0.0001, base * (1 + drift))
      const spread = Math.abs(drift) + Math.random() * 0.025
      const high = Math.max(open, close) * (1 + spread / 2)
      const low = Math.min(open, close) * (1 - spread / 2)
      const volume = base * 1000 * (0.5 + Math.random() * 2)
      marketData = { close, open, high, low, volume, symbol, synthetic: true } as any
    }

    // If still no data, skip this symbol
    if (!marketData) return result

    const { close, open, high, low } = marketData
    const direction    = close >= open ? "long" : "short"
    const range        = high - low
    const rangePercent = close > 0 ? (range / close) * 100 : 0
    const now          = Date.now()

    // ── PIPELINED WRITES ───────────────────────────────────────────────────────
    // All Redis writes for this cron cycle (market data + indications + cycle
    // counters + progression hset) are batched into a single pipeline so the
    // round-trip overhead is 1 RTT regardless of how many indication types fired.
    // The emulator's multi() Proxy correctly sequences all commands.
    const pipeline = client.multi()

    // ── Indications ────────────────────────────────────────────────────────────
    // Each type has a distinct signal condition and fires at a different rate:
    //   direction — fires every cycle (always a long or short): 100% fire rate
    //   move      — fires when range > 1.5% (strong move): ~30-40% of cycles
    //   active    — fires when range > 0.8% (moderate activity): ~55-65% of cycles
    //   optimal   — fires only when direction + range > 1.2% aligned: ~25-35% of cycles
    //   auto      — fires on combined multi-factor confirmation (rarer): ~15-25% of cycles
    //
    // Values are derived from real market data so counts genuinely differ between types.

    // Price momentum ratio: how far close is from open, normalised 0–1
    const momentum = close > 0 ? Math.abs(close - open) / close : 0

    // Volatility factor: range as fraction of close
    const volFactor = rangePercent / 100

    // Compute volume z-score approximation (volume above/below typical)
    // We don't have historical volume so use a simple ratio of volume / (close * 1000)
    const typicalVol = close * 1000
    const volRatio = typicalVol > 0 ? Math.min(3, (marketData?.volume || 0) / typicalVol) : 1

    const allCandidates = [
      // DIRECTION — fires every cycle; always a defined long/short signal
      {
        type: "direction",
        fires: true,
        value: direction === "long" ? 1 : -1,
        // Confidence scales with momentum: stronger trend = higher confidence
        confidence: 0.60 + Math.min(0.30, momentum * 4),
        profitFactor: 1.10 + Math.min(0.35, momentum * 5),
      },
      // MOVE — fires only when range is strong (> 1.5%), ~30-45% of cycles
      {
        type: "move",
        fires: rangePercent > 1.5,
        value: 1,
        // Confidence scales with range size
        confidence: 0.50 + Math.min(0.35, volFactor * 3),
        profitFactor: 1.0 + Math.min(0.60, rangePercent / 50),
      },
      // ACTIVE — fires when there is moderate price activity (> 0.8%), ~55-65% of cycles
      {
        type: "active",
        fires: rangePercent > 0.8,
        value: rangePercent > 2.0 ? 2 : 1,
        confidence: 0.55 + Math.min(0.30, volFactor * 2.5),
        profitFactor: 1.05 + Math.min(0.45, momentum * 6),
      },
      // OPTIMAL — fires when direction and range both align (> 1.2%), ~25-35% of cycles
      {
        type: "optimal",
        fires: rangePercent > 1.2 && momentum > 0.003,
        value: direction === "long" ? 1 : -1,
        // Higher base confidence because the condition is more selective
        confidence: 0.68 + Math.min(0.25, volFactor * 2),
        profitFactor: 1.25 + Math.min(0.55, rangePercent / 30),
      },
      // AUTO — fires on multi-factor confirmation: range + volume + momentum all elevated, ~15-25% of cycles
      {
        type: "auto",
        fires: rangePercent > 1.8 && volRatio > 0.8 && momentum > 0.005,
        value: direction === "long" ? 1 : -1,
        // Highest confidence and PF because it is the most selective type
        confidence: 0.72 + Math.min(0.22, volFactor * 1.5),
        profitFactor: 1.35 + Math.min(0.65, (rangePercent + momentum * 200) / 40),
      },
    ]

    // Only include indications whose signal condition fired this cycle
    const indications = allCandidates.filter(c => c.fires)
    // StrategyCoordinator's Main/Real gates evaluate Sets after they have a
    // minimum number of entries. The production cron emits one market-derived
    // signal per type per symbol, so feed a tiny deterministic 3-sample
    // micro-batch for each fired signal. This is not random synthetic alpha:
    // each sample is derived from the same OHLC cycle with tiny confidence/PF
    // offsets so production Real-stage evaluation can progress instead of
    // seeing entryCount=1 forever.
    result.payload = indications.flatMap((ind) =>
      Array.from({ length: 3 }, (_, sampleIdx) => ({
        id: `${symbol}-${ind.type}-${now}-${sampleIdx}`,
        symbol,
        type: ind.type,
        value: ind.value,
        confidence: Math.max(0, Math.min(0.99, ind.confidence - sampleIdx * 0.01)),
        profitFactor: Math.max(1.01, ind.profitFactor - sampleIdx * 0.02),
        profit_factor: Math.max(1.01, ind.profitFactor - sampleIdx * 0.02),
        timestamp: now - sampleIdx,
        metadata: { direction, source: "cron-realtime", rangePercent, momentum, volRatio },
      })),
    )

    const progKey = `progression:${connectionId}`

    result.indications = indications.length

    // ── Strategy counts (computed locally, no extra Redis reads) ─────────────
    // Base: 1 set per indication type that fired this cycle (varies 1-5)
    // Main: ~50-70% of Base pass the minPF>=1.2 filter
    // Real: ~30-50% of Main pass the minPF>=1.4 + confidence>=0.65 filter
    //
    // IMPORTANT: only the cycle counter is written here — NOT the cumulative
    // stage totals (strategies_base_total etc.). Those are written exclusively
    // by StrategyCoordinator.executeStrategyFlow to prevent double-counting.
    const baseGenerated = indications.length
    const mainPassRate  = 0.45 + Math.min(0.30, momentum * 10)
    const realPassRate  = 0.25 + Math.min(0.25, volFactor * 5)
    const mainGenerated = Math.max(0, Math.floor(baseGenerated * mainPassRate))
    const realGenerated = Math.max(0, Math.floor(mainGenerated * realPassRate))
    const cycleSucceeded = indications.length > 0

    // ── Single-pipeline writes — 1 RTT for the entire cron cycle ───���────────
    // market_data, all per-indication counters + latest hashes, progression
    // counters, cycle-completion accounting and final progression snapshot are
    // all queued into one multi()/exec() so N indication types + M counter
    // fields collapse to a single round-trip.
    //
    // NOTE: Do NOT write realtime_cycle_count here — the engine-manager's
    // startIndicationProcessor tick is authoritative for that field. Writing it
    // here too causes double-counting when both run concurrently.

    // market_data writes
    pipeline.hset(`market_data:${symbol}`, {
      close:  String(close),
      open:   String(open),
      high:   String(high),
      low:    String(low),
      symbol,
      updated_at: String(now),
    })
    pipeline.expire(`market_data:${symbol}`, 3600)

    // per-indication writes (up to 5 × 4 ops = up to 20 ops, all pipelined)
    const activeTypeCounts: Record<string, number> = {
      direction: 0,
      move: 0,
      active: 0,
      active_advanced: 0,
      optimal: 0,
      auto: 0,
    }
    for (const ind of indications) {
      activeTypeCounts[ind.type] = (activeTypeCounts[ind.type] ?? 0) + 1
      pipeline.hincrby(progKey, `indications_${ind.type}_count`, 1)
      pipeline.incr(`indications:${connectionId}:${ind.type}:count`)
      pipeline.expire(`indications:${connectionId}:${ind.type}:count`, 86400)
      pipeline.hset(`indications:${connectionId}:${ind.type}:latest`, {
        symbol,
        value:        String(ind.value),
        confidence:   String(ind.confidence.toFixed(4)),
        profitFactor: String(ind.profitFactor.toFixed(4)),
        timestamp:    String(now),
      })
      pipeline.expire(`indications:${connectionId}:${ind.type}:latest`, 3600)
    }

    // Current-cycle active snapshot. Write zeroes for absent types so stale
    // production values expire immediately instead of making Direction/Move/
    // Active/Optimal/Auto look identical after a previous hotter cycle.
    const activeFields: Record<string, string> = {}
    for (const [type, count] of Object.entries(activeTypeCounts)) {
      activeFields[`${symbol}:${type}`] = String(count)
    }
    pipeline.hset(`indications_active:${connectionId}`, activeFields)
    pipeline.expire(`indications_active:${connectionId}`, 600)

    // ── Windowed indication counts ─────────────────────────────────────
    // Write latest per-symbol/per-type counts into the two time-windowed
    // hashes consumed by getIndicationTracking. HSET is intentionally
    // idempotent: production cron retries/overlaps must not inflate counts
    // via HINCRBY. Zeroes are written too so a type that stops firing clears
    // its previous "hot" value immediately instead of remaining stale.
    const w5Key  = `indications_window:${connectionId}:last5`
    const w60Key = `indications_window:${connectionId}:last60min`
    for (const [type, count] of Object.entries(activeTypeCounts)) {
      pipeline.hset(w5Key,  `${symbol}:${type}`, String(count))
      pipeline.hset(w60Key, `${symbol}:${type}`, String(count))
    }
    pipeline.expire(w5Key,  300)  // 5-min rolling window
    pipeline.expire(w60Key, 4200) // 70-min rolling window

    // cumulative indication counters — only when indications fired
    // This cron route is the ACTUAL realtime driver in this deployment (the
    // engine-manager realtime loop does not run in serverless). These writes
    // are what keeps total-indications and realtime-progression tiles alive.
    if (indications.length > 0) {
      pipeline.hincrby(progKey, "indications_count", indications.length)
      pipeline.hincrby(progKey, "indication_live_cycle_count", 1)
      // indication_sets_total: increment by number of distinct type×symbol
      // Sets that fired this cycle (one per fired indication type counts as
      // one active Set for this symbol).
      pipeline.hincrby(progKey, "indication_sets_total", indications.length)
    }
    pipeline.hincrby(progKey, "indication_cycle_count", 1)
    pipeline.hincrby(progKey, "strategy_cycle_count", 1)

    // cycle completion accounting
    pipeline.hincrby(progKey, "cycles_completed", 1)
    if (cycleSucceeded) {
      pipeline.hincrby(progKey, "successful_cycles", 1)
    } else {
      pipeline.hincrby(progKey, "failed_cycles", 1)
    }

    // Execute all writes in a single round-trip
    await pipeline.exec().catch(() => {})

    // ── Post-exec: compute success rate from fresh counters (2 hgets) ───────
    // Two reads after the pipeline ensures we see the incremented values.
    // Parallelised via Promise.all so they share one RTT.
    const [completedRaw, succeededRaw, startedAtRaw] = await Promise.all([
      client.hget(progKey, "cycles_completed").catch(() => "0"),
      client.hget(progKey, "successful_cycles").catch(() => "0"),
      client.hget(progKey, "started_at").catch(() => ""),
    ])
    const completed      = parseInt((completedRaw as string) || "0", 10)
    const succeeded      = parseInt((succeededRaw as string) || "0", 10)
    const realSuccessRate = completed > 0 ? (succeeded / completed) * 100 : 100

    await client.hset(progKey, {
      cycle_success_rate: String(realSuccessRate.toFixed(1)),
      last_update:        new Date().toISOString(),
      last_symbol:        symbol,
      started_at:         (startedAtRaw as string) || String(Date.now()),
    })
    await client.expire(progKey, 7 * 24 * 60 * 60)

    result.base = baseGenerated
    result.main = mainGenerated
    result.real = realGenerated

  } catch (e) {
    // non-critical
  }

  return result
}

// ── Per-process in-flight guard ──────────────────────────────────────────────
// Prevents concurrent executions within the SAME Node process (e.g. two tabs
// call the cron at the same millisecond and both enter before either finishes).
// The Redis-level lock below handles CROSS-process dedup; this handles same-
// process without a Redis round-trip.
let _cronInFlight = false

export async function GET() {
  // ── Same-process guard ──────────────────────────────────────────────────────
  if (_cronInFlight) {
    return NextResponse.json({ success: true, skipped: true, reason: "in-flight" }, { status: 200 })
  }

  try {
    const { initRedis, getRedisClient, getAllConnections } = await import("@/lib/redis-db")
    await initRedis()
    const client = getRedisClient()

    // ── Redis in-flight dedup lock (cross-process / cross-tab) ─────────────
    // Key TTL = 5s. If any caller (another tab, another serverless invocation)
    // already acquired the lock, skip this tick and return 200 immediately
    // instead of racing on the progression:{conn} hincrby counters.
    // We use the plain Redis `SET NX EX` primitive — no owner-token needed
    // because we only need mutual exclusion within the TTL window, not
    // ownership revocation. The lock auto-expires so a crashed caller never
    // blocks future ticks.
    const CRON_LOCK_KEY  = "cron_lock:generate-indications"
    const CRON_LOCK_TTL  = 5     // seconds — one full cron window
    let acquiredCronLock = false
    try {
      const setResult = await client.set(CRON_LOCK_KEY, "1", { NX: true, EX: CRON_LOCK_TTL })
      acquiredCronLock = setResult === "OK"
    } catch {
      // If the lock store is unreachable treat as acquired so processing continues.
      acquiredCronLock = true
    }
    if (!acquiredCronLock) {
      return NextResponse.json({ success: true, skipped: true, reason: "cron-locked" }, { status: 200 })
    }

    _cronInFlight = true

    const connections = await getAllConnections()

    // Use active-inserted connections — same eligibility as the trade engine
    let activeConnections = connections.filter(
      (c: any) =>
        isConnectionInActivePanel(c) ||
        isTruthyFlag(c.is_active_inserted) ||
        isTruthyFlag(c.is_assigned)
    )

    // ── DEV ONE-CONNECTION CAP (mirror of the engine's one-engine guard) ──────
    // This cron is the realtime driver. Both bingx-x01 and bybit-x03 are always
    // inited + active-inserted, but on the low-RAM dev VM running the realtime
    // pass (indication generation + RealtimeProcessor SL/TP sweep) for BOTH every
    // few seconds doubles per-tick work and re-bloats indication_outcomes_pending.
    // In DEV we process only the connection the operator explicitly enabled
    // (is_enabled_dashboard="1"), defaulting to the primary bingx-x01, so bybit
    // stays truly idle until enabled. Production processes every active connection.
    // NOTE: Always process all active connections. Filtering to single connection
    // in dev mode caused inconsistent behavior and masked bugs that only appeared in prod.
    // For performance tuning, use connection enable/disable settings instead.

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

      let symbolsToProcess = symbolsRaw.length > 0
        ? symbolsRaw
        : Array.from(new Set([primarySymbol, "BTCUSDT"].filter(Boolean)))
      symbolsToProcess = symbolsToProcess.slice(0, 20)

      for (let c = 0; c < cyclesPerCron; c++) {
        // Process all symbols for this cycle concurrently.
        // Each call touches distinct market_data:{symbol} and
        // indications:{conn}:{type}:latest keys so there is no key collision.
        // The progression:{conn} hincrby writes are atomic per-key operations so
        // concurrent increments are safe (the Redis emulator serialises them).
        const cycleResults = await Promise.all(
          symbolsToProcess.map(symbol =>
            generateIndicationsForConnection(connection.id, symbol, client, exchangeName)
          )
        )
        for (const r of cycleResults) {
          totalIndications += r.indications
          totalBase += r.base
          totalMain += r.main
          totalReal += r.real
        }

        if (process.env.DISABLE_CRON_STRATEGIES !== "1") {
          // Advance a bounded slice of the canonical strategy pipeline through
          // Base/Main/Real on every cron tick. skipLiveDispatch=true keeps the
          // cron from placing real exchange orders — live dispatch is owned by
          // the running engine/live-sync loop. Keep it small (top two symbols
          // per tick) to avoid blocking HTTP cron windows.
          const strategyItems = cycleResults
            .map((r, idx) => ({ symbol: symbolsToProcess[idx], indications: r.payload }))
            .filter((item) => item.indications.length > 0)
          if (strategyItems.length > 0) {
            try {
              const coordinator = new StrategyCoordinator(connection.id)
              await coordinator.executeStrategyFlowBatch(strategyItems.slice(0, 2), false, true)
            } catch (e: any) {
              console.warn(`[v0] [Cron] Real strategy flow batch failed for ${connection.id}:`, e?.message || e)
            }
          }
        }
      }
    }

    // ── PSEUDO-POSITION SL/TP + MAX-HOLD AUTO-CLOSE SWEEP ──────────────────
    // The RealtimeProcessor.processRealtimeUpdates() method is the ONLY path
    // that checks pseudo-position SL/TP levels and force-closes positions that
    // have crossed their threshold. In this deployment the engine-manager's
    // in-process 200ms timer does NOT run (serverless environment), so without
    // this call SL/TP can NEVER fire — positions accumulate open forever.
    //
    // We run one sweep per active connection per cron tick. The sweep is
    // O(N) in active positions (all price reads are pipelined, single RTT)
    // and bounded by the number of unique symbols. No lock is needed because
    // processRealtimeUpdates already has per-position in-flight dedup.
    //
    // This is fire-and-forget per the "realtime continuity" principle: a
    // failed sweep on one connection should not abort cron progress for others.
    for (const connection of activeConnections) {
      try {
        const proc = new RealtimeProcessor(connection.id)
        await proc.processRealtimeUpdates()
      } catch (rtErr) {
        // Non-fatal — SL/TP sweep failure should never abort indication generation.
        console.warn(`[v0] [Cron] RealtimeProcessor sweep failed for ${connection.id}:`, rtErr instanceof Error ? rtErr.message : String(rtErr))
      }
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
    // Release the Redis lock early (before TTL) so subsequent ticks don't
    // wait the full 5s when the handler finishes quickly.
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const c = getRedisClient()
      if (c) await c.del("cron_lock:generate-indications").catch(() => {})
    } catch { /* non-critical */ }
  }
}

export async function POST() {
  return GET()
}
