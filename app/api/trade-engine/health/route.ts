import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadConnections } from "@/lib/file-storage"
import { query } from "@/lib/db"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Fetching trade engine health status")
    
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Null check on coordinator
    if (!coordinator) {
      console.warn("[v0] Coordinator is null - engines may not be initialized yet")
      return NextResponse.json({
        success: false,
        error: "Trade engine coordinator not initialized",
        overall: "offline",
        runningEngines: 0,
        totalEngines: 0,
        engines: [],
        timestamp: new Date().toISOString(),
      }, { status: 503 })
    }

    const connections = loadConnections()
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        overall: "error",
        engines: [],
      }, { status: 500 })
    }

    const enabledConnections = connections.filter((c) => c.is_enabled)

    // Get health for each engine
    const engineHealthStatus = await Promise.all(
      enabledConnections.map(async (conn) => {
        try {
          const engineStatus = await coordinator.getEngineStatus(conn.id)
          const state = await query<{ state: string; updated_at: string }>(
            `SELECT state, updated_at FROM trade_engine_state WHERE connection_id = ?`,
            [conn.id]
          )

          // Determine if engine is running based on health status:
          // Health components report "healthy" when their cycles are progressing.
          const isRunning = engineStatus?.health?.components?.realtime?.status === "healthy"
            || engineStatus?.health?.components?.indications?.status === "healthy"
            || engineStatus?.health?.components?.strategies?.status === "healthy"

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            status: isRunning ? "running" : "idle",
            isRunning,
            lastUpdate: state[0]?.updated_at || null,
            errorMessage: engineStatus?.errorMessage || null,
          }
        } catch (err) {
          console.error(`[v0] Failed to get health for ${conn.id}:`, err)
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            status: "error",
            isRunning: false,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      })
    )

    const runningCount = engineHealthStatus.filter((s) => s.isRunning).length
    const totalCount = engineHealthStatus.length

    return NextResponse.json({
      success: true,
      overall: runningCount > 0 ? "healthy" : "idle",
      runningEngines: runningCount,
      totalEngines: totalCount,
      engines: engineHealthStatus,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to get health status:", error)
    return NextResponse.json(
      { success: false, error: "Failed to get health status", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
