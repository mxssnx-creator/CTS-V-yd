import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

// Clear ALL stale engine timers
function clearAllEngineTimers() {
  const engineGlobal = globalThis as unknown as {
    __engine_timers?: Set<ReturnType<typeof setInterval>>
  }
  
  if (engineGlobal.__engine_timers && engineGlobal.__engine_timers.size > 0) {
    for (const timer of engineGlobal.__engine_timers) {
      try {
        clearInterval(timer)
      } catch {}
    }
    engineGlobal.__engine_timers.clear()
  }
}

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    let connectionId: string | undefined
    try {
      const text = await request.text()
      if (text && text.trim()) {
        const body = JSON.parse(text)
        connectionId = body.connectionId
      }
    } catch {
      // Empty or invalid body - stop all engines
    }

    console.log("[v0] [Trade Engine] Stopping trade engine for connection:", connectionId || "all")
    
    // CRITICAL: Clear stale timers from previous code versions
    clearAllEngineTimers()

    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()

    // If no connectionId, stop ALL engines (global shutdown)
    if (!connectionId) {
      // 1. Find all connections with active engines and record them for potential resume
      const { getAllConnections, updateConnection } = await import("@/lib/redis-db")
      const allConnections = await getAllConnections()
      const pausedConnections: string[] = []
      const pausedPresetConnections: string[] = []
      
      for (const conn of allConnections) {
        const isLiveTrade = conn.is_live_trade === "1" || conn.is_live_trade === true
        const isPresetTrade = conn.is_preset_trade === "1" || conn.is_preset_trade === true
        
        if (isLiveTrade || isPresetTrade) {
          const updates: Record<string, string> = {
            updated_at: new Date().toISOString(),
          }
          
          if (isLiveTrade) {
            pausedConnections.push(conn.id)
            updates.is_live_trade = "0"
            updates.paused_by_global = "1"
          }
          if (isPresetTrade) {
            pausedPresetConnections.push(conn.id)
            updates.is_preset_trade = "0"
            updates.paused_preset_by_global = "1"
          }
          
          await updateConnection(conn.id, { ...conn, ...updates })
          console.log("[v0] [Trade Engine] Paused connection:", conn.id, conn.name, 
            isLiveTrade ? "(main)" : "", isPresetTrade ? "(preset)" : "")
        }
      }
      
      // 2. Stop all running engines via coordinator
      try {
        if (coordinator) await coordinator.stopAll()
      } catch { /* ignore */ }
      
      // 3. Save paused lists so start route can resume them
      if (pausedConnections.length > 0) {
        await client.set("trade_engine:paused_connections", JSON.stringify(pausedConnections))
      }
      if (pausedPresetConnections.length > 0) {
        await client.set("trade_engine:paused_preset_connections", JSON.stringify(pausedPresetConnections))
      }
      
      const totalPaused = new Set([...pausedConnections, ...pausedPresetConnections]).size
      
      // 4. Set global state in Redis (write-through to Upstash)
      // CRITICAL: also write `operator_stopped="1"` so the migration
      // bootstrap (`ensureBaseConnections` in lib/redis-migrations.ts)
      // honours this explicit halt across module reloads / redeploys.
      // Without this flag the next module reload would resurrect
      // status="running" and the auto-start monitor would re-arm the
      // engines the operator just stopped.
      await client.hset("trade_engine:global", { 
        status: "stopped", 
        desired_status: "stopped",
        operator_intent: "stopped",
        actual_status: "stopped",
        active_worker_id: "",
        last_heartbeat_at: "",
        stopped_at: new Date().toISOString(),
        coordinator_ready: "false",
        operator_stopped: "1",
        operator_stopped_at: new Date().toISOString(),
        paused_main_count: String(pausedConnections.length),
        paused_preset_count: String(pausedPresetConnections.length),
      })
      
      console.log("[v0] [Trade Engine] All engines stopped. Paused", totalPaused, "connections (main:", pausedConnections.length, "preset:", pausedPresetConnections.length, ")")
      await SystemLogger.logTradeEngine(
        `Global engine stopped. Paused ${pausedConnections.length} main + ${pausedPresetConnections.length} preset engines.`,
        "info",
        { pausedConnections, pausedPresetConnections }
      )
      
      return NextResponse.json({ 
        success: true, 
        message: `All trade engines stopped. ${totalPaused} connection(s) paused.`,
        pausedConnections,
        pausedPresetConnections,
      })
    }

    // Verify connection exists in Redis
    const { getAllConnections } = await import("@/lib/redis-db")
    const connections = await getAllConnections()
    const connection = connections.find((c: any) => c.id === connectionId)

    if (!connection) {
      console.error("[v0] [Trade Engine] Connection not found:", connectionId)
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404 }
      )
    }

    try {
      // Stop the engine via coordinator
      await coordinator.stopEngine(connectionId, { operatorRequested: true })

      await SystemLogger.logTradeEngine(
        `Trade engine stopped successfully for connection: ${connection.name}`,
        "info",
        { connectionId, connectionName: connection.name }
      )

      console.log("[v0] [Trade Engine] Engine stopped successfully for connection:", connectionId)

      return NextResponse.json({
        success: true,
        message: "Trade engine stopped successfully",
        connectionId,
        connectionName: connection.name,
      })
    } catch (stopError) {
      console.error("[v0] [Trade Engine] Failed to stop engine:", stopError)
      await SystemLogger.logTradeEngine(
        `Failed to stop trade engine: ${stopError}`,
        "error",
        { connectionId, error: stopError instanceof Error ? stopError.message : String(stopError) }
      )

      return NextResponse.json(
        {
          success: false,
          error: "Failed to stop trade engine",
          details: stopError instanceof Error ? stopError.message : "Unknown error",
        },
        { status: 500 },
      )
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] [Trade Engine] Failed to process stop request:", errorMessage)
    await SystemLogger.logError(error, "trade-engine", "POST /api/trade-engine/stop")
    
    return NextResponse.json(
      {
        success: false,
        error: "Failed to stop trade engine",
        details: errorMessage,
      },
      { status: 500 },
    )
  }
}
