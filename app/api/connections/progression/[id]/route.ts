import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient, getSettings, getConnection } from "@/lib/redis-db"
import { getProgressionLogs, forceFlushLogs } from "@/lib/engine-progression-logs"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { normalizeSymbolList } from "@/lib/trade-engine/symbol-selection-ownership"

export const dynamic = "force-dynamic"
export const dynamicParams = true
export const runtime = "nodejs"
export const maxDuration = 30
export const revalidate = 0
export const fetchCache = "force-no-store"

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function parseSymbolList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((symbol) => String(symbol).trim()).filter(Boolean)
  }
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      return parsed.map((symbol) => String(symbol).trim()).filter(Boolean)
    }
  } catch {
    // Fall through to comma/newline parsing for legacy Redis fields.
  }
  return trimmed
    .split(/[\n,]/)
    .map((symbol) => symbol.trim())
    .filter(Boolean)
}

function getConfiguredSymbolCount(connection: any, engineState: any): number {
  const canonicalSelectedSymbols = normalizeSymbolList(engineState?.selected_symbols)
  const canonicalTotal = Math.max(toNumber(engineState?.config_set_symbols_total), canonicalSelectedSymbols.length)
  if (canonicalTotal > 0) return canonicalTotal
  const candidates = [
    connection?.force_symbols,
    connection?.active_symbols,
    engineState?.force_symbols,
    engineState?.active_symbols,
  ]
  for (const candidate of candidates) {
    const symbols = parseSymbolList(candidate)
    if (symbols.length > 0) return symbols.length
  }
  return Math.max(
    toNumber(connection?.symbol_count),
    toNumber(engineState?.symbol_count),
    toNumber(engineState?.config_set_symbols_total),
  )
}

