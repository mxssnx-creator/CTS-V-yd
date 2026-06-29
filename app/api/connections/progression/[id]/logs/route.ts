import { type NextRequest, NextResponse } from "next/server"
import { getProgressionLogs, clearProgressionLogs } from "@/lib/engine-progression-logs"
import { initRedis, getRedisClient, getSettings } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"
export const maxDuration = 30
export const revalidate = 0

function toNumber(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function sanitizeNonNegative(value: unknown): number {
  return Math.max(0, toNumber(value))
}

async function countKeys(client: any, patterns: string[]): Promise<number> {
  let total = 0
  for (const pattern of patterns) {
    const keys = await client.keys(pattern).catch(() => [])
    total += Array.isArray(keys) ? keys.length : 0
  }
  return total
}

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Get progression logs for this connection
    const logs = await getProgressionLogs(connectionId)
    
    // Get progression state (cycles, trades, etc.)
    const progressionState = await ProgressionStateManager.getProgressionState(connectionId)
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    
    // Get engine progression phase
    const engineProgression = await getSettings(`engine_progression:${connectionId}`)
    
    // Get structured engine logs
    const client = getRedisClient()
    let structuredLogs: any[] = []
    try {
      const rawLogs = await client.lrange(`engine:logs:${connectionId}`, 0, 100)
      structuredLogs = rawLogs.map((log: string) => {
        try { return JSON.parse(log) } catch { return null }
      }).filter(Boolean)
    } catch {
      structuredLogs = []
    }

    // Read per-type indication counts directly from the live progression hash.
    // statistics-tracker writes these as HINCRBY every indication cycle, so they are
    // always more current than the flat indications:{connId}:count key.
    let progHashForLogs: Record<string, string> = {}
    try {
      progHashForLogs = (await client.hgetall(`progression:${connectionId}`)) || {}
    } catch {
      progHashForLogs = {}
    }
    const indicationsByType = {
      direction: toNumber(progHashForLogs["indications_direction_count"]),
      move:      toNumber(progHashForLogs["indications_move_count"]),
      active:    toNumber(progHashForLogs["indications_active_count"]),
      optimal:   toNumber(progHashForLogs["indications_optimal_count"]),
      auto:      toNumber(progHashForLogs["indications_auto_count"]),
    }
    const indicationsByTypeTotal =
      indicationsByType.direction +
      indicationsByType.move +
      indicationsByType.active +
      indicationsByType.optimal +
      indicationsByType.auto

    const mergedLogs = logs.length > 0
      ? logs
      : structuredLogs.map((log: any) => ({
          timestamp: log.timestamp || new Date().toISOString(),
          level: log.status === "error" ? "error" : "info",
          phase: log.phase || log.engine || "engine",
          message: log.action || "structured log",
          details: log.details || {},
          connectionId,
        }))

    // Fetch progression hash to get accurate stage counts from strategy-coordinator
    const progHashForSetCounts = (await client.hgetall(`progression_lifecycle:${connectionId}`).catch(() => ({}))) || {}

    const [
      prehistoricSymbolsSet,
      prehistoricDataKeys,
      baseSetCount,
      mainSetCount,
      realSetCount,
      indicationDirectionCount,
      indicationMoveCount,
      indicationActiveCount,
      indicationOptimalCount,
      redisDbSize,
      redisMemoryInfo,
    ] = await Promise.all([
      client.scard(`prehistoric:${connectionId}:symbols`).catch(() => 0),
      countKeys(client, [`prehistoric:${connectionId}:*`, `market_data:${connectionId}:*`]),
      // Base stage count from progression hash — sets promoted by Base stage
      toNumber((progHashForSetCounts as Record<string, string>).strategies_base_total || "0"),
      // Main stage count from progression hash — sets fanned out by Main stage
      toNumber((progHashForSetCounts as Record<string, string>).strategies_main_total || "0"),
      // Real stage count comes from progression hash (strategies_real_total), NOT Redis key count.
      // This is the authoritative source set by strategy-coordinator when Real stage evaluates.
      toNumber((progHashForSetCounts as Record<string, string>).strategies_real_total || "0"),
      toNumber(await client.get(`indications:${connectionId}:direction:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:move:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:active:evaluated`).catch(() => 0)),
      toNumber(await client.get(`indications:${connectionId}:optimal:evaluated`).catch(() => 0)),
      client.dbSize().catch(() => 0),
      client.info().catch(() => ""),
    ])

    const usedMemoryLine = String(redisMemoryInfo)
      .split("\n")
      .find((line) => line.startsWith("used_memory:"))
    const usedMemoryBytes = toNumber(usedMemoryLine?.split(":")[1])
    const dbSizeMb = usedMemoryBytes > 0 ? usedMemoryBytes / (1024 * 1024) : 0

    return NextResponse.json({
      success: true,
      connectionId,
      logsCount: mergedLogs.length,
      logs: mergedLogs,
      structuredLogs,
      structuredLogsCount: structuredLogs.length,
      progressionState: {
        cyclesCompleted: sanitizeNonNegative(Math.max(progressionState.cyclesCompleted, Number(engineState?.indication_cycle_count || 0))),
        successfulCycles: sanitizeNonNegative(Math.max(progressionState.successfulCycles, Number(engineState?.strategy_cycle_count || 0))),
        failedCycles: sanitizeNonNegative(progressionState.failedCycles),
        totalTrades: sanitizeNonNegative(progressionState.totalTrades),
        successfulTrades: sanitizeNonNegative(progressionState.successfulTrades),
        totalProfit: toNumber(progressionState.totalProfit),
        cycleSuccessRate: sanitizeNonNegative(progressionState.cycleSuccessRate),
        tradeSuccessRate: sanitizeNonNegative(progressionState.tradeSuccessRate),
        lastCycleTime: progressionState.lastCycleTime,
        prehistoricCyclesCompleted: sanitizeNonNegative(progressionState.prehistoricCyclesCompleted),
        prehistoricPhaseActive: progressionState.prehistoricPhaseActive,
        realtimeCycleCount: sanitizeNonNegative(engineState?.realtime_cycle_count),
        cycleTimeMs: sanitizeNonNegative(engineState?.last_cycle_duration),
        intervalsProcessed: sanitizeNonNegative(await client.get(`intervals:${connectionId}:processed_count`).catch(() => 0)),
        indicationsCount: sanitizeNonNegative(
          // Prefer the live progression hash total; fall back to the flat counter
          indicationsByTypeTotal > 0
            ? indicationsByTypeTotal
            : toNumber(await client.get(`indications:${connectionId}:count`).catch(() => 0))
        ),
        indicationsByType,
        strategiesCount: sanitizeNonNegative(await client.get(`strategies:${connectionId}:count`).catch(() => 0)),
        strategyEvaluatedBase: sanitizeNonNegative(await client.get(`strategies:${connectionId}:base:evaluated`).catch(() => 0)),
        strategyEvaluatedMain: sanitizeNonNegative(await client.get(`strategies:${connectionId}:main:evaluated`).catch(() => 0)),
        strategyEvaluatedReal: sanitizeNonNegative(await client.get(`strategies:${connectionId}:real:evaluated`).catch(() => 0)),
        indicationEvaluatedDirection: sanitizeNonNegative(indicationDirectionCount),
        indicationEvaluatedMove: sanitizeNonNegative(indicationMoveCount),
        indicationEvaluatedActive: sanitizeNonNegative(indicationActiveCount),
        indicationEvaluatedOptimal: sanitizeNonNegative(indicationOptimalCount),
        prehistoricSymbolsProcessed: sanitizeNonNegative(engineState?.config_set_symbols_processed),
        prehistoricCandlesProcessed: sanitizeNonNegative(engineState?.config_set_candles_processed),
        prehistoricSymbolsProcessedCount: sanitizeNonNegative(prehistoricSymbolsSet || engineState?.config_set_symbols_processed),
        prehistoricDataSize: sanitizeNonNegative(prehistoricDataKeys),
        setsBaseCount: sanitizeNonNegative(baseSetCount),
        setsMainCount: sanitizeNonNegative(mainSetCount),
        setsRealCount: sanitizeNonNegative(realSetCount),
        // `setsTotalCount` is the pipeline's final-stage output (Real).
        // Base → Main → Real is a cascade filter — the SAME logical Sets
        // survive each stage — so stages must not be summed.
        setsTotalCount: sanitizeNonNegative(realSetCount),
        redisDbEntries: sanitizeNonNegative(redisDbSize),
        redisDbSizeMb: Number(dbSizeMb.toFixed(2)),
        processingCompleteness: {
          prehistoricLoaded: !!(engineState?.prehistoric_data_loaded === true || engineState?.prehistoric_data_loaded === "1"),
          indicationsRunning: sanitizeNonNegative(engineState?.indication_cycle_count) > 0,
          strategiesRunning: sanitizeNonNegative(engineState?.strategy_cycle_count) > 0,
          realtimeRunning: sanitizeNonNegative(engineState?.realtime_cycle_count) > 0,
          hasErrors: sanitizeNonNegative(engineState?.config_set_errors) > 0,
        },
      },
      enginePhase: engineProgression ? {
        phase: engineProgression.phase,
        progress: engineProgression.progress,
        detail: engineProgression.detail,
        updatedAt: engineProgression.updated_at,
      } : null,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error fetching progression logs:", error)
    return NextResponse.json(
      { error: "Failed to fetch progression logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    
    await initRedis()

    if (!connectionId) {
      return NextResponse.json({ error: "Connection ID required" }, { status: 400 })
    }

    // Clear progression logs
    await clearProgressionLogs(connectionId)
    
    // Also clear structured logs
    const client = getRedisClient()
    await client.del(`engine:logs:${connectionId}`)
    await client.del(`engine_logs:${connectionId}`)

    return NextResponse.json({
      success: true,
      message: "Logs cleared successfully",
      connectionId,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Error clearing progression logs:", error)
    return NextResponse.json(
      { error: "Failed to clear logs", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
