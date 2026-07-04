import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getConnection, getAppSettings } from "@/lib/redis-db"
import { VolumeCalculator } from "@/lib/volume-calculator"
import { aggregateLastXClosedPositions } from "@/lib/trade-engine/closed-position-aggregation"
import { getGlobalCoordinator } from "@/lib/trade-engine"
import { normalizeSymbolList } from "@/lib/trade-engine/symbol-selection-ownership"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30
export const revalidate = 0

// Rate-limit STATS-VALIDATION console.warn to once per 5 min per connection.
// The stale real>main snapshot persists across many requests until the
// coordinator writes a fresh cycle — spamming logs on every stats poll.
const _statsValidationLastWarn: Map<string, number> = new Map()
function throttledStatsWarn(key: string, msg: string): void {
  const now = Date.now()
  const last = _statsValidationLastWarn.get(key) ?? 0
  if (now - last < 300_000) return
  _statsValidationLastWarn.set(key, now)
  console.warn(msg)
}

  function n(v: unknown): number {
    const x = Number(v)
    return Number.isFinite(x) && x >= 0 ? x : 0
  }

  function pick(...values: unknown[]): number {
    for (const v of values) {
      const x = n(v)
      if (x > 0) return x
    }
    return 0
  }

  function nf(v: unknown, decimals = 2): number {
    const x = Number(v)
    if (!Number.isFinite(x) || x < 0) return 0
    const m = Math.pow(10, decimals)
    return Math.round(x * m) / m
  }

  const INDICATION_TYPES = ["direction", "move", "active", "active_advanced", "optimal", "auto"] as const

  function aggregateIndicationSnapshot(hash: Record<string, string> | null | undefined): {
    counts: Record<string, number>
    activeSets: Record<string, number>
  } {
    const counts: Record<string, number> = {
      direction: 0, move: 0, active: 0, active_advanced: 0, optimal: 0, auto: 0,
    }
    const activeSets: Record<string, number> = {
      direction: 0, move: 0, active: 0, active_advanced: 0, optimal: 0, auto: 0,
    }
    const fields = hash && typeof hash === "object" ? hash : {}

    // Legacy production deployments wrote plain fields ("direction") while
    // current writers use scoped fields ("BTCUSDT:direction"). When both exist
    // for the same type, ignore the plain field so mixed deploys do not double
    // count. If only the legacy shape exists, keep reading it so Kilo/old Redis
    // data does not show false zeroes until the next cron tick rewrites scoped
    // fields.
    const hasScopedField: Record<string, boolean> = {
      direction: false, move: false, active: false, active_advanced: false, optimal: false, auto: false,
    }
    for (const field of Object.keys(fields)) {
      const idx = field.lastIndexOf(":")
      if (idx <= 0) continue
      const type = field.slice(idx + 1)
      if (type in hasScopedField) hasScopedField[type] = true
    }

    for (const [field, raw] of Object.entries(fields)) {
      const idx = field.lastIndexOf(":")
      const type = idx > 0 ? field.slice(idx + 1) : field
      if (!(type in counts)) continue
      if (idx <= 0 && hasScopedField[type]) continue
      const value = n(raw)
      counts[type] += value
      if (value > 0) activeSets[type] += 1
    }

    return { counts, activeSets }
  }

  /**
   * Compute live-stage performance metrics from a closed-position snapshot.
   * Used by both `buildTradeHistory` (row-level PF) and `aggregateClosedStats`
   * (tier-level aggregates).
   *
   * Returns total profit-loss, gross-profit, gross-loss, hold-ms, volume-usd,
   * and realised-RoE for the batch.
   */
  function evaluateClosedBatch(
    positions: Array<Record<string, any>>,
  ): { sumPnl: number; sumGrossProfit: number; sumGrossLoss: number; sumHoldMs: number; sumVolumeUsd: number; sumRoe: number; count: number } {
    let sumPnl = 0, sumGrossProfit = 0, sumGrossLoss = 0
    let sumHoldMs = 0, sumVolumeUsd = 0, sumRoe = 0, cnt = 0
    for (const pos of positions) {
      const pnl = Number(pos.realizedPnL ?? pos.realized_pnl ?? pos.pnl ?? 0) || 0
      sumPnl += pnl
      if (pnl > 0) sumGrossProfit += pnl
      if (pnl < 0) sumGrossLoss += Math.abs(pnl)
      const created = Number(pos.createdAt ?? pos.opened_at ?? 0) || 0
      const closedAt = Number(pos.closedAt ?? pos.updatedAt ?? 0) || 0
      if (created > 0 && closedAt > created) sumHoldMs += closedAt - created
      const qty = Number(pos.executedQuantity ?? pos.quantity ?? 0) || 0
      const avgP = Number(pos.averageExecutionPrice ?? pos.entryPrice ?? 0) || 0
      const notional = qty * avgP
      sumVolumeUsd += notional
      if (notional > 0) sumRoe += pnl / notional
      cnt++
    }
    return { sumPnl, sumGrossProfit, sumGrossLoss, sumHoldMs, sumVolumeUsd, sumRoe, count: cnt }
  }

