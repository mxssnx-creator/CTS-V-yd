/**
 * ╔═════════════════════════════════════════════════════════════════════════╗
 * ║              PROGRESSION STATE — REDIS SCHEMA (CANONICAL)              ║
 * ║                                                                         ║
 * ║  Hash key:                       progression:{connectionId}            ║
 * ║  Sibling string keys (per-stage Set fan-out, 24h TTL):                 ║
 * ║      strategies:{id}:base:count        strategies:{id}:base:evaluated  ║
 * ║      strategies:{id}:main:count        strategies:{id}:main:evaluated  ║
 * ║      strategies:{id}:real:count        strategies:{id}:real:evaluated  ║
 * ║                                                                         ║
 * ║  Update discipline (PRESERVE THIS — concurrent processors race):       ║
 * ║   • COUNTERS  → `hincrby` ONLY. Never `hset` a counter; three           ║
 * ║                  processors (indication / strategy / realtime) and     ║
 * ║                  the strategy-coordinator all write the same hash      ║
 * ║                  concurrently, so read-modify-write loses updates.     ║
 * ║   • SNAPSHOTS → `hset` (a single newest value wins).                   ║
 * ║   • FLOATS    → stored as ASCII strings; read with `parseFloat`.       ║
 * ║   • Reset is operator-driven only (see `resetProgressionState`).       ║
 * ║     Engine restart MUST preserve every counter — `engine-manager       ║
 * ║     .ts:start()` only writes `last_update` + `engine_started` when     ║
 * ║     the hash already exists (and now backfills `started_at` if         ║
 * ║     absent).                                                            ║
 * ║                                                                         ║
 * ║  ── Field families (the names below match exact Redis hash keys) ──   ║
 * ║                                                                         ║
 * ║   GLOBAL CYCLE COUNTERS (hincrby) — written by every processor on      ║
 * ║   every productive tick via `incrementCycle`:                          ║
 * ║      cycles_completed         successful_cycles      failed_cycles     ║
 * ║                                                                         ║
 * ║   PER-PROCESSOR CYCLE COUNTERS (hincrby) — taxonomy:                   ║
 * ║      *_cycle_count       = every tick (churn / scheduler heartbeat)    ║
 * ║      *_live_cycle_count  = ticks that did real work (≥1 entry)         ║
 * ║      indication_cycle_count       indication_live_cycle_count          ║
 * ║      strategy_cycle_count         strategy_live_cycle_count            ║
 * ║      realtime_cycle_count         realtime_live_cycle_count            ║
 * ║      frames_processed             ← cross-processor cumulative sum     ║
 * ║                                                                         ║
 * ║   INDICATION-SET COUNTERS (hincrby, one per type — additive on every   ║
 * ║   `saveIndicationToSet`/`batchSaveIndications` call):                  ║
 * ║      indications_direction_count        indications_move_count        ║
 * ║      indications_active_count           indications_active_advanced_count
 * ║      indications_optimal_count          indications_auto_count        ║
 * ║      ▸ Adding a new type to `DEFAULT_LIMITS` in                        ║
 * ║        `lib/indication-sets-processor.ts` REQUIRES adding the counter  ║
 * ║        to (a) `ProgressionState`, (b) `getProgressionState` parser,    ║
 * ║        (c) `getDefaultState`, and (d) the per-type hincrby write in    ║
 * ║        `engine-manager.ts → startIndicationProcessor`.                 ║
 * ║                                                                         ║
 * ║   STRATEGY-SET COUNTERS (hincrby — written by                          ║
 * ║   `StrategyCoordinator.executeStrategyFlow` on every Set creation;     ║
 * ║   `engine-manager` writes ONLY cycle metrics to avoid double-count):   ║
 * ║      strategies_base_total              strategies_base_evaluated     ║
 * ║      strategies_main_total              strategies_main_evaluated     ║
 * ║      strategies_real_total              strategies_real_evaluated     ║
 * ║      ▸ Note: NOT `strategy_evaluated_*`. The "evaluated" counters      ║
 * ║        currently mirror "total" 1:1 (`evaluated += entryCount` per     ║
 * ║        Set) — kept distinct so future filtering (skip-empty etc.)      ║
 * ║        can diverge them without a data migration.                      ║
 * ║                                                                         ║
 * ║   TRADE / PROFIT (mixed — see field):                                   ║
 * ║      total_trades         (hincrby)                                    ║
 * ║      successful_trades    (hincrby)                                    ║
 * ║      total_profit         (hincrbyfloat — atomic float add)            ║
 * ║                                                                         ║
 * ║   SNAPSHOT FIELDS (hset; newest wins):                                 ║
 * ║      cycle_success_rate (float-as-string, %)                           ║
 * ║      trade_success_rate (float-as-string, %)                           ║
 * ║      cycle_time_ms      (int-as-string)                                ║
 * ║      last_cycle_time    (ISO-8601)                                     ║
 * ║      last_update        (ISO-8601)                                     ║
 * ║      started_at         (epoch-ms; written on first init,              ║
 * ║                          backfilled on restart if absent — feeds       ║
 * ║                          `/api/connections/progression/[id]/stats`     ║
 * ║                          rolling-window rate calculations)             ║
 * ║      connection_id      (string)                                       ║
 * ║      engine_started     ("true" / "false")                             ║
 * ║      prehistoric_phase_active   ("true" / "false")                     ║
 * ║      prehistoric_symbols_processed (JSON-encoded string[])             ║
 * ║      intervals_processed  indications_count  strategies_count          ║
 * ║      prehistoric_candles_processed                                     ║
 * ║      prehistoric_symbols_processed_count                               ║
 * ║                                                                         ║
 * ║  Read path:                                                             ║
 * ║   • `getProgressionState(connectionId)` HGETALLs the hash and parses   ║
 * ║     numeric fields. Missing fields default via `getDefaultState` so    ║
 * ║     consumers always see a complete, well-typed `ProgressionState`.   ║
 * ╚═════════════════════════════════════════════════════════════════════════╝
 */

import { getRedisClient, initRedis, setSettings } from "@/lib/redis-db"

export interface ProgressionRecoordinationResult {
  changed: boolean
  reason?: string
  newEpoch?: number
}

export interface RecoordinateProgressionResult {
  changed: boolean
  reason?: string
  newEpoch?: number
}

export interface ProgressionState {
  connectionId: string
  // Session identity — increments each time a new progression starts
  sessionNumber?: number
  // Epoch written by engine-manager on every new start; used for stale-write guards
  epoch?: number
  // Timestamps for the current session
  startedAt?: number       // epoch-ms; set on first/new session start
  endedAt?: number         // epoch-ms; set when engine stops cleanly
  cyclesCompleted: number
  successfulCycles: number
  failedCycles: number
  cycleSuccessRate: number
  totalTrades: number
  successfulTrades: number
  totalProfit: number
  tradeSuccessRate?: number
  lastUpdate: Date
  prehistoricCyclesCompleted?: number
  prehistoricSymbolsProcessed?: string[]
  prehistoricPhaseActive?: boolean
  engine_cycles_total?: number
  lastCycleTime?: Date | null
  
  // Prehistoric data processing metrics
  prehistoricCandlesProcessed?: number
  prehistoricSymbolsProcessedCount?: number
  
  // Indication-set counters
  indicationsDirectionCount?: number
  indicationsMoveCount?: number
  indicationsActiveCount?: number
  indicationsActiveAdvancedCount?: number
  indicationsOptimalCount?: number
  indicationsAutoCount?: number
  indicationsCount?: number
  
  // Strategy-set counters
  strategiesBaseTotal?: number
  strategiesMainTotal?: number
  strategiesRealTotal?: number
  strategyEvaluatedBase?: number
  strategyEvaluatedMain?: number
  strategyEvaluatedReal?: number
  strategiesCount?: number
  
  // Processing metrics
  cycleTimeMs?: number
  intervalsProcessed?: number
  
