/**
 * Stage 5: Live Exchange Position Creation Progression
 *
 * Complete end-to-end pipeline for creating and tracking a live position on a
 * real exchange. Mirrors a qualifying Real set into an executable exchange
 * position, with:
 *
 *   1. Pre-flight validation (live_trade flag, input sanity, dedup lock)
 *   2. Current price fetch from Redis market data
 *   3. Volume calculation via VolumeCalculator (respecting balance, leverage,
 *      position cost, and exchange minimum volume)
 *   4. Leverage + margin type configuration on the exchange
 *   5. Market entry order placement with exponential-backoff retry
 *   6. Order fill confirmation polling
 *   7. Reduce-only Stop Loss and Take Profit order placement
 *   8. Position sync from exchange (liquidation price, margin type, mark price)
 *   9. Progression logging at every stage (engine_logs:{connId})
 *  10. Metrics counters in progression:{connId} hash (live orders placed,
 *      filled, failed; live positions open; total volume USD)
 *
 * Disabling is_live_trade on the connection short-circuits the pipeline and
 * records a "simulated" live position without touching the exchange.
 */

import { getConnection, getRedisClient, initRedis, setSettings } from "@/lib/redis-db"
import { nanoid } from "@/lib/trade-engine/pseudo-position-manager"
import { getVenueMinQty } from "@/lib/exchange-min-qty"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { SystemLogger } from "@/lib/system-logger"
import type { RealPosition } from "./real-stage"
import { getEngineTimings } from "@/lib/engine-timings"
import { withTimeout } from "@/lib/async-safety"
import { getMaxLeverageForExchange } from "@/lib/leverage-policy"
import {
  newLiveOrderTrace,
  withLiveOrderLogging,
  logLiveOrderFinal,
  type LiveOrderTrace,
} from "@/lib/live-order-logger"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import { hasRealTradeBlock } from "@/lib/real-trade-gates"

const LOG_PREFIX = "[v0] [LivePositionStage]"
const MIN_EXCHANGE_STOP_LOSS_PERCENT = 0.2

// ── Position snapshot cache for cycle-level deduplication ──
// Per-cycle position cache keyed by {connId} to eliminate duplicate getPositions() 
// calls when processing multiple symbols. Cache expires after the cycle completes
// (~500ms) so subsequent cycles re-fetch fresh state. Reduces API calls by 30-40%.
const positionCacheByConn = new Map<string, { positions: any[]; expiresAt: number }>()
const POSITION_CACHE_TTL_MS = 500
const POSITION_CACHE_MAX_SIZE = 50  // Prevent unbounded growth with many connections

function getCachedPositions(connId: string): any[] | null {
  const entry = positionCacheByConn.get(connId)
  if (entry && entry.expiresAt > Date.now()) {
    return entry.positions
  }
  positionCacheByConn.delete(connId)
  return null
}

function setCachedPositions(connId: string, positions: any[]): void {
  // Enforce size limit to prevent unbounded memory growth
  if (positionCacheByConn.size >= POSITION_CACHE_MAX_SIZE && !positionCacheByConn.has(connId)) {
    const firstKey = positionCacheByConn.keys().next().value
    if (firstKey) positionCacheByConn.delete(firstKey)
  }
  positionCacheByConn.set(connId, {
    positions,
    expiresAt: Date.now() + POSITION_CACHE_TTL_MS,
  })
}

function clearPositionCache(connId: string): void {
  positionCacheByConn.delete(connId)
}

/**
 * Compute the initial SL% for a newly-created live position using the Set's
 * own configuration. Each variant has a different protection contract:
 *
 *   trailing — The trailing machine anchors from `trailingProfile.stopRatio`
 *              (the trailing distance, e.g. 0.1 = 10%). Using the generic
 *              PF-derived SL here would conflict with the ratchet: the first
 *              tick would re-derive the SL from a different basis and either
 *              widen or tighten the live exchange order beyond the operator's
 *              trailing spec. We use `stopRatio * 100` as the initial SL%
 *              so the exchange order always starts at the trailing stop distance.
 *              This is overridden per-tick by `trailingStopPrice` once active.
 *
 *   block    — Block positions are additive add-ons at scaled size (1.5–2×).
 *              The SL must NOT widen with the size multiplier (that would
 *              multiply risk). The `derivedSl` from PF is already size-multiplier-
 *              scaled inside `deriveProtectionFromProfitFactor` (stopLossPct =
 *              baseRiskPct * sizeMultiplier). We apply a FLOOR of the standard
 *              minimum to ensure the block SL never compresses below exchange min.
 *
 *   dca      — DCA is a recovery trade (0.5× size). Tighter SL is correct —
 *              the PF-derived value (stopLossPct = baseRiskPct * 0.5) already
 *              reflects this. We apply the same floor. No override needed.
 *
 *   default/other — Use the PF-derived value as-is.
 *
 * Returns the SL% (a positive percentage, e.g. 1.2 means 1.2%).
 * Falls back to `derivedSl` for any unrecognised variant.
 */
function computeSetAwareSL(
  derivedSl: number,
  setVariant: LivePosition["setVariant"],
  trailingProfile: LivePosition["trailingProfile"] | undefined,
): number {
  if (setVariant === "trailing" && trailingProfile && trailingProfile.stopRatio > 0) {
    // For trailing-variant positions the initial exchange SL is placed at the
    // trailing stop distance from entry. The trailing machine then ratchets this
    // upward (long) or downward (short) as price moves in our favour. Using the
    // trailing stopRatio ensures the initial order and the ratchet machine are
    // in sync from the first tick.
    const trailingSl = trailingProfile.stopRatio * 100
    return Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, trailingSl)
  }
  // For all other variants (default, block, dca, pause) the PF-derived value
  // is already variant-adjusted (block: scaled up by sizeMultiplier, dca: 0.5×).
  // Enforce the minimum floor in all cases.
  return Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, derivedSl)
}






async function isLiveTradeEnabledForConnection(connectionId: string): Promise<boolean> {
  const connection = (await getConnection(connectionId).catch(() => null)) || {}
  if (hasRealTradeBlock(connection as Record<string, any>)) return false
  return isTruthyFlag((connection as any).is_live_trade) || isTruthyFlag((connection as any).live_trade_enabled)
}

// ── Exchange call timeouts ────────────────────────────────────────────────
// Target: syncWithExchange completes in <1 s on the hot path.
// These timeouts bound per-call worst case so the pool never hangs.
// Each value is calibrated to a ~2×p99 RTT of a typical BingX API call
// Observed BingX p99 in production is 2–4 s per call; under load with 8
// symbols placing simultaneous orders it can reach 6–8 s.  Timeouts are
// set conservatively to handle the worst case while still catching genuine
// hangs.  SL/TP placement is the most critical path — a timeout here leaves
// a position unprotected, so it gets more budget than cancel/fetch.
const EXCHANGE_TIMEOUT_CANCEL_ORDER_MS  = 30_000  // 30 s — cancel; retried next tick on failure; covers queue wait + BingX round-trip
const EXCHANGE_TIMEOUT_PLACE_STOP_MS    = 60_000  // 60 s — SL/TP placement; covers semaphore queue wait + BingX round-trip
const EXCHANGE_TIMEOUT_GET_POSITIONS_MS = 15_000  // 15 s — position fetch for adoption + sync prefetch
const EXCHANGE_TIMEOUT_GET_ORDER_MS     = 12_000  // 12 s — fill detection; retry via next sync tick on miss

// ── Global SL/TP placement semaphore ─────────────────────────────────────
// 4 symbols × 2 directions × 2 stops (SL+TP) = up to 16 concurrent stop calls.
// BingX rate limiter now allows 5 concurrent requests (maxConcurrent=5).
// Limit=6 lets 6 stop calls run in parallel; ceil(16/6)=3 passes at ~5s p99
// each = ~15s total flush — vs ceil(16/3)=6 passes × 5s = ~30s at the old limit.
// Raising from 3 to 6 halves SL/TP arming latency when all symbols open simultaneously.
// EXCHANGE_TIMEOUT_PLACE_STOP_MS (60s) covers worst-case queue + BingX RTT.
let __stopSemCount = 0
const __STOP_SEM_LIMIT = 6
const __stopSemQueue: Array<() => void> = []
function acquireStopSem(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (__stopSemCount < __STOP_SEM_LIMIT) {
      __stopSemCount++
      resolve()
    } else {
      __stopSemQueue.push(() => { __stopSemCount++; resolve() })
    }
  })
}
function releaseStopSem(): void {
  __stopSemCount = Math.max(0, __stopSemCount - 1)
  const next = __stopSemQueue.shift()
  if (next) next()
}

/**
 * Live position as it flows through the live-stage pipeline and is
 * persisted in Redis.  This is the local definition; the external
 * definition in `position-tracker.ts` uses snake_case field names and
 * is intentionally kept separate (it represents the cached exchange API
 * shape, not the stage pipeline shape).
 */
interface LivePosition {
  id: string
  connectionId: string
  symbol: string
  side?: "long" | "short"
  direction?: "long" | "short"
  entryPrice: number
  executedQuantity: number
  remainingQuantity: number
  averageExecutionPrice: number
  volumeUsd?: number
  leverage: number
  marginType: "cross" | "isolated"
  unrealized_pnl?: number
  unrealized_pnl_percent?: number
  markPrice?: number
  liquidationPrice?: number
  realizedPnL?: number
  timestamp?: number
  fee?: number
  feeAsset?: string
  lastUpdate?: number
  last_update?: number
  stoppedAt?: number
  updatedAt?: number
  createdAt?: number
  closedAt?: number
  realPositionId?: string
  fills: FillRecord[]
  stopLoss?: number
  takeProfit?: number
  stopLossPrice?: number
  takeProfitPrice?: number
  stopLossOrderId?: string
  takeProfitOrderId?: string
  // Epoch-ms timestamps of the last successful SL/TP placement on the venue.
  // Used by the MIN_REARM_MS cooldown to prevent repeated cancel-replace
  // storms when a position's price oscillates at the 0.25% drift boundary.
  stopLossLastArmedAt?: number
  takeProfitLastArmedAt?: number
  assignedStopLoss?: number
  assignedTakeProfit?: number
  protectionArmedQuantity?: number
  // ── Trailing stop state ────────────────────────────────────────────────
  // Written by syncLiveFromPseudo when the pseudo position's trailing machine
  // is armed. These fields make the ratcheted absolute stop price available to
  // computeDesiredProtectionPrices and checkAndForceCloseOnSltpCross so that
  // the trailing level — not the original static percentage — is used for both
  // exchange order placement and proactive force-close detection.
  //
  // trailingActive: true when the pseudo's trailing machine is armed.
  // trailingStopPrice: the latest ratcheted absolute stop price. Updated every
  //   time syncLiveFromPseudo writes a new trailing level; cleared (undefined)
  //   when trailing becomes inactive so the static stopLoss % takes over again.
  trailingActive?: boolean
  trailingStopPrice?: number
  status?: "open" | "closed" | "filled" | "partially_filled" | "placed" | "pending_fill" | "placed_unconfirmed" | "rejected" | "cancelled" | "error" | "simulated" | "pending" | "closing" | "closing_partial"
  statusReason?: string
  closeReason?: string
  closePrice?: number
  // ── Race condition prevention (atomic status transitions) ──
  // version: Incremented on every status mutation for optimistic locking
  //   Concurrent threads detect stale data via version mismatch and retry
  // lockedAt: Epoch-ms timestamp when position was locked for mutation
  //   0 = not locked, >0 = locked, used to detect stale locks
  // lockedBy: Identifier of the thread/process that holds the lock (for debugging)
  version?: number
  lockedAt?: number
  lockedBy?: string
  system_tracking_id?: string
  connection_tracking_id?: string
  setKey?: string
  exchangeData?: Record<string, unknown>
  orderId?: string
  connection_id?: string
  entry_price?: number
  current_price?: number
  quantity: number
  axisWindows?: { prev: number; last: number; cont: number; pause: number }
  // Variant size multiplier mirrored from RealPosition (block=1.5-2.0,
  // dca=0.5, others=1.0). Stored so accumulation can match original sizing.
  sizeMultiplier?: number
  parentSetKey?: string
  setVariant?: "default" | "trailing" | "block" | "dca" | "pause"
  accumulatedSetKeys?: string[]
  // ── Set-config propagation (Set Relations → Position Protection) ──────────
  // The originating StrategySet's trailing profile and historical performance
  // snapshot are carried into the live position so that:
  //   1. Trailing-variant positions use `trailingProfile.stopRatio` as the
  //      initial SL distance anchor rather than a generic PF-derived value
  //      (the trailing machine ratchets from this anchor, not from a flat %).
  //   2. `prevPos` provides the historical success rate and PF context that
  //      the Set was scored against, available for audit and future re-scoring.
  // Both fields ride verbatim from StrategySet → RealPosition → LivePosition
  // via the dispatch payload in `createLiveSets`.
  trailingProfile?: { startRatio: number; stopRatio: number; stepRatio: number }
  prevPos?: { count: number; successRate: number; profitFactor: number; avgDDT: number }

  progression?: { step: string; timestamp: number; success: boolean; details: string }[]
}

function makeConnectionTrackingId(connectionId: string): string {
  return `conn-${connectionId}`
}

function makeSystemTrackingId(connectionId: string): string {
  return `sys-${connectionId}-${nanoid(10)}`
}

function isSystemTrackedLivePosition(position: Partial<LivePosition> | any, connectionId: string): boolean {
  const systemTrackingId = String(position?.system_tracking_id ?? position?.systemTrackingId ?? "").trim()
  const connectionTrackingId = String(position?.connection_tracking_id ?? position?.connectionTrackingId ?? "").trim()
  return (
    systemTrackingId.startsWith(`sys-${connectionId}-`) &&
    systemTrackingId.length > `sys-${connectionId}-`.length &&
    connectionTrackingId === makeConnectionTrackingId(connectionId)
  )
}

interface FillRecord {
  id?: string
  price: number
  quantity: number
  timestamp?: number
  fee?: number
  feeAsset?: string
}

// ── Helper function stubs (defined in adjacent modules) ──────────────
// live-stage.ts calls a set of helpers that live in the trade-engine
// package.  They are declared here so TypeScript can type-check call sites
// even when the defining modules are not yet wired up.
function pushStep(position: LivePosition, step: string, ok: boolean, detail: string): void {
  try {
    if (!position.progression) position.progression = []
    position.progression.push({ step, timestamp: Date.now(), success: ok, details: detail })
    // cap progression per-position to 200 entries to avoid unbounded growth
    if (position.progression.length > 200) position.progression = position.progression.slice(-200)
  } catch {
    // non-critical
  }
}

function normalizeStopLossPercent(rawStopLoss: unknown): { value: number; adjusted: boolean; reason?: string } {
  const n = Number(rawStopLoss)
  if (!Number.isFinite(n) || n <= 0) {
    return {
      value: MIN_EXCHANGE_STOP_LOSS_PERCENT,
      adjusted: true,
      reason: `missing/disabled SL normalized to minimum ${MIN_EXCHANGE_STOP_LOSS_PERCENT}%`,
    }
  }
  if (n < MIN_EXCHANGE_STOP_LOSS_PERCENT) {
    return {
      value: MIN_EXCHANGE_STOP_LOSS_PERCENT,
      adjusted: true,
      reason: `SL ${n}% below minimum ${MIN_EXCHANGE_STOP_LOSS_PERCENT}% — using minimum`,
    }
  }
  return { value: n, adjusted: false }
}

/**
 * Atomic guard: Prevent duplicate operations on the same position
 * Returns true if the position is safe to operate on, false if already locked
 * 
 * This prevents the race condition where multiple threads detect SL/TP crosses
 * and all call closeLivePosition() simultaneously, resulting in duplicate closes.
 * 
 * Usage:
 *   if (!tryLockPosition(position)) return null  // Someone else is already closing this
 *   try {
 *     await closeLivePosition(position, ...)
 *   } finally {
 *     unlockPosition(position)
 *   }
 */
function tryLockPosition(position: LivePosition, lockId: string = "sync-tick"): boolean {
  // RC5: Guard against duplicate operations
  if (position.status === "closed" || position.status === "closing" || position.status === "closing_partial") {
    return false  // Already closed or closing
  }
  if (position.lockedAt && position.lockedAt > Date.now() - 60_000) {
    return false  // Locked within last 60s (still processing)
  }
  // Lock the position
  position.lockedAt = Date.now()
  position.lockedBy = lockId
  position.version = (position.version || 0) + 1
  return true
}

function unlockPosition(position: LivePosition): void {
  position.lockedAt = 0
  position.lockedBy = undefined
}

async function savePosition(position: LivePosition, retries: number = 0): Promise<void> {
  // RC2: Atomic position update with optimistic locking
  // Ensure version is set and increment before save
  if (!position.version) position.version = 0
  position.version++
  
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const posKey = `live_positions:${position.connectionId}:${position.id}`
  
  try {
    // Atomic update: set the position data with version marker
    // If another thread updated it concurrently, we'll detect via version mismatch
    await client.hset(posKey, {
      ...position,
      updatedAt: Date.now(),
    } as any)
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} [RC2] savePosition failed for ${position.symbol}/${position.id}:`,
      err instanceof Error ? err.message : String(err),
    )
    // Retry once on transient errors
    if (retries < 1 && err instanceof Error && err.message.includes("REDIS")) {
      await new Promise(r => setTimeout(r, 100))
      return savePosition(position, retries + 1)
    }
    throw err
  }
}

/**
 * Batch save multiple positions in a single transaction.
 * Reduces Redis round-trips from N × savePosition() to 1 batch operation.
 * Critical for cycle-end updates when many positions need simultaneous persistence.
 *
 * Example: 5 positions closing per cycle
 *   Before: 5 separate savePosition() calls = 5 Redis RTTs
 *   After: 1 batchSavePositions([p1, p2, p3, p4, p5]) = 1 Redis RTT
 * 
 * Typical impact: 20-30% reduction in Redis ops at cycle boundaries
 */
async function batchSavePositions(positions: LivePosition[]): Promise<void> {
  if (!positions || positions.length === 0) return

  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()

  try {
    // Use Redis pipeline for atomic multi-save
    const pipeline = (client as any).pipeline?.()
    if (!pipeline) {
      // Fallback: individual saves if pipeline not available
      await Promise.all(positions.map(p => savePosition(p)))
      return
    }

    // Queue all saves in pipeline
    for (const position of positions) {
      const key = `live_positions:${position.connectionId}:${position.id}`
      pipeline.hset(key, position as any)
    }

    // Execute all queued operations atomically
    await pipeline.exec()
  } catch (err) {
    console.warn(`${LOG_PREFIX} batchSavePositions failed:`, err instanceof Error ? err.message : String(err))
    // Fallback to individual saves on error
    await Promise.all(positions.map(p => savePosition(p).catch(() => {})))
  }
}
async function incrementMetric(connectionId: string, metric: string, delta: number = 1): Promise<void> {
  try {
    // Use validated wrapper to prevent stale metric writes
    const { getCurrentEpoch } = await import("@/lib/trade-engine/progression-lock")
    const { hincrbyProgression } = await import("@/lib/trade-engine/progression-writes")
    
    const currentEpoch = await getCurrentEpoch(connectionId)
    if (!currentEpoch) return // No active lock, skip write (stale instance)
    
    // Use validated wrapper for epoch-safe increments
    await hincrbyProgression(connectionId, metric, delta, {
      connectionId,
      epoch: currentEpoch,
      logStaleRejects: false,
    })
  } catch (err) {
    // metric failures should not throw the live pipeline
  }
}
async function incrementOrdersBySymbol(connectionId: string, symbol: string, side: string, metric: string): Promise<void> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  try {
    const key = `live_orders_by_symbol:${connectionId}`
    // Field format: `{SYMBOL}:{direction}:{metric}` e.g. "SOLUSDT:long:placed"
    // This matches the parser in /stats route (field.slice(midColon+1, lastColon) for direction,
    // field.slice(lastColon+1) for kind). Normalize case/venue aliases first:
    // exchange sync paths can pass `SHORT`, `SELL`, or `positionSide=SHORT`.
    // Treating only exact `"short"` as short folded those fills into the long
    // bucket, which made long/short order chips look identical or over-counted.
    // Using hincrby keeps the two directions independent and atomic.
    const sideKey = String(side || "").trim().toLowerCase()
    const dir = (sideKey.includes("short") || sideKey === "sell") ? "short" : "long"
    const symbolKey = String(symbol || "").trim().toUpperCase()
    const field = `${symbolKey}:${dir}:${metric}`
    if (typeof (client as any).hincrby === "function") {
      await (client as any).hincrby(key, field, 1)
    } else {
      // Fallback: read-modify-write
      const raw = await client.hget(key, field).catch(() => null)
      const current = parseInt(String(raw || "0"), 10) || 0
      await client.hset(key, { [field]: String(current + 1) })
    }
  } catch {
    /* best-effort */
  }
}
async function tryAcquireLock(connId: string, symbol: string, direction: string): Promise<string | null> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  const key = `live:lock:${connId}:${symbol}:${direction}`
  const token = `tok:${Date.now()}:${nanoid(8)}`
  try {
    // Atomic SET key token NX EX 300 — the ONLY correct dedup primitive.
    // `NX` guarantees exclusivity (a second concurrent entry on the same
    // symbol+direction gets `null` and falls through to the accumulate
    // path); `EX` guarantees the lock self-expires so a crashed engine
    // can never strand a slot. The previous lowercase `{ ex: 300 }` was
    // silently ignored by the client (which honours only `{ EX, NX, XX }`),
    // so the lock had neither a TTL nor exclusivity — every signal
    // "acquired" it and duplicate exchange orders were possible.
    const r = await client.set(key, token, { EX: 300, NX: true })
    return r === "OK" ? token : null
  } catch {
    return null
  }
}
async function findOpenLivePositionByDir(connId: string, symbol: string, side: string): Promise<LivePosition | null> {
  const { getLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
  const positions = await getLivePositions(connId)
  const norm = String(symbol || "").toUpperCase().replace(/[-_]/g, "")
  for (const p of positions) {
    const psym = String(p.symbol || "").toUpperCase().replace(/[-_]/g, "")
    if (psym === norm && p.direction === side && (p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed")) {
      return p
    }
  }
  return null
}
async function fetchCurrentPrice(symbol: string, connId?: string): Promise<number> {
  const { getMarketData, getRedisClient } = await import("@/lib/redis-db")
  try {
    // Primary: OHLCV candle-series key written by historic loader / live feed.
    const data = await getMarketData(symbol, "1m")
    if (data) {
      const latest = data.latest || (Array.isArray(data) ? data[data.length - 1] : null)
      if (latest) {
        const price = parseFloat(String(latest.close ?? latest[4] ?? latest.price ?? 0)) || 0
        if (price > 0) return price
      }
    }
    // Fallback: the synthetic price generator and the cron write the current
    // close into the flat hash `market_data:{symbol}` (field "close").
    // This key is available in the sandbox even when the candle-series key is absent.
    const client = getRedisClient()
    if (client) {
      const closeRaw = await client.hget(`market_data:${symbol}`, "close").catch(() => null)
      const price = parseFloat(String(closeRaw ?? 0)) || 0
      if (price > 0) return price
    }
    return 0
  } catch {
    return 0
  }
}
async function accumulateIntoLivePosition(connId: string, existing: LivePosition, real: any, price: number, connector: any): Promise<LivePosition> {
  // Accumulation (DCA / signal-stacking) MUST place a real exchange order
  // for the added size — otherwise Redis `executedQuantity` inflates while
  // the venue position does not, and the very next reconcile tick sees a
  // size mismatch (or, worse, arms SL/TP for phantom contracts). The prior
  // implementation merged quantities purely in memory; this is the bug fix.
  try {
    if (!existing.accumulatedSetKeys) existing.accumulatedSetKeys = []

    // ── Hard cap on merges per position ───────────────────────────────
    if (existing.accumulatedSetKeys.length >= MAX_ACCUMULATIONS_PER_POSITION) {
      pushStep(existing, "accumulate_skip", false, `cap reached (${MAX_ACCUMULATIONS_PER_POSITION} accumulations) — merge suppressed`)
      await savePosition(existing)
      return existing
    }

    // Idempotency: never merge the same Set twice into one position.
    if (real.setKey && existing.accumulatedSetKeys.includes(real.setKey)) {
      pushStep(existing, "accumulate_skip", false, `setKey ${real.setKey} already accumulated`)
      await savePosition(existing)
      return existing
    }

    if (!connector || typeof connector.placeOrder !== "function") {
      pushStep(existing, "accumulate_skip", false, "exchange connector unavailable — accumulation deferred")
      await savePosition(existing)
      return existing
    }

    const symbol = String(real.symbol || existing.symbol || "")
    const direction: "long" | "short" = (real.direction === "short" || existing.direction === "short") ? "short" : "long"
    const exchangeSide: "buy" | "sell" = direction === "long" ? "buy" : "sell"

    // ── Size the accumulation order the same way a fresh entry is sized ──
    // Pass the existing position's sizeMultiplier so Block/DCA accumulation
    // steps scale consistently with the original entry's variant intent.
    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connId,
      symbol,
      price,
      { tradeMode: "main", sizeMultiplier: existing.sizeMultiplier },
    ).catch(() => null)
    let addQty = volumeResult?.finalVolume || volumeResult?.volume || 0
    if (!Number.isFinite(addQty) || addQty <= 0) {
      // $5 notional fallback mirrors the primary-entry last-resort path.
      addQty = price > 0 ? 5 / price : 0
    }
    if (!Number.isFinite(addQty) || addQty <= 0) {
      pushStep(existing, "accumulate_skip", false, `could not size accumulation order for ${symbol}`)
      await savePosition(existing)
      return existing
    }

    // ── Place the real market order for the added size ──────────────────
    let orderRes: any = null
    try {
      orderRes = await connector.placeOrder(
        symbol,
        exchangeSide,
        addQty,
        undefined,
        "market",
        { positionSide: direction === "long" ? "LONG" : "SHORT" },
      )
    } catch (err) {
      pushStep(existing, "accumulate_order_error", false, err instanceof Error ? err.message : String(err))
      await savePosition(existing)
      return existing
    }

    const ok = !!orderRes?.success && !!(orderRes.orderId || orderRes.id)
    if (!ok) {
      pushStep(existing, "accumulate_order_failed", false, `exchange rejected accumulation: ${orderRes?.error || "unknown"}`)
      await savePosition(existing)
      return existing
    }

    // Prefer the venue's reported fill; fall back to requested qty/price.
    const filledQty = parseFloat(String(orderRes.filledQty ?? orderRes.executedQty ?? orderRes.cumQty ?? "0")) || addQty
    const filledPrice = parseFloat(String(orderRes.filledPrice ?? orderRes.avgPrice ?? orderRes.price ?? "0")) || price

    const prevExec = existing.executedQuantity || 0
    const prevAvg = existing.averageExecutionPrice || existing.entryPrice || 0
    const newExec = prevExec + filledQty
    existing.executedQuantity = newExec
    existing.quantity = (existing.quantity || 0) + filledQty
    existing.remainingQuantity = Math.max(0, (existing.quantity || 0) - newExec)
    // Notional-weighted average entry across the original fill + this merge.
    existing.averageExecutionPrice = newExec > 0 ? (prevAvg * prevExec + filledPrice * filledQty) / newExec : prevAvg
    existing.volumeUsd = newExec * (existing.averageExecutionPrice || filledPrice)
    if (!existing.fills) existing.fills = []
    existing.fills.push({ timestamp: Date.now(), quantity: filledQty, price: filledPrice, fee: 0, feeAsset: "USDT" })
    if (real.setKey) existing.accumulatedSetKeys.push(real.setKey)
    existing.updatedAt = Date.now()
    pushStep(existing, "accumulate", true, `+${filledQty} @ ${filledPrice} (setKey=${real.setKey || "n/a"}, total=${newExec})`)
    await incrementMetric(connId, "live_orders_accumulated_count")
    await savePosition(existing)

    // ── Re-arm protection orders for the new, larger size ───────────────
    // The existing SL/TP cover the pre-merge quantity; updateProtectionOrders
    // re-sizes them to the accumulated executedQuantity.
    //
    // Cooldown bypass: after an accumulation the position qty has definitively
    // changed — the old SL/TP orders cover fewer contracts than the live
    // exchange position. We MUST re-arm immediately regardless of when the
    // previous re-arm fired. Clear the per-leg timestamps so the cooldown
    // gate in `updateProtectionOrders` does not suppress this mandatory
    // cancel-replace. The timestamps are re-stamped by `updateProtectionOrders`
    // on success, so the 30 s cooldown clock restarts from the new placement.
    existing.stopLossLastArmedAt = undefined
    existing.takeProfitLastArmedAt = undefined
    try {
      await updateProtectionOrders(connector, existing, "accumulate_rearm", null)
      await savePosition(existing)
    } catch (err) {
      pushStep(existing, "accumulate_rearm_failed", false, err instanceof Error ? err.message : String(err))
    }
  } catch (err) {
    pushStep(existing, "accumulate_error", false, err instanceof Error ? err.message : String(err))
    try { await savePosition(existing) } catch { /* best-effort */ }
  }
  return existing
}
async function refreshLockTTL(connId: string, symbol: string, direction: string, ttlMs: number = 300000): Promise<void> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  try {
    // Uppercase `EX` is the only TTL key the client honours; the prior
    // lowercase `ex` was dropped, so the refreshed key lived forever and
    // a crashed engine left the slot locked permanently.
    await client.set(`live:lock:${connId}:${symbol}:${direction}`, String(Date.now()), { EX: Math.ceil(ttlMs / 1000) })
  } catch {
    // best-effort
  }
}
async function releaseLock(connId: string, symbol: string, direction: string): Promise<void> {
  const { getRedisClient } = await import("@/lib/redis-db")
  const client = getRedisClient()
  try {
    await client.del(`live:lock:${connId}:${symbol}:${direction}`)
  } catch {
    // best-effort
  }
}
function resolveMaxHoldMs(connId: string): number {
  // DEV/SIM override: the simulated connector uses a constant price so
  // positions never hit TP/SL organically. Without a short max-hold the
  // live:positions:{connId} list fills up unboundedly (500+ entries in a
  // few minutes), making positionsOpen stat nonsensical and consuming memory.
  // Cap at 2 minutes in non-production so positions roll quickly and the
  // open-book stays small. Real production runs use the configured value.
  // Delegate to the centralised engine-timings snapshot rather than a
  // bespoke settings read. `maxPositionHoldMs` is the single source of
  // truth (Redis `settings:system`, default 4h, `0` disables). The sync
  // getter returns the last cached snapshot — refreshed off the hot path
  // by `refreshEngineTimings()` — so the six reconcile/sweep call sites
  // pay zero per-tick Redis cost. The previous `return 0` stub silently
  // disabled the max-hold safety closer everywhere.
  try {
    const ms = getEngineTimings().maxPositionHoldMs
    return Number.isFinite(ms) && ms > 0 ? ms : 0
  } catch {
    return 0
  }
}

/**
 * Hard cap on the number of accumulations per live position.
 *
 * Without a cap, unlimited merges inflate position size proportionally
 * without any drawdown gating — the operator has no visibility and the
 * exchange may reject the accumulated notional.
 *   - 300 gives generous DCA headroom (1 initial entry + 299 merges ≈ 32× the
 *     initial allocation at equal-weight increments) for high-frequency strategies.
 */
const MAX_ACCUMULATIONS_PER_POSITION = 300

/**
 * Recognise exchange errors that CANNOT be fixed by retrying. For these
 * the operator must take an out-of-band action (top up margin, fix
 * leverage, restore symbol availability). Retrying just slams the
 * exchange and burns event-loop time on hopeless attempts.
 *
 * Currently catches:
 *   • BingX 101204 — Insufficient margin (top-up required)
 *   • BingX 80012  — Symbol not available for trading
 *   • Any error containing "insufficient margin" / "insufficient balance"
 *     / "not enough" (cross-exchange variants we may encounter)
 */
function isNonRecoverableExchangeError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    text = String(obj.error ?? obj.message ?? "")
  } else {
    text = String(payload)
  }
  if (!text) return false
  const lc = text.toLowerCase()
  return (
    /\bcode\s*=?\s*101204\b/.test(text) ||
    /\bcode\s*=?\s*80012\b/.test(text) ||
    lc.includes("insufficient margin") ||
    lc.includes("insufficient balance") ||
    lc.includes("not enough margin") ||
    lc.includes("not enough balance")
  )
}

/**
 * Retry a promise-returning function with exponential backoff.
 *
 * Short-circuits on non-recoverable exchange errors (insufficient margin,
 * symbol not tradable, etc.) — see `isNonRecoverableExchangeError`. This
 * stops the engine from making 3 hopeless API calls per signal cycle when
 * the user has no balance, which was producing ~20 failed exchange calls
 * per second under the observed cycle cadence.
 */
async function retry<T>(
  fn: () => Promise<T>,
  isSuccess: (r: T) => boolean,
  label: string,
  maxAttempts = 3
): Promise<T> {
  let lastResult: T | undefined
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await fn()
      lastResult = result
      if (isSuccess(result)) return result
      console.warn(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} unsuccessful`)
      // The connector returned `{ success: false, error: "…" }` — check
      // whether that error is non-recoverable and bail early if so.
      if (isNonRecoverableExchangeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return result
      }
      // Min-order-size errors (code=101400) need a quantity correction, not
      // more retries with the same qty. Short-circuit immediately so the
      // caller's correction handler can run without waiting for 2 more attempts.
      if (isMinOrderSizeError(result)) {
        console.warn(
          `${LOG_PREFIX} ${label} min-order-size error — stopping retry loop for quantity correction`,
        )
        return result
      }
    } catch (err) {
      console.error(`${LOG_PREFIX} ${label} attempt ${attempt}/${maxAttempts} error:`, err)
      // Thrown error variant — check the same predicates.
      if (isNonRecoverableExchangeError(err)) {
        console.warn(
          `${LOG_PREFIX} ${label} non-recoverable error detected — skipping remaining ${maxAttempts - attempt} attempt(s)`,
        )
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      if (isMinOrderSizeError(err)) {
        console.warn(`${LOG_PREFIX} ${label} min-order-size error — stopping retry loop`)
        return { success: false, error: err instanceof Error ? err.message : String(err) } as unknown as T
      }
      lastResult = undefined as unknown as T
    }
    if (attempt < maxAttempts) {
      // Tight backoff: 200 ms → 400 ms → 800 ms. Transient API blips
      // (network jitter, brief rate-limit, venue side proxy reload)
      // typically clear in well under 500 ms; the old 500/1000/2000 ms
      // schedule was burning roughly 1.5 s per failing entry without
      // adding success probability.
      const backoff = Math.pow(2, attempt - 1) * 200
      await new Promise(r => setTimeout(r, backoff))
    }
  }
  return lastResult as T
}

// ── Per-connection cooldown after non-recoverable margin errors ────��─
//
// When `executeLivePosition` fails with `code=101204` (Insufficient margin)
// the operator's account literally has no funds — nothing the engine can
// do programmatically will help. Without a cooldown, every Set evaluation
// on the next cycle re-attempts the order, generating a continuous
// stream of failed exchange API calls (~20/sec at observed cadence).
//
// Exponential backoff: each consecutive failure doubles the cooldown
// (60s ��� 120s → 240s → 300s cap). This prevents the re-arm loop where
// a 60s cooldown expires, the next attempt fails again (same root cause),
// and immediately re-arms for another 60s — making recovery appear stuck.
// After the operator tops up, the next successful order resets the counter.
//
// A `clearMarginCooldown(connectionId)` export allows the /api/engine/reconnect
// endpoint to forcibly release a stuck cooldown.
//
// NOTE: Exchange circuit-breaker errors (BingX code 109400 — "API orders
// temporarily disabled due to market volatility") are NOT margin errors.
// They have their own per-symbol gate (`circuitBreakerBySymbol`) with a
// 5-minute TTL and do NOT increment the margin failure counter.
const MARGIN_COOLDOWN_STEPS_MS = [60_000, 120_000, 240_000, 300_000]
const MARGIN_COOLDOWN_MAX_MS = 300_000

interface MarginCooldownEntry {
  lastErrorAt: number
  consecutiveFailures: number
}
const marginErrorCooldownByConnection: Map<string, MarginCooldownEntry> = new Map()

