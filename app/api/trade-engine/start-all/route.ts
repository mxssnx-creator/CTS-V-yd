import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { initRedis, getAssignedAndEnabledConnections, getAllConnections, getSettings, getRedisClient } from "@/lib/redis-db"

async function handleStartAll() {
  try {
    const coordinator = getGlobalTradeEngineCoordinator()
    
    if (!coordinator) {
      return NextResponse.json({
        success: false,
        error: "Trade engine coordinator not initialized",
        results: [],
      }, { status: 503 })
    }

    await initRedis()
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global").catch(() => null)) as Record<string, string> | null
    if (globalState?.status !== "running") {
      return NextResponse.json({
        success: false,
        error: "Global coordinator is not enabled",
        message: "Start the Global Trade Engine Coordinator before starting connection progressions.",
        status: globalState?.status || "stopped",
        results: [],
      }, { status: 409 })
    }

    const connections = await getAllConnections()
    
    if (!Array.isArray(connections)) {
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        results: [],
      }, { status: 500 })
    }

    // Reuse the canonical Main Connections eligibility rule.
    // Use the same assignment + dashboard-enabled eligibility as the global
    // coordinator. `is_live_trade` controls live order execution, not whether
    // an assigned connection should receive general engine processing.
    const activeConnections = await getAssignedAndEnabledConnections()

    if (activeConnections.length === 0) {
      return NextResponse.json({
        success: true,
        message: "No assigned and dashboard-enabled connections found",
        totalConnections: connections.length,
        activeConnections: 0,
        results: [],
      })
    }

    const settings = (await getSettings("trade_engine_settings")) || {}
    const indicationInterval = settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 1
    const strategyInterval = settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 1
    const realtimeInterval = settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3

    const results = []
    let successCount = 0

    for (const connection of activeConnections) {
      try {
        // Reset evaluated counters for fresh start
        await initRedis()
        const evalKeys = [
          `strategies:${connection.id}:base:evaluated`,
          `strategies:${connection.id}:main:evaluated`,
          `strategies:${connection.id}:real:evaluated`,
        ]
        for (const key of evalKeys) {
          try {
            await getRedisClient().del(key)
          } catch (delErr) {
            console.warn(`[START-ALL] Failed to delete ${key}:`, delErr)
          }
        }

        const engineConfig = {
          connectionId: connection.id,
          allowInProcessStart: true,
          indicationInterval,
          strategyInterval,
          realtimeInterval,
        }
        const engineStarted = await coordinator.startEngine(connection.id, engineConfig, { markAssigned: true, forceLocalTakeover: true })

        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          exchange: connection.exchange,
          success: engineStarted,
          message: engineStarted ? "Engine started" : "Engine start skipped by coordinator",
        })

        if (engineStarted) {
          successCount++
        }
      } catch (error) {
        results.push({
          connectionId: connection.id,
          connectionName: connection.name,
          exchange: connection.exchange,
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    return NextResponse.json({
      success: true,
      message: `Queued ${successCount} of ${activeConnections.length} trade engines`,
      totalConnections: connections.length,
      activeConnections: activeConnections.length,
      successCount,
      results,
    })
  } catch (error) {
    console.error("[START-ALL] Error:", error)

    return NextResponse.json(
      {
        success: false,
        error: "Failed to start trade engines",
        details: error instanceof Error ? error.message : String(error),
      },
      { status: 500 }
    )
  }
}

export const dynamic = "force-dynamic"
export async function GET() {
  return handleStartAll()
}

export async function POST() {
  return handleStartAll()
}