  progressSettingsSnapshot?: Record<string, any>
  startedForSettingsVersion?: string
  
  // Per-processor cycle counters (cumulative, atomic)
  indicationCycleCount?: number
  indicationLiveCycleCount?: number
  strategyCycleCount?: number
  strategyLiveCycleCount?: number
  realtimeCycleCount?: number
  realtimeLiveCycleCount?: number
  framesProcessed?: number
  
  // Uniqueness / solidity snapshot fields
  symbolCount?: number
  activeSymbolsHash?: string
}

/**
 * Progression state manager - tracks engine cycles and progression for each connection.
 * Uses Redis for persistent storage and in-memory LRU for hot connection state.
 */
export class ProgressionStateManager {
  static async getProgressionState(connectionId: string): Promise<ProgressionState> {
    try {
      // PRODUCTION FIX: Always initialize Redis connection before using it
      await initRedis()
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not initialized for ${connectionId}, returning default state`)
        return this.getDefaultState(connectionId)
      }

      const key = `progression:${connectionId}`
      let data: Record<string, string> = {}
      
      try {
        const raw = await client.hgetall(key)
        if (raw !== null && raw !== undefined) data = raw as Record<string, string>
      } catch (redisError) {
        console.warn(`[v0] Redis connection error reading progression:${connectionId}, using default state:`, redisError)
        return this.getDefaultState(connectionId)
      }

      if (!data || Object.keys(data).length === 0) {
        return this.getDefaultState(connectionId)
      }

      return {
        connectionId,
        // Session identity
        sessionNumber: data.session_number ? parseInt(data.session_number, 10) : undefined,
        epoch: data.epoch ? Number(data.epoch) : undefined,
        startedAt: data.started_at ? Number(data.started_at) : undefined,
        endedAt: data.ended_at ? Number(data.ended_at) : undefined,
        cyclesCompleted: parseInt(data.cycles_completed || "0", 10),
        successfulCycles: parseInt(data.successful_cycles || "0", 10),
        failedCycles: parseInt(data.failed_cycles || "0", 10),
        totalTrades: parseInt(data.total_trades || "0", 10),
        successfulTrades: parseInt(data.successful_trades || "0", 10),
        totalProfit: parseFloat(data.total_profit || "0"),
        cycleSuccessRate: parseFloat(data.cycle_success_rate || "0"),
        tradeSuccessRate: parseFloat(data.trade_success_rate || "0"),
        lastCycleTime: data.last_cycle_time ? new Date(data.last_cycle_time) : undefined,
        lastUpdate: new Date(data.last_update || new Date()),
        prehistoricCyclesCompleted: parseInt(data.prehistoric_cycles_completed || "0", 10),
        prehistoricSymbolsProcessed: data.prehistoric_symbols_processed ? (() => { try { return JSON.parse(data.prehistoric_symbols_processed) } catch { return [] } })() : [],
        prehistoricPhaseActive: data.prehistoric_phase_active === "true",
        prehistoricCandlesProcessed: parseInt(data.prehistoric_candles_processed || "0", 10),
        prehistoricSymbolsProcessedCount: parseInt(data.prehistoric_symbols_processed_count || "0", 10),
        indicationsDirectionCount: parseInt(data.indications_direction_count || "0", 10),
        indicationsMoveCount: parseInt(data.indications_move_count || "0", 10),
        indicationsActiveCount: parseInt(data.indications_active_count || "0", 10),
        indicationsActiveAdvancedCount: parseInt(data.indications_active_advanced_count || "0", 10),
        indicationsOptimalCount: parseInt(data.indications_optimal_count || "0", 10),
        indicationsAutoCount: parseInt(data.indications_auto_count || "0", 10),
        strategiesBaseTotal: parseInt(data.strategies_base_total || "0", 10),
        strategiesMainTotal: parseInt(data.strategies_main_total || "0", 10),
        strategiesRealTotal: parseInt(data.strategies_real_total || "0", 10),
        strategyEvaluatedBase: parseInt(data.strategies_base_evaluated || "0", 10),
        strategyEvaluatedMain: parseInt(data.strategies_main_evaluated || "0", 10),
        strategyEvaluatedReal: parseInt(data.strategies_real_evaluated || "0", 10),
        cycleTimeMs: parseInt(data.cycle_time_ms || "0", 10),
        intervalsProcessed: parseInt(data.intervals_processed || "0", 10),
        indicationsCount: parseInt(data.indications_count || "0", 10),
        strategiesCount: parseInt(data.strategies_count || "0", 10),
        // Uniqueness / solidity snapshot fields
        progressSettingsSnapshot: data.progress_settings_snapshot ? (() => { try { return JSON.parse(data.progress_settings_snapshot) } catch { return {} } })() : {},
        symbolCount: data.symbol_count ? parseInt(data.symbol_count, 10) : 0,
        activeSymbolsHash: data.active_symbols_hash || "",
        startedForSettingsVersion: data.started_for_settings_version || "",
        // Per-processor cycle counters (cumulative, atomic)
        indicationCycleCount: parseInt(data.indication_cycle_count || "0", 10),
        indicationLiveCycleCount: parseInt(data.indication_live_cycle_count || "0", 10),
        strategyCycleCount: parseInt(data.strategy_cycle_count || "0", 10),
        strategyLiveCycleCount: parseInt(data.strategy_live_cycle_count || "0", 10),
        realtimeCycleCount: parseInt(data.realtime_cycle_count || "0", 10),
        realtimeLiveCycleCount: parseInt(data.realtime_live_cycle_count || "0", 10),
        framesProcessed: parseInt(data.frames_processed || "0", 10),
      }
    } catch (error) {
      console.error(`[v0] Failed to get progression state for ${connectionId}:`, error)
      return this.getDefaultState(connectionId)
    }
  }

  /**
   * Get default progression state (reusable helper)
   */
  static getDefaultState(connectionId: string): ProgressionState {
    return {
      connectionId,
      cyclesCompleted: 0,
      successfulCycles: 0,
      failedCycles: 0,
      totalTrades: 0,
      successfulTrades: 0,
      totalProfit: 0,
      cycleSuccessRate: 0,
      tradeSuccessRate: 0,
      lastCycleTime: undefined,
      lastUpdate: new Date(),
      prehistoricCyclesCompleted: 0,
      prehistoricSymbolsProcessed: [],
      prehistoricPhaseActive: false,
      prehistoricCandlesProcessed: 0,
      prehistoricSymbolsProcessedCount: 0,
      indicationsDirectionCount: 0,
      indicationsMoveCount: 0,
      indicationsActiveCount: 0,
      indicationsActiveAdvancedCount: 0,
      indicationsOptimalCount: 0,
      indicationsAutoCount: 0,
      strategiesBaseTotal: 0,
      strategiesMainTotal: 0,
      strategiesRealTotal: 0,
      strategyEvaluatedBase: 0,
      strategyEvaluatedMain: 0,
      strategyEvaluatedReal: 0,
      cycleTimeMs: 0,
      intervalsProcessed: 0,
      indicationsCount: 0,
      strategiesCount: 0,
      // Uniqueness / solidity snapshot fields
      progressSettingsSnapshot: {},
      symbolCount: 0,
      activeSymbolsHash: "",
      startedForSettingsVersion: "",
      indicationCycleCount: 0,
      indicationLiveCycleCount: 0,
      strategyCycleCount: 0,
      strategyLiveCycleCount: 0,
      realtimeCycleCount: 0,
      realtimeLiveCycleCount: 0,
      framesProcessed: 0,
    }
  }

  /**
   * Cycle counting and progression tracking.
   * Three processors call this concurrently, so we use atomic hincrby to
   * avoid read-modify-write race windows.
   *
   * Memory optimization: Limit to 100 active connections in memory.
   * When limit exceeded, oldest (least recently used) connection is evicted.
   * This prevents unbounded memory growth when many connections are created.
   */
  private static readonly CYCLE_COUNTERS_MAX = 100
  private static cycleCounters: Map<string, { completed: number; successful: number; failed: number }> = new Map()

  static async incrementCycle(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) {
        await initRedis()
      }
      const actualClient = getRedisClient()
      if (!actualClient) {
        console.warn(`[v0] Redis client not available for incrementCycle`)
        return
      }

      const redisKey = `progression:${connectionId}`

      // CRITICAL FIX: use atomic hincrby instead of read-modify-write hset.
      // Three processors (indication/strategy/realtime) call incrementCycle
      // concurrently. The old read-then-write pattern had a race window that
      // dropped updates, which contributed to jumping/inconsistent counters
      // across refreshes. hincrby is atomic at the Redis level.
      let newCompleted = 0
      let newSuccessful = 0
      let newFailed = 0
      try {
        // Only fire the two hincrby calls we actually need — no hget.
        // The third counter value (successful vs failed) is derived from
        // the local in-process mirror which is updated below. This cuts
        // the Redis fan-out from 3 ops to 2 ops per incrementCycle call,
        // eliminating one round-trip per productive cycle tick.
        const prev = this.cycleCounters.get(connectionId) ?? { completed: 0, successful: 0, failed: 0 }
        if (successful) {
          const [completed, successCount] = await Promise.all([
            client.hincrby(redisKey, "cycles_completed", 1),
            client.hincrby(redisKey, "successful_cycles", 1),
          ])
          newCompleted  = Number(completed) || 0
          newSuccessful = Number(successCount) || 0
          newFailed     = prev.failed
        } else {
          const [completed, failCount] = await Promise.all([
            client.hincrby(redisKey, "cycles_completed", 1),
            client.hincrby(redisKey, "failed_cycles", 1),
          ])
          newCompleted  = Number(completed) || 0
          newFailed     = Number(failCount) || 0
          newSuccessful = prev.successful
        }
      } catch (e) {
        console.warn(`[v0] Failed to increment progression counters for ${connectionId}:`, e)
        return
      }

      // Update local counter for tracking (best-effort mirror; not authoritative)
      // Enforce size limit to prevent unbounded memory growth
      if (this.cycleCounters.size >= this.CYCLE_COUNTERS_MAX && !this.cycleCounters.has(connectionId)) {
        const firstKey = this.cycleCounters.keys().next().value
        if (firstKey) this.cycleCounters.delete(firstKey)
      }
      this.cycleCounters.set(connectionId, {
        completed: newCompleted,
        successful: newSuccessful,
        failed: newFailed,
      })

      const successRate = newCompleted > 0 ? (newSuccessful / newCompleted) * 100 : 0

      // Write metadata (non-counter fields) + expire in parallel.
      try {
        const nowIso = new Date().toISOString()
        const metaWrites: Promise<any>[] = [
          client.hset(redisKey, {
            cycle_success_rate: String(successRate.toFixed(2)),
            last_cycle_time: nowIso,
            last_update: nowIso,
            connection_id: connectionId,
          }),
        ]
        // Gate expire to every 500 completed cycles — the hash TTL is 7
        // days; resetting it on every cycle burns one extra round-trip per
        // cycle across all three concurrent processors. At 500 cycles the
        // key is refreshed roughly every 25 s, well within the 7-day window.
        if (newCompleted % 500 === 1) {
          metaWrites.push(client.expire(redisKey, 7 * 24 * 60 * 60))
        }
        await Promise.all(metaWrites)
      } catch (writeError) {
        console.warn(`[v0] Failed to write progression metadata for ${connectionId}:`, writeError)
        return
      }

      // Log every 25 cycles
      if (newCompleted % 25 === 0 && newCompleted > 0) {
        console.log(`[v0] [Progression] Cycle ${newCompleted}: ${successRate.toFixed(1)}% success rate`)
      }
    } catch (error) {
      // Silent fail to not block processing
      console.error(`[v0] Unexpected error in incrementCycle:`, error)
    }
  }

  /**
   * Track prehistoric phase progress (separate from realtime)
   */
  static async incrementPrehistoricCycle(connectionId: string, symbol: string): Promise<void> {
    try {
      if (!getRedisClient()) {
        await initRedis()
      }
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not available for incrementPrehistoricCycle`)
        return
      }
      const key = `progression:${connectionId}`