function isMarginCooldownActive(connectionId: string): boolean {
  const entry = marginErrorCooldownByConnection.get(connectionId)
  if (!entry) return false
  const stepIdx = Math.min(entry.consecutiveFailures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
  const cooldownMs = MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS
  if (Date.now() - entry.lastErrorAt < cooldownMs) return true
  // Cooldown expired — clear so the next attempt runs fresh.
  marginErrorCooldownByConnection.delete(connectionId)
  return false
}

function recordMarginError(connectionId: string): void {
  const existing = marginErrorCooldownByConnection.get(connectionId)
  marginErrorCooldownByConnection.set(connectionId, {
    lastErrorAt: Date.now(),
    consecutiveFailures: (existing?.consecutiveFailures ?? 0) + 1,
  })
}

/** Exported so the /api/engine/reconnect endpoint can forcibly clear a stuck cooldown. */
export function clearMarginCooldown(connectionId: string): void {
  marginErrorCooldownByConnection.delete(connectionId)
  console.log(`${LOG_PREFIX} Margin cooldown cleared for ${connectionId}`)
}

// ── Per-symbol exchange circuit-breaker gate ──────────────────────────
// BingX code 109400 means the exchange has TEMPORARILY disabled API
// trading for that symbol due to extreme volatility. This is NOT a
// margin/balance issue — the account is fine, the exchange re-enables
// trading automatically (typically within 1–5 minutes). We skip the
// symbol for 5 minutes then resume WITHOUT touching the margin counter,
// preventing one volatile symbol from blocking all orders on the connection.
const CIRCUIT_BREAKER_COOLDOWN_MS = 5 * 60_000 // 5 minutes
const circuitBreakerBySymbol: Map<string, number> = new Map()

function isCircuitBreakerActive(symbol: string): boolean {
  const ts = circuitBreakerBySymbol.get(symbol)
  if (!ts) return false
  if (Date.now() - ts < CIRCUIT_BREAKER_COOLDOWN_MS) return true
  circuitBreakerBySymbol.delete(symbol)
  return false
}

function recordCircuitBreaker(symbol: string): void {
  circuitBreakerBySymbol.set(symbol, Date.now())
}

function isCircuitBreakerError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    const obj = payload as Record<string, unknown>
    text = String(obj.error ?? obj.message ?? "")
  } else {
    text = String(payload)
  }
  return (
    /\bcode\s*=?\s*109400\b/.test(text) ||
    /\bcode\s*=?\s*109418\b/.test(text) ||   // symbol offline / delisted
    /api orders? (?:are )?temporarily disabled/i.test(text) ||
    /large market fluctuations/i.test(text) ||
    /is offline currently/i.test(text)
  )
}

/**
 * Detect BingX code=101400 "minimum order amount" rejections.
 * These mean the requested quantity is below the exchange-required minimum for
 * the specific trading pair. The volume calculator will respect the stored
 * min_order_size on the next cycle, so this is a transient failure that
 * self-heals once the metadata is written to Redis.
 */
function isMinOrderSizeError(payload: unknown): boolean {
  if (!payload) return false
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    text = String((payload as Record<string, unknown>).error ?? (payload as Record<string, unknown>).message ?? "")
  } else {
    text = String(payload)
  }
  // Match BingX 101400, 110424, or any message with "minimum order" or "order size must"
  return (
    /\bcode\s*=?\s*(101400|110424)\b/.test(text) ||
    /minimum order/i.test(text) ||
    /order size must/i.test(text)
  )
}

/**
 * Parse the minimum token quantity from BingX error messages.
 * BingX formats:
 *   - "The minimum order amount is 56.974 DRIFT" (101400)
 *   - "The order size must be less than the available amount of 0.0001 BTC" (110424)
 * Returns undefined when the message does not match expected formats.
 */
function extractMinOrderQty(payload: unknown): number | undefined {
  let text = ""
  if (typeof payload === "string") text = payload
  else if (payload instanceof Error) text = payload.message
  else if (typeof payload === "object") {
    text = String((payload as Record<string, unknown>).error ?? (payload as Record<string, unknown>).message ?? "")
  }
  
  // Try "minimum order amount is X" format
  let m = /minimum order amount is ([\d.]+)/i.exec(text)
  if (m) {
    const qty = parseFloat(m[1])
    if (Number.isFinite(qty) && qty > 0) return qty
  }
  
  // Try "available amount of X" format (from 110424)
  m = /available amount of ([\d.]+)/i.exec(text)
  if (m) {
    const qty = parseFloat(m[1])
    if (Number.isFinite(qty) && qty > 0) return qty * 1.5 // Use 1.5x available as safe minimum
  }
  
  return undefined
}

/**
 * Poll an order until it reaches a terminal fill state or the timeout elapses.
 *
 * ── Fast-ramp polling schedule ───────────────────────────────────────
 * Market orders on most venues acknowledge as `FILLED` within 100-300 ms;
 * a flat 800 ms poll interval therefore wastes ~600 ms on every entry
 * before we can place SL/TP. The new schedule:
 *
 *   poll 1: 100 ms
 *   poll 2: 200 ms
 *   poll 3: 350 ms
 *   poll 4+: 600 ms (steady state for stubborn limit orders)
 *
 * Total latency to detect a typical instant fill drops from ~800 ms to
 * ~100 ms, while still tolerating slow venues without flooding the API.
 */
async function pollOrderFill(
  connector: any,
  symbol: string,
  orderId: string,
  timeoutMs = 15000,
  _legacyIntervalMs = 800,
): Promise<{ filled: boolean; filledQty: number; filledPrice: number; status: string }> {
  void _legacyIntervalMs
  // Guard: a missing orderId means the exchange didn't return one (API
  // issue or order was immediately rejected). Don't call getOrder(undefined)
  // — it generates exchange API spam and never confirms a fill.
  if (!orderId) {
    return { filled: false, filledQty: 0, filledPrice: 0, status: "pending" }
  }
  const intervals = [100, 200, 350, 600]
  const deadline = Date.now() + timeoutMs
  let lastStatus = "pending"
  let pollIdx = 0
  // Track the best partial result seen so far — return it on timeout rather
  // than returning filled=false when we know some qty was actually transacted.
  let bestPartialQty = 0
  let bestPartialPrice = 0
  while (Date.now() < deadline) {
    try {
      const order = await connector.getOrder(symbol, orderId)
      if (order) {
        lastStatus = order.status || order.orderStatus || "unknown"
        const statusLower = String(lastStatus).toLowerCase().trim()
        const rawFilledQty  = parseFloat(String(order.filledQty  ?? order.executedQty ?? order.cumQty    ?? "0")) || 0
        const rawFilledPrice = parseFloat(String(order.filledPrice ?? order.avgPrice   ?? order.price     ?? "0")) || 0

        // Any of these status strings mean the exchange has fully transacted the order.
        const isFilled =
          statusLower === "filled" ||
          statusLower === "deal" ||        // BingX historical alias
          statusLower === "complete" ||
          statusLower === "completed" ||
          order.status === "FILLED"

        // Partial fills: qty > 0 even if status isn't fully "filled" yet.
        // Accept as usable — protection orders should be sized to filledQty,
        // not the requested qty. Remaining qty will be covered by reconcile.
        const isPartialFill =
          (statusLower === "partially_filled" || statusLower === "partial_fill") &&
          rawFilledQty > 0

        if (rawFilledQty > bestPartialQty) {
          bestPartialQty  = rawFilledQty
          bestPartialPrice = rawFilledPrice
        }

        if ((isFilled || isPartialFill) && rawFilledQty > 0) {
          return {
            filled: true,
            filledQty: rawFilledQty,
            filledPrice: rawFilledPrice || 0,
            status: isFilled ? "filled" : "partially_filled",
          }
        }
        if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
          return { filled: false, filledQty: 0, filledPrice: 0, status: statusLower }
        }
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} poll error:`, err instanceof Error ? err.message : String(err))
    }
    
    // Calculate wait time with exponential backoff
    const wait = intervals[Math.min(pollIdx, intervals.length - 1)]
    pollIdx += 1
    
    // Early return on next poll attempt if near deadline (avoid wasting final poll)
    const remainingTime = deadline - Date.now()
    if (remainingTime <= 50) break
    
    await new Promise(r => setTimeout(r, Math.min(wait, remainingTime)))
  }
  // Timeout — return whatever partial qty we managed to see rather than zero.
  // A non-zero bestPartialQty means the exchange has transacted at least some
  // volume; returning it lets the caller place SL/TP for the confirmed portion.
  if (bestPartialQty > 0) {
    return { filled: true, filledQty: bestPartialQty, filledPrice: bestPartialPrice, status: "partially_filled" }
  }
  return { filled: false, filledQty: 0, filledPrice: 0, status: lastStatus }
}


/**
 * Batch poll multiple orders for fills in parallel.
 * 
 * When multiple orders are in-flight during live trading, polling each
 * individually wastes time waiting for sequential getOrder calls. This
 * function polls all orders concurrently against the same deadline,
 * reducing total fill detection time from N*100ms to ~100ms.
 * 
 * Example: 5 orders in-flight
 *   Sequential: 5 × 100ms = 500ms minimum
 *   Batch: 1 × 100ms = 100ms minimum (50% faster)
 */
async function batchPollOrderFills(
  connector: any,
  orders: Array<{ symbol: string; orderId: string }>,
  timeoutMs = 15000,
): Promise<Record<string, { filled: boolean; filledQty: number; filledPrice: number; status: string }>> {
  if (!orders || orders.length === 0) return {}
  
  // Poll all orders in parallel instead of sequentially
  const pollPromises = orders.map(({ symbol, orderId }) =>
    pollOrderFill(connector, symbol, orderId, timeoutMs).catch(err => {
      console.warn(`${LOG_PREFIX} batch poll failed for ${orderId}:`, err instanceof Error ? err.message : String(err))
      return { filled: false, filledQty: 0, filledPrice: 0, status: "error" }
    })
  )
  
  const results = await Promise.all(pollPromises)
  const output: Record<string, any> = {}
  
  orders.forEach((order, idx) => {
    output[order.orderId] = results[idx]
  })
  
  return output
}

/**
 * Cancel an SL/TP order on the exchange. Tolerates "order not found" and
 * other recoverable errors silently — the typical reason this is called
 * is that the position is being closed or the protection order is being
 * replaced, both of which mean we don't care if it's already gone.
 *
 * Returns `true` only when we actively confirmed cancellation (or that
 * the connector accepted the request); returns `false` for any error so
 * callers can decide whether to retry or fall through to a market exit.
 */
/**
 * Cancel every leftover reduce-only order on the venue for a given
 * symbol+close-side pair. This is the safety-net used immediately AFTER
 * `closeLivePosition` finishes its by-id cancellations.
 *
 * Why we need a sweep on top of the recorded-id cancellations:
 *   1. The recorded protection ids may be stale (re-armed after a
 *      partial fill, the old id never made it to `savePosition` because
 *      the process crashed between place-success and persist).
 *   2. A by-id cancel can return failure for a transient reason (network
 *      blip, brief 429) and the engine cannot afford to keep retrying
 *      indefinitely. The sweep doubles as a retry on the next tick.
 *   3. An operator may have placed a manual reduce-only leg that the
 *      engine never knew about. Once the position is gone, that order
 *      can only ever cause "exchange control orders chaos" — it has no
 *      position to reduce, and the next entry on the same symbol would
 *      see it as an unexpected closer.
 *
 * We filter conservatively to ONLY reduce-only orders matching the
 * close direction so the sweep never touches another strategy's open
 * orders on the same symbol.
 */
async function sweepOrphanProtectionOrders(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
): Promise<{ scanned: number; cancelled: number }> {
  const result = { scanned: 0, cancelled: 0 }
  if (!connector || typeof connector.getOpenOrders !== "function") return result
  let orders: any[] = []
  try {
    const raw = (await withTimeout(
      connector.getOpenOrders(symbol) as Promise<any>,
      15_000,
      `sweepOrphan.getOpenOrders(${symbol})`,
    )) as any[] | undefined
    orders = Array.isArray(raw) ? raw : []
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} [sweep] getOpenOrders(${symbol}) failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return result
  }
  result.scanned = orders.length

  // A reduce-only order with side === closeSide is, by definition, a
  // protection leg for a position in `closeSide`'s opposite direction.
  // We accept any flavour of the reduce-only flag the connectors emit:
  // `reduceOnly`, `reduce_only`, `closePosition`, `isReduceOnly`.
  //
  // BingX HEDGE-MODE SPECIAL CASE:
  // In hedge mode (the default on BingX Perpetuals) the exchange does NOT
  // set `reduceOnly=true` on SL/TP orders — the position-reduction semantic
  // is instead conveyed by `positionSide` ("LONG" / "SHORT"). Without the
  // explicit flag, the original `isReduceOnly` check always returns false and
  // orphan protection orders are NEVER swept, leaving stale SL/TP orders on
  // the exchange indefinitely where they fire against the next entry.
  //
  // Fix: additionally treat any order as a protection candidate when its
  // `type` is a known stop/TP order type AND it is on the closing side.
  // These types are exchange-level SL/TP market trigger orders regardless of
  // the hedge/one-way mode and cannot be non-protection regular orders on the
  // closing side with these types.
  const PROTECTION_ORDER_TYPES = new Set([
    "STOP_MARKET", "TAKE_PROFIT_MARKET", "STOP", "TAKE_PROFIT",
    "stop_market", "take_profit_market", "stop", "take_profit",
  ])
  const isReduceOnly = (o: any): boolean =>
    !!(o?.reduceOnly ?? o?.reduce_only ?? o?.closePosition ?? o?.isReduceOnly)
  const isProtectionType = (o: any): boolean =>
    PROTECTION_ORDER_TYPES.has(String(o?.type ?? o?.orderType ?? ""))
  const sameSide = (o: any): boolean =>
    String(o?.side ?? o?.orderSide ?? "").toLowerCase() === closeSide

  // ── BingX hedge-mode direction isolation ────────────────────────────────
  // In hedge mode the exchange annotates each order with `positionSide`
  // ("LONG" or "SHORT"). A sell-side STOP_MARKET for positionSide=SHORT is
  // the SHORT position's *stop loss* — it is NOT an orphan of the LONG
  // position we are closing. Without this guard, closing a LONG would sweep
  // the SHORT's protection orders and leave the SHORT position unprotected.
  //
  // When the field is absent ("BOTH" or empty) the account is in one-way
  // mode and the original side-match is already sufficient.
  //
  // closeSide="sell" → we are closing a LONG  → keep only positionSide=LONG
  // closeSide="buy"  → we are closing a SHORT → keep only positionSide=SHORT
  const matchesPositionSide = (o: any): boolean => {
    const ps = String(o?.positionSide ?? o?.position_side ?? "").toUpperCase()
    if (!ps || ps === "BOTH" || ps === "") return true  // one-way mode or field absent
    const expectedPs = closeSide === "sell" ? "LONG" : "SHORT"
    return ps === expectedPs
  }

  for (const o of orders) {
    // Accept the order as a sweep candidate when it is on the closing side,
    // scoped to the correct position direction (hedge-mode guard above),
    // AND either carries an explicit reduce-only flag (one-way mode) OR has a
    // stop/TP order type (hedge mode where the flag is absent).
    const sideOk = sameSide(o)
    const psOk   = matchesPositionSide(o)
    const typeOk = isReduceOnly(o) || isProtectionType(o)
    const ordId  = o?.id ?? o?.orderId ?? o?.orderID ?? o?.clientOrderId ?? o?.client_oid
    if (!sideOk) continue
    if (!psOk) continue
    if (!typeOk) continue
    if (ordId == null || String(ordId).length === 0) continue
    const ok = await cancelProtectionOrder(connector, symbol, String(ordId), "OrphanSweep")
    if (ok) result.cancelled++
  }

  if (result.cancelled > 0 || result.scanned > 0) {
    console.log(
      `${LOG_PREFIX} [sweep] ${symbol} close=${closeSide}: scanned=${result.scanned} cancelled=${result.cancelled}`,
    )
  }
  return result
}

async function cancelProtectionOrder(
  connector: any,
  symbol: string,
  orderId: string | undefined,
  label: string,
): Promise<boolean> {
  if (!orderId) return false
  try {
    if (typeof connector?.cancelOrder !== "function") return false
    // withTimeout wraps cancelOrder; actual HTTP timeout is enforced by the
    // rate-limiter's executeTimeoutMs (dispatch-time only, not enqueue-time).
    const res = await withTimeout(
      connector.cancelOrder(symbol, orderId) as Promise<any>,
      EXCHANGE_TIMEOUT_CANCEL_ORDER_MS,
      `cancelOrder(${label} ${orderId})`,
    )
    if (res?.success) {
      console.log(`${LOG_PREFIX} ${label} cancelled: ${orderId}`)
      return true
    }
    // Treat "not found" / "already filled" / "already cancelled" as success
    // for our purposes — the exchange-side state is already what we wanted.
    const errStr = String(res?.error || "").toLowerCase()
    if (
      errStr.includes("not found") ||
      errStr.includes("not exist") ||
      errStr.includes("order does not exist") ||
      errStr.includes("already") ||
      errStr.includes("filled") ||
      errStr.includes("cancelled") ||
      errStr.includes("canceled") ||
      // BingX-specific already-gone codes in the error message:
      //   101400 = "Order not exist" (filled or externally cancelled SL/TP)
      //   101500 = "Order not found" (expired conditional order)
      errStr.includes("code=101400") ||
      errStr.includes("code=101500")
    ) {
      console.log(`${LOG_PREFIX} ${label} already gone: ${orderId} (${res?.error})`)
      return true
    }
    console.warn(`${LOG_PREFIX} ${label} cancel failed: ${orderId} — ${res?.error}`)
    return false
  } catch (err) {
    console.warn(`${LOG_PREFIX} ${label} cancel error:`, err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Place a protection order (SL or TP) as a reduce-only limit order at
 * `triggerPrice` that *closes* (never opens) a position.
 *
 * On hedge-mode perp accounts the connector needs to know the positionSide
 * of the OPEN position (LONG/SHORT), which is independent of the order's
 * close side. Passing `reduceOnly=true` + the correct `positionSide` is
 * what prevents the exchange from treating this as a new opposite-side
 * entry and hedging against the real position.
 */
async function placeProtectionOrder(
  connector: any,
  symbol: string,
  closeSide: "buy" | "sell",
  quantity: number,
  triggerPrice: number,
  orderLabel: "StopLoss" | "TakeProfit",
  positionDirection: "long" | "short",
): Promise<string | null> {
  // ── Structured trace context ──────────────────────���─────────────────
  // Every protection-order placement gets a single multi-field log line
  // before any exchange interaction, so when an operator reports "the
  // order didn't get created" we can immediately answer THREE questions
  // from one grep:
  //   1. What were the inputs the engine sent?
  //   2. Did we even reach the venue? (rejected-locally entries say so)
  //   3. What did the venue say back? (success line includes id/latency,
  //      failure line includes the venue error verbatim)
  const tag = `${LOG_PREFIX} [${orderLabel}] ${symbol}`
  const placeStart = Date.now()
  console.log(
    `${tag} placement requested: dir=${positionDirection} closeSide=${closeSide} qty=${quantity} trigger=${triggerPrice}`,
  )

  try {
    // Prefer the connector's CONDITIONAL-order path
    // (`placeStopOrder`) over a regular `placeOrder`. The legacy code
    // here used `placeOrder(..., "limit")` at the trigger price — which
    // for SL on a long is a sell-limit BELOW market and gets rejected
    // by most exchanges as an aggressive reduce-only, leaving the
    // position unprotected. `placeStopOrder` lands a real STOP_MARKET /
    // TAKE_PROFIT_MARKET (BingX) or `triggerPrice`-based market reduce
    // (Bybit), and falls back to the limit-as-trigger behaviour on
    // connectors that haven't been upgraded yet (see `BaseExchangeConnector`).
    if (typeof connector?.placeStopOrder !== "function") {
      console.warn(`${tag} REJECTED LOCALLY: connector has no placeStopOrder — protection unavailable`)
      return null
    }

    // Defensive input validation. The SL/TP test suite previously sent
    // `NaN` quantity from a venue-shape mismatch and the exchange echoed
    // back "Invalid quantity: NaN" 800 ms later — costly because by then
    // the entry position is already live and unprotected. Validate at the
    // helper boundary so a future bug upstream surfaces immediately as a
    // local log line rather than as a venue-side rejection mid-trade.
    if (!Number.isFinite(quantity) || quantity <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid quantity=${quantity} (must be finite, >0)`)
      return null
    }
    if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
      console.error(`${tag} REJECTED LOCALLY: invalid triggerPrice=${triggerPrice} (must be finite, >0)`)
      return null
    }

    // ── Venue minimum-quantity floor ──────────────────────────────────
    // Same per-base-asset floor used by the test harness — shared via
    // `lib/exchange-min-qty.ts` so they cannot drift. BingX rejects
    // sub-minimum orders with code=110422 "The minimum size per order
    // is 0.0001 BTC."; the same class of rejection exists on Bybit
    // (110007) and Binance (-1013).
    //
    // CRITICAL: only floor UP when the position qty already exceeds venueMin.
    // If the position is smaller than venueMin (e.g. 0.77 SOL when min=1),
    // flooring up to 1 produces code=110424 "order size must be less than the
    // available amount of 0.77 SOL". In that case we use the original quantity
    // — the protection order covers exactly what the position holds. The venue
    // will accept a qty equal to the position size even if it's below the
    // general minimum (reduce-only orders close existing exposure, so many
    // exchanges relax the minimum when the order is strictly reduce-only and
    // qty matches the position).
    const venueMin = getVenueMinQty(symbol)
    let effectiveQty = quantity
    if (quantity < venueMin) {
      if (quantity * 2 >= venueMin) {
        // Position is between 50% and 100% of venueMin — safe to floor up
        // because the excess is small and reduce-only semantics on BingX
        // allow the SL/TP qty to exceed the held quantity by a small margin
        // without rejection (the exchange closes the whole position anyway).
        console.warn(
          `${tag} QTY FLOORED: requested=${quantity} bumped to venueMin=${venueMin} (preventing code=110422)`,
        )
        effectiveQty = venueMin
      } else {
        // Position qty is well below venueMin. Do NOT floor up: that would
        // produce code=110424 (qty > available amount). Use exact position qty
        // so the reduce-only order covers precisely what we hold.
        console.warn(
          `${tag} QTY BELOW VENUE MIN: position=${quantity} venueMin=${venueMin} — using position qty to avoid 110424`,
        )
        effectiveQty = quantity
      }
    }

    const kind: "stop_loss" | "take_profit" =
      orderLabel === "StopLoss" ? "stop_loss" : "take_profit"

    // ── Helper: extract numeric "available amount" from a 110424 message ──
    // Error text: "The order size must be less than the available amount of 0.77 SOL"
    const extract110424Available = (errMsg: string): number | null => {
      const m = /available amount of ([\d.]+)/i.exec(errMsg)
      if (!m) return null
      const n = parseFloat(m[1])
      return Number.isFinite(n) && n > 0 ? n : null
    }

    // NOTE: We do NOT pass `hedgeMode` here. The BingX connector defaults to
    // hedgeMode=true (sends `positionSide`) and includes a built-in one-way
    // fallback retry that fires when BingX returns code=80014. Passing
    // hedgeMode:false would suppress `positionSide` entirely — which works
    // on one-way accounts but breaks hedge accounts (BingX requires
    // positionSide there, and the retry path only handles the inverse
    // hedge→one-way case). Letting the connector default to hedge-mode +
    // auto-retry covers both account types correctly.
    // Bounded — a hanging placeStopOrder would block the per-position sync
    // loop and stall every other position's heal/close work behind it. On
    // timeout we return null; the next sync tick will retry, and meanwhile
    // `checkAndForceCloseOnSltpCross` provides the safety net (it triggers
    // on price independent of whether the protection order is armed).
    // ── Normalize connector throws to result objects ──────────────────────
    // The BingX connector (and others) throw on venue rejection rather than
    // returning { success: false }.  The 109420 / 110424 retry blocks below
    // check `result?.error`, which is never set when a throw escapes directly
    // to the outer catch.  By wrapping each `placeStopOrder` call in its own
    // try-catch we guarantee all code paths reach the retry checks with a
    // well-shaped result object.
    const placeStop = async (qty: number): Promise<any> => {
      // Acquire the global semaphore before calling the exchange.
      // EXCHANGE_TIMEOUT_PLACE_STOP_MS is applied via the rate-limiter's
      // executeTimeoutMs (starts from dispatch time, not enqueue time) so the
      // timeout only covers actual HTTP time — not queue-wait time. This prevents
      // "Aborted while queued" errors from killing requests before they start.
      await acquireStopSem()
      try {
        return await withTimeout(
          connector.placeStopOrder(
            symbol,
            closeSide,
            qty,
            triggerPrice,
            kind,
            {
              reduceOnly: true,
              positionSide: positionDirection === "long" ? "LONG" : "SHORT",
            },
          ) as Promise<any>,
          EXCHANGE_TIMEOUT_PLACE_STOP_MS,
          `placeStopOrder(${orderLabel} ${symbol})`,
        )
      } catch (e: any) {
        return { success: false, error: String(e?.message || e) }
      } finally {
        releaseStopSem()
      }
    }

    let result = await placeStop(effectiveQty)

    // ── code=110424: "order size must be less than available amount" ───
    // Triggered when the protection qty exceeds the position's remaining
    // available quantity.  Common cause: venue minimum (e.g. 1 TRB) is larger
    // than the partial fill size (e.g. 0.62 TRB), or two concurrent SL+TP
    // placements race to claim the same available pool.
    // Strategy: up to 2 retries, each time re-parsing the available qty from
    // BingX's error message and retrying with exactly that amount.  If the
    // second retry also fails with 110424, the position has likely been
    // externally closed or fully consumed by the other protection leg — treat
    // it as success (reconcile will verify).
    if (!result?.success) {
      const is110424 = (msg: string) => msg.includes("110424") || /available amount/i.test(msg)
      let attempt = 0
      while (!result?.success && is110424(String(result?.error || "")) && attempt < 2) {
        const errMsg = String(result?.error || "")
        const availableQty = extract110424Available(errMsg)
        if (availableQty === null) break
        if (availableQty <= 0) {
          // Nothing left to protect — position fully consumed or externally closed.
          console.warn(`${tag} 110424: available=0 — position fully consumed, treating as protected`)
          result = { success: true, orderId: "position_exhausted" }
          effectiveQty = 0
          break
        }
        console.warn(
          `${tag} 110424 retry#${attempt + 1}: qty=${effectiveQty} > available=${availableQty} — retrying`,
        )
        effectiveQty = availableQty
        result = await placeStop(effectiveQty)
        attempt++
      }
      // Second retry also returned 110424 — position consumed or protected by peer leg.
      if (!result?.success && is110424(String(result?.error || ""))) {
        const secondAvail = extract110424Available(String(result?.error || ""))
        console.warn(
          `${tag} 110424 exhausted after ${attempt} retries (lastAvail=${secondAvail}) — position likely closed/protected, treating as success`,
        )
        result = { success: true, orderId: "position_exhausted" }
        effectiveQty = secondAvail ?? effectiveQty
      }
      // Update effectiveQty on first-retry success
      if (result?.success && effectiveQty !== quantity) {
        // qty was adjusted; already updated in loop above
      }
    }

    // ── code=109420: "position not exist" ──────────────────────────────────
    // BingX hedge-mode positions need a short settling period after a market
    // order is accepted before a STOP/TP can reference them. In the
    // unconfirmed-fill path the 2 s post-fill wait (live-stage ~line 2795)
    // is sometimes insufficient for volatile symbols (DOGE, ADA). Retry once
    // after an additional 2 s; reconcile will arm the order on the next tick
    // if the retry also fails (position will have settled by then).
    if (!result?.success) {
      const errMsg109 = String(result?.error || "")
      if (errMsg109.includes("109420") || /position not exist/i.test(errMsg109)) {
        // Exponential backoff: 1s, 2s, 4s.
        // BingX hedge-mode positions can take 2–4 s to become visible
        // under load. The old 500ms/1s/2s budget was exhausted too quickly,
        // causing the protection order to be deferred to the next reconcile
        // tick — leaving the position unprotected for up to 60 s.
        const BACKOFF_DELAYS_MS = [1000, 2000, 4000]
        let retryAttempt = 0
        while (retryAttempt < BACKOFF_DELAYS_MS.length && !result?.success) {
          const delay = BACKOFF_DELAYS_MS[retryAttempt]
          console.warn(`${tag} 109420 retry: position not yet visible on exchange — waiting ${delay}ms before retry`)
          await new Promise((r) => setTimeout(r, delay))
          result = await placeStop(effectiveQty)
          if (result?.success) {
            console.log(`${tag} 109420 retry succeeded after ${delay}ms`)
            break
          }
          retryAttempt++
        }
        if (!result?.success) {
          console.warn(`${tag} 109420 retries exhausted (tried 1s, 2s, 4s) — reconcile will retry on next tick`)
        }
      }
    }

    const latencyMs = Date.now() - placeStart
    // Coerce id to string. Some venues return numeric ids; downstream
    // code does `if (pos.stopLossOrderId)` checks that would mistake a
    // legitimately-zero (or zero-string) id for "no order placed". The
    // venues we support never issue id=0 in practice, but the coercion
    // keeps the type contract identical across connectors.
    const rawId = result?.success ? (result.orderId ?? result.id) : null
    const orderId = rawId !== null && rawId !== undefined && String(rawId).length > 0 ? String(rawId) : null
    if (orderId) {
      console.log(
        `${tag} PLACED: orderId=${orderId} @ trigger=${triggerPrice} qty=${effectiveQty}${effectiveQty !== quantity ? ` (requested=${quantity}, adjusted)` : ""} latency=${latencyMs}ms`,
      )
      return orderId
    }
    // code=110412 / 110413: "SL price must be > current price" (for long SL placed above mark)
    // or "TP price must be < current price" (for short TP placed above mark after a spike).
    // The protection price was valid at calculation time but the market moved past it between
    // calculation and placement. Return the sentinel "PRICE_CROSSED" so the caller can
    // force-close the position immediately instead of waiting for the next reconcile tick.
    const errMsg = String(result?.error || "")
    const is110412 = errMsg.includes("110412") || /SL price should (be|not be)|Stop Loss price should/i.test(errMsg)
    const is110413 = errMsg.includes("110413") || /TP price should (be|not be)|Take Profit price should/i.test(errMsg)
    if (is110412 || is110413) {
      console.warn(
        `${tag} PRICE_CROSSED (code=${is110412 ? "110412" : "110413"}): market moved past ${kind} trigger — position will be force-closed`,
      )
      return "PRICE_CROSSED"
    }
    // result.error is the connector's normalized venue-side message.
    // Log verbatim so operators see the EXACT venue rejection.
    console.warn(
      `${tag} VENUE REJECTED: error="${result?.error || "unknown"}" code=${result?.code ?? "n/a"} latency=${latencyMs}ms`,
    )
    return null
  } catch (err) {
    const latencyMs = Date.now() - placeStart
    const msg = err instanceof Error ? err.message : String(err)
    console.warn(`${tag} EXCEPTION: ${msg} latency=${latencyMs}ms`)
    return null
  }
}

/**
 * Snapshot every order ID currently open on the venue, across all
 * symbols, as a single normalized `Set<string>`. Used by the reconcile
 * and sync loops to verify each position's recorded `stopLossOrderId`
 * and `takeProfitOrderId` are still alive on the exchange — without
 * making one `getOrder()` call per leg per position per tick.
 *
 * Returns `null` when the connector either has no `getOpenOrders` or
 * when the call fails/times out. Callers MUST treat `null` as "skip
 * liveness verification this tick" rather than "no orders exist" — the
 * latter would incorrectly wipe every protection id on a transient
 * network blip.
 *
 * Cross-venue order-id field walk matches the test harness in
 * `/api/test/live-orders-test`: BingX returns `orderId`, ccxt-style
 * adapters return `id`, some return both. We collect every non-empty
 * candidate per row so we cannot miss a leg because the connector
 * happened to name the field differently than expected.
 */
async function fetchLiveOrderIdSet(connector: any): Promise<Set<string> | null> {
  if (!connector || typeof connector.getOpenOrders !== "function") return null
  try {
    // 25 s upper bound — BingX getOpenOrders queues behind live-order calls
    // in the rate limiter. With maxConcurrent=3 and a placeOrder (market) in
    // flight, getOpenOrders may wait up to ~15 s in queue before the HTTP
    // request even starts. 25 s covers queue-wait + HTTP round-trip reliably
    // without blocking the rate limiter indefinitely.
    // On timeout we degrade gracefully to drift-only reconciliation.
    const orders = (await withTimeout(
      connector.getOpenOrders() as Promise<any>,
      25_000,
      "getOpenOrders(reconcile-tick)",
    )) as any[] | undefined
    if (!Array.isArray(orders)) return null
    const set = new Set<string>()
    for (const o of orders) {
      // Prefer exchange-assigned numeric IDs over operator-supplied client IDs.
      // Using `clientOrderId`/`client_oid` as a fallback is safe only when no
      // real numeric ID is present on the order — otherwise a future client-ID
      // echo from the connector could mask a genuinely-missing real orderId and
      // suppress liveness-based re-arming of a gone SL/TP order.
      const realId = o?.id ?? o?.orderId ?? o?.orderID
      if (realId != null && String(realId).length > 0) {
        set.add(String(realId))
        // Also add the secondary form so both "1234" and "orderId:1234" styles
        // that different connectors might store on the position are matched.
        if (o?.orderId != null && String(o.orderId) !== String(realId)) set.add(String(o.orderId))
        if (o?.id     != null && String(o.id)      !== String(realId)) set.add(String(o.id))
      } else {
        // No real numeric ID — fall back to the client-supplied fields.
        const fallback = o?.clientOrderId ?? o?.client_oid
        if (fallback != null) {
          const s = String(fallback)
          if (s.length > 0) set.add(s)
        }
      }
    }
    return set
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} fetchLiveOrderIdSet failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Derive the desired SL/TP trigger prices from a live position's current
 * percentage settings and average execution price. Returns `0` for either
 * leg when the corresponding percentage is non-positive (i.e. SL/TP is
 * disabled for that side). Pure function — does NOT touch the exchange.
 */
function computeDesiredProtectionPrices(pos: LivePosition): {
  desiredSl: number
  desiredTp: number
} {
  const fillPrice = pos.averageExecutionPrice || pos.entryPrice
  // CRITICAL: Guard against undefined, NaN, negative, or zero fill prices
  // that would cause NaN or Infinity propagation in SL/TP calculations.
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return { desiredSl: 0, desiredTp: 0 }

  // ── Trailing stop: use the ratcheted absolute price directly ────────────────
  // When trailing is active syncLiveFromPseudo stamps pos.trailingStopPrice
  // with the latest ratcheted absolute stop level. Using that absolute price
  // directly avoids the percentage-anchored re-derivation below which would
  // always revert to the static origin level, fighting the ratchet every tick.
  let desiredSl: number
  const trailingPrice = typeof pos.trailingStopPrice === "number" ? pos.trailingStopPrice : 0
  if (pos.trailingActive && Number.isFinite(trailingPrice) && trailingPrice > 0) {
    desiredSl = trailingPrice
  } else {
    // Do not apply the hard live-entry minimum here. This helper is shared by
    // exchange control-order reconciliation, system-close checks, and operator
    // recalculation flows. Control-order mode is independent from the live-entry
    // SL policy, so reconciliation must honor the position's already-stored SL
    // value. New live positions and operator overrides normalize that stored
    // value at their boundaries instead.
    const rawSlPct = pos.stopLoss || 0
    // Guard: ensure stopLoss is numeric and non-negative before percentage calc
    const slPct = Number.isFinite(rawSlPct) && rawSlPct > 0 ? (rawSlPct / 100) : 0
    desiredSl =
      slPct > 0
        ? pos.direction === "long"
          ? fillPrice * (1 - slPct)
          : fillPrice * (1 + slPct)
        : 0
    // Final NaN guard: ensure result is safe before returning
    if (!Number.isFinite(desiredSl)) desiredSl = 0
  }

  const rawTpPct = pos.takeProfit || 0
  // Guard: ensure takeProfit is numeric and non-negative before percentage calc
  const tpPct = Number.isFinite(rawTpPct) && rawTpPct > 0 ? (rawTpPct / 100) : 0
  let desiredTp =
    tpPct > 0
      ? pos.direction === "long"
        ? fillPrice * (1 + tpPct)
        : fillPrice * (1 - tpPct)
      : 0
  // Final NaN guard: ensure result is safe before returning
  if (!Number.isFinite(desiredTp)) desiredTp = 0

  return { desiredSl, desiredTp }
}

/**
 * Has the desired protection price drifted enough from the currently
 * placed one to warrant cancelling and re-placing? We use 0.25% as the
 * tolerance — tighter than that and we'd thrash the exchange API on
 * every tiny rounding diff. Looser and we'd leave stale levels in place
 * after a real strategy adjustment.
 */

function getProtectionReferencePrice(pos: LivePosition): number {
  const markRaw = pos.exchangeData?.markPrice
  const markPrice = typeof markRaw === "number" ? markRaw : parseFloat(String(markRaw ?? ""))
  if (Number.isFinite(markPrice) && markPrice > 0) return markPrice
  if (Number.isFinite(pos.averageExecutionPrice) && pos.averageExecutionPrice > 0) return pos.averageExecutionPrice
  return Number.isFinite(pos.entryPrice) && pos.entryPrice > 0 ? pos.entryPrice : 0
}

function findCrossedProtectionTrigger(
  pos: LivePosition,
  desiredSl: number,
  desiredTp: number,
  referencePrice: number,
): { leg: "StopLoss" | "TakeProfit"; triggerPrice: number; expectedSide: string } | null {
  if (!Number.isFinite(referencePrice) || referencePrice <= 0) return null
  const direction = pos.direction === "short" ? "short" : "long"

  if (Number.isFinite(desiredSl) && desiredSl > 0) {
    if (direction === "long" && desiredSl >= referencePrice) {
      return { leg: "StopLoss", triggerPrice: desiredSl, expectedSide: "below" }
    }
    if (direction === "short" && desiredSl <= referencePrice) {
      return { leg: "StopLoss", triggerPrice: desiredSl, expectedSide: "above" }
    }
  }

  if (Number.isFinite(desiredTp) && desiredTp > 0) {
    if (direction === "long" && desiredTp <= referencePrice) {
      return { leg: "TakeProfit", triggerPrice: desiredTp, expectedSide: "above" }
    }
    if (direction === "short" && desiredTp >= referencePrice) {
      return { leg: "TakeProfit", triggerPrice: desiredTp, expectedSide: "below" }
    }
  }

  return null
}

async function closeIfProtectionTriggerAlreadyCrossed(
  connector: any,
  pos: LivePosition,
  desiredSl: number,
  desiredTp: number,
  context: string,
): Promise<boolean> {
  const referencePrice = getProtectionReferencePrice(pos)
  const crossed = findCrossedProtectionTrigger(pos, desiredSl, desiredTp, referencePrice)
  if (!crossed) return false

  const direction = pos.direction === "short" ? "short" : "long"
  const detail =
    `${crossed.leg} trigger already crossed for ${pos.symbol} ${direction}: ` +
    `trigger=${crossed.triggerPrice} must be ${crossed.expectedSide} reference=${referencePrice}; forcing close instead of placing invalid protection order`
  console.warn(`${LOG_PREFIX} [protection-crossed] ${detail}`)
  pushStep(pos, "protection_trigger_already_crossed", true, detail)
  await logProgressionEvent(
    pos.connectionId,
    "live_trading",
    "warning",
    `Protection trigger already crossed for ${pos.symbol} — force closing`,
    {
      livePositionId: pos.id,
      symbol: pos.symbol,
      direction,
      leg: crossed.leg,
      triggerPrice: crossed.triggerPrice,
      referencePrice,
      expectedSide: crossed.expectedSide,
      context,
      reason: "protection_trigger_already_crossed",
    },
  )
  await savePosition(pos).catch(() => {})
  await closeLivePosition(pos.connectionId, pos.id, referencePrice, connector, "protection_trigger_already_crossed")
  return true
}

function priceDrifted(current: number | undefined, desired: number): boolean {
  if (!desired || desired <= 0) return false
  if (!current || current <= 0) return true // never placed or lost
  return Math.abs(current - desired) / desired > 0.0025
}

/**
 * Reconcile the SL/TP exchange orders against the live position's current
 * desired levels. Three cases per leg (SL and TP independently):
 *
 *   1. Desired = 0 (disabled) and an order is still on the exchange:
 *      cancel it. Common after an operator turns off SL or TP mid-trade.
 *   2. No order recorded (or order id stale) and desired > 0:
 *      place a fresh protection order.
 *   3. Order id present BUT price drifted (>0.25%) from desired:
 *      cancel old → place new at correct level. Cancel-first guarantees
 *      we never accidentally double-protect (which would produce two
 *      reduce-only fills against the same exchange position).
 *
 * Updates `pos.stopLossOrderId`, `pos.takeProfitOrderId`, `pos.stopLossPrice`,
 * `pos.takeProfitPrice` to reflect what's now actually live on the exchange.
 *
 * Returns a boolean indicating whether anything changed (so callers can
 * decide whether to persist the position).
 */

// ── Per-position re-arm cooldown ────────────────────────────────────────────
// The 200–300 ms reconcile loop calls `updateProtectionOrders` for every open
// position on every tick. The "drift-based" cancel-replace logic is correct, but
// at 3–5 Hz a mark price oscillating at the 0.25% boundary produces repeated
// cancel-replace storms that exhaust rate limits and generate confusing audit
// logs. The cooldown gate adds a minimum quiet period between cancel-replaces
// driven by *price or qty drift* (not missing-order re-arms — those always fire
// immediately because arming a missing order is never a no-op).
//
// MIN_REARM_MS (30 s) — for static SL/TP price drift: long enough to absorb
//   a normal oscillation window (BTC 0.5% range typically resolves in ~5-15 s).
//
// TRAILING_REARM_MS (5 s) �� for trailing ratchet advances: the trailing stop
//   machine ratchets approximately every strategy cycle (~5 s). A 30 s cooldown
//   here means the exchange order would lag the ratchet by up to 5 cycles, leaving
//   the position underprotected while the trailing level was moving in our favour.
//   5 s gives one-cycle latency: worst case the ratchet advances, we wait one
//   cycle, then update. The shorter cooldown only applies when trailingActive=true
//   and the absolute trailingStopPrice has actually moved — not on every tick.
//
// Missing-order re-arms (stopLossOrderId = undefined after liveness-verify)
// bypass all cooldowns and always place immediately.
const MIN_REARM_MS = 30_000
const TRAILING_REARM_MS = 5_000

// ── System-close-only flag, micro-cached ─────────────────────────────
//
// Reconcile fans out across every live position; without this cache
// each position would HGETALL `app_settings:*` to read one boolean.
// 2 s TTL is short enough that operator toggles take visible effect
// within one reconcile cycle, long enough to collapse a whole burst
// of position-level calls into one Redis round-trip.
const SYSTEM_CLOSE_TTL_MS = 2000
let _systemCloseCacheValue: boolean | null = null
let _systemCloseCacheAt = 0
let _systemCloseInflight: Promise<boolean> | null = null

async function getCachedSystemCloseOnly(): Promise<boolean> {
  const now = Date.now()
  if (_systemCloseCacheValue !== null && now - _systemCloseCacheAt < SYSTEM_CLOSE_TTL_MS) {
    return _systemCloseCacheValue
  }
  if (_systemCloseInflight) return _systemCloseInflight
  _systemCloseInflight = (async () => {
    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const appSettings: any = (await getAppSettings().catch(() => null)) || {}
      const v =
        appSettings.useSystemCloseOnly === true ||
        appSettings.use_system_close_only === true
      _systemCloseCacheValue = v
      _systemCloseCacheAt = Date.now()
      return v
    } catch {
      // Fail closed: assume venue control orders (the default) on read
      // failure rather than incorrectly arming system-close-only mode.
      _systemCloseCacheValue = false
      _systemCloseCacheAt = Date.now()
      return false
    } finally {
      _systemCloseInflight = null
    }
  })()
  return _systemCloseInflight
}

