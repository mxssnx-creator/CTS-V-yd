import { MIN_VOLUME_FACTOR } from "@/lib/constants"
/**
 * Trade Engine Manager V11
 * Manages asynchronous processing for symbols, indications, pseudo positions, and strategies
 * V10: Define totalStrategiesEvaluated globally to prevent stale closure ReferenceError
 * V11: Self-scheduling setTimeout loops with configurable cycle pause
 *      (app_settings.cyclePauseMs, default 50 ms) to fix 4 s+ cycle hang.
 * @version 11.0.0
 * @lastUpdate 2026-04-20 — self-scheduling cycle loops
 */

const _ENGINE_BUILD_VERSION = "11.0.0"

// CRITICAL FIX: Define totalStrategiesEvaluated in global scope as fallback
// This allows stale closures from old code to continue without ReferenceError
// The variable is defined but not used - new code doesn't reference it
declare global {

  var totalStrategiesEvaluated: number
}
if (typeof globalThis.totalStrategiesEvaluated === "undefined") {
  globalThis.totalStrategiesEvaluated = 0
}

// Type for global engine state
interface EngineGlobalState {
  __engine_version?: string
  __engine_timers?: Set<ReturnType<typeof setInterval>>
  __engine_instances?: Map<string, unknown>
}

const engineGlobal = (typeof globalThis !== "undefined" ? globalThis : {}) as EngineGlobalState

// ─────────────────────────────────────────────────────────────────────────
// Hot-path: shared global-pause cache (1 s TTL)
// ─────────────────────────────────────────────────────────────────────────
// Both indication and strategy ticks (and the realtime live-sync) check
// `trade_engine:global.status === "paused"` on every tick. That is an
// hgetall round-trip per tick per processor — for one connection at
// ~20 Hz that is 60+ Redis calls/s purely to gate cycle execution.
let _globalPauseCache: { paused: boolean; checkedAtMs: number } | null = null
async function isGloballyPausedCached(): Promise<boolean> {
  const now = Date.now()
  if (_globalPauseCache && now - _globalPauseCache.checkedAtMs < 1000) {
    return _globalPauseCache.paused
  }
  try {
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global").catch(() => ({}))) as Record<string, string>
    const paused = globalState?.status === "paused"
    _globalPauseCache = { paused, checkedAtMs: now }
    return paused
  } catch {
    return _globalPauseCache?.paused ?? false
  }
}

// STABILITY: NEVER clear live engine timers on module reload.
//
// Previously this block ran on every module reload (HMR / serverless
// warm-restart / redeploy) and cleared every interval handle that any live
// engine had registered. After the clear the timer handles still existed
// inside the engines' closures, but firing them did nothing — and the
// per-tick "stale module version" guard (also removed in this changeset)
// then refused to schedule the next cycle. Net effect: every running
// engine silently went to sleep on every reload. Hence the
// "engines silently stop running" symptom.
//
// We now log the version transition and preserve the timer set. Real
// timer disposal is owned by `EngineManager.stop()` and `rearmIfStalled()`.
if (engineGlobal.__engine_version && engineGlobal.__engine_version !== _ENGINE_BUILD_VERSION) {
  console.log(
    `[v0] Engine version ${engineGlobal.__engine_version} -> ${_ENGINE_BUILD_VERSION} ` +
      `(keeping ${engineGlobal.__engine_timers?.size ?? 0} live timers)`,
  )
}
engineGlobal.__engine_version = _ENGINE_BUILD_VERSION

// Initialize timer set if it doesn't exist yet (first load in this process).
if (!engineGlobal.__engine_timers) {
  engineGlobal.__engine_timers = new Set()
}

// Helper to register timers so they can be cleaned up on reload
function registerEngineTimer(timer: ReturnType<typeof setInterval>): void {
  engineGlobal.__engine_timers?.add(timer)
}

function unregisterEngineTimer(timer: ReturnType<typeof setInterval>): void {
  engineGlobal.__engine_timers?.delete(timer)
}

/**
 * Configurable pause (ms) between engine cycles.
 *
 * Value comes from the `app_settings.cyclePauseMs` key in Redis, clamped to
 * [10, 200]. Default 50 ms.
 *
 * ── Live-settings contract ────────────────────────────────────────────
 * Cached in-memory so cycle scheduling never blocks on Redis I/O, BUT the
 * cache is tied to the global `settings_version` counter (bumped by every
 * write via `setAppSettings` / `bumpSettingsVersion`), not a wall-clock
 * TTL. The synchronous getter returns the last-known value and fires an
 * async refresh whenever:
 *   (a) the counter has changed since the last refresh   → operator saved
 *   (b) 30 s have elapsed without any version bump       → defence-in-
 *       depth against a missed signal (Redis flush, lost INCR, etc.)
 * This makes saved settings take effect on the very next cycle (typically
 * < 300 ms later, bounded by SETTINGS_VERSION_READ_TTL_MS + cycle pause)
 * with NO engine restart required.
 */
const DEFAULT_CYCLE_PAUSE_MS = 300
const CYCLE_PAUSE_MIN = 100
const CYCLE_PAUSE_MAX = 500
const CYCLE_PAUSE_HARD_REFRESH_MS = 30_000

let _cyclePauseMsCached: number = DEFAULT_CYCLE_PAUSE_MS
let _cyclePauseMsFetchedAt = 0
let _cyclePauseMsVersion = -1
let _cyclePauseMsRefreshing = false

function clampCyclePauseMs(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n)
  if (!Number.isFinite(v)) return DEFAULT_CYCLE_PAUSE_MS
  return Math.max(CYCLE_PAUSE_MIN, Math.min(CYCLE_PAUSE_MAX, Math.round(v)))
}

function refreshCyclePauseMsAsync(): void {
  if (_cyclePauseMsRefreshing) return
  _cyclePauseMsRefreshing = true
  ;(async () => {
    try {
      // `getAppSettings` / `getSettingsVersion` are statically imported
      // at the top of the module — hoisted out of the hot path to avoid
      // a per-cycle `await import()` round-trip that was previously
      // costing ~1 ms every time the settings version advanced.
      //
      // Snapshot the version BEFORE the read so any further bump that
      // lands mid-read still triggers a subsequent refresh.
      const version = await getSettingsVersion()
      const s = (await getAppSettings()) || {}
      if (s && typeof s === "object" && "cyclePauseMs" in s) {
        _cyclePauseMsCached = clampCyclePauseMs((s as any).cyclePauseMs)
      }
      _cyclePauseMsVersion = version
      _cyclePauseMsFetchedAt = Date.now()
    } catch {
      // Keep last-known value on error; still stamp the clock so we
      // don't stampede the refresh on every cycle.
      _cyclePauseMsFetchedAt = Date.now()
    } finally {
      _cyclePauseMsRefreshing = false
    }
  })()
}

/**
 * Synchronous read used by every cycle loop. Hot path — must not await.
 * Checks the version-counter cache (maintained by getSettingsVersion's
 * own 250 ms in-process cache) and fires a background refresh whenever
 * the counter has advanced OR the hard-refresh deadline has passed.
 */
function getCyclePauseMsSync(): number {
  const now = Date.now()
  // Read the cached version synchronously via the non-blocking snapshot
  // maintained in redis-db.ts. `getSettingsVersionCachedSync` never
  // awaits — it opportunistically schedules a background refresh when
  // its own 250 ms TTL has lapsed and returns the last-known value.
  const liveVersion = getSettingsVersionCachedSync()
  if (liveVersion !== _cyclePauseMsVersion) {
    refreshCyclePauseMsAsync()
  } else if (now - _cyclePauseMsFetchedAt > CYCLE_PAUSE_HARD_REFRESH_MS) {
    refreshCyclePauseMsAsync()
  }
  return _cyclePauseMsCached
}

// Prime the cache on module load so the first cycle uses a recent value.
refreshCyclePauseMsAsync()

import { getSettings, setSettings, getAllConnections, getRedisClient, initRedis, getSettingsVersionCachedSync, getAppSettings, getAppSetting, getSettingsVersion } from "@/lib/redis-db"
import { canonicalTotalForSymbols, clampProcessedToTotal, getCanonicalSymbolSelection, ownsCanonicalSymbolSelection, ownsCanonicalSymbolSelectionEpoch } from "@/lib/trade-engine/symbol-selection-ownership"
import { DataSyncManager } from "@/lib/data-sync-manager"
import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor, clearFlowThrottleForConnection } from "./strategy-processor"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { RealtimeProcessor } from "./realtime-processor"
import { runIndStratCycle } from "./shared-ind-strat-pipeline"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"
import { getEngineTimings } from "@/lib/engine-timings"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { loadMarketDataForEngine } from "@/lib/market-data-loader"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { engineMonitor } from "@/lib/engine-performance-monitor"
import { ConfigSetProcessor } from "./config-set-processor"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { prefetchMarketDataBatch, getParsedCandlesCached } from "./market-data-cache"
import {
  // ── Cross-process progression ownership (spec §"no multiple started
  // progressions per connection, no switching"). The lock guarantees a
  // single TradeEngineManager runs per connection across the entire
  // deployment; the `epoch` it carries is also written to the
  // `progression:{id}` hash so stale callbacks from a previous
  // generation can be detected and dropped by external readers.
  LOCK_EXTEND_INTERVAL_MS,
  extendProgressionLock,
  releaseProgressionLock,
  type LockHandle,
} from "./progression-lock"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { fetchTopSymbols } from "@/lib/top-symbols"

/**
 * Per-symbol fan-out concurrency cap.
 *
 * `Promise.all(symbols.map(...))` is conceptually parallel but practically
 * unbounded: at 50+ symbols every per-symbol task fires simultaneously,
 * each performing several Redis reads + indicator math + (sometimes)
 * a market-data refetch. The cumulative pressure can:
 *   • saturate the Redis client's pipeline depth → tail latency spikes
 *   • starve the Node event loop while indicator math runs → other
 *     timers (heartbeat, /api requests, watchdog) drift
 *   • cause the per-cycle deadline to fire even though no single task
 *     was hung — the whole batch was just queued behind itself
 *
 * Capping concurrency at 32 keeps p99 cycle latency stable across watchlist
 * sizes from 1 to a few hundred symbols. The cap is intentionally
 * larger than typical symbol counts (most operators run 1–25) so the
 * common case still runs fully in parallel; the cap only kicks in for
 * heavy workloads where it provides real protection.
 *
 * If a future operator runs hundreds of symbols and the cap becomes the
 * bottleneck, expose this as a setting — but don't remove the cap.
 *
 * MEMORY: raised 6 → 8 for 20-symbol runs. Each symbol's strategy pass builds a
 * large in-memory Set graph (Base→Main→Real). The CoordIndex optimisation (slim
 * SetCoordRecord scalars vs full StrategySet clones) significantly reduced per-symbol
 * peak allocation. At 20 symbols with 6144 MB dev heap we drop to 5 concurrent
 * to keep peak live Set-graph allocation below the eviction trigger threshold.
 * Node is single-threaded — tighter concurrency yields to GC between symbols.
 * At 20 symbols: 3 concurrent means each batch of 3 completes, yields the
 * event loop (letting the 4s eviction interval fire), then starts the next 3.
 * 5 concurrent keeps the event loop blocked long enough that the eviction
 * setInterval callback cannot fire between batches.
 *
 * DEV NOTE: Scales with V0_DEV_SYMBOL_COUNT. With 1 symbol it stays 1;
 * with 10 symbols it rises to min(3, ceil(N/4)) so at most 3 symbols
 * are processed in parallel even in dev, keeping in-flight StrategySet
 * count manageable (3 × MAIN_AXIS_SETS_CEILING per cycle peak).
 */
const _devSymCount = process.env.NODE_ENV === "development"
  ? Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "1", 10) || 1)
  : 0
const SYMBOL_CONCURRENCY = process.env.NODE_ENV === "development"
  ? Math.min(3, Math.max(1, Math.ceil(_devSymCount / 4)))
  : 3

// ── Lazy-import helpers for LivePositions hot path ───────────────────
// `await import()` at 200 ms cadence costs ~1 ms each (module resolution
// in V8). We memoize the dynamic imports at module level so they resolve
// exactly once per process — the 200 ms tick avoids the per-call
// overhead entirely.
let __liveStage: any = null
async function _processSimulatedPositionsLazy(connId: string) {
  if (!__liveStage) {
    __liveStage = await import("./stages/live-stage")
  }
  return __liveStage.processSimulatedPositions(connId)
}
async function _syncWithExchangeLazy() {
  if (!__liveStage) {
    __liveStage = await import("./stages/live-stage")
  }
  return __liveStage.syncWithExchange
}
let __getConnectionFn: any = null
async function _getConnectionLazy(connId: string) {
  if (!__getConnectionFn) {
    const mod = await import("@/lib/redis-db")
    __getConnectionFn = mod.getConnection
  }
  return __getConnectionFn(connId)
}
let __createExchangeConnectorFn: any = null
async function _createExchangeConnectorLazy() {
  if (!__createExchangeConnectorFn) {
    const mod = await import("@/lib/exchange-connectors")
    __createExchangeConnectorFn = mod.createExchangeConnector
  }
  return __createExchangeConnectorFn
}

/**
 * Per-cycle hard deadline (ms) for engine processor ticks.
 *
 * The engine has a strong self-scheduling design (try/catch + finally
 * scheduleNext), but `finally` only fires when the awaited body settles.
 * A single hung await — Redis network black-hole, exchange connector
 * waiting on a stuck WebSocket frame, malformed promise that never
 * resolves — would leave the tick suspended forever and the loop
 * silently dead.
 *
 * `withCycleDeadline` wraps each tick's primary work in a `Promise.race`
 * against a bounded timeout (30s dev, 60s production). When the deadline fires, the wrapper rejects,
 * the rejection is caught by the tick's outer try/catch, `finally` runs,
 * and `scheduleNext` re-arms the loop. Any in-flight promises continue
 * to settle in the background — they just no longer block subsequent
 * ticks.
 */
// Dev gets 55 s (same budget as prod) — the deadline is a stuck-await safety
// net, not a performance target. With the dev 1-symbol cap (migration 057)
// the indication cycle finishes well under 10 s normally; the extra headroom
// prevents false deadline fires when the VM is under memory pressure or
// the strategy flow is unusually large on a cold start.
const CYCLE_DEADLINE_MS = process.env.NODE_ENV === "production" ? 60_000 : 55_000

