import { NextResponse } from "next/server"
import { initRedis, getAllConnections, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"

/**
 * GET /api/engine/system-status
 * Returns comprehensive system health including:
 * - Active connections
 * - Indication processing status
 * - Strategy evaluation status
 * - Recent errors and performance metrics
 */
export const dynamic = "force-dynamic"
export async function GET() {
  try {
    await initRedis()

    const connections = await getAllConnections()

    // Mirror the same eligibility logic as getAssignedAndEnabledConnections():
    // assigned to Main Connections and explicitly dashboard-enabled.
    const _isOn = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"
    const activeConnections = connections.filter((c: any) => {
      const assigned = _isOn(c.is_active_inserted) || _isOn(c.is_assigned) || _isOn(c.is_dashboard_inserted)
      const enabled = _isOn(c.is_enabled_dashboard)
      return assigned && enabled
    })

    // Get engine state for first active connection.
    //
    // Canonical key per the dual-progression audit (see
    // `v0_plans/comprehensive-system-audit.md`, item 5):
    //   • last_*_run + *_avg_duration_ms       → trade_engine_state:{id}  (heartbeat / health)
    //   • *_cycle_count + total_strategies_evaluated → progression:{id}    (atomic counters)
    //
    // Previously every cycle counter on this route was read from
    // `trade_engine_state` only, which held a *snapshot* written at most
    // once per cycle and lagged the authoritative atomic counters in
    // `progression:{id}`. After a watchdog re-arm the snapshot can stay
    // empty for many seconds while progression keeps incrementing —
    // visually freezing this status surface and producing false
    // "engine not running" recommendations. We now read the counters
    // from `progression:` first and fall back to `trade_engine_state` so
    // the response stays correct on legacy data.
    // Fall back to any connection that has engine state if activeConnections
    // is still empty (e.g. snapshot restored without re-running quickstart).
    const connectionId =
      activeConnections[0]?.id ||
      connections.find((c: any) => _isOn(c.is_enabled_dashboard) && (_isOn(c.is_assigned) || _isOn(c.is_active_inserted) || _isOn(c.is_dashboard_inserted)))?.id ||
      "unknown"

    // Read counters from the authoritative Redis keys:
    //   progression:{id}      — atomic hincrby counters (ProgressionStateManager)
    //   trade_engine_state:{id} — heartbeat snapshot written each cycle
    // getSettings() uses a "settings:" prefix so it is the wrong read path
    // for these keys — use hgetall directly.
    const client = getRedisClient()
    const progression = (connectionId !== "unknown" ? await client.hgetall(`progression:${connectionId}`) : null) || {}
    const engineState = (connectionId !== "unknown" ? await client.hgetall(`trade_engine_state:${connectionId}`) : null) || {}

    const indicationCycles =
      Number((progression as any).indication_cycle_count) ||
      Number((engineState as any).indication_cycle_count) || 0
    const strategyCycles =
      Number((progression as any).strategy_cycle_count) ||
      Number((engineState as any).strategy_cycle_count) || 0
    const totalStrategiesEvaluated =
      Number((progression as any).total_strategies_evaluated) ||
      Number((engineState as any).total_strategies_evaluated) || 0
    const totalTrades =
      Number((progression as any).total_trades) || 0
    const openPositions =
      Number((progression as any).open_positions) ||
      Number((engineState as any).open_positions) || 0
    const closedToday =
      Number((progression as any).closed_today) ||
      Number((engineState as any).closed_today) || 0

    const status = {
      timestamp: new Date().toISOString(),
      system: {
        totalConnections: connections.length,
        activeConnections: activeConnections.length,
        activeConnectionNames: activeConnections.map((c: any) => c.name || c.exchange),
      },
      indication: {
        lastRun: engineState.last_indication_run,
        cycleCount: indicationCycles,
        avgDurationMs: Math.round(Number(engineState.indication_avg_duration_ms) || 0),
        status: indicationCycles > 0 ? "running" : "idle",
      },
      strategy: {
        lastRun: engineState.last_strategy_run,
        cycleCount: strategyCycles,
        avgDurationMs: Math.round(Number(engineState.strategy_avg_duration_ms) || 0),
        totalEvaluated: totalStrategiesEvaluated,
        status: strategyCycles > 0 ? "running" : "idle",
      },
      live: {
        openPositions,
        closedToday,
        totalTrades,
      },
      recommendation: getRecommendation(activeConnections, {
        indication_cycle_count: indicationCycles,
        strategy_cycle_count: strategyCycles,
        total_strategies_evaluated: totalStrategiesEvaluated,
      }),
    }

    await logProgressionEvent(connectionId, "system_status_check", "info", "System status report generated", status)

    return NextResponse.json(status, { status: 200 })
  } catch (error) {
    console.error("[v0] [SystemStatus] Error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

function getRecommendation(activeConnections: any[], engineState: any): string {
  if (activeConnections.length === 0) {
    return "No active connections. Use quick-start to enable a connection."
  }
  if (!engineState.indication_cycle_count) {
    return "Indication engine not running. Check connection and restart."
  }
  if (!engineState.strategy_cycle_count) {
    return "Strategy engine not running. Check indication processor output."
  }
  if (engineState.total_strategies_evaluated === 0) {
    return "Strategies being evaluated but none passing evaluation yet. Check thresholds."
  }
  return "System healthy and processing strategies."
}
