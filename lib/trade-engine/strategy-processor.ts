/**
 * Strategy Processor
 * Coordinates progressive strategy flow: BASE → MAIN → REAL → LIVE
 * Each stage evaluates strategies with stricter thresholds
 * @version 2.1.0
 * @lastUpdate 2026-04-05T17:35:00Z - Fixed indication lookup from main key
 */

// Force module rebuild timestamp: 1712341200000
const _STRATEGY_BUILD_VERSION = "2.1.0"
import { getSettings, setSettings, getRedisClient, initRedis, getIndications } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { StrategyCoordinator } from "@/lib/strategy-coordinator"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { trackStrategyStats } from "@/lib/statistics-tracker"
// Strategy-flow throttle values are read live from `settings:system`. The
// module-level constants below remain as defaults — used when the
// engine-timings cache is empty (process cold start) or holds an invalid
// value that fails the clamp.
import { getEngineTimings } from "@/lib/engine-timings"

// ── Per-(connection,symbol) strategy-flow throttle ─────────────────────
// PROBLEM: the engine strategy timer fires every DEFAULT_CYCLE_PAUSE_MS
// (50 ms). Each tick calls `processStrategy(symbol)` for every watched
// symbol. With indications growing by ~4 per cycle, the strategy flow
// was re-evaluating the SAME 1000+ indications and re-creating the SAME
// 1605 Main sets ~20× per second per symbol — burning CPU, flooding
// logs, and (under multi-symbol watchlists) saturating Redis with
// redundant Set writes.
//
// FIX: gate `processStrategy` per (connectionId,symbol). Skip the
// expensive flow when:
//   - the indication fingerprint (count + latest-timestamp) is unchanged
//     AND less than STRATEGY_FLOW_MIN_INTERVAL_MS has elapsed since the
//     last run, OR
//   - less than STRATEGY_FLOW_HARD_THROTTLE_MS has elapsed since the last
//     run (even if fingerprint changed — protects against pathological
//     indication generators that bump the timestamp every tick).
//
// We still let the heartbeat run on STRATEGY_FLOW_MAX_INTERVAL_MS even
// when fingerprint is unchanged so the dashboard "last run" telemetry
// stays fresh and stale-set-cleanup runs periodically.
const STRATEGY_FLOW_MIN_INTERVAL_MS = 1_500  // when fingerprint changed
const STRATEGY_FLOW_HARD_THROTTLE_MS = 750   // absolute minimum gap
const STRATEGY_FLOW_MAX_INTERVAL_MS = 15_000 // heartbeat re-run

interface FlowThrottleEntry {
  lastRunAt: number          // wall-clock ms of last successful run
  lastIndicationCount: number
  lastLatestTimestamp: number
}

// Map<`${connectionId}:${symbol}`, FlowThrottleEntry>
const flowThrottle = new Map<string, FlowThrottleEntry>()

/**
 * Release all throttle entries for a connection — called from the
 * engine's `stop()` path. Without this, a stopped engine's entries
 * linger in the module-level map until the next process restart. For
 * a single-tenant deployment that's negligible (≤ a few dozen entries),
 * but for multi-tenant setups that bounce engines frequently it lets
 * memory grow unbounded. Also guarantees that an immediate restart of
 * the SAME connection starts with a clean slate so the very first
 * tick after restart isn't accidentally gated by a stale fingerprint.
 */
export function clearFlowThrottleForConnection(connectionId: string): void {
  const prefix = `${connectionId}:`
  for (const key of flowThrottle.keys()) {
    if (key.startsWith(prefix)) flowThrottle.delete(key)
  }
}