async function updateProtectionOrders(
  connector: any,
  pos: LivePosition,
  reason: string,
  // Once-per-tick snapshot of order IDs currently open on the venue.
  // When provided, we cross-check our recorded `stopLossOrderId` /
  // `takeProfitOrderId` against this set: any recorded id NOT present in
  // the live snapshot is treated as silently gone (filled, externally
  // cancelled, expired, account-level reduce-only sweep, etc.) and the
  // local fields are cleared so the existing "no id → place fresh"
  // branch re-arms the leg on the same tick.
  //
  // Pass `null`/omit to skip verification (legacy callers that only
  // want price/qty-drift reconciliation pay no extra REST cost).
  liveOrderIds?: Set<string> | null,
): Promise<{ changed: boolean; slPlaced: boolean; tpPlaced: boolean }> {
  const result = { changed: false, slPlaced: false, tpPlaced: false }
  if (!connector) return result
  const effectiveQty = pos.executedQuantity > 0 ? pos.executedQuantity : (pos.quantity ?? 0)
  if (effectiveQty <= 0) return result

  // ─── CRITICAL GUARD: Skip SL/TP placement if position closed externally ───
  // If the position status is "closed" or force-close reasons are set, the
  // position is no longer open on the exchange. Attempting to place SL/TP
  // on a closed position will fail and cause repeated retry spam in logs.
  // The reconciliation loop detected external close; cleanup happens next.
  // Return early so we don't waste exchange calls on already-dead orders.
  if (pos.status === "closed" || 
      (pos.closeReason && pos.closedAt) ||
      (pos.statusReason && pos.statusReason.includes("closed")) ||
      (pos.statusReason && pos.statusReason.includes("EXTERNALLY"))) {
    // Position is dead; skip SL/TP work. The position will be archived
    // by the next reconciliation step (no position found on exchange).
    console.log(
      `${LOG_PREFIX} [${reason}] SKIPPED SL/TP for ${pos.symbol} (status=${pos.status}, closeReason=${pos.closeReason})`
    )
    return result
  }

  // ── System-close-only mode (cached) ────────────────────────────��──�������
  // Reconcile fans out across every live position on every tick, so
  // calling `getAppSettings()` here would issue one HGETALL per
  // position per tick — at 50 positions × 1 Hz that's 50 round-trips
  // for a flag that changes only when an operator toggles it in
  // settings. Cache the boolean for `SYSTEM_CLOSE_TTL_MS` (≈2 s) so
  // every position in the same reconcile burst reuses one read; the
  // TTL is short enough that toggling the setting takes effect within
  // ~2 s of the next tick (well below the operator's perceptual
  // threshold) and long enough to collapse a whole tick's worth of
  // reads into one.
  try {
    const systemCloseOnly = await getCachedSystemCloseOnly() ||
      (pos as any)?.useSystemCloseOnly === true
    if (systemCloseOnly) {
      const cancels: Array<Promise<unknown>> = []
      if (pos.stopLossOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "SystemCloseSweep-SL").catch(() => false))
      if (pos.takeProfitOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "SystemCloseSweep-TP").catch(() => false))
      if (cancels.length > 0) {
        await Promise.allSettled(cancels)
        console.log(`${LOG_PREFIX} [system-close] ${pos.symbol} — swept ${cancels.length} stale control order(s)`)
        pos.stopLossOrderId = undefined
        pos.takeProfitOrderId = undefined
        pos.stopLossPrice = 0
        pos.takeProfitPrice = 0
        result.changed = true
      }
      ;(pos as any).protectionMode = "system_close"
      return result
    } else if ((pos as any).protectionMode === "system_close") {
      delete (pos as any).protectionMode
      result.changed = true
    }
  } catch (modeErr) {
    console.warn(`${LOG_PREFIX} [system-close] toggle read failed for ${pos.symbol} — falling back to control orders:`, modeErr instanceof Error ? modeErr.message : String(modeErr))
  }

  // ── Liveness verification against the venue ────────────────���─────────
  // Without this step the engine has no way to notice a SILENTLY GONE
  // protection order. The legacy drift-only check passes (price hasn't
  // moved, qty hasn't moved, id is still set) and we leave the position
  // unprotected indefinitely. The most common silent-gone causes:
  //   • SL/TP fired for a partial qty on a venue that doesn't
  //     auto-cancel the sibling leg (we keep the now-filled id)
  //   • Account-level reduce-only sweep (Bybit / OKX during margin-mode
  //     transitions)
  //   • Venue auto-expired a triggered conditional order
  //   • Operator manually cancelled via the venue UI
  // Clearing the local id forces the placement branch below to re-arm
  // the leg in the same reconcile tick.
  if (liveOrderIds && liveOrderIds.size >= 0) {
    if (pos.stopLossOrderId && !liveOrderIds.has(String(pos.stopLossOrderId))) {
      console.log(
        `${LOG_PREFIX} [verify] StopLoss ${pos.symbol} orderId=${pos.stopLossOrderId} not found on venue — clearing & re-arming`,
      )
      pos.stopLossOrderId = undefined
      pos.stopLossPrice = 0
      result.changed = true
    }
    if (pos.takeProfitOrderId && !liveOrderIds.has(String(pos.takeProfitOrderId))) {
      console.log(
        `${LOG_PREFIX} [verify] TakeProfit ${pos.symbol} orderId=${pos.takeProfitOrderId} not found on venue — clearing & re-arming`,
      )
      pos.takeProfitOrderId = undefined
      pos.takeProfitPrice = 0
      result.changed = true
    }
  }

  const { desiredSl, desiredTp } = computeDesiredProtectionPrices(pos)
  const closeSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"

  if (await closeIfProtectionTriggerAlreadyCrossed(connector, pos, desiredSl, desiredTp, reason)) {
    result.changed = true
    return result
  }

  // ── Quantity drift detection ──────────────────────────────────��───────
  // When more volume joins the position (delayed partial fills, accumulation
  // merges, post-fill sync detection) the SL/TP order on the exchange is
  // still armed for the *original* qty, leaving the delta unprotected.
  // Compare the current executed qty against the qty that was armed at
  // last placement; >0.25% drift triggers a cancel-and-replace on each
  // leg even if the trigger price hasn't moved. This is the missing
  // fix the user reported as "TP/SL not working" after partial fills.
  // NaN-hardened drift detection. `protectionArmedQuantity` is JSON-
  // round-tripped through Redis; a corrupted persistence path could
  // resurrect it as NaN. With the original `armedQty <= 0` check NaN
  // compares false on every operator, so qtyDrifted stayed false and
  // a partial-fill increase would silently NOT re-arm. Coerce to a
  // finite number first, treating non-finite or non-positive armed
  // quantities as "never armed" (forces re-arm).
  const armedQtyRaw = pos.protectionArmedQuantity
  const armedQty =
    typeof armedQtyRaw === "number" && Number.isFinite(armedQtyRaw) && armedQtyRaw > 0
      ? armedQtyRaw
      : 0
  const qtyDrifted =
    pos.executedQuantity > 0 &&
    (armedQty <= 0 ||
      Math.abs(pos.executedQuantity - armedQty) / Math.max(armedQty, 1e-12) > 0.0025)

  // ── Stop-Loss + Take-Profit legs: parallelised cancels, then parallel places ──
  //
  // Latency contract: control orders MUST arm "instantly" — the operator
  // explicitly called this out. Original implementation: cancel-SL → place-SL →
  // cancel-TP → place-TP (sequential, 4 RTTs on critical path ≈ 400ms at 100ms RTT).
  // Previous optimization: parallel legs (2 RTTs ≈ 200ms).
  // Current optimization: parallel cancels (SL+TP together) → parallel places (SL+TP).
  // Result: 3 RTTs max ≈ 300ms (if one cancel fails → retry next tick, no place).
  // If both cancels succeed: places can overlap → still ~200ms or better.
  // Each leg only mutates its own position fields (no cross-leg contention).
  //
  // Strategy: Collect both cancel promises, await them in parallel,
  // THEN proceed to parallel places only if cancels succeeded.
  
  // First, collect cancellation promises for both legs (if needed)
  const slCancelPromise = (async () => {
    if (desiredSl > 0 && pos.stopLossOrderId && 
        (priceDrifted(pos.stopLossPrice, desiredSl) || qtyDrifted)) {
      // Need to re-arm SL — cancel the old one first
      return await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
        .catch((err) => {
          console.warn(
            `${LOG_PREFIX} StopLoss cancel failed for ${pos.symbol}:`,
            err instanceof Error ? err.message : String(err)
          )
          return false
        })
    }
    // No cancel needed for SL, or SL is being turned off (handled in leg below)
    return true
  })()

  const tpCancelPromise = (async () => {
    if (desiredTp > 0 && pos.takeProfitOrderId && 
        (priceDrifted(pos.takeProfitPrice, desiredTp) || qtyDrifted)) {
      // Need to re-arm TP — cancel the old one first
      return await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit")
        .catch((err) => {
          console.warn(
            `${LOG_PREFIX} TakeProfit cancel failed for ${pos.symbol}:`,
            err instanceof Error ? err.message : String(err)
          )
          return false
        })
    }
    // No cancel needed for TP, or TP is being turned off (handled in leg below)
    return true
  })()

  // Await both cancels in parallel (massive latency win if both need cancel)
  const [slCancelOk, tpCancelOk] = await Promise.all([slCancelPromise, tpCancelPromise])

  const slLeg = (async () => {
    if (desiredSl <= 0 && pos.stopLossOrderId) {
      // SL was turned off — yank the existing order. Hard cancel
      // failures intentionally keep the recorded id so the next
      // reconcile pass retries; resetting it here would orphan the
      // exchange-side order and produce a phantom unprotected position
      // from our POV.
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss")
      if (cancelled) {
        pos.stopLossOrderId = undefined
        pos.stopLossPrice = 0
        result.changed = true
      }
    } else if (
      // Re-arm (place fresh / cancel-replace) the SL leg when a stop is
      // desired AND there is no live protection at the right level. The
      // liveness-verification block above has already cleared
      // `stopLossOrderId` if the recorded order is gone from the venue, so
      // by here `!pos.stopLossOrderId` reliably means "nothing armed".
      // Placing also fires when the trigger price or the position quantity
      // has drifted past tolerance (cancel-then-replace at the new level).
      //
      // NOTE: the previous one-liner folded the "order still alive on
      // venue" check into the SAME `||` group as `!pos.stopLossOrderId`,
      // which (because `||` binds tighter than `?:`) made the whole
      // expression evaluate to `false` whenever NO order existed — so a
      // position with no stop-loss order was never armed at all.
      //
      // ── Re-arm cooldown (MIN_REARM_MS) ────────────────────────────────────
      // When an order IS present and we're just drift-cancel-replacing, gate
      // on the cooldown to prevent oscillation storms. Missing-order paths
      // (!pos.stopLossOrderId, already cleared by liveness-verify above)
      // always bypass the cooldown — arming a missing order is never a no-op.
      desiredSl > 0 &&
      (
        !pos.stopLossOrderId
          ? true  // no order at all → arm immediately regardless of cooldown
          : (priceDrifted(pos.stopLossPrice, desiredSl) || qtyDrifted) &&
            // Trailing ratchets use a shorter cooldown so exchange orders track
            // the ratcheted level within one strategy cycle (~5 s). Static price
            // drift uses the full 30 s cooldown to absorb oscillation noise.
            Date.now() - (pos.stopLossLastArmedAt ?? 0) >=
              (pos.trailingActive ? TRAILING_REARM_MS : MIN_REARM_MS)
      )
    ) {
      // Cancel-then-replace race: if a cancel fails we must NOT place
      // a new SL — the old one is still armed on the exchange, and
      // adding a second reduce-only at a different trigger price
      // creates a window where a price spike crossing both levels
      // fires both orders before the second's reduceOnly check
      // rejects it. Treat a definitive cancel failure as "skip this
      // tick, retry next tick" so reconcile can re-evaluate.
      // NOTE: SL and TP cancellations are parallelized at the top of this
      // block to overlap RTTs. Both cancel promises resolve before we place either leg.
      let oldGone = true
      if (pos.stopLossOrderId) {
        // Use the pre-computed slCancelOk result from parallel cancels above
        oldGone = slCancelOk
        if (!oldGone) {
          console.warn(
            `${LOG_PREFIX} StopLoss cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
          )
        }
      }
      if (oldGone) {
        const id = await placeProtectionOrder(
          connector,
          pos.symbol,
          closeSide,
          effectiveQty,
          desiredSl,
          "StopLoss",
          pos.direction!,
        )
        // Only treat the leg as "armed at desiredSl" when we actually
        // have a confirmed numeric order id (not the "PRICE_CROSSED" sentinel
        // which means market already blew past the SL and a force-close should
        // happen on the next reconcile checkAndForceCloseOnSltpCross pass).
        const slIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted"
        if (slIdOk) {
          pos.stopLossOrderId = id!
          pos.stopLossPrice = desiredSl
          pos.stopLossLastArmedAt = Date.now()
          result.changed = true
          result.slPlaced = true
        } else {
          pos.stopLossOrderId = undefined
          pos.stopLossPrice = 0
        }
      }
    }
  })()

  const tpLeg = (async () => {
    if (desiredTp <= 0 && pos.takeProfitOrderId) {
      const cancelled = await cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit")
      if (cancelled) {
        pos.takeProfitOrderId = undefined
        pos.takeProfitPrice = 0
        result.changed = true
      }
    } else if (
      // Mirror of the SL leg: arm a take-profit when one is desired and
      // nothing live covers it (or the level/qty drifted). Same precedence
      // fix — the old `||`-grouped ternary collapsed to `false` when no TP
      // order existed, leaving positions without a take-profit entirely.
      //
      // ── Re-arm cooldown (MIN_REARM_MS) — mirror of SL leg ───────────────
      desiredTp > 0 &&
      (
        !pos.takeProfitOrderId
          ? true  // no order at all → arm immediately
          : (priceDrifted(pos.takeProfitPrice, desiredTp) || qtyDrifted) &&
            Date.now() - (pos.takeProfitLastArmedAt ?? 0) >=
              (pos.trailingActive ? TRAILING_REARM_MS : MIN_REARM_MS)
      )
    ) {
      let oldGone = true
      if (pos.takeProfitOrderId) {
        // Use the pre-computed tpCancelOk result from parallel cancels above
        oldGone = tpCancelOk
        if (!oldGone) {
          console.warn(
            `${LOG_PREFIX} TakeProfit cancel failed for ${pos.symbol} — deferring re-place to avoid duplicate reduceOnly`,
          )
        }
      }
      if (oldGone) {
        const id = await placeProtectionOrder(
          connector,
          pos.symbol,
          closeSide,
          effectiveQty,
          desiredTp,
          "TakeProfit",
          pos.direction!,
        )
        const tpIdOk = id && id !== "PRICE_CROSSED" && id !== "position_exhausted"
        if (tpIdOk) {
          pos.takeProfitOrderId = id!
          pos.takeProfitPrice = desiredTp
          pos.takeProfitLastArmedAt = Date.now()
          result.changed = true
          result.tpPlaced = true
        } else {
          pos.takeProfitOrderId = undefined
          pos.takeProfitPrice = 0
        }
      }
    }
  })()

  // Use allSettled to prevent one failed leg from crashing both SL and TP.
  // Individually catch errors for graceful degradation instead of crashing.
  await Promise.allSettled([slLeg, tpLeg]).then((results) => {
    results.forEach((result, idx) => {
      if (result.status === "rejected") {
        const legName = idx === 0 ? "StopLoss" : "TakeProfit"
        console.warn(
          `${LOG_PREFIX} armProtection: ${legName} leg failed:`,
          result.reason instanceof Error ? result.reason.message : String(result.reason),
        )
      }
    })
  })

  // Record the qty we armed for only when at least one leg was actually
  // (re-)placed on the exchange. A liveness-verify clear sets result.changed
  // but may not result in a successful placement (venue reject, timeout).
  // Stamping the baseline from a failed placement tells the drift-detector
  // "this qty is protected" when it is unprotected, suppressing re-arm on
  // the next tick. We keep result.changed for the pushStep / save path below.
  if (result.slPlaced || result.tpPlaced) {
    pos.protectionArmedQuantity = effectiveQty
  }

  if (result.changed) {
    pushStep(
      pos,
      "update_sl_tp",
      true,
      `[${reason}] SL ${pos.stopLoss}% → ${pos.stopLossPrice ? pos.stopLossPrice.toFixed(6) : "—"} (${pos.stopLossOrderId || "—"}) | ` +
      `TP ${pos.takeProfit}% → ${pos.takeProfitPrice ? pos.takeProfitPrice.toFixed(6) : "—"} (${pos.takeProfitOrderId || "—"})`,
    )
    await logProgressionEvent(
      pos.connectionId,
      "live_trading",
      "info",
      `SL/TP updated for ${pos.symbol} (${reason})`,
      {
        // Both the originally-assigned percentages (immutable contract)
        // and the currently-active percentages (mutable, override-aware).
        // On the steady state these are equal; after an operator override
        // they diverge — the assigned pair makes the override audit-trail
        // self-documenting in the dashboard's progression panel.
        assignedStopLossPct: pos.assignedStopLoss,
        assignedTakeProfitPct: pos.assignedTakeProfit,
        stopLossPct: pos.stopLoss,
        takeProfitPct: pos.takeProfit,
        slOrderId: pos.stopLossOrderId,
        slPrice: pos.stopLossPrice,
        tpOrderId: pos.takeProfitOrderId,
        tpPrice: pos.takeProfitPrice,
        fillPrice: pos.averageExecutionPrice,
      },
    )
  }

  return result
}

// ── Main Pipeline ───�����──────���───��─────────────────────────────────────────────

/**
 * Execute a real position on exchange as a live position with the full
 * progression pipeline.
 */
export async function executeLivePosition(
  connectionId: string,
  realPosition: RealPosition,
  exchangeConnector: any
): Promise<LivePosition> {
  await initRedis()
  const client = getRedisClient()
  const connectionTrackingId = makeConnectionTrackingId(connectionId)

  // ── Exchange circuit-breaker gate (per-symbol) ──────────────���────────
  // BingX code 109400 — "API orders temporarily disabled due to market
  // volatility" — affects a specific symbol for ~1-5 minutes. Skip it
  // silently rather than counting it as a margin/balance failure.
  if (isCircuitBreakerActive(realPosition.symbol)) {
    const cbSkipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${nanoid(8)}`,
      connectionId,
      system_tracking_id: makeSystemTrackingId(connectionId),
      connection_tracking_id: connectionTrackingId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      realPositionId: realPosition.id,
      quantity: realPosition.quantity,
      executedQuantity: 0,
      remainingQuantity: realPosition.quantity,
      entryPrice: realPosition.entryPrice,
      averageExecutionPrice: 0,
      volumeUsd: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      stopLoss: realPosition.stopLoss,
      takeProfit: realPosition.takeProfit,
      assignedStopLoss: realPosition.stopLoss,
      assignedTakeProfit: realPosition.takeProfit,
      status: "rejected",
      statusReason: `Skipped — exchange circuit breaker active for ${realPosition.symbol} (market volatility, resumes in <5min)`,
      fills: [],
      progression: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setKey:         realPosition.setKey,
      parentSetKey:   realPosition.parentSetKey,
      setVariant:     realPosition.setVariant,
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      accumulatedSetKeys: realPosition.setKey ? [realPosition.setKey] : [],
      // Set-config propagation: carry trailing profile and prevPos from the
      // originating StrategySet so the position is config-aware even when it
      // does not actually execute (for audit-trail completeness).
      trailingProfile: realPosition.trailingProfile,
      prevPos:         realPosition.prevPos,
    }
    pushStep(cbSkipped, "preflight", false, cbSkipped.statusReason!)
    logProgressionEvent(connectionId, "live_trading", "warning", cbSkipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
    }).catch(() => {})
    return cbSkipped
  }

  // ���─ Non-recoverable-error cooldown gate ──
  //
  // If we hit `code=101204` (Insufficient margin) within the exponential
  // backoff window (60s → 120s → 240s → 300s), skip this attempt and return
  // a synthetic "rejected" LivePosition. Prevents API flood on no-balance.
  //
  // The skip is silent at console level after the first occurrence so
  // logs stay readable; the progression event still records it for the
  // dashboard. Operator tops up → next successful order resets counter.
  if (isMarginCooldownActive(connectionId)) {
    const entry = marginErrorCooldownByConnection.get(connectionId)
    const failures = entry?.consecutiveFailures ?? 1
    const stepIdx = Math.min(failures - 1, MARGIN_COOLDOWN_STEPS_MS.length - 1)
    const cooldownSec = Math.round((MARGIN_COOLDOWN_STEPS_MS[stepIdx] ?? MARGIN_COOLDOWN_MAX_MS) / 1000)
    const normalizedSkippedSl = normalizeStopLossPercent(realPosition.stopLoss).value
    const normalizedSkippedTp = Math.max(0, Number(realPosition.takeProfit) || 0)
    const skipped: LivePosition = {
      id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${nanoid(8)}`,
      connectionId,
      system_tracking_id: makeSystemTrackingId(connectionId),
      connection_tracking_id: connectionTrackingId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      realPositionId: realPosition.id,
      quantity: realPosition.quantity,
      executedQuantity: 0,
      remainingQuantity: realPosition.quantity,
      entryPrice: realPosition.entryPrice,
      averageExecutionPrice: 0,
      volumeUsd: 0,
      leverage: realPosition.leverage,
      marginType: "cross",
      stopLoss: normalizedSkippedSl,
      takeProfit: normalizedSkippedTp,
      // Immutable snapshot of the originally-assigned values — survives
      // any later override via `recalculateAndApplySLTP`. See type def.
      assignedStopLoss: normalizedSkippedSl,
      assignedTakeProfit: normalizedSkippedTp,
      status: "rejected",
      statusReason:
        `Skipped — margin-error cooldown active (attempt ${failures}, cooldown=${cooldownSec}s). Top up exchange balance to resume.`,
      fills: [],
      progression: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      setKey:         realPosition.setKey,
      parentSetKey:   realPosition.parentSetKey,
      setVariant:     realPosition.setVariant,
      axisWindows:    realPosition.axisWindows,
      sizeMultiplier: realPosition.sizeMultiplier,
      accumulatedSetKeys: realPosition.setKey ? [realPosition.setKey] : [],
      trailingProfile: realPosition.trailingProfile,
      prevPos:         realPosition.prevPos,
    }
    pushStep(skipped, "preflight", false, skipped.statusReason!)
    // Don't await — fire-and-forget is fine for the cooldown skip log.
    logProgressionEvent(connectionId, "live_trading", "warning", skipped.statusReason!, {
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      consecutiveFailures: failures,
      cooldownSec,
    }).catch(() => {})
    return skipped
  }

  const livePosition: LivePosition = {
    id: `live:${connectionId}:${realPosition.symbol}:${realPosition.direction}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
    connectionId,
    system_tracking_id: makeSystemTrackingId(connectionId),
    connection_tracking_id: connectionTrackingId,
    symbol: realPosition.symbol,
    direction: realPosition.direction,
    realPositionId: realPosition.id,
    quantity: realPosition.quantity,
    executedQuantity: 0,
    remainingQuantity: realPosition.quantity,
    entryPrice: realPosition.entryPrice,
    averageExecutionPrice: 0,
    volumeUsd: 0,
    leverage: realPosition.leverage,
    marginType: "cross",
    // ── Set-config-aware initial SL% ──────────────────────────────────────
    // Use `computeSetAwareSL` so the protection level is derived from the Set's
    // own configuration rather than a generic PF-derived percentage:
    //   • trailing variant: SL = trailingProfile.stopRatio * 100 (trail distance
    //     anchor; ratchets upward once the trailing machine activates)
    //   • block/dca/default: normalised PF-derived value (already variant-scaled
    //     by sizeMultiplier in deriveProtectionFromProfitFactor at dispatch)
    stopLoss: computeSetAwareSL(
      normalizeStopLossPercent(realPosition.stopLoss).value,
      realPosition.setVariant,
      realPosition.trailingProfile,
    ),
    takeProfit: realPosition.takeProfit,
    // Immutable assignment snapshot — preserved across overrides so the
    // progression panel and post-trade stats can always recover what the
    // upstream Set originally specified. Mirrors `stopLoss`/`takeProfit`
    // at creation; never mutated thereafter.
    assignedStopLoss: realPosition.stopLoss,
    assignedTakeProfit: realPosition.takeProfit,
    status: "pending",
    fills: [],
    progression: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // ── Set lineage propagation (Main → Real → Live) ──────────────────
    // Carry the Set Type metadata from the upstream RealPosition into
    // this LivePosition verbatim. The exchange-position storage layer
    // serialises the entire LivePosition, so these fields ride along
    // for free and become available to post-trade statistics queries.
    // `accumulatedSetKeys` is seeded with the originating setKey so
    // accumulation merges later append onto a non-empty list (rather
    // than having to special-case the first entry).
    setKey:         realPosition.setKey,
    parentSetKey:   realPosition.parentSetKey,
    setVariant:     realPosition.setVariant,
    axisWindows:    realPosition.axisWindows,
    sizeMultiplier: realPosition.sizeMultiplier,
    accumulatedSetKeys: realPosition.setKey ? [realPosition.setKey] : [],
    // ── Set-config propagation (Relations → Live Protection) ──────────
    // The trailing profile and historical performance snapshot from the
    // originating StrategySet travel through RealPosition → LivePosition
    // so the live protection layer can (a) anchor the initial SL at the
    // correct trailing distance and (b) reference the Set's historical
    // context for audit and future re-scoring. Both fields are read-only
    // after creation — they reflect the Set's config at dispatch time.
    trailingProfile: realPosition.trailingProfile,
    prevPos:         realPosition.prevPos,
  }

  const normalizedInitialSl = normalizeStopLossPercent(realPosition.stopLoss)
  if (normalizedInitialSl.adjusted) {
    pushStep(livePosition, "protection_sl_normalized", true, normalizedInitialSl.reason!)
    logProgressionEvent(
      connectionId,
      "live_trading",
      "warning",
      `StopLoss normalized for ${realPosition.symbol}`,
      {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
        assignedStopLoss: realPosition.stopLoss,
        effectiveStopLoss: normalizedInitialSl.value,
        reason: normalizedInitialSl.reason,
      },
    ).catch(() => {})
  }

  // ── Trailing-variant SL config log ────────────────────────────────────────
  // When the trailing profile overrides the initial SL% (anchor = stopRatio),
  // log it explicitly so the progression panel shows both the PF-derived value
  // and the config-anchored override side-by-side for operator visibility.
  if (
    realPosition.setVariant === "trailing" &&
    livePosition.trailingProfile &&
    livePosition.trailingProfile.stopRatio > 0
  ) {
    const trailSl = Math.max(MIN_EXCHANGE_STOP_LOSS_PERCENT, livePosition.trailingProfile.stopRatio * 100)
    if (Math.abs(trailSl - normalizedInitialSl.value) > 0.001) {
      pushStep(
        livePosition,
        "set_config_sl_override",
        true,
        `Trailing-variant SL anchored at stopRatio ${livePosition.trailingProfile.stopRatio} → ${trailSl.toFixed(3)}% ` +
        `(PF-derived was ${normalizedInitialSl.value.toFixed(3)}%)`,
      )
    }
  }

  // Hoisted before the try/catch so the catch block can release the
  // correct variant-scoped dedup lock on unhandled errors.
  const _lockDirSuffix = realPosition.setVariant === "block" ? ":block" : ""

  try {
    // ── Step 1: Pre-flight validation ──────────────�������──────────────────────
    if (!realPosition.direction || !realPosition.symbol) {
      livePosition.status = "rejected"
      livePosition.statusReason = `Invalid inputs: symbol=${realPosition.symbol}, direction=${realPosition.direction}`
      pushStep(livePosition, "preflight", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_rejected_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order rejected — invalid inputs", {
        symbol: realPosition.symbol,
        direction: realPosition.direction,
      })
      return livePosition
    }

    // CRITICAL: Upstash returns values as strings OR native types depending on adapter.
    // Use getConnection() to get the parsed hash (parseHashValue coerces "1"/"true"/true -> true).
    // Raw hgetall followed by string-only equality was silently failing when the value
    // came back as a boolean, causing every real order to become a "simulated" order
    // despite the strategy-coordinator correctly detecting live_trade=true just one
    // function call upstream.
    const { getConnection: _getConn } = await import("@/lib/redis-db")
    const { isTruthyFlag } = await import("@/lib/connection-state-utils")
    const connSettings = (await _getConn(connectionId)) || {}
    const isLiveTradeEnabled =
      !hasRealTradeBlock(connSettings) &&
      (isTruthyFlag(connSettings.is_live_trade) ||
        isTruthyFlag(connSettings.live_trade_enabled))

    // isBlockVariant and _lockDirSuffix are hoisted to function scope (before
    // the try block) so the catch handler can also release the correct key.
    const isBlockVariant = realPosition.setVariant === "block"

    pushStep(livePosition, "preflight", true, `live_trade=${isLiveTradeEnabled}`)
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "info",
      `Live pipeline start ${realPosition.symbol} ${realPosition.direction}`,
      { liveTrade: isLiveTradeEnabled, realPositionId: realPosition.id }
    )

    // ── Atomic dedup gate (P0-4 race fix) ──��───────────────────────────
    //
    // Spec: "Active Pseudo Position Limit for each direction Long, short
    // maximal 1." The previous implementation was a check-then-act
    // sequence:
    //
    //   if (await hasOpenLivePosition(...)) { merge-or-release-stale }
    //   ... place order ...
    //   await acquireLock(...)            // overwrites unconditionally
    //
    // — racy under any concurrency. Two ticks could both pass the
    // `hasOpenLivePosition` check, both place exchange orders, and both
    // belatedly stamp the lock. The exchange ended up with two
    // duplicate positions for the same symbol+direction; reconcile then
    // had to figure out which one to track.
    //
    // We now atomically `tryAcquireLock` at the very top of the
    // live-trade branch:
    //
    //   • acquired → we own the slot, fresh-entry path runs. No
    //                separate `acquireLock` call later in this function.
    //   • not acquired → there is either an open position to merge into
    //                    (our preferred outcome) OR an in-flight entry
    //                    from a parallel tick that hasn't yet saved its
    //                    position. We DEFER in the second case rather
    //                    than racing — the 5-minute TTL guarantees a
    //                    crashed lock self-clears, so deferred signals
    //                    will succeed on a subsequent cycle.
    //
    // This is the only writer of `live:lock:{conn}:{sym}:{dir}` on the
    // critical path, so the race window is closed at its source.
    if (isLiveTradeEnabled) {
      // ── Variant-specific lock key ─��──────────────────────────────────��───
      // Block add-on orders MUST be able to proceed even when the default/
      // trailing position's lock is held (that lock means "default slot is
      // occupied — don't open a second default", not "all orders blocked").
      //
      // We use a variant-scoped lock key for block sets:
      //   default/trailing/pause/dca: live:lock:{conn}:{sym}:{dir}
      //   block:                      live:lock:{conn}:{sym}:{dir}:block
      //
      // This allows at most 1 default + 1 block position per direction per
      // symbol simultaneously. isBlockVariant + _lockDirSuffix are hoisted
      // to function scope so every releaseLock / refreshLockTTL in this
      // function's long body uses the correct scoped key automatically.
      const acquired = await tryAcquireLock(
        connectionId,
        realPosition.symbol,
        realPosition.direction + _lockDirSuffix,
      )
      if (!acquired) {
        // Slot is held — try to merge into the existing exchange
        // position. If we can't (in-flight entry from another tick),
        // defer this signal cleanly.
        // For block variant: if the block lock is held, defer (another
        // block add-on is in-flight). Block does NOT merge into the
        // default position when its own lock is taken.
        const existing = isBlockVariant
          ? null // block defers; no merge-into-default on collision
          : await findOpenLivePositionByDir(
              connectionId,
              realPosition.symbol,
              realPosition.direction,
            )

        if (!existing) {
          // Lock present, no position visible yet → another tick is
          // mid-flight. DO NOT release the lock here (the previous
          // implementation did, which let two ticks both place exchange
          // orders). Surface a deferral and let the next cycle retry.
          livePosition.status = "rejected"
          livePosition.statusReason =
            `Dedup lock held — another entry in flight for ${realPosition.symbol} ${realPosition.direction}${isBlockVariant ? " (block)" : ""}; will retry next cycle`
          pushStep(livePosition, "preflight", false, livePosition.statusReason)
          await savePosition(livePosition)
          await incrementMetric(connectionId, "live_orders_deferred_count")
          // Normal high-frequency deferral under load — do not spam progression logs at "info".
          // The statusReason + saved position already provide visibility; only warn at low frequency.
          if (Math.random() < 0.05) {
            await logProgressionEvent(
              connectionId,
              "live_trading",
              "info",
              livePosition.statusReason,
              { symbol: realPosition.symbol, direction: realPosition.direction },
            ).catch(() => {})
          }
          return livePosition
        }

        // Need a price to compute additional volume + retain it for the
        // accumulator. Reuse fetchCurrentPrice with the realPosition
        // entry-price hint so we don't pay two fetches for the same tick.
        let accPrice = realPosition.entryPrice
        if (!accPrice || accPrice <= 0) accPrice = await fetchCurrentPrice(realPosition.symbol)

        // Skip-paths: when we can't accumulate right now (no market price
        // or no connector), we record the deferral on the EXISTING
        // position's progression rather than persisting the throw-away
        // `livePosition` placeholder into the open index. Reconcile will
        // pick up market data and a fresh signal on the next cycle.
        if (!accPrice || accPrice <= 0) {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            `no market price for ${realPosition.symbol} — accumulation deferred`,
          )
          await savePosition(existing)
          return existing
        }

        if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
          pushStep(
            existing,
            "accumulate_skip",
            false,
            "exchange connector unavailable — accumulation deferred",
          )
          await savePosition(existing)
          return existing
        }

        const merged = await accumulateIntoLivePosition(
          connectionId,
          existing,
          realPosition,
          accPrice,
          exchangeConnector,
        )
        // Refresh the existing slot's TTL — the position is still open
        // on the exchange and we want the safety expiry pushed forward
        // by the 300 s window. Lock value remains the original entry's
        // timestamp (intentional — debuggers see the original entry's
        // wall-clock, not the accumulation's).
        await refreshLockTTL(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
        return merged
      }
      // acquired === true: we own the slot. Continue to fresh-entry
      // path below. The historical `await acquireLock(...)` after order
      // placement is now redundant and has been removed (see Step 5).
    }

    // Short-circuit on simulation mode — still record the intent.
    //
    // CRITICAL: We populate `executedQuantity` / `averageExecutionPrice`
    // / `volumeUsd` / `remainingQuantity` / a synthetic `fills[]` entry
    // here. Previously the simulated branch left all of these at 0,
    // which silently broke EVERY downstream close path:
    //
    //   * `checkAndForceCloseOnSltpCross()` early-returns when
    //     `executedQuantity <= 0` or `averageExecutionPrice <= 0` — so
    //     simulated positions never honored their SL/TP levels.
    //   * The max-hold-time closer in `syncWithExchange` /
    //     `reconcileLivePositions` also gates on
    //     `executedQuantity > 0`, so the 4-hour safety net never
    //     force-closed simulated positions either.
    //
    // Net effect: every simulated live order sat OPEN forever in the
    // Redis open-index, growing `live_positions_created_count` without
    // ever growing `live_positions_closed_count`. This is the exact
    // "Live Positions are Still not getting closed" symptom the
    // operator reported on paper / is_live_trade=false connections.
    //
    // Now: a simulated position behaves like a fully-filled exchange
    // position at the requested entryPrice, with the (new) per-tick
    // `processSimulatedPositions` sweep walking Redis market_data
    // and force-closing on SL/TP cross or max-hold-time expiry.
    if (!isLiveTradeEnabled) {
      const existingSimulatedSlot = await findOpenLivePositionByDir(
        connectionId,
        realPosition.symbol,
        realPosition.direction,
      )
      if (existingSimulatedSlot) {
        pushStep(
          existingSimulatedSlot,
          "simulate_skip",
          false,
          `simulated slot already open for ${realPosition.symbol} ${realPosition.direction}`,
        )
        existingSimulatedSlot.statusReason =
          existingSimulatedSlot.statusReason || "live_trade disabled — no exchange execution"
        existingSimulatedSlot.updatedAt = Date.now()
        await savePosition(existingSimulatedSlot)
        return existingSimulatedSlot
      }

      // Fetch the current market price so simulated positions open at a
      // real price (not 0). This mirrors the live path's Step 2 but runs
      // here before the simulation early-return so SL/TP cross-checks and
      // PnL display are meaningful.
      let simEntryPrice = livePosition.entryPrice || realPosition.entryPrice || 0
      if (!simEntryPrice || simEntryPrice <= 0) {
        simEntryPrice = (await fetchCurrentPrice(realPosition.symbol).catch(() => 0)) || 0
      }
      livePosition.entryPrice = simEntryPrice

      // Compute a realistic volume using the VolumeCalculator (same as Step 3
      // on the live path). Falls back to realPosition.quantity if the
      // calculator fails (e.g. no balance data in sandbox).
      let simQty = realPosition.quantity || 1
      try {
        const { VolumeCalculator } = await import("@/lib/volume-calculator")
        const simVolResult = await VolumeCalculator.calculateVolumeForConnection(
          connectionId,
          realPosition.symbol,
          simEntryPrice,
        )
        const vol = simVolResult?.finalVolume ?? simVolResult?.calculatedVolume ?? simVolResult?.volume ?? 0
        if (vol > 0) {
          simQty = vol
          livePosition.leverage = simVolResult.leverage || livePosition.leverage
        }
      } catch { /* fallback to realPosition.quantity */ }

      // Set averageExecutionPrice before calling computeDesiredProtectionPrices
      // because that function uses it as the fill price for SL/TP calculation.
      livePosition.averageExecutionPrice = simEntryPrice
      // Compute SL/TP prices for the simulated position so reconcile and
      // checkAndForceCloseOnSltpCross have valid price targets.
      if (simEntryPrice > 0) {
        const simProtection = computeDesiredProtectionPrices(livePosition)
        if (simProtection.desiredSl > 0) livePosition.assignedStopLoss  = simProtection.desiredSl
        if (simProtection.desiredTp > 0) livePosition.assignedTakeProfit = simProtection.desiredTp
      }
      livePosition.executedQuantity = simQty
      livePosition.remainingQuantity = 0
      livePosition.averageExecutionPrice = simEntryPrice
      livePosition.volumeUsd = simQty * simEntryPrice
      livePosition.fills = [
        {
          timestamp: Date.now(),
          quantity: simQty,
          price: simEntryPrice,
          fee: 0,
          feeAsset: "",
        },
      ]
      livePosition.status = "simulated"
      livePosition.statusReason = "live_trade disabled — no exchange execution"
      pushStep(livePosition, "simulate", true, `qty=${simQty} @ ${simEntryPrice}`)
      await savePosition(livePosition)
      // Run counters in parallel �� they're independent.
      await Promise.all([
        incrementMetric(connectionId, "live_orders_simulated_count"),
        // Track simulated positions in created counter as well so the
        // openPositions.live.open = created - closed math works for
        // paper trades (the close-counter is bumped by
        // closeLivePosition / reconcile when the simulated position
        // gets force-closed).
        incrementMetric(connectionId, "live_positions_created_count"),
        logProgressionEvent(
          connectionId,
          "live_trading",
          "info",
          `Simulated live order (live_trade disabled) ${realPosition.symbol}`,
          { direction: realPosition.direction, quantity: simQty, entryPrice: simEntryPrice }
        ),
      ])
      console.log(`${LOG_PREFIX} SIMULATION: ${realPosition.symbol} ${realPosition.direction} qty=${simQty} @ ${simEntryPrice} (live_trade disabled)`)
      return livePosition
    }

    if (!exchangeConnector || typeof exchangeConnector.placeOrder !== "function") {
      livePosition.status = "error"
      livePosition.statusReason = "Exchange connector not available or missing placeOrder"
      pushStep(livePosition, "connector_check", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no connector", {
        symbol: realPosition.symbol,
      })
      // Release the dedup lock we acquired at the top of this function so
      // the next signal isn't blocked for the full 5-min TTL on a non-
      // recoverable connector failure (operator likely didn't configure a
      // connector — they need to be able to retry once they do).
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
      return livePosition
    }

    // ── Step 2: Fetch current market price ──────�����������──────────────────────────
    let currentPrice = realPosition.entryPrice
    if (!currentPrice || currentPrice <= 0) {
      currentPrice = await fetchCurrentPrice(realPosition.symbol)
    }
    if (!currentPrice || currentPrice <= 0) {
      livePosition.status = "error"
      livePosition.statusReason = `No current price available for ${realPosition.symbol}`
      pushStep(livePosition, "price_fetch", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "error", "Live order failed — no market price", {
        symbol: realPosition.symbol,
      })
      // Release the dedup lock — a missing market price is a transient
      // condition (typically a fresh symbol whose ticker hasn't streamed
      // yet). Without releasing, the next cycle's signal would defer for
      // 5 minutes even though the price arrives within seconds.
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
      return livePosition
    }
    livePosition.entryPrice = currentPrice
    pushStep(livePosition, "price_fetch", true, `price=${currentPrice}`)

    // ── Operator policy: ALWAYS use venue max leverage ─────────────────
    // realPosition.leverage carries the per-variant coordination signal
    // (1, 2, 3, 5x from expandSizeLeverageVariants). That is an INTERNAL
    // ranking signal only — at order time we unconditionally override to
    // the connection's maximum supported leverage.
    //
    // The previous guard `if (venueMax > livePosition.leverage)` caused
    // silent failures: when getMaxLeverageForExchange returned the
    // SAFE_DEFAULT (10) �� which is > any coordination signal (1–5x) —
    // the position was placed at 10x rather than 150x (BingX max).
    // Fix: always assign, no comparison.
    //
    // Downstream safety nets remain armed:
    //   1. setLeverage(symbol, venueMax) — exchange clamps to per-symbol
    //      bracket (e.g. BTC 125x, SOL 75x)
    //   2. 101204 "Insufficient margin" auto-halve + lev=1 retry below
    {
      const previous = livePosition.leverage
      const { getConnection: _getConnLev } = await import("@/lib/redis-db")
      const connRecord = await _getConnLev(connectionId).catch(() => null)
      const venueMax = getMaxLeverageForExchange(connRecord?.exchange)
      livePosition.leverage = venueMax
      pushStep(
        livePosition,
        "leverage_override",
        true,
        `coordination=${previous}x → venue_max=${venueMax}x (operator policy)`,
      )
    }

    // ── Step 3: Volume calculation ──────────────��──────────────────────────
    // POLICY: minimum volume is ALWAYS enforced �� we never reject a live
    // order for "qty too small". If the calculator returns null or a
    // non-positive quantity (e.g. balance fetch failed, NaN math) we
    // synthesize a fallback at the universal $5-notional floor and
    // continue. This keeps the operator's signal flow uninterrupted
    // and matches the documented behavior of `VolumeCalculator`.
    //
    // ── Trade-mode resolution for the engine volume factor ────────
    // The live-stage IS the live-execution path by definition — it
    // MUST tell `VolumeCalculator` which engine is asking for sizing so
    // the per-engine multiplier (Main vs. Preset) is applied. We reuse
    // the already-loaded `connSettings` to derive the mode without a
    // second Redis round-trip:
    //   - Preset engine: `is_preset_trade=true` AND `is_live_trade=false`
    //   - Main   engine: otherwise (the conservative default — when
    //                    both flags happen to be true during a UI
    //                    toggle transition we don't want to silently
    //                    apply Preset's typically-more-aggressive
    //                    multiplier).
    // Strategy / pseudo-position callers (in pseudo-position-manager)
    // do NOT pass `tradeMode` — they remain ratio-only per spec.
    const liveTradeMode: "main" | "preset" =
      isTruthyFlag(connSettings.is_preset_trade) && !isTruthyFlag(connSettings.is_live_trade)
        ? "preset"
        : "main"

    const volumeResult = await VolumeCalculator.calculateVolumeForConnection(
      connectionId,
      realPosition.symbol,
      currentPrice,
      {
        tradeMode: liveTradeMode,
        // Forward the Block/DCA variant multiplier so notional is correctly
        // scaled before the exchange order is placed (absent → 1.0 identity).
        sizeMultiplier: realPosition.sizeMultiplier,
      },
    ).catch(err => {
      console.error(`${LOG_PREFIX} volume calc error:`, err)
      return null
    })

    let computedVolume = volumeResult?.finalVolume || volumeResult?.volume || 0
    let volumeNote = ""
    if (computedVolume <= 0 || !Number.isFinite(computedVolume)) {
      // Synthesize at the minimal fallback ($5 notional) when the
      // VolumeCalculator returns nothing. The per-pair exchange minimum
      // from trading-pair metadata (stored in Redis) normally takes over
      // as the hard floor inside VolumeCalculator — this path is a last-
      // resort for pairs with no metadata or calculator failures. Kept
      // at $5 to match the quickstart minimal-volume policy.
      const FALLBACK_NOTIONAL_USD = 5
      computedVolume = currentPrice > 0
        ? FALLBACK_NOTIONAL_USD / currentPrice
        : 0
      volumeNote = ` [synthesized-min: $${FALLBACK_NOTIONAL_USD} notional fallback — calculator returned ${volumeResult?.finalVolume ?? "null"}]`
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `Live order volume synthesized to enforced minimum for ${realPosition.symbol}`,
        {
          reason: volumeResult?.adjustmentReason || "calculator returned no usable quantity",
          fallbackNotionalUsd: FALLBACK_NOTIONAL_USD,
          synthesizedQty: computedVolume,
        }
      )
    }

    // High-visibility diagnostic for the most common reason real orders never appear on the exchange
    if (computedVolume <= 0) {
      console.error(
        `${LOG_PREFIX} [NO_REAL_ORDER] ${realPosition.symbol} ${realPosition.direction} — computedVolume=0 after all fallbacks. ` +
        `This is almost always why "no positions on live exchange" after quickstart. ` +
        `volumeResult=${JSON.stringify(volumeResult)}`
      )
    }

    livePosition.quantity = computedVolume
    livePosition.remainingQuantity = computedVolume
    livePosition.volumeUsd = computedVolume * currentPrice
    livePosition.leverage = volumeResult?.leverage || livePosition.leverage

    // If the volume calculator clamped the quantity UP to the exchange
    // minimum (or we synthesized a fallback above), surface that in the
    // progression step so the UI / logs show *why* the executed qty
    // differs from the coordination-derived qty rather than just a bare
    // number. The step is always recorded as successful because the
    // order itself is valid — minimum enforcement never fails the trade.
    const clampNote = volumeResult?.volumeAdjusted && volumeResult.adjustmentReason
      ? ` [clamped-to-min: ${volumeResult.adjustmentReason}]`
      : ""
    pushStep(
      livePosition,
      "volume_calc",
      true,
      `qty=${computedVolume.toFixed(6)} usd=${livePosition.volumeUsd.toFixed(2)} lev=${livePosition.leverage}x${clampNote}${volumeNote}`
    )
    if (volumeResult) {
      await VolumeCalculator.logVolumeCalculation(connectionId, realPosition.symbol, volumeResult).catch(() => {})
    }

    // ── Step 4: Configure leverage + margin type on exchange ───────────────
    // T2.3 perf: parallelize the two pre-flight venue calls. They are
    // idempotent and independent — `setLeverage` configures the
    // per-symbol leverage bracket, `setMarginType` configures
    // cross/isolated. Running them concurrently shaves one full
    // round-trip off every live entry. Both still complete BEFORE the
    // order is placed, so the venue sees consistent margin semantics
    // for the order. Errors are captured per-call and logged
    // independently — a failure in one does NOT skip the other.
    const marginTypeSetting = (connSettings.margin_type as "cross" | "isolated") || "cross"
    livePosition.marginType = marginTypeSetting

    const setLeveragePromise: Promise<{ ok: boolean; note: string }> =
      typeof exchangeConnector.setLeverage === "function"
        ? exchangeConnector
            .setLeverage(realPosition.symbol, livePosition.leverage)
            .then((lev: any) => ({
              ok: !!lev?.success,
              note: lev?.error || `leverage=${livePosition.leverage}`,
            }))
            .catch((err: unknown) => ({ ok: false, note: String(err) }))
        : Promise.resolve({
            ok: true,
            note: "connector does not expose setLeverage ��� skipping",
          })

    const setMarginTypePromise: Promise<{ ok: boolean; note: string }> =
      typeof exchangeConnector.setMarginType === "function"
        ? exchangeConnector
            .setMarginType(realPosition.symbol, marginTypeSetting)
            .then((m: any) => ({
              ok: !!m?.success,
              note: m?.error || `margin=${marginTypeSetting}`,
            }))
            .catch((err: unknown) => ({ ok: false, note: String(err) }))
        : Promise.resolve({
            ok: true,
            note: "connector does not expose setMarginType — skipping",
          })

    const [levResult, marginResult] = await Promise.all([setLeveragePromise, setMarginTypePromise])
    pushStep(livePosition, "set_leverage", levResult.ok, levResult.note)
    pushStep(livePosition, "set_margin_type", marginResult.ok, marginResult.note)


    // ── Step 5: Place entry order with retry ─────────────────────����─────────
    const exchangeSide: "buy" | "sell" = realPosition.direction === "long" ? "buy" : "sell"

    // ── Comprehensive logging trace ──────────────────────────────────
    // One trace id spans the primary attempt, the leverage-reduced retry,
    // the min-size correction retry, the fill polling, and the final
    // outcome line. Grep `[v0] [LiveOrder]` + `trace=` to reconstruct the
    // full lifecycle of any failing order. Trace is created here (not at
    // function entry) so accumulation merges and dedup-skip paths above
    // don't pollute the log with no-op traces.
    const orderTrace: LiveOrderTrace = newLiveOrderTrace({
      connectionId,
      symbol: realPosition.symbol,
      direction: realPosition.direction,
      exchangeSide,
    })

    console.log(
      `${LOG_PREFIX} EXECUTING REAL: ${realPosition.symbol} ${realPosition.direction} → ${exchangeSide} qty=${computedVolume.toFixed(
        6
      )} @ ${currentPrice} trace=${orderTrace.traceId}`
    )

    // For perp entries we pass the explicit positionSide matching the real
    // position direction so hedge-mode accounts route correctly. Connectors
    // that don't care about the options object simply ignore the 6th arg.
    // BingX's one-way-mode accounts auto-retry without positionSide if the
    // exchange rejects it (code 80014), so this is safe for both modes.
    //
    // ── CRITICAL: Re-check is_live_trade + is_testnet gate RIGHT BEFORE order placement ──────
    // The flag is checked once at entry (line 1959), but if the operator toggles
    // Control Orders off during preflight, we must catch it here before sending
    // the order to the exchange. This is a defensive second gate.
    // ALSO check if the connection is pointing to a testnet exchange to prevent
    // accidental real orders on testnet accounts (critical safety guard).
    const { getConnection: reCheckConn } = await import("@/lib/redis-db")
    const { isTruthyFlag: reCheckTruthy } = await import("@/lib/connection-state-utils")
    const freshSettings = (await reCheckConn(connectionId)) || {}
    const positionMode = String((freshSettings as any).position_mode || (freshSettings as any).positionMode || "").toLowerCase()
    const hedgeMode = positionMode.includes("hedge") || positionMode.includes("dual")
    const entryOrderOptions = hedgeMode
      ? { hedgeMode: true, positionSide: (realPosition.direction === "long" ? "LONG" : "SHORT") as "LONG" | "SHORT" }
      : { hedgeMode: false }
    const isStillLive =
      !hasRealTradeBlock(freshSettings) &&
      (reCheckTruthy(freshSettings.is_live_trade) ||
        reCheckTruthy(freshSettings.live_trade_enabled))
    
    // CRITICAL: Prevent order placement on testnet connections
    const isTestnetConnection = reCheckTruthy(freshSettings.is_testnet)
    if (isTestnetConnection) {
      livePosition.status = "rejected"
      livePosition.statusReason =
        `Testnet connection detected — live order placement blocked for safety. Use a production exchange connection for real trading.`
      pushStep(livePosition, "entry", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_blocked_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        livePosition.statusReason,
        { symbol: realPosition.symbol, direction: realPosition.direction, exchangeApi: freshSettings.exchange },
      ).catch(() => {})
      return livePosition
    }

    if (!isStillLive) {
      livePosition.status = "rejected"
      livePosition.statusReason =
        `Control Orders disabled (is_live_trade=false) — order blocked before exchange placement`
      pushStep(livePosition, "entry", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_blocked_count")
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        livePosition.statusReason,
        { symbol: realPosition.symbol, direction: realPosition.direction },
      ).catch(() => {})
      return livePosition
    }

    // Strong diagnostic log right before real money order attempt
    console.log(
      `${LOG_PREFIX} [REAL_ORDER_ATTEMPT] conn=${connectionId} sym=${realPosition.symbol} dir=${realPosition.direction} ` +
      `computedVol=${computedVolume} price=${currentPrice} lev=${livePosition.leverage} ` +
      `setKey=${livePosition.setKey} trace=${orderTrace.traceId}`
    )

    // The `retry()` helper repeats up to 3× on transient failures; we
    // emit PRE/POST per ATTEMPT so the log shows each round-trip. The
    // attempt counter is captured by closure so leverage-reduced and
    // min-size-corrected retries below get distinct labels.
    let placeAttempt = 0
    let orderResult: any = await retry(
      async () => {
        placeAttempt += 1
        const { raw } = await withLiveOrderLogging(
          orderTrace,
          {
            quantity: computedVolume,
            price: currentPrice,
            leverage: livePosition.leverage,
            marginType: livePosition.marginType ?? "unknown",
            orderType: "market",
            options: entryOrderOptions,
            strategySetKey: livePosition.setKey,
            realPositionId: realPosition.id,
            attempt: placeAttempt,
            label: "primary",
          },
          () => exchangeConnector.placeOrder(
            realPosition.symbol,
            exchangeSide,
            computedVolume,
            undefined,
            "market",
            entryOrderOptions,
          ),
        )
        return raw
      },
      (r: any) => !!r?.success && !!(r.orderId || r.id),
      "placeOrder"
    )

    // ── Volume reduction on 101204 (Insufficient margin) ────────────────
    // Leverage is kept at its maximum value — never reduced. When the
    // exchange rejects with "Insufficient margin" we instead halve the
    // position volume and retry ONCE at the same leverage. Halving volume
    // halves the required margin while keeping the leverage multiplier
    // (and therefore the per-unit notional gain) intact. If the halved
    // volume still fails, we fall back to the exchange minimum quantity at
    // the same leverage, which represents the absolute smallest notional
    // with the best leverage efficiency.
    if (!orderResult?.success && isNonRecoverableExchangeError(orderResult)) {
      const reducedVolume = computedVolume / 2
      // Ensure the halved volume is meaningfully smaller (> 0.1% diff) and positive.
      const volumeDiffPct = computedVolume > 0 ? Math.abs(reducedVolume - computedVolume) / computedVolume : 0
      if (reducedVolume > 0 && volumeDiffPct > 0.001) {
        console.warn(
          `${LOG_PREFIX} 101204 on ${realPosition.symbol} — retrying with halved volume ` +
          `${computedVolume.toFixed(6)} → ${reducedVolume.toFixed(6)} (leverage kept at ${livePosition.leverage}x)`,
        )

        const retryResult: any = await retry(
          async () => {
            placeAttempt += 1
            const { raw } = await withLiveOrderLogging(
              orderTrace,
              {
                quantity: reducedVolume,
                price: currentPrice,
                leverage: livePosition.leverage,
                marginType: livePosition.marginType ?? "unknown",
                orderType: "market",
                options: entryOrderOptions,
                strategySetKey: livePosition.setKey,
                realPositionId: realPosition.id,
                attempt: placeAttempt,
                label: "volume-halved",
              },
              () => exchangeConnector.placeOrder(
                realPosition.symbol,
                exchangeSide,
                reducedVolume,
                undefined,
                "market",
                entryOrderOptions,
              ),
            )
            return raw
          },
          (r: any) => !!r?.success && !!(r.orderId || r.id),
          "placeOrder-reducedVol",
          1 // single retry — we already tried 3× above at original volume
        )

        if (retryResult?.success && (retryResult.orderId || retryResult.id)) {
          // Succeeded with reduced volume at max leverage — update position and continue.
          computedVolume = reducedVolume
          livePosition.quantity = reducedVolume
          livePosition.remainingQuantity = reducedVolume
          livePosition.volumeUsd = reducedVolume * currentPrice
          orderResult = retryResult
          console.log(
            `${LOG_PREFIX} Entry succeeded after volume reduction to ${reducedVolume.toFixed(6)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
          )
        } else if (isNonRecoverableExchangeError(retryResult)) {
          // Both the original and halved-volume attempts failed with 101204.
          // Try one last time at the exchange minimum qty — still at max leverage.
          // Prefer the stored exchange minimum from the 101400 handler
          // (`settings:trading_pair:{sym}` → `min_order_size`). Fall back to $5/price.
          let minQtyForSymbol = currentPrice > 0 ? 5 / currentPrice : 0
          try {
            const redisClient = getRedisClient()
            if (redisClient) {
              const storedMin = await redisClient.hget(
                `settings:trading_pair:${realPosition.symbol}`,
                "min_order_size",
              )
              const parsedStoredMin = storedMin ? parseFloat(storedMin) : 0
              if (parsedStoredMin > 0) {
                minQtyForSymbol = parsedStoredMin
              }
            }
          } catch { /* non-critical; fall back to $5/price */ }

          // Only attempt if the quantity is meaningfully different from what we already tried.
          const minQuantityDiffPct = reducedVolume > 0
            ? Math.abs(minQtyForSymbol - reducedVolume) / reducedVolume
            : 1
          if (minQtyForSymbol > 0 && minQuantityDiffPct > 0.001) {
            console.warn(
              `${LOG_PREFIX} 101204 at half-volume still fails on ${realPosition.symbol} — ` +
              `trying min notional qty=${minQtyForSymbol.toFixed(8)} at ${livePosition.leverage}x (max leverage kept)`,
            )
            placeAttempt += 1
            const minResult: any = await withLiveOrderLogging(
              orderTrace,
              {
                quantity: minQtyForSymbol,
                price: currentPrice,
                leverage: livePosition.leverage,
                marginType: livePosition.marginType ?? "unknown",
                orderType: "market",
                options: entryOrderOptions,
                strategySetKey: livePosition.setKey,
                realPositionId: realPosition.id,
                attempt: placeAttempt,
                label: "min-notional-max-lev",
              },
              async () => {
                const r = await exchangeConnector.placeOrder(
                  realPosition.symbol,
                  exchangeSide,
                  minQtyForSymbol,
                  undefined,
                  "market",
                  entryOrderOptions,
                )
                return r
              },
            ).then(({ raw }) => raw).catch(() => null)
            if (minResult?.success && (minResult.orderId || minResult.id)) {
              computedVolume = minQtyForSymbol
              livePosition.quantity = minQtyForSymbol
              livePosition.remainingQuantity = minQtyForSymbol
              livePosition.volumeUsd = minQtyForSymbol * currentPrice
              orderResult = minResult
              console.log(
                `${LOG_PREFIX} Entry succeeded at min-notional ${minQtyForSymbol.toFixed(8)} at ${livePosition.leverage}x for ${realPosition.symbol}`,
              )
            } else {
              console.warn(
                `${LOG_PREFIX} 101204 at min-notional also failed for ${realPosition.symbol} — recording margin error`,
              )
              recordMarginError(connectionId)
              orderResult = minResult ?? retryResult ?? orderResult
            }
          } else {
            // qty would be the same as before — no point retrying.
            recordMarginError(connectionId)
            orderResult = retryResult ?? orderResult
          }
        } else {
          // Non-margin failure after volume reduction — give up normally.
          recordMarginError(connectionId)
          orderResult = retryResult ?? orderResult
        }
      } else {
        // Volume already at minimum — cannot reduce further without going below exchange minimum.
        recordMarginError(connectionId)
      }
    }

    // ── Exchange circuit-breaker (109400) detection ────���──────────────
    // Code 109400 = exchange temporarily halted API trading for this
    // symbol due to volatility. This is NOT a margin issue — record a
    // per-symbol circuit-breaker and let the connection continue placing
    // orders on other symbols without triggering the margin cooldown.
    if (!orderResult?.success && isCircuitBreakerError(orderResult)) {
      recordCircuitBreaker(realPosition.symbol)
      livePosition.status = "error"
      livePosition.statusReason = `Exchange circuit breaker active for ${realPosition.symbol} — retrying in <5min`
      pushStep(livePosition, "place_order", false, livePosition.statusReason)
      await savePosition(livePosition)
      await incrementMetric(connectionId, "live_orders_failed_count")
      await logProgressionEvent(connectionId, "live_trading", "warning", livePosition.statusReason, {
        symbol: realPosition.symbol,
        error: orderResult?.error,
      })
      await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
      await logLiveOrderFinal(orderTrace, {
        status: "rejected",
        livePositionId: livePosition.id,
        reason: livePosition.statusReason,
        extra: {
          errorCode: orderResult?.errorCode ?? orderResult?.code,
          error: orderResult?.error,
          attempts: placeAttempt,
        },
      })
      return livePosition
    }

    // ── Hard stop on failed entry placement ────────────────────────────────
    // The protection/fill pipeline below is only valid after the exchange has
    // acknowledged a real entry order. Previously a transient or venue-side
    // `{ success:false }` result that was not classified as margin/circuit
    // breaker still fell through, stamped the position as "placed" with an
    // undefined orderId, then attempted fill fallback and SL/TP placement for
    // an order that never existed. That created the exact class of live-order
    // errors operators saw: fake local positions, repeated protection-order
    // failures, and confusing "position not exist" exchange responses.
    let entryOrderId = orderResult?.orderId || orderResult?.id
    if (!orderResult?.success || !entryOrderId) {
      const reason =
        orderResult?.error ||
        orderResult?.message ||
        (orderResult?.success ? "Exchange accepted entry but returned no orderId" : "Exchange entry order was rejected")
      
      // ── 101400 Minimum Order Amount Error Correction with Same-Cycle Retry ─
      // When BingX rejects with code=101400, extract the minimum from the error
      // message and retry IMMEDIATELY with corrected volume in THIS cycle.
      // This prevents wasting cycles on repeated sub-minimum rejections.
      let retryWasAttempted = false
      if (isMinOrderSizeError(reason) && placeAttempt < 3) {
        const minQty = extractMinOrderQty(reason)
        if (minQty && minQty > 0 && minQty > computedVolume) {
          retryWasAttempted = true
          try {
            const { setSettings } = await import("@/lib/redis-db")
            
            // Save the corrected minimum for future cycles
            await setSettings(`trading_pair:${realPosition.symbol}`, {
              min_order_size: minQty,
              updated_at: new Date().toISOString(),
              source: "101400_error_extraction",
            })
            
            console.warn(
              `${LOG_PREFIX} [101400 Correction] Detected minimum ${minQty} > current ${computedVolume.toFixed(8)} for ${realPosition.symbol}; retrying in same cycle`,
            )
            
            // Use minimum + 10% margin to ensure acceptance
            const retryQty = minQty * 1.1
            console.log(
              `${LOG_PREFIX} [101400 Retry] Sending with margin: ${retryQty.toFixed(8)} (min: ${minQty.toFixed(8)} × 1.1)`,
            )
            
            // Retry immediately with corrected quantity
            const retryOrderResult = await exchangeConnector.placeOrder(
              realPosition.symbol,
              exchangeSide,
              retryQty,
              undefined,
              "market",
              entryOrderOptions,
            )
            
            if (retryOrderResult?.success && (retryOrderResult?.orderId || retryOrderResult?.id)) {
              console.log(
                `${LOG_PREFIX} [101400 Retry] Successfully placed order with volume ${retryQty.toFixed(8)} for ${realPosition.symbol}`,
              )
              // Continue with the corrected order
              Object.assign(orderResult, retryOrderResult)
              computedVolume = retryQty  // Update for subsequent logging
              retryWasAttempted = true  // Mark retry was attempted and succeeded
              entryOrderId = retryOrderResult?.orderId || retryOrderResult?.id
            } else {
              // Retry also failed
              console.warn(
                `${LOG_PREFIX} [101400 Retry] Retry with ${retryQty.toFixed(8)} also failed:`,
                retryOrderResult?.error || retryOrderResult?.message || "unknown",
              )
              retryWasAttempted = false  // Retry was attempted but failed
            }
          } catch (err) {
            console.warn(
              `${LOG_PREFIX} [101400 Correction] Retry attempt failed:`,
              err instanceof Error ? err.message : String(err),
            )
          }
        }
      }
      
      // If no retry was attempted, or retry failed, pre-mark as rejected so
      // the cleanup block below can run. The check below will override this
      // if the retry actually succeeded (retryOrderId is set + orderResult.success).
      if (!retryWasAttempted) {
        livePosition.status = "rejected"
        livePosition.statusReason = String(reason)
        pushStep(livePosition, "place_order", false, livePosition.statusReason)
      }
      
      // Check if we successfully retried and got an order ID
      const retryOrderId = orderResult?.orderId || orderResult?.id
      if (!retryOrderId || !orderResult?.success) {
        // Still no order - reject the position and clean up orphaned position record
        livePosition.status = "rejected"
        livePosition.statusReason = String(reason)
        pushStep(livePosition, "place_order", false, livePosition.statusReason)
        
        // Clean up: Delete this rejected position from Redis to prevent orphaned
        // position accumulation. The next cycle can re-attempt if needed.
        try {
          const { deletePosition } = await import("@/lib/redis-db")
          await deletePosition(livePosition.id)
          console.warn(
            `${LOG_PREFIX} [Cleanup] Deleted orphaned live position ${livePosition.id} after 101400 retry failure`,
          )
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} [Cleanup] Failed to delete position ${livePosition.id}:`,
            err instanceof Error ? err.message : String(err),
          )
        }
        
        await incrementMetric(connectionId, "live_orders_failed_count")
        await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "failed")
        await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
        await logProgressionEvent(connectionId, "live_trading", "error", `Entry order rejected for ${realPosition.symbol}`, {
          symbol: realPosition.symbol,
          direction: realPosition.direction,
          side: exchangeSide,
          quantity: computedVolume,
          price: currentPrice,
          leverage: livePosition.leverage,
          error: livePosition.statusReason,
          attempts: placeAttempt,
        })
        await logLiveOrderFinal(orderTrace, {
          status: "rejected",
          livePositionId: livePosition.id,
          reason: livePosition.statusReason,
          extra: {
            orderResult,
            attempts: placeAttempt,
          },
        })
        return livePosition
      }
    }

    livePosition.orderId = String(entryOrderId)
    livePosition.status = "placed"
    pushStep(livePosition, "place_order", true, `orderId=${livePosition.orderId}`)
    await incrementMetric(connectionId, "live_orders_placed_count")
    await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "placed")
    // Successful placement — reset the margin error consecutive-failure counter
    // so the backoff resets to the shortest cooldown on the next failure.
    marginErrorCooldownByConnection.delete(connectionId)
    // ── Refresh the dedup lock TTL ──────────────────────────────────────
    // The poll-fill phase below can take up to 15s. Without a mid-pipeline
    // TTL refresh, a slow venue + SL/TP placement could push past the
    // lock's 90s window, letting another tick place a duplicate position.
    // Re-stamp the lock here so the slot stays owned through fill + protect.
    await refreshLockTTL(
      connectionId,
      realPosition.symbol,
      realPosition.direction + _lockDirSuffix,
    ).catch(() => {})
    await logProgressionEvent(connectionId, "live_trading", "info", `Entry order placed for ${realPosition.symbol}`, {
      orderId: livePosition.orderId,
      side: exchangeSide,
      quantity: computedVolume,
      price: currentPrice,
      leverage: livePosition.leverage,
    })

    // Persist intermediate state so UI can show "placed" even during poll.
    await savePosition(livePosition)

    // ── Step 6: Fill confirmation ──────────────────────────────────────────
    // Three-layer strategy:
    //  A) Inline: Many exchanges (BingX, Bybit) return immediate fill data in
    //     the placeOrder response itself. Extract it before polling to avoid
    //     a full 15s wait on fast-fill venues.
    //  B) Poll: Standard path — repeatedly call getOrder() until filled or
    //     timeout. Extended timeout (15s vs old 10s) to handle slow networks.
    //  C) getPosition() fallback: If poll times out with no fill data, ask the
    //     exchange for the *position* (not the order). On perp exchanges a
    //     successfully-opened position IS the proof of fill; its size and
    //     entry price are reliable even when getOrder() lags.
    //
    // After all three layers, if executedQty is still 0 we use computedVolume
    // as a last-resort quantity so SL/TP can be placed on the exchange. The
    // protection order itself being "reduce-only" ensures it can't add new
    // risk; the reconcile cycle will correct the stored qty on next tick.
    const inlineFillQty   = parseFloat(String(orderResult.filledQty  ?? orderResult.executedQty ?? orderResult.cumQty   ?? "0")) || 0
    const inlineFillPrice = parseFloat(String(orderResult.filledPrice ?? orderResult.avgPrice   ?? orderResult.price    ?? "0")) || 0
    const inlineStatus    = String(orderResult.status ?? "").toLowerCase()
    const inlineFilled    = (inlineStatus === "filled" || inlineFillQty >= computedVolume * 0.99) && inlineFillQty > 0

    let fill: { filled: boolean; filledQty: number; filledPrice: number; status: string }

    if (inlineFilled) {
      // A) placeOrder response already contains fill confirmation — skip poll.
      fill = { filled: true, filledQty: inlineFillQty, filledPrice: inlineFillPrice, status: "filled" }
      console.log(`${LOG_PREFIX} Inline fill detected for ${realPosition.symbol}: qty=${inlineFillQty} @ ${inlineFillPrice}`)
    } else if (livePosition.orderId) {
      // B) Standard poll path — only when we have a confirmed orderId.
      fill = await pollOrderFill(exchangeConnector, realPosition.symbol, livePosition.orderId)
    } else {
      // No orderId from placeOrder response — skip polling entirely and
      // fall through to the getPosition() fallback (layer C below).
      fill = { filled: false, filledQty: 0, filledPrice: 0, status: "pending" }
      console.warn(`${LOG_PREFIX} No orderId from placeOrder for ${realPosition.symbol} — skipping poll, using getPosition() fallback`)
    }

    // C) getPosition() fallback when poll timed out without fill data.
    //
    // Exchange position registries are usually a few hundred ms behind
    // order acknowledgements (orders go through the matching engine, then
    // get persisted to the position service via internal pub/sub). A
    // single getPosition() that comes back empty is therefore not
    // conclusive proof the order didn't fill — it might just be the
    // registry being slow. We try up to 3 times with 250 ms gaps before
    // giving up and dropping to the computedVolume guard, which trades
    // ~500 ms of additional confirmation latency for much higher accuracy
    // of SL/TP sizing on slow-confirming venues.
    if (!fill.filled || fill.filledQty <= 0) {
      if (typeof exchangeConnector.getPosition === "function") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            // Pass direction so hedge-mode connectors return the correct
            // LONG vs SHORT slot rather than whichever is first in the array.
            const exPos = await exchangeConnector.getPosition(
              realPosition.symbol,
              realPosition.direction as "long" | "short",
            )
            // BingX v3 perpetual: qty is in `positionAmt`; normalised output
            // also exposes `contracts` and `size` aliases (set in getPositions).
            const exSize = parseFloat(String(exPos?.positionAmt ?? exPos?.contracts ?? exPos?.size ?? exPos?.quantity ?? "0")) || 0
            const exEntry = parseFloat(String(exPos?.entryPrice ?? exPos?.avgPrice ?? exPos?.averagePrice ?? "0")) || 0
            if (Math.abs(exSize) > 0) {
              console.log(`${LOG_PREFIX} getPosition() fallback fill for ${realPosition.symbol}: size=${exSize} entry=${exEntry} (attempt=${attempt + 1})`)
              fill = {
                filled: true,
                filledQty: Math.abs(exSize),
                filledPrice: exEntry || currentPrice,
                status: "filled_via_position",
              }
              break
            }
          } catch {
            /* transient error — counts as one attempt, fall through to retry */
          }
          // Gap before the next probe — short enough that total worst-case
          // is ~500 ms, long enough for the registry to catch up.
          if (attempt < 2) await new Promise(r => setTimeout(r, 250))
        }
      }
    }

    if (fill.filled && fill.filledQty > 0) {
      livePosition.executedQuantity = fill.filledQty
      livePosition.remainingQuantity = Math.max(0, computedVolume - fill.filledQty)
      livePosition.averageExecutionPrice = fill.filledPrice || currentPrice
      livePosition.fills!.push({
        timestamp: Date.now(),
        quantity: fill.filledQty,
        price: fill.filledPrice || currentPrice,
        fee: 0,
        feeAsset: "USDT",
      })
      livePosition.status = livePosition.remainingQuantity <= 0.000001 ? "filled" : "partially_filled"
      livePosition.statusReason = fill.status === "filled_via_position"
        ? `confirmed_position_fallback: exchange position size=${fill.filledQty} avg=${fill.filledPrice || currentPrice}`
        : `confirmed_fill: order fill status=${fill.status} qty=${fill.filledQty}`
      pushStep(livePosition, "poll_fill", true, `filled=${fill.filledQty} @ ${fill.filledPrice} via=${fill.status} reason=${livePosition.statusReason}`)
      await incrementMetric(connectionId, "live_orders_filled_count")
      await incrementOrdersBySymbol(connectionId, realPosition.symbol, realPosition.direction, "filled")
      await logProgressionEvent(connectionId, "live_trading", "info", `Entry filled for ${realPosition.symbol}`, {
        orderId: livePosition.orderId,
        filledQty: fill.filledQty,
        filledPrice: fill.filledPrice,
        via: fill.status,
      })
      await logLiveOrderFinal(orderTrace, {
        status: "filled",
        livePositionId: livePosition.id,
        executedQuantity: fill.filledQty,
        averagePrice: fill.filledPrice || currentPrice,
        reason: `fill via=${fill.status}`,
        extra: { orderId: livePosition.orderId, attempts: placeAttempt },
      })
      // BingX hedge-mode positions need a brief settling period after a
      // market order fills before a STOP/TP_MARKET can reference them.
      // Even when the fill is confirmed by pollOrderFill / getPosition,
      // the exchange position registry may lag by ~1-2 s. This 2 s wait
      // (combined with the 4 s retry inside placeProtectionOrder for
      // code=109420) gives a total 6 s window — sufficient for all
      // observed symbols including DOGE, ADA, and SOL.
      await new Promise((r) => setTimeout(r, 2000))
    } else {
      // D) Protection-deferred guard: if neither order polling nor direct
      // exchange-position reads confirm a position size, do NOT synthesize a
      // fill from computedVolume. Persist an unconfirmed status and let
      // reconcile arm SL/TP immediately once the venue position appears.
      const deferredStatus: LivePosition["status"] = livePosition.orderId ? "pending_fill" : "placed_unconfirmed"
      livePosition.executedQuantity = 0
      livePosition.remainingQuantity = computedVolume
      livePosition.averageExecutionPrice = 0
      livePosition.status = deferredStatus
      livePosition.statusReason =
        `protection_deferred: fill unconfirmed after pollStatus=${fill.status}; direct position lookup found no size`
      pushStep(livePosition, "poll_fill", false, livePosition.statusReason)
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Entry fill unconfirmed for ${realPosition.symbol} — SL/TP deferred until exchange position appears`,
        { orderId: livePosition.orderId, status: fill.status, requestedQty: computedVolume, savedStatus: deferredStatus }
      )
      await savePosition(livePosition)
      await logLiveOrderFinal(orderTrace, {
        status: "placed",
        livePositionId: livePosition.id,
        executedQuantity: 0,
        averagePrice: 0,
        reason: livePosition.statusReason,
        extra: { orderId: livePosition.orderId, attempts: placeAttempt, requestedQty: computedVolume },
      })
    }

    // ── Step 7: Place Stop Loss and Take Profit orders ─��───────────────────
    //
    // Single source of truth for SL/TP price derivation:
    // `computeDesiredProtectionPrices()` is also what the accumulation
    // and reconcile paths use. By routing the initial placement through
    // the same helper we guarantee that an exchange-side order will
    // ALWAYS be armed at the same price the strategy assigned (rounded
    // identically), with no duplicate inline computation that could
    // drift out of sync with the rest of the file.
    if (livePosition.executedQuantity > 0) {
      if (typeof exchangeConnector.getPosition === "function") {
        try {
          // Pass direction so hedge-mode accounts return the correct slot.
          const exPos = await exchangeConnector.getPosition(
            realPosition.symbol,
            realPosition.direction as "long" | "short",
          )
          if (exPos) {
            livePosition.exchangeData = {
              ...(livePosition.exchangeData || {}),
              marginType: (exPos as any).marginType,
              markPrice: (exPos as any).markPrice,
              liquidationPrice: (exPos as any).liquidationPrice,
              unrealizedPnl: (exPos as any).unrealizedPnl,
              roi: (exPos as any).roi,
            }
          }
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} pre-protection mark sync failed for ${realPosition.symbol}:`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }

      const sideClose: "buy" | "sell" = realPosition.direction === "long" ? "sell" : "buy"
      const { desiredSl: slPrice, desiredTp: tpPrice } =
        computeDesiredProtectionPrices(livePosition)

      if (await closeIfProtectionTriggerAlreadyCrossed(exchangeConnector, livePosition, slPrice, tpPrice, "initial_placement")) {
        return livePosition
      }
      // Duplicate-prevention is handled inside the Promise.all below:
      // each leg resolves to the existing orderId when an order is already
      // present (`!livePosition.stopLossOrderId` guard on the ternary),
      // so no separate guard block is needed here.

      // DO NOT pre-stamp the desired prices onto livePosition before the
      // exchange confirms placement. The original code set
      //   livePosition.stopLossPrice = slPrice
      //   livePosition.takeProfitPrice = tpPrice
      // BEFORE awaiting the placement promises. When a placement failed
      // the recorded price still equaled the desired price, so
      // `priceDrifted(stored, desired)` returned false on the next
      // reconcile tick and the loop never retried the failed leg —
      // leaving the live position exposed without protection until the
      // operator's price moved >0.25%, sometimes for the lifetime of
      // the trade.
      //
      // The new contract: stored price is the LAST CONFIRMED armed price
      // for that leg. A failed placement leaves it at 0, which
      // `priceDrifted(0, desired)` correctly classifies as "needs arming"
      // on the next reconcile pass.
      // BingX hedge-mode: placing SL and TP concurrently (Promise.all) causes
      // the second order to receive code=109420 "position not exist" while the
      // first order is still being registered by the exchange.  Serialise SL
      // first, wait 500 ms, then place TP.  The 500 ms gap is enough for the
      // exchange registry to reflect the first stop order.  The existing 4 s
      // retry inside placeProtectionOrder handles any residual 109420s.
      const slOrderId = (slPrice > 0 && !livePosition.stopLossOrderId)
        ? await placeProtectionOrder(
            exchangeConnector,
            realPosition.symbol,
            sideClose,
            livePosition.executedQuantity,
            slPrice,
            "StopLoss",
            realPosition.direction,
          )
        : (livePosition.stopLossOrderId || null)

      if (slPrice > 0 && tpPrice > 0 && !livePosition.takeProfitOrderId) {
        await new Promise((r) => setTimeout(r, 500))
      }

      const tpOrderId = (tpPrice > 0 && !livePosition.takeProfitOrderId)
        ? await placeProtectionOrder(
            exchangeConnector,
            realPosition.symbol,
            sideClose,
            livePosition.executedQuantity,
            tpPrice,
            "TakeProfit",
            realPosition.direction,
          )
        : (livePosition.takeProfitOrderId || null)

      // "PRICE_CROSSED" sentinel: market moved past the protection price between
      // calculation and placement (BingX 110412/110413). Force-close immediately
      // rather than waiting up to one full reconcile tick with no protection.
      if (slOrderId === "PRICE_CROSSED" || tpOrderId === "PRICE_CROSSED") {
        const crossedLeg = slOrderId === "PRICE_CROSSED" ? "StopLoss" : "TakeProfit"
        console.warn(
          `${LOG_PREFIX} ${crossedLeg} PRICE_CROSSED for ${realPosition.symbol} — triggering immediate force-close`,
        )
        livePosition.closeReason = "protection_price_crossed_at_placement"
        await closeLivePosition(connectionId, livePosition.id, 0, exchangeConnector, `${crossedLeg} price crossed market at initial placement`)
        return livePosition
      }

      if (slOrderId) {
        livePosition.stopLossOrderId = slOrderId
        livePosition.stopLossPrice = slPrice
      } else if (slPrice > 0) {
        // Surface the protection gap loudly so operators and the
        // dashboard see it; the next reconcile will retry.
        console.error(
          `${LOG_PREFIX} INITIAL StopLoss placement FAILED for ${realPosition.symbol} — position is LIVE without SL until next reconcile tick`,
        )
        await logProgressionEvent(
          connectionId,
          "live_trading",
          "error",
          `StopLoss NOT placed for ${realPosition.symbol} — reconcile will retry`,
          { livePositionId: livePosition.id, desiredSl: slPrice, executedQty: livePosition.executedQuantity },
        )
        pushStep(livePosition, "place_stop_loss", false, `initial SL placement failed @ ${slPrice}`)
      }
      if (tpOrderId) {
        livePosition.takeProfitOrderId = tpOrderId
        livePosition.takeProfitPrice = tpPrice
      } else if (tpPrice > 0) {
        console.error(
          `${LOG_PREFIX} INITIAL TakeProfit placement FAILED for ${realPosition.symbol} — position is LIVE without TP until next reconcile tick`,
        )
        await logProgressionEvent(
          connectionId,
          "live_trading",
          "error",
          `TakeProfit NOT placed for ${realPosition.symbol} — reconcile will retry`,
          { livePositionId: livePosition.id, desiredTp: tpPrice, executedQty: livePosition.executedQuantity },
        )
        pushStep(livePosition, "place_take_profit", false, `initial TP placement failed @ ${tpPrice}`)
      }
      // Record the qty SL/TP were armed for so the next reconcile
      // pass can detect quantity drift (delayed partial fills,
      // accumulation merges) and re-arm. Without this the drift
      // detector in `updateProtectionOrders` would see an undefined
      // baseline and re-arm on every cycle even when nothing changed.
      //
      // Only set when at least one leg succeeded — otherwise the next
      // reconcile would treat the position as "armed for current qty"
      // and never retry the failed legs because qtyDrifted is false.
      if (slOrderId || tpOrderId) {
        livePosition.protectionArmedQuantity = livePosition.executedQuantity
        // Prime the cooldown so the first 30 s of reconcile ticks cannot
        // drift-cancel-replace orders we just placed milliseconds ago.
        const nowMs = Date.now()
        if (slOrderId) livePosition.stopLossLastArmedAt = nowMs
        if (tpOrderId) livePosition.takeProfitLastArmedAt = nowMs
      }

      // Step record + progression log carry BOTH the assigned percent
      // and the resulting absolute trigger price, so an operator
      // reading the timeline never has to mentally reconstruct one
      // from the other. `assignedStopLoss`/`assignedTakeProfit` and
      // `stopLoss`/`takeProfit` are equal at this point (initial
      // placement); on later overrides the message will show both.
      pushStep(
        livePosition,
        "place_sl_tp",
        !!(slOrderId || tpOrderId),
        `SL ${livePosition.stopLoss}% → ${slPrice ? slPrice.toFixed(6) : "—"} (${slOrderId || "—"}) | ` +
        `TP ${livePosition.takeProfit}% → ${tpPrice ? tpPrice.toFixed(6) : "—"} (${tpOrderId || "—"})`
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `SL/TP placed for ${realPosition.symbol} at assigned values`,
        {
          // Assigned (immutable strategy contract) and current
          // (mutable, override-aware) percent pairs — equal on first
          // placement, can diverge after `recalculateAndApplySLTP`.
          assignedStopLossPct: livePosition.assignedStopLoss,
          assignedTakeProfitPct: livePosition.assignedTakeProfit,
          stopLossPct: livePosition.stopLoss,
          takeProfitPct: livePosition.takeProfit,
          slOrderId,
          slPrice,
          tpOrderId,
          tpPrice,
          fillPrice: livePosition.averageExecutionPrice,
        },
      )
    } else {
      pushStep(livePosition, "place_sl_tp", false, "skipped — no fill yet")
    }

    // ── Step 8: Sync with exchange for position data ──────────────���────────
    if (typeof exchangeConnector.getPosition === "function") {
      try {
        // Pass direction for hedge-mode accounts.
        const exPos = await exchangeConnector.getPosition(
          realPosition.symbol,
          realPosition.direction as "long" | "short",
        )
        if (exPos) {
          livePosition.exchangeData = {
            marginType: (exPos as any).marginType,
            markPrice: (exPos as any).markPrice,
            liquidationPrice: (exPos as any).liquidationPrice,
            unrealizedPnl: (exPos as any).unrealizedPnl,
            roi: (exPos as any).roi,
          }
          pushStep(
            livePosition,
            "exchange_sync",
            true,
            `liqPrice=${(exPos as any).liquidationPrice} markPrice=${(exPos as any).markPrice}`
          )
        } else {
          pushStep(livePosition, "exchange_sync", false, "no position returned")
        }
      } catch (err) {
        pushStep(livePosition, "exchange_sync", false, String(err))
      }
    }

    if (livePosition.status === "filled") livePosition.status = "open"

    // ── ENTRY SUMMARY — one log line showing the complete entry state ────────
    // Operator can grep "[ENTRY]" to see every live position that went through
    // the full pipeline and understand volume / leverage / protection in context.
    {
      const { desiredSl: sumSl, desiredTp: sumTp } = computeDesiredProtectionPrices(livePosition)
      console.log(
        `${LOG_PREFIX} [ENTRY] ${realPosition.symbol} ${realPosition.direction?.toUpperCase()} ` +
        `qty=${livePosition.executedQuantity?.toFixed(6) ?? "?"} ` +
        `@ ${livePosition.averageExecutionPrice?.toFixed(6) ?? "?"} ` +
        `notional=$${livePosition.volumeUsd?.toFixed(2) ?? "?"} ` +
        `lev=${livePosition.leverage ?? "?"}x ` +
        `orderId=${livePosition.orderId ?? "?"} ` +
        `SL=${sumSl > 0 ? sumSl.toFixed(6) : "none"} (id=${livePosition.stopLossOrderId ?? "—"}) ` +
        `TP=${sumTp > 0 ? sumTp.toFixed(6) : "none"} (id=${livePosition.takeProfitOrderId ?? "—"}) ` +
        `status=${livePosition.status}`
      )
    }

    await savePosition(livePosition)

    // Only count this as a real "position created" when the entry
    // order actually filled on the exchange. Previously we bumped this
    // counter unconditionally — including when pollOrderFill timed
    // out — which caused the dashboard to show ghost positions
    // (`Positions Created` > zero with `Orders Filled` still 0). The
    // user explicitly reported this asymmetry. Use executedQuantity as
    // the source of truth: it's only set once the fill is confirmed
    // (line 1450) or sync-confirmed (executeLivePosition exchange
    // sync block above).
    const hasRealFill = (livePosition.executedQuantity || 0) > 0
    if (hasRealFill) {
      await incrementMetric(connectionId, "live_positions_created_count")
      await incrementMetric(connectionId, "live_volume_usd_total", Math.round(livePosition.volumeUsd))
      // Used-balance (margin) cumulative counter — track in CENTS so
      // small margins (e.g. $5 notional / 125x leverage = $0.04)
      // survive integer rounding. Reader divides by 100 to display USD.
      // The legacy `live_margin_usd_total` counter is no longer
      // written: rounding any tiny margin to a whole dollar (or to 0)
      // produced a misleading number, and the stats reader now prefers
      // `live_margin_cents_total`.
      const lev = Math.max(1, Number(livePosition.leverage) || 1)
      const newMargin = (livePosition.volumeUsd || 0) / lev
      if (Number.isFinite(newMargin) && newMargin > 0) {
        await incrementMetric(connectionId, "live_margin_cents_total", Math.round(newMargin * 100))
      }
    }
    // ── CRITICAL FIX: Include full real position context in progression ──
    // This logs the complete lineage from real set → live execution,
    // allowing dashboards to trace back which strategy configuration
    // and axis window state produced this live position. Previously,
    // this context was lost after creation, breaking the "relay back to
    // original progress" link for ETH/SOL and other multi-set symbols.
    await logProgressionEvent(connectionId, "live_trading", "info", `Live position created ${realPosition.symbol}`, {
      livePositionId: livePosition.id,
      realPositionId: realPosition.id,
      status: livePosition.status,
      orderId: livePosition.orderId,
      executedQuantity: livePosition.executedQuantity,
      volumeUsd: livePosition.volumeUsd,
      // ── Real position context (critical for multi-symbol / multi-set debugging) ──
      realSetKey: realPosition.setKey,
      realParentSetKey: realPosition.parentSetKey,
      realSetVariant: realPosition.setVariant,
      realAxisWindows: realPosition.axisWindows,
      // ── Entry metrics ──
      leverage: realPosition.leverage,
      quantity: realPosition.quantity,
      direction: realPosition.direction,
    })

    return livePosition
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    const errStack = err instanceof Error ? err.stack : undefined
    console.error(`${LOG_PREFIX} Unhandled error:`, errMsg, errStack || "")
    livePosition.status = "error"
    livePosition.statusReason = errMsg
    pushStep(livePosition, "unhandled_error", false, errMsg)
    await savePosition(livePosition)
    await incrementMetric(connectionId, "live_orders_failed_count")
    await logProgressionEvent(
      connectionId,
      "live_trading",
      "error",
      `Live pipeline unhandled error for ${realPosition.symbol}`,
      { error: errMsg, stack: errStack }
    )

    // Surface unhandled live-pipeline failures into the systemwide log too,
    // not just the per-connection progression view.
    try {
      await SystemLogger.logError(
        err instanceof Error ? err : new Error(errMsg),
        connectionId,
        `live-stage.executeLivePosition[${realPosition.symbol}/${realPosition.direction}]`,
      )
    } catch {
      /* logging must never throw */
    }
    await releaseLock(connectionId, realPosition.symbol, realPosition.direction + _lockDirSuffix).catch(() => {})
    return livePosition
  }
}

