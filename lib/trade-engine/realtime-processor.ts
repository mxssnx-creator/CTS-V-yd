/**
 * Realtime Processor
 * Processes real-time updates for active positions with market data.
 *
 * ── Prehistoric dependency ─────────────────────────────────────────────
 * This processor is SELF-GATED in `engine-manager.startRealtimeProcessor`
 * on the `prehistoric:{id}:done` Redis flag, and additionally verifies
 * readiness at the entry of every cycle in `processRealtimeUpdates()`.
 * Until prehistoric has finished it returns `{ updates: 0 }` and skips
 * all per-position work. This guarantees that when a tick evaluates a
 * live pseudo-position we can always enrich it with the "prev position"
 * context derived from the prehistoric Set calculations — see
 * `getPrevSetPosition()` below. Previous-position context feeds into
 * TP/SL calibration and prevents cold-start TP/SL decisions running
 * against an empty history.
 *
 * NOW: 100% Redis-backed, no SQL.
 */

import { getRedisClient } from "@/lib/redis-db"
import { PseudoPositionManager } from "./pseudo-position-manager"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { StrategyConfigManager, type PseudoPosition } from "@/lib/strategy-config-manager"
import { trackTrailingStopMetrics } from "@/lib/statistics-tracker"
import { validateTrailingStopEdgeCases, logValidationWarnings, isAnomalousPrice } from "@/lib/validation-guards"
// Shared module-level market-data cache with a 200ms TTL, in-flight
// deduplication, and pipelined batch prefetch. We delegate price reads
// to it instead of maintaining a second per-processor cache — a single
// 200ms-TTL cache aligns with the market-data feed cadence and lets
// multiple processors (indication, strategy, realtime) share the same
// warm entries.
import { getMarketDataCached, prefetchMarketDataBatch } from "./market-data-cache"
// Tunable cadences (heartbeat, live-sync) read at gate-evaluation time from
// `settings:system`. See lib/engine-timings.ts. The `private static readonly`
// constants below are kept as fallback defaults when the cache is empty on
// cold start.
import { getEngineTimings } from "@/lib/engine-timings"
import { performanceProfiler } from "@/lib/performance-profiler"

// ── Module-level import memoization for live-sync hot paths ──────────
// `fireSyncLiveFromPseudo` and `maybeRunLiveSync` were previously doing
// 3 `await import()` calls per invocation (every trailing stop update
// and every 5s sync), costing 3–5ms each. Memoize at module level so
// each dynamic import resolves exactly once per process.
let __connModule: any = null
let __exchangeModule: any = null
let __liveStageModule: any = null
async function __ensureConnModule() {
  if (!__connModule) __connModule = await import("@/lib/redis-db")
  return __connModule.getConnection
}
async function __ensureExchangeModule() {
  if (!__exchangeModule) __exchangeModule = await import("@/lib/exchange-connectors")
  return __exchangeModule.createExchangeConnector
}
async function __ensureLiveStageModule() {
  if (!__liveStageModule) __liveStageModule = await import("@/lib/trade-engine/stages/live-stage")
  return __liveStageModule
}

export class RealtimeProcessor {
  private connectionId: string
  private positionManager: PseudoPositionManager
  // StrategyConfigManager owns the canonical Set schema (entry format,
  // keyspace, trim cap). We hold a single instance per processor and
  // delegate to it for all prev-position retrieval — zero duplicated
  // parsing, zero key drift. Historic fill, realtime read, realtime
  // write-back (on close) all share the exact same methods.
  private strategy: StrategyConfigManager
  // Price reads go through the shared module-level `getMarketDataCached`
  // (200ms TTL, in-flight dedup, pipelined prefetch). No per-processor
  // price cache — a second cache here would just add a staleness layer
  // on top of the shared one.

  // Cache of prev-set positions keyed by strategy-config id. The Set is
  // updated by the prehistoric fill path AND by live-close writebacks,
  // so the TTL is deliberately short (2s) — a live TP/SL close must
  // propagate into the realtime tick's context on the next cycle.
  private prevSetCache: Map<string, { pos: PseudoPosition | null; ts: number }> = new Map()
  private readonly PREV_SET_CACHE_TTL = 2_000

  // Cached prehistoric-ready flag (mirrors the gate in engine-manager).
  // Checked once per ~3s while serving ticks; flipped to `true` we skip
  // re-reading Redis entirely. If we ever see a cycle *after* the flag
  // flipped to false again (cache flush, manual reset) the next
  // processRealtimeUpdates call will correctly re-gate.
  private prehistoricReady = false
  private prehistoricCheckedAt = 0
  private static readonly PREHISTORIC_RECHECK_MS = 3000

  // Throttle for the settings-dirty Redis read in processRealtimeUpdates.
  // The flag is set rarely (UI-driven) but the GET fires every tick — at
  // ~5 Hz that's 5+ unnecessary reads/sec per connection.
  private _lastDirtyCheckMs = 0

  // Heartbeat throttling: the realtime loop ticks multiple times per second.
  // Previously every tick performed a getSettings + setSettings round-trip on
  // trade_engine_state just to refresh `last_realtime_run` / the position
  // count. That was ~10+ Redis hits per second per engine with zero
  // behavioural value. We now throttle the engine-state heartbeat to once per
  // second and only re-read the full state hash when the position count
  // actually changed.
  private lastHeartbeatAt = 0
  private lastPositionsCount = -1
  /** Per-position in-flight gate to prevent concurrent processPosition calls on same ID. */
  private _inflightProcessPosition = new Set<string>()
  /** Per-symbol streaming lock: prevents concurrent market data updates for the same symbol. */
  private _perSymbolLocks = new Map<string, boolean>()
  private static readonly HEARTBEAT_INTERVAL_MS = 1000