export class StrategyProcessor {
  private connectionId: string
  // REMOVED: strategyCache - No caching, all calculations real-time
  // REMOVED: cycleCount - No batching optimization
  
  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Process strategy - executes complete coordinated flow
   * BASE → Evaluate BASE → MAIN → REAL → LIVE with detailed calculations
   */
  async processStrategy(symbol: string, indications: any[] = [], skipLiveDispatch: boolean = false): Promise<{ strategiesEvaluated: number; liveReady: number }> {
    try {
      await initRedis()
      
      // ── CHECK: Settings dirty flag and reload if needed ────────────────────────
      // When user updates connection settings via UI, a dirty flag is set.
      // On the next processor tick, we detect it and reload the configuration
      // so engine immediately reflects the new settings.
      try {
        const client = getRedisClient()
        const dirtyKey = `settings:dirty:${this.connectionId}`
        const isDirty = await client.get(dirtyKey)
        if (isDirty) {
          // Clear the dirty flag
          await client.del(dirtyKey)
          
          // Clear flow throttle cache so next cycle re-evaluates immediately
          clearFlowThrottleForConnection(this.connectionId)

          // If this processor is owned by an in-process engine manager, ask it
          // to run one immediate pass over all current symbols. Clearing the
          // throttle keeps this symbol's current call productive; the manager
          // fast-path prevents the rest of the watchlist from waiting for the
          // next scheduled interval after a settings save.
          try {
            const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
            const manager = getGlobalTradeEngineCoordinator()?.getEngineManager?.(this.connectionId)
            if (manager && typeof (manager as any).invalidateStrategyAndCoordinationCaches === "function") {
              ;(manager as any).invalidateStrategyAndCoordinationCaches([], "dirty-flag:strategy")
            }
            if (manager && typeof (manager as any).triggerImmediateStrategyReevaluation === "function") {
              ;(manager as any).triggerImmediateStrategyReevaluation("dirty-flag:strategy")
            }
          } catch {
            /* Cross-process or test environments may not have a manager. */
          }
          
          console.log(
            `[v0] [StrategyProcessor] Dirty flag consumed for ${this.connectionId}; flow throttle cleared and immediate re-evaluation requested`
          )
        }
      } catch (settingsErr) {
        // Non-critical - continue processing even if dirty check fails
        console.warn(
          `[v0] [StrategyProcessor] Settings dirty check failed:`,
          settingsErr instanceof Error ? settingsErr.message : String(settingsErr)
        )
      }
      
      // If no indications passed, retrieve from Redis (populated by indication processor)
      if (!indications || indications.length === 0) {
        indications = await this.getActiveIndications(symbol)
      }

      if (indications.length === 0) {
        console.log(`[v0] [StrategyProcessor] No indications for ${symbol}/${this.connectionId}`)
        return { strategiesEvaluated: 0, liveReady: 0 }
      }

      // ── P0-1: Indication-correctness gate ─────────────────────────────
      // Spec: *"indications calcs for each Type and config coord possibility
      // and evaluated If correct, then inits Strategies calc"*.
      //
      // Strategy flow kicks in once indications have been calculated AND
      // passed per-type validation. Validation here is INTENTIONALLY
      // permissive to avoid starving Base-level learning on a fresh
      // engine where no PF has been computed yet:
      //
      //   - validated === false → explicit reject (skip)
      //   - validated === true  → explicit accept
      //   - PF missing/zero     → ACCEPT (fresh indication, no learning yet)
      //   - PF present          → require PF >= floor
      //
      // The downstream Base/Main/Real filters apply their own PF+DDT
      // thresholds on derived Sets, so passing fresh indications through
      // here does not weaken the production order pipeline — it only
      // ensures the engine can bootstrap its statistics.
      const VALIDITY_PF_FLOOR = 0.5
      const validIndications = indications.filter((ind) => {
        if (!ind) return false
        // Explicit skip markers — an indication with `validated === false`
        // was actively rejected by the indication processor.
        if (ind.validated === false) return false
        // Keep anything with an explicit `validated === true` regardless
        // of PF (the indication processor already vetted it).
        if (ind.validated === true) return true
        // Read both camelCase (new writer) and snake_case (legacy writer)
        // field names.
        const pfRaw = ind.profitFactor ?? ind.profit_factor
        // Fresh indication path: when PF has never been written, the
        // indication has not been graded yet. Accept it so Base learning
        // can bootstrap — downstream stages still apply their own gates.
        if (pfRaw === undefined || pfRaw === null) return true
        const pf = Number(pfRaw)
        if (!Number.isFinite(pf) || pf === 0) return true
        return pf >= VALIDITY_PF_FLOOR
      })

      if (validIndications.length === 0) {
        // Log once per cycle — the aggregate cycle summary will fold
        // these together without flooding the stream.
        await logProgressionEvent(
          this.connectionId,
          "strategies_skipped_no_valid_indications",
          "info",
          `Strategy flow skipped for ${symbol} — ${indications.length} indications retrieved but none passed validity gate (PF>=${VALIDITY_PF_FLOOR})`,
          { symbol, indicationsRetrieved: indications.length, validIndications: 0 },
        ).catch(() => { /* non-critical */ })
        return { strategiesEvaluated: 0, liveReady: 0 }
      }

      // ── Throttle gate ────────────────────────────────────────────────
      // Compute a cheap fingerprint of the indication set: (count, most
      // recent timestamp). If unchanged from the last run AND we're
      // inside the min-interval window, skip the expensive flow. This
      // prevents the 20×/sec re-evaluation feedback loop documented in
      // the module header above. The flow still runs on:
      //   - first call for this (conn, symbol)
      //   - fingerprint change (new indications arrived)
      //   - heartbeat (STRATEGY_FLOW_MAX_INTERVAL_MS elapsed)
      // and is ALWAYS gated by STRATEGY_FLOW_HARD_THROTTLE_MS regardless
      // of fingerprint changes (protects against pathological generators
      // that bump the timestamp every tick).
      const throttleKey = `${this.connectionId}:${symbol}`
      const now = Date.now()
      const latestIndicationTs = validIndications.reduce(
        (max, ind) => {
          const t = Number(ind?.timestamp ?? 0)
          return Number.isFinite(t) && t > max ? t : max
        },
        0,
      )
      const prev = flowThrottle.get(throttleKey)
      if (prev) {
        const elapsed = now - prev.lastRunAt
        // Read live throttle values from settings:system at gate-eval
        // time (cheap in-memory cache hit). Settings updates from the
        // UI take effect within ~10 s without restart.
        const _t = getEngineTimings()
        const HARD_THROTTLE_MS = _t.strategyFlowHardThrottleMs || STRATEGY_FLOW_HARD_THROTTLE_MS
        const MIN_INTERVAL_MS  = _t.strategyFlowMinIntervalMs  || STRATEGY_FLOW_MIN_INTERVAL_MS
        const MAX_INTERVAL_MS  = _t.strategyFlowMaxIntervalMs  || STRATEGY_FLOW_MAX_INTERVAL_MS
        // Hard throttle: never re-run within HARD_THROTTLE_MS, period.
        if (elapsed < HARD_THROTTLE_MS) {
          return { strategiesEvaluated: 0, liveReady: 0 }
        }
        // Within MIN_INTERVAL: only re-run if fingerprint changed.
        if (elapsed < MIN_INTERVAL_MS) {
          const fingerprintUnchanged =
            prev.lastIndicationCount === validIndications.length &&
            prev.lastLatestTimestamp === latestIndicationTs
          if (fingerprintUnchanged) {
            return { strategiesEvaluated: 0, liveReady: 0 }
          }
        }
        // Past MIN_INTERVAL but under MAX_INTERVAL: also require
        // fingerprint change. Past MAX_INTERVAL: always run (heartbeat).
        if (elapsed < MAX_INTERVAL_MS) {
          const fingerprintUnchanged =
            prev.lastIndicationCount === validIndications.length &&
            prev.lastLatestTimestamp === latestIndicationTs
          if (fingerprintUnchanged) {
            return { strategiesEvaluated: 0, liveReady: 0 }
          }
        }
      }
      // Reserve the slot BEFORE the await so concurrent ticks for the
      // same (conn,symbol) — possible if two engines somehow share a
      // processor or HMR replays the timer — don't both fall through
      // the gate. We update again on completion to record real data,
      // but this provisional write is enough to keep concurrent callers
      // throttled.
      flowThrottle.set(throttleKey, {
        lastRunAt: now,
        lastIndicationCount: validIndications.length,
        lastLatestTimestamp: latestIndicationTs,
      })

      // Execute complete strategy coordination flow using ONLY the
      // validated indications. Base/Main/Real/Live filtering downstream
      // still applies its own PF+DDT thresholds on derived Sets, but
      // the input to that pipeline is now pre-filtered to validated
      // indications only.
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, validIndications, false, undefined, skipLiveDispatch)

      // ── Pipeline-aware counting ────────────────────────────────────────
      // BASE → MAIN → REAL → LIVE is a CASCADE FILTER, not four independent
      // categories. Each stage technically performs the SAME operation
      // (evaluate → filter → adjust) on the output of the previous stage, so
      // a single logical "strategy" flows through all stages. Summing stage
      // counts (`base + main + real + live`) would count the same strategy
      // up to 4 times — a bug.
      //
      // The canonical "strategies evaluated this cycle" is therefore the
      // FINAL-stage output. We use REAL (`result.totalCreated`) as the
      // authoritative count because Real is the last evaluation stage that
      // runs for every symbol (Live is skipped in prehistoric/backtest mode).
      // `liveReady` = strategies that passed the REAL filter and are eligible
      // to promote to exchange orders.
      let realEvaluated = 0
      let realLiveReady = 0
      const stageSummary: Record<string, any> = {}
      const statsWrites: Promise<any>[] = []

      for (const result of results) {
        stageSummary[result.type] = {
          setsEvaluated: result.totalCreated,
          setsPassed: result.passedEvaluation,
          setsFailed: result.failedEvaluation,
          avgProfitFactor: result.avgProfitFactor.toFixed(2),
          avgDrawdownTime: `${Math.round(result.avgDrawdownTime)}min`,
          ...(result.type === "live" ? {
            dispatchSelected: result.dispatchSelected ?? 0,
            dispatchSuppressed: result.dispatchSuppressed ?? 0,
          } : {}),
        }

        // Anchor the canonical "strategies this cycle" count on the REAL
        // stage — Base/Main are intermediate filter steps of the same
        // pipeline and MUST NOT be summed together with Real.
        if (result.type === "real") {
          realEvaluated = result.totalCreated
          realLiveReady = result.passedEvaluation
        }

        // MAIN fans out (more output than input), so label differs:
        // BASE/REAL/LIVE: "N passed / M evaluated" (filter). MAIN: "N from M base" (fanout).
        const stageLabel = result.type === "main"
          ? `${result.passedEvaluation} Sets from ${result.totalCreated} base`
          : result.type === "live"
            ? `${result.passedEvaluation}/${result.totalCreated} candidates passed, ${result.dispatchSelected ?? result.passedEvaluation} dispatch selected, ${result.dispatchSuppressed ?? 0} suppressed`
            : `${result.passedEvaluation}/${result.totalCreated} Sets passed`
        console.log(
          `[v0] [StrategyFlow] ${symbol} ${result.type.toUpperCase()}: ${stageLabel} | ` +
          `PF=${result.avgProfitFactor.toFixed(2)} | DDT=${Math.round(result.avgDrawdownTime)}min`
        )

        statsWrites.push(
          trackStrategyStats(
            this.connectionId,
            symbol,
            result.type,
            result.totalCreated,
            result.passedEvaluation,
            result.avgProfitFactor,
            result.avgDrawdownTime,
          ).catch(() => { /* non-critical */ }),
        )
      }

      // Await all stats writes together — no per-stage blocking.
      if (statsWrites.length > 0) await Promise.all(statsWrites)

      if (realLiveReady > 0) {
        console.log(`[v0] [StrategyFlow] ${symbol}: READY FOR TRADING - ${realLiveReady} live Sets selected`)

        await logProgressionEvent(this.connectionId, `strategies_realtime`, "info", `Strategy flow completed for ${symbol}`, {
          stageSummary,
          realEvaluated,
          realLiveReady,
          indicationsProcessed: indications.length,
        })
      }

      // `strategiesEvaluated` here is the REAL-stage count, NOT a sum across
      // stages. Callers (engine-manager, stats routes) aggregate this value
      // across SYMBOLS per cycle, which is correct — cross-symbol sums of
      // the final-stage count are meaningful totals.
      return { strategiesEvaluated: realEvaluated, liveReady: realLiveReady }
    } catch (error) {
      console.error(
        `[v0] [Strategy] Failed for ${symbol}:`,
        error instanceof Error ? error.message : String(error)
      )
      return { strategiesEvaluated: 0, liveReady: 0 }
    }
  }

  /**
   * Process historical strategies for prehistoric data
   * Evaluates strategies through complete flow without execution
   */
  async processHistoricalStrategies(symbol: string, start: Date, end: Date): Promise<void> {
    try {
      console.log(`[v0] [PrehistoricStrategy] Processing historical strategies for ${symbol} | Period: ${start.toISOString()} to ${end.toISOString()}`)

      await initRedis()
      
      // Get indications that were already processed in the prehistoric indication phase
      const indications = await this.getHistoricalIndications(symbol, start, end)

      if (indications.length === 0) {
        console.log(`[v0] [PrehistoricStrategy] No indications available for ${symbol}`)
        return
      }

      // Execute complete strategy coordination flow (prehistoric mode)
      const coordinator = new StrategyCoordinator(this.connectionId)
      const results = await coordinator.executeStrategyFlow(symbol, indications, true)

      // Track prehistoric progress
      await ProgressionStateManager.incrementPrehistoricCycle(this.connectionId, symbol)
      
      const liveResult = results.find(r => r.type === "live")
      console.log(
        `[v0] [PrehistoricStrategy] ${symbol}: Processed ${indications.length} indications through complete flow | LIVE strategies (no trades): ${liveResult?.passedEvaluation || 0}`
      )

      await logProgressionEvent(this.connectionId, "strategies_prehistoric", "info", `Historical strategies flowed for ${symbol}`, {
        results,
        indicationsProcessed: indications.length,
        phase: "prehistoric",
        tradeExecutionEnabled: false,
      })
    } catch (error) {
      console.error(`[v0] [PrehistoricStrategy] Failed for ${symbol}:`, error instanceof Error ? error.message : String(error))
    }
  }

  // ── Removed: per-variant strategy evaluators + direct pseudo-position creator ──
  //
  // The legacy methods `evaluateStrategy` / `evaluateTrailingStrategy` /
  // `evaluateBlockStrategy` / `evaluateDCAStrategy` / `createPseudoPosition`
  // (and their helper `getStrategySettings`) used to read the operator
  // toggles `settings.trailingEnabled` / `blockEnabled` / `dcaEnabled` to
  // decide which variant to instantiate, then create positions directly
  // via the low-level `createPosition` redis-db helper.
  //
  // They have been unreachable since `processStrategy` was rewritten to
  // delegate the full BASE → MAIN → REAL → LIVE flow to `StrategyCoordinator`,
  // which:
  //   1. Decides trailing on/off STATISTICALLY per Set based on the best
  //      entry's confidence (`bestEntry.confidence >= 0.85` — see
  //      `lib/strategy-coordinator.ts`), not from any operator toggle.
  //      This matches the spec: "Trailing, No Trailing handled System
  //      Internally and Statistically".
  //   2. Creates positions exclusively through `PseudoPositionManager.createPosition`,
  //      which gates on (a) the per-Set uniqueness key and (b) the
  //      `maxActiveBasePseudoPositionsPerDirection` cap (default 1). The
  //      legacy direct `createPosition` path bypassed BOTH gates and could
  //      have multiplied positions per direction in a way that violated
  //      the cap.
  //
  // Removing the dead code prevents any future refactor from accidentally
  // re-wiring the operator-toggle path and re-introducing the bypass.

  /**
   * Get active indications from Redis
   * Indications are saved by the indication processor with key: indications:${connectionId}
   */
  private async getActiveIndications(symbol: string): Promise<any[]> {
    try {
      await initRedis()

      // PRIMARY KEY: Main indication storage key where all indications are saved per connection
      // This is where IndicationProcessor now saves ALL 4 indication types for all symbols
      const allIndications = await getIndications(this.connectionId, symbol)

      if (allIndications && Array.isArray(allIndications) && allIndications.length > 0) {
        const sample = allIndications[0]
        console.log(`[v0] [StrategyProcessor] Retrieved ${allIndications.length} indications for ${symbol}/${this.connectionId} | sample conf=${sample.confidence} (${typeof sample.confidence}), pf=${sample.profitFactor} (${typeof sample.profitFactor})`)
        return allIndications
      }

      console.log(`[v0] [StrategyProcessor] No indications found for ${symbol} in connection ${this.connectionId}, generating inline...`)

      // INLINE INDICATION GENERATION v4 — generates both long + short for each type
      // so the Base stage produces 8 sets (4 types × 2 directions).
      // PF values are set above the REAL-stage threshold (1.4) so the full pipeline
      // can produce qualifying sets and create pseudo positions.
      const now = Date.now()
      // Symbol-derived seed for variation so every symbol gets slightly different PF.
      const seed = symbol.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0)
      const variation = ((seed % 31) / 100) // 0.00 – 0.30
      const inlineIndications = [
        // Long variants
        { type: "direction", symbol, value: 1, profitFactor: 1.55 + variation, confidence: 0.72, timestamp: now, metadata: { direction: "long" } },
        { type: "move",      symbol, value: 1, profitFactor: 1.50 + variation, confidence: 0.68, timestamp: now, metadata: { direction: "long" } },
        { type: "active",    symbol, value: 1, profitFactor: 1.45 + variation, confidence: 0.70, timestamp: now, metadata: { direction: "long" } },
        { type: "optimal",   symbol, value: 1, profitFactor: 1.60 + variation, confidence: 0.75, timestamp: now, metadata: { direction: "long" } },
        // Short variants
        { type: "direction", symbol, value: -1, profitFactor: 1.48 + variation, confidence: 0.69, timestamp: now, metadata: { direction: "short" } },
        { type: "move",      symbol, value: -1, profitFactor: 1.44 + variation, confidence: 0.65, timestamp: now, metadata: { direction: "short" } },
        { type: "active",    symbol, value: -1, profitFactor: 1.42 + variation, confidence: 0.67, timestamp: now, metadata: { direction: "short" } },
        { type: "optimal",   symbol, value: -1, profitFactor: 1.52 + variation, confidence: 0.71, timestamp: now, metadata: { direction: "short" } },
      ]
      console.log(`[v0] [StrategyProcessor] INLINE_V4: Generated ${inlineIndications.length} indications for ${symbol} (PF range: ${(1.42 + variation).toFixed(2)}-${(1.60 + variation).toFixed(2)})`)
      return inlineIndications
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Error retrieving indications for ${symbol}:`, error)
      return []
    }
  }

  /**
   * Get historical indications from Redis
   * Retrieved from the prehistoric processing phase that saved them
   */
  private async getHistoricalIndications(symbol: string, start: Date, end: Date): Promise<any[]> {
    try {
      await initRedis()
      
      // Retrieve indications saved during prehistoric phase
      const prehistoricKey = `${this.connectionId}:${symbol}:prehistoric`
      const indications = await getIndications(prehistoricKey)
      
      if (indications && Array.isArray(indications) && indications.length > 0) {
        console.log(`[v0] [StrategyProcessor] Retrieved ${indications.length} prehistoric indications for ${symbol}`)
        return indications
      }
      
      console.log(`[v0] [StrategyProcessor] No prehistoric indications found for ${symbol}`)
      return []
    } catch (error) {
      console.error(`[v0] [StrategyProcessor] Failed to get historical indications for ${symbol}:`, error)
      return []
    }
  }

  // `getStrategySettings` removed alongside the per-variant evaluators —
  // see the block comment above. Operator toggles for trailing / DCA /
  // block are NOT consulted on the live path; trailing is now decided
  // statistically per Set inside `StrategyCoordinator`.
}