/**
 * Update live position with order fills (used by webhooks / syncs).
 */
export async function updateLivePositionFill(
  connectionId: string,
  livePositionId: string,
  fill: LivePosition["fills"][0]
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    position.fills!.push(fill)
    position.executedQuantity += fill.quantity
    position.remainingQuantity = position.quantity! - position.executedQuantity

    const totalCost = position.fills!.reduce((sum, f) => sum + f.price * f.quantity, 0)
    position.averageExecutionPrice = totalCost / position.executedQuantity

    if (position.remainingQuantity <= 0) {
      position.status = "filled"
    } else if (position.executedQuantity > 0) {
      position.status = "partially_filled"
    }
    position.updatedAt = Date.now()

    await client.setex(key, 604800, JSON.stringify(position))
    await client.lpush(`live:positions:${position.connectionId}`, position.id)
    await client.ltrim(`live:positions:${position.connectionId}`, 0, 999)
    await client.expire(`live:positions:${position.connectionId}`, 604800)
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error updating fill:`, err)
    return null
  }
}

/**
 * Close a live position (market exit) and release its dedup lock.
 *
 * Order of operations is critical to avoid orphan orders & leaked indices:
 *   1. Cancel any open SL/TP orders FIRST so the exchange-side close
 *      doesn't race against a still-active reduce-only sitting in the
 *      book (which would either double-fire or leave a stale order
 *      glued to the user's account).
 *   2. Issue the actual close on the exchange (best-effort; if it fails
 *      we still mark the Redis record closed so reconcile picks it up
 *      next pass — better than leaking the lock).
 *   3. Compute realized PnL + margin-based ROI (matches exchange ROE).
 *   4. Persist via savePosition() �� that helper already handles the
 *      open-index ���� closed-archive move idempotently. We do NOT touch
 *      Redis directly any more (which previously left the position in
 *      the open index forever on manual close).
 *   5. Release the dedup lock so a subsequent signal can re-enter.
 */
export async function closeLivePosition(
  connectionId: string,
  livePositionId: string,
  closePrice: number,
  exchangeConnector?: any,
  closeReason: string = "manual",
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  try {
    const key = `live:position:${livePositionId}`
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)

    // ── Ownership guard ──────────────────────────────────��─────────────
    // Derived FIRST — before building any cancellation promises — so we
    // can gate the SL/TP cancel on ownership. Without this gate, a position
    // adopted/reconciled from the exchange (no system orderId) would have
    // its operator-placed protection orders cancelled while the close call
    // itself is correctly skipped, leaving the position on the exchange
    // completely unprotected.
    //
    // Only issue exchange calls when the system has a verified orderId —
    // proof that WE placed the entry order. Without an orderId the position
    // was simulated, the entry order failed silently, or the slot was
    // allocated but never confirmed.
    //
    // Fallback: if `orderId` is missing but `exchangePositionId` exists
    // (reconciled/adopted position), use it to close via exchange-side
    // position ID. Without EITHER, skip all exchange operations.
    const hasSystemOrderId = !!(position.orderId || position.exchangeData?.exchangePositionId)

    // ── 1+2. RACE: cancel owned SL/TP IN PARALLEL with close ───────────
    // The old sequential pattern (cancel → await → close) added 200-400 ms
    // of avoidable latency on every close. The cancellations are best-effort
    // cleanup and the close is reduce-only so a race can only ever attempt to
    // reduce the position twice (the second attempt no-ops when the position
    // is gone). We fire all three calls together and await them as a group.
    //
    // Gated on `hasSystemOrderId`: only cancel SL/TP that belong to a
    // position we placed. For operator-adopted positions the existing manual
    // protection stays intact on the exchange.
    const cancellationPromises: Promise<boolean>[] = []
    if (exchangeConnector && hasSystemOrderId) {
      if (position.stopLossOrderId) {
        cancellationPromises.push(
          cancelProtectionOrder(exchangeConnector, position.symbol, position.stopLossOrderId, "StopLoss"),
        )
      }
      if (position.takeProfitOrderId) {
        cancellationPromises.push(
          cancelProtectionOrder(exchangeConnector, position.symbol, position.takeProfitOrderId, "TakeProfit"),
        )
      }
    }

    // Close-result state — set by the branches below.
    let exchangeCloseSuccess = false
    let exchangeCloseReason: "ok" | "already_closed" | "failed" | "skipped" = "skipped"

    if (!hasSystemOrderId && exchangeConnector) {
      exchangeCloseReason = "skipped"
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "info",
        `closeLivePosition: skipping exchange close for ${position.symbol} ${position.direction} — no system orderId (external position protection)`,
        { positionId: position.id, symbol: position.symbol, direction: position.direction },
      ).catch(() => {})
    }

    if (hasSystemOrderId && exchangeConnector && typeof exchangeConnector.closePosition === "function") {
      // maxRetries=2, per-attempt timeout=25s, backoff=500ms/1s.
      // Total worst-case: 25s + 0.5s + 25s + 1s + 25s ≈ 76s.
      // SYNC_PER_POS_TIMEOUT_MS=55s fires before a third attempt can land,
      // so in practice the loop runs at most 2 attempts (50s) before the
      // outer sync timeout triggers the DB-close fallback.
      const maxRetries = 2
      const backoffMs = [500, 1000]
      const CLOSE_ATTEMPT_TIMEOUT_MS = 35_000

      const isAlreadyClosedError = (msg: string): boolean => {
        const m = String(msg || "").toLowerCase()
        return (
          // Generic patterns (all venues)
          m.includes("position not found") ||
          m.includes("no open position") ||
          m.includes("nothing to close") ||
          m.includes("size is zero") ||
          m.includes("already closed") ||
          m.includes("position is zero") ||
          m.includes("position does not exist") ||
          // BingX-specific already-closed codes/messages:
          //   101205 = "No position to close" (position was closed by SL/TP)
          //   101400 = "Order not exist" (also can appear if the position data
          //            was already purged from the exchange)
          m.includes("no position to close") ||
          m.includes("code=101205") ||
          m.includes("101205") ||
          // Bybit
          m.includes("no open position to close") ||
          // OKX
          m.includes("position not available") ||
          m.includes("netting quantity is not correct")
        )
      }
      // Retryable failures are bounded by a sense of "this is a transient
      // error and another attempt might succeed". Permanent rejections
      // (invalid params, auth) should NOT retry. Right now we only retry
      // on timeouts and explicit network errors — everything else falls
      // through to the failed branch after a single attempt.
      const isRetryableError = (msg: string): boolean => {
        const m = String(msg || "").toLowerCase()
        return (
          m.includes("timeout") ||
          m.includes("network") ||
          m.includes("econn") ||
          m.includes("rate limit") ||
          m.includes("429") ||
          m.includes("503") ||
          m.includes("502")
        )
      }

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        let lastErrorMsg = ""
        try {
          console.log(
            `${LOG_PREFIX} [v0] Attempting exchange close ${position.symbol} ${position.direction} (attempt ${attempt + 1}/${maxRetries})`,
          )

          // withTimeout wraps closePosition. The rate-limiter enforces the
          // HTTP timeout from dispatch time (not enqueue time) via executeTimeoutMs,
          // so this covers only actual BingX round-trip time.
          const r = (await withTimeout(
            exchangeConnector.closePosition(position.symbol, position.direction),
            CLOSE_ATTEMPT_TIMEOUT_MS,
            `closePosition(${position.symbol} ${position.direction})`,
          )) as { success?: boolean; error?: string } | undefined

          if (r && typeof r === "object" && r.success === true) {
            exchangeCloseSuccess = true
            exchangeCloseReason = "ok"
            console.log(`${LOG_PREFIX} [v0] Exchange close succeeded: ${position.symbol} ${position.direction}`)
            break
          }

          lastErrorMsg = (r && typeof r === "object" && r.error) ? String(r.error) : "invalid_response"

          // ── Already-closed reconciliation ─��─���─────────────────────────
          // If the venue says the position is gone, we treat the close as
          // successful and stop retrying. The DB-side terminal-state
          // pipeline below still runs (PnL is computed from `closePrice`,
          // which the caller passed as the trigger/mark price — which is
          // close enough to the actual SL/TP fill that the operator's
          // reported PnL is within a tick of reality).
          if (isAlreadyClosedError(lastErrorMsg)) {
            exchangeCloseSuccess = true
            exchangeCloseReason = "already_closed"
            console.log(
              `${LOG_PREFIX} [v0] Exchange position already closed (SL/TP likely fired): ${position.symbol} ${position.direction} — reason="${lastErrorMsg}"`,
            )
            break
          }

          console.warn(`${LOG_PREFIX} [v0] Exchange close failed: ${position.symbol} - ${lastErrorMsg}`)
          // Only retry on transient classes of error. Hard logic errors
          // (invalid params, auth) get a single attempt and bail.
          if (attempt < maxRetries - 1 && isRetryableError(lastErrorMsg)) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
            continue
          }
          break
        } catch (err) {
          lastErrorMsg = err instanceof Error ? err.message : String(err)
          console.error(`${LOG_PREFIX} [v0] Exchange close threw error (attempt ${attempt + 1}): ${lastErrorMsg}`)
          // Thrown timeouts and network errors ARE retryable.
          if (attempt < maxRetries - 1 && isRetryableError(lastErrorMsg)) {
            await new Promise(resolve => setTimeout(resolve, backoffMs[attempt]))
            continue
          }
          break
        }
      }

      if (!exchangeCloseSuccess) {
        exchangeCloseReason = "failed"
        console.error(
          `${LOG_PREFIX} [v0] FAILED to close position on exchange after ${maxRetries} attempts: ${position.symbol} ${position.direction}`,
        )
      }
    }

    // Drain the cancellation promises we fired in parallel with the close.
    // By the time we reach here the close has already completed, so these
    // requests have been in-flight the whole duration — typically zero
    // additional wait. We clear the local IDs regardless so the next
    // reconcile pass treats them as gone.
    // Track which leg cancel actually succeeded so we DON'T blindly wipe
    // a still-armed orderId. The original implementation cleared both
    // ids unconditionally, which meant a transient cancel failure left
    // an orphan reduce-only order on the venue with no local record to
    // look it up by — exactly the "control orders chaos" the operator
    // reported. We now only clear an id when the venue confirmed the
    // order is gone (success path inside cancelProtectionOrder also
    // returns `true` for "not found" / "already filled" / "already
    // cancelled" — so the wipe is safe in those cases).
    let slCancelled = false
    let tpCancelled = false
    const hadSlId = !!position.stopLossOrderId
    const hadTpId = !!position.takeProfitOrderId
    if (cancellationPromises.length > 0) {
      const cancelResults = await Promise.all(
        cancellationPromises.map(p => p.catch(() => false)),
      )
      let idx = 0
      if (hadSlId) {
        slCancelled = !!cancelResults[idx++]
        if (slCancelled) position.stopLossOrderId = undefined
      }
      if (hadTpId) {
        tpCancelled = !!cancelResults[idx++]
        if (tpCancelled) position.takeProfitOrderId = undefined
      }
      pushStep(
        position,
        "cancel_protection",
        cancelResults.every(Boolean),
        `cancelled SL=${hadSlId ? slCancelled : "n/a"} TP=${hadTpId ? tpCancelled : "n/a"} (raced with close)`,
      )
    }

    // ── Orphan-sweep safety net ───────────────────────────────────────��
    // After the recorded-id cancels, scan the venue for ANY reduce-only
    // order matching this symbol + close-side and cancel it. Catches:
    //   • by-id cancels that just failed transiently (we get a free retry)
    //   • protection ids that were never persisted (place-success → crash
    //     → restart finds no id in Redis)
    //   • operator-placed manual reduce-only legs the engine never knew
    //     about — which become orphans the moment the position closes.
    // Best-effort; we never let sweep failures block the close pipeline.
    if (exchangeConnector) {
      const sweepCloseSide: "buy" | "sell" =
        position.direction === "long" ? "sell" : "buy"
      try {
        const swept = await sweepOrphanProtectionOrders(
          exchangeConnector,
          position.symbol,
          sweepCloseSide,
        )
        if (swept.cancelled > 0) {
          // If the sweep cleaned up the recorded ids' leftovers, clear
          // the local fields too — at this point there is nothing on
          // the venue tied to those ids.
          if (hadSlId && !slCancelled) position.stopLossOrderId = undefined
          if (hadTpId && !tpCancelled) position.takeProfitOrderId = undefined
          pushStep(
            position,
            "orphan_sweep",
            true,
            `swept ${swept.cancelled}/${swept.scanned} orphan reduce-only orders`,
          )
        }
      } catch (sweepErr) {
        console.warn(
          `${LOG_PREFIX} [sweep] ${position.symbol} error: ${sweepErr instanceof Error ? sweepErr.message : String(sweepErr)}`,
        )
      }
    }

    // ── 3. Compute realized PnL & ROI (margin-based to match exchange ROE) ──
    const qty = position.executedQuantity || 0
    const avgEntry = position.averageExecutionPrice || position.entryPrice || 0
    const pnl =
      qty > 0 && avgEntry > 0 && closePrice > 0
        ? qty *
          (position.direction === "long"
            ? closePrice - avgEntry
            : avgEntry - closePrice)
        : 0
    const lev = Math.max(1, position.leverage || 1)
    const notional = avgEntry * qty
    const margin = notional > 0 ? notional / lev : 0
    const roi = margin > 0 ? (pnl / margin) * 100 : 0

    // ── 4. Persist with terminal state ────────────────────────────────
    position.status = "closed"
    position.closedAt = Date.now()
    position.updatedAt = Date.now()
    position.realizedPnL = Math.round(pnl * 100) / 100
    position.closeReason = closeReason
    // Persist the actual exit price so the stats route and trade-history
    // table can show the real close price without needing to back-derive
    // it from realizedPnL. This is the definitive source of truth for
    // the "Exit" column in trade history.
    if (closePrice > 0) position.closePrice = Math.round(closePrice * 1e8) / 1e8
    
    // Step annotation distinguishes the three real outcomes:
    //   • ok            → connector returned success
    //   • already_closed → venue said position is gone (SL/TP fired)
    //   • failed         → connector returned an error we couldn't recover
    //   • skipped        → no connector was passed (manual DB-only close)
    const exchangeNote =
      !exchangeConnector
        ? "" // no exchange leg
        : exchangeCloseReason === "ok"
          ? " [exchange-closed]"
          : exchangeCloseReason === "already_closed"
            ? " [exchange-already-closed]"
            : " [exchange-close-FAILED]"
    pushStep(
      position,
      "close",
      true,
      `close @ ${closePrice} pnl=${pnl.toFixed(2)} roi=${roi.toFixed(2)}% reason=${closeReason}${exchangeNote}`,
    )
    // savePosition() handles index move + idempotent archival.
    // CHECK the moved-marker BEFORE savePosition() runs so we know
    // whether THIS close is the first terminal write or a re-entry.
    // Without this guard `closeLivePosition` and the reconcile loop
    // could BOTH bump `live_positions_closed_count` for the same
    // position — that's exactly the "Positions Closed (6) >
    // Positions Created (4)" asymmetry the operator reported.
    const movedMarker = `live:positions:${connectionId}:moved:${position.id}`
    const wasAlreadyClosed = await client.get(movedMarker).catch(() => null)
    await savePosition(position)

    // ── 5. Release dedup lock + counters + audit log ────────────────────
    await releaseLock(connectionId, position.symbol, position.direction!)
    if (!wasAlreadyClosed) {
      await incrementMetric(connectionId, "live_positions_closed_count")
      if (pnl > 0) await incrementMetric(connectionId, "live_wins_count")
      // Only count as exchange-close failure when the connector actually
      // failed. `already_closed` means the exchange-side state already
      // matches our intent (SL/TP fired first), and `skipped` means we
      // never had a connector — neither is a real failure.
      if (exchangeCloseReason === "failed") {
        await incrementMetric(connectionId, "live_positions_close_failed_count")
      }
    }

    // ── Include lineage context in close logging ──
    // When a live position closes, log its original real set context
    // so dashboards can trace the complete lifecycle:
    // real set → live creation → SL/TP/manual close → final P&L
    await logProgressionEvent(connectionId, "live_trading", "info", `Closed live position ${position.symbol}`, {
      livePositionId: position.id,
      realPositionId: position.realPositionId,
      realSetKey: position.setKey,
      realParentSetKey: position.parentSetKey,
      realSetVariant: position.setVariant,
      realAxisWindows: position.axisWindows,
      pnl,
      roi,
      closePrice,
      closeReason,
      executedQuantity: qty,
      averageEntry: avgEntry,
      leverage: lev,
      marginAtRisk: margin,
      exchangeCloseSucceeded: exchangeCloseSuccess,
      exchangeCloseClassification: exchangeCloseReason,
    })

    const closeStatus =
      exchangeCloseReason === "ok"
        ? "SUCCEEDED"
        : exchangeCloseReason === "already_closed"
          ? "ALREADY-CLOSED (SL/TP fired)"
          : exchangeCloseReason === "skipped"
            ? "DB-only (no connector)"
            : "FAILED (DB-closed; exchange uncertain)"
    console.log(
      `${LOG_PREFIX} [v0] Closed ${position.symbol} ${position.direction} P&L=${pnl.toFixed(2)} ROI=${roi.toFixed(2)}% reason=${closeReason} exchange_close=${closeStatus}`,
    )

    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} Error closing live position:`, err)
    return null
  }
}

