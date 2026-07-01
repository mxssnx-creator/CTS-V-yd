import { NextResponse } from "next/server"
import { getAllConnections, getAssignedAndEnabledConnections, getRedisClient, initRedis } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * GET /api/trade-engine/diagnostic
 * Diagnostic endpoint to show why trade engine isn't starting
 */
export async function GET() {
  try {
    console.log("[v0] [Diagnostic] Analyzing trade engine startup state...")
    
    await initRedis()
    const client = getRedisClient()
    const allConnections = await getAllConnections()
    const assignedAndEnabled = await getAssignedAndEnabledConnections()
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Check if ANY connections have is_enabled_dashboard = true/"1"
    const activeConnections = allConnections.filter((c: any) => {
      const d = c.is_enabled_dashboard
      return d === true || d === "1" || d === "true"
    })
    
    const dashboardInsertedConnections = allConnections.filter((c: any) => {
      const d = c.is_dashboard_inserted
      return d === "1" || d === true
    })
    
    const baseConnections = allConnections.filter((c: any) => {
      const isBase = ["bybit", "bingx", "pionex", "orangex", "binance", "okx"].includes((c.exchange || "").toLowerCase())
      return isBase
    })
    
    const [globalState, refreshRequest, marketDataKeys, prehistoricKeys, engineStateKeys] = await Promise.all([
      client.hgetall("trade_engine:global").catch(() => ({})),
      client.hgetall("settings:engine_coordinator:refresh_requested").catch(() => ({})),
      client.keys("market_data:*:1m").catch(() => []),
      client.keys("prehistoric:*").catch(() => []),
      client.keys("settings:trade_engine_state:*").catch(() => []),
    ])
    const heartbeatRaw = String((globalState as Record<string, string>)?.last_heartbeat_at || "")
    const heartbeatMs = Number(heartbeatRaw)
    const lastHeartbeatAt =
      Number.isFinite(heartbeatMs) && heartbeatMs > 0
        ? new Date(heartbeatMs).toISOString()
        : heartbeatRaw || null
    const refreshTimestamp = String((refreshRequest as Record<string, string>)?.timestamp || "")

    const diagnostic = {
      timestamp: new Date().toISOString(),
      summary: {
        totalConnections: allConnections.length,
        baseConnections: baseConnections.length,
        dashboardInserted: dashboardInsertedConnections.length,
        dashboardActive: activeConnections.length,
        assignedAndEnabled: assignedAndEnabled.length,
        tradeEngineCanStart: assignedAndEnabled.length > 0,
        coordinatorActiveEngines: coordinator?.getActiveEngineCount?.() ?? 0,
      },
      runtime: {
        globalState,
        coordinatorLifecycle: {
          autoStartEnv: process.env.ENABLE_TRADE_ENGINE_AUTOSTART || "",
          continuityEnv: process.env.ENABLE_IN_PROCESS_CONTINUITY || "",
          activeWorkerId: (globalState as Record<string, string>)?.active_worker_id || null,
          lastHeartbeatAt,
          refreshRequested: Boolean(refreshTimestamp && refreshTimestamp !== "null"),
        },
        dataCoverage: {
          marketDataKeys: marketDataKeys.length,
          prehistoricKeys: prehistoricKeys.length,
          tradeEngineStateKeys: engineStateKeys.length,
        },
      },
      details: {
        allConnections: allConnections.map((c: any) => ({
          id: c.id,
          name: c.name,
          exchange: c.exchange,
          is_enabled: c.is_enabled,
          is_dashboard_inserted: c.is_dashboard_inserted,
          is_enabled_dashboard: c.is_enabled_dashboard,
          is_assigned: c.is_assigned,
          is_live_trade: c.is_live_trade,
          hasCredentials: !!(c.api_key && c.api_secret && String(c.api_key).length > 8 && String(c.api_secret).length > 8),
        })),
      },
      diagnosis: {
        noActiveConnections: assignedAndEnabled.length === 0,
        reason: assignedAndEnabled.length === 0 
          ? "No connections are both assigned-to-main and dashboard-enabled."
          : "Engine should process. If not, inspect runtime/dataCoverage and progression keys.",
        nextSteps: assignedAndEnabled.length === 0
          ? [
              "1. Ensure Global Trade Engine is running: POST /api/trade-engine/start",
              "2. Add connection to Main panel (assigned)",
              "3. Toggle dashboard Enable to ON",
              "4. Verify credentials are present",
              "5. Re-check /api/trade-engine/status and this diagnostic endpoint"
            ]
          : [
              "1. Check globalState.status is running",
              "2. Verify marketDataKeys and tradeEngineStateKeys are increasing",
              "3. Inspect /api/trade-engine/detailed-logs for cycle progress"
            ],
      },
    }
    
    console.log("[v0] [Diagnostic] Analysis complete:", {
      totalConnections: diagnostic.summary.totalConnections,
      dashboardActive: diagnostic.summary.dashboardActive,
      canStart: diagnostic.summary.tradeEngineCanStart,
    })
    
    return NextResponse.json(diagnostic)
  } catch (error) {
    console.error("[v0] [Diagnostic] Error:", error)
    return NextResponse.json(
      { error: "Failed to run diagnostic", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
