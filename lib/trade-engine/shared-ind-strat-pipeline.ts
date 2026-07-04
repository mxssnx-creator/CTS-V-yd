/**
 * Shared Indication + Strategy Pipeline
 *
 * ── The single canonical inner pipeline used by BOTH the Prehistoric
 *    Progression and the Realtime Progression. ──
 *
 * Per the architectural spec:
 *
 *   "indications and strategies processings are in the same intervalled
 *    progress … indications and strategies progress is unique for both
 *    prehistoric and realtime (it processes through)."
 *
 * The two callers share IDENTICAL indication-derivation and strategy
 * code paths. The only behavioural difference is the `asOfMs` parameter
 * threaded through `processIndication`:
 *
 *   asOfMs === undefined  → Realtime mode. processIndication evaluates
 *                           the latest live candle in Redis hot keys
 *                           and stamps indications at wall-clock now.
 *                           Phase 2 marks live pseudo positions to the
 *                           current price.
 *
 *   asOfMs === number     → Replay mode. processIndication slices the
 *                           loaded candle history to <= asOfMs, treats
 *                           the tail candle as the simulated "current"
 *                           bar, and stamps indications at asOfMs. The
 *                           shared `indication_set:*` keyspace is
 *                           filled with the simulated bar. Phase 2 is
 *                           SKIPPED — backdated candles must never trip
 *                           TP/SL on live pseudo positions.
 *
 * ── Phase order per symbol per cycle ──────────────────────────────────
 *   Phase 1   processIndication(symbol, asOfMs?)            (both modes)
 *   Phase 1b  setsProcessor.processAllIndicationSets         (replay)
 *   Phase 2   updateOpenPseudoPositionsForSymbol            (realtime)
 *   Phase 3   processStrategy(symbol, indications)          (both modes,
 *             gated on indicationCount > 0)
 *
 * ── Coordination guarantees ───────────────────────────────────────────
 * Independent timers; a slow prehistoric cycle never blocks realtime.
 * Set keyspace `indication_set:{connId}:{symbol}:{type}:{cfg}` is SHARED:
 * Prehistoric writes (per replay step), Realtime reads (per live tick).
 * `processAllIndicationSets` is idempotent per `(symbol, candle.timestamp)`
 * so overlapping replay ranges across cycles are cheap and safe.
 */

import { IndicationProcessor } from "./indication-processor-fixed"
import { StrategyProcessor } from "./strategy-processor"
import type { RealtimeProcessor } from "./realtime-processor"
import { IndicationSetsProcessor } from "@/lib/indication-sets-processor"

export type PipelineMode = "historical" | "realtime"

export interface PipelineCycleResult {
  symbol: string
  mode: PipelineMode
  asOfMs?: number
  indicationCount: number
  indicationTypeCounts: Record<string, number>
  pseudoUpdates: number
  strategiesEvaluated: number
  liveReady: number
  durationMs: number
  error?: string
}

export interface PipelineDeps {
  indication: IndicationProcessor
  strategy: StrategyProcessor
  realtime: RealtimeProcessor
  /**
   * Replay-mode anchors (both required together for replay mode):
   *   asOfMs    — simulated wall-clock for this step (= candle.timestamp).
   *   asOfCandle — the candle object at that timestamp; passed straight
   *                into `processAllIndicationSets` so Sets-fill uses the
   *                exact same bar processIndication's slice tail sees.
   *   setsProcessor — optional shared IndicationSetsProcessor; the
   *                prehistoric tick allocates one per cycle and reuses
   *                it across all replay steps to avoid per-step churn.
   */
  asOfMs?: number
  asOfCandle?: any
  setsProcessor?: IndicationSetsProcessor
  skipLiveDispatch?: boolean
  enableStrategyFlow?: boolean
}