  // ── Live-position exchange sync throttle ───────────────────────────────
  // `syncWithExchange` from live-stage refreshes mark prices, places /
  // heals SL/TP protection ("control") orders, detects SL/TP crosses and
  // force-closes positions whose exchange-side stop failed to fire. It
  // MUST run from the engine loop — without it, control orders are never
  // healed and force-close-on-cross only fires via the 60s cron or the
  // 30s strategy-coordinator reconcile (which itself only runs when a
  // symbol reaches the Real-stage block). For sub-second SL/TP response
  // the realtime tick has to drive it.
  //
  // Rate-limited to settings.liveSyncIntervalMs (default 200 ms, matches
  // the live exchange-positions update cadence). Per-instance throttle is
  // sufficient because the engine spawns one RealtimeProcessor per
  // connectionId.
  //
  // Two timestamps + a single-flight flag = three independent gates:
  //   1. `liveSyncInFlight`         — never start a sync while one is
  //                                   already running (handles slow REST
  //                                   round-trips during a tick storm).
  //   2. `lastLiveSyncStartedAt`    — enforce the target cadence
  //                                   (start-to-start = liveSyncIntervalMs).
  //   3. `lastLiveSyncCompletedAt`  — enforce a post-completion breath
  //                                   (completion-to-start = liveSyncPauseMs).
  //
  // Mirrors the main progression cycle pattern in engine-manager.ts: each
  // cycle runs to full completion → short pause → next cycle. The pause
  // guarantees downstream Redis writes / control-order placements made
  // by the previous sync are fully durable before the next sync reads.
  private lastLiveSyncStartedAt = 0
  private lastLiveSyncCompletedAt = 0
  private liveSyncInFlight = false
  private static readonly LIVE_SYNC_INTERVAL_MS = 120
  private static readonly LIVE_SYNC_PAUSE_MS = 30

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.positionManager = new PseudoPositionManager(connectionId)
    this.strategy = new StrategyConfigManager(connectionId)
  }

  /**
   * Returns `true` once the prehistoric calc has written its "done"
   * marker. Cached for `PREHISTORIC_RECHECK_MS` to avoid hammering Redis.
   * The engine-manager tick loop ALSO gates on this flag (belt-and-
   * braces); this check is the second layer so callers of
   * `processRealtimeUpdates` directly (e.g. startup warm-up) can never
   * bypass the gate.
   */
  async isPrehistoricReady(): Promise<boolean> {
    if (this.prehistoricReady) return true
    const now = Date.now()
    if (now - this.prehistoricCheckedAt < RealtimeProcessor.PREHISTORIC_RECHECK_MS) {
      return this.prehistoricReady
    }
    this.prehistoricCheckedAt = now
    try {
      const client = getRedisClient()
      const v = await client.get(`prehistoric:${this.connectionId}:done`)
      this.prehistoricReady = v === "1"
    } catch {
      // Keep last-known value on transient failures.
    }
    return this.prehistoricReady
  }

  /**
   * Read the latest prev-set position for a live pseudo-position.
   *
   * Resolution order for the target `configId`:
   *   1. Explicit `strategy_config_id` field on the position hash (set
   *      by `createPosition` when the caller knows the DB primary key).
   *      This is the authoritative link into the historic-fill keyspace.
   *   2. Tail segment of `config_set_key` (legacy fallback, may be a
   *      fingerprint rather than a real configId).
   *
   * Delegates to `StrategyConfigManager.getLatestPosition` — the single
   * canonical primitive that owns both the Redis keyspace
   * (`strategy:{connId}:config:{configId}:positions`) and the entry
   * schema used by every writer.
   *
   * Cache is bounded to `MAX_PREV_SET_CACHE` entries using a simple FIFO
   * eviction so long-running engines with many distinct config ids can't
   * grow the map unboundedly. Also exposes `invalidatePrevSet` so the
   * close path can drop stale entries the moment the underlying Set is
   * mutated.
   */
  async getPrevSetPosition(
    position: { config_set_key?: string; strategy_config_id?: string } | string | undefined,
  ): Promise<PseudoPosition | null> {
    let configId = ""
    if (typeof position === "string" || position == null) {
      configId = StrategyConfigManager.extractConfigId(position)
    } else {
      const explicit = String(position.strategy_config_id || "").trim()
      configId = explicit || StrategyConfigManager.extractConfigId(position.config_set_key)
    }
    if (!configId) return null

    const now = Date.now()
    const cached = this.prevSetCache.get(configId)
    if (cached && now - cached.ts < this.PREV_SET_CACHE_TTL) return cached.pos

    try {
      const pos = await this.strategy.getLatestPosition(configId)
      this.setPrevSetCache(configId, pos, now)
      return pos
    } catch (err) {
      // On transient failure we negative-cache briefly so bursty traffic
      // doesn't stampede Redis with the same lookup.
      this.setPrevSetCache(configId, null, now)
      console.warn(
        `[v0] [Realtime] getPrevSetPosition(${configId}) failed:`,
        err instanceof Error ? err.message : String(err),
      )
      return null
    }
  }

  /** Hard cap on `prevSetCache` entries. Exceeded entries are FIFO-evicted. */
  private readonly MAX_PREV_SET_CACHE = 2048

  /** Insert with FIFO-eviction when the cache is full. */
  private setPrevSetCache(configId: string, pos: PseudoPosition | null, ts: number): void {
    if (this.prevSetCache.size >= this.MAX_PREV_SET_CACHE && !this.prevSetCache.has(configId)) {
      // Map iteration is insertion order — drop the oldest entry.
      const oldest = this.prevSetCache.keys().next().value
      if (oldest !== undefined) this.prevSetCache.delete(oldest)
    }
    this.prevSetCache.set(configId, { pos, ts })
  }

  /** Drop a cached prev-set entry. Called from the close path to avoid
   *  serving stale context for the remainder of the TTL window. */
  invalidatePrevSet(configId: string | undefined): void {
    if (!configId) return
    this.prevSetCache.delete(configId)
  }

  /**
   * Phase 2 of the shared ind+strat pipeline — per-symbol pseudo
   * position handling.
   *
   * Called by `runIndStratCycle` between indication and strategy
   * evaluation. ALWAYS runs regardless of indication outcome, so open
   * positions never miss a mark-to-market / TP / SL / max-hold check.
   *
   * Behaviour is identical to `processRealtimeUpdates` for the matching
   * symbol's positions:
   *   - refresh `current_price` from the 200 ms market-data cache
   *   - recompute `unrealized_pnl`
   *   - update `trailing_stop_price` (single- or multi-step path)
   *   - close on take_profit / stop_loss / max_hold_time_exceeded
   *
   * Returns the number of positions processed so callers can drive
   * telemetry / idle backoff without re-querying Redis.
   *
   * NOTE: this method DOES NOT touch live-exchange sync — that is the
   * responsibility of the dedicated LivePositions Progression loop in
   * engine-manager. See the three-progression contract.
   */
  async updateOpenPseudoPositionsForSymbol(symbol: string): Promise<number> {
    try {
      // Advisory readiness — Phase B (prev-set enrichment) gates on this,
      // but Phase A (mark-to-market + TP/SL) ALWAYS runs.
      const prehistoricReady = await this.isPrehistoricReady()

      // Filter active positions to this symbol. Cheap in-memory filter
      // after one cached LRANGE — far cheaper than an indexed lookup.
      const all = await this.positionManager.getActivePositions()
      const positions = (all || []).filter((p: any) => p?.symbol === symbol)
      if (positions.length === 0) return 0

      // (Plan-perf #3) The upstream realtime-tick orchestrator calls
      // `prefetchMarketDataBatch(allWatchlistSymbols)` once before
      // fanning out to every symbol — that already warmed this
      // symbol's cache in the same tick. The previous duplicate
      // `prefetchMarketDataBatch([symbol])` here added one Redis
      // round-trip per symbol per cycle (10/cycle at 10 symbols) for
      // zero observable benefit. `getMarketDataCached` reads the same
      // shared cache and returns the warmed value; if the upstream
      // batch happened to miss this symbol (e.g. just-added symbol
      // racing against a tick), it will fall back to a fresh fetch
      // exactly once for that pair.

      // Process all positions for this symbol in parallel. Each call
      // carries the position hash through so the manager skips a second
      // HGETALL.
      await Promise.all(
        positions.map((position) => this.processPosition(position, prehistoricReady)),
      )

      // Surface the per-symbol pseudo-update counters so the dashboard
      // can verify Phase 2 is firing inside each shared-pipeline cycle.
      try {
        const { getCurrentEpoch } = await import("./progression-lock")
        const { hincrbyProgressionBatch, updateProgressionSnapshot } = await import("./progression-writes")
        
        const currentEpoch = await getCurrentEpoch(this.connectionId)
        if (!currentEpoch) return positions.length // No active lock, skip metrics (stale instance)
        
        // Use validated wrappers for epoch-safe metrics
        await Promise.all([
          hincrbyProgressionBatch(this.connectionId, {
            pseudo_positions_updated_count: positions.length,
            pseudo_positions_update_cycles: 1,
          }, { connectionId: this.connectionId, epoch: currentEpoch, logStaleRejects: false }),
          updateProgressionSnapshot([
            { field: "pseudo_positions_last_update_at", value: new Date().toISOString(), operation: "set" },
            { field: "pseudo_positions_last_symbol", value: symbol, operation: "set" },
            { field: "pseudo_positions_last_count", value: String(positions.length), operation: "set" },
          ], { connectionId: this.connectionId, epoch: currentEpoch, logStaleRejects: false }),
        ])
      } catch {
        // Non-critical visibility metric — never break the pipeline.
      }

      return positions.length
    } catch (err) {
      console.error(
        `[v0] [RealtimeProcessor] updateOpenPseudoPositionsForSymbol(${symbol}) failed:`,
        err instanceof Error ? err.message : String(err),
      )
      return 0
    }
  }

  /**
   * Process real-time updates for all active positions.
   *
   * ── Decoupling contract (P0-5) ────────────────────────────────────
   * Per the architectural spec — *"Open Pseudo positions get updated
   * handled on each cycle, Independent of active indication process"* —
   * this loop MUST update every open position every tick regardless of
   * whether indication/strategy/prehistoric phases have produced any
   * work. The prehistoric-ready flag used to be a HARD gate here; it
   * is now an ADVISORY flag, passed to `processPosition` to decide
   * whether to also do prev-set enrichment (Phase B). The mark-to-
   * market update (Phase A — `current_price`, `unrealized_pnl`,
   * trailing stop, TP/SL check) ALWAYS runs.
   *
   * Returns the number of positions actually processed so callers can
   * gate follow-up work (telemetry, backoff) without re-querying Redis.
   */
  async processRealtimeUpdates(): Promise<{ updates: number }> {
    // PERFORMANCE: Start cycle profiling
    const cycleId = performanceProfiler.startCycle(this.connectionId, "realtime")
    
    try {
      performanceProfiler.recordOperation(cycleId, "init")
      
      // ── CHECK: Settings dirty flag and reload if needed ────────────────────────
      // When user updates connection settings via UI, a dirty flag is set.
      // On the next realtime tick, we detect it and clear the flag so
      // position management picks up new settings on next open/close.
      // Throttled to 1 Hz — at 5 Hz cadence the unconditional GET would
      // fire ~5 Redis ops/s per engine just to poll a typically-false flag.
      try {
        if (Date.now() - this._lastDirtyCheckMs >= 1000) {
          this._lastDirtyCheckMs = Date.now()
          const client = getRedisClient()
          const dirtyKey = `settings:dirty:${this.connectionId}`
          const isDirty = await client.get(dirtyKey)
          if (isDirty) {
            await client.del(dirtyKey)
            this.prevSetCache.clear()
            try {
              const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
              const manager = getGlobalTradeEngineCoordinator()?.getEngineManager?.(this.connectionId)
              if (manager && typeof (manager as any).invalidateStrategyAndCoordinationCaches === "function") {
                ;(manager as any).invalidateStrategyAndCoordinationCaches([], "dirty-flag:realtime")
              }
              if (manager && typeof (manager as any).triggerImmediateStrategyReevaluation === "function") {
                ;(manager as any).triggerImmediateStrategyReevaluation("dirty-flag:realtime")
              }
            } catch {
              /* Cross-process or test environments may not have a manager. */
            }
            console.log(
              `[v0] [RealtimeProcessor] Dirty flag consumed for ${this.connectionId}; caches cleared and immediate strategy re-evaluation requested`
            )
          }
        }
      } catch (settingsErr) {
        console.warn(
          `[v0] [RealtimeProcessor] Settings dirty check failed:`,
          settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
        )
      }

      // Advisory readiness flag — tells processPosition whether it's
      // safe to attach prev-set context. Never blocks Phase A work.
      const prehistoricReady = await this.isPrehistoricReady()

      const activePositions = await this.positionManager.getActivePositions()
      const count = activePositions.length
      const now = Date.now()

      // ── Per-position in-flight gate ────────────────────────────────────
      // `processRealtimeUpdates` and `updateOpenPseudoPositionsForSymbol`
      // (called from the shared pipeline) can both process the same position
      // concurrently — one via the all-positions fan-out, the other via the
      // per-symbol filter. Without a gate, two concurrent `processPosition`
      // calls on the same ID can double-increment trades, emit duplicate
      // broadcasts, and race on close. A simple in-memory Set prevents the
      // hot-path overlap (single Node process, single-threaded).
      const inflight = this._inflightProcessPosition
      for (let i = activePositions.length - 1; i >= 0; i--) {
        if (inflight.has(activePositions[i].id)) {
          activePositions.splice(i, 1)
        }
      }

      // Write the lightweight heartbeat at most once per second, and skip the
      // preceding getSettings() unless the position count changed (which is
      // when we need to merge with the persisted state hash).
      const countChanged = count !== this.lastPositionsCount
      // Read cadence from settings cache each tick — in-memory hit, no I/O.
      // Falls back to the static default if the cache hasn't yet been
      // populated (process cold start, < 1 ms after boot).
      const heartbeatIntervalMs =
        getEngineTimings().heartbeatIntervalMs || RealtimeProcessor.HEARTBEAT_INTERVAL_MS
      const heartbeatDue = now - this.lastHeartbeatAt >= heartbeatIntervalMs

      if (countChanged || heartbeatDue) {
        const stateKey = `trade_engine_state:${this.connectionId}`
        try {
          // ── Atomic heartbeat write (P0-3 race fix) ─────────────────
          // Both branches now use direct field-level hset — no
          // getSettings + spread merge. Previously the `countChanged`
          // branch did a read-modify-write that could clobber field
          // updates from concurrent writers (PseudoPositionManager.create
          // / close, engine startup, watchdog re-arm) between our read
          // and our write. With Redis hash semantics the rewrite was
          // technically a per-field merge, but the RE-WRITTEN fields
          // came from the stale read snapshot, silently losing other
          // writers' progress.
          //
          // Now: hset only the fields THIS cycle actually owns
          // (active_positions_count, last_realtime_run, updated_at,
          // realtime_processor_active). Every other field on the hash
          // — symbols, prehistoric flags, started_at, etc. — is
          // preserved untouched, regardless of who wrote it last.
          const client = getRedisClient()
          const fields: Record<string, string> = {
            last_realtime_run: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            realtime_processor_active: "true",
          }
          if (countChanged) {
            // Only stamp the count when we know it changed — saves
            // pointless writes on the heartbeat-only path.
            fields.active_positions_count = String(count)
          }
          await client.hset(stateKey, fields)
          this.lastPositionsCount = count
          this.lastHeartbeatAt = now
        } catch (hbErr) {
          // Heartbeat failures are non-critical — don't abort the cycle.
          console.warn("[v0] [Realtime] Heartbeat write failed:", hbErr instanceof Error ? hbErr.message : String(hbErr))
        }
      }

      // ── Live-position exchange sync — MOVED to its own progression ───
      // The fire-and-forget `void this.maybeRunLiveSync()` call that
      // used to live here has been removed. Live exchange-positions
      // handling is now driven by `engine-manager.startLivePositionsProgression`
      // (the third independent top-level progression loop, default
      // 200 ms cadence). That loop calls `syncWithExchange` directly
      // and is single-flighted via the Redis lock `live_sync_lock:{connId}`,
      // so pseudo-position handling here no longer needs to coordinate
      // with exchange sync. See the architectural spec for the three-
      // progression contract.

      if (count === 0) {
        performanceProfiler.endCycle(cycleId)
        return { updates: 0 }
      }

      // Pre-warm the shared market-data cache for every unique symbol
      // in a SINGLE pipelined batch (one Redis RTT regardless of symbol
      // count). Subsequent per-position price lookups hit the module-
      // level cache synchronously with zero round-trips until the 200ms
      // TTL expires. This is the single biggest win for dense ticks:
      // 100 positions across 30 symbols = 1 RTT here + 0 during the fan-
      // out, vs. the previous 30 RTTs just to warm prices.
      const uniqueSymbols = new Set<string>()
      for (const p of activePositions) {
        if (p?.symbol) uniqueSymbols.add(p.symbol)
      }
      if (uniqueSymbols.size > 0) {
        await prefetchMarketDataBatch(Array.from(uniqueSymbols))
      }

      // Process each position in parallel. Each call carries the
      // position object through — no second HGETALL in updatePosition
      // or closePosition, since the caller already has the hash.
      // `prehistoricReady` is passed as an advisory flag so Phase B
      // (prev-set enrichment) can be conditionally skipped without
      // blocking Phase A (mark-to-market + TP/SL).
      await Promise.all(
        activePositions.map((position) => {
          if (!position?.id) return Promise.resolve()
          this._inflightProcessPosition.add(position.id)
          return this.processPosition(position, prehistoricReady).finally(() => {
            this._inflightProcessPosition.delete(position.id)
          })
        }),
      )

      // ── Cross-tick visibility for the "open positions are being
      //    handled independent of indication/strategy" guarantee ─────
      // Spec: open pseudo positions inside the multiple Sets must get
      // mark-to-market refreshed on EVERY realtime cycle, before/
      // independent of indication+strategy ticks. We already do that
      // above (this is the only writer of `updatePosition` inside
      // trade-engine — verified by grep), but the dashboard needed a
      // way to *see* that it was firing without sampling individual
      // position hashes. We surface two atomic counters:
      //
      //   pseudo_positions_updated_count : cumulative position-tick events
      //                                    (= sum of `updates` across ticks)
      //   pseudo_positions_update_cycles : cumulative realtime cycles that
      //                                    actually touched ≥1 position
      //
      // These are independent of the existing realtime_*_cycle_count
      // family (which tracks tick existence regardless of work).
      try {
        const client = getRedisClient()
        const progKey = `progression:${this.connectionId}`
        await Promise.all([
          client.hincrby(progKey, "pseudo_positions_updated_count", count),
          client.hincrby(progKey, "pseudo_positions_update_cycles", 1),
          client.hset(progKey, {
            pseudo_positions_last_update_at: new Date().toISOString(),
            pseudo_positions_last_count: String(count),
          }),
          client.expire(progKey, 7 * 24 * 60 * 60),
        ])
      } catch {
        // Non-critical visibility metric — never break the realtime loop.
      }

      performanceProfiler.endCycle(cycleId)
      return { updates: count }
    } catch (error) {
      console.error("[v0] Failed to process realtime updates:", error)
      await logProgressionEvent(this.connectionId, "realtime_error", "error", "Realtime processor failed", {
        error: error instanceof Error ? error.message : String(error),
      })
      performanceProfiler.endCycle(cycleId)
      return { updates: 0 }
    }
  }

  /**
   * Process an individual active pseudo-position.
   *
   * ── Two-phase execution (P0-5) ─────────────────────────────────────
   * Every open pseudo-position gets a Phase A pass on every tick,
   * REGARDLESS of indication / strategy / prehistoric state. Phase B
   * enrichment is advisory and only runs when prehistoric has produced
   * the prev-set Sets.
   *
   *   Phase A — mark-to-market (ALWAYS):
   *     - refresh `current_price` from the 200ms market-data cache
   *     - recompute `unrealized_pnl`
   *     - update `trailing_stop_price` when trailing is enabled
   *     - check TP / SL and dispatch close
   *
   *   Phase B — prev-set enrichment (ONLY when prehistoricReady):
   *     - fetch the latest prev-set position via the 2s prev-set cache
   *     - attach it to the position as `_prev_set_position` so the
   *       TP/SL helpers can calibrate against the most recent closed
   *       position from the same strategy config
   *
   * This guarantees open positions always get mark-to-market updates
   * and timely TP/SL enforcement, even during the prehistoric warm-up
   * window or if any position somehow exists before prehistoric has
   * finished. Prev-set-calibrated decisions (a small refinement, not
   * the core safety mechanism) gracefully degrade to defaults when
   * prehistoric is not yet ready.
   */
  private async processPosition(position: any, prehistoricReady: boolean): Promise<void> {
    try {
      // ── System tracking validation ──
      // Only process positions created by this system. Skip foreign/manual orders.
      const trackingId = String(position?.system_tracking_id || "").trim()
      if (!trackingId.startsWith("sys-") || trackingId.length <= 10) {
        // Silent skip for foreign positions - don't pollute logs with every tick
        return
      }

      // Phase A is the critical path — always kick off the price fetch.
      // Phase B (prev-set) only fires when prehistoric is ready, and
      // runs in parallel with the price fetch to avoid sequential
      // latency under high symbol counts.
      const pricePromise = this.getCurrentPrice(position.symbol)
      const prevSetPromise: Promise<PseudoPosition | null> = prehistoricReady
        ? this.getPrevSetPosition(position)
        : Promise.resolve(null)

      const [currentPrice, prevSetPos] = await Promise.all([pricePromise, prevSetPromise])

      if (!currentPrice) {
        return
      }

      // Phase B attachment — only when prehistoric produced something.
      // Underscore prefix makes clear this is transient enrichment,
      // not persisted state.
      if (prevSetPos) {
        position._prev_set_position = prevSetPos
      }

      // Update position with current price. Pass the in-memory hash
      // through so the manager skips a redundant HGETALL round-trip
      // (see PseudoPositionManager.updatePosition hot-path notes).
      await this.positionManager.updatePosition(position.id, currentPrice, position)

      // Calculate profit/loss
      const entryPrice = parseFloat(position.entry_price || "0")
      const quantity = parseFloat(position.quantity || "0")
      const side = position.side || "long"

      const pnl = side === "long"
        ? (currentPrice - entryPrice) * quantity
        : (entryPrice - currentPrice) * quantity

      // Before handing to closePosition, stamp the latest market price
      // onto the position object so the manager's PnL calculation uses
      // the live price (not the potentially-stale `current_price` hash
      // field) without needing an extra HGETALL.
      position.current_price = String(currentPrice)

      // Resolve the target configId ONCE so we can invalidate the
      // prev-set cache entry the instant the underlying Set is mutated
      // by closePosition. Without this, the processor would serve the
      // stale (pre-close) prev-set record for up to PREV_SET_CACHE_TTL
      // to any other position pointing at the same config.
      const cacheConfigId =
        String(position.strategy_config_id || "").trim() ||
        StrategyConfigManager.extractConfigId(position.config_set_key)

      // Check take profit
      if (this.shouldCloseTakeProfit(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "take_profit", position)
        this.invalidatePrevSet(cacheConfigId)
        return
      }

      // Check stop loss
      if (this.shouldCloseStopLoss(position, currentPrice)) {
        await this.positionManager.closePosition(position.id, "stop_loss", position)
        this.invalidatePrevSet(cacheConfigId)
        return
      }

      // Max hold-time force-close — matches the same env-var used by the
      // live-stage so both pseudo and live positions share one time limit.
      // Reads `opened_at` first (canonical pseudo-position field), falls
      // back to `entry_time` (historic fills) then `created_at` (legacy).
      const MAX_HOLD_MS = Number(process.env.MAX_POSITION_HOLD_MS ?? 4 * 60 * 60 * 1000)
      if (MAX_HOLD_MS > 0) {
        const openedRaw = position.opened_at || position.entry_time || position.created_at
        const openedAt = openedRaw ? new Date(openedRaw).getTime() : 0
        if (openedAt > 0 && Date.now() - openedAt > MAX_HOLD_MS) {
          await this.positionManager.closePosition(position.id, "max_hold_time_exceeded", position)
          this.invalidatePrevSet(cacheConfigId)
          const heldHrs = ((Date.now() - openedAt) / 3_600_000).toFixed(1)
          console.log(
            `[v0] [Realtime] Max hold exceeded for ${position.symbol} ${side} ` +
            `(held ${heldHrs}h) | PnL: ${pnl.toFixed(4)}`,
          )
          return
        }
      }

      // Update trailing stop if enabled — the prev-set context is on
      // the position object so `updateTrailingStop` can honour it.
      if (position.trailing_enabled === "1" || position.trailing_enabled === true) {
        await this.updateTrailingStop(position, currentPrice)
      }
    } catch (error) {
      console.error(`[v0] Failed to process position ${position.id}:`, error)
    }
  }

  /**
   * Get the current price for a symbol via the shared 200ms market-
   * data cache. The cache handles in-flight dedup and pipelined batch
   * prefetch, so every realtime tick pays at most ONE Redis RTT per
   * 200ms window regardless of how many positions share the symbol.
   */
  private async getCurrentPrice(symbol: string): Promise<number | null> {
    try {
      const data = await getMarketDataCached(symbol)
      if (!data) return null
      const price = parseFloat(data?.close || data?.price || "0")
      return price > 0 ? price : null
    } catch (error) {
      console.error(`[v0] Failed to get current price for ${symbol}:`, error)
      return null
    }
  }

  /**
   * Check if take profit should be triggered.
   *
   * **Source of truth**: prefer the *assigned* `takeprofit_price` stored
   * on the position hash at creation time. That value is the SAME one
   * placed on the exchange for the corresponding live position, so this
   * pseudo-evaluator and the exchange's own TP order will fire on the
   * exact same threshold — no drift between the two.
   *
   * Recomputing from `(entry_price × takeprofit_factor%)` on every tick
   * (the legacy behaviour) was numerically equivalent for unaltered
   * positions, but if the assigned percent was ever overridden after
   * creation the two paths would silently diverge. The assigned price
   * is the definitive contract.
   *
   * Falls back to the percent-based recompute only when the stored
   * `takeprofit_price` is absent — preserves back-compat with legacy
   * position hashes opened before this field was persisted.
   */
  private shouldCloseTakeProfit(position: any, currentPrice: number): boolean {
    const side = position.side || "long"

    const assignedTpPrice = parseFloat(position.takeprofit_price || "0")
    if (assignedTpPrice > 0) {
      return side === "long" ? currentPrice >= assignedTpPrice : currentPrice <= assignedTpPrice
    }

    // Fallback: legacy hashes without `takeprofit_price`.
    const entryPrice = parseFloat(position.entry_price || "0")
    const takeprofitFactor = parseFloat(position.takeprofit_factor || "0")
    if (entryPrice <= 0 || takeprofitFactor <= 0) return false
    const recomputed =
      side === "long"
        ? entryPrice * (1 + takeprofitFactor / 100)
        : entryPrice * (1 - takeprofitFactor / 100)
    return side === "long" ? currentPrice >= recomputed : currentPrice <= recomputed
  }

  /**
   * Check if stop loss should be triggered.
   *
   * Same source-of-truth rationale as `shouldCloseTakeProfit` — prefer
   * the assigned `stoploss_price` snapshot on the position hash, which
   * is the SAME price placed on the exchange. Trailing-stop checks
   * still come first (a tighter ratchet trigger should always win over
   * the static SL gate).
   */
  private shouldCloseStopLoss(position: any, currentPrice: number): boolean {
    const side = position.side || "long"

    // Trailing stop wins when armed — it's by definition tighter than the
    // static SL (otherwise the ratchet wouldn't have moved it).
    const trailingStopPrice = parseFloat(position.trailing_stop_price || "0")
    if (trailingStopPrice > 0) {
      if (side === "long" && currentPrice <= trailingStopPrice) return true
      if (side === "short" && currentPrice >= trailingStopPrice) return true
    }

    const assignedSlPrice = parseFloat(position.stoploss_price || "0")
    if (assignedSlPrice > 0) {
      return side === "long" ? currentPrice <= assignedSlPrice : currentPrice >= assignedSlPrice
    }

    // Fallback: legacy hashes without `stoploss_price`.
    const entryPrice = parseFloat(position.entry_price || "0")
    const stoplossRatio = parseFloat(position.stoploss_ratio || "0")
    if (entryPrice <= 0 || stoplossRatio <= 0) return false
    const recomputed =
      side === "long"
        ? entryPrice * (1 - stoplossRatio / 100)
        : entryPrice * (1 + stoplossRatio / 100)
    return side === "long" ? currentPrice <= recomputed : currentPrice >= recomputed
  }

  /**
   * Trailing-stop tick — supports BOTH the legacy single-step path AND
   * the multi-step state machine driven by the Settings → Strategy →
   * Trailing matrix.
   *
   *   • Legacy path (no `trailing_start_ratio` on the hash, or 0): trail
   *     distance = `stoploss_ratio` %; ratchet on every favourable move.
   *     Identical to the previous behaviour — kept for back-compat with
   *     positions opened before multi-step trailing existed.
   *
   *   • Multi-step path (3 ratio fields populated): a 2-phase state
   *     machine.
   *
   *       1. INACTIVE — `gain_ratio < trailing_start_ratio` → no-op.
   *       2. ACTIVATION — `gain_ratio >= trailing_start_ratio` →
   *          flip `trailing_active = 1`, set `trailing_anchor` to
   *          `currentPrice` (high-water for long, low-water for short),
   *          set `trailing_stop_price` to
   *          `anchor × (1 ∓ trailing_stop_ratio)`.
   *       3. ACTIVE — re-anchor only when price has moved at least
   *          `trailing_step_ratio × anchor` in the favourable direction
   *          (so jitter inside the step doesn't re-write Redis on every
   *          tick). Stop ratchets one direction.
   *
   *   When stop is hit, `shouldCloseStopLoss` (unchanged) closes the
   *   position with reason `stop_loss`. The check there reads
   *   `trailing_stop_price`, which we set in BOTH paths, so the close
   *   gate is shared.
   */
  private async updateTrailingStop(position: any, currentPrice: number): Promise<void> {
    try {
      const entryPrice = parseFloat(position.entry_price || "0")
      const side: "long" | "short" = position.side === "short" ? "short" : "long"
      if (entryPrice <= 0 || currentPrice <= 0) return

      const startRatio = parseFloat(position.trailing_start_ratio || "0")
      const stopRatio = parseFloat(position.trailing_stop_ratio || "0")
      let stepRatio = parseFloat(position.trailing_step_ratio || "0")
      
      // CRITICAL: Validate stepRatio is not zero or too small. If stepRatio is
      // 0 or NaN, re-anchoring would happen on every price change, breaking the
      // entire trailing mechanism. Default to stopRatio/2 if invalid.
      if (!Number.isFinite(stepRatio) || stepRatio <= 0) {
        stepRatio = stopRatio > 0 ? stopRatio / 2 : 0
        if (!Number.isFinite(stepRatio)) stepRatio = 0
      }
      
      const useMultiStep = startRatio > 0 && stopRatio > 0

      const client = getRedisClient()
      const hashKey = `pseudo_position:${this.connectionId}:${position.id}`

      // ── Multi-step path ────────────────────────────────────────────
      if (useMultiStep) {
        // Profit ratio in the trade's favourable direction.
        const gainRatio =
          side === "long"
            ? (currentPrice - entryPrice) / entryPrice
            : (entryPrice - currentPrice) / entryPrice

        const wasActive = position.trailing_active === "1" || position.trailing_active === true
        const anchorStored = parseFloat(position.trailing_anchor || "0")
        const currentTrailingStop = parseFloat(position.trailing_stop_price || "0")

        // Phase 1 — INACTIVE: not yet at the activation threshold.
        if (!wasActive) {
          if (gainRatio < startRatio) return  // dormant; pure TP/SL governs

          // Phase 2 — ACTIVATION: cross the start threshold for the first time.
          const anchor = currentPrice
          const newStop =
            side === "long"
              ? anchor * (1 - stopRatio)
              : anchor * (1 + stopRatio)

          await client.hset(hashKey, {
            trailing_active: "1",
            trailing_anchor: String(anchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          // Mutate in-place so the very next gate (shouldCloseStopLoss)
          // sees the freshly-armed stop without re-fetching the hash.
          position.trailing_active = "1"
          position.trailing_anchor = String(anchor)
          position.trailing_stop_price = String(newStop)
          
          // Track trailing stop creation
          void trackTrailingStopMetrics(
            this.connectionId,
            position.symbol,
            "created",
            stopRatio,
            undefined,
            newStop
          ).catch(() => {})
          
          // Validate edge cases
          const trailingWarnings = validateTrailingStopEdgeCases(
            position.symbol,
            entryPrice,
            parseFloat(position.leverage || "1"),
            stopRatio,
            true,
            newStop,
            currentPrice
          )
          logValidationWarnings(trailingWarnings, `${position.symbol} trailing created`)
          
          // Spec §6: trailing just armed — sync to live position now
          // so the exchange SL/TP reflects the activated stop level.
          void this.fireSyncLiveFromPseudo(position).catch(() => {})
          return
        }

        // Phase 3 — ACTIVE: re-anchor only when price has moved by ≥ step
        // in the favourable direction. Step is computed against the
        // STORED anchor (not currentPrice) so a single big tick doesn't
        // skip over and immediately re-anchor on the next.
        // CRITICAL: Enforce minimum stepRatio to prevent ratcheting too frequently.
        // If stepRatio is too small, every small price tick would trigger re-anchoring.
        const minStepRatio = 0.001  // 0.1% minimum step size (can be overridden via settings)
        const safeStepRatio = Math.max(stepRatio, minStepRatio)
        const stepDistance = anchorStored * safeStepRatio
        if (side === "long") {
          if (currentPrice <= anchorStored + stepDistance) return
          const newAnchor = currentPrice
          const newStop = newAnchor * (1 - stopRatio)
          // Ratchet — never relax the stop downward for longs
          if (currentTrailingStop > 0 && newStop <= currentTrailingStop) {
            // Anchor moved but stop didn't tighten meaningfully — write
            // the anchor only so subsequent steps measure from the new
            // high. Cheap one-field write.
            await client.hset(hashKey, {
              trailing_anchor: String(newAnchor),
              updated_at: new Date().toISOString(),
            })
            position.trailing_anchor = String(newAnchor)
            return
          }
          await client.hset(hashKey, {
            trailing_anchor: String(newAnchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          position.trailing_anchor = String(newAnchor)
          position.trailing_stop_price = String(newStop)
          // Spec §6: re-arm matching live position's exchange SL/TP.
          void this.fireSyncLiveFromPseudo(position).catch(() => {})
        } else {
          // SHORT: ratchet when price drops below anchor - step distance
          if (currentPrice >= anchorStored - stepDistance) return
          const newAnchor = currentPrice
          const newStop = newAnchor * (1 + stopRatio)
          if (currentTrailingStop > 0 && newStop >= currentTrailingStop) {
            await client.hset(hashKey, {
              trailing_anchor: String(newAnchor),
              updated_at: new Date().toISOString(),
            })
            position.trailing_anchor = String(newAnchor)
            return
          }
          await client.hset(hashKey, {
            trailing_anchor: String(newAnchor),
            trailing_stop_price: String(newStop),
            updated_at: new Date().toISOString(),
          })
          position.trailing_anchor = String(newAnchor)
          position.trailing_stop_price = String(newStop)
          // Spec §6: re-arm matching live position's exchange SL/TP.
          void this.fireSyncLiveFromPseudo(position).catch(() => {})
        }
        return
      }

      // ── Legacy single-step path (back-compat) ─────────────────────
      const stoplossRatio = parseFloat(position.stoploss_ratio || "0")
      const currentTrailingStop = parseFloat(position.trailing_stop_price || "0")
      const trailingDistance = currentPrice * (stoplossRatio / 100)

      let newTrailingStop: number
      if (side === "long") {
        newTrailingStop = currentPrice - trailingDistance
        if (newTrailingStop <= currentTrailingStop && currentTrailingStop > 0) return
      } else {
        newTrailingStop = currentPrice + trailingDistance
        if (newTrailingStop >= currentTrailingStop && currentTrailingStop > 0) return
      }

      await client.hset(hashKey, {
        trailing_stop_price: String(newTrailingStop),
        updated_at: new Date().toISOString(),
      })

      // ── Pseudo → Live sync hook (spec §6) ─────────────────────────
      //
      // Single-step path tail. Call the sync helper so any matching
      // live position re-arms its exchange-side SL/TP at the new
      // trailing stop. We intentionally use the percent form
      // (`stoploss_ratio`) rather than the absolute trailing price —
      // `recalculateAndApplySLTP` re-derives the trigger from the
      // percent + live entry price, which is correct even when the
      // live entry differs from the pseudo entry by fees / slippage.
      //
      // Fire-and-forget: `syncLiveFromPseudo` returns Promise<void>
      // and swallows every error. Never await on the hot path.
      void this.fireSyncLiveFromPseudo(position).catch(() => {})
    } catch (error) {
      console.error(`[v0] Failed to update trailing stop for position ${position.id}:`, error)
    }
  }

  /**
   * Build a connector + invoke `syncLiveFromPseudo` for the connection.
   * Kept as a separate method so we can call it from both the
   * multi-step and single-step trailing branches without duplicating
   * the connector boilerplate. Best-effort; logs and swallows errors.
   */
  private async fireSyncLiveFromPseudo(position: any): Promise<void> {
    try {
      const getConnection = await __ensureConnModule()
      const connection = await getConnection(this.connectionId)
      if (!connection) return
      const apiKey = (connection as any).api_key || (connection as any).apiKey || ""
      const apiSecret = (connection as any).api_secret || (connection as any).apiSecret || ""
      if (!apiKey || !apiSecret) return

      const createExchangeConnector = await __ensureExchangeModule()
      const connector = await createExchangeConnector(connection.exchange, {
        apiKey,
        apiSecret,
        apiType: connection.api_type,
        contractType: connection.contract_type,
        isTestnet: connection.is_testnet === true || connection.is_testnet === "true",
      })

      const { syncLiveFromPseudo } = await __ensureLiveStageModule()
      await syncLiveFromPseudo(this.connectionId, position, connector)
    } catch (err) {
      console.warn(`[v0] fireSyncLiveFromPseudo error for ${position?.id}:`, err instanceof Error ? err.message : String(err))
    }
  }

  /**
   * Per-tick driver for `live-stage.syncWithExchange`. Refreshes mark
   * prices, heals SL/TP protection orders, force-closes positions whose
   * SL/TP level has been crossed, and arms protection for delayed fills.
   *
   * Throttled to LIVE_SYNC_INTERVAL_MS (5 s) so a fast realtime tick
   * doesn't translate into multi-Hz exchange REST hits. Single-flight
   * guarded so a slow exchange round-trip can't queue overlapping syncs.
   * Fire-and-forget: errors are logged but never propagated to the tick
   * loop — pseudo-position processing must continue regardless.
   *
   * No-op early-exit when:
   *   - throttle window not yet elapsed
   *   - a previous sync is still in flight
   *   - the connection has no exchange credentials (paper-only)
   *   - the global coordinator is paused (exchange ops skipped, simulated
   *     positions still close via local SL/TP detection)
   */
  private async maybeRunLiveSync(): Promise<void> {
    const now = Date.now()
    // ── Gate 1: single-flight ─────────────────────────────────────────
    // Never start a sync while another is in progress. A slow REST
    // round-trip during a tick storm must NOT queue overlapping syncs;
    // they would race on the same per-position Redis state.
    if (this.liveSyncInFlight) return

    // Read cadence + pause from settings:system; static consts are the
    // fallback only until the engine-timings cache lands (~milliseconds
    // after boot).
    const timings = getEngineTimings()
    const liveSyncIntervalMs =
      timings.liveSyncIntervalMs || RealtimeProcessor.LIVE_SYNC_INTERVAL_MS
    const liveSyncPauseMs =
      (typeof timings.liveSyncPauseMs === "number" ? timings.liveSyncPauseMs : RealtimeProcessor.LIVE_SYNC_PAUSE_MS)

    // ── Gate 2: target cadence (start-to-start) ───────────────────────
    // Enforce the configured interval between sync STARTS. Drives the
    // close-detection cadence (default 200 ms = 5 sweeps/sec).
    if (now - this.lastLiveSyncStartedAt < liveSyncIntervalMs) return

    // ── Gate 3: post-completion breath ────────────────────────────────
    // After the previous sync finished, wait `liveSyncPauseMs` before
    // the next can start. Mirrors the main progression cycle's 50 ms
    // breath — gives the event loop room and ensures downstream Redis
    // writes from the previous sync are observable to the next one.
    // On the very first tick `lastLiveSyncCompletedAt` is 0, so this
    // gate is a no-op (now - 0 >> pauseMs).
    if (now - this.lastLiveSyncCompletedAt < liveSyncPauseMs) return

    this.lastLiveSyncStartedAt = now
    this.liveSyncInFlight = true

    try {
      // ── Always-run simulated-position sweep ─────────────────────────
      // Runs BEFORE every early-return below (no connection record,
      // missing API keys, connector failure) so simulated positions on
      // paper-only / is_live_trade=false connections always get a
      // close path on every realtime tick. The helper is fully
      // self-contained and reads Redis market_data for prices, so it
      // doesn't depend on the exchange connector being available.
      //
      // This is the single most important fix for the operator's
      // recurring "Live Positions are Still not getting closed"
      // complaint on paper-mode connections ��� every other close path
      // was gated on having a working exchange connector, so paper
      // simulated positions accumulated unboundedly.
      //
      // ALSO runs even when the global coordinator is paused — local
      // SL/TP detection and position closing must continue regardless
      // of pause state.
      try {
        const { processSimulatedPositions } = await import("@/lib/trade-engine/stages/live-stage")
        await processSimulatedPositions(this.connectionId)
      } catch (simErr) {
        console.warn(
          `[v0] [Realtime] processSimulatedPositions error for ${this.connectionId}:`,
          simErr instanceof Error ? simErr.message : String(simErr),
        )
      }

      // ── Check if coordinator is paused before exchange sync ──────────
      // When paused, skip the exchange syncing (control order creation,
      // orphan adoption, mark-price refresh) but KEEP the simulated-
      // position sweep running above. When resumed, the next sync will
      // rebuild control orders and catch up on mark prices.
      try {
        const { initRedis, getRedisClient } = await import("@/lib/redis-db")
        await initRedis()
        const client = getRedisClient()
        const globalState = await client.hgetall("trade_engine:global")
        if ((globalState as any)?.status === "paused") {
          console.log(
            `[v0] [Realtime] live sync skipped for ${this.connectionId}: coordinator is paused (simulated positions still closing locally)`,
          )
          return
        }
      } catch (pauseCheckErr) {
        // Non-fatal pause check failure — proceed with sync anyway
        console.warn(
          `[v0] [Realtime] pause state check failed, proceeding with sync:`,
          pauseCheckErr instanceof Error ? pauseCheckErr.message : String(pauseCheckErr),
        )
      }

      // ── REMOVED the prior LLEN short-circuit ────────────────────────────
      // The previous version short-circuited when `live:positions:{id}`
      // LLEN returned 0. That looked like a sensible optimization but
      // turned out to be the root cause of the operator's repeated
      // "Live Positions not getting closed" complaint:
      //
      //   - Positions placed by the system in earlier runs / before a
      //     savePosition LPUSH lost their TTL, OR positions opened by
      //     the operator directly on the exchange, are NEVER in the
      //     Redis open-index. With the LLEN guard, `syncWithExchange`
      //     was therefore never invoked — so the orphan-adoption sweep
      //     inside it (added below) never ran, and the exchange-side
      //     positions stayed open indefinitely with no control orders.
      //
      // The cost of always calling `syncWithExchange` when there are
      // zero tracked positions is one `getLivePositions` (cheap LRANGE)
      // plus, every 5 s, one `getPositions()` exchange call inside the
      // orphan-adoption sweep. Fine.
      const getConnection = await __ensureConnModule()
      const connection = await getConnection(this.connectionId)
      if (!connection) {
        console.warn(`[v0] [Realtime] live sync skipped: no connection record for ${this.connectionId}`)
        return
      }
      const apiKey = (connection as any).api_key || (connection as any).apiKey || ""
      const apiSecret = (connection as any).api_secret || (connection as any).apiSecret || ""
      // Paper-only if either key is empty. Do NOT check length — valid
      // credentials vary by exchange (some are short, some long).
      if (!apiKey || !apiSecret) {
        // Paper-only connection — nothing to sync against on the exchange
        // side. The simulated-position sweep above already handled all
        // close paths for paper trades, so we return silently here.
        return
      }

      const createExchangeConnector = await __ensureExchangeModule()
      const connector = await createExchangeConnector(connection.exchange, {
        apiKey,
        apiSecret,
        apiType: connection.api_type,
        contractType: connection.contract_type,
        isTestnet: connection.is_testnet === true || connection.is_testnet === "true",
      })
      if (!connector) {
        console.warn(`[v0] [Realtime] live sync skipped: createExchangeConnector returned null for ${this.connectionId}`)
        return
      }

      const { syncWithExchange } = await __ensureLiveStageModule()
      await syncWithExchange(this.connectionId, connector)
    } catch (err) {
      console.warn(
        `[v0] [Realtime] live syncWithExchange error for ${this.connectionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    } finally {
      // Stamp completion FIRST so the post-completion pause gate measures
      // from real "work done" rather than "lock released" — these are the
      // same instant here, but ordering this explicitly documents intent.
      this.lastLiveSyncCompletedAt = Date.now()
      this.liveSyncInFlight = false
    }
  }

  /**
   * Get stream status
   */
  getStatus(): string {
    return "redis_polling"
  }

  /**
   * Initialize real-time data stream (placeholder for WebSocket-based streams)
   */
  async initializeStream(): Promise<void> {
    console.log(`[v0] [RealtimeProcessor] Stream initialized for ${this.connectionId} (using Redis polling)`)
  }

  /**
   * Stop real-time data stream
   */
  async stopStream(): Promise<void> {
    console.log(`[v0] [RealtimeProcessor] Stream stopped for ${this.connectionId}`)
  }

  /**
   * Get current stream status
   */
  getStreamStatus(): { active: boolean; type: string; lastUpdate?: number } {
    return {
      active: true,
      type: "redis_polling",
      lastUpdate: Date.now(),
    }
  }
}
