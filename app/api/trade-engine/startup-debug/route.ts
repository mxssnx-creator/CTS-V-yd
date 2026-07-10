import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadConnections, loadSettings } from "@/lib/file-storage"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] [DEBUG] Trade Engine Manual Startup Endpoint")

    const coordinator = getGlobalTradeEngineCoordinator()
    const connections = loadConnections()
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] [DEBUG] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        log: [`ERROR: Connections data is not an array (type: ${typeof connections})`],
      }, { status: 500 })
    }

    const enabledConnections = connections.filter(
      (c) => c.is_enabled === true && c.is_active === true
    )

    const settings = loadSettings()
    const indicationInterval = settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1
    const strategyInterval = settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1
    const realtimeInterval = settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3

    const results = []

    for (const connection of enabledConnections) {
      try {
        const engineConfig = {
          connectionId: connection.id,
          indicationInterval,
          strategyInterval,
          realtimeInterval,
        }

        const started = await coordinator.startEngine(connection.id, engineConfig)

        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          success: started,
          queued: false,
          message: started
            ? "Engine started successfully"
            : "Engine start skipped by coordinator/runtime gate",
        })
      } catch (error) {
        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return NextResponse.json({
      success: true,
      message: "Manual trade engine startup completed",
      totalConnections: connections.length,
      enabledConnections: enabledConnections.length,
      results,
    })
  } catch (error) {
    console.error("[v0] [DEBUG] Startup failed:", error)
    await SystemLogger.logError(error, "trade-engine", "Manual startup failed")

    return NextResponse.json(
      {
        success: false,
        error: "Manual startup failed",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}