// ── Lazy-import cache for Phase 4 live-order path ───────────────────
// `executeReadyStrategiesAsLiveOrders` is the heavy Phase 4 that only
// fires when liveReady > 0 (typically < 10% of cycles). We still want
// dynamic imports so the 90% of ticks that don't enter Phase 4 pay
// nothing, but we memoize at module level so the 10% that DO enter
// resolve each import exactly once per process.
let __liveExecExports: {
  getConnection: any
  createExchangeConnector: any
} | null = null
async function __ensureLiveExecExports() {
  if (!__liveExecExports) {
    const [redisDb, connMod] = await Promise.all([
      import("@/lib/redis-db"),
      import("@/lib/exchange-connectors"),
    ])
    __liveExecExports = {
      getConnection: redisDb.getConnection,
      createExchangeConnector: connMod.createExchangeConnector,
    }
  }
  return __liveExecExports
}

async function executeReadyStrategiesAsLiveOrders(
  connectionId: string,
  symbol: string,
  liveStageExports: any,
): Promise<void> {
  try {
    const { getSettings, setSettings } = await import("@/lib/redis-db")
    const { executeLivePosition } = liveStageExports

    const realKey    = `strategies:${connectionId}:${symbol}:real:sets`
    const stored     = await getSettings(realKey) as any
    let realSets: any[] = []

    if (stored && typeof stored === "object") {
      if (stored._slim && Array.isArray(stored.setKeys)) {
        // ── Slim format: resolve full Sets from Base (Step 5 of coord plan) ──
        // Real/Live keys are now written as slim { setKeys[], _slim:true } blobs.
        // Base sets are the single authoritative source for entries+quality data.
        const baseKey  = `strategies:${connectionId}:${symbol}:base:sets`
        const baseSt   = await getSettings(baseKey) as any
        const baseArr: any[] = Array.isArray(baseSt?.sets) ? baseSt.sets : []
        const keySet   = new Set<string>(stored.setKeys as string[])
        realSets       = baseArr.filter((s: any) => keySet.has(s.setKey))
      } else {
        // Legacy full-blob format — tolerate during rollout.
        realSets = Array.isArray(stored.sets) ? stored.sets : []
      }
    }

    if (realSets.length === 0) return

    const { getConnection } = await __ensureLiveExecExports()
    const connection = await getConnection(connectionId).catch(() => null)
    if (!connection) {
      console.warn(`[v0] [Phase4] ${symbol}: connection ${connectionId} not found — skipping live orders`)
      return
    }
    // Resolve the exchange connector via the SAME factory path Phase 3
    // (StrategyCoordinator.createLiveSets) uses. The factory returns a real
    // connector when API credentials are present and a SimulatedConnector when
    // they are absent (dev / sim connections). Previously this Phase 4 path
    // bailed whenever credentials were missing, which silently disabled the
    // entire realtime live-dispatch loop in dev (placed=0 forever) even though
    // is_live_trade was enabled. Mirroring Phase 3's factory keeps both paths
    // consistent: executeLivePosition still gates on the is_live_trade flag.
    const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
    const exchangeConnector = await exchangeConnectorFactory
      .getOrCreateConnector(connectionId)
      .catch(() => null)
    if (!exchangeConnector) {
      console.warn(`[v0] [Phase4] ${symbol}: failed to create exchange connector for ${connection.exchange} — skipping`)
      return
    }

    // Track execution statistics for monitoring
    let createdCount = 0
    let failedCount = 0
    let totalEntries = 0

    // ── CRITICAL: cap dispatch to 1 highest-PF Set per direction ─────────
    // The exchange holds exactly ONE position per symbol+direction (the
    // dedup lock `live:lock:{conn}:{sym}:{dir}` enforces this). Phase 3
    // (`StrategyCoordinator.createLiveSets`) ALREADY dispatches the live
    // position for the best Set per direction with that same cap. This
    // Phase 4 pass previously looped over EVERY Real Set × EVERY entry and
    // called the heavyweight `executeLivePosition` for each — on a symbol
    // with ~2400 axis Real Sets that is thousands of price-fetch → volume →
    // order → SL/TP → sync round-trips per realtime cycle. The result was
    // event-loop starvation that made the whole server unresponsive
    // (verified: 2000+ "Live pipeline start" floods → dev server crash).
    //
    // Fix: mirror the createLiveSets contract here. Pick the single
    // highest-PF Set per direction; every duplicate would only hit the
    // dedup lock and be deferred anyway, so dispatching it is pure waste.
    // Sets are sorted by avgProfitFactor desc, then the first per direction
    // is kept. The per-direction dedup lock inside executeLivePosition
    // still guards against any residual concurrency.
    const sortedSets = [...realSets]
      .filter((s: any) => Array.isArray(s.entries) && s.entries.length > 0)
      .sort((a: any, b: any) => (b.avgProfitFactor || 0) - (a.avgProfitFactor || 0))
    const dispatchSets: any[] = []
    {
      let sawLong = false
      let sawShort = false
      for (const s of sortedSets) {
        const dir = s.direction === "short" ? "short" : "long"
        if (dir === "long" && !sawLong) { dispatchSets.push(s); sawLong = true }
        if (dir === "short" && !sawShort) { dispatchSets.push(s); sawShort = true }
        if (sawLong && sawShort) break
      }
    }

    // One live order per dispatched Set, sized from its single best entry
    // (highest PF). Accumulation onto an already-open position is handled
    // inside executeLivePosition's dedup/accumulate branch.
    for (const realSet of dispatchSets) {
      const entries = realSet.entries || []
      totalEntries += entries.length
      if (!entries || entries.length === 0) continue

      const bestEntry = entries.reduce(
        (best: any, e: any) => ((e.profitFactor || 0) > (best?.profitFactor || 0) ? e : best),
        entries[0],
      )
      if (!bestEntry) continue

      try {
        const realPosition = {
          id: `real:${connectionId}:${symbol}:${realSet.setKey}:${bestEntry.id}:${Date.now()}`,
          connectionId,
          symbol,
          direction: realSet.direction || "long",
          quantity: Math.max(0.1, bestEntry.sizeMultiplier || 1.0),
          entryPrice: 0,
          leverage: Math.max(1, Math.min(20, bestEntry.leverage || 1)),
          stopLoss: realSet.stopLoss,
          takeProfit: realSet.takeProfit,
          trailingStop: realSet.trailingStop,
          trailingStepSize: realSet.trailingStepSize,
          maxHoldTime: realSet.maxHoldTime,
          setKey: realSet.setKey,
          parentSetKey: realSet.parentSetKey,
          setVariant: realSet.variant,
          axisWindows: realSet.axisWindows,
          entryConfidence: bestEntry.confidence,
          entryProfitFactor: bestEntry.profitFactor,
        }

        const livePos = await executeLivePosition(connectionId, realPosition, exchangeConnector)
        if (livePos?.status === "filled" || livePos?.status === "placed" || livePos?.status === "pending_fill" || livePos?.status === "placed_unconfirmed") {
          createdCount++
          // ── CRITICAL FIX: Log full RealPosition context to progression ──
          // When a live position is created, the progression logs need to capture:
          // - Which real Set it came from (setKey, profitFactor, variant)
          // - Its axis windows (prev, last, cont, pause states)
          // - The best-entry metrics (profitFactor, leverage, confidence)
          // This is the "relay back to original progress" — linking the live
          // execution back to its originating strategy set. Without this,
          // dashboards show "position created" but lose the context of which
          // strategy variation and set axis drove the creation.
          const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
          await logProgressionEvent(
            connectionId,
            "live_trading",
            "info",
            `Live position dispatched from real set ${symbol}/${realSet.direction}`,
            {
              livePositionId: livePos.id,
              realSetKey: realSet.setKey,
              parentSetKey: realSet.parentSetKey,
              setVariant: realSet.variant,
              axisWindows: realSet.axisWindows,
              entryProfitFactor: bestEntry.profitFactor,
              entryConfidence: bestEntry.confidence,
              leverage: realPosition.leverage,
              quantity: realPosition.quantity,
              status: livePos.status,
            }
          )
        } else {
          failedCount++
        }
      } catch (err) {
        failedCount++
        console.error(`[v0] [Phase4] ${symbol}: error=${err instanceof Error ? err.message : String(err)}`)
      }
    }

    if (createdCount > 0) {
      await setSettings(`live_execution:${connectionId}:${symbol}:latest`, {
        timestamp: new Date().toISOString(),
        created: createdCount,
        failed: failedCount,
      }).catch(() => {})
    }
  } catch (err) {
    console.error(`[v0] [Phase4] error: ${err instanceof Error ? err.message : String(err)}`)
  }
}
// ── Live dispatch ownership ───────────────────────────────────────
// Live exchange dispatch is intentionally owned by
// `StrategyCoordinator.createLiveSets()` in Phase 3. This shared pipeline
// must not read `real:sets` or perform a second dispatch pass: slim Real
// set storage can contain coord/axis identities that cannot be recovered by
// filtering Base sets alone, and a second selector risks duplicate or
// conflicting live orders.

