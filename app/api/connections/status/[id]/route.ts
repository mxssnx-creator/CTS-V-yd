import { type NextRequest, NextResponse } from "next/server"
import { getTradeEngineStatus } from "@/lib/trade-engine"
import { getConnection, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

// GET real-time status for a specific connection
export const dynamic = "force-dynamic"
export const maxDuration = 30
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id

    console.log("[v0] Fetching status for connection:", connectionId)

    await initRedis()
    const connection = await getConnection(connectionId)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Get real status from trade engine
    const engineStatus = await getTradeEngineStatus(connectionId)

    const status = {
      id: connection.id,
      name: connection.name,
      exchange: connection.exchange,
      status: connection.is_enabled ? (connection.is_live_trade ? "connected" : "connecting") : "disabled",
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

    return NextResponse.json(status)
  } catch (error) {
    console.error("[v0] Failed to fetch connection status:", error)
    await SystemLogger.logError(error, "api", "GET /api/connections/status/[id]")
    return NextResponse.json({ error: "Failed to fetch connection status" }, { status: 500 })
  }
}