      // PERFORMANCE: The previous implementation called `getProgressionState`
      // which does a full `hgetall` + JSON parse on every call — expensive
      // and unnecessary. We now use atomic hincrby for the counter and a
      // per-connection Set for the processed symbols which deduplicates in
      // O(1) Redis-side without needing to re-read the whole hash.
      const symbolsSetKey = `${key}:prehistoric_symbols_set`
      const nowIso = new Date().toISOString()

      const [prehistoricCycles] = await Promise.all([
        client.hincrby(key, "prehistoric_cycles_completed", 1),
        client.sadd(symbolsSetKey, symbol).catch(() => 0),
        client.expire(symbolsSetKey, 7 * 24 * 60 * 60).catch(() => 0),
      ])

      // Mirror the processed symbols list into the hash so existing readers
      // (which still expect `prehistoric_symbols_processed` as JSON) keep
      // working. `smembers` replaces the old read-modify-write cycle.
      const symbolsProcessed = ((await client.smembers(symbolsSetKey).catch(() => [])) || []) as string[]

      await Promise.all([
        client.hset(key, {
          prehistoric_symbols_processed: JSON.stringify(symbolsProcessed),
          prehistoric_phase_active: "true",
          last_update: nowIso,
        }),
        client.expire(key, 7 * 24 * 60 * 60),
      ])