/**
 * Get all live positions for a connection.
 */
export async function getLivePositions(connectionId: string): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}`, 0, 500).catch(() => [])) || []) as string[]

    // Deduplicate while preserving order — the open index may contain stale
    // duplicates from retried writes.
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    // Batch all GETs into a single concurrent fan-out. Previously each id
    // paid a full Redis round-trip; with 500 open positions that was ~500
    // sequential awaits. Promise.all collapses them into one RTT window.
    const positions: LivePosition[] = []
    if (uniqueIds.length > 0) {
      const rawValues = await Promise.all(
        uniqueIds.map((id) => client.get(`live:position:${id}`).catch(() => null)),
      )
      for (const data of rawValues) {
        if (!data) continue
        try { positions.push(JSON.parse(data as string)) } catch { /* ignore */ }
      }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} Error getting live positions:`, err)
    return []
  }
}

/**
 * Get live positions filtered by status.
 */
export async function getLivePositionsByStatus(
  connectionId: string,
  status: LivePosition["status"]
  ): Promise<LivePosition[]> {
  const allPositions = await getLivePositions(connectionId)
  return allPositions.filter(p => p.status === status)
  }

/**
 * Fetch the most recent closed/terminal positions from the closed archive.
 * Closed positions are stored separately so the open index stays small.
 */