/**
 * Run one full per-symbol pipeline pass. Errors are isolated to the
 * result object — they never propagate so the caller's loop survives.
 */
// Per-phase deadline: each individual phase gets its own timeout so one
// slow Redis call in Phase 1 never wedges all 8 symbols for 120s.
// Phase budgets: Phase1=20s, Phase2=8s, Phase3=25s (well under the 120s outer deadline).
function withPhaseTimeout<T>(work: Promise<T>, label: string, ms: number): Promise<T> {
  // When ms=Infinity, skip the timeout entirely — the outer cycle deadline
  // (engine-manager) is the correct bound. setTimeout(fn, Infinity) would fire
  // at 1ms in Node.js (V8 clamps Infinity to MAX_TIMEOUT), so we guard here.
  if (!isFinite(ms) || ms <= 0) return work
  return new Promise<T>((resolve, reject) => {
    let done = false
    const t = setTimeout(() => {
      if (done) return
      done = true
      reject(new Error(`[phase-timeout] ${label} exceeded ${ms}ms`))
    }, ms)
    if (typeof (t as any).unref === "function") try { (t as any).unref() } catch { /* ok */ }
    work.then(
      (v) => { if (!done) { done = true; clearTimeout(t); resolve(v) } },
      (e) => { if (!done) { done = true; clearTimeout(t); reject(e) } },
    )
  })
}