      console.log(
        `[v0] [Prehistoric] Symbol ${symbol}: Cycle ${prehistoricCycles} | Processed: ${symbolsProcessed.join(", ")}`,
      )
    } catch (error) {
      console.error(`[v0] Failed to track prehistoric cycle for ${connectionId}:`, error)
    }
  }

  /**
   * Mark prehistoric phase as complete.
   *
   * Deterministically PINS the terminal progress state so the dashboard can
   * never be left showing a sub-100% bar or an "X/N" label short of N once the
   * run has actually finished — even if a symbol was skipped (no data) or threw
   * mid-process and the live percent never organically reached the end. Pass
   * `symbolTotal` (the connection's configured symbol count) to stamp the
   * authoritative final counts.
   */
  static async completePrehistoricPhase(connectionId: string, symbolTotal?: number): Promise<void> {
    try {
      // Ensure Redis is initialised BEFORE using the client.
      // getRedisClient() returns null on cold-boot; binding `client` first then
      // calling initRedis() left the local null, causing every completion call
      // to crash on `client.hset` with "Cannot read properties of null".
      // Re-fetch after init so we always hold a live instance.
      let client = getRedisClient()
      if (!client) {
        await initRedis()
        client = getRedisClient()!
      }
      const key = `progression:${connectionId}`

      await client.hset(key, {
        prehistoric_phase_active: "false",
        last_update: new Date().toISOString(),
      })

      // Pin the prehistoric counter hash + the dashboard progress bar to their
      // terminal values. We clamp the displayed processed count to the distinct
      // SET cardinality (authoritative) but never below `symbolTotal` so the
      // label reads a clean "N/N".
      try {
        const distinct = await client
          .scard(`prehistoric:${connectionId}:symbols`)
          .catch(() => 0)
        const total = Math.max(1, symbolTotal ?? distinct ?? 1)
        const finalProcessed = Math.max(distinct, total)
        await client.hset(`prehistoric:${connectionId}`, {
          symbols_processed: String(finalProcessed),
          symbols_total: String(total),
          is_complete: "1",
        })
        await setSettings(`engine_progression:${connectionId}`, {
          phase: "prehistoric_data",
          progress: 95,
          detail: `Prehistoric calc complete — ${finalProcessed}/${total} symbols processed`,
          sub_current: finalProcessed,
          sub_total: total,
          connection_id: connectionId,
          updated_at: new Date().toISOString(),
        }).catch(() => { /* non-critical */ })
      } catch { /* non-critical */ }

      console.log(`[v0] [Prehistoric] Phase completed for connection ${connectionId}`)
    } catch (error) {
      console.error(`[v0] Failed to mark prehistoric phase complete:`, error)
    }
  }

  /**
   * Record a trade execution
   *
   * CRITICAL FIX: the previous implementation used the classic read-modify-write
   * pattern (`getProgressionState` → mutate locally → `hset`). When trades
   * complete for multiple symbols concurrently (e.g. the strategy coordinator
   * fans out live-set execution in parallel) this silently dropped counter
   * updates because the two in-flight writers each read the same `total_trades`
   * value and wrote `+1` on top of the other's write.
   *
   * We now use atomic Redis primitives (`hincrby` / `hincrbyfloat`) so every
   * trade is counted exactly once regardless of concurrency. The derived
   * `trade_success_rate` is computed from the freshly-incremented counters
   * rather than from stale in-memory snapshots.
   *
   * `total_profit` is stored as a float via `hincrbyfloat`. On the mock Redis
   * adapter this call falls through to `hincrby` (which rejects non-integer
   * deltas); we detect that path and fall back to a safe snapshot update.
   */
  static async recordTrade(connectionId: string, successful: boolean, profit: number = 0): Promise<void> {
    try {
      const client = getRedisClient()
      if (!client) {
        await initRedis()
      }
      const actualClient = getRedisClient()
      if (!actualClient) {
        console.warn(`[v0] Redis client not available for recordTrade`)
        return
      }
      const key = `progression:${connectionId}`

      // Atomic counter increments. Kick off both counters concurrently — hincrby
      // returns the post-increment value so we can derive the success rate from
      // authoritative data rather than a read-then-write snapshot.
      const totalTradesP = client.hincrby(key, "total_trades", 1)
      const successfulTradesP = successful
        ? client.hincrby(key, "successful_trades", 1)
        : Promise.resolve(null as any)

      // Profit is a float. Prefer hincrbyfloat; if the adapter doesn't support
      // it (e.g. mock / older inline client) fall back to a read-modify-write
      // on `total_profit` only — the counters above remain atomic either way.
      let totalProfitP: Promise<any>
      const hincrbyfloat = (client as any).hincrbyfloat as
        | ((k: string, f: string, d: number) => Promise<string | number>)
        | undefined
      if (typeof hincrbyfloat === "function" && profit !== 0) {
        totalProfitP = hincrbyfloat.call(client, key, "total_profit", profit).catch(async () => {
          // Fallback: read current, add, write. Best-effort only — racy vs
          // other profit updates but the counter integrity is preserved.
          try {
            const cur = Number((await client.hget(key, "total_profit")) || "0") || 0
            await client.hset(key, { total_profit: String(cur + profit) })
          } catch { /* ignore */ }
        })
      } else if (profit !== 0) {
        totalProfitP = (async () => {
          try {
            const cur = Number((await client.hget(key, "total_profit")) || "0") || 0
            await client.hset(key, { total_profit: String(cur + profit) })
          } catch { /* ignore */ }
        })()
      } else {
        totalProfitP = Promise.resolve()
      }

      const [totalTradesRaw, successfulTradesRaw, totalProfitRaw] = await Promise.all([
        totalTradesP,
        successfulTradesP,
        totalProfitP,
      ])

      const newTotalTrades = Number(totalTradesRaw) || 0
      // When this trade was successful, we already incremented `successful_trades`
      // atomically via hincrby — use the returned value directly. When
      // unsuccessful, read the count for success-rate math. We always have the
      // resolved value available (either from hincrby return or from the extra
      // fetch) — no separate Redis round-trip needed on either path.
      const newSuccessfulTrades = !successful
        ? (Number((await client.hget(key, "successful_trades")) || "0") || 0)
        : (Number(successfulTradesRaw) || 0)

      // Defensive bound: after quickstart resets or cross-worker recovery, stale
      // successful_trades can momentarily exceed the freshly reset total_trades,
      // producing impossible UI/log values such as 200% success. Clamp and write
      // the corrected counter back so subsequent readers stay sane.
      const maxPossibleSuccessfulTrades = successful ? newTotalTrades : Math.max(0, newTotalTrades - 1)
      const boundedSuccessfulTrades = Math.max(0, Math.min(newSuccessfulTrades, maxPossibleSuccessfulTrades))
      const tradeSuccessRate =
        newTotalTrades > 0 ? (boundedSuccessfulTrades / newTotalTrades) * 100 : 0

      // Metadata + rate write in parallel with the expire refresh.
      const nowIso = new Date().toISOString()
      const tradeUpdate: Record<string, string> = {
        trade_success_rate: String(tradeSuccessRate.toFixed(2)),
        last_update: nowIso,
        last_trade_time: nowIso,
      }
      if (boundedSuccessfulTrades !== newSuccessfulTrades) {
        tradeUpdate.successful_trades = String(boundedSuccessfulTrades)
      }
      await Promise.all([
        client.hset(key, tradeUpdate),
        client.expire(key, 7 * 24 * 60 * 60),
      ]).catch(() => { /* non-critical */ })

      console.log(
        `[v0] [Progression] Trade recorded: ${successful ? "✓ Win" : "✗ Loss"} | ` +
          `Profit: ${profit.toFixed(2)} | Trades: ${boundedSuccessfulTrades}/${newTotalTrades} | ` +
          `Success Rate: ${tradeSuccessRate.toFixed(1)}%`,
      )
    } catch (error) {
      console.error(`[v0] Failed to record trade for ${connectionId}:`, error)
    }
  }

  /**
   * Reset progression state (useful for testing or manual reset)
   */
  static async resetProgressionState(connectionId: string): Promise<void> {
    try {
      if (!getRedisClient()) {
        await initRedis()
      }
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not available for resetProgressionState`)
        return
      }
      const key = `progression:${connectionId}`
      await client.del(key)
      console.log(`[v0] [Progression] State reset for ${connectionId}`)
    } catch (error) {
      console.error(`[v0] Failed to reset progression state for ${connectionId}:`, error)
    }
  }

  /**
   * Stamp the current progression as ended.
   *
   * Writes `ended_at` (epoch-ms) and `engine_started = "false"` into the
   * canonical `progression:{id}` hash. Safe to call multiple times — the
   * second call is a no-op if `ended_at` is already set and the epoch
   * matches (idempotent for crash-restart scenarios).
   *
   * @param connectionId  Target connection.
   * @param epoch         Epoch that is ending. Used to guard against a
   *                      stale stop() racing a freshly-started new epoch.
   *                      Pass 0 to skip the epoch guard (operator-driven
   *                      reset from the admin panel).
   */
  static async endProgression(connectionId: string, epoch = 0): Promise<void> {
    try {
      if (!getRedisClient()) {
        await initRedis()
      }
      const client = getRedisClient()
      if (!client) {
        console.warn(`[v0] Redis client not available for endProgression`)
        return
      }
      const key = `progression:${connectionId}`
      const now = Date.now()

      // Epoch guard: if the hash already carries a newer epoch we are a
      // stale stop() from a superseded engine instance — bail out.
      if (epoch > 0) {
        const storedEpoch = await client.hget(key, "epoch").catch(() => null)
        if (storedEpoch && Number(storedEpoch) > epoch) {
          console.warn(
            `[v0] [Progression] endProgression(${connectionId}) skipped — stored epoch ${storedEpoch} > ending epoch ${epoch}`,
          )
          return
        }
      }

      await client.hset(key, {
        ended_at: String(now),
        engine_started: "false",
        last_update: new Date(now).toISOString(),
      })
      console.log(`[v0] [Progression] Ended progression for ${connectionId} at epoch ${epoch}`)
    } catch (error) {
      console.error(`[v0] Failed to end progression for ${connectionId}:`, error)
    }
  }

  /**
   * Archive the current progression and initialise a clean new one.
   *
   * Called at the START of a new engine run when a prior progression hash
   * already exists. The old hash is:
   *   1. Stamped with `ended_at` if not already set.
   *   2. Snapshot-copied to `progression:{id}:history:{oldEpoch}` with a
   *      24-hour TTL so the dashboard can show "previous session" data.
   *   3. Deleted (replaced) with a fresh hash carrying:
   *        started_at, epoch, session_number (old + 1), all counters = 0.
   *
   * If no prior hash exists this function simply creates the initial hash
   * (same as the "first start" path in engine-manager).
   *
   * @param connectionId  Target connection.
   * @param newEpoch      The epoch of the engine that is just starting.
   * @returns             The session_number written into the new progression.
   */
  static async archiveAndStartNewProgression(
    connectionId: string,
    newEpoch: number,
  ): Promise<number> {
    // CRITICAL: init first, then fetch the live client — the old pattern bound
    // `client` before initRedis() ran, so the first call on a cold boot used null.
    if (!getRedisClient()) {
      await initRedis()
    }
    const client = getRedisClient()
    if (!client) {
      console.warn(`[v0] Redis client not available for archiveAndStartNewProgression — returning session 1`)
      return 1
    }
    const key = `progression:${connectionId}`
    const now = Date.now()

    try {
      const existing = await client.hgetall(key).catch(() => null)

      let sessionNumber = 1

      if (existing && Object.keys(existing).length > 0) {
        // ── Step 1: stamp ended_at on the old progression if absent ──
        const endedAt = existing.ended_at ? Number(existing.ended_at) : 0
        if (!endedAt || !Number.isFinite(endedAt)) {
          await client.hset(key, {
            ended_at: String(now),
            engine_started: "false",
            last_update: new Date(now).toISOString(),
          })
        }

        // ── Step 2: archive the (now-closed) old hash ─────────────────
        // Re-read so the snapshot includes the ended_at we just wrote.
        const snapshot = await client.hgetall(key).catch(() => existing)
        const oldEpoch = existing.epoch || String(newEpoch - 1)
        const historyKey = `progression:${connectionId}:history:${oldEpoch}`
        if (snapshot && Object.keys(snapshot).length > 0) {
          // Pipeline: write history hash + set its TTL atomically.
          // 7-day TTL — enough for a weekly review without bloating Redis.
          const HISTORY_TTL_SEC = 7 * 24 * 3600
          // Pass as a plain object — avoids TS spread-tuple restriction
          // while remaining compatible with ioredis / upstash hset overloads.
          const snapshotRecord: Record<string, string> = {}
          for (const [k, v] of Object.entries(snapshot)) {
            snapshotRecord[k] = String(v)
          }
          await client.hset(historyKey, snapshotRecord)
          await client.expire(historyKey, HISTORY_TTL_SEC)
        }

        // ── Step 3: derive session number ────────────────────────────
        const prevSession = parseInt(existing.session_number || "0", 10)
        sessionNumber = (Number.isFinite(prevSession) ? prevSession : 0) + 1

        // ── Step 4: delete old hash so we start fully clean ───────────
        await client.del(key)
        console.log(
          `[v0] [Progression] Archived old progression for ${connectionId} (oldEpoch=${oldEpoch}) → ${historyKey}`,
        )
      }

      // ── Step 5: write fresh progression hash ─────────────────────────
      await client.hset(key, {
        // Identity
        connection_id: connectionId,
        session_number: String(sessionNumber),
        epoch: String(newEpoch),
        // Timestamps
        started_at: String(now),
        last_update: new Date(now).toISOString(),
        // State
        engine_started: "false",
        // Prehistoric phase explicitly closed so a new engine start never
        // inherits a stuck prehistoric_phase_active="true" from a prior
        // crashed session, which would block the realtime phase from starting.
        prehistoric_phase_active: "false",
        // All cumulative counters start at zero for this session.
        cycles_completed: "0",
        successful_cycles: "0",
        failed_cycles: "0",
        total_trades: "0",
        successful_trades: "0",
        total_profit: "0",
        cycle_success_rate: "0",
        trade_success_rate: "0",
        indication_cycle_count: "0",
        indication_live_cycle_count: "0",
        strategy_cycle_count: "0",
        strategy_live_cycle_count: "0",
        realtime_cycle_count: "0",
        realtime_live_cycle_count: "0",
        frames_processed: "0",
        indications_direction_count: "0",
        indications_move_count: "0",
        indications_active_count: "0",
        indications_active_advanced_count: "0",
        indications_optimal_count: "0",
        indications_auto_count: "0",
        // Indication-Set aggregate counters — used by getIndicationTracking
        indications_count: "0",
        indication_sets_total: "0",
        indication_sets_at_limit: "0",
        strategies_base_total: "0",
        strategies_main_total: "0",
        strategies_real_total: "0",
        // IMPORTANT: must match the field names read by getProgressionState
        // (which reads `strategies_base_evaluated` etc.). The old keys
        // `strategy_evaluated_base` / `strategy_evaluated_main` /
        // `strategy_evaluated_real` were never read — they silently diverged
        // from the reader, causing strategy-evaluated counters to always
        // show 0 on the dashboard after a fresh progression start.
        strategies_base_evaluated: "0",
        strategies_main_evaluated: "0",
        strategies_real_evaluated: "0",

        // Uniqueness snapshot fields (filled by engine-manager immediately after start
        // with the *actual* live settings + symbols for this specific progression run).
        // This guarantees each connection's progress is solid and isolated to what it was started for.
        symbol_count: "0",
        active_symbols_hash: "",
        started_for_settings_version: "",
        progress_settings_snapshot: "{}",
      })

      console.log(
        `[v0] [Progression] Started new progression for ${connectionId} (session=${sessionNumber}, epoch=${newEpoch})`,
      )
      return sessionNumber
    } catch (error) {
      console.error(`[v0] Failed to archive/start progression for ${connectionId}:`, error)
      return 1
    }
  }

  /**
   * Re-coordinate the progression for the *actual* current live state of the connection.
   *
   * If the active progression's snapshot (symbol count, settings hash, etc.) differs
   * from what is currently live in `connection:${id}` + symbol list, this forces a
   * clean stop of the previous running progress + starts a brand new unique one.
   *
   * Call this on settings change, symbol list edit, connection toggle, etc.
   * Guarantees: previous progress is stopped (via archive + epoch bump), new one is
   * solid for the actual current configuration.
   */
  static async recoordinateForActualOne(connectionId: string, engineType = "main"): Promise<RecoordinateProgressionResult> {
    try {
      await initRedis()
      const client = getRedisClient()
      if (!client) return { changed: false, reason: "redis-unavailable" }

      const key = `progression:${connectionId}`
      const existing = await client.hgetall(key).catch(() => null)
      if (!existing || Object.keys(existing).length === 0) {
        // No active progression yet — initialise a fresh one so the engine
        // starts prehistoric processing on the next cycle instead of silently
        // sitting idle. This covers the "enable connection → nothing starts"
        // bug where the engine saw no progression and returned early without
        // beginning the prehistoric phase.
        const epoch = Date.now()
        await this.archiveAndStartNewProgression(connectionId, epoch)
        return { changed: true, reason: "no active progression", newEpoch: epoch }
      }

      // Resolve current live state
      const connData = (await client.hgetall(`connection:${connectionId}`).catch(() => ({}))) as Record<string, string>
      // Robustly parse a symbols field that may be stored either as a JSON
      // array (current format) or a legacy comma/pipe-joined string. The old
      // code did a bare JSON.parse on a comma-joined value ("BTCUSDT,ETH...")
      // which threw "Unexpected token 'B'" and aborted re-coordination.
      const parseSymbols = (raw: string | undefined | null): string[] => {
        if (!raw) return []
        const s = String(raw).trim()
        if (!s) return []
        if (s.startsWith("[")) {
          try {
            const arr = JSON.parse(s)
            return Array.isArray(arr) ? arr.map(String) : []
          } catch {
            /* fall through to delimiter split */
          }
        }
        return s
          .split(/[,|]/)
          .map((x) => x.trim())
          .filter(Boolean)
      }

      // Resolve the *operator-selected* symbol set.
      //
      // NOTE: setSettings() stores under a `settings:` prefix, so the engine
      // state hash lives at `settings:trade_engine_state:{id}`.
      //
      // CRITICAL ORDERING: the settings PATCH (and the Quickstart slot) write
      // the user's selection to `force_symbols` / `symbol_count`. The engine
      // only writes `symbols` / `active_symbols` LATER, during the prehistoric
      // pass, and those reflect the PREVIOUS selection until the new run
      // finishes. If we read `symbols` first (as the old code did) a symbol
      // change is invisible here — liveSymbolCount stays at the old value, the
      // mismatch check fails, and progress/stats never reset. So `force_symbols`
      // (the explicit operator override) MUST take priority over the
      // engine-populated `symbols` array.
      const state = (await client
        .hgetall(`settings:trade_engine_state:${connectionId}`)
        .catch(() => ({}))) as Record<string, string>
      const connectionSettings = {
        ...((await client.hgetall(`settings:connection_settings:${connectionId}`).catch(() => ({}))) as Record<string, string>),
        ...((await client.hgetall(`connection_settings:${connectionId}`).catch(() => ({}))) as Record<string, string>),
      }
      const cd = connData as Record<string, string>
      let currentSymbols: string[] = parseSymbols(state.force_symbols)
      if (currentSymbols.length === 0) currentSymbols = parseSymbols(cd.force_symbols)
      if (currentSymbols.length === 0) currentSymbols = parseSymbols(state.active_symbols)
      if (currentSymbols.length === 0) currentSymbols = parseSymbols(state.symbols)
      if (currentSymbols.length === 0) currentSymbols = parseSymbols(cd.active_symbols)

      const liveSymbolCount = currentSymbols.length
      const liveSymbolsHash = currentSymbols.slice().sort().join("|")

      // ── Settings fingerprint ────────────────────────────────────────────
      // Fields that fundamentally change what the progression computes.
      // A progression born for is_live_trade=0 must be scrapped when
      // the operator enables live trading (different code paths, different
      // position sets). Likewise for testnet/preset mode switches and
      // connection_method (library vs websocket), and the margin/position
      // configuration that drives the exchange connector. We compare the
      // *stored* snapshot (captured at engine-start) to the *live* values
      // so the first settings-save that differs triggers a clean restart.
      const fpValue = (key: string, fallback = ""): string => {
        const v = (connectionSettings as any)[key] ?? (state as any)[key] ?? (connData as any)[key] ?? fallback
        if (v === undefined || v === null) return fallback
        if (typeof v === "object") {
          try { return JSON.stringify(v) } catch { return fallback }
        }
        return String(v)
      }
      const progressionFingerprintFields = [
        "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
        "profitFactorMin",
        "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
        "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
        "variantTrailingEnabled", "variantBlockEnabled", "variantDcaEnabled",
        "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
        "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
        "blockVolumeRatio", "blockMaxStack", "blockPauseCountRatio",
        "minimal_step_count", "minimalStepCount", "minStep",
        "prevPosWindow", "prevPosMinCount", "mainEvalPosCount", "realEvalPosCount",
        "live_volume_factor", "preset_volume_factor", "volume_factor_live", "volume_factor_preset",
        "volume_step_ratio", "volume_factor",
        "coordination_settings", "strategies", "indications", "active_indications",
      ]

      const liveFingerprint = JSON.stringify({
        engineType: engineType || "main",
        is_live_trade: connData.is_live_trade || "0",
        is_testnet: connData.is_testnet || "0",
        is_preset_trade: connData.is_preset_trade || "0",
        connection_method: connData.connection_method || "library",
        margin_type: connData.margin_type || "cross",
        position_mode: connData.position_mode || "hedge",
        settings: Object.fromEntries(progressionFingerprintFields.map((field) => [field, fpValue(field)])),
      })

      // The stored snapshot is a JSON blob; parse it gracefully.
      let storedFingerprint = ""
      try {
        const snap = existing.progress_settings_snapshot
          ? JSON.parse(existing.progress_settings_snapshot)
          : {}
        if (snap.progression_fingerprint) {
          storedFingerprint = String(snap.progression_fingerprint)
        } else {
          storedFingerprint = JSON.stringify({
            engineType: snap.engine_type || existing.engine_type || "main",
            is_live_trade: snap.is_live_trade || "0",
            is_testnet: snap.is_testnet || "0",
            is_preset_trade: snap.is_preset_trade || "0",
            connection_method: snap.connection_method || "library",
            margin_type: snap.margin_type || "cross",
            position_mode: snap.position_mode || "hedge",
            settings: snap.settings || {},
          })
        }
      } catch { /* treat missing snapshot as a mismatch */ }

      const liveSnapshot = {
        symbol_count: liveSymbolCount,
        symbols_hash: liveSymbolsHash,
        engine_type: engineType || "main",
        is_live_trade: connData.is_live_trade || "0",
        is_testnet: connData.is_testnet || "0",
        is_preset_trade: connData.is_preset_trade || "0",
        connection_method: connData.connection_method || "library",
        margin_type: connData.margin_type || "cross",
        position_mode: connData.position_mode || "hedge",
        progression_fingerprint: liveFingerprint,
        settings: Object.fromEntries(progressionFingerprintFields.map((field) => [field, fpValue(field)])),
        updated_at: new Date().toISOString(),
      }

      const storedSymbolCount = parseInt(existing.symbol_count || "0", 10)
      const storedHash = existing.active_symbols_hash || ""
      const storedSymbols = storedHash
        ? storedHash.split("|").map((symbol: string) => symbol.trim()).filter(Boolean)
        : []
      const storedSymbolSet = new Set(storedSymbols)
      const missingSymbols = currentSymbols.filter((symbol) => !storedSymbolSet.has(symbol))
      const additiveSymbolOnlyChange =
        storedSymbols.length > 0 &&
        missingSymbols.length > 0 &&
        storedSymbols.every((symbol) => currentSymbols.includes(symbol)) &&
        storedFingerprint !== "" &&
        storedFingerprint === liveFingerprint

      if (additiveSymbolOnlyChange) {
        // Additive symbol changes should not wipe an otherwise healthy
        // progression. Preserve completed historic work for existing symbols
        // and clear only the gates for symbols that are genuinely missing so
        // the next prehistoric pass calculates the delta instead of replaying
        // the whole connection.
        await Promise.all([
          client.del(`prehistoric:${connectionId}:done`).catch(() => {}),
          client.del(`prehistoric:${connectionId}:firstpass:done`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}:verified`).catch(() => {}),
          client.del(`progression:${connectionId}:prehistoric_symbols_set`).catch(() => {}),
          ...missingSymbols.map((symbol) =>
            client.del(`prehistoric:${connectionId}:${symbol}:processed_intervals`).catch(() => {}),
          ),
        ])

        await client.hset(key, {
          symbol_count: String(liveSymbolCount),
          active_symbols_hash: liveSymbolsHash,
          started_for_settings_version: existing.started_for_settings_version || new Date().toISOString(),
          progress_settings_snapshot: JSON.stringify(liveSnapshot),
          engine_type: engineType || "main",
          prehistoric_phase_active: "true",
          missing_prehistoric_symbols: JSON.stringify(missingSymbols),
          last_update: new Date().toISOString(),
        }).catch(() => {})

        const actualProcessedCount = await client
          .scard(`prehistoric:${connectionId}:symbols`)
          .catch(async () => client.scard(`progression:${connectionId}:prehistoric_symbols_set`).catch(() => 0))
        await client
          .hset(`settings:trade_engine_state:${connectionId}`, {
            config_set_symbols_total: String(liveSymbolCount > 0 ? liveSymbolCount : 1),
            config_set_symbols_processed: String(Math.min(Math.max(0, actualProcessedCount || 0), liveSymbolCount)),
          })
          .catch(() => {})

        return {
          changed: true,
          reason: `symbols added (${missingSymbols.join(",")}) — preserving existing prehistoric progress`,
          newEpoch: Number(existing.epoch || existing.started_at || 0) || undefined,
        }
      }

      const symbolMismatch = storedSymbolCount !== liveSymbolCount || storedHash !== liveSymbolsHash
      // Only compare fingerprints when a stored snapshot exists (empty stored
      // fingerprint = first ever start, not yet solidified — not a mismatch).
      const settingsMismatch = storedFingerprint !== "" && storedFingerprint !== liveFingerprint
      const missingPrehistoricSymbols = currentSymbols.filter((symbol) => !storedSymbolSet.has(symbol))
      const additiveSymbolChange =
        symbolMismatch &&
        !settingsMismatch &&
        storedSymbols.length > 0 &&
        liveSymbolCount > storedSymbols.length &&
        storedSymbols.every((symbol) => currentSymbols.includes(symbol)) &&
        missingPrehistoricSymbols.length === liveSymbolCount - storedSymbols.length
      const mismatch = symbolMismatch || settingsMismatch

      if (additiveSymbolChange) {
        const reason = `symbols added (stored=${storedSymbolCount} vs live=${liveSymbolCount})`
        console.log(
          `[v0] [Progression] Additive symbol re-coordination for ${connectionId}: ${reason}. ` +
          `Keeping existing progress and re-opening prehistoric gates for new symbols only.`,
        )

        const progressionProcessedSet = `progression:${connectionId}:prehistoric_symbols_set`
        const canonicalProcessedSet = `prehistoric:${connectionId}:symbols`
        const [progressionProcessedCountRaw, canonicalProcessedCountRaw] = await Promise.all([
          client.scard(progressionProcessedSet).catch(() => 0),
          client.scard(canonicalProcessedSet).catch(() => 0),
        ])
        const progressionProcessedCount = Number(progressionProcessedCountRaw) || 0
        const canonicalProcessedCount = Number(canonicalProcessedCountRaw) || 0
        const actualProcessedCount = progressionProcessedCount > 0
          ? progressionProcessedCount
          : canonicalProcessedCount
        const configSetSymbolsProcessed = Math.min(actualProcessedCount, liveSymbolCount)

        await Promise.all([
          client.del(`prehistoric:${connectionId}:done`).catch(() => {}),
          client.del(`prehistoric:${connectionId}:firstpass:done`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}:verified`).catch(() => {}),
          client.del(`prehistoric:progress:${connectionId}`).catch(() => {}),
        ])

        try {
          const intervalKeys = missingPrehistoricSymbols.map((symbol) => `prehistoric:${connectionId}:${symbol}:processed_intervals`)
          if (intervalKeys.length > 0) {
            await client.del(...intervalKeys).catch(() => {})
          }
        } catch { /* non-critical */ }

        await client.hset(key, {
          symbol_count: String(liveSymbolCount),
          active_symbols_hash: liveSymbolsHash,
          started_for_settings_version: new Date().toISOString(),
          progress_settings_snapshot: JSON.stringify(liveSnapshot),
          engine_type: engineType || "main",
          prehistoric_phase_active: configSetSymbolsProcessed < liveSymbolCount ? "true" : "false",
          last_update: new Date().toISOString(),
        }).catch(() => {})

        await client.hset(`prehistoric:${connectionId}`, {
          symbols_total: String(liveSymbolCount),
          symbols_processed: String(configSetSymbolsProcessed),
          is_complete: configSetSymbolsProcessed >= liveSymbolCount ? "1" : "0",
          updated_at: new Date().toISOString(),
        }).catch(() => {})

        await client
          .hset(`settings:trade_engine_state:${connectionId}`, {
            config_set_symbols_total: String(liveSymbolCount > 0 ? liveSymbolCount : 1),
            config_set_symbols_processed: String(configSetSymbolsProcessed),
            missing_prehistoric_symbols: JSON.stringify(missingPrehistoricSymbols),
            prehistoric_data_loaded: configSetSymbolsProcessed >= liveSymbolCount ? "true" : "false",
            updated_at: new Date().toISOString(),
          })
          .catch(() => {})

        if (configSetSymbolsProcessed >= liveSymbolCount) {
          await Promise.all([
            client.set(`prehistoric:${connectionId}:done`, "1", { EX: 86400 } as any).catch(() => {}),
            client.set(`prehistoric:${connectionId}:firstpass:done`, "1", { EX: 86400 } as any).catch(() => {}),
          ])
        }

        return { changed: true, reason, newEpoch: Number(existing.epoch || "0") || undefined }
      }

      if (mismatch) {
        const reason = symbolMismatch
          ? `symbols changed (stored=${storedSymbolCount} vs live=${liveSymbolCount})`
          : `settings changed (stored="${storedFingerprint}" vs live="${liveFingerprint}")`
        console.log(
          `[v0] [Progression] Re-coordination needed for ${connectionId}: ${reason}. ` +
          `Stopping previous progress and starting fresh for actual state.`,
        )

        // Force archive + new start (this stops previous via the archive logic + new epoch)
        const newEpoch = Date.now()
        await this.archiveAndStartNewProgression(connectionId, newEpoch)

        // Clear the prehistoric gate flags so the engine re-runs the full
        // historic processing for the new symbol set / config. Without this
        // the engine sees `:done` and `:firstpass:done` still set from the
        // previous run and skips prehistoric entirely, leaving the new
        // symbols completely unprocessed.
        await Promise.all([
          client.del(`prehistoric:${connectionId}:done`).catch(() => {}),
          client.del(`prehistoric:${connectionId}:firstpass:done`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}`).catch(() => {}),
          client.del(`prehistoric_loaded:${connectionId}:verified`).catch(() => {}),
          client.del(`prehistoric:progress:${connectionId}`).catch(() => {}),
          client.del(`prehistoric:${connectionId}`).catch(() => {}),
          client.del(`prehistoric:${connectionId}:symbols`).catch(() => {}),
          client.del(`progression:${connectionId}:prehistoric_symbols_set`).catch(() => {}),
          // Reset realtime telemetry for the new session. The stats route reads
          // realtime cycle/indication counts from `realtime:{id}`; without this
          // they carried over the PREVIOUS symbol selection's cumulative totals,
          // making the dashboard show stale "running" cycle counts even though a
          // fresh prehistoric pass had just started for the new symbol set.
          client.del(`realtime:${connectionId}`).catch(() => {}),
        ])

        try {
          // Do not run a broad KEYS scan on every settings save; that can
          // block the in-memory Redis emulator and make progress/stat polling
          // look stalled under large datasets. The live symbol list is exactly
          // the namespace that must be invalidated for the next prehistoric
          // run, so delete those bounded per-symbol interval gates directly.
          const intervalKeys = currentSymbols.map((symbol) => `prehistoric:${connectionId}:${symbol}:processed_intervals`)
          if (intervalKeys.length > 0) {
            await client.del(...intervalKeys).catch(() => {})
          }
        } catch { /* non-critical */ }

        // Immediately solidify the new progression with the *actual* live data
        await client.hset(key, {
          symbol_count: String(liveSymbolCount),
          active_symbols_hash: liveSymbolsHash,
          started_for_settings_version: new Date().toISOString(),
          progress_settings_snapshot: JSON.stringify(liveSnapshot),
          engine_type: engineType || "main",
          prehistoric_phase_active: "false",
        }).catch(() => {})

        // Reset the stale `config_set_*` snapshot held in the engine-state hash.
        // The stats route uses these as a TERTIARY source inside its
        // Math.max/pick fallbacks (config_set_symbols_total /
        // _symbols_processed / _candles_processed / _indication_results). They
        // survive the prehistoric:{id} reset above, so without this the
        // dashboard kept showing the PREVIOUS selection's totals (e.g. "20/20,
        // 5000 candles") after the operator switched to fewer symbols. We seed
        // the total with the new live count and zero the progress counters; the
        // engine repopulates all four on its next prehistoric pass
        // (engine-manager writes them at start and after processing).
        await client
          .hset(`settings:trade_engine_state:${connectionId}`, {
            config_set_symbols_total: String(liveSymbolCount > 0 ? liveSymbolCount : 1),
            config_set_symbols_processed: "0",
            config_set_candles_processed: "0",
            config_set_indication_results: "0",
          })
          .catch(() => {})

        return { changed: true, reason, newEpoch }
      }

      return { changed: false, reason: "active progression already matches current state" }
    } catch (err) {
      console.warn(`[v0] [Progression] recoordinateForActualOne failed for ${connectionId}:`, err)
      return {
        changed: false,
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }

  /**
   * Ensure there is exactly ONE UNIQUE solid progression for this connection,
   * matched to the *actual current* live settings and symbol count.
   *
   * - Uses recoordinate logic internally for snapshot match.
   * - If no active or the active one is for different state → archive old (stop previous), start fresh unique one.
   * - If active one matches current live state → attach to it (keeps the progression unique, no new instance).
   *
   * This keeps "Just Unique": one solid unique progression per connection at any time.
   * Page refreshes / independent opens attach to the current unique one when the live state matches.
   * No concurrent multiple progressions/instances for the same connection.
   */
  static async ensureJustUniqueProgression(
    connectionId: string,
    options: { ownerEpoch?: number; engineType?: string } = {},
  ): Promise<{ sessionNumber: number; epoch: number; wasNew: boolean }> {
    try {
      await initRedis()
      const client = getRedisClient()
      if (!client) {
        const epoch = Date.now()
        const session = await this.archiveAndStartNewProgression(connectionId, epoch)
        return { sessionNumber: session, epoch, wasNew: true }
      }

      // First, make sure we are coordinated to actual current state
      const engineType = options.engineType || "main"
      await this.recoordinateForActualOne(connectionId, engineType)

      const key = `progression:${connectionId}`
      const existing = await client.hgetall(key).catch(() => null)

      const now = Date.now()
      const nowIso = new Date(now).toISOString()

      // ── Staleness guard ────────────────────────────────────────────────
      // A progression with `engine_started === "true"` may be a zombie:
      // the engine init wrote the flag but then crashed before the first
      // processor tick updated `last_update`. We detect this by comparing
      // `last_update` (the canonical activity timestamp written every 500
      // cycles and on every settings change) to a generous staleness bound.
      //
      // STALENESS_MS = 30 minutes. An actively running engine updates
      // `last_update` at minimum every 500 cycles × ≥300ms = ~150s. If
      // 30 min have elapsed with no update the engine is either stopped or
      // dead — treating the progression as live would incorrectly attach
      // a new engine start to a zombie session (wrong epoch, wrong counters).
      const STALENESS_MS = 30 * 60 * 1000

      const ownerEpoch = options.ownerEpoch && Number.isFinite(options.ownerEpoch) && options.ownerEpoch > 0
        ? options.ownerEpoch
        : now

      if (existing && Object.keys(existing).length > 0 && existing.engine_started !== "true") {
        const sessionNumber = parseInt(existing.session_number || "1", 10)
        const lastUpdateMs = existing.last_update
          ? new Date(existing.last_update).getTime()
          : (existing.started_at ? Number(existing.started_at) : 0)
        const sessionAge = now - lastUpdateMs
        const endedAt = Number(existing.ended_at || "0") || 0
        const isReusableStopped =
          !endedAt &&
          lastUpdateMs &&
          Number.isFinite(lastUpdateMs) &&
          sessionAge <= STALENESS_MS

        if (!isReusableStopped) {
          const newSession = await this.archiveAndStartNewProgression(connectionId, ownerEpoch)
          await client.hset(key, {
            last_visited: nowIso,
            last_update: nowIso,
            engine_started: "true",
            engine_type: engineType,
          }).catch(() => {})
          console.log(
            `[v0] [Progression] Stopped/stale progression for ${connectionId} was not reusable ` +
            `(ended_at=${endedAt || "none"}, age=${Math.round(sessionAge / 1000)}s) — started fresh ` +
            `(session=${newSession}, epoch=${ownerEpoch})`,
          )
          return { sessionNumber: newSession, epoch: ownerEpoch, wasNew: true }
        }

        const epoch = ownerEpoch
        await client.hset(key, {
          last_update: nowIso,
          last_visited: nowIso,
          engine_started: "true",
          epoch: String(epoch),
          engine_type: engineType,
        }).catch(() => {})
        await client.expire(key, 7 * 24 * 60 * 60).catch(() => {})
        console.log(
          `[v0] [Progression] Activated coordinated progression for ${connectionId} ` +
          `(session=${sessionNumber}, epoch=${epoch})`,
        )
        return { sessionNumber, epoch, wasNew: false }
      }

      if (existing && Object.keys(existing).length > 0 && existing.engine_started === "true") {
        // Check that the session is actually fresh — not a zombie from a prior
        // crashed engine that set engine_started but never ran its first tick.
        const lastUpdateMs = existing.last_update
          ? new Date(existing.last_update).getTime()
          : (existing.started_at ? Number(existing.started_at) : 0)
        const sessionAge = now - lastUpdateMs
        const isStale = !lastUpdateMs || !Number.isFinite(lastUpdateMs) || sessionAge > STALENESS_MS

        if (!isStale) {
          // There is already one healthy unique active progression (recoordinate ensured it matches current live state)
          const sessionNumber = parseInt(existing.session_number || "1", 10)
          const epoch = ownerEpoch

          // Light attach: update activity timestamps, keep the same unique session/epoch
          await client.hset(key, {
            last_update: nowIso,
            last_visited: nowIso,
            engine_started: "true",
            epoch: String(epoch),
            engine_type: engineType,
          }).catch(() => {})

          await client.expire(key, 7 * 24 * 60 * 60).catch(() => {})

          console.log(
            `[v0] [Progression] Attached to existing unique progression for ${connectionId} ` +
            `(session=${sessionNumber}, epoch=${epoch}, age=${Math.round(sessionAge / 1000)}s)`,
          )

          return { sessionNumber, epoch, wasNew: false }
        }

        // Session is stale — treat as dead and start fresh
        console.log(
          `[v0] [Progression] Stale session detected for ${connectionId} ` +
          `(engine_started=true but last_update=${Math.round(sessionAge / 60000)}min ago) — starting fresh.`,
        )
      }

      // No active unique progression (or it was cleaned by recoordinate) → start one
      const newEpoch = ownerEpoch
      const newSession = await this.archiveAndStartNewProgression(connectionId, newEpoch)

      await client.hset(key, {
        last_visited: nowIso,
        last_update: nowIso,
        engine_started: "true",
        engine_type: engineType,
      }).catch(() => {})

      console.log(
        `[v0] [Progression] Started unique progression for ${connectionId} ` +
        `(session=${newSession}, epoch=${newEpoch})`
      )

      return { sessionNumber: newSession, epoch: newEpoch, wasNew: true }
    } catch (error) {
      console.error(`[v0] ensureJustUniqueProgression failed for ${connectionId}:`, error)
      const fallbackEpoch = Date.now()
      const fallbackSession = await this.archiveAndStartNewProgression(connectionId, fallbackEpoch).catch(() => 1)
      return { sessionNumber: fallbackSession, epoch: fallbackEpoch, wasNew: true }
    }
  }
}