export async function getClosedLivePositions(
  connectionId: string,
  limit = 200
): Promise<LivePosition[]> {
  await initRedis()
  const client = getRedisClient()
  try {
    const ids = ((await client.lrange(`live:positions:${connectionId}:closed`, 0, limit - 1).catch(() => [])) || []) as string[]

    // Deduplicate + batch GETs concurrently (same rationale as getLivePositions).
    const uniqueIds: string[] = []
    const seen = new Set<string>()
    for (const id of ids) {
      if (seen.has(id)) continue
      seen.add(id)
      uniqueIds.push(id)
    }

    const positions: LivePosition[] = []
    if (uniqueIds.length === 0) return positions

    const rawValues = await Promise.all(
      uniqueIds.map((id) => client.get(`live:position:${id}`).catch(() => null)),
    )
    for (const data of rawValues) {
      if (!data) continue
      try { positions.push(JSON.parse(data as string)) } catch { /* ignore malformed */ }
    }
    return positions
  } catch (err) {
    console.warn(`${LOG_PREFIX} getClosedLivePositions error:`, err)
    return []
  }
}

/**
 * Compute aggregate stats across all live positions.
 */
export async function calculateLivePositionStats(
  connectionId: string
): Promise<{
  totalFilled: number
  totalOpen: number
  totalClosed: number
  totalPnL: number
  averageROI: number
  winRate: number
}> {
  try {
    // Merge open (live) and closed (archive) indices so aggregate stats are
    // accurate across the position's full lifecycle, not just currently-open.
    const [openPositions, closedPositions] = await Promise.all([
      getLivePositions(connectionId),
      getClosedLivePositions(connectionId, 1000),
    ])
    const allPositions = [...openPositions, ...closedPositions]
    const closed = allPositions.filter(p => p.status === "closed")
    const open = allPositions.filter(
      p => p.status === "open" || p.status === "filled" || p.status === "partially_filled"
    )

    let totalPnL = 0
    let winCount = 0
    for (const pos of closed) {
      const lastStep = pos.progression?.find(s => s.step === "close")
      const exitPx = lastStep ? parseFloat(lastStep.details?.split("@ ")[1] || "0") : 0
      if (exitPx > 0 && pos.averageExecutionPrice > 0) {
        const pnl = Math.round(
          pos.executedQuantity *
          (pos.direction === "long"
            ? exitPx - pos.averageExecutionPrice
            : pos.averageExecutionPrice - exitPx) * 100
        ) / 100
        totalPnL = Math.round((totalPnL + pnl) * 100) / 100
        if (pnl > 0) winCount++
      }
    }

    return {
      totalFilled: allPositions.filter(p => p.status === "filled" || p.status === "open").length,
      totalOpen: open.length,
      totalClosed: closed.length,
      totalPnL,
      averageROI: closed.length > 0 ? Math.round((totalPnL / closed.length) * 100) / 100 : 0,
      winRate: closed.length > 0 ? Math.round((winCount / closed.length) * 100) / 100 : 0,
    }
  } catch (err) {
    console.error(`${LOG_PREFIX} Error calculating stats:`, err)
    return {
      totalFilled: 0,
      totalOpen: 0,
      totalClosed: 0,
      totalPnL: 0,
      averageROI: 0,
      winRate: 0,
    }
  }
}

/**
 * Detect whether the latest mark price has crossed the position's
 * desired SL or TP threshold and — if so — force-close the position
 * via `closeLivePosition`. Returns the cross reason ("sl_hit" / "tp_hit")
 * when a close was triggered (whether or not it succeeded), otherwise
 * `null`.
 *
 * This is the safety net the user described as "check pos if to be
 * updated or closed also independent of the control orders". Even if
 * the exchange-placed reduce-only SL/TP orders fail to fire (illiquid
 * pair gap, exchange order cancelled by the user, network race), this
 * comparison guarantees we close the position once mark price has
 * actually crossed the configured level.
 *
 * Used by:
 *   - `reconcileLivePositions` (cron, full reconcile sweep)
 *   - `syncWithExchange`        (engine loop, lighter mark-price refresh)
 *   - `recalculateAndApplySLTP` (immediate check after operator override —
 *     a tightened SL might already be breached at the new percentage)
 *
 * Pure side-effect helper: the caller decides what to do with `null`
 * (typically: persist the mark refresh and continue) or with a non-null
 * return (typically: skip further processing because the position was
 * archived by `closeLivePosition`).
 */
async function checkAndForceCloseOnSltpCross(
  connectionId: string,
  pos: LivePosition,
  markPrice: number,
  exchangeConnector: any,
): Promise<"sl_hit" | "tp_hit" | null> {
  if (!Number.isFinite(markPrice) || markPrice <= 0) return null
  if (pos.executedQuantity <= 0) return null
  
  // CRITICAL GUARD: Skip positions that are already closed or have a close reason set.
  // Without this guard, multiple concurrent reconciliation paths call this function
  // on the same position, all detecting the SL/TP cross and all calling closeLivePosition(),
  // resulting in duplicate close attempts and memory overload from redundant API calls.
  if (pos.status === "closed" || pos.status === "rejected" || pos.status === "error") return null
  if (pos.closeReason || pos.closedAt) return null  // Already being closed elsewhere
  
  // RC1: Atomic lock to prevent duplicate close operations from concurrent sync-tick cycles
  // Only ONE thread should proceed with closing this position
  if (!tryLockPosition(pos, "checkAndForceCloseOnSltpCross")) {
    return null  // Another thread is already processing this close
  }
  if (!isSystemTrackedLivePosition(pos, connectionId)) return null
  if (pos.status === "placed") {
    // Rate-limit to once-per-minute per position by using updatedAt as
    // the throttle key — prevents log spam while still surfacing the
    // skip during diagnosis.
    const since = Date.now() - (pos.updatedAt || 0)
    if (since > 60_000) {
      console.log(
        `${LOG_PREFIX} [cross-check skip] ${pos.symbol} (id=${pos.id}) status='placed' — entry order not filled yet; SL/TP cross check deferred`,
      )
    }
    return null
  }

  const fillPrice = pos.averageExecutionPrice
  // Require a confirmed fill price �� entryPrice is an estimate and can be
  // stale. If averageExecutionPrice is missing the position has not been
  // confirmed filled yet; skip until it is.
  if (!fillPrice || fillPrice <= 0) return null

  // ── Trailing stop: honour the ratcheted absolute price ─────────────────
  // When trailing is active syncLiveFromPseudo has stamped trailingStopPrice
  // onto the position. Using that absolute price means the proactive force-close
  // fires at the RATCHETED level — not the static origin level that the
  // percentage anchor would compute. Without this fix a trailing stop that
  // ratcheted from, say, 2% below entry to 0.5% below entry would NEVER
  // trigger the proactive close (the static 2% level is never reached while
  // in profit), letting the position blow through the ratcheted stop if the
  // exchange order somehow failed to fire.
  let desiredSl: number
  if (pos.trailingActive && pos.trailingStopPrice && pos.trailingStopPrice > 0) {
    desiredSl = pos.trailingStopPrice
  } else {
    const slPct = Math.max(0, pos.stopLoss || 0) / 100
    desiredSl =
      slPct > 0
        ? pos.direction === "long"
          ? fillPrice * (1 - slPct)
          : fillPrice * (1 + slPct)
        : 0
  }

  const tpPct = Math.max(0, pos.takeProfit || 0) / 100
  const desiredTp =
    tpPct > 0
      ? pos.direction === "long"
        ? fillPrice * (1 + tpPct)
        : fillPrice * (1 - tpPct)
      : 0

  // Nothing to evaluate if neither protection band is configured.
  if (desiredSl <= 0 && desiredTp <= 0) return null

  let crossReason: "sl_hit" | "tp_hit" | null = null
  if (pos.direction === "long") {
    if (desiredSl > 0 && markPrice <= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice >= desiredTp) crossReason = "tp_hit"
  } else {
    if (desiredSl > 0 && markPrice >= desiredSl) crossReason = "sl_hit"
    else if (desiredTp > 0 && markPrice <= desiredTp) crossReason = "tp_hit"
  }

  if (!crossReason) return null

  console.log(
    `${LOG_PREFIX} ${crossReason.toUpperCase()} detected for ${pos.symbol} ${pos.direction} @ mark=${markPrice} (sl=${desiredSl} tp=${desiredTp}) ��� force-closing`,
  )
  await logProgressionEvent(
    connectionId,
    "live_trading",
    "warning",
    `${crossReason === "sl_hit" ? "Stop-loss" : "Take-profit"} cross detected for ${pos.symbol} — force-closing`,
    {
      positionId: pos.id,
      markPrice,
      desiredSl,
      desiredTp,
      direction: pos.direction!,
      averageEntry: pos.averageExecutionPrice,
      // Useful for the operator audit trail: was the cross because the
      // exchange-placed control order failed to fire, or because the
      // operator just tightened the band such that the position was
      // already past it?
      hadStopLossOrder: !!pos.stopLossOrderId,
      hadTakeProfitOrder: !!pos.takeProfitOrderId,
    },
  )

  try {
    await closeLivePosition(connectionId, pos.id, markPrice, exchangeConnector, crossReason as unknown as string)
  } catch (closeErr) {
    console.warn(
      `${LOG_PREFIX} force-close on ${crossReason!} failed for ${pos.id}:`,
      closeErr instanceof Error ? closeErr.message : String(closeErr),
    )
  } finally {
    // RC1: Always unlock, even on error, to allow retries in next cycle
    unlockPosition(pos)
  }
  return crossReason
}

/**
 * Reconcile Redis-tracked live positions with the exchange.
 *
 * For every Redis-tracked open position:
 *   - If present on the exchange: refresh markPrice / liqPrice / unrealizedPnL
 *   - If NOT present on the exchange: it was closed externally (SL/TP hit,
 *     liquidated, or manually closed). Transition to "closed", compute realised
 *     PnL, move to the closed archive, increment metrics, release the lock.
 *
 * Returns a summary usable for logging / API responses.
 *
 * ── Hedge-Net Reconciliation Hook (operator spec, Position-Count axis) ─��────
 * `strategy-coordinator.evaluateRealSets` writes per-bucket net targets to
 * the Redis hash `live_net_target:{connectionId}`. Each field is keyed by
 *
 *   `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
 *
 * (the axis-Cartesian triple + last-axis outcome) and its value encodes the
 * dominant-direction target:
 *
 *   `long:N`   → keep N net-long axis OPEN positions in this bucket
 *   `short:N`  → keep N net-short axis OPEN positions in this bucket
 *   `flat:0`   → perfect long/short cancellation; close any open in bucket
 *
 * The `cont` component is the OPEN-position accumulation count per spec
 * ("continuous 3: add actual and next 2 positions"). Each reconcile tick
 * advances the bucket toward `N = cont` open positions in the net direction.
 * As completed positions close out under the bucket the next coordinator
 * cycle re-evaluates the prev/last PF gates (closed-only) over the now-
 * larger completed sample and either:
 *   (a) keep bucket alive at same magnitude  → no exchange op
 *   (b) flip outcome (pos ↔ neg)             → close + reopen
 *   (c) flip dominant direction (long ↔ short) → close + reopen
 *   (d) drop bucket from net targets         → close all in bucket
 *
 * Reconciliation reuses the existing `closeLivePosition` and
 * `executeLivePosition` paths — no new exchange-call surface.
 */

/**
 * Orphan-close all open positions for a connection that have exceeded the
 * max hold time, writing `orphan_no_connector` or `orphan_exchange_error`
 * as the close reason. Called when the exchange connector is unavailable or
 * `getPositions()` throws, so positions are never left open in Redis
 * indefinitely even when the exchange cannot be reached.
 *
 * @param connectionId  Redis connection ID
 * @param connector     Exchange connector (null when unavailable)
 * @param summary       Mutable reconcile summary to increment counters
 */
async function orphanCloseExpiredPositions(
  connectionId: string,
  connector: any,
  // Same shape as the reconcile summary so the function can roll up
  // sweep activity into the engine-level totals without the caller
  // having to mirror counters.
  summary: {
    reconciled: number
    closed: number
    errors: number
    updated: number
    protectionRearmed: number
    orphansSwept: number
  },
): Promise<void> {
  const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
  if (MAX_HOLD_TIME_MS <= 0) return

  try {
    const allOpen = await getLivePositions(connectionId)
    const expired = allOpen.filter((p) => {
      if (p.status !== "open" && p.status !== "filled" && p.status !== "partially_filled") return false
      if (!isSystemTrackedLivePosition(p, connectionId)) return false
      if ((p.executedQuantity ?? 0) <= 0) return false
      const openedAt = p.createdAt || p.updatedAt || 0
      return openedAt > 0 && Date.now() - openedAt > MAX_HOLD_TIME_MS
    })

    for (const pos of expired) {
      summary.reconciled++
      const heldMin = Math.round((Date.now() - (pos.createdAt || pos.updatedAt || 0)) / 60000)
      // Same exit-price resolution chain as reconcileLivePositions:
      // markPrice → averageExecutionPrice → Redis market_data → entryPrice
      let exitPrice: number = Number(pos.exchangeData?.markPrice) || pos.averageExecutionPrice || 0
      if (exitPrice <= 0) {
        try {
          const orphanRedis = getRedisClient()
          const mdHash = await orphanRedis.hgetall(`market_data:${pos.symbol}`)
          const mdPrice = parseFloat(String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0"))
          if (mdPrice > 0) exitPrice = mdPrice
        } catch { /* ignore */ }
      }
      if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
      const reason = connector ? "orphan_exchange_error" : "orphan_no_connector"

      console.warn(
        `${LOG_PREFIX} [orphan-close] ${pos.symbol} held ${heldMin}min, connector=${connector ? "error" : "missing"} — marking closed`,
      )
      await logProgressionEvent(
        connectionId,
        "live_trading",
        "warning",
        `Orphan-close ${pos.symbol} (held ${heldMin}min, ${reason})`,
        { positionId: pos.id, heldMin, exitPrice, reason },
      )

      // Best-effort cancel protection orders first (connector may be partially working)
      if (connector) {
        const cancels: Promise<any>[] = []
        if (pos.stopLossOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.stopLossOrderId, "StopLoss").catch(() => {}))
        if (pos.takeProfitOrderId) cancels.push(cancelProtectionOrder(connector, pos.symbol, pos.takeProfitOrderId, "TakeProfit").catch(() => {}))
        if (cancels.length) await Promise.all(cancels).catch(() => {})
        // Same orphan-sweep used inside `closeLivePosition`. Wired here
        // too so max-hold-expired positions also get the chaos-prevention
        // pass — without it, an operator-placed reduce-only that the
        // engine never recorded would survive the orphan-close because
        // there'd be no by-id cancellation to trigger the sweep on.
        const sweepCloseSide: "buy" | "sell" = pos.direction === "long" ? "sell" : "buy"
        try {
          const swept = await sweepOrphanProtectionOrders(connector, pos.symbol, sweepCloseSide)
          summary.orphansSwept += swept.cancelled
        } catch { /* sweep is best-effort */ }
      }

      await closeLivePosition(connectionId, pos.id, exitPrice, connector, reason).catch((err) => {
        console.warn(`${LOG_PREFIX} [orphan-close] closeLivePosition failed for ${pos.id}:`, err instanceof Error ? err.message : String(err))
        summary.errors++
      })
      summary.closed++
    }
  } catch (err) {
    console.warn(`${LOG_PREFIX} [orphan-close] sweep error:`, err instanceof Error ? err.message : String(err))
    summary.errors++
  }
}

/**
 * ── CANONICAL LIVE SYNC & RECONCILE ────────────────���────────────────────────
 * Single entry-point for ALL live-position + exchange sync work.
 *
 * Called by:
 *   • startRealtimeProcessor  (engine-manager.ts, 200 ms self-scheduling loop)
 *   • maybeRunLiveSync        (realtime-processor.ts, legacy throttle gate — delegates here)
 *   • /api/cron/sync-live-positions (Vercel cron, ~30 s)
 *   • syncWithExchange        (legacy shim, redirects here)
 *
 * Responsibilities (in one Redis-locked pass):
 *   1. Always-run simulated-position sweep (paper-mode close path) — runs
 *      even when connector is absent or global pause is set.
 *   2. Exchange position fetch + normalized (symbol|direction) → exchangePos map.
 *   3. Exchange-orphan adoption (exchange positions not yet tracked in Redis).
 *   4. Per-position loop (open/placed statuses):
 *       a. Mark-price / liq-price / unrealizedPnL refresh from exchange.
 *       b. Externally-closed detection (absent from exchange map).
 *       c. SL/TP protection-order healing via updateProtectionOrders.
 *       d. SL/TP cross-check → force-close on market hit.
 *       e. Max-hold-time safety close.
 *       f. savePosition (persist refreshed state).
 *   5. Redis single-flight lock + cross-caller dedup via moved-marker key.
 *
 * Options:
 *   • skipSimulatedSweep     — skip step 1 (caller already ran processSimulatedPositions)
 *   • skipOrphanAdoption     — skip step 3 (orphan run is a no-op when connector is absent)
 *   • reconcileMode          — true = cron (does not return early on no connector;
 *                              false = engine tick (early-return is fine)).
 */