/**
 * GET /api/connections/progression/[id]/stats
 *
 * Canonical statistics endpoint consumed by all dashboard UIs.
 * Reads from three dedicated Redis namespaces so historic vs realtime
 * processing metrics are always cleanly separated:
 *
 *   prehistoric:{connId}              – written by trackPrehistoricStats()
 *   realtime:{connId}                 – written by trackRealtimeCycle()
 *   progression:{connId}              – written every cycle by ProgressionStateManager
 *                                       and statistics-tracker (hincrby)
 *
 * Falls back to trade_engine_state:{connId} (flushed every 50-100 cycles)
 * only when the primary sources return zero.
 *
 * ── IMPORTANT: Pipeline semantics (applies to every stage total below) ─
 * Base → Main → Real → Live is a CASCADE FILTER pipeline:
 *   Base  = initial Set enumeration (eval)
 *   Main  = Base Sets that survived the Main PF/DDT filter
 *   Real  = Main Sets that survived the strict Real filter (adjust)
 *   Live  = Real Sets promoted to the exchange (runtime subset of Real)
 * Each downstream stage contains the SAME logical strategies that survived
 * the upstream stage — it is NOT a separate population. Therefore:
 *
 *   canonical "strategies total" = Real-stage count (final filtered output)
 *
 * and stage counters MUST NEVER be summed together. Ratios between adjacent
 * stages (e.g. main/base) express pass-through rate, not additive totals.
 * The same rule applies to pseudo-position base/main/real counts.
 *
 * Response shape:
 * {
 *   historic: { symbolsProcessed, symbolsTotal, candlesLoaded, indicatorsCalculated,
 *               cyclesCompleted, isComplete, progressPercent,
 *               processing: { indicationChurnCycles, strategyChurnCycles } }
 *   realtime: { indicationCycles, strategyCycles, realtimeCycles, indicationsTotal,
 *               strategiesTotal, positionsOpen, isActive, successRate, avgCycleTimeMs,
 *               cycleCounters: {                            // per-processor cumulative
 *                 indication, indicationLive,               // (every tick / live only)
 *                 strategy, strategyLive,
 *                 realtime, realtimeLive
 *               },
 *               framesProcessed                              // cross-processor tick total
 *                                                            // — independent of 250 cap }
 *               ↑ strategiesTotal = Real-stage output (NOT sum of stages)
 *   breakdown: {
 *     indications: { direction, move, active, activeAdvanced, optimal, auto, total }
 *     strategies:  { base, main, real, live, total,
 *                    baseEvaluated, mainEvaluated, realEvaluated }
 *                    ↑ `total` = Real-stage count only, per pipeline rule above
 *   }
 *   metadata: { engineRunning, phase, progress, message, lastUpdate, redisDbEntries }
 * }
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // Add request timeout: if this endpoint takes >15 seconds, abort
  const timeoutPromise = new Promise<Response>((_, reject) =>
    setTimeout(() => reject(new Error("Stats endpoint timeout (15s exceeded)")), 15000)
  )

  const mainLogic = async () => {
    try {
      const { id: connectionId } = await params

      await initRedis()
      const client = getRedisClient()
      if (!client) {
        return NextResponse.json({ error: "Redis not available" }, { status: 503 })
      }

    // ── Read all namespaces in parallel ──────────────────────────────────────
    // NOTE: hgetall returns null (not throws) when the key doesn't exist — always coerce to {}
    const [
      progHashRaw,
      prehistoricHashRaw,
      realtimeHashRaw,
      engineState,
      engineProgression,
      prehistoricSymbolCount,
      prehistoricDoneMarker,
      axisWindowsHashRaw,
      ordersBySymbolRaw,
      hedgePosAccHashRaw,
      strategyDetailBaseHashRaw,
      strategyDetailMainHashRaw,
      strategyDetailRealHashRaw,
      strategyDetailLiveHashRaw,
    ] = await Promise.all([
      client.hgetall(`progression:${connectionId}`).catch(() => null),
      client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
      client.hgetall(`realtime:${connectionId}`).catch(() => null),
      getSettings(`trade_engine_state:${connectionId}`).catch(() => ({})),
      getSettings(`engine_progression:${connectionId}`).catch(() => ({})),
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      // `:done` marker written by completePrehistoricPhase — a plain SET
      // key separate from the hash so a hot-reload that loses the in-memory
      // completion callback can still flip the progress bar to 100 %.
      client.get(`prehistoric:${connectionId}:done`).catch(() => null),
      // Per-axis-window cumulative counters written by createMainSets in
      // strategy-coordinator.ts. Hash fields are `${axis}_${N}_sets` /
      // `${axis}_${N}_pos` for axis ∈ {prev, last, cont, pause} and the
      // step-1 windows documented in StrategySet.axisWindows.
      client.hgetall(`axis_windows:${connectionId}`).catch(() => null),
      // Per-symbol/direction order counters written by live-stage.ts via
      // `incrementOrdersBySymbol`. Hash field layout is
      // `{SYMBOL}:{direction}:{kind}` so a single HGETALL recovers the
      // entire breakdown for the dashboard's "Orders BTCUSDT L:3 / S:2"
      // chip strip. Stays in lock-step with the global
      // `live_orders_placed_count` / `live_orders_filled_count` totals.
      client.hgetall(`live_orders_by_symbol:${connectionId}`).catch(() => null),
      // Per-Base hedge pos-count accumulation written by bumpHedgePosAccumulation
      // in the Real stage tuner loop. Fields: `{parentSetKey}:{long|short|sets_long|sets_short|ts}`
      // Consumed to surface long/short hedge breakdown per base Set in strategyDetail.real.
      client.hgetall(`hedge_pos_acc:${connectionId}`).catch(() => null),
      // Per-symbol strategy detail for the Base stage (performance tier source).
      // Previously this hash was never fetched — buildSpecPerformance for "base"
      // was incorrectly reading from the Main hash, causing the dashboard's Base
      // performance tile to display Main-stage data instead of Base-stage data.
      client.hgetall(`strategy_detail:${connectionId}:base`).catch(() => null),
      // Per-symbol strategy detail for the Main stage (performance tier source).
      // Fields: `s:{symbol}:{created|entries|running|progressing|passed|evaluated|
      //   apf|addt|apps|aper|ts}` — one bundle per symbol × cycle.
      client.hgetall(`strategy_detail:${connectionId}:main`).catch(() => null),
      // Per-symbol strategy detail for the Real stage (performance tier source).
      client.hgetall(`strategy_detail:${connectionId}:real`).catch(() => null),
      // Live-stage detail also carries compact dispatch selected/suppressed summaries.
      client.hgetall(`strategy_detail:${connectionId}:live`).catch(() => null),
    ])

    const progHash: Record<string, string>       = progHashRaw       || {}
    const prehistoricHash: Record<string, string> = prehistoricHashRaw || {}
    const realtimeHash: Record<string, string>   = realtimeHashRaw   || {}
    const axisWindowsHash: Record<string, string> = axisWindowsHashRaw || {}
    const ordersBySymbolHash: Record<string, string> = ordersBySymbolRaw || {}
    const hedgePosAccHash: Record<string, string> = (hedgePosAccHashRaw as Record<string, string>) || {}
    const strategyDetailBaseHash: Record<string, string> = (strategyDetailBaseHashRaw as Record<string, string>) || {}
    const strategyDetailMainHash: Record<string, string> = (strategyDetailMainHashRaw as Record<string, string>) || {}
    const strategyDetailRealHash: Record<string, string> = (strategyDetailRealHashRaw as Record<string, string>) || {}
    const strategyDetailLiveHash: Record<string, string> = (strategyDetailLiveHashRaw as Record<string, string>) || {}

    const es = (engineState as Record<string, any>) || {}
    const ep = (engineProgression as Record<string, any>) || {}

    // ── HISTORIC section ─────────────────────────────────────────────────────
    // Primary: prehistoric:{connId} hash (written by trackPrehistoricStats)
    // Secondary: progression hash mirror fields
    // Tertiary: trade_engine_state fields (config_set_*)
    const historicSymbolsProcessed = pick(
      n(prehistoricHash.symbols_processed),
      prehistoricSymbolCount,
      n(progHash.prehistoric_symbols_processed_count),
      n(es.config_set_symbols_processed)
    )

    // Total user-selected symbols: canonical source is
    //   prehistoric:{id}.symbols_total  (written by quickstart + engine)
    //   trade_engine_state:{id}.config_set_symbols_total
    //   length of the symbols array actually stored for the engine
    // We DO NOT default to a magic "3" anymore — that caused the UI to
    // display misleading totals (e.g. "1/3") when the user selected 1
    // symbol in the Quickstart slot. Fall back to `processed || 1` only
    // when we genuinely have no other source.
    let symbolsFromArray = 0
    if (Array.isArray((es as any).symbols)) {
      symbolsFromArray = (es as any).symbols.length
    } else if (Array.isArray((es as any).active_symbols)) {
      symbolsFromArray = (es as any).active_symbols.length
    } else if (typeof (es as any).active_symbols === "string") {
      try {
        const parsed = JSON.parse((es as any).active_symbols)
        if (Array.isArray(parsed)) symbolsFromArray = parsed.length
      } catch { /* ignore */ }
    }
    const quickstartSymbols = normalizeSymbolList((es as any).quickstart_symbols)
    const quickstartCount = n((es as any).quickstart_symbol_count)
    const activeSelectionEpoch = String((es as any).symbol_selection_epoch || (es as any).quickstart_symbol_generation || "")
    const prehistoricSelectionEpoch = String((prehistoricHash as any).symbol_selection_epoch || "")
    const prehistoricTotalIsActive = !activeSelectionEpoch || !prehistoricSelectionEpoch || activeSelectionEpoch === prehistoricSelectionEpoch
    const canonicalSelectedSymbols = normalizeSymbolList(es.selected_symbols)
    const activeQuickstartTotal = Math.max(quickstartCount, quickstartSymbols.length)
    const canonicalCurrentTotal = activeQuickstartTotal > 0
      ? activeQuickstartTotal
      : Math.max(
        n(es.config_set_symbols_total),
        canonicalSelectedSymbols.length,
        symbolsFromArray,
      )
    const historicSymbolsTotal = canonicalCurrentTotal > 0
      ? Math.max(Math.min(historicSymbolsProcessed, canonicalCurrentTotal), canonicalCurrentTotal)
      : Math.max(
          historicSymbolsProcessed,
          prehistoricTotalIsActive ? n(prehistoricHash.symbols_total) : 0,
          symbolsFromArray,
          1,
        )
    const historicCandlesLoaded = pick(
      n(prehistoricHash.candles_loaded),
      n(progHash.prehistoric_candles_processed),
      n(es.config_set_candles_processed)
    )
    // `indicators_calculated` is written by the prehistoric calculator but
    // is reset to "0" by the dev-boot migrations. Fall back to the realtime
    // indication cycle count (every live indication cycle = processed a batch
    // of market indications, equivalent to "indicators calculated") so this
    // field is never falsely 0 when the engine is actively running.
    const historicIndicatorsCalculated = pick(
      n(prehistoricHash.indicators_calculated) || 0,
      n(es.config_set_indication_results),
      // Fall back: use live indication cycles as the "indicators processed" proxy
      n(progHash.indication_live_cycle_count),
      n(progHash.indication_cycle_count),
    )
    const historicCyclesCompleted = pick(
      n(progHash.prehistoric_cycles_completed),
      n(es.config_set_symbols_processed),
      // Tertiary: use the number of symbols processed as a minimum
      // non-zero cycle count — each symbol constitutes one prehistoric
      // cycle even if the dedicated `prehistoric_cycles_completed`
      // counter was never written (e.g. the increment call silently
      // failed). This prevents P-Cycles from showing 0 when 4 symbols
      // have clearly been processed (Frames and Indicators are non-zero).
      historicSymbolsProcessed
    )
    // DATA INTEGRITY: every completion signal is gated on REAL recorded work
    // (symbolsProcessed > 0). The genuine completion path
    // (completePrehistoricPhase) always stamps symbols_processed=max(scard,total)
    // alongside is_complete and the `:done` marker — so a flag without work is
    // by definition a stale/fake stamp (legacy fake-data writers stamped
    // prehistoric_done=1, the 7-day-TTL `:done` key, and data_loaded
    // unconditionally). Without this gate a never-run system shows a false
    // "100 % complete" with symbolsProcessed=0.
    const historicIsComplete =
      historicSymbolsProcessed > 0 &&
      (prehistoricHash.is_complete === "1" ||
        // `:done` plain-key marker written by completePrehistoricPhase —
        // survives hot-reloads where the in-memory callback may not fire.
        String(prehistoricDoneMarker) === "1" ||
        progHash.prehistoric_phase_active === "false" ||
        es.prehistoric_data_loaded === true ||
        es.prehistoric_data_loaded === "1" ||
        // All symbols processed — even if is_complete was never written
        // (e.g. the processor crashed after the last symbol but before the
        // completion pin), treat the run as done so the bar reaches 100 %.
        (historicSymbolsTotal > 0 && historicSymbolsProcessed >= historicSymbolsTotal))
    const historicProgressPercent = historicIsComplete
      ? 100
      // No Math.min(99) cap — progress tracks real completion. The bar
      // should reach 100 % when all symbols are processed, not be stuck
      // one step below waiting for an is_complete flag that may never arrive.
      : historicSymbolsTotal > 0
        ? Math.round((historicSymbolsProcessed / historicSymbolsTotal) * 100)
        : 0

    // ── REALTIME section ─────────────────────────────────────────────────────
    // Primary:   live_*_cycle_count    — only ticks that produced real work
    //                                     (indications generated / strategies evaluated).
    //                                     This is the user-facing "live progression" metric.
    // Secondary: *_cycle_count         — every tick incl. warmup/empty. Prehistoric processing
    //                                     churn, surfaced under historic.processing below,
    //                                     kept calculatively hidden from the main display.
    //
    // If the live counter is still zero (first few moments after start), fall back to the
    // churn counter so the UI doesn't render a misleading 0 while the engine spins up.
    const churnIndicationCycles = pick(
      n(progHash.indication_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.indication_cycle_count)
    )
    const churnStrategyCycles = pick(
      n(progHash.strategy_cycle_count),
      n(es.strategy_cycle_count)
    )
    const liveIndicationCycles = n(progHash.indication_live_cycle_count)
    const liveStrategyCycles   = n(progHash.strategy_live_cycle_count)
    const liveRealtimeCycles   = n(progHash.realtime_live_cycle_count)

    const realtimeIndicationCycles = liveIndicationCycles || churnIndicationCycles
    const realtimeStrategyCycles   = liveStrategyCycles   || churnStrategyCycles
    // realtimeCycles = total realtime ticks (churn). This is now actually
    // populated because EngineManager.startRealtimeProcessor writes
    // `realtime_cycle_count` on every tick via hincrby (previously this key
    // was never written, so this counter was permanently 0).
    const realtimeCycles = pick(
      n(progHash.realtime_cycle_count),
      n(realtimeHash.cycle_count),
      n(es.realtime_cycle_count)
    )

    // Cross-processor cumulative tick counter — sum of every tick across
    // indication + strategy + realtime processors since the engine started.
    // INDEPENDENT of the per-Set 250-entry DB cap. This is the "Frames /
    // Total Ticks" metric on the dashboard.
    const framesProcessed = n(progHash.frames_processed)

    // Cycle time average from realtime hash
    const realtimeCycleTimeSum = n(realtimeHash.cycle_time_sum_ms)
    const realtimeCycleCount   = n(realtimeHash.cycle_count) || 1  // avoid div-by-zero
    const avgCycleTimeMs = realtimeCycleTimeSum > 0
      ? Math.round(realtimeCycleTimeSum / realtimeCycleCount)
      : n(es.last_cycle_duration)

    const successRate = parseFloat(progHash.cycle_success_rate || String(es.cycle_success_rate || "100"))

    // Total indications/strategies evaluated — prefer progression hash
    const indicationsTotal = pick(
      n(progHash.indications_count),
      n(realtimeHash.total_indications),
      n(es.total_indications_evaluated)
    )
    const strategiesTotal = pick(
      n(progHash.strategies_count),
      n(realtimeHash.total_strategies),
      n(es.total_strategies_evaluated)
    )

    // ── OPEN POSITIONS + ACCUMULATED VOLUME (per-Set rollup) ────────────
    //
    // We track *two* independent open-position namespaces because they
    // answer different questions:
    //
    //   1. PseudoPositionManager rows at `pseudo_position:{connId}:{id}`
    //      — every live Base-stage pseudo position carries its full
    //      sizing (`position_cost`, `quantity`, `entry_price`) plus the
    //      `config_set_key` that identifies which strategy Set created
    //      it. Summing `position_cost` gives the accumulated notional
    //      USD across every *running* pseudo position, and grouping by
    //      `config_set_key` gives a per-Set rollup so the operator can
    //      see "Set X currently has 3 positions worth $1,200".
    //      Running Sets = SCARD of `pseudo_positions:{connId}:active_config_keys`.
    //
    //   2. Real-stage positions at `real:position:real:{connId}:*` —
    //      these carry `quantity * entryPrice` notional but no
    //      per-Set key; they represent Main → Real promotions that
    //      survived ratio gating. We report count + accumulated USD
    //      volume so the Strategies → Real tile can show the same
    //      "currently holding" picture as Main/Live.
    //
    // Live exchange accumulated volume is already exposed via
    // progHash.live_volume_usd_total (cumulative) and derived into
    // `openPositions.live` below.
    let pseudoOpen = 0
    let pseudoRunningSets = 0
    // Per-Set open-position counts (pseudo evaluation stage).
    // Volume is intentionally NOT tracked here — pseudo is a
    // simulated-sizing evaluation stage, not real exchange exposure.
    // Count is the only meaningful metric for the mirroring pipeline
    // health view.
    const pseudoSetAgg = new Map<string, { count: number }>()
    // ── Symbol+direction → setKey lookup index ───────────────────────
    // Built during the pseudo-position scan so the live-stage
    // Set-relation join below can identify which Set an exchange
    // position was mirrored from WITHOUT requiring new fields on the
    // LivePosition schema. Keyed as `SYMBOL:direction` (upper-cased
    // symbol, lowercase direction). Value = candidate setKeys
    // currently holding open pseudo positions for that pair; ranking
    // is by pseudo-position count (how many eval positions the Set
    // carries). In practice a live position maps to exactly one Set
    // (the one whose Real promotion triggered the exchange order) —
    // we expose candidates regardless so the operator sees the
    // relationship even when multiple equivalent Sets overlap on the
    // same symbol/direction (the consolidation case).
    const pseudoSymDirIdx = new Map<
      string,
      Array<{ setKey: string; count: number }>
    >()

    try {
      const posIds = (await client
        .smembers(`pseudo_positions:${connectionId}`)
        .catch(() => [] as string[])) || []
      // Parallel hgetall for every id — matches the fan-out pattern in
      // stages/real-stage.ts etc. A sequential loop here dominated
      // /stats latency when pseudo positions accumulated.
      const hashes = await Promise.all(
        posIds.slice(0, 500).map((id) =>
          client.hgetall(`pseudo_position:${connectionId}:${id}`).catch(() => null),
        ),
      )
      for (const h of hashes) {
        if (!h) continue
        const hh = h as Record<string, any>
        const status = hh.status ?? ""
        // Pseudo positions are written with status="open" directly.
        // Skip anything that is not explicitly open.
        if (status !== "open") continue
        pseudoOpen++

        const setKey = String(hh.config_set_key || "").trim()
        if (setKey) {
          const prev = pseudoSetAgg.get(setKey) || { count: 0 }
          prev.count++
          pseudoSetAgg.set(setKey, prev)

          // Populate symbol+direction → setKey join index for live
          // position coordination (see openPositions.live.positions
          // downstream). Same per-hash pass — no extra Redis work.
          // Equivalent upstream Sets sharing the same symbol+direction
          // appear in this list and will be consolidated into a single
          // exchange position downstream (the mirroring principle).
          const sym = String(hh.symbol || "").trim().toUpperCase()
          const dir = String(hh.direction || "").trim().toLowerCase()
          if (sym && (dir === "long" || dir === "short")) {
            const joinKey = `${sym}:${dir}`
            const arr = pseudoSymDirIdx.get(joinKey) || []
            const existing = arr.find((e) => e.setKey === setKey)
            if (existing) {
              existing.count++
            } else {
              arr.push({ setKey, count: 1 })
            }
            pseudoSymDirIdx.set(joinKey, arr)
          }
        }
      }

      // Running Sets = distinct config_set_keys currently active. This
      // is the set PseudoPositionManager maintains for O(1) duplicate
      // detection; it's the ground truth for "valid Running Sets".
      pseudoRunningSets = Number(
        await client
          .scard(`pseudo_positions:${connectionId}:active_config_keys`)
          .catch(() => 0),
      ) || 0
    } catch { /* non-critical */ }

    // Back-compat: the historic `positionsOpen` field counts total open positions
    // across all pipeline stages: pseudo (evaluation) + real (promotion) + live (execution).
    // This gives operators visibility into "how many strategies currently have positions".
    let positionsOpen = pseudoOpen

    // Top-5 per-Set rollup sorted by POSITION COUNT — pseudo positions
    // are evaluation-stage exposure, not real money, so sorting by count
    // (how many eval positions the Set carries) is the meaningful metric.
    // Volume is intentionally NOT surfaced here; it would conflate
    // simulated-sizing eval with actual exchange exposure. Real USD
    // exposure lives on the live branch below.
    const pseudoTopSets = Array.from(pseudoSetAgg.entries())
      .map(([setKey, agg]) => ({ setKey, count: agg.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)

    // ── Real-stage open positions ────────────���───────────────────────
    //
    // Real positions are Main→Real promotions awaiting mirror into
    // exchange orders. Count only — USD volume is NOT tracked here
    // either; Real is still a pipeline stage, not the exchange. The
    // only authoritative USD exposure is live.volumeUsd below.
    // Bounded by a 500-key safety ceiling — anything beyond that
    // is a data-hygiene issue the operator needs to fix independently.
    let realOpen = 0
    // ── Symbol+direction → candidate Real positions index ─────────
    // Populated alongside the Real scan so live-position resolution
    // can fall back to Real when the pseudo ledger has no matching
    // entry (e.g. Set was closed before the exchange position did).
    // No volume tracked — resolution just needs existence + id.
    const realSymDirIdx = new Map<
      string,
      Array<{ realPositionId: string }>
    >()
    try {
      // Use the connection-scoped position-id list instead of O(N) client.keys().
      // `real:positions:{connectionId}` is maintained by the Real stage (lpush on
      // creation) and gives us a bounded, connection-filtered set in O(1) per id.
      // client.keys("real:position:*") was a blocking O(keyspace) scan that stalled
      // the event loop and scanned ALL connections' positions just to then discard
      // the ones belonging to other connections.
      const realIds = ((await client
        .lrange(`real:positions:${connectionId}`, 0, 499)
        .catch(() => [])) || []) as string[]
      if (realIds.length > 0) {
        const raws = await Promise.all(
          realIds.map((id: string) => client.get(`real:position:${id}`).catch(() => null)),
        )
        for (const raw of raws) {
          if (!raw) continue
          try {
            const pos = JSON.parse(raw as string)
            if (pos.status === "closed") continue
            realOpen++
            // Index for live position join (fallback path)
            const sym = String(pos.symbol || "").trim().toUpperCase()
            const dir = String(pos.direction || "").trim().toLowerCase()
            if (sym && (dir === "long" || dir === "short") && pos.id) {
              const joinKey = `${sym}:${dir}`
              const arr = realSymDirIdx.get(joinKey) || []
              arr.push({ realPositionId: String(pos.id) })
              realSymDirIdx.set(joinKey, arr)
            }
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-critical */ }

    // ── Active validated Real positions snapshot ───────────────────────
    // IMPORTANT: /stats is a GET/read endpoint and must not mutate Redis.
    // Older code incremented `real_active_pos_*` counters on every stats
    // poll, so multiple dashboard widgets polling at different cadences
    // changed the numbers simply by observing them. That made stats appear
    // to collapse/stall with different results after progression start.
    // The engine-owned `real_samples:{id}` ring remains the canonical rolling
    // average source; this block only exposes the current snapshot plus any
    // previously materialised average without adding poll-dependent samples.
    const existingRealActiveAvg = n(progHash.real_active_pos_avg)
    const existingRealActiveSamples = n(progHash.real_active_pos_samples)
    const realActivePosAverage = realOpen > 0
      ? (existingRealActiveSamples > 0 ? existingRealActiveAvg : realOpen)
      : existingRealActiveAvg
    const realActivePosSamples = realOpen > 0
      ? Math.max(1, existingRealActiveSamples)
      : existingRealActiveSamples

    // ── Live-stage OPEN positions + Set-relation join ─────���������───────────
    //
    // The operator asked for a coordination view that identifies which
    // Set each live exchange position came from. The live-stage
    // persists positions at `live:position:{id}` with
    // `{ symbol, direction, realPositionId, quantity, entryPrice,
    //    exchangeData: { unrealizedPnl, markPrice }, status, ... }`.
    //
    // The live ledger does NOT natively carry `config_set_key` (the
    // Set identifier lives on pseudo rows upstream). We resolve the
    // relationship here, server-side, by joining on
    // `symbol + direction` against the pseudoSymDirIdx built during
    // the Base scan above. For any live position whose pseudo join
    // returns no candidates, we fall back to the Real-stage index —
    // useful when the Set closed its pseudo row between order
    // placement and the stats request. Each live position is exposed
    // with its top-3 candidate setKeys (ordered by per-set USD
    // exposure), giving the UI everything it needs to render a
    // "which Set does this live position belong to?" tooltip without
    // extra API round-trips.
    const livePositionSetRelations: Array<{
      id: string
      symbol: string
      direction: "long" | "short"
      // ── Exchange exposure (the ONLY authoritative real-money figures) ──
      volumeUsd: number
      quantity: number
      leverage: number
      marginType: "cross" | "isolated"
      marginUsd: number               // volumeUsd / leverage — actual capital at risk
      // ── Price tracking ───────────────────────────────────�������────────────
      entryPrice: number
      markPrice: number
      liquidationPrice: number        // from exchange sync (critical safety info)
      liquidationDistancePct: number  // % distance mark → liq (negative = dangerous)
      // ── PnL ──────────────────────────────────────────────────────────
      unrealizedPnl: number
      roiPct: number                  // unrealizedPnl / marginUsd × 100 (matches ROE)
      // ── Risk-management levels ───────────────────────────────────────
      stopLossPrice: number
      takeProfitPrice: number
      // ── Exchange order references ─────────────────────────��──────────
      orderId?: string
      stopLossOrderId?: string
      takeProfitOrderId?: string
      // ── Lifecycle ────────────────────────────────────────────────────
      status: string
      createdAt: number
      updatedAt: number
      syncedAt: number                // last exchange reconciliation (staleness check)
      realPositionId?: string
      // ── Coordination (mirroring fan-in) ──────────────────────────���───
      // Equivalent upstream Sets mirrored into this ONE exchange order.
      // Count = how many pseudo eval positions that Set is currently
      // holding. No per-Set USD (eval-stage notionals are NOT real
      // exposure and would be misleading).
      setKeys: Array<{ setKey: string; count: number }>
      // `resolution` tells the UI exactly HOW the Set was identified:
      //   • "pseudo"        — exact pseudo row exists for this symbol+dir
      //   • "real-fallback" — no pseudo match; resolved via Real ledger
      //   • "unresolved"    — nothing upstream matched (stale or manual)
      resolution: "pseudo" | "real-fallback" | "unresolved"
    }> = []
    try {
      const liveOpenIds = ((await client
        .lrange(`live:positions:${connectionId}`, 0, 499)
        .catch(() => [])) || []) as string[]

      if (liveOpenIds.length > 0) {
        const rawList = await Promise.all(
          liveOpenIds.map((id) =>
            client.get(`live:position:${id}`).catch(() => null),
          ),
        )
        for (const raw of rawList) {
          if (!raw) continue
          try {
            const pos = JSON.parse(raw as string)
            // Exclude closed/cancelled; accept every in-flight state
            // where exchange exposure is still on the books.
            const status = String(pos.status || "").toLowerCase()
            if (status === "closed" || status === "cancelled" || status === "error") continue

            const sym = String(pos.symbol || "").trim().toUpperCase()
            const dir = String(pos.direction || "").trim().toLowerCase()
            if (!sym || (dir !== "long" && dir !== "short")) continue

            const qty = Number(pos.executedQuantity || pos.quantity) || 0
            const px  = Number(pos.averageExecutionPrice || pos.entryPrice) || 0
            const volumeUsd = qty > 0 && px > 0 ? Math.round(qty * px * 100) / 100 : 0

            const joinKey = `${sym}:${dir}`
            let setKeys: Array<{ setKey: string; count: number }> = []
            let resolution: "pseudo" | "real-fallback" | "unresolved" = "unresolved"

            const pseudoMatches = pseudoSymDirIdx.get(joinKey)
            if (pseudoMatches && pseudoMatches.length > 0) {
              // Rank by pseudo-position count (how many eval positions
              // the Set is holding) — count is the only meaningful
              // eval-stage metric, since USD notionals at this stage
              // are simulated-sizing not real exposure. All equivalent
              // Sets on the same symbol+dir are surfaced so the UI can
              // render "N Sets → 1 exchange order" consolidation.
              setKeys = [...pseudoMatches]
                .sort((a, b) => b.count - a.count)
                .slice(0, 3)
                .map((s) => ({ setKey: s.setKey, count: s.count }))
              resolution = "pseudo"
            } else {
              const realMatches = realSymDirIdx.get(joinKey)
              if (realMatches && realMatches.length > 0) {
                // Real-stage fallback: we don't have the setKey itself,
                // only that one exists upstream. Surface a synthetic
                // marker so the UI can distinguish "no Set found" from
                // "Set existed but Base row already closed".
                resolution = "real-fallback"
                setKeys = [{
                  setKey: `real:${realMatches[0].realPositionId}`,
                  count: realMatches.length,
                }]
              }
            }

            // ── Enrich the per-position row with complete exchange-
            //    side details so the UI can render full Position
            //    Details (leverage, margin at risk, liq distance,
            //    SL/TP levels, ROI) WITHOUT a second API round-trip.
            const leverage = Math.max(1, Number(pos.leverage) || 1)
            const marginType: "cross" | "isolated" =
              (pos.exchangeData?.marginType as "cross" | "isolated") ||
              (pos.marginType as "cross" | "isolated") ||
              "cross"
            const markPrice = Math.round(
              (Number(pos.exchangeData?.markPrice) || 0) * 1e8,
            ) / 1e8
            const liquidationPrice = Math.round(
              (Number(pos.exchangeData?.liquidationPrice) || 0) * 1e8,
            ) / 1e8
            const unrealizedPnl = Math.round(
              (Number(pos.exchangeData?.unrealizedPnl ?? pos.exchangeData?.unrealizedPnL) || 0) * 100,
            ) / 100
            // Actual margin at risk = exposure / leverage (not
            // notional). This is what the operator has skin in the
            // game for; ROI is computed against it to match exchange
            // ROE semantics.
            const marginUsd = leverage > 0
              ? Math.round((volumeUsd / leverage) * 100) / 100
              : 0
            const roiPct = marginUsd > 0
              ? Math.round((unrealizedPnl / marginUsd) * 10000) / 100
              : 0
            // Liquidation distance: +% = safe headroom, −% = mark
            // already past liq (auto-close imminent / processing).
            let liquidationDistancePct = 0
            if (markPrice > 0 && liquidationPrice > 0) {
              const raw =
                dir === "long"
                  ? (markPrice - liquidationPrice) / markPrice
                  : (liquidationPrice - markPrice) / markPrice
              liquidationDistancePct = Math.round(raw * 10000) / 100
            }

            livePositionSetRelations.push({
              id: String(pos.id || ""),
              symbol: sym,
              direction: dir as "long" | "short",
              volumeUsd,
              quantity: Math.round(qty * 1e8) / 1e8,
              leverage,
              marginType,
              marginUsd,
              entryPrice: Math.round(px * 1e8) / 1e8,
              markPrice,
              liquidationPrice,
              liquidationDistancePct,
              unrealizedPnl,
              roiPct,
              stopLossPrice:   Math.round((Number(pos.stopLossPrice)   || 0) * 1e8) / 1e8,
              takeProfitPrice: Math.round((Number(pos.takeProfitPrice) || 0) * 1e8) / 1e8,
              orderId:            pos.orderId            ? String(pos.orderId)            : undefined,
              stopLossOrderId:    pos.stopLossOrderId    ? String(pos.stopLossOrderId)    : undefined,
              takeProfitOrderId:  pos.takeProfitOrderId  ? String(pos.takeProfitOrderId)  : undefined,
              status,
              createdAt: Number(pos.createdAt) || 0,
              updatedAt: Number(pos.updatedAt) || 0,
              syncedAt:  Number(pos.exchangeData?.syncedAt) || 0,
              realPositionId: pos.realPositionId ? String(pos.realPositionId) : undefined,
              setKeys,
              resolution,
            })
          } catch { /* skip malformed */ }
        }
      }
    } catch { /* non-critical */ }

    // Derived aggregates for the openPositions.live branch below.
    // Kept separate from progHash counters because the hash is
    // write-heavy and occasionally lags the actual live:position:* rows
    // by a few seconds. These scan-derived values are the authoritative
    // "right now" view for the coordination UI.
    const liveOpenScanned = livePositionSetRelations.length

    // positionsOpen = authoritative open count from atomic counters.
    // The live:positions:{connId} list scan (liveOpenScanned) is used only for
    // the per-position detail rows and set-key relations. Using it as the count
    // causes inflation: the list accumulates all positions since boot (lrem on
    // close is best-effort) and many remain in non-closed status even after
    // the exchange position closes (simulated connector never sets price to trigger
    // TP/SL). Counter arithmetic from hincrby writes is exact and race-free.
    const phaseCurrent = String(progHash.phase || es.phase || "").toLowerCase()
    const liveCounterOpen = Math.max(0, n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count))
    positionsOpen = liveCounterOpen > 0
      ? liveCounterOpen
      : phaseCurrent === "live_trading"
        ? 0
        : pseudoOpen + realOpen
    const liveResolvedViaPseudo = livePositionSetRelations.filter(
      (p) => p.resolution === "pseudo",
    ).length
    const liveResolvedViaReal = livePositionSetRelations.filter(
      (p) => p.resolution === "real-fallback",
    ).length
    const liveUnresolvedCount = livePositionSetRelations.filter(
      (p) => p.resolution === "unresolved",
    ).length

    // ── Exchange-wide aggregates for the Live summary strip ──────────
    // Computed from the SAME scan-derived snapshot that drives the
    // per-position rows — guarantees the summary totals always equal
    // the sum of what's visible in the coordination panel. These are
    // the authoritative portfolio figures the operator needs to make
    // risk decisions.
    let liveAggTotalUnrealizedPnl = 0
    let liveAggTotalMarginUsd = 0
    let liveAggTotalVolumeUsd = 0
    let liveAggInProfit = 0
    let liveAggInLoss = 0
    let liveAggNearLiquidation = 0   // mark within ≤ 5% of liq price
    let liveAggStaleSync = 0         // no exchange sync in >60s
    const liveAggConsolidatedSets = livePositionSetRelations.reduce(
      (sum, p) => sum + (p.setKeys?.length || 0),
      0,
    )
    const nowMsAgg = Date.now()
    // Per-symbol position groupings (long/short + USD totals) — surfaced as
    // `openPositions.live.bySymbol` so the dashboard can render
    // "BTCUSDT L:2 S:1" chips beneath the Positions row. Source is the same
    // `livePositionSetRelations` array used for the portfolio aggregates, so
    // the per-symbol totals always reconcile with the global numbers.
    const bySymbolMap = new Map<string, {
      long: number
      short: number
      volumeUsd: number
      marginUsd: number
      unrealizedPnl: number
    }>()
    for (const p of livePositionSetRelations) {
      liveAggTotalUnrealizedPnl += p.unrealizedPnl || 0
      liveAggTotalMarginUsd     += p.marginUsd || 0
      liveAggTotalVolumeUsd     += p.volumeUsd || 0
      if ((p.unrealizedPnl || 0) > 0) liveAggInProfit++
      else if ((p.unrealizedPnl || 0) < 0) liveAggInLoss++
      // Both long (liq below mark → positive distance) and short (liq above mark
      // → negative distance) are "near liquidation" when their absolute distance
      // is ≤ 5%. The previous `<= 5` without Math.abs was correct for longs but
      // silently missed short positions (where liquidationDistancePct is negative
      // and would be < 5, so they WERE counted — but a short at -3% is 3% away,
      // which IS within the 5% alert band; only shorts safely past -5% are fine).
      // Use Math.abs to make the intent explicit and guard against sign drift.
      if (
        p.liquidationPrice > 0 &&
        p.markPrice > 0 &&
        p.liquidationDistancePct !== 0 &&
        Math.abs(p.liquidationDistancePct) <= 5
      ) {
        liveAggNearLiquidation++
      }
      if (p.syncedAt > 0 && nowMsAgg - p.syncedAt > 60_000) liveAggStaleSync++

      // Per-symbol roll-up
      const sym = p.symbol || ""
      if (sym) {
        const e = bySymbolMap.get(sym) || {
          long: 0, short: 0, volumeUsd: 0, marginUsd: 0, unrealizedPnl: 0,
        }
        if (p.direction === "long") e.long++
        else if (p.direction === "short") e.short++
        e.volumeUsd     += p.volumeUsd     || 0
        e.marginUsd     += p.marginUsd     || 0
        e.unrealizedPnl += p.unrealizedPnl || 0
        bySymbolMap.set(sym, e)
      }
    }
    liveAggTotalUnrealizedPnl = Math.round(liveAggTotalUnrealizedPnl * 100) / 100
    liveAggTotalMarginUsd     = Math.round(liveAggTotalMarginUsd * 100) / 100
    liveAggTotalVolumeUsd     = Math.round(liveAggTotalVolumeUsd * 100) / 100
    const liveAggPortfolioRoiPct = liveAggTotalMarginUsd > 0
      ? Math.round((liveAggTotalUnrealizedPnl / liveAggTotalMarginUsd) * 10000) / 100
      : 0
    // Frozen array for `openPositions.live.bySymbol`. Sorted so the symbol
    // with the most open positions comes first — keeps the UI chip strip
    // stable across polls.
    const liveBySymbol = Array.from(bySymbolMap.entries())
      .map(([symbol, v]) => ({
        symbol,
        long:          v.long,
        short:         v.short,
        volumeUsd:     Math.round(v.volumeUsd     * 100) / 100,
        marginUsd:     Math.round(v.marginUsd     * 100) / 100,
        unrealizedPnl: Math.round(v.unrealizedPnl * 100) / 100,
      }))
      .sort((a, b) => (b.long + b.short) - (a.long + a.short))

    // engineProgression phase and engine_state status are the canonical source of
    // truth for whether the engine is actively running. realtimeIndicationCycles
    // stays non-zero after a stop (it reflects the last run's cycle count, not
    // a live signal), so it must be gated by the authoritative phase/status.
    //
    // RACE-CONDITION FIX: After a server restart the engine_progression Redis hash
    // retains the last phase written (e.g. "realtime") from a previous process.
    // The in-memory coordinator starts empty (no engines running), so the Redis
    // hash alone produces a false-positive "running" signal. We cross-check with
    // the in-memory coordinator: if the coordinator explicitly says the engine is
    // NOT running for this connection, treat it as stopped regardless of Redis.
    const coord = getGlobalCoordinator()
    const coordSaysRunning: boolean = coord
      ? coord.isEngineRunning(connectionId)
      : false
    // If coordinator exists but says "not running", that's definitive.
    // If coordinator doesn't exist yet (null, server just booted), fall back to
    // Redis signals — don't assume stopped, since the coordinator may not have
    // initialised yet.
    const coordDefinitelyStopped = coord !== null && !coordSaysRunning

    const engineIsStopped =
      coordDefinitelyStopped ||
      ep?.phase === "stopped" ||
      es.status === "stopped" ||
      es.status === "idle"
    const realtimeIsActive =
      !engineIsStopped &&
      (realtimeIndicationCycles > 0 ||
        ep?.phase === "live_trading" ||
        ep?.phase === "realtime" ||
        es.status === "running")

    // ── BREAKDOWN section ────────────────────────────────���───────────────────
    // Indication per-type counts live in two places:
    //   1. progression hash: indications_{type}_count  (written by statistics-tracker hincrby)
    //   2. standalone key:   indications:{connId}:{type}:count  (also by statistics-tracker incr)
    // We read both and take the higher.

    // Indication types tracked. MUST stay in sync with `DEFAULT_LIMITS`
    // in `lib/indication-sets-processor.ts`. Each type has:
    //   - its own per-Set 250-entry pool (per config)
    //   - its own cumulative counter `indications_{type}_count` on progression:{id}
    //   - its own per-cycle increment via hincrby in EngineManager.startIndicationProcessor
    // `auto` is a synthetic legacy alias retained for back-compat with old runs.
    const indTypes = ["direction", "move", "active", "active_advanced", "optimal", "auto"] as const
    const indCounts: Record<string, number> = {}
    await Promise.all(
      indTypes.map(async (type) => {
        // Both standalone keys are independent — issue the two GETs
        // in parallel so each type contributes a single Redis RTT
        // instead of two sequential awaits chained through the
        // pipeline. With 6 types this halves the wall-time spent on
        // per-type breakdown reads.
        const fromHash = n(progHash[`indications_${type}_count`])
        const [fromKey, fromEval] = await Promise.all([
          client.get(`indications:${connectionId}:${type}:count`).catch(() => 0),
          client.get(`indications:${connectionId}:${type}:evaluated`).catch(() => 0),
        ])
        indCounts[type] = Math.max(fromHash, n(fromKey), n(fromEval))
      })
    )
    const indTotal = Object.values(indCounts).reduce((s, v) => s + v, 0) || indicationsTotal

    // ── ACTIVE-NOW aggregation: indications + strategies ───────────────
    // The cumulative `indCounts` / `stratCounts` above answer "how many
    // were ever created since the run started". The dashboard Overview
    // also needs "how many are alive RIGHT NOW" — i.e. passing their
    // thresholds on the latest cycle. The engine writes per-cycle
    // overwrites into:
    //
    //   indications_active:{connId} hash (fields: "{symbol}:{type}")
    //   strategies_active:{connId}  hash (fields: "{symbol}:{stage}")
    //
    // We hgetall both, then aggregate by type / stage. If the engine
    // never wrote (e.g. fresh run, no symbols yet) the hashes are empty
    // and all activeCounts come back zero — exactly the right "nothing
    // alive" semantic for the UI.
    const activeIndByType: Record<string, number> = {
      direction: 0, move: 0, active: 0, active_advanced: 0, optimal: 0, auto: 0,
    }
    const activeStratByStage: Record<string, number> = {
      base: 0, main: 0, real: 0, live: 0,
    }
    // ── DISTINCT-SETS-PROGRESSING tally (per type / per stage) ────────
    // The cumulative `indCounts.*` and `stratCounts.*` count the total
    // *entries* ever produced by every Set since run start. The
    // dashboard also needs a "how many distinct Sets are currently
    // alive RIGHT NOW" view — i.e. per (symbol × type) or
    // (symbol × stage) pairs whose latest cycle reported a non-zero
    // qualified count. We count distinct hash fields with `value > 0`
    // because each field encodes a unique "{symbol}:{type|stage}" pair
    // — exactly the cardinality of "active progressing Sets" the
    // operator asked for. Zero-valued fields (engine wrote a row but
    // nothing qualified that cycle) are excluded so the number tracks
    // currently-progressing pools, not all-ever-touched pools.
    const activeSetsIndByType: Record<string, number> = {
      direction: 0, move: 0, active: 0, active_advanced: 0, optimal: 0, auto: 0,
    }
    const activeSetsStratByStage: Record<string, number> = {
      base: 0, main: 0, real: 0, live: 0,
    }
    // Cross-symbol evaluated counts — summed from strategies_active hash
    // `:evaluated` suffix fields written by the engine. Using the same
    // hash and same summing loop as stratCounts ensures both numerator
    // and denominator are in the same (cross-symbol) scope, preventing
    // the STATS-VALIDATION "baseEvaluated > base" false positives that
    // occurred when a single-symbol standalone key was compared against
    // the cross-symbol active sum.
    const activeStratEvaluated: Record<string, number> = { base: 0, main: 0, real: 0 }
    let activeRealInput = 0
    let activeRealRelatedCreated = 0
    // Hoisted so the raw hash is accessible in the return block for `strategiesActive`.
    let stratActiveHash: Record<string, string> | null = null
    try {
      const [indActiveHash, _stratActiveHash] = await Promise.all([
        client.hgetall(`indications_active:${connectionId}`).catch(() => null),
        client.hgetall(`strategies_active:${connectionId}`).catch(() => null),
      ])
      // Persist for outer-scope access (strategiesActive in return object).
      stratActiveHash = (_stratActiveHash && typeof _stratActiveHash === "object")
        ? (_stratActiveHash as Record<string, string>)
        : null
      if (indActiveHash && typeof indActiveHash === "object") {
        const snapshot = aggregateIndicationSnapshot(indActiveHash as Record<string, string>)
        for (const type of INDICATION_TYPES) {
          activeIndByType[type] = snapshot.counts[type] || 0
          activeSetsIndByType[type] = snapshot.activeSets[type] || 0
        }
      }
      if (stratActiveHash && typeof stratActiveHash === "object") {
        for (const [field, val] of Object.entries(stratActiveHash)) {
          // Field shape: "{SYMBOL}:{stage}" or Real accounting fields such as
          // "{SYMBOL}:real:input", "{SYMBOL}:real:relatedCreated",
          // and "{SYMBOL}:{stage}:evaluated".
          // e.g. "BTCUSDT:base", "BTCUSDT:base:evaluated", "ETHUSDT:real:relatedCreated"
          // Strip the symbol prefix by slicing from the FIRST colon, not the last.
          // Using lastIndexOf would split "BTCUSDT:base:evaluated" into suffix="evaluated"
          // which never matches "base:evaluated" — the root cause of baseEvaluated=0.
          const firstColon = field.indexOf(":")
          if (firstColon <= 0) continue
          const suffix = field.slice(firstColon + 1)   // e.g. "base", "main", "real", "base:evaluated"
          const numVal = n(val)
          // Fields ending in ":evaluated" are written by the engine to give cross-symbol
          // evaluated counts in the same scope as the stage counts. Aggregate them into
          // stratEvaluated so the STATS-VALIDATION check compares apples to apples.
          if (suffix === "base:evaluated" || suffix === "main:evaluated" || suffix === "real:evaluated") {
            const stage = suffix.replace(":evaluated", "") as "base" | "main" | "real"
            activeStratEvaluated[stage] = (activeStratEvaluated[stage] ?? 0) + numVal
            continue
          }
          if (suffix === "real:input") {
            activeRealInput += numVal
            continue
          }
          if (suffix === "real:relatedCreated") {
            activeRealRelatedCreated += numVal
            continue
          }
          if (suffix in activeStratByStage) {
            activeStratByStage[suffix] += numVal
            if (numVal > 0) activeSetsStratByStage[suffix] += 1
          }
        }
      }
    } catch { /* non-critical: dashboard falls back to cumulative */ }
    const activeIndTotal = Object.values(activeIndByType).reduce((s, v) => s + v, 0)
    // Pipeline-aware total: only count REAL stage (final filtered output), not sum of BASE+MAIN+REAL
    // Each strategy survives through the cascade filter, not added at each stage.
    let activeStratTotal = activeStratByStage.real || strategiesTotal
    const activeSetsIndTotal   = Object.values(activeSetsIndByType).reduce((s, v) => s + v, 0)
    // Only count distinct REAL-stage sets progressing, not sum across stages
    const activeSetsStratTotal = activeSetsStratByStage.real || 0

    // Strategy per-stage counts
    // NOTE on source priority:
    //   strategies_active:{id}  hash  — per-symbol hset, aggregated to activeStratByStage above.
    //                                    This is the CURRENT snapshot (what's alive right now).
    //   strategies:{id}:{stage}:count  — standalone string, overwritten each cycle with the
    //                                    LAST-PROCESSED symbol's count. Correct only for 1-symbol runs.
    //   strategies_{stage}_total       — cumulative hincrby (grows every cycle). NEVER use as
    //                                    current count — it inflates dramatically over many cycles.
    // Priority: activeStratByStage (cross-symbol sum, most recent) > standalone key > cumulative hash.
    const stratTypes = ["base", "main", "real", "live"] as const
    const stratCounts: Record<string, number> = {}
    const stratEvaluated: Record<string, number> = {}
    await Promise.all(
      stratTypes.map(async (type) => {
        // Prefer the cross-symbol sum from strategies_active hash (already computed above).
        // `createLiveSets` now writes `{symbol}:live` to strategies_active each cycle, so
        // `activeStratByStage.live` is valid and should be preferred like the other stages.
        const fromActive = activeStratByStage[type] || 0
        // Issue both standalone-key reads in parallel — they're
        // independent and previously chained as sequential awaits,
        // doubling the per-stage wall time for no benefit.
        const [fromKeyRaw, evalFromKeyRaw] = await Promise.all([
          client.get(`strategies:${connectionId}:${type}:count`).catch(() => 0),
          client.get(`strategies:${connectionId}:${type}:evaluated`).catch(() => 0),
        ])
        const fromKey = n(fromKeyRaw)
        // NOTE: strategies_{type}_total is a cumulative hincrby (grows every cycle × symbols).
        // It MUST NOT be used as the current count — prefer fromActive (cross-symbol live snapshot)
        // or fromKey (last-symbol standalone, 24h TTL). Fall back to 0 when both are absent so
        // the dashboard shows "no data yet" instead of an inflated lifetime cumulative.
        stratCounts[type] = fromActive > 0 ? fromActive
                          : fromKey   > 0 ? fromKey
                          : 0
        // Prefer cross-symbol activeStratEvaluated (from strategies_active hash
        // `:evaluated` suffix fields) so the denominator matches stratCounts[type]
        // scope. Do NOT fall back to the standalone `strategies:{id}:{type}:evaluated`
        // key: that key is a lifetime cumulative `incrby` counter (grows across every
        // cron cycle × symbol) while `stratCounts[type]` is the current-cycle live
        // snapshot — comparing them triggers false-positive STATS-VALIDATION warnings
        // (e.g. baseEvaluated 1577 > base 4) and floods the error log. When the
        // active hash hasn't been written yet (cold start / old engine) return 0 so
        // the dashboard shows "no data yet" rather than an inflated lifetime number.
        const fromActiveEval = activeStratEvaluated[type] ?? 0
        stratEvaluated[type] = fromActiveEval > 0 ? fromActiveEval : 0
      })
    )
    // Enforce cascade invariants for all public progression counters:
    // BASE expands into MAIN variants, REAL is a filtered subset of MAIN, and
    // LIVE is a dispatch subset of REAL. During live runs, per-stage writers can
    // briefly update different fields in separate Redis calls, so a stats read
    // may observe `real > main` (or `live > real`) for one request. Normalize the
    // snapshot here instead of exposing an impossible state to the dashboard,
    // validation scripts, and operators watching long-running progressions.
    // BASE expands into MAIN variants, REAL filters MAIN inputs and may also
    // create additional Real Sets through related/axis fan-out, and LIVE is a
    // dispatch subset of REAL. During live runs, per-stage writers can briefly
    // update different fields in separate Redis calls, so a stats read may
    // observe impossible overages. Normalize only when REAL exceeds the
    // pipeline-aware ceiling: main inputs + Real Sets created at the Real stage.
    // `strategies_real_related_created` is cumulative, so do not use it as
    // the per-snapshot allowance; `strategies_real_last_created` is the
    // coordinator's current-cycle related/axis-created Real fan-out.
    const realRelatedCreatedForCurrentSnapshot = n(progHash.strategies_real_last_created)
    const realCeiling = stratCounts.main + realRelatedCreatedForCurrentSnapshot
    if (stratCounts.main > 0 && stratCounts.real > realCeiling) {
      throttledStatsWarn(
        `${connectionId}:real-ceiling`,
        `[STATS-VALIDATION] ${connectionId}: real (${stratCounts.real}) > ` +
        `main (${stratCounts.main}) + realRelatedCreated (${realRelatedCreatedForCurrentSnapshot}). ` +
        `Clamping real to pipeline-aware ceiling (${realCeiling}).`,
      )
      stratCounts.real = realCeiling
    }
    // Enforce cascade invariants for public progression counters. REAL may fan
    // out from upstream PF-eligible Main input, so real passed output can exceed
    // main as long as it does not exceed input + real:relatedCreated. During live
    // runs, per-stage writers can briefly update different fields in separate
    // Redis calls, so normalize only truly impossible snapshots.
    const realUpstreamInput = activeRealInput || stratCounts.main
    const realMaxAfterFanOut = realUpstreamInput + activeRealRelatedCreated
    if (realUpstreamInput > 0 && realMaxAfterFanOut > 0 && stratCounts.real > realMaxAfterFanOut) {
      throttledStatsWarn(
        `${connectionId}:real-fanout`,
        `[STATS-VALIDATION] ${connectionId}: real (${stratCounts.real}) > Real max after fan-out ` +
        `(${realMaxAfterFanOut}; main=${stratCounts.main}, input=${activeRealInput}, ` +
        `relatedCreated=${activeRealRelatedCreated}). Clamping real to fan-out max.`,
      )
      stratCounts.real = realMaxAfterFanOut
      activeStratByStage.real = Math.min(activeStratByStage.real || 0, stratCounts.real)
      activeStratTotal = activeStratByStage.real || stratCounts.real || strategiesTotal
    }
    if (stratCounts.real > 0 && stratCounts.live > stratCounts.real) {
      stratCounts.live = stratCounts.real
      activeStratByStage.live = Math.min(activeStratByStage.live || 0, stratCounts.live)
      activeStratTotal = activeStratByStage.real || stratCounts.real || strategiesTotal
    }
    // ── Pipeline-aware "total strategies" ────────────────────────────────
    // Base → Main → Real → Live is a CASCADE FILTER (eval → filter → adjust).
    // Each stage operates on the output of the previous stage, so the SAME
    // logical strategy exists at every stage it survives. Summing the four
    // stage counters would triple/quadruple-count the same strategy.
    //
    // The canonical total is the REAL-stage count (the final filtered output
    // before live promotion). Live is a runtime-only subset derived from Real
    // and is shown separately in the breakdown; it is NOT part of the total.
    // Fall back to `strategies_count` (which is written with the same
    // pipeline-aware semantic by the engine & cron) if Real is zero.
    const stratTotal = stratCounts.real || strategiesTotal

    // ── STRATEGY VARIANT breakdown ───────────────────────────────────────��───
    // The Main stage expands each promoted Base Set into position-variant
    // entries (default / trailing / block / dca). StrategyCoordinator writes
    // per-variant aggregates to `strategy_variant:{connId}:{variant}` hash
    // fields:
    //   created_sets, passed_sets, entries_count, avg_profit_factor,
    //   avg_drawdown_time, avg_pos_per_set, pass_rate, updated_at
    //
    // We surface these alongside the stage-level detail so the dashboard can
    // show "Avg PF / Avg DDT per variant" over the lifetime of the run.
    // Pause is intentionally not a strategy variant. It is exposed below as
    // an axis/window accumulation (`axisWindows.pause`), not in
    // `strategyVariants`.
    const variantKeys = ["default", "trailing", "block", "dca"] as const
    const variantDetail: Record<string, Record<string, number>> = {}
    await Promise.all(
      variantKeys.map(async (variant) => {
        // CANONICAL SOURCE = `strategy_variant_real:` (cumulative via hincrby).
        // The coordinator writes the lifecycle variant aggregates there (Real
        // stage, strategy-coordinator.ts L3619) — NOT to the legacy
        // `strategy_variant:` key this route used to read (which was never
        // written, so every variant tile + the block/dca counts showed 0).
        // The Real hash also stores derived averages (avg_profit_factor /
        // avg_drawdown_time / avg_pos_per_set / pass_rate) via its recompute
        // pass; we still fall back to computing them from the raw summed
        // fields (entries_count / sum_pf_x1000 / sum_ddt_x10 / created_sets)
        // in case that recompute pass was skipped on a given cycle.
        const h = ((await client.hgetall(`strategy_variant_real:${connectionId}:${variant}`).catch(() => null)) || {}) as Record<string, string>
        const createdSets      = n(h.created_sets)
        const passedSets       = n(h.passed_sets)
        const entriesCount     = n(h.entries_count)
        const sumPfX1000       = n(h.sum_pf_x1000)
        const sumDdtX10        = n(h.sum_ddt_x10)
        // Prefer the pre-derived field; fall back to raw-sum math when absent/0.
        let avgPosPerSet       = parseFloat(h.avg_pos_per_set   || "0")
        if (!(avgPosPerSet > 0) && createdSets > 0)  avgPosPerSet    = entriesCount / createdSets
        let avgProfitFactor    = parseFloat(h.avg_profit_factor || "0")
        // avgPF fallback: sumPfX1000 is the sum of each SET's PF×1000.
        // Divide by createdSets (not entriesCount) to get the average PF per set.
        // Dividing by entriesCount gave avg PF per entry (~0.6), which is wrong.
        if (!(avgProfitFactor > 0) && createdSets > 0) avgProfitFactor = (sumPfX1000 / 1000) / createdSets
        let avgDrawdownTime    = parseFloat(h.avg_drawdown_time || "0")
        // Similarly: sumDdtX10 is sum of each SET's DDT×10; divide by createdSets.
        if (!(avgDrawdownTime > 0) && createdSets > 0) avgDrawdownTime = (sumDdtX10 / 10) / createdSets
        const passRateRaw      = parseFloat(h.pass_rate         || "0")
        variantDetail[variant] = {
          createdSets,
          passedSets,
          entriesCount,
          avgPosPerSet:     isFinite(avgPosPerSet)    ? Math.round(avgPosPerSet * 100) / 100      : 0,
          avgProfitFactor:  isFinite(avgProfitFactor) ? Math.round(avgProfitFactor * 1000) / 1000 : 0,
          avgDrawdownTime:  isFinite(avgDrawdownTime) ? Math.round(avgDrawdownTime * 10) / 10     : 0,
          passRate:         passRateRaw > 0
            ? Math.round(passRateRaw * 1000) / 10
            : createdSets > 0
              ? Math.round((passedSets / createdSets) * 1000) / 10
              : 0,
        }
      })
    )
    // Totals across variants for an "Overall" row
    const variantTotals = variantKeys.reduce(
      (acc, v) => {
        acc.createdSets     += variantDetail[v].createdSets
        acc.passedSets      += variantDetail[v].passedSets
        acc.entriesCount    += variantDetail[v].entriesCount
        // Weighted averages across variants using createdSets as the weight
        const w = variantDetail[v].createdSets
        if (w > 0) {
          acc.weightedPF  += variantDetail[v].avgProfitFactor * w
          acc.weightedDDT += variantDetail[v].avgDrawdownTime * w
          acc.weightSum   += w
        }
        return acc
      },
      { createdSets: 0, passedSets: 0, entriesCount: 0, weightedPF: 0, weightedDDT: 0, weightSum: 0 },
    )
    const variantOverall = {
      createdSets:    variantTotals.createdSets,
      passedSets:     variantTotals.passedSets,
      entriesCount:   variantTotals.entriesCount,
      avgProfitFactor: variantTotals.weightSum > 0
        ? Math.round((variantTotals.weightedPF / variantTotals.weightSum) * 1000) / 1000
        : 0,
      avgDrawdownTime: variantTotals.weightSum > 0
        ? Math.round((variantTotals.weightedDDT / variantTotals.weightSum) * 10) / 10
        : 0,
      passRate: variantTotals.createdSets > 0
        ? Math.round((variantTotals.passedSets / variantTotals.createdSets) * 1000) / 10
        : 0,
    }

    // ── STRATEGY DETAIL fields ───────────────────────────────────────────────
    // Per-stage avg positions per set, created sets, avg profit factor, avg processing time
    // Written by strategy-processor as HSET strategy_detail:{connId}:{stage} ...
    // Note: "live" stats are derived below from progression counters + closed
    // position archive (local Redis only — no exchange history round-trip).
    const stratDetailKeys = ["base", "main", "real"] as const
    // Shared shape for base/main/real/live. `Record<string, any>` keeps the
    // structure flexible for tier-specific extras (win rate, total PnL, etc.
    // live only) without needing a discriminated union on every write site.
    // Typed as Record<string, unknown> to allow the Real stage to include
    // the hedgePosAcc nested object alongside the flat number fields.
    const stratDetail: Record<string, Record<string, unknown>> = {}

    // Track stale-symbol fields for opportunistic pruning. Without this,
    // every symbol ever evaluated (incl. ones removed from the basket
    // hours ago) leaves ~11 fields behind in the strategy_detail hash
    // until the 24h key TTL — a slow memory drift across long-running
    // connections that swap symbol baskets.
    const staleFieldsByKey = new Map<string, string[]>()

    await Promise.all(
      stratDetailKeys.map(async (stage) => {
        const detailKey = `strategy_detail:${connectionId}:${stage}`
        const dh = ((await client.hgetall(detailKey).catch(() => null)) || {}) as Record<string, string>

        // ── Cross-symbol aggregation from per-symbol `s:{symbol}:*` fields ─
        // Each `(symbol, cycle)` writes a `s:{symbol}:*` bundle. We sum
        // counters and weight-mean the averages across all FRESH symbols
        // (ts ≤ 5 min old). Symbols stale > 30 min are queued for HDEL
        // pruning to bound the hash size.
        const FRESH_MS = 5 * 60 * 1000
        const PRUNE_MS = 30 * 60 * 1000
        const nowMs = Date.now()
        let symCreated = 0, symEntries = 0, symRunning = 0, symProgressing = 0
        let symPassed = 0, symEvaluated = 0
        let weightedPF = 0, weightedDDT = 0, weightedPPS = 0, weightedPER = 0
        let weightSum = 0, freshSymbols = 0
        const staleFields: string[] = []
        for (const k of Object.keys(dh)) {
          if (!k.startsWith("s:") || !k.endsWith(":ts")) continue
          // k shape: "s:{symbol}:ts" — extract symbol between first and last colon.
          const symbol = k.slice(2, -3)
          const ts = Number(dh[k] || "0") || 0
          const ageMs = nowMs - ts
          if (ageMs > PRUNE_MS) {
            // Collect every per-symbol field for HDEL. Cheap because
            // these are stale samples already excluded from aggregation.
            for (const f of ["created","entries","running","progressing","passed","evaluated","apf","addt","apps","aper","dispatch_selected","dispatch_suppressed","ts"]) {
              if (`s:${symbol}:${f}` in dh) staleFields.push(`s:${symbol}:${f}`)
            }
            continue
          }
          if (ageMs > FRESH_MS) continue   // present-but-stale → exclude
          freshSymbols += 1
          const c = Number(dh[`s:${symbol}:created`]    || 0) || 0
          symCreated     += c
          symEntries     += Number(dh[`s:${symbol}:entries`]     || 0) || 0
          symRunning     += Number(dh[`s:${symbol}:running`]     || 0) || 0
          symProgressing += Number(dh[`s:${symbol}:progressing`] || 0) || 0
          symPassed      += Number(dh[`s:${symbol}:passed`]      || 0) || 0
          symEvaluated   += Number(dh[`s:${symbol}:evaluated`]   || 0) || 0
          // Weighted means: weight = createdSets. A symbol with c=0
          // contributes nothing — correct, an empty sample shouldn't
          // drag the mean toward 0.
          if (c > 0) {
            weightSum  += c
            weightedPF  += (Number(dh[`s:${symbol}:apf`])  || 0) * c
            weightedDDT += (Number(dh[`s:${symbol}:addt`]) || 0) * c
            weightedPPS += (Number(dh[`s:${symbol}:apps`]) || 0) * c
            weightedPER += (Number(dh[`s:${symbol}:aper`]) || 0) * c
          }
        }
        if (staleFields.length > 0) staleFieldsByKey.set(detailKey, staleFields)

        // ── Field reads: prefer per-symbol cross-sum; fall back to legacy.
        // The legacy fields (overwritten on every (symbol, cycle)) are
        // wrong when N>1 symbols are processed because the LAST symbol's
        // values are what the dashboard sees. Per-symbol fields fix that.
        const useCross = freshSymbols > 0
        const createdSets       = useCross
          ? symCreated
          : n(dh.created_sets      || progHash[`strategy_${stage}_created_sets`])
        const avgPosPerSet      = useCross && weightSum > 0
          ? weightedPPS / weightSum
          : parseFloat(dh.avg_pos_per_set      || progHash[`strategy_${stage}_avg_pos_per_set`]      || "0")
        const avgProfitFactor   = useCross && weightSum > 0
          ? weightedPF / weightSum
          : parseFloat(dh.avg_profit_factor    || progHash[`strategy_${stage}_avg_profit_factor`]    || "0")
        const avgProcessingMs   = parseFloat(dh.avg_processing_ms    || progHash[`strategy_${stage}_avg_processing_ms`]    || "0")
        // Average position evaluation score for Real stage (stored by strategy-coordinator)
        const avgPosEvalReal    = useCross && weightSum > 0
          ? weightedPER / weightSum
          : parseFloat(dh.avg_pos_eval_real    || progHash[`strategy_${stage}_avg_pos_eval_real`]    || "0")
        // Count of positions that contributed to avgPosEvalReal (only meaningful for Real stage)
        const countPosEval      = n(dh.count_pos_eval || progHash[`strategy_${stage}_count_pos_eval`])
        // Drawdown time (avg minutes from strategy sets)
        const avgDrawdownTime   = useCross && weightSum > 0
          ? weightedDDT / weightSum
          : parseFloat(dh.avg_drawdown_time    || progHash[`strategy_${stage}_avg_drawdown_time`]    || "0")

        // Eval percentage per stage:
        //   base:  100% — Base self-evaluates all its sets (no filter).
        //   main:  evaluated/base, capped at 100 (expansion: 1 base → N main).
        //   real:  evaluated/main, capped at 100 (filter: N main → M real).
        //   live:  evaluated/real, capped at 100 (filter: M real → K live).
        let evalPct = 0
        if (stage === "base") {
          // createdSets may be 0 if dh.created_sets absent; use stratCounts.base fallback
          evalPct = (createdSets > 0 || (stratCounts.base || 0) > 0) ? 100 : 0
        } else if (stage === "main") {
          const base = stratCounts.base || 1
          const raw = base > 0 ? (stratEvaluated.main / base) * 100 : 0
          evalPct = Math.min(100, Math.round(raw * 10) / 10)
        } else if (stage === "real") {
          const main = stratCounts.main || 1
          const raw = main > 0 ? (stratEvaluated.real / main) * 100 : 0
          evalPct = Math.min(100, Math.round(raw * 10) / 10)
        } else if (stage === "live") {
          const real = stratCounts.real || 1
          const raw = real > 0 ? (stratEvaluated.real / real) * 100 : 0
          evalPct = Math.min(100, Math.round(raw * 10) / 10)
        }
        const pct = (num: number, den: number): number => den > 0
          ? Math.min(100, Math.round((num / den) * 1000) / 10)
          : 0

        // ── evaluated / passed / passRatio ───���────────────────────────
        // Source priority:
        //   1. Per-symbol cross-sum (symEvaluated / symPassed) when fresh.
        //   2. Legacy dh.evaluated / dh.passed_sets — only trust when > 1
        //      (value of "1" means stale single-symbol last-write).
        //   3. Standalone Redis keys (stratEvaluated / stratCounts) written
        //      every coordinator cycle with the correct semantics.
        const stageEvaluatedRaw = useCross
          ? symEvaluated
          : n(dh.evaluated) > 1 ? n(dh.evaluated) : 0
        const stageEvaluated = stageEvaluatedRaw
          || stratEvaluated[stage]
          || stratCounts[stage]
          || 0

        // passed = sets that advanced to the next stage.
        // Expansion stages (BASE/MAIN): all sets pass → fall back to stageEvaluated.
        // Filter stages (REAL): output count = stratCounts.real.
        const stagePassedRaw = useCross
          ? symPassed
          : n(dh.passed_sets || progHash[`strategy_${stage}_passed`])
        const stagePassed = stagePassedRaw > 0
          ? stagePassedRaw
          : stratCounts[stage] || 0

        // passRatio: prefer stored pass_rate (0-1 fraction from coordinator),
        // but cross-validate it against the actual counted values.
        // If pass_rate * stageEvaluated diverges from stagePassed by more
        // than 10%, the hash is stale from a prior cycle — recompute.
        const passRatioRaw = parseFloat(dh.pass_rate || "0")
        const passRatioFromRate = passRatioRaw > 0
          ? Math.min(100, Math.round(passRatioRaw * 1000) / 10)
          : 0
        // Recompute from counted values — always available when stageEvaluated > 0.
        const passRatioFromCounts = stageEvaluated > 0
          ? Math.min(100, Math.round((stagePassed / Math.max(stageEvaluated, 1)) * 1000) / 10)
          : stagePassed > 0 ? 100 : 0
        // Validate: if pass_rate implies a passed count that differs by >10%
        // from the actual stagePassed, the stored value is stale.
        const impliedPassed = passRatioRaw * stageEvaluated
        const stalePassRate = stageEvaluated > 0 && stagePassed > 0
          && Math.abs(impliedPassed - stagePassed) / Math.max(stagePassed, 1) > 0.1
        const passRatio = (passRatioFromRate > 0 && !stalePassRate)
          ? passRatioFromRate
          : passRatioFromCounts

        // ── Actively-running counts (operator spec) ──
        // `sets_running_now` is written by strategy-coordinator using
        // membership in the `pseudo_positions:{conn}:active_config_keys`
        // Redis Set (Base) or parentSetKey resolution (Main/Real). It
        // represents Sets that are CURRENTLY processing — those holding
        // an open pseudo-position OR mid-formation this cycle. The
        // dashboard surfaces this as the canonical "Active" count.
        // Fallback chain for the Real stage: use the pseudo running-sets count
        // (SCARD of active_config_keys) because that is the source the coordinator
        // writes from — the detail hash `sets_running_now` field is only written
        // periodically and may lag on a fresh boot.
        const setsRunningNowRaw = n(dh.sets_running_now || dh.sets_with_open_positions)
        const setsRunningNow = setsRunningNowRaw > 0
          ? setsRunningNowRaw
          : stage === "real"
            ? pseudoRunningSets   // SCARD pseudo_positions:{conn}:active_config_keys
            : stage === "base"
              ? pseudoRunningSets
              : 0
        // setsProgressing: how many sets have entries/positions building up.
        // Fall back to setsRunningNow (sets with open pseudo-positions) NOT
        // createdSets (lifetime total) — createdSets inflates to 9000+ and is
        // not meaningful as a "currently progressing" metric.
        const setsProgressing = n(dh.sets_progressing) || setsRunningNow || stratCounts[stage] || 0

        stratDetail[stage] = {
          avgPosPerSet:        isFinite(avgPosPerSet)    ? Math.round(avgPosPerSet * 100) / 100      : 0,
          createdSets,
          entriesCount:        n(dh.entries_total || dh.entries_count),
          avgProfitFactor:     isFinite(avgProfitFactor) ? Math.round(avgProfitFactor * 1000) / 1000 : 0,
          avgProcessingTimeMs: isFinite(avgProcessingMs) ? Math.round(avgProcessingMs * 10) / 10     : 0,
          avgPosEvalReal:      isFinite(avgPosEvalReal)  ? Math.round(avgPosEvalReal * 1000) / 1000  : 0,
          countPosEval:        countPosEval,
          avgDrawdownTime:     isFinite(avgDrawdownTime) ? Math.round(avgDrawdownTime * 10) / 10     : 0,
          evalPct,
          passRatio,
          evaluated: stageEvaluated,
          passed: stagePassed,
          failed: Math.max(0, stageEvaluated - stagePassed),
          setsRunningNow,
          setsProgressing,
          setsWithOpenPositions: setsRunningNow,
          // Main stage only: count of axis "additional Pos-Count Sets" created
          axisSets: stage === "main" ? n(dh.axis_sets || progHash.strategies_main_axis_sets) : 0,
          // Real-only 4-perspective stats (overall/accumulated/general/combined).
          // For non-Real stages the fields are 0 — the dialog only renders
          // the 4-tile panel when stage === "real".
          ...(stage === "real"
            ? (() => {
                // Overall = total Real sets produced across all cycles.
                // Fall back to stratCounts.real (current-cycle output count).
                // Accumulated = axis position accumulation sum from axis_pos_acc hash.
                // Written by bumpAxisPosAccumulation in the Real tuner loop.
                // General = distinct Real sets this cycle (not lifetime createdSets).
                // Combined = Real sets running now (those with active base set coordination).

                // ── Hedge pos-count accumulation per base Set ─────────────────
                // Rebuilt from flat `hedge_pos_acc:{conn}` hash fields.
                // Fields: `{parentSetKey}:{long|short|sets_long|sets_short|ts}`
                // We aggregate totals and per-base snapshots so the dashboard
                // can render both a summary (total long/short entries) and the
                // per-base breakdown (which base Set is most imbalanced).
                const hedgeByBase = new Map<string, {
                  long: number; short: number
                  setsLong: number; setsShort: number
                  ts: number
                }>()
                for (const [field, rawVal] of Object.entries(hedgePosAccHash)) {
                  const val = Number(rawVal) || 0
                  const colonIdx = field.lastIndexOf(":")
                  if (colonIdx === -1) continue
                  const baseKey = field.slice(0, colonIdx)
                  const suffix  = field.slice(colonIdx + 1)
                  let entry = hedgeByBase.get(baseKey)
                  if (!entry) {
                    entry = { long: 0, short: 0, setsLong: 0, setsShort: 0, ts: 0 }
                    hedgeByBase.set(baseKey, entry)
                  }
                  if      (suffix === "long")       entry.long      = val
                  else if (suffix === "short")      entry.short     = val
                  else if (suffix === "sets_long")  entry.setsLong  = val
                  else if (suffix === "sets_short") entry.setsShort = val
                  else if (suffix === "ts")         entry.ts        = val
                }
                let hedgeTotalLong = 0, hedgeTotalShort = 0
                let hedgeTotalSetsLong = 0, hedgeTotalSetsShort = 0
                const hedgePerBase: Array<{
                  parentSetKey: string
                  longEntries: number; shortEntries: number
                  longSets: number; shortSets: number
                  net: number; hedgeRatio: number; lastUpdated: number
                }> = []
                for (const [parentSetKey, e] of hedgeByBase) {
                  hedgeTotalLong      += e.long
                  hedgeTotalShort     += e.short
                  hedgeTotalSetsLong  += e.setsLong
                  hedgeTotalSetsShort += e.setsShort
                  const total = e.long + e.short
                  hedgePerBase.push({
                    parentSetKey,
                    longEntries:  e.long,
                    shortEntries: e.short,
                    longSets:     e.setsLong,
                    shortSets:    e.setsShort,
                    net:          e.long - e.short,
                    hedgeRatio:   total > 0 ? Math.abs(e.long - e.short) / total : 0,
                    lastUpdated:  e.ts,
                  })
                }
                // Sort most-imbalanced first
                hedgePerBase.sort((a, b) => Math.abs(b.net) - Math.abs(a.net))

                return {
                  statOverall:     n(progHash.strategies_real_total) || stratCounts.real || 0,
                  statAccumulated: n(dh.stat_accumulated),
                  statGeneral:     n(dh.stat_general) || stageEvaluated || stratCounts.real || 0,
                  statCombined:    n(dh.stat_combined) || setsRunningNow || stratCounts.real || 0,
                  // ── Hedge pos-count accumulation (long/short per base Set) ──
                  hedgePosAcc: {
                    totalLongEntries:  hedgeTotalLong,
                    totalShortEntries: hedgeTotalShort,
                    totalLongSets:     hedgeTotalSetsLong,
                    totalShortSets:    hedgeTotalSetsShort,
                    netEntries:        hedgeTotalLong - hedgeTotalShort,
                    baseCount:         hedgeByBase.size,
                    perBase:           hedgePerBase,
                  },
                }
              })()
            : {}),
        }
      })
    )

    // ── Opportunistic stale per-symbol field pruning ─────────────────
    // After aggregation, HDEL the per-symbol bundles older than 30 min.
    // Done after the response is computed (and fire-and-forget) so it
    // never adds latency to /stats. Bounds hash size for long-running
    // connections that swap symbol baskets — without pruning the hash
    // grows by ~11 fields × every-symbol-ever-seen until the 24h TTL.
    if (staleFieldsByKey.size > 0) {
      void Promise.allSettled(
        Array.from(staleFieldsByKey.entries()).map(([key, fields]) =>
          fields.length > 0 ? client.hdel(key, ...fields).catch(() => 0) : Promise.resolve(0),
        ),
      )
    }

    // ── SINGLE closed-archive fetch shared by stratDetail.live and
    //    closedPositionsForHistory (below) ─────────────────────────────────
    // CRITICAL FIX: Fetch from BOTH Redis live positions AND database persisted
    // positions to ensure complete trade history. Previously only Redis was checked,
    // missing positions that were synced to the database by data-cleanup-manager.
    // Now we fetch from Redis first (for freshest data), then supplement from
    // database to capture any that may have been archived/cleaned.
    const sharedClosedParsed: Array<Record<string, any>> = []
    const seenIds = new Set<string>()
    
    try {
      // Fetch from Redis live:positions:${connectionId}:closed list
      const closedIds = ((await client
        .lrange(`live:positions:${connectionId}:closed`, 0, 499)
        .catch(() => [])) || []) as string[]
      const rawList = await Promise.all(
        closedIds.map((id) => client.get(`live:position:${id}`).catch(() => null)),
      )
      for (const raw of rawList) {
        if (!raw) continue
        try {
          const pos = JSON.parse(raw as string)
          sharedClosedParsed.push(pos)
          if (pos.id) seenIds.add(pos.id)
        } catch { /* skip malformed */ }
      }
    } catch { /* archive empty */ }
    
    // Supplement with positions from database that may have been synced and not
    // in the Redis live list (e.g., archived/cleaned or from previous sessions)
    try {
      const { query } = await import("@/lib/db")
      const dbPositions = await query(
        `SELECT 
          id, symbol, direction, entry_price as "entryPrice", exit_price as "exitPrice",
          quantity, realized_pnl as "realizedPnL", opened_at as "openedAt", 
          closed_at as "closedAt", status
        FROM positions 
        WHERE connection_id = $1 AND status = 'closed'
        ORDER BY closed_at DESC LIMIT 500`,
        [connectionId]
      )
      for (const pos of dbPositions || []) {
        // Skip if already in Redis (avoid duplicates)
        if (pos.id && seenIds.has(pos.id)) continue
        // Only add if it has minimum required fields for display
        if (pos.symbol && pos.direction && pos.entryPrice && pos.realizedPnL !== null) {
          sharedClosedParsed.push({
            id: pos.id || "",
            symbol: pos.symbol,
            direction: pos.direction,
            entryPrice: pos.entryPrice,
            exitPrice: pos.exitPrice || 0,
            quantity: pos.quantity,
            realizedPnL: pos.realizedPnL,
            openedAt: pos.openedAt ? new Date(pos.openedAt).getTime() : 0,
            closedAt: pos.closedAt ? new Date(pos.closedAt).getTime() : 0,
            status: pos.status,
          })
          if (pos.id) seenIds.add(pos.id)
        }
      }
    } catch { /* database query failed */ }

    type DispatchSummaryRow = {
      bucket: string
      direction: string
      isTrailing: boolean
      reason: string
      count: number
      detail?: string
    }
    const parseDispatchSummary = (raw: unknown): DispatchSummaryRow[] => {
      if (!raw || typeof raw !== "string") return []
      try {
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        return parsed
          .map((row) => ({
            bucket: String(row?.bucket || "unknown"),
            direction: String(row?.direction || "unknown"),
            isTrailing: Boolean(row?.isTrailing),
            reason: String(row?.reason || "unknown"),
            count: Number(row?.count || 0) || 0,
            ...(row?.detail ? { detail: String(row.detail) } : {}),
          }))
          .filter((row) => row.count > 0)
      } catch {
        return []
      }
    }
    const mergeDispatchSummaries = (rows: DispatchSummaryRow[]): DispatchSummaryRow[] => {
      const merged = new Map<string, DispatchSummaryRow>()
      for (const row of rows) {
        const key = `${row.bucket}|${row.direction}|${row.isTrailing ? "1" : "0"}|${row.reason}|${row.detail || ""}`
        const existing = merged.get(key)
        if (existing) {
          existing.count += row.count
        } else {
          merged.set(key, { ...row })
        }
      }
      return Array.from(merged.values()).sort((a, b) => b.count - a.count || a.bucket.localeCompare(b.bucket))
    }
    const readFreshSymbolDispatchSummary = (suffix: "dispatch_selected" | "dispatch_suppressed"): DispatchSummaryRow[] => {
      const FRESH_MS = 5 * 60 * 1000
      const nowMs = Date.now()
      const rows: DispatchSummaryRow[] = []
      for (const [field, raw] of Object.entries(strategyDetailLiveHash)) {
        if (!field.startsWith("s:") || !field.endsWith(`:${suffix}`)) continue
        const symbol = field.slice(2, -(suffix.length + 1))
        const ts = Number(strategyDetailLiveHash[`s:${symbol}:ts`] || "0") || 0
        if (!ts || nowMs - ts > FRESH_MS) continue
        rows.push(...parseDispatchSummary(raw))
      }
      return mergeDispatchSummaries(rows)
    }

    // ── LIVE STAGE DETAIL (4th tier — mirrors Real but from real exchange) ��──
    // Sourced entirely from local Redis — the progression hash (counters) and
    // the closed-position archive written by the live-stage pipeline. No
    // exchange history calls required.
    {
      const livePlaced    = n(progHash.live_orders_placed_count)
      const liveFilled    = n(progHash.live_orders_filled_count)
      const liveCreated   = n(progHash.live_positions_created_count)
      const liveClosed    = n(progHash.live_positions_closed_count)
      const liveWins      = n(progHash.live_wins_count)
      const liveVolumeUsd = n(progHash.live_volume_usd_total)

      // Derive stratDetail.live metrics from the shared parsed array
      // (first 200 entries mirror the old lrange(0, 199) behaviour).
      // Keep PnL normalization in lock-step with evaluateClosedBatch():
      // realizedPnL → realized_pnl → pnl.
      const sampledClosed = sharedClosedParsed.slice(0, 200)
      const closedEval = evaluateClosedBatch(sampledClosed)
      const lastXClosed = aggregateLastXClosedPositions(sampledClosed, sampledClosed.length)
      const countSampled = closedEval.count
      const sumPnl = closedEval.sumPnl
      const avgHoldMin  = countSampled > 0 ? (closedEval.sumHoldMs / countSampled) / 60_000 : 0
      const avgPnl      = countSampled > 0 ? sumPnl / countSampled : 0
      const avgRoi      = lastXClosed.avgSignedR
      const profitFactor = lastXClosed.profitFactor
      const passRate   = livePlaced > 0 ? liveFilled / livePlaced : 0
      const winRate    = lastXClosed.winRate
      const avgPosSize = countSampled > 0
        ? closedEval.sumVolumeUsd / countSampled
        : liveCreated > 0 ? liveVolumeUsd / liveCreated : 0
      const perSymbolDispatchSelected = readFreshSymbolDispatchSummary("dispatch_selected")
      const perSymbolDispatchSuppressed = readFreshSymbolDispatchSummary("dispatch_suppressed")
      const dispatchSelected = perSymbolDispatchSelected.length > 0
        ? perSymbolDispatchSelected
        : parseDispatchSummary(strategyDetailLiveHash.dispatch_selected)
      const dispatchSuppressed = perSymbolDispatchSuppressed.length > 0
        ? perSymbolDispatchSuppressed
        : parseDispatchSummary(strategyDetailLiveHash.dispatch_suppressed)
      const dispatchSelectedCount = dispatchSelected.reduce((sum, row) => sum + row.count, 0)
      const dispatchSuppressedCount = dispatchSuppressed.reduce((sum, row) => sum + row.count, 0)

      stratDetail.live = {
        // Same shape as base/main/real so the UI can reuse its row renderer:
        avgPosPerSet:        Math.round(avgPosSize * 100) / 100,        // avg position notional (USD)
        createdSets:         liveCreated,                               // positions actually created on exchange
        avgProfitFactor:     Math.round(profitFactor * 1000) / 1000,    // PF from realised PnL
        avgProcessingTimeMs: 0,                                         // not tracked for live — handled inline
        avgPosEvalReal:      Math.round(avgRoi * 10000) / 10000,        // avg ROI fraction
        countPosEval:        countSampled,
        avgDrawdownTime:     Math.round(avgHoldMin * 10) / 10,          // avg hold time in minutes
        // evalPct for the live stage = percentage of Real sets dispatched to the
        // exchange this session cycle.
        // Numerator: stratCounts.live = sets actually dispatched by createLiveSets
        //            this cycle (written into strategies_active hash each cycle).
        //            NOT liveCreated which is cumulative across all sessions.
        // Denominator: stratCounts.real = current-cycle Real sets (the filter output).
        evalPct: (stratCounts.real || 0) > 0
          ? Math.min(100, Math.round(((stratCounts.live || 0) / (stratCounts.real || 1)) * 1000) / 10)
          : n(progHash.strategies_real_total) > 0
            ? Math.min(100, Math.round(((stratCounts.live || 0) / n(progHash.strategies_real_total)) * 1000) / 10)
            : 0,
        passRatio: Math.round(passRate * 1000) / 10,                    // fill rate %
        evaluated: livePlaced,
        passed:    liveFilled,
        failed:    Math.max(0, livePlaced - liveFilled),
        // Live-exclusive fields for richer UI display:
        winRate:        lastXClosed.winRate,
        totalPnl:       Math.round(sumPnl * 100) / 100,
        avgPnl:         Math.round(avgPnl * 100) / 100,
        openPositions:  Math.max(0, liveCreated - liveClosed),
        // setsRunningNow for the live stage = open exchange positions (one set per exchange order)
        setsRunningNow:   Math.max(0, liveCreated - liveClosed),
        setsProgressing:  liveCreated,
        setsWithOpenPositions: Math.max(0, liveCreated - liveClosed),
        volumeUsdTotal: Math.round(liveVolumeUsd * 100) / 100,
        dispatchSelected,
        dispatchSuppressed,
        dispatchSelectedCount,
        dispatchSuppressedCount,
      }
    }

    // ── SPEC PERFORMANCE HISTORY ───────────────────────────────────────────────
    // Per-symbol per-stage performance snapshot derived from the Main and Real
    // strategy_detail hashes. Each hash carries `s:{symbol}:{apf|addt|apps|aper|ts}`
    // fields written by strategy-coordinator every cycle. We aggregate across all
    // fresh (≤5-min-old) symbols to give each (symbol × stage) a complete metrics
    // row including win-rate proxy (sets-with-open-pos / created), PF, DDT, hold,
    // and avg entry-score.
    //
    // "Detail" = per-symbol spec rows | "Aggregated" = cross-symbol tier averages.
    const buildSpecPerformance = (
      dh: Record<string, string>,
      stageLabel: "base" | "main" | "real",
    ): {
      aggregated: Record<string, any>
      detail: Array<{ symbol: string; created: number; entries: number; running: number; avgProfitFactor: number; avgDrawdownTime: number; avgPosPerSet: number; avgPosEval: number; fresh: boolean }>
    } => {
      const FRESH_MS = 5 * 60 * 1000
      const nowMs = Date.now()
      let symCreated = 0, symEntries = 0, symRunning = 0
      let weightedPF = 0, weightedDDT = 0, weightedPPS = 0, weightedPER = 0
      let weightSum = 0, totalRunning = 0
      const detail: Array<{ symbol: string; created: number; entries: number; running: number; avgProfitFactor: number; avgDrawdownTime: number; avgPosPerSet: number; avgPosEval: number; fresh: boolean }> = []
      for (const k of Object.keys(dh)) {
        if (!k.startsWith("s:") || !k.endsWith(":ts")) continue
        const symbol = k.slice(2, -3)
        const ts = Number(dh[k] || "0") || 0
        const fresh = (nowMs - ts) <= FRESH_MS
        const sCreated     = Number(dh[`s:${symbol}:created`]    || 0) || 0
        const sEntries     = Number(dh[`s:${symbol}:entries`]     || 0) || 0
        const sRunning     = Number(dh[`s:${symbol}:running`]     || 0) || 0
        const sApf         = nf(dh[`s:${symbol}:apf`], 3)
        const sAddt        = nf(dh[`s:${symbol}:addt`], 1)
        const sApps         = nf(dh[`s:${symbol}:apps`], 2)
        const sAper        = nf(dh[`s:${symbol}:aper`], 4)
        detail.push({ symbol, created: sCreated, entries: sEntries, running: sRunning, avgProfitFactor: sApf, avgDrawdownTime: sAddt, avgPosPerSet: sApps, avgPosEval: sAper, fresh })
        symCreated  += sCreated
        symEntries  += sEntries
        symRunning  += sRunning
        totalRunning += sRunning
        if (sCreated > 0) {
          weightSum   += sCreated
          weightedPF  += sApf  * sCreated
          weightedDDT += sAddt * sCreated
          weightedPPS += sApps  * sCreated
          weightedPER += sAper * sCreated
        }
      }
      detail.sort((a, b) => b.created - a.created)
      return {
        aggregated: {
          symbolCount:       detail.length,
          totalCreated:      symCreated,
          totalEntries:      symEntries,
          totalRunning:      totalRunning,
          avgProfitFactor:   weightSum > 0 ? Math.round((weightedPF  / weightSum) * 1000) / 1000 : 0,
          avgDrawdownTime:   weightSum > 0 ? Math.round((weightedDDT / weightSum) * 10)  / 10    : 0,
          avgPosPerSet:      weightSum > 0 ? Math.round((weightedPPS / weightSum) * 100)  / 100   : 0,
          avgPosEval:        weightSum > 0 ? Math.round((weightedPER / weightSum) * 10000) / 10000 : 0,
        },
        detail: detail.slice(0, 200), // cap at 200 rows for response size
      }
    }
    // Each stage reads from its OWN strategy_detail hash — previously
    // base used the Main hash and main used the Real hash, so the
    // dashboard's Base performance tile showed Main-stage data and
    // Main showed Real-stage data. Now every stage reads the correct source.
    const baseSpecPerf  = buildSpecPerformance(strategyDetailBaseHash, "base")
    const mainSpecPerf  = buildSpecPerformance(strategyDetailMainHash, "main")
    const realSpecPerf  = buildSpecPerformance(strategyDetailRealHash, "real")

    // ── LIVE CLOSED POSITION AGGREGATES (drive tradeHistory + perfTiers live) ──
    // Parallelise: fetch closed IDs + scan open live positions for unrealised
    // PnL, then fan-out per-archive GETs.
    let liveClosedCount = 0
    let liveClosedWins = 0
    let liveClosedSumPnl = 0
    let liveClosedSumGrossProfit = 0
    let liveClosedSumGrossLoss = 0
    let liveClosedSumHoldMs = 0
    let liveClosedCountForPf = 0
    let liveClosedSumPnlForPf = 0
    let liveClosedSumGrossProfitForPf = 0
    let liveClosedSumGrossLossForPf = 0
    let liveClosedRoeAcc = 0
    let liveClosedHoldMinutes = 0
    const closedPositionsForHistory: Array<{
      id: string
      symbol: string
      direction: "long" | "short"
      entryPrice: number
      exitPrice: number
      realizedPnl: number
      pnlPct: number
      holdMinutes: number
      openedAt: number
      closedAt: number
      volumeUsd: number
    }> = []

    try {
      // Reuse the closed-archive array already fetched and parsed above.
      // The old code fetched lrange(0,499) here independently — that was
      // a duplicate of the lrange(0,199) done for stratDetail.live, doubling
      // the number of GET calls on this hot path. `sharedClosedParsed`
      // already holds all 500 entries (fetched once above).
      const closedParsed = sharedClosedParsed
      liveClosedCount = closedParsed.length
      liveClosedCountForPf = closedParsed.length
      const closedEval = evaluateClosedBatch(closedParsed)
      liveClosedSumPnl         = closedEval.sumPnl
      liveClosedSumGrossProfit = closedEval.sumGrossProfit
      liveClosedSumGrossLoss   = closedEval.sumGrossLoss
      liveClosedSumHoldMs      = closedEval.sumHoldMs
      liveClosedRoeAcc         = closedEval.sumRoe
      liveClosedHoldMinutes    = closedEval.sumHoldMs / 60_000
      liveClosedWins           = closedParsed.filter((p: Record<string, any>) => (Number(p.realizedPnL ?? 0) || 0) > 0).length

      // Build per-position history rows (cap at 500 for response payload)
      for (const pos of closedParsed) {
        const pnl = Number(pos.realizedPnL ?? pos.realized_pnl ?? 0) || 0
        const qty = Number(pos.executedQuantity ?? pos.quantity ?? 0) || 0
        const avgP = Number(pos.averageExecutionPrice ?? pos.entryPrice ?? 0) || 0
        // Skip rejected / zero-fill positions that have no valid entry data.
        // These are orders that were placed but never filled (qty=0 or price=0).
        if (qty <= 0 || avgP <= 0) continue
        const created = Number(pos.createdAt ?? 0) || 0
        const closedAt = Number(pos.closedAt ?? pos.updatedAt ?? 0) || 0
        const notional = qty * avgP
        const pnlPct = notional > 0 ? Math.round((pnl / notional) * 10000) / 100 : 0
        const holdMin = created > 0 && closedAt > created ? Math.round((closedAt - created) / 60_000) : 0
        const sym = String(pos.symbol || "").trim().toUpperCase()
        const dirRaw = String(pos.direction || "").trim().toLowerCase()
        if (!sym || !["long", "short"].includes(dirRaw)) continue

        // Resolve exit price. Priority:
        //   1. pos.closePrice — written by closeLivePosition() after this fix.
        //   2. Back-derive from realizedPnL — for positions closed before the
        //      fix was deployed (closePrice was not persisted). This is exact:
        //      LONG:  exitPrice = entryPrice + pnl / qty
        //      SHORT: exitPrice = entryPrice - pnl / qty
        //   3. 0 — signals the UI to display "—" (no reliable exit price).
        let exitPrice = 0
        const storedClose = Number(pos.closePrice ?? pos.lastPrice ?? 0) || 0
        if (storedClose > 0) {
          exitPrice = Math.round(storedClose * 1e8) / 1e8
        } else if (pnl !== 0 && qty > 0 && avgP > 0) {
          // Back-derive from P&L: pnl = qty * (exit - entry) * direction_sign
          const derived = dirRaw === "long"
            ? avgP + pnl / qty
            : avgP - pnl / qty
          if (derived > 0) exitPrice = Math.round(derived * 1e8) / 1e8
        }

        closedPositionsForHistory.push({
          id:          String(pos.id || ""),
          symbol:      sym,
          direction:   dirRaw as "long" | "short",
          entryPrice:  Math.round(avgP * 1e8) / 1e8,
          exitPrice,
          realizedPnl: Math.round(pnl * 100) / 100,
          pnlPct,
          holdMinutes: holdMin,
          openedAt:    created,
          closedAt,
          volumeUsd:   Math.round(notional * 100) / 100,
        })
      }
      // Sort newest-first
      closedPositionsForHistory.sort((a, b) => b.closedAt - a.closedAt)
    } catch { /* archive empty */ }

    // ── TRADE HISTORY ──────────────────────────────────────────────────────────
    // Detailed closed-position history derived from the live closed archive
    // (up to 500 rows). Each row carries entry/exit price, P&L, hold-time,
    // volume, and direction so the dashboard can render a sortable, filterable
    // history table without round-tripping to the exchange.
    const tradeHistory = closedPositionsForHistory.slice(0, 500)

    // ── PERFORMANCE TIERS ����─────────────────────────────────────────────────────
    // Per-stage (base / main / real / live) performance summary derived from
    // strategy_detail hashes (base/main/real from cross-symbol aggregation,
    // live from closed-archive realised P&L). Each tier holds the fields the
    // dashboard PerformanceTiers card needs: avgPF, winRate, avgHoldMin,
    // totalPnl, sharpe (estimate), drawdown (DDT proxy).
    const buildTierFromSpecPerf = (sp: { aggregated: Record<string, any> }, extra: Record<string, any> = {}) => ({
      symbolCount:       sp.aggregated.symbolCount       || 0,
      totalCreated:      sp.aggregated.totalCreated      || 0,
      totalEntries:      sp.aggregated.totalEntries      || 0,
      totalRunning:      sp.aggregated.totalRunning      || 0,
      avgProfitFactor:   sp.aggregated.avgProfitFactor   || 0,
      avgDrawdownMin:    sp.aggregated.avgDrawdownTime  || 0,
      avgPosPerSet:      sp.aggregated.avgPosPerSet      || 0,
      avgPosEval:        sp.aggregated.avgPosEval        || 0,
      ...extra,
    })

    // Win rate proxy for base/main/real: running-sets / created.
    // Only meaningful when the sets are currently open; empty at end-of-run.
    const baseWinRateProxy  = baseSpecPerf.aggregated.totalCreated  > 0 ? Math.min(100, Math.round((baseSpecPerf.aggregated.totalRunning  / baseSpecPerf.aggregated.totalCreated) * 1000) / 10) : 0
    const mainWinRateProxy  = mainSpecPerf.aggregated.totalCreated  > 0 ? Math.min(100, Math.round((mainSpecPerf.aggregated.totalRunning  / mainSpecPerf.aggregated.totalCreated) * 1000) / 10) : 0
    const realWinRateProxy  = realSpecPerf.aggregated.totalCreated  > 0 ? Math.min(100, Math.round((realSpecPerf.aggregated.totalRunning  / realSpecPerf.aggregated.totalCreated) * 1000) / 10) : 0

    const liveProfitFactor  = liveClosedSumGrossLoss > 0
      ? Math.round((liveClosedSumGrossProfit / liveClosedSumGrossLoss) * 1000) / 1000
      : liveClosedSumGrossProfit > 0 ? 999 : 0
    const liveAvgHoldMin    = liveClosedCount > 0 ? Math.round(liveClosedHoldMinutes / liveClosedCount * 10) / 10 : 0
    const liveWinRate       = liveClosedCount > 0 ? Math.round((liveClosedWins / liveClosedCount) * 1000) / 10 : 0
    const liveAvgRoe        = liveClosedCount > 0 ? Math.round((liveClosedRoeAcc / liveClosedCount) * 10000) / 100 : 0

    // Sharpe estimate for base/main/real — use DDT as a volatility proxy if no
    // per-position returns are available at these pipeline stages (they're
    // evaluation-only, not executed, so true returns are undefined at Base/Main).
    // For Live we derive it from the closed-archive P&L sample.
    const approxSharpe = (ddtHr: number) => ddtHr > 0 ? (1 / ddtHr) * 0.15 : 0 // heuristic: shorter DDT → less volatility

    const performanceTiers = {
      base: buildTierFromSpecPerf(baseSpecPerf, {
        avgHoldMin: 0, // Base has no execution hold-time
        totalPnl: 0, // Base is evaluation-only, no real P&L
        winRate: baseWinRateProxy,
        sharpe: approxSharpe(baseSpecPerf.aggregated.avgDrawdownTime || 0),
        isExecution: false,
      }),
      main: buildTierFromSpecPerf(mainSpecPerf, {
        avgHoldMin: 0,
        totalPnl: 0,
        winRate: mainWinRateProxy,
        sharpe: approxSharpe(mainSpecPerf.aggregated.avgDrawdownTime || 0),
        isExecution: false,
      }),
      real: buildTierFromSpecPerf(realSpecPerf, {
        avgHoldMin: 0,  // Real is promo-stage, not yet exchange execution
        totalPnl: 0,
        winRate: realWinRateProxy,
        sharpe: approxSharpe(realSpecPerf.aggregated.avgDrawdownTime || 0),
        isExecution: false,
      }),
      live: {
        symbolCount:     livePositionSetRelations.length,
        totalCreated:    n(progHash.live_positions_created_count),
        totalEntries:    liveClosedCount + Math.max(0, n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)),
        totalRunning:    Math.max(0, n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)),
        avgProfitFactor: liveProfitFactor,
        avgDrawdownMin:  liveAvgHoldMin,
        avgPosPerSet:    n(progHash.live_positions_created_count) > 0
          ? n(progHash.live_volume_usd_total) / n(progHash.live_positions_created_count)
          : 0,
        totalPnl:        Math.round(liveClosedSumPnl * 100) / 100,
        winRate:         liveWinRate,
        sharpe:          0, // computed from closed-archive returns below
        isExecution:     true,
      },
    }
    // Sharpe from live closed-archive returns
    if (liveClosedCount > 1) {
      const returns = closedPositionsForHistory.slice(0, 500)
        .map((p) => p.pnlPct / 100)
      const avgR = returns.reduce((s, r) => s + r, 0) / returns.length
      const variance = returns.reduce((s, r) => s + Math.pow(r - avgR, 2), 0) / returns.length
      const stdDev = Math.sqrt(variance)
      performanceTiers.live.sharpe = stdDev > 0 ? Math.round((avgR / stdDev) * 100) / 100 : 0
    }

    // --- Prehistoric metadata (range, timeframe, interval progress) ---
    const prehistoricMeta = {
      rangeStart:              prehistoricHash.range_start          || null,
      rangeEnd:                prehistoricHash.range_end            || null,
      rangeDays:               n(prehistoricHash.range_days)        || 1,
      timeframeSeconds:        n(prehistoricHash.timeframe_seconds) || 1,
      intervalsProcessed:      n(prehistoricHash.intervals_processed) || n(progHash.prehistoric_intervals_processed),
      missingIntervalsLoaded:  n(prehistoricHash.missing_intervals)   || n(progHash.prehistoric_missing_loaded),
      currentSymbol:           prehistoricHash.current_symbol         || progHash.prehistoric_current_symbol || "",
      isComplete:              prehistoricHash.is_complete === "1",
      // Aggregate profit factor across every closed prehistoric position
      // — written by `ConfigSetProcessor` after each prehistoric run
      // (`historic_avg_profit_factor` field on the `prehistoric:{id}`
      // hash). Surfaced here so the dashboard tile + Overall Summary can
      // render it without computing PF client-side. 0 when no closed
      // positions yet, so the UI can render "—" for empty states.
      // Prefer the dedicated prehistoric PF field. If it is 0 (written only by the
      // ConfigSetProcessor after a full prehistoric run — absent when reusing a snapshot),
      // fall back to the Real-stage average PF from the strategy-detail hash which IS
      // continuously updated by the coordinator on every cycle.
      historicAvgProfitFactor: (() => {
        const fromPrehistoric = parseFloat(prehistoricHash.historic_avg_profit_factor || "0") || 0
        if (fromPrehistoric > 0) return fromPrehistoric
        // Real-stage avg_profit_factor from strategy_detail:real:{id} hash
        const fromRealDetail = parseFloat(strategyDetailRealHash.avg_profit_factor || "0") || 0
        if (fromRealDetail > 0) return fromRealDetail
        // Last resort: cumulative sum / count from the Real coordinator hash
        const sumPf = n(strategyDetailRealHash.sum_pf_x1000)
        const cnt   = n(strategyDetailRealHash.created_sets)
        return sumPf > 0 && cnt > 0 ? Math.round((sumPf / 1000 / cnt) * 1000) / 1000 : 0
      })(),
      historicAvgProfitFactorCount: n(prehistoricHash.historic_avg_profit_factor_count) ||
        n(strategyDetailRealHash.created_sets),
    }

    // ── WINDOW DATA (last 5min / 60min) ────────────���─────────────────────────
    // Stored in sorted sets: indications:{connId}:window  scored by unix ms timestamp
    // If not present fall back to estimating from cycle counts using elapsed time
    const nowMs = Date.now()
    const ago5m  = nowMs - 5  * 60 * 1000
    const ago60m = nowMs - 60 * 60 * 1000

    let indWindow5m  = 0
    let indWindow60m = 0
    let stratWindow5m  = 0
    let stratWindow60m = 0

    try {
      // Issue all four ZRANGEBYSCORE reads in parallel — they are
      // independent zsets and the previous serial chain added ~4 Redis
      // round-trips of latency to every /stats poll for zero benefit.
      // ZRANGEBYSCORE itself returns the matching members; we only need
      // the count so `.length` is sufficient.
      const [ind5m, ind60m, str5m, str60m] = await Promise.all([
        client.zrangebyscore(`indications:${connectionId}:window`, ago5m,  "+inf").catch(() => [] as string[]),
        client.zrangebyscore(`indications:${connectionId}:window`, ago60m, "+inf").catch(() => [] as string[]),
        client.zrangebyscore(`strategies:${connectionId}:window`,  ago5m,  "+inf").catch(() => [] as string[]),
        client.zrangebyscore(`strategies:${connectionId}:window`,  ago60m, "+inf").catch(() => [] as string[]),
      ])
      indWindow5m    = ind5m.length
      indWindow60m   = ind60m.length
      stratWindow5m  = str5m.length
      stratWindow60m = str60m.length
    } catch { /* non-critical; fall back to zero */ }

    // If window sets are empty, estimate from rate: total / elapsed_minutes * window
    if (indWindow5m === 0 && indTotal > 0) {
      const startedAtMs = n(progHash.started_at) || (nowMs - 3600_000)
      const elapsedMin = (nowMs - startedAtMs) / 60_000 || 1
      const ratePerMin = indTotal / elapsedMin
      indWindow5m  = Math.round(ratePerMin * 5)
      indWindow60m = Math.round(ratePerMin * Math.min(60, elapsedMin))
    }

    // ── METADATA section ─────────────────────────────────────────────�����──────
    // ── STAGE EVAL PERCENT ───────────────────────────────────────────────────
    // Cascade survival rates: same logic as detailed-tracking.ts so the stats
    // endpoint exposes the same values without a second full Redis round-trip.
    //   strategies_{stage}_total     = Sets the stage OUTPUT (promoted)
    //   strategies_{stage}_evaluated = Sets that ENTERED the stage (input)
    // base = 100% (pipeline entry; every Base set that exists passed by definition)
    // main = Main output / Main input  (Base→Main filter survival; expected ~1%)
    // real = Real output / Real input  (Main→Real filter survival)
    const _pct = (num: number, den: number): number =>
      den > 0 ? Math.max(0, Math.min(100, Number(((num / den) * 100).toFixed(1)))) : 0
    // CUMULATIVE FUNNEL (operator spec): each stage's Eval% = sets that
    // survived/evaluated at the stage ÷ the full candidate pool considered at
    // the stage. Main computes that pool as input + related fan-out. Real stores
    // the unified pool directly in `strategies_real_evaluated`, matching
    // `strategy_detail:*:real.evaluated`.
    //   strategies_{stage}_total           = stage OUTPUT (promoted / passed)
    //   strategies_{stage}_evaluated        = stage evaluated pool
    //   strategies_{stage}_related_created  = additionally created at the stage
    const _baseOutput      = Number(progHash.strategies_base_total            || "0")
    const _baseEvaluated   = Number(progHash.strategies_base_evaluated        || "0")
    const _mainOutput      = Number(progHash.strategies_main_total            || "0")
    const _mainInput       = Number(progHash.strategies_main_evaluated        || "0")
    const _mainCreated     = Number(progHash.strategies_main_related_created  || "0")
    const _realOutput      = Number(progHash.strategies_real_total            || "0")
    const _realInput       = Number(progHash.strategies_real_evaluated        || "0")
    // base = evaluated ÷ overall generated (pipeline entry — every Base Set is
    //        evaluated, so ~100% when any exist, expressed as the true ratio).
    // main = main output ÷ (passed-forward-from-base + additionally-created-at-main)
    // real = real output ÷ Real evaluated pool (already includes Real fan-out)
    // live evalPct = sets dispatched this cycle / real sets available for dispatch
    const _liveDispatched = stratCounts.live || 0
    const _liveBase       = stratCounts.real  || 0
    const stageEvalPercent = {
      base: _pct(_baseEvaluated, _baseOutput),
      main: _pct(_mainOutput, _mainInput + _mainCreated),
      real: _pct(_realOutput, _realInput),
      // Live: what fraction of Real-stage survivors were dispatched to exchange
      live: _liveBase > 0 ? Math.min(100, Math.round((_liveDispatched / _liveBase) * 1000) / 10) : 0,
    }

    // ── REAL AVERAGES ────────────��───────────────────────────────────────────
    // Average real_samples:{id} ring buffer over 5-min window. Falls back to
    // live snapshot when no in-window samples exist (cold boot / fresh session).
    const _REAL_AVG_WINDOW_MS = 5 * 60 * 1000
    const realAverages = await (async () => {
      try {
        const raw = (await client
          .lrange(`real_samples:${connectionId}`, 0, -1)
          .catch(() => [])) as string[]
        const cutoff = Date.now() - _REAL_AVG_WINDOW_MS
        let nSets = 0, nPps = 0, nOpen = 0, count = 0
        for (const entry of raw) {
          try {
            const s = JSON.parse(entry) as { t: number; sets: number; pps: number; open: number }
            if (!s || typeof s.t !== "number" || s.t < cutoff) continue
            nSets += Number(s.sets) || 0
            nPps  += Number(s.pps)  || 0
            nOpen += Number(s.open) || 0
            count++
          } catch { /* skip malformed */ }
        }
        if (count === 0) {
          return {
            activeSets: stratCounts.real || 0,
            posPerSet:  0,
            posOpen:    0,
            samples:    0,
          }
        }
        return {
          activeSets: Number((nSets / count).toFixed(2)),
          posPerSet:  Number((nPps  / count).toFixed(2)),
          posOpen:    Number((nOpen / count).toFixed(2)),
          samples:    count,
        }
      } catch {
        return { activeSets: 0, posPerSet: 0, posOpen: 0, samples: 0 }
      }
    })()

    // Phase derivation: prefer the explicit engine_progression field.
    // When it's absent (fresh engine that hasn't written phase yet, or
    // just-started before config-set-processor runs), fall back through
    // observable signals so the UI never shows "unknown":
    //   1. ep.phase — explicit from engine_progression Redis key
    //   2. es.status=running + live cycles → "live_trading"
    //   3. es.status=running + historic not done → "prehistoric_data"
    //   4. es.status=running → "realtime"
    //   5. es.status=stopped/idle → "stopped"/"idle"
    //   6. realtimeIndicationCycles > 0 (engine running, phase not yet written) → "realtime"
    //   7. final fallback → "idle" (not "unknown" — cleaner UX)
    const phase: string = (() => {
      // On a fresh server boot the engine_progression Redis hash retains the
      // previous phase ("realtime", "live_trading", etc.).  If the in-memory
      // coordinator says definitively stopped, always return "idle" — the
      // stale Redis phase is not trustworthy.
      if (engineIsStopped) {
        // Prefer explicit ep.phase when it matches stopped/idle, otherwise idle.
        if (ep?.phase === "stopped") return "stopped"
        return "idle"
      }
      if (ep?.phase && ep.phase !== "unknown") return ep.phase
      if (es.status === "stopped") return "stopped"
      if (es.status === "idle")    return "idle"
      if (es.status === "running" || realtimeIsActive) {
        if (historicIsComplete || es.prehistoric_data_loaded === "1" || es.prehistoric_data_loaded === true) {
          return "live_trading"
        }
        if (historicSymbolsProcessed > 0) return "prehistoric_data"
        return "realtime"
      }
      if (realtimeIndicationCycles > 0) return "realtime"
      return "idle"
    })()
    const progress = n(ep?.progress)
    const message  = ep?.detail || ep?.message || ""
    const lastUpdate = progHash.last_update || realtimeHash.last_cycle_at || new Date().toISOString()

    let redisDbEntries = 0
    try { redisDbEntries = await client.dbSize() } catch { /* non-critical */ }

    // ── Volume configuration snapshot ─────────────────��──────────────────────
    // Resolve the EFFECTIVE live/preset volume factors exactly as
    // VolumeCalculator.calculateVolumeForConnection does, so the dashboard
    // can show what multiplier is actually being applied to live orders rather
    // than making the operator guess which settings path won.
    let volumeConfig: {
      liveVolumeFactor: number
      presetVolumeFactor: number
      tradeMode: "main" | "preset"
      positionCostPct: number
      positionsAverage: number
      source: string
    } = {
      liveVolumeFactor:   1,
      presetVolumeFactor: 1,
      tradeMode:          "main",
      positionCostPct:    0.02,
      positionsAverage:   2,
      source:             "default",
    }
    try {
      const [vcConn, vcApp] = await Promise.all([
        getConnection(connectionId).catch(() => null),
        getAppSettings().catch(() => null),
      ])
      // Build the merged settings object the same way calculateVolumeForConnection does:
      // global app_settings + connection_settings overlay + connection record fields.
      const vcSettings: Record<string, unknown> = { ...(vcApp as Record<string, unknown> || {}) }
      try {
        const vcConnS = (await client.hgetall(`connection_settings:${connectionId}`).catch(() => null)) || {}
        for (const [k, v] of Object.entries(vcConnS)) {
          if (v !== undefined && v !== null && v !== "") vcSettings[k] = v
        }
      } catch { /* best-effort */ }
      if (vcConn) {
        const CONN_FIELDS = [
          "exchangePositionCost", "exchange_position_cost", "positionCost",
          "positions_average", "positionsAverage",
          "live_volume_factor", "preset_volume_factor",
          "leveragePercentage", "useMaximalLeverage",
          "is_live_trade", "is_preset_trade",
        ] as const
        for (const f of CONN_FIELDS) {
          const v = (vcConn as Record<string, unknown>)[f]
          if (v !== undefined && v !== null && v !== "") vcSettings[f] = v
        }
      }
      const resolved = VolumeCalculator.resolveLiveEngine(vcConn, vcSettings)
      const posCostRaw = Number(
        vcSettings.exchangePositionCost ?? vcSettings.positionCost ?? vcSettings.exchange_position_cost ?? "0.02"
      )
      const posAvgRaw = Number(vcSettings.positions_average ?? vcSettings.positionsAverage ?? "2")
      volumeConfig = {
        liveVolumeFactor:   resolved.mainVolumeFactor,
        presetVolumeFactor: resolved.presetVolumeFactor,
        tradeMode:          resolved.tradeMode,
        positionCostPct:    Number.isFinite(posCostRaw) && posCostRaw > 0 ? posCostRaw : 0.02,
        positionsAverage:   Number.isFinite(posAvgRaw) && posAvgRaw > 0 ? posAvgRaw : 2,
        source:             vcConn?.live_volume_factor ? "connection"
                            : (vcSettings.volume_factor_live ? "app_settings" : "default"),
      }
    } catch { /* non-critical — keep defaults */ }

    // ── Build response ──────────────────────────────────────────────────────
    return NextResponse.json({
      success: true,
      connectionId,

      historic: {
        symbolsProcessed:       historicSymbolsProcessed,
        symbolsTotal:           historicSymbolsTotal,
        candlesLoaded:          historicCandlesLoaded,
        indicatorsCalculated:   historicIndicatorsCalculated,
        cyclesCompleted:        historicCyclesCompleted,
        isComplete:             historicIsComplete,
        progressPercent:        historicProgressPercent,

        // Frame/interval counters — at 1-second timeframes the source market
        // data only holds ~480 candles per 8-hour window, so `candlesLoaded`
        // stays small. The real "processed data units" count lives under
        // `framesProcessed` (= intervalsProcessed from the config-set
        // processor, one frame per timeframe tick across the range).
        framesProcessed:        n(prehistoricMeta.intervalsProcessed),
        framesMissingLoaded:    n(prehistoricMeta.missingIntervalsLoaded),
        timeframeSeconds:       n(prehistoricMeta.timeframeSeconds) || 1,

        // ── Historic profit factor + executed positions ────────────────
        // Two operator-requested overview metrics that previously lived
        // only inside the per-stage `strategyDetail` block (PF) or the
        // `liveExecution` block (positions created/closed). Surfaced
        // alongside the prehistoric counters so the QuickStart card and
        // the Overall Summary can render them without re-deriving from
        // multiple fields.
        //
        //   * `avgProfitFactor` — historic-wide PF (all closed
        //     prehistoric positions, sum(+pct) / |sum(-pct)|, capped at
        //     9.999). 0 ⇒ no closed positions yet.
        //   * `avgProfitFactorCount` — sample count behind the average.
        //   * `executedPositions` — cumulative live exchange positions
        //     created since engine start (`live_positions_created_count`).
        //     This is the canonical "Executed Positions" metric the spec
        //     refers to: every Real→Live promotion that resulted in an
        //     actual exchange order.
        avgProfitFactor:        Math.round(prehistoricMeta.historicAvgProfitFactor * 1000) / 1000,
        avgProfitFactorCount:   prehistoricMeta.historicAvgProfitFactorCount,
        executedPositions:      n(progHash.live_positions_created_count),

        // Prehistoric-processing churn counters — tick every time the engine spins
        // through its evaluation loop, incl. idle/warmup ticks. Kept here so the UI
        // can hide them from the primary live-progression display while still
        // exposing them for debugging / operations dashboards.
        processing: {
          indicationChurnCycles: churnIndicationCycles,
          strategyChurnCycles:   churnStrategyCycles,
        },
      },


      realtime: {
        indicationCycles: realtimeIndicationCycles,
        strategyCycles:   realtimeStrategyCycles,
        realtimeCycles,
        // ── Per-processor cycle counters (cumulative, hincrby-backed) ──
        // Each processor maintains TWO independent counters:
        //   *_cycle_count       — every tick (incl. idle/empty/gated)
        //   *_live_cycle_count  — only ticks that produced actual work
        // The dashboard surfaces both so the operator can spot imbalances
        // (e.g. realtime ticking but never doing live work = no positions).
        cycleCounters: {
          indication:       churnIndicationCycles,
          indicationLive:   liveIndicationCycles,
          strategy:         churnStrategyCycles,
          strategyLive:     liveStrategyCycles,
          realtime:         realtimeCycles,
          realtimeLive:     liveRealtimeCycles,
        },
        // ── Pseudo-position mark-to-market visibility ────────────────
        // Cumulative counters written by RealtimeProcessor.processRealtimeUpdates
        // on every tick that touched ≥1 open pseudo-position. Lets the
        // dashboard prove the "open positions are recalculated INDEPENDENT
        // of indication/strategy" invariant — independent of indication/
        // strategy cycle counters above.
        pseudoPositionUpdates: {
          totalUpdates:     n(progHash.pseudo_positions_updated_count),
          updateCycles:     n(progHash.pseudo_positions_update_cycles),
          lastUpdateAt:     progHash.pseudo_positions_last_update_at || null,
          lastBatchSize:    n(progHash.pseudo_positions_last_count),
        },
        // Cross-processor cumulative tick total — independent of the
        // per-Set 250-entry DB cap. Counts every loop tick across all
        // three processors since the engine started.
        framesProcessed,
        // `indTotal` is the better canonical count: it is the per-type
        // summation (direction + move + active + optimal + auto) which
        // falls back to `indicationsTotal` (progHash.indications_count)
        // when no per-type keys exist. Using `indicationsTotal` alone
        // here caused the realtime.indicationsTotal tile to show 0
        // even when 92K+ indications had been generated, because the
        // `indications_count` key was only written when per-type counts
        // were non-zero on the SAME cycle — a write-order race.
        indicationsTotal: indTotal,
        // Same principle for strategies: use stratTotal (computed from stratCounts.real
        // and fallback to strategiesTotal) instead of stale progHash value.
        strategiesTotal: stratTotal,
        positionsOpen,
        // Sets + Positions are the canonical "continuous live progression" anchors
        // the user relies on. These come straight from atomic hincrby writes
        // inside StrategyCoordinator (sets) and live-stage (positions/orders).
        setsCreated: {
          base:  stratCounts.base  || 0,
          main:  stratCounts.main  || 0,
          real:  stratCounts.real  || 0,
          // Live is the final dispatch stage (sets actually selected for order dispatch).
          // Written per-cycle by createLiveSets into strategies_active:{conn} hash.
          live:  stratCounts.live  || 0,
          // Pipeline-aware total: Base → Main → Real → Live is a cascade, not
          // four independent populations. Summing stage counts double/triple
          // counts the same logical Sets and is the source of inflated Main/
          // Real totals in production dashboards. `stratTotal` is the canonical
          // deepest surviving Set count (Real, with safe fallback).
          total: stratTotal,
        },
        positions: {
          opened:    n(progHash.live_positions_created_count),
          closed:    n(progHash.live_positions_closed_count),
          open:      Math.max(
            0,
            n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count) +
            Math.max(0, n(progHash.live_orders_placed_count) - n(progHash.live_orders_filled_count))
          ),
          ordersPlaced: n(progHash.live_orders_placed_count),
          ordersFilled: n(progHash.live_orders_filled_count),
        },
        isActive:         realtimeIsActive,
        successRate:      Math.round(successRate * 10) / 10,
        avgCycleTimeMs,
      },

      breakdown: {
        // EVERY indication type tracked by `IndicationSetsProcessor` is
        // surfaced here — `active_advanced` was previously silently
        // dropped from this response despite the engine generating it.
        // Each value is the cumulative count since run start.
        indications: {
          direction:      indCounts.direction      || 0,
          move:           indCounts.move           || 0,
          active:         indCounts.active         || 0,
          activeAdvanced: indCounts.active_advanced || 0,
          optimal:        indCounts.optimal        || 0,
          auto:           indCounts.auto           || 0,
          total:          indTotal,
        },
        strategies: {
          base: stratCounts.base || 0,
          main: stratCounts.main || 0,
          real: stratCounts.real || 0,
          live: stratCounts.live || 0,
          // Pipeline-aware total — do not sum cascade stages. Base/Main/Real
          // contain the same logical Sets at successive filters, so summing
          // stages inflates counts and makes Main look too high in prod.
          total: stratTotal,
          baseEvaluated: (() => {
            // Validate constraint: eval <= sets
            const base = stratCounts.base || 0
            const eval_val = stratEvaluated.base || 0
            // Transient read-race: clamp silently (expected, not a bug).
            if (eval_val > base && base > 0) return base
            return eval_val
          })(),
          mainEvaluated: (() => {
            const main = stratCounts.main || 0
            // The active hash writes baseSets.length (= base candidate count) into
            // {symbol}:main:evaluated — the correct "inputs to the main stage" count.
            // But the user expects "how many main sets were evaluated" which equals
            // main (all main sets are evaluated; pass rate is 100% at main stage).
            // The standalone `strategies:{id}:main:evaluated` key correctly writes
            // mainSets.length, so prefer it when it's larger.
            const eval_val = stratEvaluated.main || 0
            // When the active-hash eval is smaller than main (the base-input
            // interpretation), treat the main count itself as the evaluated count:
            // all main sets undergo full PF/DDT evaluation.
            if (main > 0 && eval_val < main) return main
            // Transient read-race: clamp silently (expected, not a bug).
            if (eval_val > main && main > 0) return main
            return eval_val || main
          })(),
          realEvaluated: (() => {
            // NOTE: realEvaluated = Main sets that ENTERED Real-stage PF evaluation
            // (the INPUT count, written as mainPFEligible by the coordinator).
            // stratCounts.real = Real sets that PASSED and survived to dispatch
            // (the OUTPUT count), plus any related/axis-created fan-out that
            // the Real stage materialized for this snapshot. With fan-out
            // enabled, output can legitimately exceed the upstream input by
            // that related-created amount, so do NOT clamp realEvaluated here.
            return stratEvaluated.real || 0
            // NOTE: Real accounting has three meanings:
            // - real:input = upstream Main PF-eligible input before Real fan-out.
            // - real:relatedCreated = current-cycle Real fan-out added to input.
            // - stratCounts.real = Real passed output after PF/DDT filtering.
            // Public realEvaluated is every Real Set considered after fan-out, so
            // prefer input + relatedCreated and fall back to the writer's evaluated
            // field for mixed deploys. It may exceed passed output; do not clamp.
            const afterFanOut = activeRealInput + activeRealRelatedCreated
            return afterFanOut || stratEvaluated.real || 0
          })(),
        },
      },

      // ── CURRENTLY-ACTIVE counts (per cycle, not cumulative) ───────────
      // The Overview surfaces these as the headline numbers because the
      // operator wants to see what's alive RIGHT NOW — not "how many
      // were ever created since boot". Engine writers overwrite the
      // backing hashes once per cycle so these values track live state.
      // See engine writers in:
      //   - lib/indication-sets-processor.ts → indications_active:{id}
      //   - lib/strategy-coordinator.ts      → strategies_active:{id}
      activeCounts: {
        indications: {
          direction:      activeIndByType.direction        || 0,
          move:           activeIndByType.move             || 0,
          active:         activeIndByType.active           || 0,
          activeAdvanced: activeIndByType.active_advanced  || 0,
          optimal:        activeIndByType.optimal          || 0,
          auto:           activeIndByType.auto             || 0,
          total:          activeIndTotal,
        },
        strategies: {
          base:  activeStratByStage.base  || 0,
          main:  activeStratByStage.main  || 0,
          real:  activeStratByStage.real  || 0,
          total: activeStratTotal,
        },
      },

      // ── ACTIVE PROGRESSING (sets / trackings / positions) ───────────
      // Per spec: "count for Indications and Strategies Active
      // Progressing Sets, trackings .. active positions."
      //
      // Three orthogonal axes, computed per indication-type and per
      // strategy-stage:
      //
      //   1. `sets`      — distinct (symbol × type/stage) pairs whose
      //                    latest cycle reported a non-zero qualified
      //                    count. This is the cardinality of Sets
      //                    currently producing entries.
      //   2. `trackings` — cumulative entries that have ever been
      //                    written to those Sets. Mirrors the
      //                    `breakdown` totals so the operator sees
      //                    "how much tracked data has been observed".
      //   3. `positions` — open positions held by that
      //                    type/stage. For Strategies the canonical
      //                    mapping is:
      //                       base → pseudoOpen   (mark-to-market)
      //                       main → pseudoOpen   (Main is a Set
      //                                            evaluation stage,
      //                                            shares the pseudo
      //                                            ledger; surfaced for
      //                                            symmetry, identical
      //                                            value to base)
      //                       real → realOpen     (Real-stage promotions)
      //                       live → liveOpen     (exchange orders)
      //                    For Indications `positions` is the count
      //                    of currently-qualified indications (one
      //                    per slot held).
      //
      // All three are read from already-collected variables — zero
      // additional Redis calls.
      activeProgressing: {
        indications: {
          direction:      { sets: activeSetsIndByType.direction       || 0, trackings: indCounts.direction       || 0, positions: activeIndByType.direction        || 0 },
          move:           { sets: activeSetsIndByType.move            || 0, trackings: indCounts.move            || 0, positions: activeIndByType.move             || 0 },
          active:         { sets: activeSetsIndByType.active          || 0, trackings: indCounts.active          || 0, positions: activeIndByType.active           || 0 },
          activeAdvanced: { sets: activeSetsIndByType.active_advanced || 0, trackings: indCounts.active_advanced || 0, positions: activeIndByType.active_advanced  || 0 },
          optimal:        { sets: activeSetsIndByType.optimal         || 0, trackings: indCounts.optimal         || 0, positions: activeIndByType.optimal          || 0 },
          auto:           { sets: activeSetsIndByType.auto            || 0, trackings: indCounts.auto            || 0, positions: activeIndByType.auto             || 0 },
          total:          { sets: activeSetsIndTotal,                       trackings: indTotal,                       positions: activeIndTotal },
        },
        strategies: (() => {
          // ─��� Actively-running per stage (operator spec) ─────────────
          // Source of truth: `strategy_detail:{conn}:{stage}.sets_running_now`,
          // written by strategy-coordinator each cycle using parent-base
          // active_config_keys membership. Fallback only to the per-symbol
          // presence count — never fall back to total-ever-created (stratCounts)
          // which would inflate the figure to thousands when nothing is running.
          const baseRun = n(stratDetail.base?.setsRunningNow) || activeSetsStratByStage.base || 0
          const mainRun = n(stratDetail.main?.setsRunningNow) || activeSetsStratByStage.main || 0
          const realRun = n(stratDetail.real?.setsRunningNow) || activeSetsStratByStage.real || 0
          const liveRun = n(stratDetail.live?.setsRunningNow) || pseudoRunningSets || 0

          // Cascade: each downstream stage is a subset — cap child ≤ parent.
          const cappedMain = Math.min(mainRun, stratCounts.main || mainRun)
          const cappedReal = Math.min(realRun, cappedMain)
          const cappedLive = Math.min(liveRun, cappedReal)

          // Prefer key-scan (liveOpenScanned) as it survives server restarts.
          // Counter arithmetic (created-closed) drifts when InlineLocalRedis
          // resets on restart. Include pending-fill placed-but-not-filled orders
          // only when both sources show 0 open filled positions.
          const counterOpen = Math.max(
            0,
            n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count),
          )
          const pendingFills = Math.max(0, n(progHash.live_orders_placed_count) - n(progHash.live_orders_filled_count))
          const livePositions = liveOpenScanned > 0
            ? liveOpenScanned + pendingFills
            : Math.max(0, counterOpen + pendingFills)

          // Pipeline-aware total — the deepest active stage is canonical.
          const totalRun = Math.max(baseRun, cappedMain, cappedReal, cappedLive)

          // positions semantics per stage:
          //   base/main: how many sets have open pseudo-positions (evaluation stage).
          //              pseudoRunningSets = scard(active_config_keys) = ground truth.
          //              Fall back to pseudoOpen (individual position objects count).
          //   real:      promoted sets currently active — realOpen from real:position:*
          //              keys is ground truth. Do NOT fall back to stratCounts.real
          //              (that is 1920 = total-ever-created, not open positions).
          //              Fall back to setsRunningNow (active coordination count)
          //              which is a tight upper bound on truly-open real positions.
          //   live:      actual exchange positions (created − closed + unfilled orders).
          const baseMainPos = pseudoRunningSets || pseudoOpen
          // Use setsRunningNow from the Real stage detail (already collected
          // in the stage loop above) as the fallback — it is the count of
          // Real Sets that are actively coordinating, which is the correct
          // semantic for "open real positions" when realOpen=0.
          const realDetailRunning = n(stratDetail.real?.setsRunningNow)
          const realPos = realOpen || realDetailRunning || 0
          return {
            base: { sets: baseRun,    trackings: stratCounts.base || 0, positions: baseMainPos },
            main: { sets: cappedMain, trackings: stratCounts.main || 0, positions: baseMainPos },
            real: { sets: cappedReal, trackings: stratCounts.real || 0, positions: realPos },
            live: {
              sets:      cappedLive,
              trackings: stratCounts.live || 0,
              positions: livePositions,
            },
            total: {
              sets:      totalRun,
              trackings: stratTotal,
              positions: Math.max(baseMainPos, realPos, livePositions),
            },
          }
        })(),
      },

      // Per-stage strategy detail — avg positions per set, created sets, avg profit factor, avg processing time,
      // avg pos eval for Real, pass ratios, drawdown time
      strategyDetail: {
        base: stratDetail.base,
        main: stratDetail.main,
        real: stratDetail.real,
        // 4th tier — computed from local Redis (progression + closed archive).
        // Mirrors Real's shape but reflects true exchange-side outcomes.
        live: stratDetail.live,
      },

      // Per-variant strategy breakdown (Default / Trailing / Block / DCA).
      // Written by StrategyCoordinator.createMainSets based on each entry's
      // positionState + leverage + size profile. The `overall` row is a
      // weighted aggregate so the UI can show one canonical PF/DDT alongside
      // the four variant rows. These counts are cumulative since run start.
      strategyVariants: {
        default:  variantDetail.default,
        trailing: variantDetail.trailing,
        block:    variantDetail.block,
        dca:      variantDetail.dca,
        overall:  variantOverall,
      },

      // ── Main-stage COORDINATION snapshot ─────────────────────────────────
      // Answers "is the Main stage coordinating correctly?" at a glance:
      //   • activeVariants           — names of variants gated ACTIVE this cycle
      //                                (default is always on; trailing/block/dca
      //                                require matching position context).
      //   • lastCreated / lastReused — how many variant Sets were built fresh
      //                                vs. reused from the fingerprint cache
      //                                last cycle. High reuse = cache working.
      //   • totalCreated / totalReused — cumulative counters over the run.
      //   • reuseRate                — totalReused / (totalCreated + totalReused)
      //                                as a percent. Higher is better.
      //   • positionContext          — live snapshot of the pseudo-position
      //                                state that gates variant selection.
      mainCoordination: (() => {
        const activeVariantsStr = progHash.strategies_main_active_variants || "default"
        const totalCreated = n(progHash.strategies_main_related_created)
        const totalReused  = n(progHash.strategies_main_related_reused)
        const totalCycles  = n(progHash.strategies_main_cycles)
        const reuseDenom   = totalCreated + totalReused

        // ── Build per-axis-window arrays from `axis_windows:{id}` ──────��──
        //
        // Spec mapping:
        //   prev  : N ∈ 0..12 (closed lookback window)
        //   last  : N ∈ 0..4  (last-N wins/losses magnitude)
        //   cont  : N ∈ 0..8  (open continuous positions)
        //   pause : N ∈ 0..8  (last-N validation window)
        //
        // For each axis we emit an array of `{ window, sets, pos }` so the
        // dashboard can render a compact 0..N strip without re-deriving
        // positional offsets. `sets` = cumulative Sets that landed under
        // window N; `pos` = total entries (≈ "position configurations")
        // those Sets carried. 0-bucket is included so consumers can show
        // "axis was inactive N times" without special-casing the absence.
        const buildAxis = (axis: "prev" | "last" | "cont" | "pause", maxN: number) => {
          const out: Array<{ window: number; sets: number; pos: number }> = []
          for (let i = 0; i <= maxN; i++) {
            out.push({
              window: i,
              sets: n(axisWindowsHash[`${axis}_${i}_sets`]),
              pos:  n(axisWindowsHash[`${axis}_${i}_pos`]),
            })
          }
          return out
        }

        return {
          activeVariants:       activeVariantsStr.split(",").filter(Boolean),
          activeVariantCount:   n(progHash.strategies_main_active_variant_count),
          lastCreated:          n(progHash.strategies_main_last_created),
          lastReused:           n(progHash.strategies_main_last_reused),
          totalCreated,
          totalReused,
          totalCycles,
          reuseRate: reuseDenom > 0 ? Math.round((totalReused / reuseDenom) * 1000) / 10 : 0,
          positionContext: {
            continuous:  n(progHash.strategies_main_ctx_continuous),
            lastWins:    n(progHash.strategies_main_ctx_last_wins),
            lastLosses:  n(progHash.strategies_main_ctx_last_losses),
            prevLosses:  n(progHash.strategies_main_ctx_prev_losses),
            prevTotal:   n(progHash.strategies_main_ctx_prev_total),
            updatedAt:   n(progHash.strategies_main_ctx_updated_at),
          },
          // ── Per-axis Position-Count windows (cumulative across run) ─────
          // Spec: *"step 1 previous 1-12; Last (of previous) 1-4;
          // continuous 1-8 and Pause 1-8"*. Each axis emits its full 0..N
          // bucket strip, suitable for a compact "axis summary" UI row.
          axisWindows: {
            prev:   buildAxis("prev",  12),
            last:   buildAxis("last",  4),
            cont:   buildAxis("cont",  8),
            pause:  buildAxis("pause", 8),
            updatedAt: n(axisWindowsHash.updated_at),
          },
        }
      })(),

      // ��─ Live Exchange Execution metrics ─────────────────────────────────
      // Read directly from progression hash counters written by the live-stage
      // pipeline (see lib/trade-engine/stages/live-stage.ts). Every stage of
      // the pipeline increments one of these so the UI can show a real-time
      // picture of exchange-level activity.
      // ── OPEN POSITIONS & ACCUMULATED VOLUME ───────������────────────────────
      // Snapshot of every "currently holding exposure" layer of the
      // mirroring pipeline. CRITICAL semantics — pseudo/real/live are
      // NOT independent pools: they represent the SAME trading signal
      // being mirrored down through evaluation stages before finally
      // becoming an exchange order. Therefore:
      //
      //   • Volume is a LIVE-ONLY concept. The only USD exposure that
      //     matters is what actually sits on the exchange. Pseudo and
      //     Real positions carry evaluation-only notionals that MUST
      //     NOT be summed with live volume — doing so would grossly
      //     overstate real exposure. We surface counts for pseudo/
      //     real (pipeline health), and volume only for live.
      //
      //   • Layers:
      //       pseudo — Strategy-level continuous evaluation (Base).
      //                Count only. Running-sets index feeds the live
      //                coordination join.
      //       real   — Main→Real promotions that cleared gating.
      //                Count only.
      //       live   — Actual exchange positions. Count + USD volume
      //                (progHash.live_volume_usd_total is the single
      //                authoritative exposure figure).
      //
      //   • Coordination principle: multiple equivalent Sets that
      //     share the same Base + ranges produce ONE consolidated
      //     exchange position, not N duplicate orders. The
      //     `live.positions[].mirroredSets` array carries those
      //     equivalent Sets so the UI can render "N Sets → 1 Order".
      openPositions: (() => {
        // IMPORTANT: use the scan-derived outer variables (from the actual
        // smembers/lrange scans above), NOT progHash counters. The progHash
        // fields `pseudo_positions_created_count` and `real_positions_created_count`
        // are NOT written anywhere in the canonical schema — they always resolve
        // to 0, which caused openPositions.pseudo.open and openPositions.real.open
        // to always show 0 even when there were genuine open positions.
        // `pseudoOpen` and `realOpen` already hold the correct scan-derived counts.
        const mainOpen = 0  // Main has no independent open-position store (uses pseudo ledger)
        // liveOpenScanned is the authoritative count: it reflects the actual
        // number of open live:position:{id} keys in Redis at this moment.
        // Counter arithmetic (created - closed) drifts after a server restart
        // because InlineLocalRedis counters reset while position keys persist.
        // Prefer liveOpenScanned; fall back to counter arithmetic only when
        // the scan returned 0 but counters suggest positions exist (e.g. the
        // scan ran before positions were written on a fresh first cycle).
        const liveCounterOpen = Math.max(
          0,
          n(progHash.live_positions_created_count) -
            n(progHash.live_positions_closed_count),
        )
        const liveOpen = liveOpenScanned > 0
          ? liveOpenScanned
          : liveCounterOpen
        const liveVolumeUsd = n(progHash.live_volume_usd_total)
        const liveVolumeUsdR = Math.round(liveVolumeUsd * 100) / 100
        // Used-balance (margin) cumulative counter — incremented in
        // lock-step with `live_volume_usd_total` by live-stage.ts at both
        // creation and accumulation points. This is the canonical "USDT
        // used balance" surface the UI should prefer over the leveraged
        // notional figure (per the operator's spec). Falls back to the
        // current portfolio aggregate when the cumulative counter is
        // empty (legacy connection that started before margin tracking).
        // Prefer the new cent-precision counter so sub-dollar margins
        // (a $5 fill at 125x leverage = $0.04 margin) survive integer
        // truncation. Falls back to the legacy dollar counter, then
        // to the open-portfolio aggregate.
        const liveMarginCents = n(progHash.live_margin_cents_total)
        const liveMarginUsdR = liveMarginCents > 0
          ? Math.round(liveMarginCents) / 100
          : (() => {
              const dollars = n(progHash.live_margin_usd_total)
              return dollars > 0
                ? Math.round(dollars * 100) / 100
                : Math.round(liveAggTotalMarginUsd * 100) / 100
            })()

        // Real-stage active validated positions can be represented either by
        // persisted RealPosition rows (`realOpen`) or, for coordinator-only
        // strategy validation cycles, by Real detail's setsRunningNow. Use the
        // validated Real-stage snapshot as fallback so the UI does not show 0
        // active Real positions while Real Sets are actively coordinating.
        const realDetailRunning = n(stratDetail.real?.setsRunningNow)
        const realValidatedActivePositions = realOpen || realDetailRunning || 0
        const realActiveAvgDisplay = realValidatedActivePositions > 0 && realActivePosSamples === 0
          ? realValidatedActivePositions
          : realActivePosAverage

        // Full Exchange Position Details per live position. Contains
        // everything the operator needs to evaluate trade health
        // (leverage, margin at risk, liquidation distance, SL/TP,
        // ROI) WITHOUT having to hit /api/trading/live-positions
        // separately. Also carries the mirroring coordination payload
        // (`mirroredSets`) so the UI can render "N equivalent Sets
        // consolidated into this 1 exchange order" without a second
        // join against the pseudo ledger.
        const liveMirroring = livePositionSetRelations
          .slice(0, 50)
          .map((p) => ({
            id:            p.id,
            symbol:        p.symbol,
            direction:     p.direction,
            // Exchange exposure
            volumeUsd:     p.volumeUsd,
            quantity:      p.quantity,
            leverage:      p.leverage,
            marginType:    p.marginType,
            marginUsd:     p.marginUsd,
            // Prices
            entryPrice:    p.entryPrice,
            markPrice:     p.markPrice,
            liquidationPrice:       p.liquidationPrice,
            liquidationDistancePct: p.liquidationDistancePct,
            // PnL
            unrealizedPnl: p.unrealizedPnl,
            roiPct:        p.roiPct,
            // Risk management
            stopLossPrice:   p.stopLossPrice,
            takeProfitPrice: p.takeProfitPrice,
            // Exchange references
            orderId:            p.orderId,
            stopLossOrderId:    p.stopLossOrderId,
            takeProfitOrderId:  p.takeProfitOrderId,
            // Lifecycle
            status:        p.status,
            createdAt:     p.createdAt,
            updatedAt:     p.updatedAt,
            syncedAt:      p.syncedAt,
            realPositionId: p.realPositionId,
            // Coordination fan-in
            mirroredSetCount: p.setKeys.length,
            mirroredSets:     p.setKeys.map((s) => ({
              setKey: s.setKey,
              count:  s.count,
            })),
            resolution: p.resolution,
          }))

        return {
          pseudo: {
            open:         pseudoOpen,                // count only
            runningSets:  pseudoRunningSets,
            topSets:      pseudoTopSets,             // { setKey, count }
          },
          real: {
            open:         realValidatedActivePositions, // active validated Real-stage position count
            // Running average of currently-active validated Real
            // positions, accumulated across all /stats fetches for this
            // connection. UNBOUNDED — does not share the per-set 250
            // entry cap. See "Running-avg of active validated Real
            // positions" block above for the storage layout. Resets
            // when ResetDB clears `progression:{id}`.
            activeAvg:    Math.round(realActiveAvgDisplay * 100) / 100,
            activeSamples: realActivePosSamples,
          },
          live: {
            open:         liveOpen,                  // count
            volumeUsd:    liveVolumeUsdR,            // exchange USD notional (qty × price, leveraged exposure)
            // Used-balance / margin USDT — the value of the *capital
            // committed* to live exchange positions, NOT the leveraged
            // notional. This is what the dashboard should display under
            // "USDT" labels per operator spec. Equals the cumulative
            // sum of (notional / leverage) across every live fill +
            // accumulation, with a fallback to the live portfolio
            // aggregate when no historical counter exists.
            marginUsd:    liveMarginUsdR,
            openScanned:  liveOpenScanned,
            positions:    liveMirroring,
            resolution: {
              pseudo:       liveResolvedViaPseudo,
              realFallback: liveResolvedViaReal,
              unresolved:   liveUnresolvedCount,
            },
            // ── Portfolio-wide exchange aggregates ─────────��────
            // Sum of `positions[]` — guarantees the Live strip
            // totals always equal what's visible in the rows.
            aggregate: {
              totalUnrealizedPnl: liveAggTotalUnrealizedPnl,
              totalMarginUsd:     liveAggTotalMarginUsd,
              totalVolumeUsd:     liveAggTotalVolumeUsd,
              portfolioRoiPct:    liveAggPortfolioRoiPct,
              inProfit:           liveAggInProfit,
              inLoss:             liveAggInLoss,
              nearLiquidation:    liveAggNearLiquidation,
              staleSync:          liveAggStaleSync,
              consolidatedSetsTotal: liveAggConsolidatedSets,
            },
            // Per-symbol position groupings (count of long/short positions +
            // USD totals, sorted by descending size). Lets the dashboard
            // render "BTCUSDT L:2 S:1" chips under the Positions row without
            // re-deriving from `positions[]`. Empty array when no live
            // positions exist.
            bySymbol: liveBySymbol,
          },
          overall: {
            // Pipeline-health counters. Semantically distinct from
            // each other — do NOT sum.
            pipelineEvalOpen: pseudoOpen,   // strategies evaluating
            exchangeOpen:     liveOpen,     // orders actually on exchange
            exchangeVolumeUsd: liveVolumeUsdR,
            exchangeUnrealizedPnl: liveAggTotalUnrealizedPnl,
            exchangeMarginUsd:     liveAggTotalMarginUsd,
            runningSetsCount: pseudoRunningSets,
          },
        }
      })(),

      liveExecution: {
        // Orders
        ordersPlaced:     n(progHash.live_orders_placed_count),
        ordersFilled:     n(progHash.live_orders_filled_count),
        ordersFailed:     n(progHash.live_orders_failed_count),
        ordersRejected:   n(progHash.live_orders_rejected_count),
        ordersSimulated:  n(progHash.live_orders_simulated_count),
        // Accumulated entries (extra fills merged into an existing
        // exchange position because multiple Real-stage Set signals
        // for the same symbol+direction landed on a still-open live
        // position). This is the canonical "Pos Accumulated" metric
        // the user wants surfaced at Real → Live: it's how many
        // upstream Set signals were absorbed without spawning new
        // exchange orders, keeping the live exposure consolidated.
        ordersAccumulated: n(progHash.live_orders_accumulated_count),
        // Positions
        positionsCreated: n(progHash.live_positions_created_count),
        positionsClosed:  n(progHash.live_positions_closed_count),
        positionsOpen: (() => {
          // Prefer key-scan (liveOpenScanned) — authoritative; survives server
          // restarts where InlineLocalRedis counters reset to 0.
          const execCounterOpen = Math.max(
            0,
            n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count),
          )
          const execPending = Math.max(
            0,
            n(progHash.live_orders_placed_count) - n(progHash.live_orders_filled_count),
          )
          return liveOpenScanned > 0
            ? liveOpenScanned + execPending
            : Math.max(0, execCounterOpen + execPending)
        })(),
        wins:             n(progHash.live_wins_count),
        // Volume — leveraged notional (cumulative qty × price across all fills)
        volumeUsdTotal:   n(progHash.live_volume_usd_total),
        // Used-balance margin (cumulative notional/leverage). This is
        // the canonical "USDT" figure the dashboard should display:
        // the actual capital committed, not the leveraged exposure.
        //
        // PRIORITY ORDER:
        //   1. `live_margin_cents_total` — cent-precision counter
        //      (added 2026-05-03). Survives the rounding that wiped out
        //      sub-dollar margins (e.g. $5 notional / 125x = $0.04
        //      margin) on the legacy dollar counter.
        //   2. `live_margin_usd_total` — legacy dollar counter, still
        //      written in lock-step for backward-compat dashboards.
        //   3. Current open-portfolio margin aggregate, for connections
        //      that started before either counter existed.
        marginUsdTotal:   (() => {
          const cents = n(progHash.live_margin_cents_total)
          if (cents > 0) return Math.round(cents) / 100
          const dollars = n(progHash.live_margin_usd_total)
          if (dollars > 0) return dollars
          return Math.round(liveAggTotalMarginUsd * 100) / 100
        })(),
        // Derived
        fillRate: (() => {
          const placed = n(progHash.live_orders_placed_count)
          const filled = n(progHash.live_orders_filled_count)
          return placed > 0 ? Math.round((filled / placed) * 1000) / 10 : 0
        })(),
        winRate: (() => {
          const closed = n(progHash.live_positions_closed_count)
          const wins   = n(progHash.live_wins_count)
          return closed > 0 ? Math.round((wins / closed) * 1000) / 10 : 0
        })(),
        // Per-symbol/direction order counters — folds the
        // `live_orders_by_symbol:{id}` HGETALL into an array of
        // `{ symbol, long: { placed, filled }, short: { placed, filled } }`
        // rows so the UI can render "BTCUSDT L:3/2 S:1/1" chips after the
        // global totals. Empty array when no orders have been placed yet.
        ordersBySymbol: (() => {
          const map = new Map<string, {
            long:  { placed: number; filled: number }
            short: { placed: number; filled: number }
          }>()
          for (const [field, raw] of Object.entries(ordersBySymbolHash)) {
            // Legacy/testing route compatibility: older simulated order helpers
            // stored one JSON object under `{SYMBOL}` instead of the canonical
            // `{SYMBOL}:{direction}:{kind}` fields. Do not let that malformed
            // shape disappear or crash the aggregation; fold it into the same
            // independent long/short buckets.
            if (!field.includes(":") && typeof raw === "string" && raw.trim().startsWith("{")) {
              try {
                const parsed = JSON.parse(raw)
                const rawSide = String(parsed?.side ?? parsed?.direction ?? "").trim().toLowerCase()
                const legacyDirection: "long" | "short" =
                  rawSide.includes("short") || rawSide === "sell" ? "short" : "long"
                const entry = map.get(field) || {
                  long:  { placed: 0, filled: 0 },
                  short: { placed: 0, filled: 0 },
                }
                const legacyCount = n(parsed?.count ?? 0)
                entry[legacyDirection].placed += n(parsed?.placed ?? parsed?.ordersPlaced ?? legacyCount)
                // Old test-order rows were written only after a successful
                // endpoint response and did not carry a separate filled field.
                // Mirror `count` into filled when no explicit fill count exists
                // so the per-symbol row reconciles with the global filled
                // counter instead of showing L:1/0 for an already-open test
                // position restored from a production/dev snapshot.
                entry[legacyDirection].filled += n(parsed?.filled ?? parsed?.ordersFilled ?? legacyCount)
                map.set(field, entry)
              } catch {
                // Ignore malformed legacy values; canonical fields below remain authoritative.
              }
              continue
            }
            // Field format: `{SYMBOL}:{direction}:{kind}`. Direction must
            // be one of long|short and kind one of placed|filled — anything
            // else is treated as malformed and skipped.
            const lastColon = field.lastIndexOf(":")
            const midColon  = field.lastIndexOf(":", lastColon - 1)
            if (lastColon < 0 || midColon < 0) continue
            const symbol    = field.slice(0, midColon)
            const direction = field.slice(midColon + 1, lastColon)
            const kind      = field.slice(lastColon + 1)
            if (!symbol) continue
            if (direction !== "long" && direction !== "short") continue
            if (kind !== "placed" && kind !== "filled") continue
            const value = n(raw)
            if (value <= 0) continue
            const entry = map.get(symbol) || {
              long:  { placed: 0, filled: 0 },
              short: { placed: 0, filled: 0 },
            }
            // Accumulate rather than assign so canonical counters and legacy
            // backfilled rows can coexist without one direction overwriting the
            // other. This preserves independent long/short totals.
            entry[direction][kind] += value
            map.set(symbol, entry)
          }
          return Array.from(map.entries())
            .map(([symbol, v]) => ({ symbol, ...v }))
            .sort((a, b) =>
              (b.long.placed + b.short.placed + b.long.filled + b.short.filled) -
              (a.long.placed + a.short.placed + a.long.filled + a.short.filled),
            )
        })(),
      },

      // Prehistoric processing metadata — range, timeframe, interval progress
      prehistoricMeta,

      // ── PERFORMANCE TIERS ────────────────────────────────��──────────────────
      // Per-stage (base / main / real / live) performance summary. Fields are
      // sourced from strategy_detail hashes (base/main/real: cross-symbol
      // aggregations of avg PF, DDT, pos-eval) or from the live closed archive
      // (live: realised P&L, win rate, Sharpe, fill-rate). Buffer-size proxy
      // (`avgPosPerSet` for live) is derived from volume-usd / created count.
      performanceTiers: {
        base: {
          avgProfitFactor: baseSpecPerf.aggregated.avgProfitFactor,
          avgDrawdownMin:  baseSpecPerf.aggregated.avgDrawdownTime,
          avgPosPerSet:    baseSpecPerf.aggregated.avgPosPerSet,
          avgPosEval:      baseSpecPerf.aggregated.avgPosEval,
          winRate:         baseWinRateProxy,
          sharpe:          approxSharpe(baseSpecPerf.aggregated.avgDrawdownTime || 0),
          totalPnl:        0,
          totalCreated:    baseSpecPerf.aggregated.totalCreated,
          totalEntries:    baseSpecPerf.aggregated.totalEntries,
          totalRunning:    baseSpecPerf.aggregated.totalRunning,
          symbolCount:     baseSpecPerf.aggregated.symbolCount,
          isExecution:     false,
        },
        main: {
          avgProfitFactor: mainSpecPerf.aggregated.avgProfitFactor,
          avgDrawdownMin:  mainSpecPerf.aggregated.avgDrawdownTime,
          avgPosPerSet:    mainSpecPerf.aggregated.avgPosPerSet,
          avgPosEval:      mainSpecPerf.aggregated.avgPosEval,
          winRate:         mainWinRateProxy,
          sharpe:          approxSharpe(mainSpecPerf.aggregated.avgDrawdownTime || 0),
          totalPnl:        0,
          totalCreated:    mainSpecPerf.aggregated.totalCreated,
          totalEntries:    mainSpecPerf.aggregated.totalEntries,
          totalRunning:    mainSpecPerf.aggregated.totalRunning,
          symbolCount:     mainSpecPerf.aggregated.symbolCount,
          isExecution:     false,
        },
        real: {
          avgProfitFactor: realSpecPerf.aggregated.avgProfitFactor,
          avgDrawdownMin:  realSpecPerf.aggregated.avgDrawdownTime,
          avgPosPerSet:    realSpecPerf.aggregated.avgPosPerSet,
          avgPosEval:      realSpecPerf.aggregated.avgPosEval,
          winRate:         realWinRateProxy,
          sharpe:          approxSharpe(realSpecPerf.aggregated.avgDrawdownTime || 0),
          totalPnl:        0,
          totalCreated:    realSpecPerf.aggregated.totalCreated,
          totalEntries:    realSpecPerf.aggregated.totalEntries,
          totalRunning:    realSpecPerf.aggregated.totalRunning,
          symbolCount:     realSpecPerf.aggregated.symbolCount,
          isExecution:     false,
        },
        live: {
          avgProfitFactor: liveProfitFactor,
          avgDrawdownMin:  liveAvgHoldMin,
          avgPosPerSet:    n(progHash.live_positions_created_count) > 0
            ? n(progHash.live_volume_usd_total) / n(progHash.live_positions_created_count)
            : 0,
          winRate:         liveWinRate,
          sharpe:          performanceTiers.live?.sharpe || 0,
          totalPnl:        Math.round(liveClosedSumPnl * 100) / 100,
          avgPnl:          liveClosedCount > 0 ? Math.round((liveClosedSumPnl / liveClosedCount) * 100) / 100 : 0,
          totalCreated:    n(progHash.live_positions_created_count),
          totalClosed:     n(progHash.live_positions_closed_count),
          totalRunning:    Math.max(0, n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)),
          openScanned:     liveOpenScanned,
          symbolCount:     livePositionSetRelations.length,
          isExecution:     true,
          fillRate:        Math.round((n(progHash.live_orders_filled_count) / Math.max(1, n(progHash.live_orders_placed_count))) * 1000) / 10,
          volumeUsdTotal:  Math.round(n(progHash.live_volume_usd_total) * 100) / 100,
        },
      },

      // ── TRADE HISTORY ────────────────────────────────────────────────────────
      // Up to 500 most-recently-closed live exchange positions with full row-level
      // detail. Sorted newest-first. Drives the TradeHistoryTable component.
      tradeHistory: tradeHistory.map((pos) => ({
        id:          pos.id,
        symbol:      pos.symbol,
        direction:   pos.direction,
        entryPrice:  pos.entryPrice,
        exitPrice:   pos.exitPrice,
        realizedPnl: pos.realizedPnl,
        pnlPct:      pos.pnlPct,
        holdMinutes: pos.holdMinutes,
        openedAt:    pos.openedAt,
        closedAt:    pos.closedAt,
        volumeUsd:   pos.volumeUsd,
        // Friendly display strings derived server-side
        pnlLabel:    pos.realizedPnl >= 0 ? `+$${pos.realizedPnl.toFixed(2)}` : `-$${Math.abs(pos.realizedPnl).toFixed(2)}`,
        pnlPctLabel: `${pos.pnlPct >= 0 ? "+" : ""}${pos.pnlPct.toFixed(2)}%`,
        holdLabel:   pos.holdMinutes < 60
          ? `${pos.holdMinutes}m`
          : `${Math.floor(pos.holdMinutes / 60)}h ${Math.floor(pos.holdMinutes % 60)}m`,
      })),

      // ── SPEC PERFORMANCE HISTORY ─────────────────────────────────────────────
      // Per-symbol performance aggregates for base, main, and real stages.
      // Each stage carries an `aggregated` cross-symbol summary + a `detail`
      // array (capped at 200 rows).
      specPerformanceHistory: {
        base:  { aggregated: baseSpecPerf.aggregated,  detail: baseSpecPerf.detail  },
        main:  { aggregated: mainSpecPerf.aggregated,  detail: mainSpecPerf.detail  },
        real:  { aggregated: realSpecPerf.aggregated,  detail: realSpecPerf.detail  },
        live:  {
          aggregated: {
            symbolCount:   livePositionSetRelations.length,
            totalCreated:  n(progHash.live_positions_created_count),
            totalClosed:   n(progHash.live_positions_closed_count),
            totalRunning:  Math.max(0, n(progHash.live_positions_created_count) - n(progHash.live_positions_closed_count)),
            avgProfitFactor: liveProfitFactor,
            avgDrawdownMin:  liveAvgHoldMin,
            winRate:         liveWinRate,
            avgPnl:          liveClosedCount > 0 ? Math.round((liveClosedSumPnl / liveClosedCount) * 100) / 100 : 0,
            volumeUsdTotal:  Math.round(n(progHash.live_volume_usd_total) * 100) / 100,
            fillRate:        Math.round((n(progHash.live_orders_filled_count) / Math.max(1, n(progHash.live_orders_placed_count))) * 1000) / 10,
          },
          detail: livePositionSetRelations.slice(0, 200).map((p) => ({
            id:            p.id,
            symbol:        p.symbol,
            direction:     p.direction,
            volumeUsd:     p.volumeUsd,
            leverage:      p.leverage,
            marginUsd:     p.marginUsd,
            unrealizedPnl: p.unrealizedPnl,
            roiPct:        p.roiPct,
            liquidationDistancePct: p.liquidationDistancePct,
            status:        p.status,
            createdAt:     p.createdAt,
            updatedAt:     p.updatedAt,
            syncedAt:      p.syncedAt,
            entryPrice:    p.entryPrice,
            markPrice:     p.markPrice,
            stopLossPrice:   p.stopLossPrice,
            takeProfitPrice: p.takeProfitPrice,
          })),
        },
      },


      // Rolling time-window indication and strategy counts
      windows: {
        indications: { last5m: indWindow5m, last60m: indWindow60m },
        strategies:  { last5m: stratWindow5m, last60m: stratWindow60m },
      },

      metadata: {
        engineRunning: realtimeIsActive,
        phase,
        progress,
        message,
        lastUpdate,
        redisDbEntries,
        // ── Progression identity (per session) ───────────────────────────
        // The frontend uses these to detect whether a page refresh lands
        // on the SAME progression session (same sessionNumber+epoch) or a
        // NEW one (sessionNumber bumped by archiveAndStartNewProgression).
        // When session changes the FE clears local cached UI state; when
        // it stays the same, it KEEPS the current view (resumes mid-cycle).
        // Both fields are written by `archiveAndStartNewProgression` on
        // every engine start and survive every refresh because they live
        // in the persisted `progression:{id}` hash.
        sessionNumber: n(progHash.session_number) || 0,
        epoch:         n(progHash.epoch) || 0,
        startedAt:     n(progHash.started_at) || 0,
        // `progressionId` is the stable per-session ID — `epoch:session`
        // is unique across all sessions for this connection.
        progressionId:
          progHash.session_number && progHash.epoch
            ? `${progHash.epoch}:${progHash.session_number}`
            : "",
      },

      // ── Plan fields: added to surface engine internals to UI ────────────
      // strategiesActive: raw {symbol}:{stage} hash snapshot from
      //   strategies_active:{id} — currently-alive count per symbol+stage.
      //   Consumers can iterate keys to render per-symbol stage badges.
      strategiesActive: stratActiveHash ?? {},

      // stageEvalPercent: cascade survival rates base/main/real (0-100).
      //   base = 100 when any Base Sets exist (entry point — by definition all pass).
      //   main = Main output / Main input (Base→Main filter survival rate).
      //   real = Real output / Real input  (Main→Real filter survival rate).
      stageEvalPercent,

      // realAverages: 5-min rolling averages over the real_samples ring buffer.
      //   activeSets = avg running Real Sets per cycle
      //   posPerSet  = avg positions per Set (division-by-zero guarded)
      //   posOpen    = avg open positions
      //   samples    = number of in-window sample points used
      realAverages,

      // volumeConfig: effective volume multiplier stack used by live orders.
      //   liveVolumeFactor   = mainVolumeFactor applied to all main-engine live orders
      //   presetVolumeFactor = multiplier for preset-engine live orders
      //   tradeMode          = which engine is active ("main" | "preset")
      //   positionCostPct    = % of balance budgeted per position (e.g. 0.02 = 0.02%)
      //   positionsAverage   = divisor for budget allocation (concurrent positions)
      //   source             = where the factor came from: "connection" | "app_settings" | "default"
      volumeConfig,

      // Legacy flat fields kept for backward compat with existing components
      // that still read engine-stats shape directly
      indicationCycleCount:  realtimeIndicationCycles,
      strategyCycleCount:    realtimeStrategyCycles,
      cyclesCompleted:       realtimeIndicationCycles,
      cycleSuccessRate:      Math.round(successRate * 10) / 10,
      totalIndicationsCount: indTotal,
      indicationsByType:     indCounts,
      baseStrategyCount:     stratCounts.base || 0,
      mainStrategyCount:     stratCounts.main || 0,
      realStrategyCount:     stratCounts.real || 0,
      liveStrategyCount:     stratCounts.live || 0,
      totalStrategyCount:    stratTotal,
      positionsCount:        positionsOpen,
    })
    } catch (error) {
      console.error("[v0] [/stats] Error:", error)
      const { id } = await params
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "Unknown error", connectionId: id },
        { status: 500 }
      )
    }
  }

  // Race the main logic against a 15-second timeout
  try {
    return await Promise.race([mainLogic(), timeoutPromise])
  } catch (error) {
    console.error("[v0] [/stats] Request failed:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Stats request failed" },
      { status: 500 }
    )
  }
}