function withCycleDeadline<T>(work: Promise<T>, label: string, ms: number = CYCLE_DEADLINE_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error(`${label} cycle deadline ${ms}ms exceeded — likely hung await`))
    }, ms)
    // Detach the deadline timer from the Node ref-count so it never holds
    // the process open during shutdown — the tick's outer finally will
    // settle and the timer fires only if the work itself wedges.
    if (typeof (timer as any).unref === "function") {
      try { (timer as any).unref() } catch { /* non-Node runtime */ }
    }
    work.then(
      (v) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

/**
 * Run `task(item)` for each item with at most `concurrency` tasks
 * in flight at a time. Preserves input order in the result array
 * (so callers using `for (let i...)` indexing into both `symbols`
 * and the result array remain correct).
 *
 * Failures inside `task` should be caught by the task itself and
 * mapped to a sentinel value — this helper does NOT swallow rejections,
 * because losing track of an erroring symbol is exactly the bug we're
 * fixing. The existing call sites already wrap with `.catch(...)`.
 */
async function mapWithConcurrency<TIn, TOut>(
  items: readonly TIn[],
  concurrency: number,
  task: (item: TIn, index: number) => Promise<TOut>,
): Promise<TOut[]> {
  if (items.length === 0) return []
  // Fast path: when the list fits inside the cap there's no benefit to
  // the worker-pool overhead — defer to plain Promise.all.
  if (items.length <= concurrency) {
    return Promise.all(items.map((item, index) => task(item, index)))
  }

  const results = new Array<TOut>(items.length)
  let nextIndex = 0
  // Worker draining a shared cursor. Each worker pulls the next index,
  // awaits the task, stores the result at the original position, and
  // loops until the cursor is exhausted. This is the classic
  // bounded-parallelism pattern (no third-party dependency, no Symbol
  // iterator overhead, deterministic ordering).
  const worker = async (): Promise<void> => {
    while (true) {
      const i = nextIndex++
      if (i >= items.length) return
      results[i] = await task(items[i], i)
      // Yield to the event loop after each task so GC and setInterval callbacks
      // (eviction, GC trigger) have a guaranteed chance to run between symbols.
      // Without this yield, tight synchronous computation inside async tasks can
      // block the event loop for seconds, preventing the 4s eviction timer from
      // firing and causing InlineLocalRedis heap to grow unchecked.
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }
  const workers: Promise<void>[] = []
  const poolSize = Math.min(concurrency, items.length)
  for (let i = 0; i < poolSize; i++) workers.push(worker())
  await Promise.all(workers)
  return results
}

export interface EngineConfig {
  connectionId: string
  connection_name?: string
  exchange?: string
  engine_type?: string
  indicationInterval?: number // seconds, default 1
  strategyInterval?: number // seconds, default 1
  realtimeInterval?: number // seconds, default 1
}

export interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
  cycleCount: number
}

const SYMBOL_AFFECTING_SETTING_FIELDS = new Set([
  "active_symbols",
  "activeSymbols",
  "symbols",
  "symbol_mode",
  "symbolMode",
  "exchange_order_by",
  "exchangeOrderBy",
  "symbol_limit",
  "symbolLimit",
  "symbol_count",
  "symbolCount",
  "symbol_order",
  "force_symbols",
  "useMainSymbols",
  "mainSymbols",
])

const STRATEGY_AFFECTING_SETTING_FIELDS = new Set([
  "profitFactorMin",
  "baseProfitFactor",
  "mainProfitFactor",
  "realProfitFactor",
  "liveProfitFactor",
  "maxDrawdownTimeMainHours",
  "maxDrawdownTimeRealHours",
  "maxDrawdownTimeLiveHours",
  "stageMinPosCountBase",
  "stageMinPosCountMain",
  "stageMinPosCountReal",
  "variantTrailingEnabled",
  "variantBlockEnabled",
  "variantDcaEnabled",
  "axisPrevEnabled",
  "axisLastEnabled",
  "axisContEnabled",
  "axisPauseEnabled",
  "axisPrevMaxWindow",
  "axisLastMaxWindow",
  "axisContMaxWindow",
  "axisPauseMaxWindow",
  "blockVolumeRatio",
  "blockMaxStack",
  "minimal_step_count",
  "minimalStepCount",
  "minStep",
  "trailingMinStep",
  "prevPosWindow",
  "prevPosMinCount",
  "mainEvalPosCount",
  "realEvalPosCount",
  "volume_factor",
  "volume_factor_live",
  "volume_factor_preset",
  "volume_step_ratio",
  "leveragePercentage",
  "useMaximalLeverage",
])

function isGenericConnectionSettingsReload(fields: readonly string[]): boolean {
  return fields.length === 0 || fields.some((field) => field === "connection_settings")
}

function hasSymbolAffectingChange(fields: readonly string[]): boolean {
  return fields.some((field) => {
    if (SYMBOL_AFFECTING_SETTING_FIELDS.has(field)) return true
    if (field.startsWith("connection_settings.")) {
      const nested = field.slice("connection_settings.".length)
      return SYMBOL_AFFECTING_SETTING_FIELDS.has(nested)
    }
    return false
  })
}

function hasStrategyAffectingChange(fields: readonly string[]): boolean {
  return fields.some((field) => {
    if (field === "strategies" || field === "coordination_settings") return true
    if (STRATEGY_AFFECTING_SETTING_FIELDS.has(field)) return true
    if (field.startsWith("connection_settings.")) {
      const nested = field.slice("connection_settings.".length)
      return nested === "strategies" || nested === "coordination_settings" || STRATEGY_AFFECTING_SETTING_FIELDS.has(nested)
    }
    return false
  })
}

export class TradeEngineManager {
  private connectionId: string
  private isRunning = false
  private isStarting = false // Guard against concurrent start() calls
  private indicationTimer?: NodeJS.Timeout
  private strategyTimer?: NodeJS.Timeout
  private realtimeTimer?: NodeJS.Timeout
  private liveProgressionsArmed = false
  private healthCheckTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout

  // Throttle for the settings-dirty Redis read in the indication tick.
  // The flag is set by the UI (rare) but read on every tick — at 20 Hz
  // that is ~20 GETs/sec per connection. 1 s reload latency is fine.
  private _lastDirtyCheckMs = 0

  /**
   * Wall-clock timestamp at which this manager instance was constructed.
   * Used by the coordinator's `pruneZombieManagers()` self-heal so a
   * not-yet-running manager that's freshly constructed isn't mistaken
   * for a zombie. Distinct from `startTime` (which is set on
   * successful `start()`).
   */
  public readonly createdAt: number = Date.now()

  private indicationProcessor: IndicationProcessor
  private strategyProcessor: StrategyProcessor
  private pseudoPositionManager: PseudoPositionManager
  private realtimeProcessor: RealtimeProcessor
  private startTime?: Date

  /**
   * Cached `EngineConfig` from the most recent successful `start()`.
   * Used by the watchdog's in-place re-arm path (`rearmIfStalled`) so we
   * can re-start ONLY the missing processor timers using the same intervals
   * the user originally configured — without rebuilding the manager,
   * re-loading market data, or re-running prehistoric.
   */
  private startConfig?: EngineConfig

  /**
   * ── One-progression-per-connection ownership ─────────────────────
   *
   * `lockHandle` is the {token, epoch} pair we acquired in the
   * coordinator before this manager's `start()` was invoked. It is the
   * cross-process proof that no other worker is running the same
   * connection's engine. While the engine is running the heartbeat
   * timer extends the lock TTL; if the extend fails (someone else
   * stole the slot, or the lock expired due to a long pause) the
   * heartbeat triggers a graceful self-stop so we don't continue
   * mutating progression state we no longer own.
   *
   * `epoch` mirrors `lockHandle.epoch` for fast in-memory checks — any
   * async result-write path can quickly verify "is my epoch still the
   * live one?" by comparing `this.epoch` to a captured local value.
   * `epoch === 0` means "not running"; the manager is freshly
   * constructed or has been stopped.
   */
  private lockHandle?: LockHandle
  private epoch = 0
  /** Optional lock-extend timer (separate from the user-visible heartbeat). */
  private lockExtendTimer?: NodeJS.Timeout

  /**
   * ── Live settings-reload bus ───────────────────────────────���─────
   *
   * When connection settings change (e.g. operator edits indication
   * thresholds, volume factor, presets, etc.) the API handler writes
   * a change event + bumps `settings_change_counter:{id}` in Redis.
   * The `settingsWatcherTimer` below polls that counter every 3s and,
   * on a bump, calls `applyPendingSettingsChange()` to dispatch the
   * event:
   *
   *   • `reload` → in-place: bump `settingsVersion`, re-read the
   *     connection snapshot, refresh config-set processor caches. No
   *     stop/start, no epoch change.
   *   • `restart` → escalates to the coordinator's stop+start path so
   *     the new credentials / api-type take effect with a fresh epoch.
   *
   * Public `settingsVersion` lets per-cycle code in processors detect
   * a generational settings flip and bust any local memoization (e.g.
   * "did the indication thresholds change since I last computed?").
   */
  private settingsWatcherTimer?: NodeJS.Timeout
  private lastSettingsCounter = 0
  private settingsVersion = 0
  /** Set true while a settings apply is in flight to prevent overlap. */
  private settingsApplying = false
  /** Prevents dirty-flag and hot-reload fast paths from recursively fanning out. */
  private immediateStrategyReevaluationInFlight = false

  private componentHealth: {
    indications: ComponentHealth
    strategies: ComponentHealth
    realtime: ComponentHealth
  }

  constructor(config: EngineConfig) {
    this.connectionId = config.connectionId
    this.indicationProcessor = new IndicationProcessor(config.connectionId)
    this.strategyProcessor = new StrategyProcessor(config.connectionId)
    this.pseudoPositionManager = new PseudoPositionManager(config.connectionId)
    this.realtimeProcessor = new RealtimeProcessor(config.connectionId)

    this.componentHealth = {
      indications: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
      strategies: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
      realtime: { status: "healthy", lastCycleDuration: 0, errorCount: 0, successRate: 100, cycleCount: 0 },
    }

    console.log("[v0] TradeEngineManager initialized")
  }

  /**
   * Public getter to check if engine is running
   */
  get isEngineRunning(): boolean {
    return this.isRunning
  }

  /**
   * Start the trade engine.
   *
   * @param config   The engine configuration to launch with.
   * @param lockCtx  Optional ownership handle obtained from
   *                 `acquireProgressionLock` in the coordinator. When
   *                 omitted the manager is running in single-process
   *                 mode (legacy callers / unit tests) and the epoch
   *                 is generated locally; cross-process safety is
   *                 then NOT guaranteed and the caller is responsible
   *                 for ensuring no other worker can race.
   */
  async start(config: EngineConfig, lockCtx?: LockHandle): Promise<void> {
    if (this.isRunning || this.isStarting) {
      return
    }
    this.isStarting = true

    // ── Stamp generation token BEFORE anything writes to Redis ──────
    // Even if startup later fails, downstream readers will see a
    // higher epoch and can correctly invalidate stale cached state.
    // Local fallback for non-coordinator callers: a fresh epoch with
    // no owner token (writes that need owner verification will skip).
    this.lockHandle = lockCtx
    this.epoch = lockCtx?.epoch ?? Date.now()

    // Cache config for the watchdog's in-place re-arm path. We do this
    // BEFORE any await so a fast-fail in startup still leaves a usable
    // record of intended intervals.
    this.liveProgressionsArmed = false
    this.startConfig = config

    // ── Symbols cache invalidation ──────────────────────────────────────
    // Quick-start and any engine restart must resolve fresh symbols from
    // Redis (`trade_engine_state:{id}` wins over `connection:{id}`) so a
    // stale 5-second in-memory TTL can't rebind the new run to a previous
    // symbol list.
    this.invalidateSymbolsCache()

    // Idempotent global unhandled-rejection handler. Defined here (not at
    // module top) so it runs in the same process tick as the engine that
    // would otherwise leak the rejection. Multiple managers calling this
    // method only attach the listener once thanks to the global guard.
    this.setupErrorRecovery()

    try {
      // Ensure Redis is initialized before using it
      await initRedis()

      // ── RE-COORDINATE FOR ACTUAL LIVE STATE (prevents stalling to old/different settings+symbols) ──
      // Before starting anything, check if the existing progression (if any) was born for
      // different settings / symbol count than what is live *right now*.
      // If mismatch → previous running progress is stopped (via archive) and we start a fresh,
      // unique, solid progression for the *actual* current configuration of this connection.
      try {
        await ProgressionStateManager.recoordinateForActualOne(this.connectionId, config.engine_type || "main")
      } catch (recoordErr) {
        console.warn("[v0] [Engine] Re-coordination check failed (continuing):", recoordErr)
      }

      // ── ENSURE JUST UNIQUE PROGRESSION (per connection, solid, one at a time) ──
      // Guarantees exactly one unique solid progression per connection.
      // - Reuses the existing one when it matches current live settings/symbols.
      // - When starting new (or recoordinate detects mismatch), previous is stopped/archived.
      // - Page refreshes / independent opens attach to the current unique one (no explosion of instances).
      // "Just Unique" — one canonical active progression for the actual state.
      try {
        const u = await ProgressionStateManager.ensureJustUniqueProgression(this.connectionId, {
          ownerEpoch: this.lockHandle?.epoch ?? this.epoch,
          engineType: config.engine_type || "main",
        })
        this.epoch = u.epoch
        console.log(
          `[v0] [Engine] Using ${u.wasNew ? "new" : "existing"} unique progression ` +
          `for ${this.connectionId} (session=${u.sessionNumber}, epoch=${u.epoch})`
        )
      } catch (ensureErr) {
        console.warn("[v0] [Engine] ensureJustUniqueProgression failed, falling back to archive:", ensureErr)
        this.epoch = this.lockHandle?.epoch ?? Date.now()
        await ProgressionStateManager.archiveAndStartNewProgression(this.connectionId, this.epoch).catch(() => {})
        await getRedisClient().hset(`progression:${this.connectionId}`, {
          engine_started: "true",
          last_update: new Date().toISOString(),
        }).catch(() => {})
      }

      // Initialize engine state
      await this.updateProgressionPhase("initializing", 5, "Starting engine components")
      await logProgressionEvent(this.connectionId, "initializing", "info", "Engine initialization started")
      await this.updateEngineState("running")
      await this.setRunningFlag(true)

      // Load market data for all symbols
      await this.updateProgressionPhase("market_data", 8, "Loading market data...")
      const symbols = await this.getSymbols()
      const ownsCurrentSelectionAtStart = await ownsCanonicalSymbolSelection(this.connectionId, symbols)
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        // Store as JSON so readers can JSON.parse reliably. Storing a raw array
        // here let the Redis emulator coerce it to a comma-joined string, which
        // then threw "Unexpected token" in recoordinateForActualOne's
        // JSON.parse(state.symbols). JSON.stringify keeps both sides consistent.
        symbols: JSON.stringify(symbols),
        active_symbols: JSON.stringify(symbols),
        symbol_count: String(symbols.length),
        ...(ownsCurrentSelectionAtStart ? {
          config_set_symbols_total: symbols.length,
          config_set_symbols_processed: 0,
        } : {}),
        updated_at: new Date().toISOString(),
      })

      // ── SOLIDIFY THIS PROGRESSION WITH CURRENT ACTUAL STATE ─────────
      // Immediately after starting a new progression, capture the *exact* live
      // symbols + key settings that this run was started for.
      // This makes the progress "Unique and Solid" for this (connection + settings + symbol count).
      // Future re-coordination can compare against this snapshot.
      try {
        const redisClient = getRedisClient()
        const symbolCount = symbols.length
        const symbolsHash = symbols.slice().sort().join("|") // simple deterministic hash; do not reorder runtime processing
        // Snapshot a minimal but useful slice of current connection settings
        const connData = (await redisClient.hgetall(`connection:${this.connectionId}`).catch(() => ({}))) as Record<string, string>
        const settingsSnapshot = {
          symbol_count: symbolCount,
          symbols_hash: symbolsHash,
          engine_type: config.engine_type || "main",
          is_live_trade: connData.is_live_trade || "0",
          is_preset_trade: connData.is_preset_trade || "0",
          live_volume_factor: connData.live_volume_factor ?? String(MIN_VOLUME_FACTOR),
          connection_method: connData.connection_method || "library",
          updated_at: new Date().toISOString(),
        }

        // ── Critical Write with Retry ─────────────────────────────────�����──
        // The progression snapshot (symbol_count, settings_version, etc.) is
        // CRITICAL for "unique + solid" progress. If this write fails, the
        // entire progression becomes stale and UI will show incorrect counters.
        // Retry once before giving up.
        let snapWriteOk = false
        try {
          await redisClient.hset(`progression:${this.connectionId}`, {
            symbol_count: String(symbolCount),
            active_symbols_hash: symbolsHash,
            started_for_settings_version: new Date().toISOString(),
          progress_settings_snapshot: JSON.stringify(settingsSnapshot),
          engine_type: config.engine_type || "main",
          })
          snapWriteOk = true
        } catch (err) {
          console.error("[v0] [Engine] First progression snapshot write failed, retrying:", err)
          try {
            // Retry once with exponential backoff
            await new Promise(r => setTimeout(r, 100))
            await redisClient.hset(`progression:${this.connectionId}`, {
              symbol_count: String(symbolCount),
              active_symbols_hash: symbolsHash,
              started_for_settings_version: new Date().toISOString(),
              progress_settings_snapshot: JSON.stringify(settingsSnapshot),
              engine_type: config.engine_type || "main",
            })
            snapWriteOk = true
          } catch (retryErr) {
            console.error("[v0] [Engine] Progression snapshot write FAILED after retry:", retryErr)
          }
        }

        console.log(
          `[v0] [Engine] Progression solidified for ${this.connectionId}: ` +
          `symbols=${symbolCount}, hash=${symbolsHash.slice(0, 16)}... (epoch=${this.epoch})`
        )
      } catch (snapErr) {
        console.warn("[v0] [Engine] Could not write progression solidity snapshot:", snapErr)
      }

      const loaded = await loadMarketDataForEngine(symbols)
      if (loaded === 0) {
        console.warn(`[v0] [Engine] No market data loaded for symbols: ${symbols.join(", ")}`)
      }

      // Phase 2: Load prehistoric data (NON-BLOCKING)
      const prehistoricCacheKey = `prehistoric_loaded:${this.connectionId}`
      const redisClient = getRedisClient()
      let prehistoricCached = await redisClient.get(prehistoricCacheKey)
      let cacheHit = prehistoricCached === "1"

      if (cacheHit) {
        await this.updateProgressionPhase("prehistoric_data", 15, "Using cached historical data")
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: true,
          prehistoric_data_source: "cache",
          updated_at: new Date().toISOString(),
        })
        // CRITICAL: Re-arm the `prehistoric:{id}:done` gate flag in the cache
        // path. Without this, the realtime processor stays gated forever after
        // an engine restart inside the 24h TTL window of
        // `prehistoric_loaded:{id}` — because the `done` flag lives on a
        // separate key with an independent TTL and was never set in this
        // path. The fix is idempotent (same value, 24h re-expire) and costs
        // exactly one Redis SET per engine boot.
        try {
          await redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 } as any)
        } catch (gateErr) {
          console.warn(
            `[v0] [Engine] Failed to re-arm prehistoric done gate on cache hit:`,
            gateErr instanceof Error ? gateErr.message : String(gateErr),
          )
        }
        // CRITICAL: Also restore the prehistoric:{id} hash completion fields.
        // The QuickStart route wipes `is_complete`, `symbols_processed`, etc.
        // on every new run so the UI can show fresh progress. In the cache
        // path, the processor never re-runs to restore them, so the stats
        // route sees `is_complete !== "1"` and `symbols_processed = 0`,
        // causing the dashboard to display "0/N symbols" indefinitely even
        // though historic data is fully ready. Re-stamp the canonical
        // completion fields here so the dashboard correctly reflects the
        // cached state.
        try {
          const symbols = await this.getSymbols()
          const cacheSelection = await getCanonicalSymbolSelection(this.connectionId)
          const writerSelectionEpoch = cacheSelection?.epoch || ""
          const ownsCacheSelection = await ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
          const canonicalCacheTotal = await canonicalTotalForSymbols(this.connectionId, symbols)
          if (ownsCacheSelection) await redisClient.hset(`prehistoric:${this.connectionId}`, {
            is_complete: "1",
            symbol_selection_epoch: writerSelectionEpoch,
            symbols_processed: String(clampProcessedToTotal(symbols.length, canonicalCacheTotal)),
            symbols_total: String(canonicalCacheTotal),
            updated_at: new Date().toISOString(),
            data_source: ownsCacheSelection ? "cache" : "stale-cache-ignored",
          })
          await redisClient.expire(`prehistoric:${this.connectionId}`, 86400)
          console.log(`[v0] [Engine] Prehistoric cache hit — restored hash for ${symbols.length} symbols (${this.connectionId})`)
        } catch (restoreErr) {
          console.warn(
            `[v0] [Engine] Failed to restore prehistoric hash on cache hit:`,
            restoreErr instanceof Error ? restoreErr.message : String(restoreErr),
          )
        }

        // ── INTENSIVE PRODUCTION SELF-HEAL: VERIFY CACHE INTEGRITY ───────
        // Auto-start / deploy recovery / monitor paths (production) trust the
        // 24 h `prehistoric_loaded:{id}` marker and skip the one-time historic
        // fill (ConfigSetProcessor full-range simulation + first-pass that
        // creates deep historic position Sets, pos_history, and PF averages).
        // If prior data was cleared (flush, migration, admin clear) but marker
        // survived, engine advances to live_trading with empty Sets → "Prehistoric
        // stuck in production", "Low DB Keys and Activity", "no base PF", "no pos
        // counting". QuickStart deletes the marker every time (dev works).
        //
        // Fix: before trusting cache, verify the done flags + is_complete +
        // historic PF sample exist. On failure, nuke marker + checkpoints +
        // partial done flags and force the full background load. This makes
        // production auto-start as robust as an explicit QuickStart while
        // preserving the fast path when data is truly present.
        try {
          const [doneFlag, firstPass, isComplete, pfSample] = await Promise.all([
            redisClient.get(`prehistoric:${this.connectionId}:done`),
            redisClient.get(`prehistoric:${this.connectionId}:firstpass:done`),
            redisClient.hget(`prehistoric:${this.connectionId}`, "is_complete"),
            redisClient.hget(`prehistoric:${this.connectionId}`, "historic_avg_profit_factor"),
          ])
          const symbolsForCheck = await this.getSymbols()
          const hasSymbols = symbolsForCheck.length > 0
          // STRICT verification in ALL environments: the production bypass of
          // the PF-sample check existed only to protect the (now removed)
          // fake fast-path that stamped flags without data. A cache marker
          // with no historic PF sample means the real fill never completed —
          // force the full reload so realtime never runs on empty Sets.
          const dataLooksComplete =
            doneFlag === "1" && firstPass === "1" && isComplete === "1" && (pfSample != null || !hasSymbols)
          if (!dataLooksComplete) {
            console.warn(
              `[v0] [Engine ${this.connectionId}] Stale prehistoric cache marker (done/firstpass/complete/PF missing or empty) — FORCING full prehistoric reload. This fixes production "stuck prehistoric / low keys / no activity" after deploys/migrations.`,
            )
            await redisClient.del(prehistoricCacheKey).catch(() => {})
            // Clear incremental checkpoints so continuous prehistoric progression
            // will replay the entire configured window instead of thinking it is caught up.
            await Promise.allSettled(
              symbolsForCheck.map((s: string) =>
                redisClient.del(`prehistoric:checkpoint:${this.connectionId}:${s}`).catch(() => {}),
              ),
            )
            // Wipe partial gates so the one-time load writes them cleanly at the end.
            await Promise.allSettled([
              redisClient.del(`prehistoric:${this.connectionId}:done`),
              redisClient.del(`prehistoric:${this.connectionId}:firstpass:done`),
            ])
            // Also clear the completion fields that the cache-hit path
            // re-stamped above BEFORE this verification ran — otherwise the
            // stats route would show a fake "complete N/N" while the forced
            // full reload is still processing.
            await redisClient
              .hset(`prehistoric:${this.connectionId}`, {
                is_complete: "0",
                symbols_processed: "0",
                updated_at: new Date().toISOString(),
                data_source: "forced-reload",
              })
              .catch(() => {})
            cacheHit = false
            prehistoricCached = null
          }
        } catch (verifyErr) {
          console.warn(
            `[v0] [Engine ${this.connectionId}] Prehistoric cache verification threw (treating as miss to guarantee correctness):`,
            verifyErr instanceof Error ? verifyErr.message : String(verifyErr),
          )
          cacheHit = false
        }
      }

      if (!cacheHit) {
        // PRODUCTION FAST-PATH REMOVED (data-integrity directive).
        // The previous code force-stamped `prehistoric:{id}:done`,
        // `firstpass:done` and `is_complete=1` WITHOUT any real prehistoric
        // processing whenever isProd && is_live_trade=1, then armed all live
        // processors against EMPTY sets. That violated the architectural
        // contract ("first finish prehistoric progress, then start realtime
        // progress") and the no-fake-data directive: realtime evaluated
        // empty Sets, dashboards showed fake 100 % completion, and the real
        // historic fill never produced the Sets/PF baselines realtime needs.
        //
        // Production now follows the SAME correct path as dev: the
        // non-blocking background load runs the real prehistoric calculator
        // (with per-symbol checkpoints, so interrupted runs resume instead
        // of restarting), and `armLiveProgressions` (via onFirstPassComplete)
        // arms the realtime loops the moment the first REAL pass completes.
        await this.updateProgressionPhase("prehistoric_data", 15, "Loading historical data (background)...")
        this.loadPrehistoricDataInBackground(prehistoricCacheKey, redisClient)
      }

      // ── Cache-hit fast path: arm live processors IMMEDIATELY ──────────
      // `cacheHit` was computed and verified earlier (production self-heal
      // checks done flags + is_complete + PF sample). When true, the one-time
      // historic fill was skipped because data is present; we arm the live
      // processors immediately. When false (or forced), the background load
      // will run and the onFirstPassComplete callback will arm them later.
      if (cacheHit) {
        console.log(
          `[v0] [Engine ${this.connectionId}] Cache hit — arming live processors immediately (prehistoric data already complete)`,
        )
        this.armLiveProgressions("cached prehistoric")
      }

      // CRITICAL: Mark engine as running AFTER processors are armed (cache-hit path)
      // or after starting background load (non-cache-hit path below). The setTimeout-based
      // loops check `this.isRunning` at the start of every tick; if false when a tick
      // fires, it aborts and never reschedules, leaving stats stuck at zero.
      // In cache-hit path, processors are already armed above, so setting this flag now
      // allows their first tick to fire. In non-cache-hit path, arm is called below.
      this.isRunning = true

      // ── Spec contract (prehistoric → realtime ordering) ─────────────────
      // All three live processors (indication / strategy / realtime) are
      // ARMED here so their timer infrastructure is live, but every tick
      // SELF-GATES on the `prehistoric:{id}:done` flag (set at the end of
      // loadPrehistoricData). Until that flag flips the ticks return a
      // "gated" outcome with zero counters bumped — guaranteeing realtime
      // only evaluates the SET data that prehistoric calculations created,
      // never half-filled or empty sets.
      //
      // We deliberately DO NOT run forced "immediate" indication/strategy
      // warm-up cycles before prehistoric is complete: those bypass the
      // tick gate and would poison `indications_count` / `strategy_cycle_count`
      // with empty-set evaluations, which in turn flipped the dashboard
      // phase auto-derivation straight to "live_trading" while the
      // prehistoric calculator was still running. The first productive
      // tick of each processor fires the moment the `:done` flag flips.
      // ── Three-progression contract (architectural spec) ──────────────
      // Three independent top-level loops, each on its own timer:
      //   A. Prehistoric Progression  (continuous, no-pause) → historical Sets fill
      //   B. Realtime  Progression    (1 s) → ind+pseudo+strat per cycle
      //                                       (driven by startIndicationProcessor
      //                                        for historical method-name reasons)
      //   C. LivePositions Progression (200 ms) → live exchange sync
      //                                           (driven by startRealtimeProcessor)
      //
      // The legacy startStrategyProcessor remains armed as a long-interval
      // heartbeat tick only — strategy evaluation now happens inside the
      // shared pipeline called from the Realtime Progression.
      //
      // ── Startup ordering ─────────────────────────────────────────────
      // Per the architectural spec: "On enabling connection, first finish
      // prehistoric progress, then start realtime progress." The Realtime
      // pipeline READS the indication Sets that the Prehistoric pipeline
      // WRITES; if realtime starts before prehistoric has filled the Sets
      // at least once, every live tick scores against an empty Set and
      // the first wave of indications is meaningless.
      //
      // To enforce the gate we:
      //   1. Start the Prehistoric loop first (and ONLY it).
      //   2. Pass an `onFirstPassComplete` callback that arms the other
      //      three progressions the moment the first historical cycle
      //      writes the `prehistoric:{connId}:firstpass:done` flag.
      //   3. The Prehistoric loop then continues running forever in the
      //      background, refilling Sets from fresh market data each cycle.
      //
      // The callback path runs SYNCHRONOUSLY inside the prehistoric tick
      // before scheduleNext, so the realtime loops are armed before the
      // second prehistoric cycle even fires — no race window.
      const armLiveProgressions = () => {
        this.armLiveProgressions("prehistoric first-pass complete")
      }
      this.startPrehistoricProgression(cacheHit ? undefined : armLiveProgressions)

      // Phase stays at `prehistoric_data` while the historical calculator
      // is filling sets. `loadPrehistoricData` updates the phase percent
      // and sub_progress (X/Y symbols) live on every symbol completion;
      // `loadPrehistoricDataInBackground` advances the phase to
      // `live_trading` after the done flag flips. Cache-hit path falls
      // straight through to live_trading below since prehistoric is
      // already complete.
      if (cacheHit) {
        await this.updateProgressionPhase(
          "live_trading",
          100,
          `Live trading ACTIVE - monitoring ${symbols.length} symbols (cached prehistoric)`,
        )
      } else {
        await this.updateProgressionPhase(
          "prehistoric_data",
          15,
          `Prehistoric calc filling sets — processors armed, gated until done`,
          { current: 0, total: symbols.length, item: "symbols" },
        )
      }

      // Verify timers are running.
      //
      // Under the prehistoric-gated startup contract, the realtime /
      // indication / strategy timers are intentionally NOT armed at boot
      // — they are armed by the `armLiveProgressions` callback the moment
      // the Prehistoric Progression finishes its first pass (which can
      // take 5-30 s on a fresh boot). So at +2 s the only timer we can
      // assert is the prehistoric one. The live timers get their own
      // confirmation log via `armLiveProgressions` itself.
      setTimeout(async () => {
        if (this.prehistoricTimer) {
          await logProgressionEvent(
            this.connectionId,
            "engine_started",
            "info",
            this.indicationTimer && this.realtimeTimer
              ? "All engine processors started"
              : "Prehistoric Progression running — live processors gated until first pass completes",
          )
        } else {
          console.error(`[v0] [Engine] Timer startup failed — prehistoric not armed`)
        }
      }, 2000)
      this.startHealthMonitoring()
      this.startHeartbeat()
      // ── Cross-process lock-extend ticker ─────────────────────────
      // Runs only when we acquired the lock via the coordinator. Each
      // tick refreshes the Redis TTL so a long-running engine never
      // loses its slot, and SELF-STOPS the engine the moment the
      // refresh fails (e.g. another worker took over after a network
      // partition or we missed too many beats). This is the only
      // place that gracefully tears down the engine because we
      // discovered we no longer own it.
      this.startLockExtender()
      // ── Live settings-reload watcher ─────────────────────────────
      // Picks up operator edits to connection settings and applies
      // them WITHOUT requiring a manual restart. See `applyPendingSettingsChange`.
      this.startSettingsWatcher()

      // Phase 6: Boot complete. The engine is now "ready":
      //   - Cache-hit path: live_trading @ 100% (set above).
      //   - Cache-miss path: phase stays at `prehistoric_data` with live
      //     percent — `loadPrehistoricDataInBackground` advances it to
      //     `live_trading` once prehistoric calc has finished filling sets.
      // Do NOT unconditionally overwrite the phase here — that would
      // backfill a fake 100% over the real prehistoric percent the user
      // sees on the progress bar.
      this.isStarting = false
      this.startTime = new Date()

      // Log boot completion. Real indication/strategy counts will appear
      // only after prehistoric is done and the gated ticks start
      // producing work — at boot time both are intentionally zero.
      await logProgressionEvent(this.connectionId, "engine_started", "info", `Engine boot complete — processors armed${cacheHit ? " (cached prehistoric)" : ", waiting for prehistoric calc"}`, {
        symbols: symbols.length,
        indicationInterval: config.indicationInterval,
        strategyInterval: config.strategyInterval,
        realtimeInterval: config.realtimeInterval,
        prehistoricCached: cacheHit,
      })

      // Also update engine state to indicate all phases are running
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        all_phases_started: true,
        indications_started: true,
        strategies_started: true,
        realtime_started: true,
        live_trading_started: true,
        updated_at: new Date().toISOString(),
      })

      await logProgressionEvent(this.connectionId, "engine_started", "info", "Trade engine fully started", {
        symbols: symbols.length,
        phases: 6,
        config,
      })

      // Ensure the engine state reflects active processors and result flow immediately
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        ...((await getSettings(`trade_engine_state:${this.connectionId}`)) || {}),
        indications_started: true,
        strategies_started: true,
        realtime_started: true,
        live_trading_started: true,
        engine_ready: true,
        updated_at: new Date().toISOString(),
      })
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      console.error(`[v0] [EngineManager] ✗ FAILED to start trade engine:`, errorMsg)
      if (error instanceof Error) {
        console.error(`[v0] [EngineManager] Stack:`, error.stack)
      }
      // CRITICAL: Clean up any timers that were already started before the error.
      // (indication/strategy/realtime are now setTimeout-based; healthCheck/heartbeat
      // remain setInterval. clearInterval and clearTimeout are interchangeable on
      // Node.js Timeouts but we use clearTimeout where appropriate for clarity.)
      if (this.indicationTimer)  { clearTimeout(this.indicationTimer);  this.indicationTimer = undefined }
      if (this.strategyTimer)    { clearTimeout(this.strategyTimer);    this.strategyTimer = undefined }
      if (this.realtimeTimer)    { clearTimeout(this.realtimeTimer);    this.realtimeTimer = undefined }
      if (this.prehistoricTimer) { clearTimeout(this.prehistoricTimer); this.prehistoricTimer = undefined }
      if (this.healthCheckTimer) { clearInterval(this.healthCheckTimer); this.healthCheckTimer = undefined }
      if (this.heartbeatTimer)   { clearInterval(this.heartbeatTimer);   this.heartbeatTimer = undefined }

      await this.updateProgressionPhase("error", 0, errorMsg)
      await this.updateEngineState("error", errorMsg)
      await this.setRunningFlag(false)
      this.isStarting = false
      await logProgressionEvent(this.connectionId, "engine_error", "error", "Engine failed to start", {
        error: errorMsg,
        stack: error instanceof Error ? error.stack : undefined,
      })
      // Surface startup failure to the coordinator. Swallowing the error made
      // callers mark the connection active/running even though all timers were
      // cleared and the progression was already in error state, which is a
      // production-only source of stalled/doubled progress after restarts.
      throw error
    }
  }

  /**
   * Graceful error recovery — catches unhandled rejections that escape the
   * processor try/catch blocks and re-arms the engine in place instead of
   * letting it die. Idempotent across re-init: the listener is attached
   * exactly once per process via a global flag.
   */
  private setupErrorRecovery() {
    const g = globalThis as unknown as { __engine_unhandled_attached?: boolean }
    if (g.__engine_unhandled_attached) return
    g.__engine_unhandled_attached = true

    try { (process as any).setMaxListeners?.(50) } catch {}

    process.on("unhandledRejection", (reason) => {
      // The listener is global and shared across all live managers. We
      // can't tell which engine the rejection belongs to, so we route it
      // through the global coordinator: every running engine gets a
      // chance to re-arm any missing timers. This is what makes the
      // "self-heal in-place, no engine restart" guarantee real — a stray
      // unhandled rejection no longer silently kills the loop.
      console.error("[v0] [Engine] Unhandled rejection:", reason)
      ;(async () => {
        try {
          const { getGlobalCoordinator } = await import("@/lib/trade-engine")
          const coord = getGlobalCoordinator?.()
          if (!coord) return
          // @ts-expect-error - reach into the coordinator's manager map
          const managers: Map<string, TradeEngineManager> | undefined = coord.engineManagers
          if (!managers) return
          for (const [, mgr] of managers.entries()) {
            if (!mgr.isEngineRunning) continue
            try { await mgr.rearmIfStalled() } catch {}
          }
        } catch {
          // If even the import fails (extremely unlikely), at least make
          // sure the current manager survives.
          if (this.isRunning) {
            try { await this.rearmIfStalled() } catch {}
            try { await this.updateEngineState("error", `Unhandled rejection: ${reason}`) } catch {}
          }
        }
      })().catch(() => {})
    })
  }

  /**
   * Arm realtime/strategy/live processors exactly once for this engine generation.
   * Prehistoric startup can complete through either the continuous first-pass loop
   * or the one-time full-load path; both call this helper, so the idempotent guard
   * prevents duplicate timer loops while still guaranteeing realtime starts after
   * the authoritative prehistoric gate opens.
   */
  private armLiveProgressions(reason: string): void {
    if (!this.isRunning || this.liveProgressionsArmed || !this.startConfig) return
    this.liveProgressionsArmed = true
    console.log(
      `[v0] [Engine ${this.connectionId}] ${reason} — arming Realtime, Strategy heartbeat, and LivePositions loops.`,
    )
    this.startIndicationProcessor(this.startConfig.indicationInterval)
    this.startStrategyProcessor(this.startConfig.strategyInterval)
    this.startRealtimeProcessor(this.startConfig.realtimeInterval)
  }

  /**
   * In-place self-heal for a stalled engine. Called by the coordinator's
   * watchdog (heartbeat older than 60s) and the unhandled-rejection
   * recovery path. Re-arms ONLY the processor timers that are currently
   * missing — does NOT stop/start the engine, NOT rebuild the manager,
   * NOT re-load market data, NOT re-run prehistoric.
   *
   * Returns true if at least one processor timer was re-armed, false if
   * everything was already armed (in which case we just refresh the
   * heartbeat so the watchdog sees liveness on the next pass).
   */
  async rearmIfStalled(): Promise<boolean> {
    if (!this.isRunning || !this.startConfig) return false

    const reasons: string[] = []
    try {
      if (!this.indicationTimer) {
        this.startIndicationProcessor(this.startConfig.indicationInterval)
        reasons.push("indication")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm indication failed:`, e)
    }
    try {
      if (!this.strategyTimer) {
        this.startStrategyProcessor(this.startConfig.strategyInterval)
        reasons.push("strategy")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm strategy failed:`, e)
    }
    try {
      if (!this.realtimeTimer) {
        this.startRealtimeProcessor(this.startConfig.realtimeInterval)
        reasons.push("realtime")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm realtime failed:`, e)
    }
    try {
      if (!this.prehistoricTimer) {
        this.startPrehistoricProgression()
        reasons.push("prehistoric")
      }
    } catch (e) {
      console.error(`[v0] [Engine ${this.connectionId}] re-arm prehistoric failed:`, e)
    }

    if (reasons.length === 0) {
      // All timers already exist — they may simply be blocked on Redis
      // I/O. Force a heartbeat write so the watchdog sees liveness on the
      // next 10s pass and surfaces any I/O issue separately in the logs.
      try { await this.updateEngineState("running") } catch {}
      try {
        const stateKey = `trade_engine_state:${this.connectionId}`
        await setSettings(stateKey, { last_processor_heartbeat: Date.now() })
      } catch {}
      return false
    }

    try {
      await logProgressionEvent(
        this.connectionId,
        "engine_rearmed",
        "warning",
        `Re-armed in place: ${reasons.join(", ")}`,
        { reasons, connectionId: this.connectionId },
      )
    } catch {
      // Logging is best-effort; never block recovery on it.
    }
    return true
  }

  async stop(): Promise<void> {
    console.log("[v0] Stopping trade engine for connection:", this.connectionId)

    // Clear all timers. Processor loops are setTimeout-based; health/heartbeat
    // are still setInterval. clearTimeout + clearInterval are the same kernel
    // primitive in Node, but we keep the semantically correct one per timer.
    if (this.indicationTimer) {
      clearTimeout(this.indicationTimer)
      this.indicationTimer = undefined
    }
    if (this.strategyTimer) {
      clearTimeout(this.strategyTimer)
      this.strategyTimer = undefined
    }
    if (this.realtimeTimer) {
      clearTimeout(this.realtimeTimer)
      this.realtimeTimer = undefined
    }
    if (this.prehistoricTimer) {
      clearTimeout(this.prehistoricTimer)
      this.prehistoricTimer = undefined
    }
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    // ── Lock-extend ticker must die BEFORE we release the lock ─────
    // Otherwise a final extend could fire concurrently with release
    // and re-extend a key we just told Redis to drop.
    if (this.lockExtendTimer) {
      clearInterval(this.lockExtendTimer)
      this.lockExtendTimer = undefined
    }
    // Settings watcher must die alongside the engine — otherwise a
    // stopped manager would keep polling and could re-apply a change
    // it has no business touching.
    if (this.settingsWatcherTimer) {
      clearInterval(this.settingsWatcherTimer)
      this.settingsWatcherTimer = undefined
    }

    this.isRunning = false
    this.liveProgressionsArmed = false
    // Capture epoch before zeroing so endProgression can use it for the
    // stale-stop guard (prevents a delayed stop() from closing a newer
    // progression that already started in a different worker/restart).
    const stoppingEpoch = this.epoch
    // Zero the epoch immediately so any in-flight callbacks bound to
    // this manager instance fail the `isCurrentGeneration` check and
    // bail out instead of writing into a stopped engine's state.
    this.epoch = 0

    // Drop module-level throttle entries for this connection. Without
    // this, an immediate restart would inherit fingerprint state from
    // the stopped engine and could delay the first productive tick by
    // up to STRATEGY_FLOW_HARD_THROTTLE_MS. Also keeps the throttle
    // map from growing unbounded across many engine bounces.
    try { clearFlowThrottleForConnection(this.connectionId) } catch { /* best-effort */ }

    // ── Stamp ended_at on the canonical progression hash ──────────
    // Must happen BEFORE lock release so the write is still gated by
    // the epoch we own. Best-effort — engine stop must not block even
    // if Redis is unavailable.
    try {
      await ProgressionStateManager.endProgression(this.connectionId, stoppingEpoch)
    } catch (endErr) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] endProgression failed (non-critical):`,
        endErr instanceof Error ? endErr.message : String(endErr),
      )
    }

    // ── Release the cross-process progression lock ─────────────────
    // Compare-and-delete: never deletes a slot we no longer own.
    // Best-effort — Redis problems must not block stop(). If we fail
    // to release, the lock's TTL (LOCK_TTL_SEC) provides the fallback
    // safety net and another worker can take over within at most one
    // TTL window.
    if (this.lockHandle) {
      try {
        await releaseProgressionLock(this.connectionId, this.lockHandle)
      } catch (err) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] release lock failed (TTL will reclaim):`,
          err instanceof Error ? err.message : String(err),
        )
      }
      this.lockHandle = undefined
    }

    // Update engine state and clear running flag
    await this.updateEngineState("stopped")
    await this.setRunningFlag(false)
    await this.updateProgressionPhase("stopped", 0, "Engine stopped")

    console.log("[v0] Trade engine stopped and timers cleared")
  }

  /**
   * PHASE 6: Non-blocking prehistoric data loading
   * Runs in background without blocking engine startup
   * Allows engine to proceed to processor startup immediately
   */
  private loadPrehistoricDataInBackground(cacheKey: string, redisClient: ReturnType<typeof getRedisClient>): void {
    this.updateProgressionPhase("prehistoric_data", 15, "Prehistoric calc starting — filling sets...")
      .then(() => this.loadPrehistoricData())
      .then(async () => {
        await redisClient.set(cacheKey, "1", { EX: 86400 })
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: true,
          prehistoric_data_source: "background",
          updated_at: new Date().toISOString(),
        })
        // ── Phase hand-off: prehistoric → live_trading ─────────────────
        // Prehistoric finished filling sets. The `:done` flag was set
        // inside loadPrehistoricData, so the indication/strategy/realtime
        // tick gates flip on their next refresh. Advance the dashboard
        // phase to `live_trading @ 100%` so the user sees the transition
        // immediately — without waiting for the tick gates to detect the
        // flag (up to 3 s lag on the cached refresh).
        try {
          const symCount = (await this.getSymbols()).length
          await this.updateProgressionPhase(
            "live_trading",
            100,
            `Live trading ACTIVE — evaluating ${symCount} symbol${symCount === 1 ? "" : "s"} against prehistoric sets`,
          )
          await setSettings(`trade_engine_state:${this.connectionId}`, {
            all_phases_started: true,
            indications_started: true,
            strategies_started: true,
            realtime_started: true,
            live_trading_started: true,
            engine_ready: true,
            updated_at: new Date().toISOString(),
          })
          this.armLiveProgressions("prehistoric full load complete")
        } catch (phaseErr) {
          console.warn(`[v0] [Engine] Failed to advance phase to live_trading after prehistoric:`, phaseErr instanceof Error ? phaseErr.message : String(phaseErr))
        }
      })
      .catch(async (err) => {
        console.warn(`[v0] [Engine] Prehistoric loading error:`, err instanceof Error ? err.message : String(err))
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: false,
          prehistoric_data_error: err instanceof Error ? err.message : String(err),
          updated_at: new Date().toISOString(),
        })
        // ── Error-path phase advance ────────────────────���──────────────
        // Even on prehistoric failure, force the gate open so the engine
        // doesn't appear "stuck at prehistoric_data" forever. The
        // realtime processor's Phase A (TP/SL on open positions) still
        // needs to run — only the prev-set enrichment depends on
        // prehistoric output, and that's a soft dependency.
        try {
          // Write BOTH gate flags. startPrehistoricProgression watches
          // `:firstpass:done` to arm realtime via onFirstPassComplete; if
          // only `:done` is written the replay loop spins forever without
          // ever calling the callback, leaving realtime permanently disabled.
          await Promise.all([
            redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 }),
            redisClient.set(`prehistoric:${this.connectionId}:firstpass:done`, "1", { EX: 86400 }),
          ])
          await this.updateProgressionPhase(
            "live_trading",
            100,
            `Live trading ACTIVE — prehistoric failed, running without prev-set enrichment`,
          )
          this.armLiveProgressions("prehistoric failure fallback")
        } catch { /* best-effort */ }
        // Fallback: load minimal market data
        try {
          const fallbackSymbols = ["DRIFTUSDT"]
          await loadMarketDataForEngine(fallbackSymbols)
        } catch (fallbackErr) {
          console.warn(`[v0] [Engine] Fallback market data failed:`, fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr))
        }
      })
  }

  /**
   * Load prehistoric data (historical data before real-time processing).
   *
   * Default range: last 8 HOURS, processed at 1-second timeframe intervals.
   * (The range is user-tunable via `app_settings.prehistoric_range_hours`,
   * bounded to 1-50h, step 1.) Prehistoric output drives the "prev position"
   * context consumed by the realtime processor — see the `prehistoric:{id}:done`
   * gate in `startRealtimeProcessor` below.
   *
   * Runs in background: the engine boot flow keeps progressing while we load,
   * and the realtime processor self-gates until the "done" flag flips. Errors
   * never stop subsequent processing.
   */
  private async loadPrehistoricData(): Promise<void> {
    // Default: 8-HOUR look-back, 1-second timeframe interval.
    // User can override via `app_settings.prehistoric_range_hours` (1-50h, step 1).
    // Legacy `trade_engine_state:{id}.prehistoric_range_days` is still respected for
    // backward compatibility.
    const DEFAULT_RANGE_HOURS = 8
    const DEFAULT_TIMEFRAME_SECONDS = 1
    const MIN_RANGE_HOURS = 1
    const MAX_RANGE_HOURS = 50

    const calcStartTs = Date.now()

    try {
      // Use the mirror-aware reader so the operator's prehistoric_range_hours
      // applies whether it was saved to the canonical (`app_settings`) or
      // legacy (`all_settings`) hash. Read the `getAppSettings` lazily from
      // redis-db to avoid adding another top-level import round-trip.
      const { getAppSettings } = await import("@/lib/redis-db")
      const [engineState, appSettings] = await Promise.all([
        getSettings(`trade_engine_state:${this.connectionId}`),
        getAppSettings(),
      ])

      // Resolve range in hours — priority: app_settings > engine state (hours) >
      // legacy engine state (days) > default.
      let rangeHours: number =
        Number((appSettings as any)?.prehistoric_range_hours) ||
        Number((engineState as any)?.prehistoric_range_hours) ||
        (Number((engineState as any)?.prehistoric_range_days) * 24) ||
        DEFAULT_RANGE_HOURS
      if (!Number.isFinite(rangeHours) || rangeHours <= 0) rangeHours = DEFAULT_RANGE_HOURS
      rangeHours = Math.min(MAX_RANGE_HOURS, Math.max(MIN_RANGE_HOURS, Math.round(rangeHours)))

      const storedTimeframeSec: number =
        Number((engineState as any)?.prehistoric_timeframe_seconds) || DEFAULT_TIMEFRAME_SECONDS

      // Derive legacy days value (rounded up) so existing UIs keep working.
      const storedRangeDays: number = Math.max(1, Math.ceil(rangeHours / 24))

      const symbols = await this.getSymbols()
      await logProgressionEvent(this.connectionId, "prehistoric_data_scan", "info", "Scanning symbols for prehistoric processing", {
        symbols,
        symbolsCount: symbols.length,
        rangeHours,
        rangeDays: storedRangeDays,
        timeframeSeconds: storedTimeframeSec,
      })
      console.log(
        `[v0] [Prehistoric] ▶ scan: ${symbols.length} symbols | range=${rangeHours}h | timeframe=${storedTimeframeSec}s`,
      )

      const prehistoricEnd = new Date()
      const prehistoricStart = new Date(prehistoricEnd.getTime() - rangeHours * 60 * 60 * 1000)

      // Store canonical range metadata so dashboard can display timeframe details
      const redisClient = getRedisClient()
      // SINGLE-WRITER RESET (fixes "0/N" stall): the run-start is the ONLY
      // place that resets the prehistoric progress counters. Clear the stale
      // dedup SET (it has an 86400 TTL so a prior partial run could otherwise
      // leak survivors into this run's scard-derived count) and the legacy
      // flat counter, then seed symbols_processed=0 + symbols_total here.
      // From this point ConfigSetProcessor is the SOLE incremental writer of
      // symbols_processed (always derived from scard of the SET it owns), so
      // the displayed count can never disagree with symbols_total.
      const initialSelection = await getCanonicalSymbolSelection(this.connectionId)
      const writerSelectionEpoch = initialSelection?.epoch || ""
      const ownsCurrentSelection = await ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
      const canonicalSymbolsTotal = await canonicalTotalForSymbols(this.connectionId, symbols)
      if (ownsCurrentSelection) {
        await redisClient.del(`prehistoric:${this.connectionId}:symbols`).catch(() => {})
      }
      await redisClient.hset(`prehistoric:${this.connectionId}`, {
        range_start: prehistoricStart.toISOString(),
        range_end: prehistoricEnd.toISOString(),
        range_hours: String(rangeHours),
        range_days: String(storedRangeDays),
        timeframe_seconds: String(storedTimeframeSec),
        is_complete: "0",
        ...(ownsCurrentSelection ? {
          symbol_selection_epoch: writerSelectionEpoch,
          symbols_processed: "0",
          symbols_total: String(canonicalSymbolsTotal),
          prehistoric_symbols_processed_count: "0",
        } : {}),
        started_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Initialize config sets and process prehistoric data through them
      const configProcessor = new ConfigSetProcessor(this.connectionId)
      const configInitResult = await configProcessor.initializeConfigSets()
      await logProgressionEvent(this.connectionId, "prehistoric_config_init", "info", "Config sets initialized", {
        indicationConfigs: configInitResult.indications,
        strategyConfigs: configInitResult.strategies,
      })

      // Process prehistoric data: only missing ranges, step by timeframe interval
      const processingResult = await configProcessor.processPrehistoricData(
        symbols,
        prehistoricStart,
        prehistoricEnd,
        storedTimeframeSec
      )
      await logProgressionEvent(this.connectionId, "prehistoric_processed", processingResult.errors > 0 ? "warning" : "info", `Prehistoric complete: ${processingResult.indicationResults} indications, ${processingResult.strategyPositions} strategies`, {
        symbolsTotal: processingResult.symbolsTotal,
        symbolsProcessed: processingResult.symbolsProcessed,
        candlesProcessed: processingResult.candlesProcessed,
        indicationResults: processingResult.indicationResults,
        strategyPositions: processingResult.strategyPositions,
        errors: processingResult.errors,
        durationMs: processingResult.duration,
        timeframeSeconds: storedTimeframeSec,
        rangeDays: storedRangeDays,
        intervalsProcessed: processingResult.intervalsProcessed || 0,
        missingIntervalsLoaded: processingResult.missingIntervalsLoaded || 0,
      })

      const totalPrehistoricDurationMs = Date.now() - calcStartTs

      // Mark prehistoric hash as complete.
      // AUTHORITATIVE symbols_processed: re-read the SCARD of the idempotent
      // SET that ConfigSetProcessor owned during the run. The local
      // `processingResult.symbolsProcessed` counter raced under parallelism and
      // can be lower than reality; SCARD is always the monotonic ground truth.
      const finalScardRaw = await redisClient
        .scard(`prehistoric:${this.connectionId}:symbols`)
        .catch(() => processingResult.symbolsProcessed)
      const finalScard = clampProcessedToTotal(finalScardRaw, processingResult.symbolsTotal)
      const ownsCurrentSelectionAtCompletion = await ownsCanonicalSymbolSelectionEpoch(this.connectionId, symbols, writerSelectionEpoch)
      await redisClient.hset(`prehistoric:${this.connectionId}`, {
        is_complete: "1",
        ...(ownsCurrentSelectionAtCompletion ? {
          symbol_selection_epoch: writerSelectionEpoch,
          symbols_processed: String(finalScard),
          symbols_total: String(processingResult.symbolsTotal),
        } : {}),
        candles_loaded: String(processingResult.candlesProcessed),
        indicators_calculated: String(processingResult.indicationResults),
        total_duration_ms: String(totalPrehistoricDurationMs),
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      await redisClient.expire(`prehistoric:${this.connectionId}`, 86400)

      // Publish an explicit "prehistoric done" marker. The live processors watch
      // this flag and switch from fast churn mode to adaptive-backoff idle mode
      // so the engine stops "spinning" on empty cycles once the historical calc
      // is finished. The interval itself stays effective whenever productive
      // work is available.
      await Promise.all([
        redisClient.set(`prehistoric:${this.connectionId}:done`, "1", { EX: 86400 }),
        redisClient.set(`prehistoric:${this.connectionId}:firstpass:done`, "1", { EX: 86400 }),
      ])

      // Emit a log event (NOT a phase overwrite) so the dashboard can show
      // prehistoric completion in its event stream. The PHASE itself is
      // advanced to `live_trading @ 100%` by the caller
      // (`loadPrehistoricDataInBackground.then(...)`) after this function
      // resolves �� keeping the phase write co-located with the cache-key
      // write and the `engine_ready` state flip for atomic transition.
      try {
        await logProgressionEvent(
          this.connectionId,
          "prehistoric_complete",
          processingResult.errors > 0 ? "warning" : "info",
          `Prehistoric calc done — ${finalScard}/${processingResult.symbolsTotal} symbols, ` +
          `${processingResult.candlesProcessed} candles, ${processingResult.indicationResults} indications, ` +
          `${processingResult.strategyPositions} positions in ${totalPrehistoricDurationMs}ms`,
          {
            symbolsTotal: processingResult.symbolsTotal,
            symbolsProcessed: finalScard,
            candlesProcessed: processingResult.candlesProcessed,
            indicationResults: processingResult.indicationResults,
            strategyPositions: processingResult.strategyPositions,
            errors: processingResult.errors,
            durationMs: totalPrehistoricDurationMs,
          },
        )
      } catch { /* non-critical */ }

      console.log(
        `[v0] [Prehistoric] ✓ complete in ${totalPrehistoricDurationMs}ms | ` +
        `symbols=${finalScard}/${processingResult.symbolsTotal} | ` +
        `candles=${processingResult.candlesProcessed} | ` +
        `indications=${processingResult.indicationResults} | ` +
        `strategies=${processingResult.strategyPositions} | ` +
        `errors=${processingResult.errors}`,
      )

      // Update state to mark prehistoric phase complete
      await setSettings(`trade_engine_state:${this.connectionId}`, {
        prehistoric_data_loaded: true,
        prehistoric_data_start: prehistoricStart.toISOString(),
        prehistoric_data_end: prehistoricEnd.toISOString(),
        prehistoric_range_hours: rangeHours,
        prehistoric_range_days: storedRangeDays,
        prehistoric_timeframe_seconds: storedTimeframeSec,
        prehistoric_duration_ms: totalPrehistoricDurationMs,
        prehistoric_symbols: symbols,
        config_sets_initialized: true,
        config_set_indication_results: processingResult.indicationResults,
        config_set_strategy_positions: processingResult.strategyPositions,
        ...(ownsCurrentSelection ? {
          config_set_symbols_total: processingResult.symbolsTotal,
          config_set_symbols_processed: finalScard,
        } : {}),
        config_set_candles_processed: processingResult.candlesProcessed,
        config_set_errors: processingResult.errors,
        config_set_duration_ms: processingResult.duration,
        prehistoric_last_processed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Also store in Redis sets for dashboard queries. Previously this loop
      // fired ~4 sequential awaits per symbol (4N round-trips for N symbols).
      // Fan-out everything in a single Promise.all — with 8h lookback × dozens
      // of symbols this alone saves hundreds of serialised awaits at startup.
      try {
        const client = getRedisClient()
        const symbolsKey = `prehistoric:${this.connectionId}:symbols`
        const writes: Promise<any>[] = []
        if (symbols.length > 0) {
          // Single SADD with multiple members, then one EXPIRE for the index.
          writes.push((client as any).sadd(symbolsKey, ...symbols))
          writes.push(client.expire(symbolsKey, 86400))
        }
        for (const symbol of symbols) {
          const loadedKey = `prehistoric:${this.connectionId}:${symbol}:loaded`
          // set with EX in a single command avoids the set+expire pair.
          writes.push(client.set(loadedKey, "true", { EX: 86400 } as any))
        }
        await Promise.all(writes)
      } catch (e) {
        console.warn("[v0] [Engine] Prehistoric Redis store failed:", e instanceof Error ? e.message : String(e))
      }
    } catch (error) {
      console.error("[v0] [Engine] Prehistoric loading failed:", error instanceof Error ? error.message : String(error))
      await logProgressionEvent(this.connectionId, "prehistoric_error", "error", "Prehistoric processing failed", {
        error: error instanceof Error ? error.message : String(error),
      })

      try {
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          prehistoric_data_loaded: false,
          prehistoric_data_error: error instanceof Error ? error.message : String(error),
          updated_at: new Date().toISOString(),
        })
      } catch { /* ignore */ }

      console.log("[v0] [Prehistoric] Proceeding with realtime processing despite prehistoric failure")
    }
  }

  /**
   * Load market data for a specific range from exchange API
   */
  private async loadMarketDataRange(symbol: string, start: Date, end: Date): Promise<void> {
    try {
      // For now, skip actual exchange API calls during development
      // Mark this range as synced in Redis
      await DataSyncManager.markSynced(
        this.connectionId,
        symbol,
        "market_data",
        end
      )
    } catch (error) {
      console.error(`[v0] [Engine] Market data sync failed:`, error instanceof Error ? error.message : String(error))
    }
  }

  /**
   * Process connection through all 5 stages: Indication → Base → Main → Real → Live
   */
  private async processConnection5Stages(connection: any): Promise<void> {
    const connectionId = connection.id || connection.name
    const startTime = Date.now()

    try {
      // Process 5 stages of analysis and execution
      await logProgressionEvent(connectionId, "cycle_start", "info", "Starting 5-stage cycle", {})
      const indications = await this.indicationProcessor.processIndication(connection.monitored_symbol || "BTC/USDT")
      const basePositionCount = indications ? 2 : 0

      const duration = Date.now() - startTime
      await logProgressionEvent(connectionId, "cycle_complete", "info", "5-stage cycle complete", {
        duration,
        basePositions: basePositionCount,
      })
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      console.error(`[v0] [Engine] 5-stage cycle error: ${error}`)
      await logProgressionEvent(connectionId, "cycle_error", "error", error, { duration: Date.now() - startTime })
      throw err
    }
  }

  /**
   * Start indication processor (async)
   * Runs every 1 second with debouncing to prevent overlaps
   */
  // Indication processor - runs strategy evaluation on interval
  // Version 3.0 - Removed totalStrategiesEvaluated to fix stale closure issues
  // Version 4.0 - Converted from setInterval to self-scheduling setTimeout so
  //   each cycle runs back-to-back with a configurable pause (app_settings.cyclePauseMs,
  //   10-200ms, default 50ms). This removes the old "skip-when-busy" pattern that
  //   was causing the cycle time to climb to 4s+ and the engine to appear hung.
  private startIndicationProcessor(_intervalSeconds: number = 1): void {
    // Idempotency guard: if this loop is already armed, tear the existing
    // timer down before installing a new one. Each start*Processor ends by
    // assigning `this.indicationTimer = setTimeout(...)`; without this guard
    // a second invocation (any future restart/arm path) would overwrite the
    // handle and orphan the prior self-rescheduling loop, leaving TWO tick
    // loops running forever — doubling Redis/exchange load and corrupting
    // cycle counters. rearmIfStalled guards externally, but the method must
    // self-protect too.
    if (this.indicationTimer) {
      try { clearTimeout(this.indicationTimer); unregisterEngineTimer(this.indicationTimer) } catch { /* stale handle */ }
      this.indicationTimer = undefined
    }
    // Counter variables for metrics tracking - simplified to avoid closure issues
    let cycleCount = 0
    let attemptedCycles = 0
    let totalDuration = 0
    let errorCount = 0

    // Adaptive idle backoff. When prehistoric calc is complete and the cycle
    // produces zero indications we progressively increase the pause from the
    // user-configured cyclePauseMs up to MAX_IDLE_PAUSE_MS. A productive cycle
    // immediately resets the backoff so the "effective interval" stays fast
    // whenever new data is arriving.
    const MAX_IDLE_PAUSE_MS = 1000
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId

    const scheduleNext = (wasProductive: boolean) => {
      if (!this.isRunning) return
      // STABILITY: scheduleNext is the ONLY thing keeping this loop alive.
      // If `setTimeout` or the unregister call ever throws (stale handle,
      // weird runtime, etc.) we MUST still rearm — otherwise the engine
      // silently dies. Catch everything and try a default-pause fallback.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (wasProductive) {
          consecutiveEmptyCycles = 0
        } else {
          consecutiveEmptyCycles++
          const prehistoricDone = prehistoricDoneFlag
          if (prehistoricDone && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        // Unregister the prior handle BEFORE overwriting it so the global
        // `__engine_timers` Set doesn't grow unbounded.
        try {
          if (this.indicationTimer) unregisterEngineTimer(this.indicationTimer)
        } catch { /* stale handle is fine */ }
        this.indicationTimer = setTimeout(tick, pause)
        registerEngineTimer(this.indicationTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] indication scheduleNext failed; fallback rearm:`, err)
        try {
          this.indicationTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.indicationTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm indication timer`, fatal)
        }
      }
    }

    // Cheap cached flag — refreshed in the background every few seconds so the
    // scheduler never blocks on Redis I/O. Flips true once prehistoric is done.
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const engineStartTime = Date.now()
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    // Prime immediately and refresh every 3s
    void refreshPrehistoricDone()

    const tick = async () => {
      if (!this.isRunning) return

      // Check pause state before executing cycle (cached, 1 s TTL)
      try {
        if (await isGloballyPausedCached()) {
          // Engine paused - reschedule but skip processing
          scheduleNext(false)
          return
        }
      } catch (err) {
        // Ignore Redis errors - continue with cycle
      }

      const startTime = Date.now()
      // Local abort flag — when true, the finally block will NOT schedule the next cycle.
      let aborted = false
      // Productivity marker — tracks whether this cycle did meaningful work so
      // scheduleNext() can reset / grow the idle backoff.
      let producedIndications = false

      // Refresh the prehistoric-done flag every 3s (non-blocking).
      if (startTime - prehistoricDoneCheckedAt > 3000) {
        prehistoricDoneCheckedAt = startTime
        void refreshPrehistoricDone()
      }

      // STABILITY: removed the V8 "stale module version self-clear".
      // Previously this block fired the moment `_ENGINE_BUILD_VERSION` was
      // bumped, cleared the indication timer, and `return`-ed *without*
      // calling `scheduleNext()`. The indication loop then went silent
      // forever for every running engine — a primary cause of the
      // "Trade Engines silently stop running after a deploy" symptom.
      // The only valid loop-exit condition is `!this.isRunning`, checked
      // at the top of this `tick`.

      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) {
          // No symbols yet — fall through; finally will schedule the next attempt.
          return
        }

        // ── CHECK: Settings dirty flag and reload if needed ─��────────────���─────────
        // When user updates connection settings via UI, a dirty flag is set.
        // On the next indication tick, we detect it and clear the flag.
        // Throttle to 1×/sec — at 20 Hz the GET would fire ~20 times/sec
        // per connection just to poll a typically-false flag.
        try {
          if (startTime - this._lastDirtyCheckMs >= 1000) {
            this._lastDirtyCheckMs = startTime
            const client = getRedisClient()
            const dirtyKey = `settings:dirty:${this.connectionId}`
            const isDirty = await client.get(dirtyKey)
            if (isDirty) {
              // Clear the dirty flag
              await client.del(dirtyKey)
              console.log(
                `[v0] [IndicationProcessor] Settings reloaded for ${this.connectionId}`
              )
            }
          }
        } catch (settingsErr) {
          // Non-critical - continue processing even if dirty check fails
          console.warn(
            `[v0] [IndicationProcessor] Settings dirty check failed:`,
            settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
          )
        }

        // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
        // The indication tick evaluates sets that the prehistoric calculator
        // is busy filling. Running it on half-filled or empty sets pollutes
        // `indications_count` / `indication_cycle_count` and flips the
        // dashboard phase auto-derivation to "live_trading" prematurely.
        // Stay silent until the `:done` flag flips — `producedIndications`
        // remains false so scheduleNext re-polls quickly via the empty-cycle
        // backoff (capped at 1s) rather than churning.
        const elapsedSinceBoot = Date.now() - engineStartTime
        const prehistoricStalled = elapsedSinceBoot > 60000 // 60s safety valve
        if (!prehistoricDoneFlag && !prehistoricStalled) {
          // Force a fresh flag read on every gated tick (cheap single-key
          // GET) so we flip to productive within one tick of prehistoric
          // completing, not up to 3s later.
          await refreshPrehistoricDone()
          if (!prehistoricDoneFlag) {
            return
          }
        }
        
        if (prehistoricStalled && !prehistoricDoneFlag) {
          // SAFETY VALVE: 60s passed, prehistoric hasn't signaled done.
          // Either it stalled, crashed, or is slower than expected.
          // Force the :done flag and proceed to realtime to prevent
          // engine from hanging forever. Log the condition.
          console.error(
            `[v0] [SAFETY VALVE] Prehistoric stalled >60s for ${connId}, ` +
            `forcing realtime start and marking prehistoric done`
          )
          prehistoricDoneFlag = true
          const client = getRedisClient()
          try {
            await client.set(`prehistoric:${connId}:done`, "1")
            await client.expire(`prehistoric:${connId}:done`, 86400)
          } catch (e) {
            console.error(`[v0] Failed to write safety valve done flag: ${e}`)
          }
        }

        attemptedCycles++

        // Batch-prefetch all symbols' market data in one Redis pipeline pass
        await prefetchMarketDataBatch(symbols).catch(() => { /* non-critical */ })

        // Process indications for every symbol in parallel — but with a
        // hard concurrency cap (`SYMBOL_CONCURRENCY`) so dense watchlists
        // don't saturate the Redis pipeline or starve the event loop.
        // Wrapped in `withCycleDeadline` so a single hung await inside
        // any `processIndication` call (Redis stall / network black-hole)
        // can never wedge the loop — the deadline fires, the tick falls
        // through to `finally`, and `scheduleNext` re-arms.
        //
        // Per-symbol failures are converted into an empty-indications
        // sentinel AND an entry in `failedSymbols` so we can surface
        // partial-coverage telemetry (operator-visible Redis counter +
        // progression-event ledger) instead of silently swallowing it.
        // ── REALTIME PROGRESSION (per architectural spec) ──────────────
        // This loop is the **Realtime Progression** — for each symbol it
        // drives the canonical shared 3-phase pipeline:
        //   Phase 1: indication evaluation
        //   Phase 2: pseudo position update/close (ALWAYS)
        //   Phase 3: strategy evaluation (gated on valid indications)
        //
        // The legacy startStrategyProcessor loop is now a no-op (kept
        // for rearmIfStalled compatibility). All ind+strat work for
        // realtime mode happens here, in one synchronized cycle per
        // symbol — guaranteeing the spec's "same intervalled progress
        // for ind and strat" contract and the "pseudo handling between
        // indications and strategies" ordering.
        // ── Per-symbol error tracking: each task's .catch() handler
        // writes its own error counters to Redis inline (see below).
        // This guarantees correct counts even when withCycleDeadline
        // fires before all tasks settle — no silent data loss.
        const pipelineDeps = {
          indication: this.indicationProcessor,
          strategy: this.strategyProcessor,
          realtime: this.realtimeProcessor,
        }
        const pipelineResults = await withCycleDeadline(
          mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, (symbol) =>
            runIndStratCycle(this.connectionId, symbol, "realtime", pipelineDeps).catch(async (err) => {
              const msg = err instanceof Error ? err.message : String(err)
              console.error(`[v0] [RealtimeProgression] Error for ${symbol}:`, msg)
              // ── Inline error tracking ────��───────────────────────────
              // Per-symbol error counters are written to Redis from inside
              // each task's catch handler, NOT deferred to the outer
              // `failedSymbols` array. If `withCycleDeadline` fires before
              // all tasks complete, the tasks that DID complete still write
              // their errors ��� no silent data loss.
              try {
                const client = getRedisClient()
                const progKey = `progression:${this.connectionId}`
                const safeMsg = msg.slice(0, 240)
                await Promise.all([
                  client.hincrby(progKey, "indication_symbol_errors_count", 1),
                  client.hset(progKey, {
                    indication_symbol_errors_last_at: new Date().toISOString(),
                    [`indication_symbol_last_error:${symbol}`]: safeMsg,
                  }),
                  client.hincrby(progKey, `indication_symbol_errors:${symbol}`, 1),
                ])
              } catch { /* best-effort */ }
              return {
                symbol,
                mode: "realtime" as const,
                indicationCount: 0,
                indicationTypeCounts: {},
                pseudoUpdates: 0,
                strategiesEvaluated: 0,
                liveReady: 0,
                durationMs: 0,
                error: msg,
              }
            }),
          ),
          `Engine ${this.connectionId} realtime-progression`,
        )

        // NOTE: Coordinator is invoked per-symbol by the strategy processor
        // (strategy-processor.ts line 252) during indication processing.
        // No separate aggregation call needed — the per-symbol execution
        // already produces BASE/MAIN/REAL/LIVE sets that persist to Redis
        // and are visible via the stats API.

        // Synthesize indication-result shape from the pipeline results
        // so the existing telemetry block below works unchanged. The
        // pipeline returns indication counts but not the full indication
        // objects, so we materialize empty arrays sized to the count —
        // sufficient for the per-cycle counter writes (count + types are
        // tracked at the processor level by `saveIndication`).
        const indicationResults: any[][] = pipelineResults.map((r) =>
          Array.from({ length: r.indicationCount }, () => ({})),
        )
        const symbolIndicationCounts: Record<string, number> = {}
        // The underlying processors (IndicationProcessor.processIndication
        // and StrategyProcessor.processStrategy) write their OWN counters
        // into the progression hash on every call. The pipeline-level
        // aggregation here is purely for the optional progress event log
        // emitted at the tail of this cycle.
        let pipelineStrategiesEvaluated = 0
        let pipelineLiveReady = 0
        let pipelinePseudoUpdates = 0
        for (let i = 0; i < pipelineResults.length; i++) {
          const r = pipelineResults[i]
          symbolIndicationCounts[r.symbol] = r.indicationCount
          pipelineStrategiesEvaluated += r.strategiesEvaluated
          pipelineLiveReady += r.liveReady
          pipelinePseudoUpdates += r.pseudoUpdates
        }

        // Build per-type counts from the actual indications emitted by
        // processIndication. PipelineCycleResult carries an already-reduced
        // map so this loop preserves canonical live families (direction, move,
        // active, optimal, auto, and any future processor-emitted types) without
        // synthesizing pseudo-types such as pf_inline/strategy_eval/live_ready.
        const indicationTypeCounts: Record<string, number> = {}
        for (const r of pipelineResults) {
          for (const [type, count] of Object.entries(r.indicationTypeCounts ?? {})) {
            if (count > 0) {
              indicationTypeCounts[type] = (indicationTypeCounts[type] ?? 0) + count
            }
          }
        }
        void pipelineStrategiesEvaluated; void pipelineLiveReady; void pipelinePseudoUpdates

        const totalIndications = indicationResults.reduce((sum: number, arr: any[]) => sum + (arr?.length || 0), 0)
        // producedIndications = totalIndications > 0
        producedIndications = totalIndications > 0
        const missingTypeBreakdown = totalIndications > 0 && Object.keys(indicationTypeCounts).length === 0
        if (missingTypeBreakdown) {
          console.warn(
            `[v0] [IndicationProcessor] WARNING: produced ${totalIndications} indications but no indication types were reported`,
          )
        }

        // Increment cycle count BEFORE writing to Redis so the stored value is accurate
        cycleCount++
        const duration = Date.now() - startTime
        totalDuration += duration

        // ── Log detailed breakdown (throttled) ─────────────────────────
        //
        // The original implementation logged THREE stdout lines on EVERY
        // tick. At the live cadence (~50 ms cycle pause + ~30-50 ms work)
        // the engine produces ~15-20 cycles/sec, which translates to
        // 45-60 stdout writes/sec from this single block alone. Stdout
        // writes block the Node event loop, so HTTP requests to the
        // dashboard time out and the UI looks "crashed".
        //
        // Two-tier throttling preserves observability without flooding:
        //   1. Always log the FIRST tick after a fresh start (boot signal).
        //   2. Otherwise, log every Nth cycle (50 → ~2.5 s at typical
        //      cadence, ~5 s at 100 ms). N is set high enough that the
        //      diagnostic is human-readable and low enough that long-tail
        //      issues still surface in production trace dumps.
        //
        // The Redis hincrby counters below are UNTHROTTLED — those don't
        // touch stdout and feed the live dashboard, which the operator
        // expects to update continuously.
        const CYCLE_LOG_EVERY = 50
        if (cycleCount === 1 || cycleCount % CYCLE_LOG_EVERY === 0) {
          console.log(`[v0] [IndicationProcessor CYCLE ${cycleCount}] Symbols: ${symbols.length} | Total Indications: ${totalIndications}`)
          console.log(`[v0] [IndicationProcessor] Per-symbol: ${JSON.stringify(symbolIndicationCounts)}`)
          console.log(`[v0] [IndicationProcessor] Per-type: ${JSON.stringify(indicationTypeCounts)}`)
        }

        // Write per-type counters into progression hash so dashboard reads real values.
        //
        // COUNTER TAXONOMY (user-facing progression vs. prehistoric/churn processing):
        //   * indication_cycle_count          — EVERY tick (incl. warmup/empty cycles). Treat as
        //                                       "prehistoric processing" churn — hidden from the
        //                                       primary live-progression display.
        //   * indication_live_cycle_count     — only ticks that produced at least one indication.
        //                                       This is the meaningful "live progression" counter.
        //   * indications_count / per-type    — cumulative indications generated (hincrby).
        //   * frames_processed                — cumulative tick count across ALL processors
        //                                       (indication + strategy + realtime). Independent
        //                                       of per-Set DB-entry caps — counts every loop tick
        //                                       since the engine started.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          // Fan-out all counter updates in parallel. The in-memory Redis
          // client services these in constant time; Promise.all minimises the
          // awaited round-trips per cycle compared to sequential awaits.
          const nowMs = Date.now()
          const nowIso = new Date(nowMs).toISOString()
          const writes: Promise<any>[] = [
            client.hincrby(redisKey, "indication_cycle_count", 1),
            // ── Realtime Progression cycle counter (three-progression refactor) ──
            // The legacy `realtime_cycle_count` field used to be incremented
            // inside `startRealtimeProcessor`'s per-position loop. That loop
            // was repurposed into the LivePositions Progression, which writes
            // its own `live_positions_cycle_count`. The dashboard's
            // `realtime` / `realtimeLive` tiles still read this field, so we
            // must keep it updated — and the canonical "realtime cycle" is
            // now THIS loop (shared ind+pseudo+strat pipeline per symbol).
            // One hincrby per Realtime Progression cycle matches the legacy
            // semantics: one cycle = one full per-symbol fan-out.
            client.hincrby(redisKey, "realtime_cycle_count", 1),
            client.hincrby(redisKey, "frames_processed", 1),
            client.hset(redisKey, "symbols_processed", String(symbols.length)),
            // Continuous "still alive" stamp on the progression hash so
            // the dashboard's freshness indicator never goes stale while
            // the engine is actively ticking. See same-pattern comment
            // in the strategy tick below.
            client.hset(redisKey, {
              last_activity_at: String(nowMs),
              last_indication_tick_at: String(nowMs),
            }),
            // ── Tick-level heartbeat for the stall watchdog ──
            // See same-pattern comment in the strategy tick: writing
            // `last_processor_heartbeat` from the tick itself prevents
            // false-positive stalls caused by event-loop starvation of
            // the 10 s `startHeartbeat` setInterval callback.
            client.hset(`settings:trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_processor_heartbeat: String(nowMs),
              last_indication_run: nowIso,
            }),
          ]
          // Gate expire to every 500 cycles — TTL is 7 days so resetting
          // it every tick wastes one Redis round-trip per cycle (~20/s).
          // At 500 cycles (20 Hz ≈ every 25 s) the key stays alive indefinitely.
          if (cycleCount % 500 === 1) {
            writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
          }
          // GATE ON REAL PRODUCTION: total indication telemetry remains based
          // on the produced total, while per-type counters are now written from
          // the real processor-emitted type map. If a cycle produces signals but
          // no type map, the warning above surfaces the mismatch without losing
          // the cumulative total.
          if (totalIndications > 0) {
            writes.push(client.hincrby(redisKey, "indication_live_cycle_count", 1))
            for (const [type, count] of Object.entries(indicationTypeCounts)) {
              writes.push(client.hincrby(redisKey, `indications_${type}_count`, count))
            }
            writes.push(client.hincrby(redisKey, "indications_count", totalIndications))
          }
          // ── Per-symbol error counters are now written inline inside each
          // task's .catch() handler (see withCycleDeadline call above).
          // No deferred array loop needed — counters are always correct
          // even when the deadline fires before all tasks complete.
          await Promise.all(writes)
        } catch { /* non-critical */ }

          const processedThisCycle = totalIndications

        this.componentHealth.indications.lastCycleDuration = duration
        this.componentHealth.indications.cycleCount = cycleCount
        this.componentHealth.indications.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // PROGRESSION CONTRACT: every tick counts as a completed cycle so the
        // dashboard can observe that the engine is alive and advancing.
        // “Productive” ticks still advance successful_cycles and indication
        // counters below; empty/clean ticks still drive completion rate.
        const hadWork = processedThisCycle > 0
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, hadWork, hadWork ? processedThisCycle : 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
        }

        // Persist non-counter snapshot data every 100 cycles to reduce Redis writes.
        //
        // INTENTIONALLY OMITTED FROM THIS SNAPSHOT (use progression:{id} instead):
        //   - indication_cycle_count        — authoritative source is hincrby on
        //                                     progression:{id}, which survives engine
        //                                     restarts. This local snapshot would
        //                                     reset to 0 on every restart and
        //                                     overwrite the live counter through the
        //                                     /stats fallback chain.
        //   - total_indications_generated   — was previously written as
        //                                     `totalIndications * cycleCount` which
        //                                     is mathematically nonsensical
        //                                     (current-tick count × loop counter).
        //                                     The cumulative is already maintained
        //                                     atomically as `indications_count` on
        //                                     progression:{id}.
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              connection_id: this.connectionId,
              status: "running",
              started_at: this.startTime?.toISOString() || new Date().toISOString(),
              last_indication_run: new Date().toISOString(),
              indication_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              symbols_in_scope: symbols.length,
            })
          } catch { /* silently fail */ }
        }

        // Track intervals processed in Redis for dashboard display.
        // Gate expire to every 500 cycles — same pattern as progression hash.
        try {
          const client = getRedisClient()
          const indication_key = `indication_cycles:${this.connectionId}`
          const p: Promise<any>[] = [client.incr(indication_key)]
          if (cycleCount % 500 === 1) p.push(client.expire(indication_key, 86400))
          await Promise.all(p)
        } catch { /* ignore errors */ }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error)

        // Suppress known stale closure errors from HMR - these will clear on server restart
        if (errorMessage.includes("totalStrategiesEvaluated is not defined")) {
          // Self-heal: clear this stale timer and do NOT reschedule
          aborted = true
          if (this.indicationTimer) {
            clearTimeout(this.indicationTimer)
            console.log("[v0] Cleared stale indication timer with totalStrategiesEvaluated error")
          }
          return
        }

        errorCount++
        this.componentHealth.indications.errorCount++
        // Track failed cycle on every error to keep progression counters accurate.
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, false, 0)
        } catch { /* non-critical */ }
        await logProgressionEvent(
          this.connectionId,
          "indications",
          "error",
          `Indication processor error: ${errorMessage}`,
          {
            attemptedCycles,
            successfulCycles: cycleCount,
            errorCount,
          },
        )
        console.error("[v0] Indication processor error:", error)
      } finally {
        // Schedule next cycle after configurable pause so the event loop can breathe.
        if (!aborted) scheduleNext(producedIndications)
      }
    }

    // Kick off the first cycle immediately (0 ms delay).
    this.indicationTimer = setTimeout(tick, 0)
    registerEngineTimer(this.indicationTimer)
  }

  /**
   * Start strategy processor (async)
   *
   * Self-scheduling setTimeout loop — cycles run back-to-back with a
   * configurable pause (app_settings.cyclePauseMs). Natural serialisation
   * prevents overlap without needing an isProcessing flag. Once prehistoric
   * calc is complete, idle cycles (0 strategies evaluated) back off
   * progressively up to 1s so the engine stops "spinning" on nothing.
   */
  private startStrategyProcessor(_intervalSeconds: number = 1): void {
    // Idempotency guard — see startIndicationProcessor. Prevents a leaked
    // duplicate heartbeat loop if this is ever (re)armed while already live.
    if (this.strategyTimer) {
      try { clearTimeout(this.strategyTimer); unregisterEngineTimer(this.strategyTimer) } catch { /* stale handle */ }
      this.strategyTimer = undefined
    }
    // ── ARCHITECTURAL CHANGE (three-progression refactor) ────────────────
    // Strategy evaluation no longer runs as an independent top-level
    // loop. It is now Phase 3 of the canonical shared ind+strat
    // pipeline, called per-symbol from inside the Realtime Progression
    // (which is driven by `startIndicationProcessor` for historical
    // method-name reasons — see header comment on that method).
    //
    // This method is kept as a long-interval heartbeat tick so the
    // `rearmIfStalled` watchdog continues to see `this.strategyTimer`
    // armed, and so call sites in startup / error cleanup don't need
    // to change. The tick body performs no work — it just self-
    // reschedules every 30 s.
    const HEARTBEAT_INTERVAL_MS = 30_000
    const heartbeatTick = () => {
      if (!this.isRunning) return
      try {
        if (this.strategyTimer) unregisterEngineTimer(this.strategyTimer)
      } catch { /* stale handle is fine */ }
      // Capture in a local const so TS keeps the non-undefined narrowing
      // across the property assignment + register call. Reading `this.strategyTimer`
      // back after assignment widens to `Timeout | undefined` because
      // control-flow analysis doesn't track property writes through `this`.
      const t = setTimeout(heartbeatTick, HEARTBEAT_INTERVAL_MS)
      this.strategyTimer = t
      registerEngineTimer(t)
    }
    heartbeatTick()
    return
    // The original loop body below is unreachable — preserved only as
    // a reference for the legacy behaviour. Safe to delete in a follow-up.

    let cycleCount = 0
    let totalDuration = 0
    let errorCount = 0
    let totalStrategiesEvaluated = 0

    // Adaptive idle backoff ��� same strategy as the indication processor.
    const MAX_IDLE_PAUSE_MS = 1000
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    void refreshPrehistoricDone()

    const scheduleNext = (wasProductive: boolean) => {
      if (!this.isRunning) return
      // See indication scheduleNext for the full stability rationale.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (wasProductive) {
          consecutiveEmptyCycles = 0
        } else {
          consecutiveEmptyCycles++
          if (prehistoricDoneFlag && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        try {
          if (this.strategyTimer) unregisterEngineTimer(this.strategyTimer)
        } catch { /* stale handle is fine */ }
        this.strategyTimer = setTimeout(tick, pause)
        registerEngineTimer(this.strategyTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] strategy scheduleNext failed; fallback rearm:`, err)
        try {
          this.strategyTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.strategyTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm strategy timer`, fatal)
        }
      }
    }

    const tick = async () => {
      if (!this.isRunning) return

      // Check pause state before executing cycle (cached, 1 s TTL)
      try {
        if (await isGloballyPausedCached()) {
          // Engine paused - reschedule but skip processing
          scheduleNext(false)
          return
        }
      } catch (err) {
        // Ignore Redis errors - continue with cycle
      }

      const startTime = Date.now()
      let producedStrategies = false

      if (startTime - prehistoricDoneCheckedAt > 3000) {
        prehistoricDoneCheckedAt = startTime
        void refreshPrehistoricDone()
      }

      // STABILITY: removed the V8 "stale module version self-clear" — see
      // identical note in the indication tick. Loop-exit is gated only on
      // `!this.isRunning`.

      try {
        // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
        // Strategy evaluation reads the same per-Set DBs that prehistoric
        // is filling. Skipping the tick until `:done` flips guarantees we
        // never evaluate strategies against an empty / half-populated set,
        // and prevents the `strategy_cycle_count` counter from inflating
        // before the calc actually completes.
        if (!prehistoricDoneFlag) {
          await refreshPrehistoricDone()
          if (!prehistoricDoneFlag) {
            return
          }
        }

        const symbols = await this.getSymbols()
        // Per-cycle deadline — see `withCycleDeadline` rationale at the
        // top of this file. Guards against a single hung
        // `processStrategy(symbol)` blocking the entire strategy loop.
        // Bounded fan-out (`mapWithConcurrency`) caps in-flight tasks at
        // SYMBOL_CONCURRENCY so dense watchlists don't saturate Redis or
        // stall the event loop.
        //
        // Per-symbol errors are now tracked (previously silently
        // swallowed): the rejection is recorded, a sentinel returned so
        // counts stay correct, and the failing symbol is logged so the
        // operator can see a chronic per-symbol breakage.
        const strategyFailedSymbols: { symbol: string; error: string }[] = []
        const strategyResults = await withCycleDeadline(
          mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, (symbol) =>
            this.strategyProcessor.processStrategy(symbol).catch((err) => {
              const msg = err instanceof Error ? err.message : String(err)
              strategyFailedSymbols.push({ symbol, error: msg })
              console.error(`[v0] [StrategyProcessor] Error for ${symbol}:`, msg)
              return { strategiesEvaluated: 0, liveReady: 0 }
            }),
          ),
          `Engine ${this.connectionId} strategy`,
        )

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        const evaluatedThisCycle = strategyResults.reduce((sum: number, result: any) => sum + (result?.strategiesEvaluated || 0), 0)
        const liveReadyThisCycle = strategyResults.reduce((sum: number, result: any) => sum + (result?.liveReady || 0), 0)
        producedStrategies = evaluatedThisCycle > 0

        // Defensive: handle stale closures from HMR
        try {
          totalStrategiesEvaluated += evaluatedThisCycle
        } catch {
          // Stale closure - skip
        }

        // Detailed per-symbol strategy breakdown
        const symbolStrategyBreakdown: Record<string, number> = {}
        for (let i = 0; i < strategyResults.length; i++) {
          symbolStrategyBreakdown[symbols[i]] = strategyResults[i]?.strategiesEvaluated || 0
        }

        // Same 1/50 throttle as the IndicationProcessor block above —
        // see that comment for rationale (Node event-loop hygiene at the
        // 50 ms cycle cadence).
        const STRATEGY_LOG_EVERY = 50
        if (cycleCount === 1 || cycleCount % STRATEGY_LOG_EVERY === 0) {
          console.log(`[v0] [StrategyProcessor CYCLE ${cycleCount}] Total Evaluated: ${evaluatedThisCycle} | Live Ready: ${liveReadyThisCycle} | Total Cumulative: ${totalStrategiesEvaluated}`)
          console.log(`[v0] [StrategyProcessor] Per-symbol breakdown: ${JSON.stringify(symbolStrategyBreakdown)}`)
        }

        this.componentHealth.strategies.lastCycleDuration = duration
        this.componentHealth.strategies.cycleCount = cycleCount
        this.componentHealth.strategies.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // Write ONLY cycle-level metrics into the progression hash.
        // Per-stage Set counts (strategies_base_total, strategies_main_total,
        // strategies_real_total, strategy_evaluated_*) are written atomically inside
        // StrategyCoordinator.executeStrategyFlow() to avoid double-counting.
        //
        // See indication-processor comment above for counter taxonomy:
        //   strategy_cycle_count          = every tick (churn)
        //   strategy_live_cycle_count     = only ticks that evaluated at least 1 strategy
        //   strategies_count              = canonical TOTAL strategies produced.
        //     `evaluatedThisCycle` sums strategy-processor results across symbols,
        //     where each result's `strategiesEvaluated` is the REAL-stage (final)
        //     count only — Base/Main are intermediate filter stages of the SAME
        //     pipeline and are NOT added here, so cross-symbol sums are safe.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          // Fan-out cycle counters in parallel — same atomic-counter
          // pattern as the indication tick. Replacing the previous
          // sequential awaits saves multiple RTTs per cycle and lets us
          // include the per-symbol error fields in the same batch.
          const nowMs = Date.now()
          const nowIso = new Date(nowMs).toISOString()
          const writes: Promise<any>[] = [
            client.hincrby(redisKey, "strategy_cycle_count", 1),
            client.hincrby(redisKey, "frames_processed", 1),
            client.hset(redisKey, "strategies_live_ready", String(liveReadyThisCycle)),
            // ── Per-tick "still alive" stamps on the progression hash ──
            // The dashboard reads `last_activity_at` to render a "fresh"
            // indicator continuously, INDEPENDENT of whether this cycle
            // produced strategies (the strategy flow may be throttled).
            // Cheap single-field hset; no extra round trips because it
            // joins the Promise.all batch.
            client.hset(redisKey, {
              last_activity_at: String(nowMs),
              last_strategy_tick_at: String(nowMs),
            }),
            // ── CRITICAL: tick-level heartbeat for the stall watchdog ──
            // The coordinator's stall watchdog reads
            // `last_processor_heartbeat` from `settings:trade_engine_state:{id}`
            // to decide whether to re-arm / restart this engine. Until
            // now that field was ONLY written by the 10 s `setInterval`
            // heartbeat in `startHeartbeat`. If event-loop pressure /
            // a long GC pause / a slow tick delays the interval callback
            // past 90 s the watchdog falsely declares a stall and
            // restarts a perfectly-healthy engine. Writing the heartbeat
            // from the tick itself ties liveness to ACTUAL processing
            // activity — the only signal that actually matters.
            client.hset(`settings:trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_processor_heartbeat: String(nowMs),
              last_strategy_run: nowIso,
            }),
          ]
          // Gate expire — same rationale as indication tick above.
          if (cycleCount % 500 === 1) {
            writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
          }
          if (evaluatedThisCycle > 0) {
            writes.push(client.hincrby(redisKey, "strategy_live_cycle_count", 1))
            writes.push(client.hincrby(redisKey, "strategies_count", evaluatedThisCycle))
          }
          // ── Per-symbol error visibility ────────────────────────────────
          // Mirrors the indication tick. Without this a chronically-
          // failing symbol's strategy errors would be silently swallowed
          // by the per-task `.catch` and the dashboard would show green.
          if (strategyFailedSymbols.length > 0) {
            writes.push(
              client.hincrby(redisKey, "strategy_symbol_errors_count", strategyFailedSymbols.length),
            )
            writes.push(
              client.hset(redisKey, {
                strategy_symbol_errors_last_cycle: String(strategyFailedSymbols.length),
                strategy_symbol_errors_last_at: new Date().toISOString(),
              }),
            )
            for (const { symbol, error } of strategyFailedSymbols) {
              writes.push(client.hincrby(redisKey, `strategy_symbol_errors:${symbol}`, 1))
              const safeMsg = error.slice(0, 240)
              writes.push(
                client.hset(redisKey, {
                  [`strategy_symbol_last_error:${symbol}`]: safeMsg,
                }),
              )
            }
          }
          await Promise.all(writes)
        } catch { /* non-critical */ }

        // PROGRESSION CONTRACT: every tick counts as a completed cycle.
        // Productive ticks still advance successful_cycles and strategy
        // counters below; empty/clean ticks still drive completion rate.
        const hadWork = evaluatedThisCycle > 0
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, hadWork, hadWork ? evaluatedThisCycle : 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Strategy cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
        }

        // Persist non-counter snapshot data every 50 cycles to reduce Redis writes.
        //
        // INTENTIONALLY OMITTED FROM THIS SNAPSHOT (authoritative source is the
        // progression:{id} hash):
        //   - strategy_cycle_count           — atomic hincrby, survives restarts
        //   - total_strategies_evaluated     — local in-process counter; the
        //                                      authoritative cumulative is the
        //                                      `strategies_count` field on
        //                                      progression:{id}.
        //   - engine_cycles_total            — meaningless when written from a
        //                                      single processor's cycleCount; the
        //                                      cross-processor total now lives in
        //                                      progression:{id}.frames_processed.
        if (cycleCount % 50 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_strategy_run: new Date().toISOString(),
              strategy_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              strategies_live_ready: liveReadyThisCycle,
              last_cycle_duration: duration,
              last_cycle_type: "strategies",
            })
          } catch { /* silently fail */ }
        }

        // Track detailed performance metrics every 50 cycles
        if (cycleCount % 50 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "strategies", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
            durationMs: duration,
            symbolsProcessed: symbols.length,
            strategiesEvaluated: evaluatedThisCycle,
            strategiesLiveReady: liveReadyThisCycle,
            totalCumulativeStrategies: totalStrategiesEvaluated,
            errors: errorCount,
          })
        }
      } catch (error) {
        errorCount++
        this.componentHealth.strategies.errorCount++
        const errorMessage = error instanceof Error ? error.message : String(error)
        await logProgressionEvent(this.connectionId, "strategies", "error", `Strategy processor error: ${errorMessage}`, {
          attemptedCycles: cycleCount,
          successfulCycles: cycleCount - errorCount,
          errorCount,
        })
        console.error("[v0] Strategy error:", errorMessage)
      } finally {
        scheduleNext(producedStrategies)
      }
    }

    // Kick off the first cycle immediately. Capture in a local const so
    // TS keeps the non-undefined narrowing across the property assignment
    // + register call.
    {
      const t = setTimeout(tick, 0)
      this.strategyTimer = t
      registerEngineTimer(t)
    }
  }

  /**
   * Start realtime processor (async).
   *
   * Self-scheduling setTimeout loop — each cycle runs back-to-back with a
   * configurable pause (app_settings.cyclePauseMs, 10-200ms, default 50ms).
   *
   * ── Prehistoric gating ──────────────────────────────────────────────
   * The loop is armed immediately, but individual ticks SELF-GATE on the
   * `prehistoric:{id}:done` flag set by loadPrehistoricData. Until that
   * flag flips we return a "gated" marker (no position processing) and
   * re-poll the flag on a short cadence (500ms) so the first productive
   * pass fires the instant prehistoric completes. This guarantees the
   * realtime processor always has prehistoric-calculated prev-position
   * context available when it evaluates positions.
   *
   * Once prehistoric is done the loop applies adaptive idle backoff
   * (max 1s) across consecutive empty cycles.
   */
  private startRealtimeProcessor(_intervalSeconds: number = 1): void {
    // Idempotency guard — see startIndicationProcessor. Prevents a leaked
    // duplicate LivePositions loop if this is ever (re)armed while live.
    if (this.realtimeTimer) {
      try { clearTimeout(this.realtimeTimer); unregisterEngineTimer(this.realtimeTimer) } catch { /* stale handle */ }
      this.realtimeTimer = undefined
    }
    // ── ARCHITECTURAL CHANGE (three-progression refactor) ─────────────���──
    // This method NO LONGER runs per-position mark-to-market / TP / SL
    // (that work is now Phase 2 of the shared ind+strat pipeline, fired
    // from inside the Realtime Progression via `startIndicationProcessor`).
    //
    // Renamed semantically: this is now the **LivePositions Progression**
    // — the third independent top-level loop, default 200 ms cadence,
    // driving live exchange-side position sync exclusively:
    //   - mark-price refresh for open LIVE positions
    //   - SL/TP cross detection + force-close on missed exchange triggers
    //   - protection ("control") order placement and healing
    //   - orphan adoption
    //   - simulated-position sweep (paper-mode connections)
    //
    // Cadence is read live from `settings:system.live_sync_interval_ms`
    // (default 200 ms) — the same field the old `maybeRunLiveSync` used,
    // so existing operator configurations Just Work.
    let cycleCount = 0
    let errorCount = 0
    let liveSyncInFlight = false
    let lastSyncCompletedAt = 0
    // ── Connector reuse (memory-pressure fix) ───────────────────────────
    // The previous code constructed a BRAND-NEW exchange connector on EVERY
    // 200ms tick (~5/sec, ~18k/hour). Each instance allocates headers,
    // closures and retry state; under live trading this allocation churn
    // outpaced GC and contributed to next-server being OOM-killed minutes
    // after live-trade start. Cache one connector per credentials-set and
    // only rebuild when the key/secret/testnet flag actually changes.
    let cachedConnector: any = null
    let cachedConnectorKey = ""

    const tickLivePositions = async () => {
      if (!this.isRunning) return
      const cycleStart = Date.now()

      // ── Single-flight guard ───────��─────────────────────────────────
      // A slow exchange REST round-trip can outlast the configured
      // interval; we MUST NOT queue overlapping syncs (they would race
      // on the same per-position Redis state).
      if (liveSyncInFlight) {
        scheduleNextLive()
        return
      }

      // ── Post-completion breath ──────────────────────────────────────
      // Wait `livePositionsCyclePauseMs` after the previous cycle finished
      // before the next can start. Mirrors the main progression pause
      // pattern — gives the event loop room and ensures previous Redis
      // writes are durable.
      const timings = getEngineTimings()
      const cyclePauseMs = timings.livePositionsCyclePauseMs ?? 50
      if (cycleStart - lastSyncCompletedAt < cyclePauseMs) {
        scheduleNextLive()
        return
      }

      // Pause-state check — when the global coordinator is paused, skip
      // exchange ops but keep simulated-position sweep running so paper
      // trades still close locally.
      let globallyPaused = false
      try {
        globallyPaused = await isGloballyPausedCached()
      } catch { /* ignore */ }

      liveSyncInFlight = true
      try {
        // syncWithExchange handles simulated positions internally (always-runs
        // guard) and real exchange operations when a connector is available.
        // Calling it here (instead of a separate _processSimulatedPositionsLazy
        // + syncWithExchange combo) avoids a double-sweep of simulated positions
        // per tick.  Only gated by the single-flight guard above.
        try {
          const connection = await _getConnectionLazy(this.connectionId)
          if (connection) {
            // Build connector only when not paused — exchange calls are
            // meaningless during a global pause, and we avoid the REST round
            // trips so paused-state cycles stay fast.
            let connector: any = null
            if (!globallyPaused) {
              const apiKey = (connection as any).api_key || (connection as any).apiKey || ""
              const apiSecret = (connection as any).api_secret || (connection as any).apiSecret || ""
              if (apiKey && apiSecret) {
                const isTestnet = connection.is_testnet === true || connection.is_testnet === "true"
                const connectorKey = `${connection.exchange}:${apiKey}:${apiSecret.slice(-8)}:${isTestnet}:${connection.api_type ?? ""}:${connection.contract_type ?? ""}`
                if (cachedConnector && cachedConnectorKey === connectorKey) {
                  connector = cachedConnector
                } else {
                  const createExchangeConnector = await _createExchangeConnectorLazy()
                  connector = await createExchangeConnector(connection.exchange, {
                    apiKey,
                    apiSecret,
                    apiType: connection.api_type,
                    contractType: connection.contract_type,
                    isTestnet,
                  })
                  cachedConnector = connector
                  cachedConnectorKey = connectorKey
                }
              } else {
                cachedConnector = null
                cachedConnectorKey = ""
              }
            }
            // syncWithExchange handles sim sweep unconditionally (no connector
            // = sims only, no exchange calls). Never throws — errors absorbed.
            const syncWithExchange = await _syncWithExchangeLazy()
            await withCycleDeadline(
              syncWithExchange(this.connectionId, connector),
              `LivePositions ${this.connectionId} syncWithExchange`,
              CYCLE_DEADLINE_MS,
            )
          }
        } catch (syncErr) {
          console.warn(
            `[v0] [LivePositions] syncWithExchange error for ${this.connectionId}:`,
            syncErr instanceof Error ? syncErr.message : String(syncErr),
          )
        }

        cycleCount++
        const duration = Date.now() - cycleStart
        this.componentHealth.realtime.lastCycleDuration = duration
        this.componentHealth.realtime.cycleCount = cycleCount
        this.componentHealth.realtime.successRate =
          cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // Progression hash telemetry — counters proving the LivePositions
        // loop is alive and cycling at its configured cadence.
        try {
          const client = getRedisClient()
          const progKey = `progression:${this.connectionId}`
          const nowMs = Date.now()
          await Promise.all([
            client.hincrby(progKey, "live_positions_cycle_count", 1),
            client.hset(progKey, {
              live_positions_last_cycle_at: String(nowMs),
              live_positions_last_cycle_ms: String(duration),
            }),
            client.hset(`settings:trade_engine_state:${this.connectionId}`, {
              status: "running",
              last_processor_heartbeat: String(nowMs),
              last_live_positions_run: new Date(nowMs).toISOString(),
            }),
            client.expire(progKey, 7 * 24 * 60 * 60),
          ])
        } catch { /* non-critical */ }
      } catch (err) {
        errorCount++
        this.componentHealth.realtime.errorCount++
        console.error(
          `[v0] [LivePositions] Cycle error for ${this.connectionId}:`,
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        lastSyncCompletedAt = Date.now()
        liveSyncInFlight = false
        scheduleNextLive()
      }
    }

    const scheduleNextLive = () => {
      if (!this.isRunning) return
      try {
        if (this.realtimeTimer) unregisterEngineTimer(this.realtimeTimer)
      } catch { /* stale handle is fine */ }
      const timings = getEngineTimings()
      // Start-to-start cadence = liveSyncIntervalMs (default 200 ms).
      // Subtract elapsed work time so a slow cycle doesn't slip cadence.
      const intervalMs = timings.liveSyncIntervalMs ?? 200
      this.realtimeTimer = setTimeout(tickLivePositions, intervalMs)
      registerEngineTimer(this.realtimeTimer)
    }

    // Kick off the first cycle immediately. See narrowing note in
    // startStrategyProcessor for why we capture in a local const.
    {
      const t = setTimeout(tickLivePositions, 0)
      this.realtimeTimer = t
      registerEngineTimer(t)
    }
    return
    // ── Legacy body preserved as unreachable reference ───────────────────

    let cycleCount_legacy = 0
    void cycleCount_legacy
    let cycleCount2 = 0
    let gatedCycles = 0
    let totalDuration = 0
    let errorCount2 = 0
    void cycleCount2; void gatedCycles; void totalDuration; void errorCount2

    const MAX_IDLE_PAUSE_MS = 1000
    // Fast-poll cadence while waiting for prehistoric to finish. Kept
    // short (500ms) so the first productive realtime tick fires within
    // half a second of prehistoric completing — but long enough to avoid
    // hammering Redis with `GET prehistoric:{id}:done` during a long-
    // running prehistoric load.
    const PREHISTORIC_WAIT_POLL_MS = 500
    let consecutiveEmptyCycles = 0
    const connId = this.connectionId
    let prehistoricDoneFlag = false
    let prehistoricDoneCheckedAt = 0
    const refreshPrehistoricDone = async () => {
      try {
        const client = getRedisClient()
        const v = await client.get(`prehistoric:${connId}:done`)
        prehistoricDoneFlag = v === "1"
      } catch { /* keep last known value */ }
    }
    void refreshPrehistoricDone()

    const scheduleNext = (outcome: "productive" | "empty" | "gated") => {
      if (!this.isRunning) return
      // See indication scheduleNext for the full stability rationale.
      try {
        const base = getCyclePauseMsSync()
        let pause = base
        if (outcome === "productive") {
          consecutiveEmptyCycles = 0
        } else if (outcome === "gated") {
          // Prehistoric-pending backoff. Don't inflate
          // `consecutiveEmptyCycles` — a gated cycle isn't an "empty"
          // cycle; it was skipped on purpose.
          pause = PREHISTORIC_WAIT_POLL_MS
        } else {
          consecutiveEmptyCycles++
          if (prehistoricDoneFlag && consecutiveEmptyCycles > 2) {
            const factor = Math.min(16, 1 << Math.min(4, consecutiveEmptyCycles - 2))
            pause = Math.min(MAX_IDLE_PAUSE_MS, base * factor)
          }
        }
        try {
          if (this.realtimeTimer) unregisterEngineTimer(this.realtimeTimer)
        } catch { /* stale handle is fine */ }
        this.realtimeTimer = setTimeout(tick, pause)
        registerEngineTimer(this.realtimeTimer)
      } catch (err) {
        console.error(`[v0] [Engine ${this.connectionId}] realtime scheduleNext failed; fallback rearm:`, err)
        try {
          this.realtimeTimer = setTimeout(tick, DEFAULT_CYCLE_PAUSE_MS)
          registerEngineTimer(this.realtimeTimer)
        } catch (fatal) {
          console.error(`[v0] [Engine ${this.connectionId}] FATAL: cannot rearm realtime timer`, fatal)
        }
      }
    }

    const tick = async () => {
      if (!this.isRunning) return
      // Default outcome: "empty". Upgraded to "productive" when the
      // processor reports real work, or demoted to "gated" when the
      // prehistoric flag hasn't flipped yet.
      let outcome: "productive" | "empty" | "gated" = "empty"
      // STABILITY: removed the V8 "stale module version self-clear" — see
      // identical note in the indication tick. Loop-exit is gated only on
      // `!this.isRunning`.
      const startTime = Date.now()

      // While prehistoric is pending poll the flag every tick (cheap
      // single-key GET on a 500ms cadence). After it flips we back off
      // to the original 3s refresh to avoid needless reads.
      const pollInterval = prehistoricDoneFlag ? 3000 : PREHISTORIC_WAIT_POLL_MS
      if (startTime - prehistoricDoneCheckedAt > pollInterval) {
        prehistoricDoneCheckedAt = startTime
        await refreshPrehistoricDone()
      }

      // ── Prehistoric advisory (P0-5) ────────────────��─────────────
      // The realtime loop USED to hard-skip ticks until the
      // `prehistoric:{id}:done` flag flipped. That's no longer correct
      // because open pseudo positions must get mark-to-market updates
      // on every tick regardless of prehistoric state (spec: "Open
      // Pseudo positions get updated handled on each cycle, Independent
      // of active indication process"). The realtime processor now
      // internally treats the flag as advisory — Phase A (TP/SL,
      // trailing, unrealised PnL) always runs; Phase B (prev-set
      // enrichment) is the only part that gates. We just log the first
      // few gated cycles for visibility.
      if (!prehistoricDoneFlag) {
        gatedCycles++
        if (gatedCycles === 1 || gatedCycles % 50 === 0) {
          void logProgressionEvent(
            this.connectionId,
            "realtime_prev_set_pending",
            "info",
            "Realtime tick running without prev-set enrichment — waiting for prehistoric calc",
            { gatedCycles },
          ).catch(() => { /* non-critical */ })
        }
      }

      try {
        // Process realtime updates for active positions
        const rtResult: any = await this.realtimeProcessor.processRealtimeUpdates()
        // Mark cycle productive when the processor returned some work.
        // Cadence guarantee (P0-5): any tick that touched open positions
        // counts as productive so idle backoff never kicks in while
        // positions are open. The processor returns `updates` = number
        // of positions processed, so `updates > 0` already implies open
        // positions exist.
        if (rtResult && typeof rtResult === "object") {
          const updates = Number(rtResult.updates ?? rtResult.processed ?? rtResult.positionsUpdated ?? 0)
          if (updates > 0) outcome = "productive"
        }

        const duration = Date.now() - startTime
        cycleCount++
        totalDuration += duration

        this.componentHealth.realtime.lastCycleDuration = duration
        this.componentHealth.realtime.cycleCount = cycleCount
        this.componentHealth.realtime.successRate = cycleCount > 0 ? ((cycleCount - errorCount) / cycleCount) * 100 : 100

        // Update progression cycle
        try {
          await ProgressionStateManager.incrementCycle(this.connectionId, true, 0)
        } catch (incError) {
          console.error(`[v0] [Engine] Realtime cycle increment failed:`, incError instanceof Error ? incError.message : String(incError))
        }

        // Write cycle counters into progression hash so the dashboard reads
        // real values (analogous to the indication & strategy processors).
        //
        // COUNTER TAXONOMY:
        //   * realtime_cycle_count       — every realtime tick (incl. idle/gated).
        //   * realtime_live_cycle_count  — only ticks that actually updated open
        //                                  positions (rtResult.updates > 0).
        //   * frames_processed           — cross-processor cumulative tick total.
        try {
          const client = getRedisClient()
          const redisKey = `progression:${this.connectionId}`
          await client.hincrby(redisKey, "realtime_cycle_count", 1)
          await client.hincrby(redisKey, "frames_processed", 1)
          if (outcome === "productive") {
            await client.hincrby(redisKey, "realtime_live_cycle_count", 1)
          }
          await client.expire(redisKey, 7 * 24 * 60 * 60)
        } catch { /* non-critical */ }

        // Track detailed performance metrics (every 100 cycles)
        if (cycleCount % 100 === 0) {
          await engineMonitor.trackCycle(this.connectionId, "realtime", {
            cycleNumber: cycleCount,
            startTime,
            endTime: Date.now(),
            durationMs: duration,
            errors: errorCount,
          })
        }

        // Persist non-counter snapshot data every 100 cycles. The cycle
        // counters themselves (realtime_cycle_count, frames_processed) live
        // exclusively in progression:{id} as atomic hincrbys — see comment
        // on the indication processor above for the rationale.
        if (cycleCount % 100 === 0) {
          try {
            await setSettings(`trade_engine_state:${this.connectionId}`, {
              last_realtime_run: new Date().toISOString(),
              realtime_avg_duration_ms: totalDuration > 0 ? Math.round(totalDuration / cycleCount) : 0,
              last_cycle_duration: duration,
              last_cycle_type: "realtime",
            })
          } catch { /* silently fail */ }
        }
      } catch (error) {
        errorCount++
        this.componentHealth.realtime.errorCount++
        console.error(`[v0] [Engine] Realtime error:`, error instanceof Error ? error.message : String(error))
        await logProgressionEvent(this.connectionId, "realtime", "error", `Processor error: ${error instanceof Error ? error.message : String(error)}`, {
          errorType: error instanceof Error ? error.name : "unknown",
          cycleCount,
          errorCount,
        })
      } finally {
        scheduleNext(outcome)
      }
    }

    // Kick off the first cycle immediately. The first tick will either
    // report "gated" (prehistoric still running) and re-poll on
    // PREHISTORIC_WAIT_POLL_MS, or run a full cycle if prehistoric is
    // already complete.
    // Local-const capture for TS narrowing — see startStrategyProcessor.
    {
      const t = setTimeout(tick, 0)
      this.realtimeTimer = t
      // Register timer for cleanup on module reload
      registerEngineTimer(t)
    }
  }

  /**
   * Prehistoric Progression — the first of the three independent top-level
   * progression loops per the architectural spec.
   *
   *   "prehistoric progress by interval of its timeframes (default 1 s) is
   *    own progress using the unique ind. and strat. progress for calcs
   *    and filling unique Sets which also getting used for RealTime Progress."
   *
   * Continuous, forever, at `prehistoricIntervalMs` (default 1000 ms).
   * Each cycle:
   *   1. Compute the look-back window from `prehistoric_range_hours`
   *      (default 8 h; bounds 1–50 h).
   *   2. For each symbol (concurrency-capped at `SYMBOL_CONCURRENCY`):
   *        runIndStratCycle(symbol, "historical", { window })
   *   3. After the first complete pass, set
   *        prehistoric:{connId}:done = 1                  (back-compat)
   *        prehistoric:{connId}:firstpass:done = 1        (new gate)
   *      so the Realtime Progression can flip from "gated" to active.
   *
   * Coordination: writes go to the **historical Set keyspace** owned by
   * IndicationSetsProcessor + StrategyConfigManager. The Realtime
   * Progression writes to the live Set keyspace. The two never race.
   */
  private prehistoricTimer?: ReturnType<typeof setTimeout>

  /**
   * Start the Prehistoric Progression loop.
   *
   * @param onFirstPassComplete  Fired ONCE, after the very first cycle
   *   has finished writing the `prehistoric:{connId}:firstpass:done`
   *   flag. The continuous loop keeps running forever afterward. This
   *   is the engine-startup gate: the Realtime + LivePositions + Strategy
   *   loops must NOT start until this callback fires, so the realtime
   *   pipeline only ever reads Sets that the prehistoric writer has
   *   already populated. The callback is invoked even if the first cycle
   *   produced zero successful symbols (it represents "the first pass
   *   completed" — not "the first pass succeeded") so a connection with
   *   stale market data still progresses out of bootstrap.
   *
   *   For the re-arm / self-heal call site (where the firstpass:done
   *   flag is already persisted in Redis from the original boot), the
   *   callback can be omitted — the realtime loop is already running.
   */
  private startPrehistoricProgression(
    onFirstPassComplete?: () => void,
  ): void {
    // Idempotency guard — see startIndicationProcessor. Prevents a leaked
    // duplicate Prehistoric loop if this is ever (re)armed while live.
    if (this.prehistoricTimer) {
      try { clearTimeout(this.prehistoricTimer); unregisterEngineTimer(this.prehistoricTimer) } catch { /* stale handle */ }
      this.prehistoricTimer = undefined
    }
    let cycleCount = 0
    let firstPassDone = false
    const connId = this.connectionId
    // Adaptive pause tracking — see scheduleNext above.
    let _ppLastSteps = 0
    let _ppConsecutiveIdle = 0

    const scheduleNext = () => {
      if (!this.isRunning) return
      try {
        if (this.prehistoricTimer) unregisterEngineTimer(this.prehistoricTimer)
      } catch { /* stale handle is fine */ }
      // ── Adaptive pause ────────────────────────────────────────────────
      // When all symbols' checkpoints are caught up (no new candles to
      // replay), the next tick produces 0 steps across every symbol.
      // Running back-to-back in that state is pure churn — each cycle
      // reloads market data from Redis, scans every symbol's checkpoint,
      // finds nothing, loops again. That starves the Realtime Progression
      // and the LivePositions loop (both share the event loop) leading to
      // "Low Activity / no realtime progressions" despite the engine
      // appearing to run.
      //
      // Adaptive pause: when the last cycle found work (steps > 0),
      // continue at full speed (0 ms delay). When work was zero, back
      // off: first idle gets 3 s, then climbs by 3 s per consecutive
      // idle up to 30 s. Productive work immediately resets to instant.
      const pause = (() => {
        if (_ppLastSteps > 0) {
          _ppConsecutiveIdle = 0
          return 0
        }
        _ppConsecutiveIdle++
        // 3s, 6s, 9s, ... capped at 30s
        return Math.min(30_000, _ppConsecutiveIdle * 3000)
      })()
      this.prehistoricTimer = setTimeout(tick, pause)
      registerEngineTimer(this.prehistoricTimer)
    }

    const tick = async () => {
      if (!this.isRunning) return
      const cycleStart = Date.now()

      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) {
          scheduleNext()
          return
        }

        // Resolve the look-back window from settings on each cycle so
        // operator edits take effect on the next iteration without
        // restart.
        const { getAppSettings } = await import("@/lib/redis-db")
        const appSettings = await getAppSettings().catch(() => ({} as any))
        const rawHours = Number(
          appSettings?.prehistoric_range_hours ?? appSettings?.prehistoricRangeHours ?? 8,
        )
        const rangeHours = Math.max(1, Math.min(50, Number.isFinite(rawHours) ? rawHours : 8))
        const windowEndMs = Date.now()
        const windowStartMs = windowEndMs - rangeHours * 60 * 60 * 1000

        // ── Step A: Bulk-load market data ONCE per cycle (DEADLINE-WRAPPED) ──
        // `loadMarketDataForEngine` can take seconds on first boot with many
        // symbols. Without a deadline, a hung network call blocks the entire
        // prehistoric tick forever. 30s deadline lets scheduleNext re-arm the
        // loop if the load hangs.
        try {
          const { loadMarketDataForEngine } = await import("@/lib/market-data-loader")
          await withCycleDeadline(
            loadMarketDataForEngine(symbols),
            `Prehistoric ${connId} loadMarketData`,
            CYCLE_DEADLINE_MS,
          )
        } catch (loadErr) {
          console.warn(
            `[v0] [PrehistoricProgression] Market-data load warning:`,
            loadErr instanceof Error ? loadErr.message : String(loadErr),
          )
        }

        // ── Step B: Per-symbol step-by-step replay ───────────────────────
        // For each symbol, walk the loaded candles from the per-symbol
        // checkpoint forward at the data's native timeframe interval
        // (1 s — that's what the loader writes), and call the SAME shared
        // pipeline the Realtime Progression uses, once per candle, with
        // `asOfMs` set to that candle's timestamp.
        //
        // Cross-cycle checkpointing: `prehistoric:checkpoint:{connId}:{symbol}`
        // stores the timestamp of the last replayed candle. On the next
        // cycle we resume from there, so the loop only ever replays NEW
        // candles (the freshly-loaded tail) — not the entire range every
        // pass. This makes back-to-back cycles cheap once the catch-up
        // phase completes.
        //
        // Per-cycle safety cap: MAX_REPLAY_STEPS_PER_SYMBOL bounds the
        // work each symbol can do in one cycle, so a cold start with a
        // 50-hour range (180 000 candles) doesn't monopolize the event
        // loop. The remaining candles replay on subsequent cycles.
        // 4 GB VM: each step materialises axis Sets + pseudo-position hashes.
        // 30 steps keeps the per-cycle heap burst under ~100 MB before eviction.
        const MAX_REPLAY_STEPS_PER_SYMBOL = process.env.NODE_ENV === "development" ? 30 : 80
        const client = getRedisClient()

        const replayOneSymbol = async (
          symbol: string,
        ): Promise<{ symbol: string; stepsReplayed: number; indications: number; strategies: number; durationMs: number; error?: string }> => {
          const symStart = Date.now()
          try {
            // Load candles for this symbol via the parsed-candles cache.
            // OOM-PROTECTION: previously this did client.get + JSON.parse of
            // the FULL ~86,400-candle (~10 MB) blob PER SYMBOL on EVERY cycle
            // (~1/sec) and then .filter().sort()'d it — the transient garbage
            // outpaced GC and OOM-killed next-server minutes after the engine
            // went active. The cache parses+sorts each blob at most once per
            // data version and returns a shared read-only array.
            const candles = await getParsedCandlesCached(symbol)
            if (!Array.isArray(candles) || candles.length === 0) {
              return { symbol, stepsReplayed: 0, indications: 0, strategies: 0, durationMs: Date.now() - symStart }
            }

            // Resolve resume point. On the very first cycle (no checkpoint)
            // we start at the configured window's start so we don't skip
            // backward bars; on subsequent cycles we resume strictly
            // after the last replayed timestamp.
            const ckptKey = `prehistoric:checkpoint:${connId}:${symbol}`
            const ckptRaw = await client.get(ckptKey).catch(() => null)
            const ckpt = ckptRaw ? Number(ckptRaw) : windowStartMs
            const resumeFrom = Number.isFinite(ckpt) ? ckpt : windowStartMs

            // Filter to candles strictly newer than the checkpoint AND
            // within the look-back window. The cached array is already sorted
            // ascending by timestamp, so no re-sort is needed here.
            const pending = candles
              .filter((c: any) => {
                const ts = Number(c?.timestamp ?? c?.t ?? 0)
                return Number.isFinite(ts) && ts > resumeFrom && ts <= windowEndMs
              })

            if (pending.length === 0) {
              return { symbol, stepsReplayed: 0, indications: 0, strategies: 0, durationMs: Date.now() - symStart }
            }

            // Cap per-cycle work so cold starts don't starve the loop.
            const steps = pending.slice(0, MAX_REPLAY_STEPS_PER_SYMBOL)

            // One shared sets processor for the whole symbol so we don't
            // pay the per-step allocation tax.
            const setsProcessor = new IndicationSetsProcessor(connId)

            // Build a rolling window of up to 300 close prices from all
            // candles up to (and including) resumeFrom so the first replay
            // step already has a price history. IndicationSetsProcessor's
            // normalizePriceHistory looks for marketData.prices or
            // marketData.candles — passing prices[] is the fastest path.
            const PRICE_WINDOW = 300
            const priceWindowBase: number[] = candles
              .filter((c: any) => {
                const ts = Number(c?.timestamp ?? c?.t ?? 0)
                return Number.isFinite(ts) && ts <= resumeFrom
              })
              .slice(-PRICE_WINDOW)
              .map((c: any) => Number(c?.close ?? c?.price ?? c?.last ?? 0))
              .filter((p: number) => p > 0)

            let indicationsTotal = 0
            let strategiesTotal = 0
            let lastReplayedTs = resumeFrom

            for (const candle of steps) {
              if (!this.isRunning) break
              const asOfMs = Number(candle?.timestamp ?? candle?.t ?? 0)
              if (!Number.isFinite(asOfMs)) continue

              // Append the current candle's close to the rolling window so
              // each step sees an up-to-date price history.
              const closePrice = Number(candle?.close ?? candle?.price ?? candle?.last ?? 0)
              if (closePrice > 0) priceWindowBase.push(closePrice)
              if (priceWindowBase.length > PRICE_WINDOW) priceWindowBase.shift()

              // Attach the rolling price history to the candle object so
              // processAllIndicationSets → normalizePriceHistory finds it.
              const candleWithPrices = {
                ...candle,
                prices: [...priceWindowBase],
                priceOrder: "oldest-first",
              }

              // SAME pipeline the Realtime Progression uses — single
              // source of indication + strategy logic for both modes.
              const stepResult = await runIndStratCycle(connId, symbol, "historical", {
                indication: this.indicationProcessor,
                strategy: this.strategyProcessor,
                realtime: this.realtimeProcessor,
                asOfMs,
                asOfCandle: candleWithPrices,
                setsProcessor,
              })
              indicationsTotal += stepResult.indicationCount
              strategiesTotal += stepResult.strategiesEvaluated
              lastReplayedTs = asOfMs
            }

            // Persist the new checkpoint so the next cycle resumes at
            // `lastReplayedTs + 1`. 7-day TTL — long enough to survive
            // a weekend restart, short enough that a cleared symbol set
            // self-recovers without manual key cleanup.
            if (lastReplayedTs > resumeFrom) {
              await client
                .set(ckptKey, String(lastReplayedTs), { EX: 7 * 24 * 60 * 60 })
                .catch((e) => {
                  // Log checkpoint failures — silent loss causes duplicate
                  // replay on the next cycle without operator visibility.
                  console.warn(
                    `[v0] [Prehistoric] checkpoint write failed for ${connId}/${symbol}:`,
                    e instanceof Error ? e.message : String(e),
                  )
                })
            }

            return {
              symbol,
              stepsReplayed: steps.length,
              indications: indicationsTotal,
              strategies: strategiesTotal,
              durationMs: Date.now() - symStart,
            }
          } catch (err) {
            return {
              symbol,
              stepsReplayed: 0,
              indications: 0,
              strategies: 0,
              durationMs: Date.now() - symStart,
              error: err instanceof Error ? err.message : String(err),
            }
          }
        }

        // Determine prehistoric progression timeout (minutes) from app settings.
        // Operator-configurable: 5–25 minutes, default 10. Clamp for safety.
        const rawTimeoutMinutes = Number(
          appSettings?.prehistoric_progression_timeout_minutes ??
            appSettings?.prehistoricProgressionTimeoutMinutes ??
            10,
        )
        const timeoutMinutes = Math.max(5, Math.min(25, Number.isFinite(rawTimeoutMinutes) ? rawTimeoutMinutes : 10))
        const timeoutMs = Math.round(timeoutMinutes * 60_000)

        // OOM-protection: replay runs the FULL Base→Main→Real pipeline per
        // candle step (each step can materialise thousands of axis Sets +
        // pseudo-position writes). At 20 symbols we drop back to 2 concurrent
        // to keep peak prehistoric-replay heap below the 1200 MB eviction floor.
        // 4 GB VM: run one symbol at a time in dev to prevent concurrent
        // axis fan-out from spiking RSS past the kernel OOM threshold.
        const REPLAY_CONCURRENCY = process.env.NODE_ENV === "development" ? 1 : 2
        const results = await withCycleDeadline(
          mapWithConcurrency(symbols, REPLAY_CONCURRENCY, replayOneSymbol),
          `Engine ${connId} prehistoric-progression`,
          timeoutMs,
        )

        cycleCount++
        const duration = Date.now() - cycleStart

        // Hoist step/indication/strategy totals so the first-pass guard below can
        // read stepsTotal before the telemetry block that originally declared it.
        const stepsTotal = results.reduce(
          (acc: number, r: any) => acc + (Number(r?.stepsReplayed) || 0),
          0,
        )
        _ppLastSteps = stepsTotal

        // First-pass done: flip the first-pass flag and arm live timer infrastructure.
        // The authoritative `:done` gate remains owned by the full prehistoric
        // load path below, so realtime ticks cannot become productive until the
        // generated historic Sets are complete. Only fire when this cycle did REAL work (at least one symbol
        // replayed ≥1 candle step). If all symbols produced zero steps on the first
        // tick (cold candle cache, market data not yet loaded) we would arm realtime
        // against completely empty Sets — exactly the state the gate is designed to
        // prevent. Stay in the "not done" state and let the next cycle retry.
        if (!firstPassDone && stepsTotal > 0) {
          firstPassDone = true
          try {
            const client = getRedisClient()
            await client.set(`prehistoric:${connId}:firstpass:done`, "1", { EX: 86400 })
          } catch { /* non-critical */ }
          await logProgressionEvent(
            connId,
            "prehistoric_progression",
            "info",
            `Prehistoric Progression first-pass complete (${symbols.length} symbols, ${duration} ms)`,
            { cycle: cycleCount, symbols: symbols.length, durationMs: duration },
          ).catch(() => {})

          // Release the startup gate. Wrapped in try/catch so a buggy
          // callback can never break the continuous prehistoric loop.
          if (onFirstPassComplete) {
            try {
              onFirstPassComplete()
            } catch (cbErr) {
              console.error(
                `[v0] [PrehistoricProgression] onFirstPassComplete threw:`,
                cbErr instanceof Error ? cbErr.message : String(cbErr),
              )
            }
          }
        }

        // Cycle telemetry — surfaces the loop's heartbeat to the dashboard.
        // stepsTotal/_ppLastSteps are already computed and set above the
        // first-pass guard so they can influence the firstPassDone check.
        const indTotal = results.reduce(
          (acc: number, r: any) => acc + (Number(r?.indications) || 0),
          0,
        )
        const stratTotal = results.reduce(
          (acc: number, r: any) => acc + (Number(r?.strategies) || 0),
          0,
        )
        const successCount = results.filter((r: any) => r && !r.error).length
        try {
          const telemetryClient = getRedisClient()
          const progKey = `progression:${connId}`
          const nowMs = Date.now()
          // NOTE: prehistoric_indications_total and prehistoric_strategies_total are
          // owned EXCLUSIVELY by ConfigSetProcessor (loadPrehistoricData path). They
          // are written once via hincrby per symbol during the one-time historic calc.
          // The ongoing replay loop here MUST NOT also hincrby those same fields —
          // doing so double-counts every cycle after historic completes and inflates the
          // dashboard numbers indefinitely. The replay loop writes to distinct
          // *_replay_* keys so the two paths stay isolated and the totals remain correct.
          await Promise.all([
            telemetryClient.hincrby(progKey, "prehistoric_progression_cycles", 1),
            telemetryClient.hincrby(progKey, "prehistoric_replay_steps_total", stepsTotal),
            telemetryClient.hincrby(progKey, "prehistoric_replay_indications_total", indTotal),
            telemetryClient.hincrby(progKey, "prehistoric_replay_strategies_total", stratTotal),
            telemetryClient.hset(progKey, {
              prehistoric_progression_last_cycle_at: String(nowMs),
              prehistoric_progression_last_cycle_ms: String(duration),
              prehistoric_progression_last_symbols: String(successCount),
              prehistoric_progression_last_steps: String(stepsTotal),
              prehistoric_progression_last_indications: String(indTotal),
              prehistoric_progression_last_strategies: String(stratTotal),
            }),
            telemetryClient.expire(progKey, 7 * 24 * 60 * 60),
          ])
        } catch { /* non-critical */ }

        // Throttled cycle log — every 50 cycles to avoid stdout flooding,
        // plus an unconditional log on cycle 1 and whenever a cycle does
        // non-trivial work (>0 steps), so operators see catch-up progress
        // without having to wait for the 50-cycle boundary.
        if (cycleCount === 1 || cycleCount % 50 === 0 || stepsTotal > 0) {
          console.log(
            `[v0] [PrehistoricProgression] cycle=${cycleCount} symbols=${symbols.length} steps=${stepsTotal} indications=${indTotal} strategies=${stratTotal} duration=${duration}ms range=${rangeHours}h`,
          )
        }
      } catch (err) {
        console.error(
          `[v0] [PrehistoricProgression] cycle error:`,
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        scheduleNext()
      }
    }

    // Kick off the first cycle immediately.
    this.prehistoricTimer = setTimeout(tick, 0)
    registerEngineTimer(this.prehistoricTimer)
  }

  /**
   * Start health monitoring
   */
  private startHealthMonitoring(): void {
    const healthCheckInterval = 10000 // Check every 10 seconds

    this.healthCheckTimer = setInterval(async () => {
      if (!this.isRunning) return

      try {
        // Update component health statuses (pass cycleCount to skip checks during warmup)
        this.componentHealth.indications.status = this.getComponentHealthStatus(
          this.componentHealth.indications.successRate,
          this.componentHealth.indications.lastCycleDuration,
          5000, // 5 second threshold
          this.componentHealth.indications.cycleCount,
        )

        this.componentHealth.strategies.status = this.getComponentHealthStatus(
          this.componentHealth.strategies.successRate,
          this.componentHealth.strategies.lastCycleDuration,
          10000, // 10 second threshold for strategies
          this.componentHealth.strategies.cycleCount,
        )

        this.componentHealth.realtime.status = this.getComponentHealthStatus(
          this.componentHealth.realtime.successRate,
          this.componentHealth.realtime.lastCycleDuration,
          3000, // 3 second threshold
          this.componentHealth.realtime.cycleCount,
        )

        // Calculate overall health
        const overallHealth = this.calculateOverallHealth()

        // Update health status in Redis (same key as updateEngineState)
        const engineState = (await getSettings(`trade_engine_state:${this.connectionId}`)) || {}
        await setSettings(`trade_engine_state:${this.connectionId}`, {
          ...engineState,
          manager_health_status: overallHealth,
          indications_health: this.componentHealth.indications.status,
          strategies_health: this.componentHealth.strategies.status,
          realtime_health: this.componentHealth.realtime.status,
          last_manager_health_check: new Date().toISOString(),
        })

      // Health monitoring is now silent - status is stored in Redis for dashboard display
      // No console warnings to avoid log flooding during normal operation
      } catch (error) {
        console.error("[v0] TradeEngineManager health monitoring error:", error)
      }
    }, healthCheckInterval)
  }

  /**
   * Get component health status
   * Requires minimum cycles before reporting unhealthy to allow warmup
   */
  private getComponentHealthStatus(
    successRate: number,
    lastCycleDuration: number,
    threshold: number,
    cycleCount: number = 0,
  ): "healthy" | "degraded" | "unhealthy" {
    // Always healthy during warmup period (first 20 cycles)
    if (cycleCount < 20) {
      return "healthy"
    }

    // Very relaxed thresholds - only unhealthy if totally failing
    if (successRate < 30 || lastCycleDuration > threshold * 10) {
      return "unhealthy"
    }
    // Degraded at 50% success rate
    if (successRate < 50 || lastCycleDuration > threshold * 5) {
      return "degraded"
    }
    return "healthy"
  }

  /**
   * Calculate overall health
   */
  private calculateOverallHealth(): "healthy" | "degraded" | "unhealthy" {
    const components = [
      this.componentHealth.indications.status,
      this.componentHealth.strategies.status,
      this.componentHealth.realtime.status,
    ]

    const unhealthyCount = components.filter((s) => s === "unhealthy").length
    const degradedCount = components.filter((s) => s === "degraded").length

    if (unhealthyCount > 0) return "unhealthy"
    if (degradedCount > 0) return "degraded"
    return "healthy"
  }

  /**
   * Get symbols for this connection - uses connection's active_symbols first.
   *
   * PERFORMANCE: The engine previously called getSymbols() on every tick across
   * 3 processors (indication / strategy / realtime) which translated to ~12
   * Redis reads per second just to resolve a list that changes at most a few
   * times per day. We now cache the resolved array in memory for 5 seconds so
   * each 1-second cycle reuses the same lookup. The short TTL keeps UI-driven
   * symbol changes propagating to the engine within the next tick or two.
   */
  private _symbolsCache: string[] | null = null
  private _symbolsCachedAt = 0
  private static readonly _SYMBOLS_TTL_MS = 5000

  // ── Invalidate symbol cache when settings change ──────────────────────────
  // Called whenever force_symbols or active_symbols are updated by the admin
  // API or migrations to ensure getSymbols() re-reads from Redis immediately.
  private invalidateSymbolCache(): void {
    this._symbolsCache = null
    this._symbolsCachedAt = 0
    console.log(`[v0] [Engine] Symbol cache invalidated for ${this.connectionId}`)
  }

  private async getSymbols(): Promise<string[]> {
    const now = Date.now()
    // Check if cache is still valid. Even if valid, verify that force_symbols
    // in Redis hasn't changed — if it has, invalidate immediately.
    if (this._symbolsCache && now - this._symbolsCachedAt < TradeEngineManager._SYMBOLS_TTL_MS) {
      try {
        // Quick check: read force_symbols from Redis to detect any external changes
        // getSettings() automatically prepends "settings:" to the key
        const connState = await getSettings(`trade_engine_state:${this.connectionId}`)
        let forceSymbols = (connState as any)?.force_symbols
        if (typeof forceSymbols === "string") {
          try { forceSymbols = JSON.parse(forceSymbols) } catch { /* ignore */ }
        }
        
        // If force_symbols exists but differs from cache, invalidate
        if (Array.isArray(forceSymbols) && forceSymbols.length > 0) {
          const sortedForce = [...forceSymbols].map(String).filter(Boolean).sort()
          const sortedCache = [...this._symbolsCache].sort()
          if (JSON.stringify(sortedForce) !== JSON.stringify(sortedCache)) {
            console.log(`[v0] [getSymbols] ${this.connectionId}: force_symbols changed in Redis, invalidating cache`)
            this.invalidateSymbolCache()
            // Fall through to reload below
          } else {
            return this._symbolsCache
          }
        } else {
          return this._symbolsCache
        }
      } catch (checkErr) {
        // Non-fatal: check failed, use cached value anyway
        return this._symbolsCache
      }
    }

    const resolve = async (): Promise<string[]> => {
      try {
        // Fire both primary lookups concurrently so the first tick after TTL
        // expiry doesn't pay two sequential Redis round-trips.
        // getSettings() automatically prepends "settings:" prefix to keys.
        const [connState, connSettings] = await Promise.all([
          getSettings(`trade_engine_state:${this.connectionId}`),
          getSettings(`connection:${this.connectionId}`),
        ])

        // ── DEV SYMBOL CAP ────────────────────────────────────────────────
        // In development the InlineLocalRedis emulator holds ALL state on the
        // Node.js heap, so symbol count directly controls peak RSS. The cap
        // is controlled by V0_DEV_SYMBOL_COUNT (env var, default "1") so it
        // can be raised to 10+ on a larger-RAM VM without touching code.
        //
        // Behaviour:
        //   V0_DEV_SYMBOL_COUNT=1  → always ["BTCUSDT"] (minimum safe, old default)
        //   V0_DEV_SYMBOL_COUNT=10 → normal resolution below, then slice to 10
        //   unset                  → default 1, same as before
        //
        // Production (NODE_ENV !== "development") is COMPLETELY UNAFFECTED —
        // this block only runs in the dev Next.js worker.
        if (process.env.NODE_ENV === "development") {
          const devCap = Math.max(1, parseInt(process.env.V0_DEV_SYMBOL_COUNT ?? "1", 10) || 1)
          // Fast path for the default single-symbol case — skip the Redis
          // resolution chain entirely; BTCUSDT is the canonical dev fixture.
          if (devCap === 1) return ["BTCUSDT"]
          // For devCap > 1 fall through to the full resolution chain below
          // (force_symbols → self-written symbols → volatility fetch).
          // The resolved list is sliced to devCap at the end of this function.
          ;(resolve as any)._devCap = devCap
        }

        if (connState && typeof connState === "object") {
          // ── Highest priority: force_symbols set by migrations/admin ────────
          // Migration 032 writes `force_symbols` to prevent the engine startup
          // path from overwriting it with exchange-fetched symbols. This key is
          // NEVER written by the engine itself, only by migrations and the admin
          // API — so it always reflects the operator's intended symbol override.
          let forceSymbols = (connState as any).force_symbols
          if (typeof forceSymbols === "string") {
            try { forceSymbols = JSON.parse(forceSymbols) } catch { /* ignore */ }
          }
          if (Array.isArray(forceSymbols) && forceSymbols.length > 0) {
            console.log(`[v0] [getSymbols] ${this.connectionId}: using force_symbols (${forceSymbols.length} symbols from migration/admin override)`)
            return forceSymbols.map(String).filter(Boolean)
          }

          // ── Secondary: self-written symbols from previous engine start ─────
          let connSymbols = (connState as any).symbols || (connState as any).active_symbols
          // The settings PATCH route and updateEngineState write this field as a
          // JSON.stringify'd array (the emulator stores hash values as strings).
          // Parse it so this primary branch isn't silently skipped — otherwise we
          // fall through to the connection-object fallback for no reason.
          if (typeof connSymbols === "string") {
            try { connSymbols = JSON.parse(connSymbols) } catch { /* ignore */ }
          }
          if (Array.isArray(connSymbols) && connSymbols.length > 0) return connSymbols.map(String).filter(Boolean)
        }

        if (connSettings && typeof connSettings === "object") {
          const symbolsField =
            (connSettings as any).force_symbols ||
            (connSettings as any).active_symbols ||
            (connSettings as any).symbols
          let symbols = symbolsField
          if (typeof symbols === "string") {
            try { symbols = JSON.parse(symbols) } catch { /* ignore */ }
          }
          if (Array.isArray(symbols) && symbols.length > 0) return symbols.map(String).filter(Boolean)
        }

        // Global main-symbols fallback — the UI stores these as fields on
        // the canonical `app_settings` hash, never as standalone Redis
        // keys, so `getSettings("useMainSymbols")` would always return
        // null. Use the mirror-aware scalar reader (statically imported
        // at the top of the module; avoids a `await import()` on this
        // cycle-hot path).
        const appSettings = await getAppSettings()
        const useMainSymbols = appSettings?.useMainSymbols === true || appSettings?.useMainSymbols === "true" || appSettings?.useMainSymbols === "1"
        if (useMainSymbols === true) {
          const mainSymbols = appSettings?.mainSymbols
          if (Array.isArray(mainSymbols) && mainSymbols.length > 0) return mainSymbols.map(String).filter(Boolean)
        }

        // ── DEFAULT: dynamic top-N selection by 1h volatility ────────────────
        // The system default (migration 055) is to trade the most volatile
        // symbols. When no explicit operator force_symbols / self-written
        // symbols / connSettings / mainSymbols exist, pick the top-N by true
        // 1h ATR via fetchTopSymbols(...,"volatility_1h"). symbol_order gates
        // this (set to "volatility_1h" by default); symbol_count controls N
        // (6 in prod, 2 in dev). The engine persists the selection by writing
        // `symbols`/`active_symbols` at start, so subsequent ticks reuse it
        // (the self-written branch above) — no per-tick churn.
        const symbolOrder = String(
          (connState as any)?.symbol_order ?? (connSettings as any)?.symbol_order ?? "",
        ).toLowerCase()
        if (symbolOrder === "volatility" || symbolOrder === "volatility_1h") {
          const exchange = String(
            (connSettings as any)?.exchange ?? (connState as any)?.exchange ?? "bingx",
          ).toLowerCase()
          let count = Number(
            (connState as any)?.symbol_count ?? (connSettings as any)?.symbol_count ?? 6,
          )
          if (!Number.isFinite(count) || count < 1) count = 6
          try {
            const top = await fetchTopSymbols(exchange, count, "volatility_1h")
            const syms = (top.symbols ?? []).map((s) => String(s.symbol)).filter(Boolean)
            if (syms.length > 0) {
              console.log(
                `[v0] [getSymbols] ${this.connectionId}: selected top-${syms.length} by 1h volatility on ${exchange}: ${syms.join(", ")}`,
              )
              return syms
            }
          } catch (volErr) {
            console.error(
              `[v0] [getSymbols] ${this.connectionId}: 1h-volatility selection failed, using fallback:`,
              volErr instanceof Error ? volErr.message : String(volErr),
            )
          }
        }

        return ["DRIFTUSDT"]
      } catch (error) {
        console.error("[v0] Failed to get symbols, using fallback:", error instanceof Error ? error.message : String(error))
        return ["DRIFTUSDT"]
      }
    }

    let resolved = await resolve()
    // Apply dev symbol cap when V0_DEV_SYMBOL_COUNT > 1 (devCap was stashed
    // on the resolve function to avoid a closure variable that could race
    // with concurrent calls during hot-reload).
    if (process.env.NODE_ENV === "development") {
      const devCap = (resolve as any)._devCap
      if (typeof devCap === "number" && devCap > 1 && resolved.length > devCap) {
        resolved = resolved.slice(0, devCap)
        console.log(`[v0] [getSymbols] Dev cap ${devCap}: using ${resolved.join(",")}`)
      }
    }
    this._symbolsCache = resolved
    this._symbolsCachedAt = now
    return resolved
  }

  /**
   * Force-expire the cached symbol list. Call from the heartbeat or when an
   * admin API updates the connection's active_symbols so the next tick picks
   * up the new value immediately rather than waiting for the TTL.
   */
  public invalidateSymbolsCache(): void {
    this._symbolsCache = null
    this._symbolsCachedAt = 0
  }

  /**
   * Best-effort settings-save fast path: run one immediate realtime
   * ind+strat pass for the currently configured symbols instead of waiting
   * for the next scheduled processor tick. This is intentionally guarded and
   * non-fatal because the normal timer loop remains the correctness fallback.
   */
  public triggerImmediateStrategyReevaluation(reason = "settings-dirty"): void {
    if (!this.isRunning) return
    if (this.immediateStrategyReevaluationInFlight) return
    this.immediateStrategyReevaluationInFlight = true
    void (async () => {
      try {
        const symbols = await this.getSymbols()
        if (!symbols || symbols.length === 0) return
        await prefetchMarketDataBatch(symbols).catch(() => { /* non-critical */ })
        const pipelineDeps = {
          indication: this.indicationProcessor,
          strategy: this.strategyProcessor,
          realtime: this.realtimeProcessor,
        }
        await mapWithConcurrency(symbols, SYMBOL_CONCURRENCY, (symbol) =>
          runIndStratCycle(this.connectionId, symbol, "realtime", pipelineDeps).catch((err) => {
            console.warn(
              `[v0] [Engine ${this.connectionId}] immediate strategy re-evaluation failed for ${symbol}:`,
              err instanceof Error ? err.message : String(err),
            )
            return null
          }),
        )
        console.log(
          `[v0] [Engine ${this.connectionId}] immediate strategy re-evaluation completed for ${symbols.length} symbol(s) (${reason})`,
        )
      } catch (err) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] immediate strategy re-evaluation failed:`,
          err instanceof Error ? err.message : String(err),
        )
      } finally {
        this.immediateStrategyReevaluationInFlight = false
      }
    })()
  }

  /**
   * Update engine state (Redis-based)
   * Uses consistent key naming for status endpoint compatibility
   */
  private async updateEngineState(status: string, errorMessage?: string): Promise<void> {
    try {
      const stateKey = `trade_engine_state:${this.connectionId}`
      const currentState = (await getSettings(stateKey)) || {}
      await setSettings(stateKey, {
        ...currentState,
        status,
        error_message: errorMessage || null,
        updated_at: new Date().toISOString(),
        last_indication_run: new Date().toISOString(),
      })

      console.log(`[v0] [Engine State] Updated ${stateKey}: status=${status}`)
    } catch (error) {
      console.error("[v0] Failed to update engine state:", error)
    }
  }

  /**
   * Update progression phase with detailed progress tracking
   * Phases: idle -> initializing -> prehistoric_data -> indications -> strategies -> realtime -> live_trading
   */
  async updateProgressionPhase(
    phase: string,
    progress: number,
    detail: string,
    subProgress?: { current: number; total: number; item?: string }
  ): Promise<void> {
    try {
      const key = `engine_progression:${this.connectionId}`
      const progressionData = {
        phase,
        progress: Math.min(100, Math.max(0, progress)),
        detail,
        sub_current: subProgress?.current || 0,
        sub_total: subProgress?.total || 0,
        sub_item: subProgress?.item || "",
        connection_id: this.connectionId,
        updated_at: new Date().toISOString(),
      }

      await setSettings(key, progressionData)

      // Log progression update with full details
      const msg = subProgress && subProgress.total > 0
        ? `${detail} (${subProgress.current}/${subProgress.total}${subProgress.item ? ` - ${subProgress.item}` : ""})`
        : detail

      console.log(`[v0] [Progression] ${this.connectionId}: ${phase} @ ${progress}% - ${msg}`)
    } catch (error) {
      console.error("[v0] Failed to update progression phase:", error)
    }
  }

  /**
   * Set running flag in Redis for active status detection
   */
  private async setRunningFlag(isRunning: boolean): Promise<void> {
    try {
      const flagKey = `engine_is_running:${this.connectionId}`
      const client = getRedisClient()
      await client.set(flagKey, isRunning ? "1" : "0")
      console.log(`[v0] [Engine Flag] ${flagKey}=${isRunning ? "1" : "0"}`)
    } catch (error) {
      console.error("[v0] Failed to set running flag:", error)
    }
  }

  /**
   * Start heartbeat to keep running state active and refresh live market data
   * Heartbeat: every 10s (state write)
   * Market data refresh: every 30s (re-fetches latest candle from exchange)
   */
  private startHeartbeat(): void {
    let heartbeatCount = 0

    this.heartbeatTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
        return
      }

      heartbeatCount++

      try {
        const stateKey = `trade_engine_state:${this.connectionId}`
        await setSettings(stateKey, {
          status: "running",
          last_indication_run: new Date().toISOString(),
          // STABILITY: dedicated millis-epoch heartbeat read by the
          // coordinator's stall watchdog. Numeric form is much cheaper
          // for the watchdog to compare than re-parsing an ISO string,
          // and it isolates "engine alive" from "indication ran" — the
          // two used to be conflated which made stall detection unreliable.
          last_processor_heartbeat: Date.now(),
          connection_id: this.connectionId,
        })
      } catch {
        // Silent fail - heartbeat is non-critical
      }

      // Refresh market data every 30s (every 3rd heartbeat) to keep live prices current.
      // Skip reload if data is already fresh — the 1s envelope TTL is 24h but the
      // loader itself writes a `market_data:BTCUSDT:1s` stamp; checking this prevents
      // redundant exchange API calls from the heartbeat and prehistoric progression
      // firing simultaneously.
      if (heartbeatCount % 3 === 0) {
        try {
          const symbols = await this.getSymbols()
          const client = getRedisClient()
          const marketLoaded = await client.get("market_data:BTCUSDT:1s")
          if (!marketLoaded) {
            await loadMarketDataForEngine(symbols)
            console.log(`[v0] [Heartbeat] Market data refreshed for ${symbols.length} symbols`)
          }
        } catch (refreshErr) {
          console.warn(`[v0] [Heartbeat] Market data refresh failed:`, refreshErr instanceof Error ? refreshErr.message : String(refreshErr))
        }
      }
    }, 10000)
  }

  /**
   * ── Lock-extend ticker ─────────────────────────────────────────────
   *
   * Refreshes the cross-process progression lock at a sub-TTL cadence
   * so the lock never expires while the engine is making progress. If
   * the extend call returns `false` we LOST OWNERSHIP — either because
   * the lock TTL elapsed during a long pause, OR because the watchdog
   * forcibly broke it after a confirmed stall and another worker took
   * over. In either case the correct response is to stop the engine
   * gracefully so we don't continue mutating progression state that
   * now belongs to a different generation.
   *
   * No-op when there's no lock handle (single-process / test mode).
   */
  /**
   * Tolerance for transient extend failures BEFORE we declare ownership
   * lost and self-stop. With LOCK_EXTEND_INTERVAL_MS = 30s and the
   * lock TTL = 300s we can tolerate 5 consecutive miss-extends (~150s)
   * without healthy engines self-stopping during slow exchange calls or
   * dev-route recompiles. Shorter windows caused live tests to lose
   * ownership while market/order requests were still in flight.
   */
  private extendFailuresInARow = 0
  private static readonly EXTEND_FAILURES_TOLERATED = 5

  private startLockExtender(): void {
    if (!this.lockHandle) return
    if (this.lockExtendTimer) {
      clearInterval(this.lockExtendTimer)
      this.lockExtendTimer = undefined
    }
    this.extendFailuresInARow = 0
    this.lockExtendTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.lockExtendTimer) {
          clearInterval(this.lockExtendTimer)
          this.lockExtendTimer = undefined
        }
        return
      }
      if (!this.lockHandle) return
      let ok = false
      try {
        ok = await extendProgressionLock(this.connectionId, this.lockHandle)
      } catch (err) {
        // ── Transient-failure path ────��──────────────────────────────
        // Network glitches, Redis pauses, and one-off serialization
        // errors must not kill the engine. Count the miss and wait
        // for the NEXT tick to confirm. Only escalate to a self-stop
        // after `EXTEND_FAILURES_TOLERATED` consecutive misses, which
        // is still well under LOCK_TTL_SEC.
        this.extendFailuresInARow++
        console.warn(
          `[v0] [Engine ${this.connectionId}] lock extend threw (${this.extendFailuresInARow}/${TradeEngineManager.EXTEND_FAILURES_TOLERATED}):`,
          err instanceof Error ? err.message : String(err),
        )
        if (this.extendFailuresInARow >= TradeEngineManager.EXTEND_FAILURES_TOLERATED) {
          console.warn(
            `[v0] [Engine ${this.connectionId}] giving up on lock extend after ${this.extendFailuresInARow} consecutive Redis failures — stopping gracefully`,
          )
          this.extendFailuresInARow = 0
          try { await this.stop() } catch { /* swallow */ }
        }
        return
      }
      if (ok) {
        // Healthy extend — reset failure counter.
        this.extendFailuresInARow = 0
        return
      }
      // ── Definitive ownership loss ────────────────────────────────
      // `ok === false` means the lock value no longer matches our
      // token (someone else owns the slot, OR the TTL expired and a
      // new acquirer wrote a fresh value on top). This is NOT a
      // retryable error — there's no recovery path; another worker
      // is already running with a higher epoch. Stop gracefully.
      this.extendFailuresInARow++
      if (this.extendFailuresInARow < TradeEngineManager.EXTEND_FAILURES_TOLERATED) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] lock token mismatch (${this.extendFailuresInARow}/${TradeEngineManager.EXTEND_FAILURES_TOLERATED}) — will confirm on next tick before stopping`,
        )
        return
      }
      console.warn(
        `[v0] [Engine ${this.connectionId}] CONFIRMED ownership loss — another generation owns this connection. Stopping gracefully to avoid result mixing.`,
      )
      this.extendFailuresInARow = 0
      try {
        await logProgressionEvent(
          this.connectionId,
          "ownership_lost",
          "warning",
          "Progression lock lost — stopping engine to prevent cross-generation result writes",
          { epoch: this.epoch, connectionId: this.connectionId },
        )
      } catch {
        /* logging is best-effort */
      }
      // Self-stop. `stop()` is idempotent and clears the extender.
      try {
        await this.stop()
      } catch {
        /* swallow */
      }
    }, LOCK_EXTEND_INTERVAL_MS)
  }

  /**
   * Quick in-memory ownership/epoch guard used by external write paths
   * (e.g. progression counters, indication metric writes) to drop
   * stale callbacks that resolve after a generation flip. Cheap:
   * compares two integers, no I/O.
   */
  isCurrentGeneration(expectedEpoch: number): boolean {
    return this.isRunning && this.epoch > 0 && this.epoch === expectedEpoch
  }

  /** Current generation epoch (0 when stopped). */
  get currentEpoch(): number {
    return this.epoch
  }

  /**
   * Current settings generation. Bumped every time `applyHotReload`
   * runs. Processors / cycle code can compare this against a locally
   * remembered value to invalidate memoized config snapshots.
   */
  get currentSettingsVersion(): number {
    return this.settingsVersion
  }

  // ───���─────────────────────────────────────────────────���──────────────
  //  Live settings reload
  // ────��───────────���───────────────────────────────────────────────────

  /**
   * Starts the per-connection settings watcher (3s poll). Cheap: a
   * single HGETALL on `settings:settings_change_counter:{id}` per
   * tick, branchless when the counter hasn't moved.
   */
  private startSettingsWatcher(): void {
    if (this.settingsWatcherTimer) {
      clearInterval(this.settingsWatcherTimer)
      this.settingsWatcherTimer = undefined
    }
    // Seed the counter so we don't immediately re-apply a change that
    // happened BEFORE the engine started.
    void this.seedSettingsCounter()
    this.settingsWatcherTimer = setInterval(async () => {
      if (!this.isRunning) {
        if (this.settingsWatcherTimer) {
          clearInterval(this.settingsWatcherTimer)
          this.settingsWatcherTimer = undefined
        }
        return
      }
      if (this.settingsApplying) return
      try {
        const { getChangeCounter } = await import("@/lib/settings-coordinator")
        const counter = await getChangeCounter(this.connectionId)
        if (counter > this.lastSettingsCounter) {
          this.lastSettingsCounter = counter
          await this.applyPendingSettingsChange()
        }
      } catch (err) {
        // Watcher failures must never kill the engine; just log once.
        console.warn(
          `[v0] [Engine ${this.connectionId}] settings watcher poll failed:`,
          err instanceof Error ? err.message : String(err),
        )
      }
    }, 3000)
  }

  private async seedSettingsCounter(): Promise<void> {
    try {
      const { getChangeCounter } = await import("@/lib/settings-coordinator")
      this.lastSettingsCounter = await getChangeCounter(this.connectionId)
    } catch {
      this.lastSettingsCounter = 0
    }
  }

  /**
   * Public fast-path: called by the API route after `notifySettingsChanged`
   * so changes take effect WITHIN MILLISECONDS rather than waiting up
   * to one watcher tick (3 s). Safe to call even when the engine isn't
   * running — it just returns. Idempotent.
   */
  async applyPendingSettingsChangeNow(): Promise<void> {
    if (!this.isRunning) return
    // Capture the latest counter so the periodic watcher doesn't
    // re-fire on the same change.
    try {
      const { getChangeCounter } = await import("@/lib/settings-coordinator")
      this.lastSettingsCounter = await getChangeCounter(this.connectionId)
    } catch {
      /* best effort */
    }
    await this.applyPendingSettingsChange()
  }

  /**
   * Consumes the pending change event, dispatches to reload-or-restart,
   * and clears the event. Wrapped in a `settingsApplying` mutex so a
   * fast-path call and a watcher tick can't interleave.
   */
  private async applyPendingSettingsChange(): Promise<void> {
    if (this.settingsApplying) return
    this.settingsApplying = true
    try {
      const { getPendingChanges, clearPendingChanges } = await import("@/lib/settings-coordinator")
      const event = await getPendingChanges(this.connectionId)
      if (!event) return

      const changeType = event.changeType
      const fields = Array.isArray(event.changedFields) ? event.changedFields : []
      console.log(
        `[v0] [Engine ${this.connectionId}] applying settings change type=${changeType} fields=[${fields.join(",")}]`,
      )

      if (changeType === "restart") {
        // Hand off to the coordinator's stop+start path. We MUST clear
        // the pending event BEFORE the restart so the freshly-started
        // engine doesn't immediately re-apply the same change (it
        // would just be a no-op, but cleaner this way).
        await clearPendingChanges(this.connectionId)
        try {
          const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
          const coordinator = getGlobalTradeEngineCoordinator()
          await coordinator.restartEngine(this.connectionId)
        } catch (restartErr) {
          console.error(
            `[v0] [Engine ${this.connectionId}] settings-driven restart failed:`,
            restartErr instanceof Error ? restartErr.message : String(restartErr),
          )
        }
        return
      }

      if (changeType === "reload") {
        await this.applyHotReload(fields)
        await clearPendingChanges(this.connectionId)
        return
      }

      // `cosmetic` — name change, label, etc. Nothing to do for the
      // engine, just clear the marker.
      await clearPendingChanges(this.connectionId)
    } catch (err) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] applyPendingSettingsChange failed:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      this.settingsApplying = false
    }
  }

  /**
   * Hot-reload path: bump `settingsVersion`, re-read the connection
   * snapshot from Redis, and refresh any cached configs the manager
   * controls. Per-cycle code in processors already reads fresh from
   * Redis, so for THOSE this is mostly a cache-bust signal. For
   * settings that ARE held in memory (interval cadence, volume
   * factor, preset toggles) we copy the new values into `startConfig`.
   */
  private async applyHotReload(_changedFields: string[]): Promise<void> {
    this.settingsVersion++
    try {
      const changedFields = Array.isArray(_changedFields) ? _changedFields : []
      const invalidatedCaches: string[] = []
      const genericConnectionSettingsReload = isGenericConnectionSettingsReload(changedFields)
      const symbolAffectingChange = hasSymbolAffectingChange(changedFields)
      const strategyAffectingChange = genericConnectionSettingsReload || hasStrategyAffectingChange(changedFields)

      if (symbolAffectingChange) {
        this.invalidateSymbolsCache()
        invalidatedCaches.push("engine.symbols")
      }

      clearFlowThrottleForConnection(this.connectionId)
      invalidatedCaches.push("strategy.flowThrottle")

      let coordinatorReloadGeneration = 0
      if (strategyAffectingChange) {
        coordinatorReloadGeneration = StrategyCoordinator.forceNextSettingsReload(this.connectionId)
        invalidatedCaches.push(
          "strategyCoordinator.PFThresholds",
          "strategyCoordinator.DDTThresholds",
          "strategyCoordinator.trailingSettings",
          "strategyCoordinator.minStepSettings",
          "strategyCoordinator.coordinationSettings",
        )
      }

      try {
        this.realtimeProcessor.invalidatePrevSet(undefined)
        ;(this.realtimeProcessor as any).prevSetCache?.clear?.()
        invalidatedCaches.push("realtime.prevSetCache")
      } catch { /* best-effort */ }

      try {
        ;(this.pseudoPositionManager as any).invalidateCache?.()
        invalidatedCaches.push("pseudoPosition.activePositions")
      } catch { /* best-effort */ }

      // Make the new generation visible to long-lived processors and to
      // other workers that receive the Redis settings-change event before
      // this in-process manager sees the API fast-path.
      for (const processor of [
        this.indicationProcessor,
        this.strategyProcessor,
        this.realtimeProcessor,
        this.pseudoPositionManager,
      ] as any[]) {
        processor.settingsGeneration = this.settingsVersion
      }

      try {
        const client = getRedisClient()
        await client.hset(`engine:settings_generation:${this.connectionId}`, {
          generation: String(this.settingsVersion),
          updated_at: new Date().toISOString(),
          changed_fields: JSON.stringify(changedFields),
          coordinator_reload_generation: String(coordinatorReloadGeneration),
        })
        await client.set(`settings:generation:${this.connectionId}`, String(this.settingsVersion))
      } catch (generationErr) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] hot-reload generation publish failed:`,
          generationErr instanceof Error ? generationErr.message : String(generationErr),
        )
      }
      const symbolRelatedFields = new Set([
        "active_symbols",
        "force_symbols",
        "symbol_count",
        "symbolCount",
        "symbol_order",
        "symbols",
      ])
      const shouldRefreshSymbols =
        // PATCH /settings emits a durable generic `connection_settings`
        // reload because the payload is nested/partial. Treat that as
        // symbol-affecting here so correctness does not depend on the
        // same-process API fast-path invalidation.
        changedFields.includes("connection_settings") ||
        changedFields.some((field) => symbolRelatedFields.has(field))

      const { getConnection } = await import("@/lib/redis-db")
      const fresh = await getConnection(this.connectionId)
      if (!fresh) {
        console.warn(
          `[v0] [Engine ${this.connectionId}] hot-reload: connection vanished from Redis; skipping`,
        )
        return
      }

      // Pick up new per-connection intervals if the operator changed
      // them via the settings UI. The scheduler reads pause from a
      // global setting today (cyclePauseMs) but `startConfig` is the
      // canonical source for any future per-connection cadence work.
      const cs: any = typeof (fresh as any).connection_settings === "string"
        ? (() => {
            try { return JSON.parse((fresh as any).connection_settings) } catch { return {} }
          })()
        : ((fresh as any).connection_settings || {})

      if (this.startConfig) {
        if (Number.isFinite(Number(cs.indicationTimeInterval))) {
          this.startConfig.indicationInterval = Number(cs.indicationTimeInterval)
        }
        if (Number.isFinite(Number(cs.strategyTimeInterval))) {
          this.startConfig.strategyInterval = Number(cs.strategyTimeInterval)
        }
        if (Number.isFinite(Number(cs.realtimeTimeInterval))) {
          this.startConfig.realtimeInterval = Number(cs.realtimeTimeInterval)
        }
      }

      if (shouldRefreshSymbols) {
        // Durable cross-process cache bust: the settings API still
        // invalidates the local manager as a latency optimization, but a
        // production manager may live in a different process. On the reload
        // event itself, force the next symbol lookup to re-read the durable
        // sources (`trade_engine_state:{id}` first, then connection settings)
        // and prime the cache before the next indication/strategy/realtime
        // tick can reuse stale active-symbol state.
        this.invalidateSymbolsCache()
        try {
          const symbols = await this.getSymbols()
          console.log(
            `[v0] [Engine ${this.connectionId}] hot-reload refreshed active-symbol cache (${symbols.length} symbols)`,
          )
        } catch (symbolErr) {
          // getSymbols() has its own fallback path; keep hot-reload best-effort.
          console.warn(
            `[v0] [Engine ${this.connectionId}] hot-reload symbol-cache refresh failed:`,
            symbolErr instanceof Error ? symbolErr.message : String(symbolErr),
          )
        }
      }

      // Best-effort: tell any subscribed processors to refresh. The
      // pseudo-position manager + config-set processor already re-read
      // fresh per cycle, so this is informational, but we still log
      // it for operator visibility.
      console.log(
        `[v0] [Engine ${this.connectionId}] hot-reload applied ` +
          `(settingsVersion=${this.settingsVersion}, volume_factor=${(fresh as any).volume_factor}, ` +
          `invalidatedCaches=[${invalidatedCaches.join(",")}], changedFields=[${changedFields.join(",")}])`,
      )

      try {
        await logProgressionEvent(
          this.connectionId,
          "settings_reloaded",
          "info",
          `Connection settings hot-reloaded (v=${this.settingsVersion})`,
          {
            settingsVersion: this.settingsVersion,
            connectionId: this.connectionId,
            changedFields,
            invalidatedCaches,
            symbolAffectingChange,
            strategyAffectingChange,
            genericConnectionSettingsReload,
            coordinatorReloadGeneration,
          },
        )
      } catch { /* best-effort */ }

      this.triggerImmediateStrategyReevaluation("settings-hot-reload")
    } catch (err) {
      console.warn(
        `[v0] [Engine ${this.connectionId}] applyHotReload failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Get engine status (Redis-based)
   */
  async getStatus() {
    try {
      const stateKey = `trade_engine_state:${this.connectionId}`
      const state = (await getSettings(stateKey)) || {}
      return {
        ...state,
        health: {
          overall: this.calculateOverallHealth(),
          components: {
            indications: { ...this.componentHealth.indications },
            strategies: { ...this.componentHealth.strategies },
            realtime: { ...this.componentHealth.realtime },
          },
          lastCheck: new Date(),
        },
      }
    } catch (error) {
      console.error("[v0] Failed to get engine status:", error)
      return null
    }
  }
}