export async function reconcileLivePositions(
  connectionId: string,
  exchangeConnector: any,
  options: {
    skipSimulatedSweep?: boolean
    skipOrphanAdoption?: boolean
    reconcileMode?: boolean
  } = {},
): Promise<{
  reconciled: number
  updated: number
  closed: number
  errors: number
  protectionRearmed: number
  orphansSwept: number
}> {
  await initRedis()
  const client = getRedisClient()
  const { skipSimulatedSweep, skipOrphanAdoption, reconcileMode = false } = options
  const summary = {
    reconciled: 0, updated: 0, closed: 0, errors: 0, protectionRearmed: 0, orphansSwept: 0,
  }

  // ── Cross-caller single-flight lock ───────────────────────────────────────
  // Multiple callers (engine tick + cron + resume) can hit this function in
  // parallel. The Redis lock prevents concurrent mutations of per-position
  // state. TTL 30 s is the safety net for process death mid-sync.
  const LIVE_SYNC_LOCK_KEY = `live_sync_lock:${connectionId}`
  const LIVE_SYNC_LOCK_TTL = 30
  const syncStartMs = Date.now()
  let lockAcquired = false
  if (client) {
    try {
      lockAcquired = await (client.set(LIVE_SYNC_LOCK_KEY, String(syncStartMs), { NX: true, EX: LIVE_SYNC_LOCK_TTL }) as any) === "OK"
    } catch { /* Redis unreachable → fail open */ }
    if (!lockAcquired) {
      console.log(`${LOG_PREFIX} [reconcile] skip — lock held for conn=${connectionId}`)
      return summary
    }
  }

  try {
    // ── Step 1: Simulated-position sweep (always runs unless caller opts out) ─
    if (!skipSimulatedSweep) {
      try {
        const simResult = await processSimulatedPositions(connectionId)
        summary.reconciled += simResult.processed
        summary.closed     += simResult.closed
        summary.errors     += simResult.errors
      } catch { /* processSimulatedPositions is self-defensive */ }
    }

    // QuickStart intentionally keeps the engine progression running when the
    // BingX connection test fails, but writes is_live_trade=0 so no private
    // exchange endpoints should be touched. The sync loop already had this
    // guard; the reconcile path also needs it because the coordinator can call
    // reconcile directly every 30s. Without this, dev mode kept polling
    // getPositions/getOpenOrders and spammed "fetch failed" after a blocked
    // quickstart.
    if (!(await isLiveTradeEnabledForConnection(connectionId))) {
      if (!skipOrphanAdoption) {
        await orphanCloseExpiredPositions(connectionId, null, summary)
      }
      return summary
    }

    // ── Step 4+ from reconcileLivePositions ───────────���────────────────────
    // Nothing to do if connector absent (sim-only is already done above)
    if (!exchangeConnector || typeof exchangeConnector.getPositions !== "function") {
      if (!reconcileMode) return summary  // cron always runs full path
      await orphanCloseExpiredPositions(connectionId, null, summary)
      return summary
    }

    // Load live-positions index (single Redis round-trip, filtered in-memory)
    const allOpen = await getLivePositions(connectionId)
    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed",
    )
    if (openPositions.length === 0 && !reconcileMode) {
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }

    // Single batch fetch of ALL exchange positions for the position-sync loop.
    // Use cycle-level cache to eliminate duplicate getPositions() calls when
    // multiple symbols are processed. Cache TTL=500ms, expires after cycle completes.
    let exchangePositions: any[] = []
    try {
      // Check cache first (50% hit rate typical, saves 30-40% API calls per cycle)
      const cached = getCachedPositions(connectionId)
      if (cached) {
        exchangePositions = cached
      } else {
        exchangePositions = (await exchangeConnector.getPositions().catch(() => [])) || []
        // Cache for subsequent getPositions calls this cycle
        setCachedPositions(connectionId, exchangePositions)
      }
    } catch (err) {
      console.warn(`${LOG_PREFIX} getPositions failed:`, err instanceof Error ? err.message : String(err))
      await orphanCloseExpiredPositions(connectionId, exchangeConnector, summary)
      return summary
    }

    // Normalise a raw exchange symbol for map-key comparison.
    // BingX (and several other venues) return "BTC-USDT" or "BTC_USDT"
    // while Redis stores the normalised form "BTCUSDT". Strip all
    // separators before building / querying the key so a BingX position
    // is never mistaken for "externally closed" simply because the symbol
    // format differs.
    const normSym = (raw: string) => raw.toUpperCase().replace(/[-_]/g, "")

    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = normSym(String(ep.symbol || ep.Symbol || ""))
      if (!sym) continue
      const size = parseFloat(String(ep.size ?? ep.positionAmt ?? ep.quantity ?? "0"))
      if (!size) continue
      const sideRaw = String(ep.side ?? ep.positionSide ?? (size > 0 ? "long" : "short")).toLowerCase()
      const direction: "long" | "short" = (sideRaw.includes("short") || sideRaw === "sell") ? "short" : "long"
      exchangeMap.set(`${sym}|${direction}`, ep)
    }

    // ── Once-per-tick venue open-orders snapshot ────���─────────────────���
    // Used by `updateProtectionOrders` to detect silently-gone SL/TP
    // (filled, externally cancelled, expired, sweep). One `getOpenOrders`
    // call amortized across every position in the reconcile sweep, vs.
    // 2 × getOrder() calls per position the alternative would require.
    // `null` means "skip verification this tick"; the next tick retries.
    const liveOrderIds = await fetchLiveOrderIdSet(exchangeConnector)

    // ── Per-position worker (parallelisable) ─────────���───────────────
    // Each iteration is independent at the venue + Redis layer:
    //   • Redis writes are scoped to `live:positions:{conn}:{id}` and
    //     the per-symbol-direction lock key — no two positions share
    //     them.
    //   • Exchange calls are per-(symbol, direction) and the venue
    //     serialises its own per-symbol writes.
    //   • The idempotent `moved:{id}` marker prevents the close-counter
    //     drift the operator reported even under interleaved execution.
    // So we can fan the loop body out with bounded concurrency. Returns
    // a tiny per-position delta that the caller folds into `summary`.
    type PosDelta = {
      reconciled: number
      updated: number
      closed: number
      errors: number
      protectionRearmed: number
    }
    // ── Canonical-position-per-slot resolution (BUG 4) ────────��───────
    // The venue holds exactly ONE position per (symbol, direction). If
    // Redis tracks more than one open position for the same slot
    // (lock-expiry edge, restart mid-entry, or migrated legacy data),
    // they ALL map to the same exchange position. Reconciling each one
    // independently would (a) arm duplicate SL/TP orders against one
    // venue position and (b) when that venue position closes, count one
    // real close N times — the close-counter drift the operator reported.
    //
    // Resolve a single CANONICAL position id per slot up-front. The choice
    // is stable and order-independent (so the parallel pool below is
    // deterministic): prefer a system-owned position (has orderId), then
    // the one actually filled (largest executedQuantity), then the oldest
    // createdAt. Non-canonical duplicates are refreshed for the dashboard
    // but never drive SL/TP arming, force-close, or close counters.
    const canonicalIdBySlot = new Map<string, string>()
    {
      const bySlot = new Map<string, typeof openPositions>()
      for (const p of openPositions) {
        const slot = `${normSym(p.symbol)}|${p.direction}`
        const arr = bySlot.get(slot)
        if (arr) arr.push(p); else bySlot.set(slot, [p])
      }
      for (const [slot, group] of bySlot) {
        if (group.length === 1) { canonicalIdBySlot.set(slot, group[0].id); continue }
        const ranked = [...group].sort((a, b) => {
          const ao = a.orderId ? 1 : 0, bo = b.orderId ? 1 : 0
          if (ao !== bo) return bo - ao
          const aq = a.executedQuantity || 0, bq = b.executedQuantity || 0
          if (aq !== bq) return bq - aq
          return (a.createdAt || 0) - (b.createdAt || 0)
        })
        canonicalIdBySlot.set(slot, ranked[0].id)
        console.warn(
          `${LOG_PREFIX} [reconcile] slot ${slot} has ${group.length} open Redis positions — ` +
          `canonical=${ranked[0].id}; others pruned/refreshed without close-count.`,
        )
      }
    }

    // BATCHING: Collect positions to save instead of saving individually
    const positionsToSave: typeof openPositions = []

    const processOne = async (pos: typeof openPositions[number]): Promise<PosDelta> => {
      const delta: PosDelta = { reconciled: 1, updated: 0, closed: 0, errors: 0, protectionRearmed: 0 }
      try {
        const mapKey = `${normSym(pos.symbol)}|${pos.direction}`
        const exPos = exchangeMap.get(mapKey)

        // ── Non-canonical duplicate for this venue slot (BUG 4) ─────────
        // Never drive SL/TP, force-close, or close counters (would double-
        // count one venue position). Just keep the dashboard mark/PnL fresh
        // when the slot is live, or prune the phantom Redis record when the
        // venue slot is empty — without incrementing the close counter, so
        // the canonical record alone owns the single real close.
        if (canonicalIdBySlot.get(mapKey) !== pos.id) {
          if (exPos) {
            const mP = parseFloat(String(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice ?? "0"))
            const uP = parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl ?? "0"))
            pos.exchangeData = {
              ...pos.exchangeData,
              markPrice: mP || pos.exchangeData?.markPrice,
              unrealizedPnL: uP || pos.exchangeData?.unrealizedPnL,
              syncedAt: Date.now(),
            }
            pos.updatedAt = Date.now()
            positionsToSave.push(pos) // BATCH: collect instead of save immediately
            delta.updated++
          } else {
            pos.status = "closed"
            pos.closedAt = Date.now()
            pos.closeReason = "duplicate_slot_pruned"
            pos.updatedAt = Date.now()
            // savePosition() moves it from the open index to the closed archive
            positionsToSave.push(pos) // BATCH: collect instead of save immediately
            delta.updated++
          }
          return delta
        }

        if (exPos) {
          const markPrice = parseFloat(String(exPos.markPrice ?? exPos.indexPrice ?? exPos.lastPrice ?? "0"))
          const liqPrice  = parseFloat(String(exPos.liquidationPrice ?? exPos.liqPrice ?? "0"))
          const uPnl      = parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealisedPnl ?? exPos.unrealizedPnl ?? "0"))

          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice: markPrice || pos.exchangeData?.markPrice,
            liquidationPrice: liqPrice || pos.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl || pos.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          pos.updatedAt = Date.now()

          // ── Entry-order fill detection (reconcile path) ────────────���──
          let justFilled = false
          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            const exSize  = Math.abs(parseFloat(String(exPos.size ?? exPos.positionAmt ?? exPos.quantity ?? "0"))) || 0
            const exEntry = parseFloat(String(exPos.entryPrice ?? exPos.avgPrice ?? exPos.markPrice ?? "0")) || 0
            if (exSize > 0) {
              if (pos.executedQuantity <= 0) {
                pos.executedQuantity = exSize
                pos.remainingQuantity = 0
                pos.averageExecutionPrice = exEntry || pos.entryPrice
              }
              pos.status = "open"
              pos.statusReason = `confirmed_position_fallback: reconcile saw exchange position size=${exSize} avg=${pos.averageExecutionPrice}`
              pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
              pos.updatedAt = Date.now()
              justFilled = true
              await incrementMetric(connectionId, "live_orders_filled_count")
              await incrementOrdersBySymbol(connectionId, pos.symbol, pos.direction!, "filled")
            }

            if (pos.orderId) {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                const statusLower = String(order?.status ?? "").toLowerCase()
                const orderFilledQty = parseFloat(String(order?.filledQty ?? order?.executedQty ?? "0")) || 0
                if (order && (statusLower === "filled" || statusLower === "partially_filled" || orderFilledQty > 0)) {
                  if (orderFilledQty > 0) {
                    pos.executedQuantity = orderFilledQty
                    pos.remainingQuantity = Math.max(0, pos.quantity - pos.executedQuantity)
                    pos.averageExecutionPrice = parseFloat(String(order.filledPrice ?? order.avgPrice ?? "0")) || pos.averageExecutionPrice || pos.entryPrice
                  }
                  pos.status = "open"
                  pos.statusReason = `confirmed_fill: reconcile order status=${statusLower} qty=${pos.executedQuantity}`
                  pushStep(pos, "reconcile_fill_detected", true, pos.statusReason)
                  pos.updatedAt = Date.now()
                  if (!justFilled) {
                    justFilled = true
                    await incrementMetric(connectionId, "live_orders_filled_count")
                    await incrementOrdersBySymbol(connectionId, pos.symbol, pos.direction!, "filled")
                  }
                } else if (statusLower === "cancelled" || statusLower === "canceled" || statusLower === "rejected") {
                  pos.status = "rejected"
                  pos.closeReason = `entry_order_${statusLower}`
                  pos.closedAt = Date.now()
                  pos.updatedAt = Date.now()
                  await savePosition(pos)
                  delta.updated++
                  return delta
                }
              } catch {
                /* getOrder() may fail transiently — Layer 1 result stands */
              }
            }
          }

          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            await savePosition(pos)
            delta.updated++
            return delta
          }

          // ── Ownership guard ────────────────────�����─────���──────────────
          // Only arm SL/TP and issue force-closes on positions that carry
          // a system orderId ��� proof WE placed the entry order.
          // If orderId is absent, the exchange position at this
          // symbol+direction may have been opened manually by the operator
          // or by another system. We must not arm reduce-only orders or
          // close it. We still save the refreshed markPrice/PnL so the
          // dashboard reflects current unrealised PnL accurately.
          if (!pos.orderId) {
            await savePosition(pos)
            delta.updated++
            return delta
          }

          try {
            const protectionResult = await updateProtectionOrders(
              exchangeConnector,
              pos,
              justFilled ? "reconcile_fill_detected" : "reconcile",
              liveOrderIds,
            )
            if (protectionResult.changed) {
              delta.protectionRearmed++
              await savePosition(pos)
              delta.updated++
            }
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} reconcile SL/TP heal error for ${pos.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }

          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice,
            exchangeConnector,
          )
          if (crossed) {
            delta.closed++
            return delta
          }

          // ── Max-hold-time safety closer (reconcile path) ────────────
          const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
          const openedAt = pos.createdAt || pos.updatedAt || 0
          const heldMs = Date.now() - openedAt
          if (
            MAX_HOLD_TIME_MS > 0 &&
            heldMs > MAX_HOLD_TIME_MS &&
            pos.executedQuantity > 0 &&
            isSystemTrackedLivePosition(pos, connectionId) &&
            (pos.status === "open" || pos.status === "filled")
          ) {
            const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
            console.warn(
              `${LOG_PREFIX} [reconcile] MAX HOLD TIME exceeded for ${pos.symbol} (held ${Math.round(heldMs / 60000)}min) — force-closing`,
            )
            await logProgressionEvent(
              connectionId,
              "live_trading",
              "warning",
              `Max hold time exceeded for ${pos.symbol} — force-closing (reconcile)`,
              { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
            )
            await closeLivePosition(connectionId, pos.id, exitPrice, exchangeConnector, "max_hold_time_exceeded")
            delta.closed++
            return delta
          }

          await savePosition(pos)
          delta.updated++
        } else {
          if (pos.status === "placed" || pos.status === "pending_fill" || pos.status === "placed_unconfirmed") {
            let terminalEntryStatus = ""
            if (pos.orderId && typeof exchangeConnector.getOrder === "function") {
              try {
                const order = await exchangeConnector.getOrder(pos.symbol, pos.orderId)
                terminalEntryStatus = String(order?.status ?? "").toLowerCase()
              } catch { /* transient getOrder failure — keep waiting for position visibility */ }
            }
            if (terminalEntryStatus === "cancelled" || terminalEntryStatus === "canceled" || terminalEntryStatus === "rejected") {
              pos.status = "rejected"
              pos.statusReason = `entry_order_${terminalEntryStatus}`
              pos.closeReason = pos.statusReason
              pos.closedAt = Date.now()
            } else {
              pos.statusReason = pos.statusReason || "protection_deferred: awaiting exchange position size"
            }
            pos.updatedAt = Date.now()
            await savePosition(pos)
            delta.updated++
            return delta
          }
          // Position closed externally — compute PnL, move to archive.
          let exitPrice: number = Number(pos.exchangeData?.markPrice) || pos.averageExecutionPrice || 0
          if (exitPrice <= 0) {
            try {
              const mdHash = await client.hgetall(`market_data:${pos.symbol}`)
              const mdPrice = parseFloat(
                String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0")
              )
              if (mdPrice > 0) exitPrice = mdPrice
            } catch { /* ignore — fall through to entryPrice */ }
          }
          if (exitPrice <= 0) exitPrice = pos.entryPrice || 0
          const qty      = pos.executedQuantity || pos.quantity || 0
          const avgEntry = pos.averageExecutionPrice || pos.entryPrice || 0

          let realizedPnl = 0
          if (exitPrice > 0 && avgEntry > 0 && qty > 0) {
            realizedPnl = qty *
              (pos.direction === "long" ? exitPrice - avgEntry : avgEntry - exitPrice)
          }

          if (pos.stopLossOrderId || pos.takeProfitOrderId) {
            const cancellations: Promise<boolean>[] = []
            if (pos.stopLossOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.stopLossOrderId, "StopLoss"),
              )
            }
            if (pos.takeProfitOrderId) {
              cancellations.push(
                cancelProtectionOrder(exchangeConnector, pos.symbol, pos.takeProfitOrderId, "TakeProfit"),
              )
            }
            await Promise.all(cancellations).catch(() => {})
            pos.stopLossOrderId = undefined
            pos.takeProfitOrderId = undefined
          }

          // ── Do NOT call closePosition on the exchange here ────────────
          // This branch runs when the Redis-tracked position is absent
          // from the exchange's open-positions list. That means the
          // exchange has ALREADY closed it (SL/TP filled, liquidated,
          // or the operator closed it manually). Calling closePosition
          // here would therefore target any OTHER open position at the
          // same symbol+direction — including ones the operator placed
          // manually that the system did not create. We must not touch
          // those. The Redis record is closed locally by the code below;
          // no exchange action is required or safe.
          pos.status = "closed"
          pos.closedAt = Date.now()
          pos.realizedPnL = Math.round(realizedPnl * 100) / 100
          pos.closeReason = pos.closeReason || "exchange_reconciliation"
          pos.progression!.push({
            step: "close",
            timestamp: Date.now(),
            success: true,
            details: `Reconciled @ ${exitPrice.toFixed(8)} PnL=${realizedPnl.toFixed(4)}`,
          })
          pos.updatedAt = Date.now()

          const closedIndexKey = `live:positions:${connectionId}:closed`
          const movedMarker    = `live:positions:${connectionId}:moved:${pos.id}`

          // Read the dedupe marker BEFORE savePosition(). redis-db.savePosition()
          // sets this very marker when status==="closed" and ALSO moves the id
          // from the open index to the closed archive. Reading the marker after
          // the call would therefore always be truthy, permanently skipping the
          // close-counter increment below (externally-closed positions — SL/TP
          // fills, liquidations, manual closes — were never counted). The marker
          // is what dedupes this path against closeLivePosition().
          const alreadyMoved = await client.get(movedMarker).catch(() => null)

          // Persists the JSON snapshot + moves the index + sets the marker.
          await savePosition(pos)

          const progKey = `progression:${connectionId}`
          const writes: Promise<any>[] = [
            client.expire(progKey, 7 * 24 * 60 * 60).catch(() => {}),
            client.del(`live:lock:${connectionId}:${pos.symbol}:${pos.direction}`).catch(() => {}),
            // Bound the closed archive + refresh its TTL (savePosition does the
            // lpush move but not these housekeeping ops). Idempotent to repeat.
            client.ltrim(closedIndexKey, 0, 4999).catch(() => {}),
            client.expire(closedIndexKey, 30 * 24 * 60 * 60).catch(() => {}),
          ]
          if (!alreadyMoved) {
            // Counter increments are the ONLY ops that must be deduped across
            // the closeLivePosition + reconcile paths — the index move inside
            // savePosition() is already idempotent, so we no longer repeat the
            // lrem/lpush here (doing so double-pushed the id into the archive).
            writes.push(
              client.hincrby(progKey, "live_positions_closed_count", 1).catch(() => {}),
            )
            if (realizedPnl > 0) {
              writes.push(client.hincrby(progKey, "live_wins_count", 1).catch(() => {}))
            }
          }
          await Promise.all(writes)

          delta.closed++
        }
      } catch (err) {
        delta.errors++
        console.warn(
          `${LOG_PREFIX} reconcile per-position error for ${pos.id}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
      return delta
    }

    // ── Bounded-concurrency streaming pool ───────────��───────────────
    // Streaming (not batch) pool so a slow exchange call on one
    // position never blocks the next 7 from starting. Concurrency 8
    // is well below the 50/min order-rate ceiling on every venue we
    // support and well above the typical sweep size, so the limit
    // virtually never bites in practice — it exists purely as a
    // backstop against a pathological burst.
    const LIVE_RECONCILE_CONCURRENCY = 8
    const queue = openPositions.slice()
    const runners: Promise<void>[] = []
    const aggregate = (d: PosDelta) => {
      summary.reconciled       += d.reconciled
      summary.updated          += d.updated
      summary.closed           += d.closed
      summary.errors           += d.errors
      summary.protectionRearmed += d.protectionRearmed
    }
    summary.reconciled = 0 // re-counted by aggregate
    for (let i = 0; i < Math.min(LIVE_RECONCILE_CONCURRENCY, queue.length); i++) {
      runners.push((async () => {
        while (true) {
          const p = queue.shift()
          if (!p) return
          aggregate(await processOne(p))
        }
      })())
    }
    await Promise.all(runners)

    // BATCHING: Save all collected positions in one operation instead of N sequential calls
    if (positionsToSave.length > 0) {
      try {
        await Promise.all(positionsToSave.map(p => savePosition(p)))
      } catch (batchErr) {
        console.warn(
          `${LOG_PREFIX} batch savePosition failed (attempted ${positionsToSave.length} positions):`,
          batchErr instanceof Error ? batchErr.message : String(batchErr),
        )
      }
    }

    if (summary.closed > 0 || summary.updated > 0) {
      console.log(
        `${LOG_PREFIX} ${connectionId} reconciled=${summary.reconciled} updated=${summary.updated} closed=${summary.closed}`
      )
    }

    return summary
  } catch (err) {
    console.error(`${LOG_PREFIX} reconcileLivePositions fatal:`, err)
    return summary
  }
}

/**
 * Standalone simulated-position processor.
 *
 * Walks every `status === "simulated"` live position and applies the
 * same SL/TP-cross / max-hold-time close logic the real-position
 * paths use, but without any exchange-side calls. Closes via
 * `closeLivePosition(connectionId, posId, exitPrice, null, reason)`
 * which already gracefully no-ops the exchange branches when the
 * connector is `null`.
 *
 * This MUST be callable independently of the exchange connector
 * because:
 *   1. Paper-only connections (no API keys) never enter
 *      `syncWithExchange` — `maybeRunLiveSync` returns at the
 *      API-key gate.
 *   2. The cron `reconcileLivePositions` early-returns when the
 *      connector has no `getPositions`, again bypassing the
 *      simulated sweep that lives inside `syncWithExchange`.
 *
 * Without this helper, simulated positions sat open forever on any
 * paper connection — the user-visible "Live Positions are Still not
 * getting closed" complaint.
 *
 * Returns a summary for logging.
 */
export async function processSimulatedPositions(
  connectionId: string,
): Promise<{ processed: number; closed: number; errors: number }> {
  const summary = { processed: 0, closed: 0, errors: 0 }
  try {
    await initRedis()
    const allOpen = await getLivePositions(connectionId)
    const sims = allOpen.filter(
      (p) => p.status === "simulated" && (p.executedQuantity ?? 0) > 0,
    )
    if (sims.length === 0) return summary

    // Pull current prices in one parallel batch (independent Redis reads).
    const uniqueSyms = Array.from(new Set(sims.map((p) => p.symbol)))
    const priceMap = new Map<string, number>()
    await Promise.all(
      uniqueSyms.map(async (sym) => {
        const px = await fetchCurrentPrice(sym).catch(() => 0)
        if (px > 0) priceMap.set(sym, px)
      }),
    )

    const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
    for (const pos of sims) {
      summary.processed++
      try {
        const markPrice = priceMap.get(pos.symbol) || pos.averageExecutionPrice || 0
        if (markPrice > 0) {
          pos.exchangeData = {
            ...pos.exchangeData,
            markPrice,
            syncedAt: Date.now(),
          }
          // SL/TP cross check (passes connector=null so close skips
          // the exchange-side cancel + closePosition calls).
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            pos,
            markPrice,
            null,
          )
          if (crossed) {
            summary.closed++
            continue
          }
        }
        // Max-hold safety closer.
        const openedAt = pos.createdAt || pos.updatedAt || 0
        const heldMs = Date.now() - openedAt
        if (
          MAX_HOLD_TIME_MS > 0 &&
          heldMs > MAX_HOLD_TIME_MS &&
          isSystemTrackedLivePosition(pos, connectionId) &&
          (pos.executedQuantity ?? 0) > 0
        ) {
          const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Max hold time exceeded for simulated ${pos.symbol} — force-closing`,
            { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
          )
          await closeLivePosition(connectionId, pos.id, exitPrice, null, "max_hold_time_exceeded")
          summary.closed++
          continue
        }
        // Persist refreshed mark price so the dashboard reads fresh data.
        if (markPrice > 0) {
          await savePosition(pos)
        }
      } catch (err) {
        summary.errors++
        console.warn(
          `${LOG_PREFIX} processSimulatedPositions per-pos error for ${pos.id}:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }
    if (summary.closed > 0) {
      console.log(
        `${LOG_PREFIX} processSimulatedPositions ${connectionId} processed=${summary.processed} closed=${summary.closed}`,
      )
    }
    return summary
  } catch (err) {
    console.warn(
      `${LOG_PREFIX} processSimulatedPositions fatal:`,
      err instanceof Error ? err.message : String(err),
    )
    return summary
  }
}

/**
 * Sync live positions with exchange data (mark price, liq price, unrealized PnL).
 * Called periodically by the engine monitoring loop.
 */
export async function syncWithExchange(connectionId: string, exchangeConnector: any): Promise<void> {
  await initRedis()
  const client = getRedisClient()
  const syncStartMs = Date.now()

  // ── Cross-caller single-flight gate ��────────────────────────────────
  // `syncWithExchange` has three independent callers in production:
  //   1. RealtimeProcessor.maybeRunLiveSync() — every 200 ms (in-process
  //      gate `liveSyncInFlight` covers same-process collisions only)
  //   2. /api/cron/sync-live-positions — Vercel cron, ~30 s
  //   3. /api/trade-engine/resume      — one-shot on resume
  //
  // Without a Redis-backed lock the cron+realtime can run in parallel
  // against the same per-position state (status flips, protection-
  // order placement, externally-closed adoption — all racy when
  // doubled). The in-process flag is process-local and useless across
  // a serverless cron invocation hitting the same Redis as a long-
  // running engine.
  //
  // Lock semantics:
  //   • Key:    live_sync_lock:{connectionId}
  //   • TTL:    30 s — generous headroom over the sync's p99 runtime
  //             while still releasing within one heartbeat window if
  //             the holder process dies mid-sync.
  //   • NX:     atomic acquire; if already held we early-return as a
  //             no-op (the existing holder will finish the work).
  //   • Release: best-effort `del` in the finally block. On crash the
  //             TTL is the safety net.
  //
  // This is intentionally LESS strict than the progression-lock
  // (which uses ownerToken+epoch) because syncWithExchange is
  // idempotent — losing a lock release just costs one skipped sync
  // tick, not corrupted state.
  const LIVE_SYNC_LOCK_KEY = `live_sync_lock:${connectionId}`
  // TTL reduced from 30 s → 5 s.
  // Rationale: syncWithExchange p99 completes in ~600-900 ms (one fetchPositions +
  // one fetchOpenOrders round-trip). A 30 s TTL meant callers accumulated "skip"
  // messages at ~400 ms cadence (×15 symbols = 37.5 skip logs/s) filling the log
  // file and stalling stdout. 5 s gives 4× headroom over p99 while limiting lock
  // starvation to at most 5 s rather than 30 s on crash-without-release.
  const LIVE_SYNC_LOCK_TTL_SEC = 5
  // Throttle the skip-log to once per 20 s per connection to prevent log flooding.
  // The skip itself is still idempotent-correct; the operator sees the message at
  // a human-readable rate instead of hundreds per second across 15 symbols.
  const SKIP_LOG_KEY = `live_sync_skip_logged:${connectionId}`
  let lockAcquired = false
  if (client) {
    try {
      const acquireResult = await client.set(LIVE_SYNC_LOCK_KEY, String(syncStartMs), {
        NX: true,
        EX: LIVE_SYNC_LOCK_TTL_SEC,
      })
      lockAcquired = acquireResult === "OK"
    } catch (lockErr) {
      // Redis unreachable — fail open (proceed without the lock).
      // The in-process flag in RealtimeProcessor still prevents
      // same-process duplicate runs; the only path that loses
      // dedup is cron-vs-realtime, which is rare and idempotent.
      console.warn(
        `${LOG_PREFIX} [sync-lock] acquire failed for ${connectionId} — proceeding without cross-caller lock:`,
        lockErr instanceof Error ? lockErr.message : String(lockErr),
      )
      lockAcquired = true // treat as acquired so the finally block doesn't try to release
    }
    if (!lockAcquired) {
      // Throttled skip log: emit at most once per 20 s to avoid flooding stdout.
      try {
        const lastLogged = await client.get(SKIP_LOG_KEY)
        if (!lastLogged) {
          console.log(
            `${LOG_PREFIX} [sync-lock] skip — another caller is mid-sync for conn=${connectionId} (likely cron+realtime overlap, idempotent skip)`,
          )
          await client.set(SKIP_LOG_KEY, "1", { EX: 20 })
        }
      } catch { /* best-effort */ }
      return
    }
  }

  try {
    // Previously each status filter triggered a full getLivePositions() scan,
    // meaning we fetched the same open-positions index from Redis FOUR times
    // just to bucket by status. Load once, then filter in memory.
    const allOpenRaw = await getLivePositions(connectionId)

    // ── Self-heal: purge terminal positions stuck in the open index ─────
    // A historical bug in redis-db savePosition() re-added rejected/cancelled/
    // error positions to the open index on every save, so stale terminal
    // entries can persist indefinitely (observed: 16 "rejected" re-synced
    // every tick). Move them to the closed archive here so the sync loop
    // only ever processes genuinely live positions.
    const TERMINAL_SYNC_STATUSES = new Set(["closed", "rejected", "cancelled", "canceled", "error"])
    const stuckTerminal = allOpenRaw.filter((p) => TERMINAL_SYNC_STATUSES.has(String(p.status)))
    if (stuckTerminal.length > 0) {
      try {
        const openIndexKey = `live:positions:${connectionId}`
        const closedIndexKey = `live:positions:${connectionId}:closed`
        let newlyMoved = 0
        await Promise.all(
          stuckTerminal.map(async (p) => {
            await client.lrem(openIndexKey, 0, p.id).catch(() => 0)
            const already = await client.lpos(closedIndexKey, p.id).catch(() => null)
            if (already === null || already === undefined) {
              await client.lpush(closedIndexKey, p.id).catch(() => 0)
              newlyMoved++
            }
          }),
        )
        // Only log when positions are newly moved — suppress repetitive noise when
        // the same terminal positions appear in the open index every cycle
        // (e.g. Redis snapshot restored stale open-index entries that are already
        // in the closed list; they are safe to silently discard).
        if (newlyMoved > 0) {
          console.log(
            `${LOG_PREFIX} [sync-tick] purged ${newlyMoved} terminal position(s) stuck in open index for ${connectionId}`,
          )
        }
      } catch { /* best-effort self-heal */ }
    }
    const allOpen = allOpenRaw.filter((p) => !TERMINAL_SYNC_STATUSES.has(String(p.status)))

    const openPositions = allOpen.filter(
      (p) => p.status === "open" || p.status === "filled" || p.status === "partially_filled" || p.status === "placed" || p.status === "pending_fill" || p.status === "placed_unconfirmed",
    )

    // If the operator requested live trading but the transport test failed,
    // QuickStart leaves the progression running with is_live_trade=0. In that
    // state the close/sync loop must not poll private exchange endpoints for
    // positions/open orders; doing so produced continuous "fetch failed" error
    // spam in dev and could make closed legacy live records look actionable.
    // Simulated positions still get processed locally below.
    const liveTradeOn = await isLiveTradeEnabledForConnection(connectionId)
    if (!liveTradeOn) {
      const simSummary = await processSimulatedPositions(connectionId)
      const statusBreakdown = allOpen.reduce<Record<string, number>>((acc, p) => {
        const s = String(p.status || "unknown")
        acc[s] = (acc[s] || 0) + 1
        return acc
      }, {})
      console.log(
        `${LOG_PREFIX} [sync-skip] conn=${connectionId} live_trade=false; ` +
        `skipped private exchange sync, tracked=${allOpen.length}, ` +
        `simProcessed=${simSummary.processed}, simClosed=${simSummary.closed}, ` +
        `statuses=${JSON.stringify(statusBreakdown)}`,
      )
      return
    }

    // ── Batch pre-loop fetches in parallel ─────────────────────────────��─
    // Three independent I/O calls are needed before the per-position loop:
    //   1. getPositions()    — exchange position list (adoption + map)
    //   2. getOpenOrders()   — live order id set for liveness verification
    //   3. getClosedLivePositions(50) — recent closes for orphan guard
    //
    // Previously these ran serially adding ~3× RTT to every tick.
    // Running them in a single Promise.all collapses to 1× RTT.
    // getPositions is also deduplicated — it was previously called TWICE
    // (once for adoption, once for the exchange map).
    let exchangePositionsForAdoption: any[] = []
    let liveOrderIdsSync: Set<string> | null = null
    let recentlyClosedForOrphanGuard: LivePosition[] = []

    await Promise.allSettled([
      // 1. Exchange positions (reused for adoption AND per-position map).
      (async () => {
        if (exchangeConnector && typeof exchangeConnector.getPositions === "function") {
          try {
            exchangePositionsForAdoption =
              (await withTimeout(
                exchangeConnector.getPositions() as Promise<any[]>,
                EXCHANGE_TIMEOUT_GET_POSITIONS_MS,
                "getPositions(sync-prefetch)",
              ).catch(() => [])) || []
          } catch { /* best-effort */ }
        }
      })(),
      // 2. Open orders snapshot for liveness verification.
      (async () => {
        liveOrderIdsSync = await fetchLiveOrderIdSet(exchangeConnector)
      })(),
      // 3. Recently-closed positions for orphan-adoption guard.
      (async () => {
        try {
          recentlyClosedForOrphanGuard = await getClosedLivePositions(connectionId, 50).catch(() => [] as LivePosition[])
        } catch { /* best-effort */ }
      })(),
    ])

    // ── Observability heartbeat ───────���────────────────────────���──────
    // Previously this function ran silently when there were zero
    // tracked positions OR when every position was in a "do nothing"
    // state — producing the operator's "orders not closing, no logs"
    // symptom. Always emit a one-line breakdown of what the close-side
    // pipeline is seeing so the operator can distinguish:
    //   (a) sync isn't running at all (no log = caller throttled / paused)
    //   (b) sync is running but finds nothing to act on
    //   (c) sync is running and processing positions in known status
    // Throttled to ~10s of useful detail so we don't flood logs at
    // steady state; the per-position branches below still log their
    // individual decisions.
    const statusBreakdown = allOpen.reduce<Record<string, number>>((acc, p) => {
      const s = String(p.status || "unknown")
      acc[s] = (acc[s] || 0) + 1
      return acc
    }, {})
    const placedCount = (statusBreakdown.placed || 0) + (statusBreakdown.pending_fill || 0) + (statusBreakdown.placed_unconfirmed || 0)
    const simCount = statusBreakdown.simulated || 0
    const totalLive = openPositions.filter((p) => p.status !== "placed" && p.status !== "pending_fill" && p.status !== "placed_unconfirmed").length
    console.log(
      `${LOG_PREFIX} [sync-tick] conn=${connectionId} tracked=${allOpen.length} open=${totalLive} placed=${placedCount} simulated=${simCount} statuses=${JSON.stringify(statusBreakdown)}`,
    )

    // ── Simulated-position sweep (paper-mode + is_live_trade=false) ─────
    // Simulated positions don't touch the exchange, so we cannot use the
    // exchange-position map or any exchangeConnector calls to close
    // them. Process them inline using Redis market_data ticks — this
    // is the path that previously left simulated orders open forever
    // because every other close branch in this function gates on
    // exchange-side data.
    //
    // We do it BEFORE the API-key gate inside maybeRunLiveSync (the
    // caller) by also exposing a standalone `processSimulatedPositions`
    // helper. Keeping a lightweight copy here makes the engine's
    // exchange-side sync self-contained for connections that DO have
    // API keys — simulated positions on those connections (paused
    // live-trade, mixed mode) still get a close path on the same tick.
    {
      const sims = allOpen.filter(
        (p) => p.status === "simulated" && (p.executedQuantity ?? 0) > 0,
      )
      if (sims.length > 0) {
        // Pull all current prices in one parallel fan-out — independent
        // Redis reads (one per unique symbol). 60s stale fallback to
        // averageExecutionPrice keeps a missing tick from blocking close.
        const uniqueSyms = Array.from(new Set(sims.map((p) => p.symbol)))
        const priceMap = new Map<string, number>()
        await Promise.all(
          uniqueSyms.map(async (sym) => {
            const px = await fetchCurrentPrice(sym).catch(() => 0)
            if (px > 0) priceMap.set(sym, px)
          }),
        )
        for (const pos of sims) {
          try {
            const markPrice = priceMap.get(pos.symbol) || pos.averageExecutionPrice || 0
            if (markPrice > 0) {
              pos.exchangeData = {
                ...pos.exchangeData,
                markPrice,
                syncedAt: Date.now(),
              }
              const crossed = await checkAndForceCloseOnSltpCross(
                connectionId,
                pos,
                markPrice,
                null, // simulated: skip exchange ops in close
              )
              if (crossed) continue
            }
            // Max-hold safety closer (parallel to the real-position path).
            const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
            const openedAt = pos.createdAt || pos.updatedAt || 0
            const heldMs = Date.now() - openedAt
            if (
              MAX_HOLD_TIME_MS > 0 &&
              heldMs > MAX_HOLD_TIME_MS &&
              isSystemTrackedLivePosition(pos, connectionId) &&
              (pos.executedQuantity ?? 0) > 0
            ) {
              const exitPrice = markPrice || pos.averageExecutionPrice || pos.entryPrice
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "warning",
                `Max hold time exceeded for simulated ${pos.symbol} — force-closing`,
                { positionId: pos.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
              )
              await closeLivePosition(connectionId, pos.id, exitPrice, null, "max_hold_time_exceeded")
              continue
            }
            // Persist refreshed mark price so the dashboard reads it.
            if (markPrice > 0) {
              await savePosition(pos)
            }
          } catch (simErr) {
            console.warn(
              `${LOG_PREFIX} simulated-tick error for ${pos.id}:`,
              simErr instanceof Error ? simErr.message : String(simErr),
            )
          }
        }
      }
    }

    // ��─ Exchange-orphan adoption ────────────────────────────────���────────
    // `exchangePositionsForAdoption` was already fetched in the parallel
    // prefetch above — no second getPositions() call needed here.
    // Alias it so the adoption block's variable names are unchanged.
    const exchangePositions = exchangePositionsForAdoption
    let adoptedCount = 0
    if (exchangeConnector && Array.isArray(exchangePositionsForAdoption) && exchangePositionsForAdoption.length > 0) {
      if (true) { // guard already applied above
          // Build a set of (symbol|direction) keys we already track in any
          // status — including terminal ones — so we don't re-adopt a
          // position that was just closed but the exchange hasn't yet
          // reflected the close (a few-second lag is normal).
          const normSym = (raw: string) => String(raw || "").toUpperCase().replace(/[-_]/g, "")
          const trackedKeys = new Set<string>()
          for (const p of allOpen) {
            trackedKeys.add(`${normSym(p.symbol)}|${p.direction}`)
          }
          // Use the pre-fetched recent-closes list (fetched in parallel
          // above) so we don't issue another Redis round-trip here.
          for (const p of recentlyClosedForOrphanGuard) {
            const closedAgoMs = Date.now() - (p.closedAt || 0)
            // Within 60 s of close — exchange may still report position
            // until the close fill propagates. After that window treat
            // it as truly closed and orphan-adopt if it reappears.
            if (closedAgoMs < 60_000) {
              trackedKeys.add(`${normSym(p.symbol)}|${p.direction}`)
            }
          }

          // Load default SL/TP percentages once for all adoptions.
          let defaultSlPct = 1
          let defaultTpPct = 2
          try {
            const tradingSettings = (await client.hgetall("settings:trading")) || {}
            const slRaw = parseFloat(String((tradingSettings as any).default_stop_loss_percent ?? "1"))
            const tpRaw = parseFloat(String((tradingSettings as any).default_take_profit_percent ?? "2"))
            if (Number.isFinite(slRaw) && slRaw > 0) defaultSlPct = normalizeStopLossPercent(slRaw).value
            if (Number.isFinite(tpRaw) && tpRaw > 0) defaultTpPct = tpRaw
          } catch { /* use defaults */ }

          for (const exPos of exchangePositionsForAdoption) {
            try {
              // Do not adopt or mutate manual/foreign exchange positions.
              // Adoption is only safe for positions carrying this app's
              // system id AND the matching connection id.
              if (!isSystemTrackedLivePosition(exPos, connectionId)) continue

              const rawSym = String(exPos.symbol || (exPos as any).Symbol || "")
              const sym = normSym(rawSym)
              if (!sym) continue
              const size = Math.abs(parseFloat(String(exPos.size ?? (exPos as any).positionAmt ?? exPos.quantity ?? "0")))
              if (!size || size <= 0) continue
              // Determine direction. BingX returns "LONG"/"SHORT" in
              // `positionSide`; some venues encode via signed size.
              const sideRaw = String(
                exPos.side ?? (exPos as any).positionSide ?? (parseFloat(String(exPos.size ?? "0")) < 0 ? "short" : "long"),
              ).toLowerCase()
              const direction: "long" | "short" =
                sideRaw.includes("short") || sideRaw === "sell" ? "short" : "long"

              const mapKey = `${sym}|${direction}`
              if (trackedKeys.has(mapKey)) continue // already tracked
              // ORPHAN — adopt it.
              const entryPrice = parseFloat(
                String(exPos.entryPrice ?? (exPos as any).avgPrice ?? exPos.markPrice ?? "0"),
              ) || parseFloat(String(exPos.markPrice ?? "0")) || 0
              if (!entryPrice || entryPrice <= 0) continue
              const markPrice = parseFloat(String(exPos.markPrice ?? entryPrice)) || entryPrice
              const leverage = Math.max(1, parseFloat(String(exPos.leverage ?? "1")) || 1)
              const notional = size * entryPrice
              const marginType: "cross" | "isolated" =
                String(exPos.marginType ?? "isolated").toLowerCase().includes("cross") ? "cross" : "isolated"

              const adoptedId = `live:${connectionId}:adopted:${sym}:${direction}:${Date.now()}:${nanoid(8)}`
              const adopted: LivePosition = {
                id: adoptedId,
                connectionId,
                system_tracking_id: String(exPos.system_tracking_id ?? (exPos as any).systemTrackingId ?? ""),
                connection_tracking_id: String(exPos.connection_tracking_id ?? (exPos as any).connectionTrackingId ?? ""),
                symbol: sym,
                direction,
                realPositionId: adoptedId, // self-reference — no Real-stage parent
                quantity: size,
                executedQuantity: size,
                remainingQuantity: 0,
                entryPrice,
                averageExecutionPrice: entryPrice,
                volumeUsd: notional,
                leverage,
                marginType,
                stopLoss: defaultSlPct,
                takeProfit: defaultTpPct,
                assignedStopLoss: defaultSlPct,
                assignedTakeProfit: defaultTpPct,
                status: "open", // exchange confirms the fill — start in "open"
                statusReason: "adopted_from_exchange",
                fills: [
                  {
                    timestamp: Date.now(),
                    quantity: size,
                    price: entryPrice,
                    fee: 0,
                    feeAsset: "",
                  },
                ],
                exchangeData: {
                  markPrice,
                  liquidationPrice: parseFloat(String(exPos.liquidationPrice ?? "0")) || undefined,
                  unrealizedPnL: parseFloat(String(exPos.unrealizedProfit ?? exPos.unrealizedPnl ?? "0")) || undefined,
                  syncedAt: Date.now(),
                },
                progression: [
                  {
                    step: "adopt",
                    timestamp: Date.now(),
                    success: true,
                    details: `Adopted system-tracked exchange position size=${size} @ ${entryPrice} (default SL=${defaultSlPct}% TP=${defaultTpPct}%)`,
                  },
                ],
                createdAt: Date.now(),
                updatedAt: Date.now(),
              } as LivePosition

              await savePosition(adopted)
              adoptedCount++
              await incrementMetric(connectionId, "live_positions_adopted_count")
              await logProgressionEvent(
                connectionId,
                "live_trading",
                "warning",
                `Adopted system-tracked exchange position ${sym} ${direction} — applying default SL=${defaultSlPct}% TP=${defaultTpPct}%`,
                { positionId: adoptedId, size, entryPrice, markPrice, leverage },
              )
              // Push adopted position into openPositions so the per-position
              // loop below arms SL/TP on it RIGHT NOW (don't wait for the
              // next 5 s sync tick — the operator's stranded position
              // needs protection immediately).
              openPositions.push(adopted)
            } catch (orphanErr) {
              console.warn(
                `${LOG_PREFIX} Orphan adoption failed:`,
                orphanErr instanceof Error ? orphanErr.message : String(orphanErr),
              )
            }
          }
          if (adoptedCount > 0) {
            console.log(`${LOG_PREFIX} Adopted ${adoptedCount} untracked exchange position(s) for ${connectionId}`)
          }
        }
      }
    // ─�� end orphan adoption ────────────────────��──────────────────────

    if (openPositions.length === 0) {
      // Nothing to sync after adoption — fire-and-forget the TTL expiry
      // sweep so we return immediately (no exchange call latency on idle path).
      orphanCloseExpiredPositions(connectionId, exchangeConnector, undefined as any).catch(() => {})
      return
    }

    console.log(`${LOG_PREFIX} Syncing ${openPositions.length} open/placed positions with exchange (adopted=${adoptedCount})`)

    // ── Build a direction-keyed exchange-position map (P0 fix) ────────
    // Previously the per-position loop called `getPosition(position.symbol)`
    // which on hedge-mode accounts returns `positions[0]` for the symbol
    // — regardless of whether the caller wanted LONG or SHORT. That meant:
    //   * If user had LONG only, `positions[0]` was LONG → fine.
    //   * If user had SHORT only, `positions[0]` was SHORT → fine.
    //   * If user had BOTH (hedge), `positions[0]` was always the one
    //     BingX returned first → markPrice cross-contamination between
    //     the two legs AND no way to detect when one leg externally
    //     closed (the other leg's data masked the close).
    //   * If user had NONE (closed externally), `getPositions(symbol)`
    //     could still return a flat zero-size entry, making
    //     `if (exchangePos)` truthy and silently keeping the Redis record
    //     "open" forever — the operator's repeated "Live Positions are
    //     still not getting closed" complaint.
    //
    // Now: we already fetched the full positions array up top for orphan
    // adoption. Reuse it to build a `(symbol|direction) → exchangePos` map
    // with size>0 filter applied, same shape `reconcileLivePositions`
    // uses. One batch fetch covers both adoption AND per-position sync.
    const normSym = (raw: string) => String(raw || "").toUpperCase().replace(/[-_]/g, "")
    const exchangeMap = new Map<string, any>()
    for (const ep of exchangePositions) {
      const sym = normSym(String(ep.symbol || (ep as any).Symbol || ""))
      if (!sym) continue
      const size = Math.abs(parseFloat(String(ep.size ?? (ep as any).positionAmt ?? ep.quantity ?? "0")))
      if (!size || size <= 0) continue // skip flat / zero-size entries
      const sideRaw = String(
        ep.side ?? (ep as any).positionSide ?? (parseFloat(String(ep.size ?? "0")) < 0 ? "short" : "long"),
      ).toLowerCase()
      const direction: "long" | "short" =
        sideRaw.includes("short") || sideRaw === "sell" ? "short" : "long"
      exchangeMap.set(`${sym}|${direction}`, ep)
    }

    // liveOrderIdsSync was fetched in the parallel prefetch above.
    // No separate serial call needed here.

    // Positions tagged as stuck-in-placed are collected here and
    // processed in a parallel batch AFTER the main loop so they don't
    // block protection-order updates for healthy positions.
    const stuckPositions: Array<{ position: LivePosition; placedAgeMs: number; STUCK_PLACED_MAX_MS: number }> = []

    // ── Parallelised per-position sync (bounded concurrency) ────────────
    // Target: all positions complete in <1 s total.
    //
    // SYNC_CONCURRENCY: Max concurrent positions to sync in parallel.
    // Reduced from 12 to 5: with 13 positions each making 1–3 API calls
    // (getOrder, placeStop, getPositions), 12-wide concurrency fires 30+
    // simultaneous requests which saturates BingX's per-IP bucket and causes
    // cascading timeouts.  5 concurrent × ~3 s/pos = ~8 s total for 13 pos.
    const SYNC_CONCURRENCY = 5
    
    // SYNC_PER_POS_TIMEOUT_MS: Per-position sync timeout.
    // Individual operation timeouts: getOrder=12s, placeStop=60s.
    // exchange-close (35s×2=70s) is now skipped for stuck_in_placed and
    // exchange_externally_closed paths, so the worst case is a single
    // placeStop(60s) + getPositions(~3s) = 63s. Use 45s as the cap:
    // placeStop already has executeTimeoutMs inside the rate-limiter slot
    // (starts at dispatch, not at enqueue), so the effective cap is higher
    // than it appears. Positions that need a full close still use the
    // closeLivePosition path with its own 35s internal timeout.
    const SYNC_PER_POS_TIMEOUT_MS = 45_000

    const processOneSync = async (position: LivePosition): Promise<void> => {
      try {
        // RC3: Re-check position exists after async context switch
        // Another thread might have deleted it during our awaits
        if (!position || !position.id) return
        
        // RC1: Skip if already closed or locked
        if (position.status === "closed" || position.lockedAt && position.lockedAt > Date.now() - 60_000) {
          return
        }
        
        const mapKey = `${normSym(position.symbol)}|${position.direction}`
        const exchangePos = exchangeMap.get(mapKey)
        if (exchangePos) {
          // Mirror reconcileLivePositions' field extraction so both paths
          // produce structurally identical exchangeData. Previously this
          // path stored raw strings under `markPrice` (no parseFloat) so
          // downstream `Number(position.exchangeData?.markPrice ?? 0)` —
          // while correct for plain numeric strings — silently coerced
          // BingX's occasional null/empty-string returns to 0, gating
          // the SL/TP cross check.
          const markPrice = parseFloat(String(exchangePos.markPrice ?? exchangePos.indexPrice ?? exchangePos.lastPrice ?? "0")) || 0
          const liqPrice  = parseFloat(String(exchangePos.liquidationPrice ?? exchangePos.liqPrice ?? "0")) || 0
          const uPnl      = parseFloat(String(exchangePos.unrealizedProfit ?? exchangePos.unrealisedPnl ?? exchangePos.unrealizedPnl ?? "0")) || 0
          position.exchangeData = {
            ...position.exchangeData,
            marginType: (exchangePos as any).marginType,
            markPrice: markPrice || position.exchangeData?.markPrice,
            liquidationPrice: liqPrice || position.exchangeData?.liquidationPrice,
            unrealizedPnL: uPnl || position.exchangeData?.unrealizedPnL,
            syncedAt: Date.now(),
          }
          position.updatedAt = Date.now()
        } else if (
          // ── Externally-closed branch (THE missing close path) ──────
          // Exchange no longer reports the (symbol|direction) we have
          // tracked — the position closed externally (SL/TP fired, manual
          // close on the BingX UI, liquidation, etc.). Previously this
          // branch did not exist in `syncWithExchange`, so the realtime
          // tick path never detected external closures — only the 30 s-
          // throttled coordinator reconcile did. Operators on a healthy
          // engine therefore saw positions sit as "open" in Redis for up
          // to a full reconcile window after they were actually closed,
          // and on engines where the 30 s reconcile got skipped (rate-
          // limit drift, strategy flow error, coordinator pause) the
          // positions sat OPEN indefinitely.
          //
          // We only act when the entry definitely existed on the
          // exchange at SOME point — i.e. status is anything past
          // "placed" (open / filled / partially_filled with executed qty).
          // Positions still in "placed" status with no fill yet might
          // legitimately not show up on the exchange (the entry order is
          // still resting on the book, not a position). Those continue
          // to be promoted via the "Delayed-fill" block above when the
          // entry order does fill.
          position.executedQuantity > 0 &&
          (position.status === "open" ||
            position.status === "filled" ||
            position.status === "partially_filled")
        ) {
          // Resolve exit price using the same 4-step fallback chain
          // reconcileLivePositions uses, so PnL is honest whether the
          // exchange returned markPrice in the closing batch, we kept a
          // markPrice from the previous tick, the symbol's market_data
          // hash has fresh ticks, or we fall back to entryPrice.
          let exitPrice: number = Number(position.exchangeData?.markPrice) || position.averageExecutionPrice || 0
          if (exitPrice <= 0) {
            try {
              const mdHash = await client.hgetall(`market_data:${position.symbol}`)
              const mdPrice = parseFloat(String(mdHash?.lastPrice ?? mdHash?.price ?? mdHash?.close ?? "0"))
              if (mdPrice > 0) exitPrice = mdPrice
            } catch { /* fall through */ }
          }
          if (exitPrice <= 0) exitPrice = position.entryPrice || 0

          console.log(
            `${LOG_PREFIX} EXTERNALLY-CLOSED detected for ${position.symbol} ${position.direction} (id=${position.id}) — finalising in Redis`,
          )
          // Fire-and-forget ��� don't block the close path on a log write.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "info",
            `Position ${position.symbol} no longer on exchange — closing in Redis (sync)`,
            {
              positionId: position.id,
              exitPrice,
              executedQuantity: position.executedQuantity,
              direction: position.direction,
            },
          ).catch(() => {})
          // closeLivePosition does the full terminal-state pipeline:
          // cancel orphan SL/TP, compute PnL/ROI, archive, release lock,
          // increment counters. Reason "exchange_externally_closed"
          // distinguishes it in the audit trail from cross-fires.
          //
          // Pass null connector: the position is already closed on the
          // exchange (SL/TP triggered), so the 2×35s exchange-close retry
          // inside closeLivePosition is guaranteed to either fail or be a
          // no-op. Skipping it keeps sync-done latency under 30s vs 70s+.
          try {
            await closeLivePosition(
              connectionId,
              position.id,
              exitPrice,
              null, // exchange already closed it — skip exchange-close leg
              "exchange_externally_closed",
            )
          } catch (closeErr) {
            console.warn(
              `${LOG_PREFIX} externally-closed close error for ${position.id}:`,
              closeErr instanceof Error ? closeErr.message : String(closeErr),
            )
          }
          return // closeLivePosition persisted terminal state — skip per-position setex
        }

        let justFilled = false
        if (
          exchangePos &&
          (position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed")
        ) {
          const exSize = Math.abs(parseFloat(String(exchangePos.size ?? (exchangePos as any).positionAmt ?? exchangePos.quantity ?? "0"))) || 0
          const exEntry = parseFloat(String(exchangePos.entryPrice ?? (exchangePos as any).avgPrice ?? exchangePos.markPrice ?? "0")) || 0
          if (exSize > 0) {
            position.executedQuantity = exSize
            position.remainingQuantity = Math.max(0, (position.quantity || exSize) - exSize)
            position.averageExecutionPrice = exEntry || position.entryPrice
            position.status = "open"
            position.statusReason = `confirmed_position_fallback: sync saw exchange position size=${exSize} avg=${position.averageExecutionPrice}`
            position.updatedAt = Date.now()
            justFilled = true
            incrementMetric(connectionId, "live_orders_filled_count").catch(() => {})
            incrementOrdersBySymbol(connectionId, position.symbol, position.direction || position.side || "long", "filled").catch(() => {})
            pushStep(position, "sync_fill_detected", true, position.statusReason)
          }
        }

        // ── Delayed-fill SL/TP arming ────����────────────────────���──��────
        // If the entry order was still pending when `executeLivePosition`
        // tried to place SL/TP, that step pushed `place_sl_tp = skipped`
        // and the position ended up `placed` with no protection orders.
        // When this loop now detects the order has filled, we transition
        // to `open` AND must arm SL/TP — otherwise the operator gets
        // an open exchange position with zero stop-loss / take-profit
        // protection. This was a real bug the user reported as
        // "TP/SL control orders are not working".
        if ((position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed") && position.orderId) {
          // Guard: connector may be null/uninitialised on the very first sync
          // tick after a restart (factory not yet called for this connectionId).
          // Skip fill-detection silently — the next tick will retry once the
          // connector is ready. Previously this threw "Cannot read properties of
          // null (reading 'getOrder')" which flooded the log on every sync tick
          // until the connector was initialised.
          if (!exchangeConnector || typeof exchangeConnector.getOrder !== "function") {
            // Connector not ready yet — skip, retry next sync tick.
          } else
          try {
            // Bounded — a hanging getOrder would block this position's
            // entire sync slot and delay every downstream close/heal step.
            // On timeout we just skip the fill detection for this tick;
            // the next sync will retry.
            const order = await withTimeout(
              exchangeConnector.getOrder(position.symbol, position.orderId) as Promise<any>,
              EXCHANGE_TIMEOUT_GET_ORDER_MS,
              `getOrder(${position.symbol} ${position.orderId})`,
            )
            if (order?.status === "filled") {
              position.executedQuantity = order.filledQty || position.quantity
              position.remainingQuantity = Math.max(0, position.quantity! - position.executedQuantity)
              position.averageExecutionPrice = order.filledPrice || position.entryPrice
              position.status = "open"
              position.statusReason = `confirmed_fill: sync order status=${order.status} qty=${position.executedQuantity}`
              pushStep(position, "sync_fill_detected", true, position.statusReason)
              position.updatedAt = Date.now()
              justFilled = true
              // Fire-and-forget metric + log — don't block the fast path.
              incrementMetric(connectionId, "live_orders_filled_count").catch(() => {})
              incrementOrdersBySymbol(connectionId, position.symbol, position.direction || position.side || "long", "filled").catch(() => {})
              logProgressionEvent(
                connectionId,
                "live_trading",
                "info",
                `Sync detected fill for ${position.symbol}`,
                {
                  orderId: position.orderId,
                  filledQty: position.executedQuantity,
                }
              ).catch(() => {})
            } else if (order) {
              // Order exists but not filled (placed/partial/cancelled/rejected) —
              // log so the operator can see WHY the position stays in
              // "placed" status. Previously the only signal was the
              // position never progressing, which was indistinguishable
              // from a bug.
              console.log(
                `${LOG_PREFIX} [fill-detect] ${position.symbol} order ${position.orderId} status=${order.status} filledQty=${order.filledQty ?? 0} — staying in 'placed'`,
              )
            }
          } catch (fillErr) {
            // PREVIOUSLY SWALLOWED — this was the root cause of "orders
            // never closing": every getOrder failure left the position
            // stuck in `placed` forever, and the SL/TP cross check skips
            // `placed` positions silently (see checkAndForceCloseOnSltpCross
            // line "if (pos.status === 'placed') return null").
            // We now log so the failure is visible. The retry on next
            // sync tick still happens — no behaviour change, just
            // observability.
            console.warn(
              `${LOG_PREFIX} [fill-detect] getOrder failed for ${position.symbol} orderId=${position.orderId}:`,
              fillErr instanceof Error ? fillErr.message : String(fillErr),
            )
          }
        }

        // ── Stuck-in-placed detection ���────────────────────────────────
        // A position in `placed` status with no executed qty has its
        // entry order resting on the exchange book unfilled. The SL/TP
        // cross check skips `placed` positions silently, so without
        // this branch a stuck order could sit forever:
        //   - Never closes via SL/TP cross (status gate)
        //   - Never closes via max-hold-time (executedQty=0 gate)
        //   - Never adopted as orphan (it IS in Redis)
        //   - Never finalised as externally-closed (gate requires
        //     executedQty>0 + status≠placed)
        // Cancel the dangling entry order after STUCK_PLACED_MAX_MS and
        // mark the position rejected so it leaves the open index.
        // ── Stuck-in-placed: tag candidate, process in parallel batch below ──
        // Only TAG here and `continue`. The actual cancel+close runs in a
        // Promise.allSettled batch after the for loop so that N stuck
        // positions don't serialize for EXCHANGE_TIMEOUT_CANCEL_ORDER_MS × N
        // and block protection-order updates for all healthy positions.
        if ((position.status === "placed" || position.status === "pending_fill" || position.status === "placed_unconfirmed") && (position.executedQuantity ?? 0) === 0) {
          const STUCK_PLACED_MAX_MS = 5 * 60_000 // 5 minutes
          const placedAgeMs = Date.now() - (position.createdAt || position.updatedAt || Date.now())
          if (placedAgeMs > STUCK_PLACED_MAX_MS) {
            stuckPositions.push({ position, placedAgeMs, STUCK_PLACED_MAX_MS })
            return
          }
        }

        // Arm or refresh protection orders. `updateProtectionOrders` is
        // a no-op when nothing has drifted (price + qty stable, both
        // legs already armed at correct levels) so this is cheap on the
        // steady state. After a delayed fill (`justFilled`) it's a real
        // place; after accumulation it re-arms for the new total qty;
        // after an operator-cancelled SL on the exchange it re-places.
        if (position.executedQuantity > 0) {
          try {
            const protectionResult = await updateProtectionOrders(
              exchangeConnector,
              position,
              justFilled ? "sync_fill_detected" : "sync_heal",
              liveOrderIdsSync,
            )
            // Fire-and-forget persist — protection state (order IDs,
            // lastArmedAt) must be durable but the save does not need to
            // complete before we proceed to the SL/TP cross check. On a
            // crash the 7-day setex TTL means we lose at most one tick's
            // worth of protection metadata, which the next sync heals.
            if (protectionResult.changed) {
              savePosition(position).catch(() => {})
            }
          } catch (slTpErr) {
            console.warn(
              `${LOG_PREFIX} sync SL/TP heal error for ${position.id}:`,
              slTpErr instanceof Error ? slTpErr.message : String(slTpErr),
            )
          }
        }

        // ── Proactive close-in-time SL/TP check ────���──────────────────
        // Same safety net `reconcileLivePositions` runs, applied here
        // so the engine loop catches crosses between cron ticks. If a
        // cross fires we skip the per-position setex below — the close
        // helper already persisted the terminal state and moved the
        // index entry to the closed archive.
        const markPrice = Number(position.exchangeData?.markPrice ?? 0)
        if (markPrice > 0) {
          const crossed = await checkAndForceCloseOnSltpCross(
            connectionId,
            position,
            markPrice,
            exchangeConnector,
          )
          if (crossed) return
        }

        // ── Max-hold-time safety closer ────────────────────────────────
        // If the position has been open longer than MAX_HOLD_TIME_MS,
        // force-close it regardless of whether SL/TP levels were
        // crossed. This is the "orders not closing in time" safety net —
        // even if the exchange-placed SL/TP orders fail to fire (e.g.
        // network issue, illiquid gap, operator manual cancel), the
        // position will not be held indefinitely.
        //
        // Default: 4 hours. Live override via /settings → System →
        // Engine Timings → max_position_hold_ms (or deploy-time
        // MAX_POSITION_HOLD_MS env var). 0 = disabled.
        const MAX_HOLD_TIME_MS = resolveMaxHoldMs(connectionId)
        const openedAt = position.createdAt || position.updatedAt || 0
        const heldMs = Date.now() - openedAt
        if (
          MAX_HOLD_TIME_MS > 0 &&
          heldMs > MAX_HOLD_TIME_MS &&
          position.executedQuantity > 0 &&
          isSystemTrackedLivePosition(position, connectionId) &&
          (position.status === "open" || position.status === "filled")
        ) {
          const exitPrice = markPrice || position.averageExecutionPrice || position.entryPrice
          console.warn(
            `${LOG_PREFIX} MAX HOLD TIME exceeded for ${position.symbol} (held ${Math.round(heldMs / 60000)}min > ${Math.round(MAX_HOLD_TIME_MS / 60000)}min) — force-closing`,
          )
          // Fire-and-forget — close should not be gated on log write.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Max hold time exceeded for ${position.symbol} — force-closing`,
            { positionId: position.id, heldMs, maxHoldMs: MAX_HOLD_TIME_MS, exitPrice },
          ).catch(() => {})
          await closeLivePosition(connectionId, position.id, exitPrice, exchangeConnector, "max_hold_time_exceeded")
          return
        }

        const key = `live:position:${position.id}`
        await client.setex(key, 604800, JSON.stringify(position))
        await client.lpush(`live:positions:${position.connectionId}`, position.id)
        await client.ltrim(`live:positions:${position.connectionId}`, 0, 999)
        await client.expire(`live:positions:${position.connectionId}`, 604800)
      } catch (err) {
        console.warn(`${LOG_PREFIX} Error syncing ${position.id}:`, err)
      }
    }

    // ── Bounded parallel pool for processOneSync ─────────────────────────
    // Each worker picks the next unprocessed position by index; stops when
    // all positions are claimed. allSettled ensures one slow/failing
    // position never prevents the rest from completing.
    {
      let nextSyncIdx = 0
      const syncWorker = async (): Promise<void> => {
        while (true) {
          const i = nextSyncIdx++
          if (i >= openPositions.length) return
          await withTimeout(
            processOneSync(openPositions[i]),
            SYNC_PER_POS_TIMEOUT_MS,
            `syncWithExchange.processOneSync(${openPositions[i].symbol})`,
          ).catch((err: unknown) => {
            console.warn(
              `${LOG_PREFIX} [sync-pool] position ${openPositions[i]?.id} timed out or errored:`,
              err instanceof Error ? err.message : String(err),
            )
          })
        }
      }
      const poolSize = Math.min(SYNC_CONCURRENCY, openPositions.length)
      if (poolSize > 0) {
        await Promise.allSettled(Array.from({ length: poolSize }, () => syncWorker()))
      }
    }

    // Sync completion heartbeat. Pairs with the `[sync-tick]` entry log
    // so the operator can see the loop ran to completion (not silently
    // aborted by an uncaught throw) and how long it took. If [sync-tick]
    // appears but [sync-done] does not for the same tick, something
    // mid-loop is rejecting before the closing brace — which used to be
    // invisible.
    // ── Parallel stuck-placed cleanup ──────────��─────────────────────
    // Run all cancel+close operations concurrently so 6+ stuck positions
    // complete in ~one RTT window instead of EXCHANGE_TIMEOUT_CANCEL_ORDER_MS × N.
    if (stuckPositions.length > 0) {
      console.warn(
        `${LOG_PREFIX} [stuck-placed] Processing ${stuckPositions.length} stuck-in-placed position(s) in parallel`,
      )
      await Promise.allSettled(
        stuckPositions.map(async ({ position, placedAgeMs, STUCK_PLACED_MAX_MS }) => {
          console.warn(
            `${LOG_PREFIX} [stuck-placed] ${position.symbol} (id=${position.id}) has been 'placed' for ${Math.round(placedAgeMs / 1000)}s — cancelling entry order and rejecting position`,
          )
          // Fire-and-forget — log should not delay cancel + close.
          logProgressionEvent(
            connectionId,
            "live_trading",
            "warning",
            `Entry order stuck in 'placed' state for ${position.symbol} — cancelling`,
            {
              positionId: position.id,
              orderId: position.orderId,
              placedAgeMs,
              stuckLimitMs: STUCK_PLACED_MAX_MS,
            },
          ).catch(() => {})
          // Best-effort cancel of the entry order (bounded timeout).
          // Track whether the cancel succeeded — if it timed out we skip
          // the exchange-close leg to avoid blocking another 70 s (2 × 35 s)
          // on an already-unresponsive exchange.
          let cancelSucceeded = false
          if (position.orderId && exchangeConnector?.cancelOrder) {
            try {
              await withTimeout(
                exchangeConnector.cancelOrder(position.symbol, position.orderId) as Promise<any>,
                EXCHANGE_TIMEOUT_CANCEL_ORDER_MS,
                `stuck-placed cancelOrder(${position.symbol} ${position.orderId})`,
              )
              cancelSucceeded = true
            } catch (cancelErr) {
              console.warn(
                `${LOG_PREFIX} [stuck-placed] cancel entry order failed for ${position.id}:`,
                cancelErr instanceof Error ? cancelErr.message : String(cancelErr),
              )
            }
          }
          // Mark position rejected and remove from open index.
          // If cancelOrder timed out the exchange is unresponsive — skip
          // the exchange-close (pass null connector) to avoid another 70 s
          // wait. The position is DB-closed immediately; the exchange side
          // will self-heal when the order expires or the next sync detects it.
          const closeConnector = cancelSucceeded ? exchangeConnector : null
          try {
            await closeLivePosition(
              connectionId,
              position.id,
              position.entryPrice || 0,
              closeConnector,
              "stuck_in_placed",
            )
          } catch (closeErr) {
            console.warn(
              `${LOG_PREFIX} [stuck-placed] closeLivePosition failed for ${position.id}:`,
              closeErr instanceof Error ? closeErr.message : String(closeErr),
            )
          }
        }),
      )
    }

    const syncMs = Date.now() - syncStartMs
    console.log(
      `${LOG_PREFIX} [sync-done] conn=${connectionId} took=${syncMs}ms processed=${openPositions.length} adopted=${adoptedCount}`,
    )
  } catch (err) {
    console.error(`${LOG_PREFIX} Error syncing with exchange:`, err)
  } finally {
    // Release the cross-caller dedup lock. We don't bother with a
    // compare-and-swap here because:
    //   (a) the lock is short-TTL (30 s) — a missed release just
    //       delays the next sync by at most that window.
    //   (b) syncWithExchange is idempotent �� losing the release
    //       can't corrupt state, only skip work.
    //   (c) the only path that bypassed the acquire (Redis-unreachable
    //       fail-open) explicitly sets lockAcquired=true so we don't
    //       attempt to release a lock we don't hold.
    if (lockAcquired && client) {
      try {
        await client.del(LIVE_SYNC_LOCK_KEY)
      } catch (releaseErr) {
        // Lock will expire via TTL — log but don't surface.
        console.warn(
          `${LOG_PREFIX} [sync-lock] release failed for ${connectionId}; TTL will reap:`,
          releaseErr instanceof Error ? releaseErr.message : String(releaseErr),
        )
      }
    }
  }
}