/**
 * GET /api/connections/progression/[id]
 * Returns comprehensive progression data for an active connection
 * Tracks: initialization, historical data loading, indications, strategies, realtime, live trading
 */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    // PRODUCTION FIX: Initialize Redis before use
    try {
      await initRedis()
    } catch (redisErr) {
      console.error(`[v0] [ProgressionAPI] Redis init failed for ${connectionId}:`, redisErr)
      return getErrorResponse(connectionId, "Redis initialization failed")
    }
    
    // Force flush any pending logs before fetching
    try {
      await forceFlushLogs(connectionId)
    } catch (flushErr) {
      console.warn(`[v0] [ProgressionAPI] Failed to flush logs for ${connectionId}:`, flushErr)
    }

    // Get connection details for context
    const connection = await getConnection(connectionId).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get connection ${connectionId}:`, e)
      return null
    })
    const connName = connection?.name || connectionId

    // Get progression phase data from engine-manager's updateProgressionPhase
    const progression = await getSettings(`engine_progression:${connectionId}`).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression settings for ${connectionId}:`, e)
      return {}
    })
    
    // Get engine state from the correct Redis key: trade_engine_state:{connectionId}
    const client = getRedisClient()
    const engineState = await getSettings(`trade_engine_state:${connectionId}`).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get engine state for ${connectionId}:`, e)
      return {}
    })
    
    // Also check global state (stored as Redis HASH via hset, not a string)
    let globalState: any = {}
    try {
      if (client) {
        const globalStateData = await client.hgetall("trade_engine:global").catch(() => null)
        globalState = globalStateData && Object.keys(globalStateData).length > 0 ? globalStateData : {}
      }
    } catch {
      globalState = {}
    }
    const isGloballyRunning = globalState?.status === "running"
    const configuredSymbolCount = getConfiguredSymbolCount(connection, engineState)
    
     // PHASE 2 FIX: Check running flag directly from coordinator (most reliable)
     // Get current engine running state from coordinator
     let isEngineRunning = false
     try {
       const coordinator = getGlobalTradeEngineCoordinator()
       if (coordinator) {
         isEngineRunning = coordinator.isEngineRunning(connectionId)
       }
     } catch (e) {
       console.warn(`[v0] [ProgressionAPI] ${connectionId}: Failed to check coordinator state, falling back to Redis flag`)
       const runningFlag = await client?.get(`engine_is_running:${connectionId}`).catch(() => null)
       isEngineRunning = runningFlag === "true" || runningFlag === "1"
     }
    
    // Check if this connection is currently active/dashboard enabled
    const isActive = connection?.is_enabled_dashboard === "1" || connection?.is_enabled_dashboard === true
    const isEnabled = connection?.is_enabled === "1" || connection?.is_enabled === true
    const isInserted = connection?.is_inserted === "1" || connection?.is_inserted === true
    const isActiveInserted = connection?.is_active_inserted === "1" || connection?.is_active_inserted === true
    
    // Get progression state (cycles, success rates)
    let progressionState = await ProgressionStateManager.getProgressionState(connectionId).catch((e) => {
      console.warn(`[v0] [ProgressionAPI] Failed to get progression state for ${connectionId}:`, e)
      return ProgressionStateManager.getDefaultState(connectionId)
    })
    
    // Read live progression hash (written EVERY cycle) for real-time counts
    // This is more current than engineState which persists only every 50-100 cycles
    let progHash: Record<string, string> = {}
    try {
      progHash = (await client.hgetall(`progression:${connectionId}`)) || {}
    } catch { /* non-critical */ }

    // Cycle counts: prefer live progression hash over engineState (more current)
    const indicationCycleCount =
      parseInt(progHash.indication_cycle_count || "0", 10) ||
      toNumber(engineState?.indication_cycle_count) ||
      progressionState.indicationCycleCount ||
      progressionState.indicationLiveCycleCount ||
      0
    const strategyCycleCount =
      parseInt(progHash.strategy_cycle_count || "0", 10) ||
      toNumber(engineState?.strategy_cycle_count) ||
      progressionState.strategyCycleCount ||
      progressionState.strategyLiveCycleCount ||
      0
    const hasRecentActivity = engineState?.last_indication_run 
      ? (Date.now() - new Date(engineState.last_indication_run).getTime()) < 60000 // Active in last 60s
      : false
    
    // Engine is running only when there is current runtime evidence
    const engineRunning = isEngineRunning || 
      (isGloballyRunning && (isActiveInserted || isInserted) && isEnabled) ||
      engineState?.status === "running" ||
      hasRecentActivity

    let indicationsCount = parseInt(progHash.indications_count || "0", 10)
    let strategiesCount  = parseInt(progHash.strategies_count  || "0", 10)

    // Fallback to string counter keys written by statistics-tracker, then to
    // the canonical progression-state fields used by the status endpoint. The
    // old route returned zero stats while /trade-engine/status showed active
    // Base/Main/Real set counts, making the UI look stalled even after the
    // engine reached live trading.
    if (indicationsCount === 0) {
      indicationsCount =
        toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0)) ||
        progressionState.indicationsCount ||
        progressionState.indicationsDirectionCount ||
        progressionState.indicationsMoveCount ||
        progressionState.indicationsActiveCount ||
        toNumber(engineState?.config_set_indication_results)
    }
    if (strategiesCount === 0) {
      strategiesCount =
        toNumber(await client.get(`strategies:${connectionId}:count`).catch(() => 0)) ||
        progressionState.strategiesCount ||
        Math.max(
          progressionState.strategiesBaseTotal || 0,
          progressionState.strategiesMainTotal || 0,
          progressionState.strategiesRealTotal || 0,
          progressionState.strategyEvaluatedBase || 0,
          progressionState.strategyEvaluatedMain || 0,
          progressionState.strategyEvaluatedReal || 0,
        ) ||
        toNumber(engineState?.total_strategies_evaluated)
    }
    
    // Phase progression depends on stored phase or derived from state
    let phase = progression?.phase || "idle"
    let progress = Number(progression?.progress) || 0
    let detail = progression?.detail || "Not running"

    // ── Prehistoric gate (spec: realtime starts AFTER prehistoric done) ──
    // Read the prehistoric `:done` flag eagerly. While it is unset AND
    // the engine is running, force phase = "prehistoric_data" with the
    // live percent from the stored `engine_progression:{id}` hash —
    // regardless of any incidental indication/strategy cycle counters
    // (which can be non-zero on engine restart from a previous live run).
    // The downstream auto-derivation only kicks in once prehistoric is
    // truly complete, so the user always sees the honest phase + percent.
    const prehistoricDoneRaw = await client?.get(`prehistoric:${connectionId}:done`).catch(() => null)
    const prehistoricDone = String(prehistoricDoneRaw) === "1"

    if (engineRunning && !prehistoricDone) {
      // Trust the engine's own phase update (written per-symbol-completion
      // by config-set-processor) — it carries the live 15 → 95 percent.
      // Fall back to a "starting" 15% if the engine hasn't written one
      // yet (boot transient).
      phase = "prehistoric_data"
      progress = progression?.phase === "prehistoric_data" ? (Number(progression?.progress) || 15) : 15
      detail = progression?.phase === "prehistoric_data"
        ? (progression?.detail || "Prehistoric calc filling sets…")
        : "Prehistoric calc filling sets…"
    } else if (progression?.phase === "live_trading" && Number(progression?.progress || 0) >= 100) {
      // The engine writes the authoritative terminal live-trading state after
      // prehistoric completes. Trust it before heuristic cycle/indication
      // derivation; otherwise a fresh run with indications but zero completed
      // realtime cycles regressed the visible UI back to 90% forever.
      phase = "live_trading"
      progress = 100
      detail = progression.detail || `Live trading ACTIVE — evaluating ${configuredSymbolCount || "configured"} symbols`
    } else if (indicationCycleCount > 100 || progressionState.cyclesCompleted > 100) {
      phase = "live_trading"
      progress = 100
      detail = `Live trading active - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
    } else if (indicationCycleCount > 20 || progressionState.cyclesCompleted > 20 || indicationsCount > 50) {
      phase = "live_trading"
      progress = 90 + Math.min(10, indicationCycleCount / 100)
      detail = `Live trading - ${Math.max(indicationCycleCount, progressionState.cyclesCompleted)} cycles`
    } else if (indicationCycleCount > 0 || indicationsCount > 0 || progressionState.cyclesCompleted > 0) {
      const totalCycles = Math.max(progressionState.cyclesCompleted, indicationCycleCount)
      phase = "realtime"
      progress = 80 + Math.min(20, totalCycles / 10)
      detail = `Processing - ${totalCycles} cycles`
    } else if (progression?.phase && !["ready", "idle", "initializing"].includes(progression.phase)) {
      phase = progression.phase
      progress = Number(progression.progress) || 50
      detail = progression.detail || "Engine running"
    } else if (engineState?.all_phases_started || engineState?.live_trading_started) {
      phase = "live_trading"
      progress = 100
      detail = "All phases active"
    } else if (engineState?.strategies_started) {
      phase = "strategies"
      progress = 75
      detail = "Strategies processor active"
    } else if (engineState?.indications_started) {
      phase = "indications"
      progress = 60
      detail = "Indications processor active"
    } else if (engineState?.prehistoric_data_loaded) {
      phase = "prehistoric_data"
      progress = 15
      detail = "Prehistoric data loaded"
    } else if (engineState?.status === "running" || isEngineRunning) {
      phase = "initializing"
      progress = 30
      detail = "Engine starting up..."
    } else if (!isEnabled || (!isActiveInserted && !isInserted)) {
      phase = "idle"
      progress = 0
      detail = "Connection disabled or not inserted"
    } else if (progression?.phase === "ready") {
      phase = "ready"
      progress = 0
      detail = progression.detail || "Ready - toggle Enable on dashboard to start"
    }
    
    // Get detailed prehistoric progress tracking
    let prehistoricProgress = {
      symbolsProcessed: 0,
      // Prefer the operator-configured symbol count so the UI never shows a
      // stale 0/1 denominator while prehistoric hashes are being reset or
      // rewritten during a settings-driven recoordination.
      symbolsTotal: Math.max(configuredSymbolCount, 1),
      candlesLoaded: 0,
      candlesTotal: 0,
      indicatorsCalculated: 0,
      currentSymbol: "",
      duration: 0,
      percentComplete: 0,
    }
    
    try {
      if (client) {
        // Check for prehistoric progress tracking in Redis. All three sources
        // are read in parallel — the hash holds the canonical state written by
        // EngineManager / ConfigSetProcessor, the SADD set is the source of
        // truth for the list of processed symbols, and the `:done` marker
        // lets us flip to 100% even if the hash's `is_complete` field was
        // written before a hot reload.
        const [prehistoricDataRaw, prehistoricSymbolsSet, doneMarker] = await Promise.all([
          client.hgetall(`prehistoric:${connectionId}`).catch(() => null),
          client.smembers(`prehistoric:${connectionId}:symbols`).catch(() => [] as string[]),
          client.get(`prehistoric:${connectionId}:done`).catch(() => null),
        ])
        const prehistoricData = (prehistoricDataRaw as Record<string, string> | null) || {}
        const processedSet = Array.isArray(prehistoricSymbolsSet) ? prehistoricSymbolsSet : []

        if (Object.keys(prehistoricData).length > 0 || processedSet.length > 0 || doneMarker) {
          prehistoricProgress.currentSymbol = prehistoricData.current_symbol || ""
          prehistoricProgress.candlesLoaded = Number(prehistoricData.candles_loaded || 0)
          prehistoricProgress.candlesTotal = Number(prehistoricData.candles_total || 0)
          prehistoricProgress.indicatorsCalculated = Number(prehistoricData.indicators_calculated || 0)
          prehistoricProgress.duration = Number(
            prehistoricData.total_duration_ms || prehistoricData.duration || 0,
          )

          // Use the largest known total. Redis hashes can briefly contain stale
          // legacy values (for example 1) while a background engine start resets
          // prehistoric progress, so the saved connection/engine symbol list is
          // the floor for the denominator.
          const hashSymbolsTotal = Number(prehistoricData.symbols_total || 0)
          const canonicalProgressTotal = configuredSymbolCount > 0 ? configuredSymbolCount : hashSymbolsTotal
          prehistoricProgress.symbolsTotal = Math.max(
            prehistoricProgress.symbolsTotal,
            canonicalProgressTotal,
            processedSet.length,
          )

          // symbolsProcessed — canonical source of truth, in priority order:
          //   1. Hash field `symbols_processed` (written by engine-manager /
          //      config-set-processor on each symbol completion)
          //   2. SCARD of the `prehistoric:{id}:symbols` SADD set
          //   3. Fall back to 1 if currently processing a symbol. Legacy
          //      `:*:completed` markers are repaired by migrations instead of
          //      scanned from the UI poll path.
          const hashProcessed = Number(prehistoricData.symbols_processed || 0)
          const setProcessed = processedSet.length
          let processed = Math.max(hashProcessed, setProcessed)
          // Do not fall back to a Redis KEYS scan here. In production that scan
          // can block large keyspaces and make the progress endpoint itself
          // look like the stall. Modern processors write both the hash and the
          // canonical SADD set above; legacy completed-marker keys are repaired
          // by migrations instead of scanned on every UI poll.
          if (processed === 0 && prehistoricProgress.currentSymbol) processed = 1
          prehistoricProgress.symbolsProcessed = Math.min(
            processed,
            prehistoricProgress.symbolsTotal,
          )

          // isComplete → either explicit flag, `:done` marker, or all symbols processed.
          const isComplete =
            prehistoricData.is_complete === "1" ||
            prehistoricData.is_complete === "true" ||
            String(doneMarker) === "1" ||
            (prehistoricProgress.symbolsTotal > 0 &&
              prehistoricProgress.symbolsProcessed >= prehistoricProgress.symbolsTotal)

          prehistoricProgress.percentComplete = isComplete
            ? 100
            : prehistoricProgress.symbolsTotal > 0
              ? Math.round(
                  (prehistoricProgress.symbolsProcessed / prehistoricProgress.symbolsTotal) * 100,
                )
              : 0
        }
      }
    } catch (e) {
      console.warn(`[v0] [ProgressionAPI] Failed to get prehistoric progress for ${connectionId}:`, e)
    }
    
    const subItem = progression?.sub_item || (phase === "prehistoric_data" ? "symbols" : "")
    const storedSubCurrent = Number(progression?.sub_current) || 0
    const storedSubTotal = Number(progression?.sub_total) || 0
    const subCurrent = phase === "prehistoric_data"
      ? Math.max(storedSubCurrent, prehistoricProgress.symbolsProcessed)
      : storedSubCurrent
    const subTotal = phase === "prehistoric_data"
      ? Math.max(storedSubTotal, prehistoricProgress.symbolsTotal, configuredSymbolCount)
      : storedSubTotal

    // Build comprehensive message
    let message = detail
    if (subTotal > 0 && subCurrent > 0) {
      message = `${detail} (${subCurrent}/${subTotal}${subItem ? ` - ${subItem}` : ""})`
    } else if (engineRunning && phase === "realtime") {
      message = "Processing realtime indications and strategies"
    }

    // Derive detailed step flags from phase progression
    const phaseOrder = ["idle", "initializing", "prehistoric_data", "indications", "strategies", "realtime", "live_trading"]
    const currentIdx = phaseOrder.indexOf(phase)

    // Get recent logs for this connection
    const recentLogs = await getProgressionLogs(connectionId)

    const response = {
      success: true,
      connectionId,
      connectionName: connName,
      connection: {
        exchange: connection?.exchange || "unknown",
        isActive,
        isEnabled,
        isInserted,
        isActiveInserted,
      },
      progression: {
        phase,
        progress,
        message,
        timestamp: new Date().toISOString(),
        subPhase: subItem || null,
        subProgress: {
          current: subCurrent,
          total: subTotal,
        },
        startedAt: globalState?.started_at || engineState?.started_at || null,
        updatedAt: progression?.updated_at || engineState?.last_indication_run || new Date().toISOString(),
        details: {
          historicalDataLoaded: currentIdx >= 3 || (progressionState.prehistoricCyclesCompleted || 0) > 0,
          indicationsCalculated: currentIdx >= 4 || engineRunning || indicationsCount > 0,
          strategiesProcessed: currentIdx >= 5 || engineRunning || strategiesCount > 0,
          liveProcessingActive: currentIdx >= 5 || engineRunning,
          liveTradingActive: phase === "live_trading",
        },
        prehistoricProgress: prehistoricProgress,
        error: phase === "error" ? detail : null,
      },
      state: {
        cyclesCompleted: progressionState.cyclesCompleted,
        successfulCycles: progressionState.successfulCycles,
        failedCycles: progressionState.failedCycles,
        cycleSuccessRate: Math.round(progressionState.cycleSuccessRate * 10) / 10,
        totalTrades: progressionState.totalTrades,
        successfulTrades: progressionState.successfulTrades,
        totalProfit: progressionState.totalProfit,
        tradeSuccessRate: Math.round((progressionState.tradeSuccessRate ?? 0) * 10) / 10,
        lastCycleTime: progressionState.lastCycleTime?.toISOString() || null,
        prehistoricCyclesCompleted: progressionState.prehistoricCyclesCompleted,
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
      },
      metrics: {
        indicationsCount,
        strategiesCount,
        strategiesBaseTotal: progressionState.strategiesBaseTotal || parseInt(progHash.strategies_base_total || "0", 10),
        strategiesMainTotal: progressionState.strategiesMainTotal || parseInt(progHash.strategies_main_total || "0", 10),
        strategiesRealTotal: progressionState.strategiesRealTotal || parseInt(progHash.strategies_real_total || "0", 10),
        strategyEvaluatedBase: progressionState.strategyEvaluatedBase || parseInt(progHash.strategies_base_evaluated || "0", 10),
        strategyEvaluatedMain: progressionState.strategyEvaluatedMain || parseInt(progHash.strategies_main_evaluated || "0", 10),
        strategyEvaluatedReal: progressionState.strategyEvaluatedReal || parseInt(progHash.strategies_real_evaluated || "0", 10),
        intervalsProcessed: toNumber(await client?.get(`intervals:${connectionId}:processed_count`).catch(() => 0)),
        engineRunning,
        // UI consumers historically read `isEngineRunning`; expose the same
        // durable running truth as `engineRunning` so hot-reload coordinator
        // loss does not show a false stopped state while Redis/global/runtime
        // evidence proves the engine is active.
        isEngineRunning: engineRunning,
        coordinatorEngineRunning: isEngineRunning,
        hasRecentActivity,
        globalEngineStatus: globalState?.status || "unknown",
        engineStateStatus: engineState?.status || "unknown",
        indicationCycleCount,
        strategyCycleCount,
        realtimeCycleCount: toNumber(engineState?.realtime_cycle_count),
        // LivePositions loop (Loop C) telemetry — written by engine-manager
        // `tickLivePositions` every 200 ms into `progression:{id}`.
        livePositionsCycleCount: parseInt(progHash.live_positions_cycle_count || "0", 10),
        livePositionsLastCycleAt: toNumber(progHash.live_positions_last_cycle_at),
        livePositionsLastCycleMs: toNumber(progHash.live_positions_last_cycle_ms),
        cycleTimeMs: toNumber(engineState?.last_cycle_duration),
        totalStrategiesEvaluated: toNumber(engineState?.total_strategies_evaluated),
        totalIndicationsEvaluated: toNumber(engineState?.total_indications_evaluated),
        prehistoricSymbolsTotal: configuredSymbolCount,
        prehistoricSymbolsProcessed: toNumber(engineState?.config_set_symbols_processed),
        prehistoricCandlesProcessed: toNumber(engineState?.config_set_candles_processed),
        prehistoricIndicationResults: toNumber(engineState?.config_set_indication_results),
        prehistoricStrategyPositions: toNumber(engineState?.config_set_strategy_positions),
        prehistoricErrors: toNumber(engineState?.config_set_errors),
        progressionCyclesCompleted: progressionState.cyclesCompleted,
        lastIndicationRun: engineState?.last_indication_run || null,
        lastStrategyRun: engineState?.last_strategy_run || null,
      },
      recentLogs: recentLogs.slice(0, 20).map(log => ({
        timestamp: log.timestamp,
        level: log.level,
        phase: log.phase,
        message: log.message,
        details: log.details,
      })),
    }

    return NextResponse.json(response)
  } catch (error) {
    console.error("[v0] [Progression] Failed to fetch progression:", error)
    const { id } = await params
    return getErrorResponse(id, error instanceof Error ? error.message : "Unknown error")
  }
}

// Production-safe error response helper
function getErrorResponse(connectionId: string, message: string) {
  return NextResponse.json({ 
    success: false,
    connectionId,
    progression: {
      phase: "error",
      progress: 0,
      message: "Failed to fetch progression status",
      subPhase: null,
      subProgress: { current: 0, total: 0 },
      startedAt: null,
      updatedAt: null,
      details: {
        historicalDataLoaded: false,
        indicationsCalculated: false,
        strategiesProcessed: false,
        liveProcessingActive: false,
        liveTradingActive: false,
      },
      error: message,
    },
  }, { status: 500 })
}