export async function runIndStratCycle(
  connectionId: string,
  symbol: string,
  mode: PipelineMode,
  deps: PipelineDeps,
): Promise<PipelineCycleResult> {
  const cycleStart = Date.now()
  const result: PipelineCycleResult = {
    symbol,
    mode,
    asOfMs: deps.asOfMs,
    indicationCount: 0,
    indicationTypeCounts: {},
    pseudoUpdates: 0,
    strategiesEvaluated: 0,
    liveReady: 0,
    durationMs: 0,
  }

  try {
    // ── Phase 1: Indication evaluation (UNIFIED) ──────────────────────
    // One method, both modes. asOfMs threads through to control which
    // candle slice and emission timestamp the processor uses.
    // Hard per-phase timeout of 20s — prevents one stuck Redis fetch from
    // blocking all other symbols until the outer 120s deadline fires.
    const indications = await withPhaseTimeout(
      deps.indication.processIndication(symbol, deps.asOfMs),
      `Phase1/processIndication/${symbol}`,
      20_000,
    ).catch((err) => {
        console.error(
          `[v0] [SharedPipeline] processIndication failed for ${symbol} (mode=${mode}, asOfMs=${deps.asOfMs ?? "now"}):`,
          err instanceof Error ? err.message : String(err),
        )
        return [] as any[]
      })
    result.indicationCount = Array.isArray(indications) ? indications.length : 0
    if (Array.isArray(indications)) {
      for (const indication of indications) {
        const rawType =
          typeof indication?.type === "string" ? indication.type
            : typeof indication?.indication_type === "string" ? indication.indication_type
              : typeof indication?.indicationType === "string" ? indication.indicationType
                : ""
        const type = rawType.trim()
        if (type.length > 0) {
          result.indicationTypeCounts[type] = (result.indicationTypeCounts[type] ?? 0) + 1
        }
      }
    }

    // ── Phase 1b: Sets-fill (replay only) ─────────────────────────────
    // The shared `indication_set:*` keyspace is the bridge between the
    // two loops. Realtime reads it on every live tick; only Prehistoric
    // writes to it, and only on replay steps where we have an explicit
    // candle to attribute.
    if (mode === "historical" && deps.asOfCandle) {
      const setsProc = deps.setsProcessor ?? new IndicationSetsProcessor(connectionId)
      await setsProc
        .processAllIndicationSets(symbol, deps.asOfCandle)
        .catch((err) => {
          console.warn(
            `[v0] [SharedPipeline] Sets-fill warning for ${symbol} @${deps.asOfMs}:`,
            err instanceof Error ? err.message : String(err),
          )
        })
    }

    // ── Phase 2: Open pseudo position handling (REALTIME ONLY) ────────
    // Backdated candles must NEVER reach the pseudo-position close
    // engine — a 2-hour-old bar would trip TP/SL on every open paper
    // position instantly. Realtime mode marks against the live price.
    // Timeout: 8s — exchange price fetch + Redis writes should be <2s normally.
    if (mode === "realtime") {
      try {
        const pseudoUpdates = await withPhaseTimeout(
          deps.realtime.updateOpenPseudoPositionsForSymbol(symbol),
          `Phase2/pseudoUpdate/${symbol}`,
          8_000,
        )
        result.pseudoUpdates = pseudoUpdates
      } catch (pseudoErr) {
        console.error(
          `[v0] [SharedPipeline] Pseudo update failed for ${symbol}:`,
          pseudoErr instanceof Error ? pseudoErr.message : String(pseudoErr),
        )
      }
    }

    // ── Phase 3: Strategy evaluation (UNIFIED, indication-gated) ──────
    // In production the API worker also owns the coordinator. Calling the
    // full strategy evaluator on every empty warm-up tick can monopolize the
    // Node event loop and make health/status routes look crashed. Run the
    // evaluator when Phase 1 produced live indications (historical replay still
    // passes its backdated indication array), and let the next productive tick
    // advance the strategy/live stages.
    // Phase3 has no inner timeout. processStrategy is CPU-bound and with 3800+
    // sets takes 50-110s per symbol on single-threaded Node. A fixed inner
    // timeout was too conservative and discarded valid indication work from
    // Phase1/Phase2. The outer cycle deadline (120s dev / 75s prod) enforced
    // by the engine is the correct bound: if the cycle runs long, the engine
    // skips it and tries again next tick. Setting PHASE3_TIMEOUT_MS=Infinity
    // disables the Promise.race in the caller.
    const PHASE3_TIMEOUT_MS = Infinity
    const apiStrategyFlowEnabled =
      process.env.NODE_ENV !== "production" ||
      process.env.ENABLE_API_STRATEGY_FLOW === "1" ||
      process.env.ENABLE_API_STRATEGY_FLOW === "true" ||
      deps.enableStrategyFlow === true
    if (result.indicationCount > 0 && apiStrategyFlowEnabled) {
      const stratResult = await withPhaseTimeout(
        deps.strategy
          .processStrategy(symbol, indications, deps.skipLiveDispatch === true)
          .catch((err) => {
            console.error(
              `[v0] [SharedPipeline] processStrategy failed for ${symbol} (mode=${mode}):`,
              err instanceof Error ? err.message : String(err),
            )
            return { strategiesEvaluated: 0, liveReady: 0 }
          }),
        `Phase3/processStrategy/${symbol}`,
        PHASE3_TIMEOUT_MS,
      )
      result.strategiesEvaluated = stratResult.strategiesEvaluated || 0
      result.liveReady = stratResult.liveReady || 0
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
    console.error(
      `[v0] [SharedPipeline] Cycle error for ${connectionId}/${symbol} (${mode}):`,
      result.error,
    )
  } finally {
    result.durationMs = Date.now() - cycleStart
  }

  return result
}