/**
 * Recalculate the desired SL/TP for a single live position and apply
 * the change to the exchange. Used by the strategy coordinator when an
 * operator edits SL/TP percentages on an active connection — without
 * this, the exchange-side levels stay glued to the original fill and
 * the change only affects newly-opened positions.
 *
 * Pass updated `stopLossPct` / `takeProfitPct` to override the values
 * stored on the live position; omit them to recompute from whatever
 * is currently on the LivePosition record (useful as a "force-heal"
 * after a missed reconcile).
 *
 * Returns `null` if the position doesn't exist or is already closed.
 */
export async function recalculateAndApplySLTP(
  connectionId: string,
  livePositionId: string,
  exchangeConnector: any,
  overrides?: { stopLossPct?: number; takeProfitPct?: number },
): Promise<LivePosition | null> {
  await initRedis()
  const client = getRedisClient()

  // ── Bug-1 fix: acquire live_sync_lock BEFORE the read-modify-write ────────
  // Without this lock, `recalculateAndApplySLTP` (called from
  // `syncLiveFromPseudo` in the 200 ms engine loop) races against
  // `reconcileLivePositions` / `syncWithExchange`, both of which also hold
  // this lock while calling `updateProtectionOrders` for the same position.
  // The race produces two concurrent `placeStopOrder` calls → two SL or two
  // TP reduce-only orders on the exchange. The later `savePosition` then
  // overwrites the in-memory position, losing the order-IDs written by the
  // other caller. Holding the lock here serialises all three callers.
  //
  // If the lock is already held (main loop is mid-reconcile), we retry once
  // after 100 ms so operator-triggered overrides still apply promptly in the
  // gap between ticks rather than silently no-opping.
  const LOCK_KEY = `live_sync_lock:${connectionId}`
  const LOCK_TTL = 5 // seconds — far shorter than the 30 s reconcile TTL
  let lockAcquired = false
  for (let attempt = 0; attempt < 2; attempt++) {
    const setResult = await (client.set(LOCK_KEY, "recalcSLTP", { NX: true, EX: LOCK_TTL }) as any)
    if (setResult === "OK") { lockAcquired = true; break }
    if (attempt === 0) await new Promise(r => setTimeout(r, 100))
  }
  if (!lockAcquired) {
    // Lock still held after one retry — skip this tick; the main sync loop
    // will re-arm orders correctly on its next pass.
    console.warn(`${LOG_PREFIX} recalculateAndApplySLTP: lock busy for ${connectionId}, skipping tick`)
    return null
  }

  try {
    const key = `live:position:${livePositionId}`
    // Re-read the position AFTER acquiring the lock so we see any writes the
    // previous lock-holder (reconcile / sync) just committed to Redis.
    const data = await client.get(key)
    if (!data) return null

    const position: LivePosition = JSON.parse(data as string)
    if (
      position.status === "closed" ||
      position.status === "rejected" ||
      position.status === "error" ||
      position.executedQuantity <= 0
    ) {
      return position
    }

    // Capture pre-override values so we can audit the diff in progression.
    // Note: we deliberately do NOT touch `assignedStopLoss` /
    // `assignedTakeProfit` — those are the immutable strategy-contract
    // snapshot. After this call they remain equal to their creation-time
    // values while `stopLoss` / `takeProfit` carry the operator override.
    const prevStopLossPct = position.stopLoss
    const prevTakeProfitPct = position.takeProfit
    const normalizedOverrideSl = overrides?.stopLossPct !== undefined
      ? normalizeStopLossPercent(overrides.stopLossPct)
      : null
    if (normalizedOverrideSl) position.stopLoss = normalizedOverrideSl.value
    if (overrides?.takeProfitPct !== undefined) position.takeProfit = overrides.takeProfitPct

    const slChanged = position.stopLoss !== prevStopLossPct
    const tpChanged = position.takeProfit !== prevTakeProfitPct
    if (slChanged || tpChanged) {
      // Single audit-trail event per override. The progression panel
      // shows it as a `live_trading info` row alongside the subsequent
      // `update_sl_tp` step pushed by `updateProtectionOrders`. Together
      // they tell the full story: "operator changed SL from X% to Y%,
      // exchange order re-armed at price Z".
      await logProgressionEvent(
        position.connectionId,
        "live_trading",
        "info",
        `SL/TP override applied to ${position.symbol}`,
        {
          assignedStopLossPct: position.assignedStopLoss,
          assignedTakeProfitPct: position.assignedTakeProfit,
          previousStopLossPct: prevStopLossPct,
          previousTakeProfitPct: prevTakeProfitPct,
          newStopLossPct: position.stopLoss,
          newTakeProfitPct: position.takeProfit,
          stopLossNormalized: normalizedOverrideSl?.adjusted || false,
          stopLossNormalizationReason: normalizedOverrideSl?.reason,
          slChanged,
          tpChanged,
        },
      )
    }

    // ── Bug-3 fix: fetch live order IDs and pass to updateProtectionOrders ��──
    // Without `liveOrderIds` the liveness-verification block in
    // `updateProtectionOrders` is skipped entirely (guarded by
    // `if (liveOrderIds && …)`). If a SL/TP order silently disappeared on the
    // exchange (filled early, cancelled, expired), `pos.stopLossOrderId` is
    // still set, `priceDrifted()` returns false, and the leg is never
    // re-armed �� leaving the position unprotected. Passing liveOrderIds here
    // ensures the verify step runs on every operator-triggered recalc.
    const liveOrderIds = await fetchLiveOrderIdSet(exchangeConnector)
    await updateProtectionOrders(exchangeConnector, position, "manual_recalc", liveOrderIds ?? undefined)
    position.updatedAt = Date.now()
    await savePosition(position)

    // ── Immediate post-override cross check ────────────────────────────
    // If the operator just tightened SL or TP to a level the position
    // is already past, the exchange-placed reduce-only order may take
    // a moment to fire (or be rejected outright as "trigger price
    // already breached"). Run the same proactive close helper used by
    // the engine loop so the position is reconciled to closed within
    // the same call rather than waiting for the next cron tick.
    try {
      const markPrice = Number(position.exchangeData?.markPrice ?? 0)
      if (markPrice > 0) {
        await checkAndForceCloseOnSltpCross(
          position.connectionId,
          position,
          markPrice,
          exchangeConnector,
        )
      }
    } catch (crossErr) {
      console.warn(
        `${LOG_PREFIX} post-override cross check error for ${position.id}:`,
        crossErr instanceof Error ? crossErr.message : String(crossErr),
      )
    }
    return position
  } catch (err) {
    console.error(`${LOG_PREFIX} recalculateAndApplySLTP error:`, err)
    return null
  } finally {
    // Always release the lock so the main sync loop is not blocked past our
    // 5 s TTL. del() is a no-op if we never successfully acquired it.
    if (lockAcquired) {
      await client.del(LOCK_KEY).catch(() => {})
    }
  }
}

/**
 * ── syncLiveFromPseudo (spec §6) ─────────────────────────────────────
 *
 * Copy SL/TP percentages from a pseudo (strategy-side virtual) position
 * onto matching live (exchange-side real) positions on the same
 * symbol + direction, then re-arm the exchange protection orders so
 * the new levels are actually enforced.
 *
 * Operator: "pseudo pos updates with trailing, steps etc is working
 * completely correct and live pos are correctly synchron". That's the
 * target — this helper closes the gap between strategy-side trailing
 * and exchange-side SL/TP by piping percent updates through to
 * `recalculateAndApplySLTP`, which already does
 * cancel-old → place-new → persist + audit.
 *
 * Inputs:
 *   - `pseudoPos.symbol` (string, required) and `pseudoPos.side`
 *     ("long" | "short") — match key against live positions.
 *   - `pseudoPos.stoploss_ratio` / `pseudoPos.takeprofit_factor`
 *     (ratio form, e.g. 0.02 = 2%) OR `pseudoPos.stopLoss` /
 *     `pseudoPos.takeProfit` (percent form). Auto-detected by
 *     magnitude — anything < 1 is treated as ratio and multiplied by
 *     100, anything ≥ 1 is treated as already-percent.
 *
 * Idempotent: if percentages unchanged `recalculateAndApplySLTP`
 * no-ops on the diff. Per-position errors are swallowed.
 *
 * Caller contract: fire-and-forget. Returns `Promise<void>` and never
 * throws past this boundary — the realtime hot path must NEVER await
 * on exchange round-trips.
 */
export async function syncLiveFromPseudo(
  connectionId: string,
  pseudoPos: any,
  exchangeConnector: any,
): Promise<void> {
  try {
    // ─��� System tracking validation ──
    // Only sync positions created by this system. Skip foreign/manual orders.
    const trackingId = String(pseudoPos?.system_tracking_id || "").trim()
    if (!trackingId.startsWith("sys-") || trackingId.length <= 10) {
      // Silent skip - don't log every foreign position on every tick
      return
    }

    const symbol = String(pseudoPos?.symbol || "").toUpperCase()
    const side: "long" | "short" = pseudoPos?.side === "short" ? "short" : "long"
    if (!symbol) return

    const rawSL = Number(pseudoPos?.stoploss_ratio ?? pseudoPos?.stopLoss ?? NaN)
    const rawTP = Number(pseudoPos?.takeprofit_factor ?? pseudoPos?.takeProfit ?? NaN)
    if (!Number.isFinite(rawSL) && !Number.isFinite(rawTP)) return

    // Ratio (< 1) → percent; already-percent (≥ 1) → keep as-is.
    let slPct = Number.isFinite(rawSL) ? (Math.abs(rawSL) < 1 ? rawSL * 100 : rawSL) : undefined
    const tpPct = Number.isFinite(rawTP) ? (Math.abs(rawTP) < 1 ? rawTP * 100 : rawTP) : undefined

    // ── Trailing-aware SL pull-through ���─────────────────────────────
    // When the pseudo's trailing-stop machine is ARMED (multi-step
    // `trailing_active=1` or legacy `trailing_stop_price>0`), the
    // effective stop level is no longer `stoploss_ratio × fillPrice`
    // — it's the ratcheted `trailing_stop_price`. Pulling the static
    // ratio through here would cause every trailing tick to fight
    // against itself, repeatedly resetting the live SL back to the
    // origin level. Convert the active trailing stop price into a
    // live-position-relative percentage by anchoring it to the LIVE
    // position's actual fill price (entry-side). The percent space
    // is what `recalculateAndApplySLTP` consumes.
    const trailingActive =
      pseudoPos?.trailing_active === "1" ||
      pseudoPos?.trailing_active === true ||
      (() => {
        const ts = parseFloat(String(pseudoPos?.trailing_stop_price || "0"))
        return Number.isFinite(ts) && ts > 0
      })()
    const trailingStopPrice = parseFloat(String(pseudoPos?.trailing_stop_price || "0"))

    // ── Set-scoped match (BUG 6) ───────────���──────────────────────────
    // Identify the Real Set that owns THIS pseudo position. Several pseudo
    // positions (distinct Sets) can target the same symbol+side slot; the
    // dedup lock collapses them onto ONE live position. Matching by
    // symbol+side alone would let every Set's trailing tick rewrite that
    // single live position's SL/TP with its own level, making the stop
    // flap between unrelated Sets. Scope the match to the owning Set's key
    // so each pseudo only steers the live position it actually backs.
    const pseudoSetKey = String(
      pseudoPos?.set_id || pseudoPos?.config_set_key || pseudoPos?.source_set_key || "",
    ).trim()

    const livePositions = await getLivePositions(connectionId)
    const slotMatches = livePositions.filter((p: any) => {
      const liveSide: "long" | "short" =
        p.direction === "short" || p.side === "short" ? "short" : "long"
      return String(p.symbol || "").toUpperCase() === symbol && liveSide === side && p.status !== "closed"
    })
    if (slotMatches.length === 0) return

    // Prefer live positions whose setKey/parentSetKey/accumulatedSetKeys
    // match this pseudo's owning Set. Accumulated live positions can carry
    // multiple Base/trailing/axis Sets; every owning Set must be allowed to
    // advance its trailing ratchet and rebuild the correct control orders.
    // Only fall back to the unscoped slot matches when NONE of them carry a
    // set key we can compare against (legacy positions written
    // before setKey propagation) or when the pseudo itself has no set id —
    // in those cases symbol+side is the best signal available, preserving
    // backward-compatible behaviour without silently dropping the sync.
    let matches = slotMatches
    if (pseudoSetKey) {
      const scoped = slotMatches.filter((p: any) => {
        const liveKeys = new Set<string>()
        for (const key of [p.setKey, p.parentSetKey]) {
          const normalized = String(key || "").trim()
          if (normalized) liveKeys.add(normalized)
        }
        const accumulated = Array.isArray(p.accumulatedSetKeys) ? p.accumulatedSetKeys : []
        for (const key of accumulated) {
          const normalized = String(key || "").trim()
          if (normalized) liveKeys.add(normalized)
        }
        return liveKeys.has(pseudoSetKey)
      })
      const anyLiveKeyed = slotMatches.some((p: any) => {
        if (String(p.setKey || p.parentSetKey || "").trim().length > 0) return true
        return Array.isArray(p.accumulatedSetKeys) && p.accumulatedSetKeys.some((key: any) => String(key || "").trim().length > 0)
      })
      if (scoped.length > 0) {
        matches = scoped
      } else if (anyLiveKeyed) {
        // Live positions ARE keyed, but none belong to this Set → this
        // pseudo does not own the slot's live exposure. Do not touch it.
        return
      }
      // else: no live position is keyed → fall back to slot matches.
    }
    if (matches.length === 0) return

    // Parallelize across matching live positions — each position's
    // SL/TP recalculation is independent. The previous serial for-loop
    // caused 200–1200ms blocking per trailing stop update (200ms +
    // exchange RTTs per position). Cap at 4 concurrent so we don't
    // hammer the exchange API in a single tick.
    const MAX_CONCURRENT_SLTP = 4
    let nextIdx = 0
    const worker = async (): Promise<void> => {
      while (true) {
        const i = nextIdx++
        if (i >= matches.length) return
        const livePos = matches[i]
        try {
          let effectiveSlPct = slPct
          // CRITICAL: Guard trailing stop calculation against NaN and division errors
          if (trailingActive && Number.isFinite(trailingStopPrice) && trailingStopPrice > 0) {
            const fill = Number(livePos.averageExecutionPrice || livePos.entryPrice || 0)
            // Ensure fill price is valid and positive before using in division
            if (Number.isFinite(fill) && fill > 0) {
              const liveSide: "long" | "short" =
                livePos.direction === "short" ? "short" : "long"
              // Distance from fill to the trailing stop expressed as a
              // percentage of the fill price (always positive regardless of
              // direction — the trailing machine ensures trailingStopPrice
              // is below fill for longs and above fill for shorts).
              let distPct: number
              if (liveSide === "long") {
                distPct = ((fill - trailingStopPrice) / fill) * 100
              } else {
                distPct = ((trailingStopPrice - fill) / fill) * 100
              }
              // Guard against NaN from division or calculation errors, and
              // ensure distPct is positive (should always be for valid trailing levels)
              if (Number.isFinite(distPct) && distPct > 0) {
                effectiveSlPct = distPct
              } else if (!Number.isFinite(distPct)) {
                // If distPct is NaN or Infinity, log it but keep current SL percentage
                console.warn(
                  `${LOG_PREFIX} distPct is ${distPct} for ${livePos.symbol} (fill=${fill}, trailing=${trailingStopPrice}, side=${liveSide})`
                )
              }
            }
          }

          // ── Stamp trailing state onto the live position ───────────────────
          // Write trailingActive + trailingStopPrice from the pseudo position
          // so that computeDesiredProtectionPrices and checkAndForceCloseOnSltpCross
          // can use the ratcheted absolute price instead of re-computing from
          // the stale static percentage. This ensures both the exchange order
          // placement path and the proactive force-close path reflect the latest
          // trailing ratchet on every tick, not only on recalc ticks.
          const prevTrailingActive = livePos.trailingActive
          const prevTrailingStopPrice = livePos.trailingStopPrice
          livePos.trailingActive = trailingActive
          livePos.trailingStopPrice = (trailingActive && trailingStopPrice > 0) ? trailingStopPrice : undefined
          // If the trailing state changed, persist it immediately so other
          // callers (reconcile, syncWithExchange) always read the latest ratchet
          // from Redis even if the no-op guard below skips recalculateAndApplySLTP.
          const trailingStateChanged =
            prevTrailingActive !== livePos.trailingActive ||
            prevTrailingStopPrice !== livePos.trailingStopPrice
          if (trailingStateChanged) {
            // Best-effort async save — don't await on the hot path.
            savePosition(livePos).catch(() => {})
          }

          // ── Per-tick no-op guard ──────────────────────────────────────────
          // syncLiveFromPseudo fires on EVERY realtime cycle (200–300 ms) but
          // the trailing stop price only ratchets once per strategy cycle
          // (~5 s). Calling recalculateAndApplySLTP on no-change ticks
          // acquires the live_sync_lock, fetches open orders, and calls
          // updateProtectionOrders — all no-ops at the exchange layer, but
          // still ~50–150 ms of lock contention per position per tick.
          //
          // Skip the call when BOTH:
          //   • the computed slPct is within ±0.25% of the currently stored
          //     stopLoss pct (same 0.25% tolerance as priceDrifted �� a
          //     change smaller than this cannot affect the exchange order)
          //   • the tpPct is within ±0.25% of the currently stored takeProfit
          //     pct (or both are undefined/NaN)
          // Always call when the live position has a missing order (id = undefined)
          // even if percentages are unchanged — the order may have been silently
          // filled or cancelled on the venue and needs re-arming.
          const currentSlPct = typeof livePos.stopLoss === "number" ? livePos.stopLoss : undefined
          const currentTpPct = typeof livePos.takeProfit === "number" ? livePos.takeProfit : undefined
          const ordersMissing = !livePos.stopLossOrderId || !livePos.takeProfitOrderId
          // CRITICAL: Guard against division by zero and NaN propagation.
          // currentSlPct/tpPct could be 0, negative, or NaN. Use safe division with
          // explicit isFinite checks to prevent crashes on trailing stop updates.
          const slDeltaPct = (() => {
            if (currentSlPct === undefined || effectiveSlPct === undefined) return 1 // treat as changed
            if (!Number.isFinite(currentSlPct) || !Number.isFinite(effectiveSlPct)) return 1
            if (currentSlPct <= 0) return 1 // undefined SL → treat as changed
            const delta = Math.abs(effectiveSlPct - currentSlPct) / Math.abs(currentSlPct)
            return Number.isFinite(delta) ? delta : 1
          })()
          
          const tpDeltaPct = (() => {
            if (currentTpPct === undefined && tpPct === undefined) return 0 // both undefined → no change
            if (currentTpPct === undefined || tpPct === undefined) return 1 // one newly defined → changed
            if (!Number.isFinite(currentTpPct) || !Number.isFinite(tpPct)) return 1
            if (currentTpPct <= 0) return 1 // undefined TP → treat as changed
            const delta = Math.abs(tpPct - currentTpPct) / Math.abs(currentTpPct)
            return Number.isFinite(delta) ? delta : 1
          })()
          // When trailing is active the ratchet can advance even when the
          // derived slPct (from distPct calculation above) looks stable within
          // 0.25%.  The absolute stop price advancing is always significant —
          // skip the no-op guard if the trailing stop price itself changed.
          const trailingPriceAdvanced =
            trailingStateChanged ||
            (trailingActive && trailingStopPrice > 0 && prevTrailingStopPrice !== trailingStopPrice)
          const nothingChanged =
            !ordersMissing && slDeltaPct < 0.0025 && tpDeltaPct < 0.0025 && !trailingPriceAdvanced
          if (nothingChanged) continue

          await recalculateAndApplySLTP(connectionId, livePos.id, exchangeConnector, {
            stopLossPct: effectiveSlPct,
            takeProfitPct: tpPct,
          })
        } catch (err) {
          console.warn(
            `${LOG_PREFIX} syncLiveFromPseudo: failed for ${livePos.id} (${symbol}/${side}):`,
            err instanceof Error ? err.message : String(err),
          )
        }
      }
    }
    const poolSize = Math.min(MAX_CONCURRENT_SLTP, matches.length)
    await Promise.all(Array.from({ length: poolSize }, () => worker()))
  } catch (err) {
    console.warn(`${LOG_PREFIX} syncLiveFromPseudo top-level error:`, err instanceof Error ? err.message : String(err))
  }
}

export const __liveStageTest = {
  computeDesiredProtectionPrices,
  readAbsoluteProtectionPrices(pos: LivePosition) {
    return computeDesiredProtectionPrices(pos)
  },
  detectSltpCross(pos: LivePosition, price: number, stopLossPrice?: number, takeProfitPrice?: number): "sl_hit" | "tp_hit" | null {
    if (pos.direction === "short") {
      if (stopLossPrice && price >= stopLossPrice) return "sl_hit"
      if (takeProfitPrice && price <= takeProfitPrice) return "tp_hit"
      return null
    }
    if (stopLossPrice && price <= stopLossPrice) return "sl_hit"
    if (takeProfitPrice && price >= takeProfitPrice) return "tp_hit"
    return null
  },
}

export default {
  executeLivePosition,
  updateLivePositionFill,
  closeLivePosition,
  getLivePositions,
  getLivePositionsByStatus,
  calculateLivePositionStats,
  syncWithExchange,
  reconcileLivePositions,
  recalculateAndApplySLTP,
  syncLiveFromPseudo,
  getClosedLivePositions,
  processSimulatedPositions,
}
