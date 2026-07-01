import { NextResponse } from "next/server"
import { getAllConnections, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { getTradeEngineStatus } from "@/lib/trade-engine"

// GET real-time status for all active connections
export const dynamic = "force-dynamic"
export const maxDuration = 30
export async function GET() {
  try {
    console.log("[v0] Fetching real connection statuses from Redis")

    await initRedis()
    const connections = await getAllConnections()
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({ error: "Invalid connections data", statuses: [] }, { status: 500 })
    }

    const activeConnections = connections.filter((c: any) => c.is_enabled !== false)

    // Get real statuses from trade engines
    const statuses = await Promise.all(
      activeConnections.map(async (connection: any) => {
        try {
          const engineStatus = await getTradeEngineStatus(connection.id)

          const assigned = connection.is_active_inserted === true || connection.is_active_inserted === "1" || connection.is_assigned === true || connection.is_assigned === "1" || connection.is_dashboard_inserted === true || connection.is_dashboard_inserted === "1"
          const processingEnabled = connection.is_enabled_dashboard === true || connection.is_enabled_dashboard === "1"

          return {
            id: connection.id,
            name: connection.name,
            exchange: connection.exchange,
            assigned,
            processingEnabled,
            status: processingEnabled ? (connection.is_live_trade ? "connected" : "connecting") : "disabled",
            progress: engineStatus?.loadingProgress || 0,
            balance: engineStatus?.balance || 0,
            activePositions: engineStatus?.activePositions || 0,
            activeSymbols: engineStatus?.activeSymbols || 0,
            indicationsActive: engineStatus?.indicationsActive || 0,
            lastUpdate: engineStatus?.lastUpdate || new Date().toISOString(),
            isLoading: engineStatus?.isLoading || false,
            loadingStage: engineStatus?.loadingStage || "idle",
            error: engineStatus?.error || null,
          }
        } catch (error) {
          console.error(`[v0] Failed to get status for ${connection.id}:`, error)
          return {
            id: connection.id,
            name: connection.name,
            exchange: connection.exchange,
            assigned: connection.is_active_inserted === true || connection.is_active_inserted === "1" || connection.is_assigned === true || connection.is_assigned === "1" || connection.is_dashboard_inserted === true || connection.is_dashboard_inserted === "1",
            processingEnabled: connection.is_enabled_dashboard === true || connection.is_enabled_dashboard === "1",
            status: "error",
            progress: 0,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      }),
    )

    return NextResponse.json(statuses)
  } catch (error) {
    console.error("[v0] Failed to fetch connection statuses:", error)
    await SystemLogger.logError(error, "api", "GET /api/connections/status")
    return NextResponse.json({ error: "Failed to fetch connection statuses", statuses: [] }, { status: 500 })
  }
}
