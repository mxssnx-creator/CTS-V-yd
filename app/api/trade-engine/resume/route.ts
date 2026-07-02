import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient, getActiveConnectionsForEngine } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/resume
 * Resume the Global Trade Engine Coordinator
 * Resumes all trading operations across all connections and restores previous state
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    // ── Publish running intent before resume starts engines ─────────────
    // startEngine() rejects starts unless trade_engine:global says running,
    // so order this write before coordinator.resume().
    try {
      await client.hset("trade_engine:global", {
        status: "running",
        operator_intent: "running",
        desired_status: "running",
        resumed_at: new Date().toISOString(),
      })
      await client.hdel("trade_engine:global", "paused_at", "paused_by", "previous_status")
      console.log("[v0] Global running intent published for resume")
    } catch (err) {
      console.warn("[v0] Failed to publish running intent:", err instanceof Error ? err.message : String(err))
      throw err
    }

    await coordinator.resume()
    
    // ── Clear "Paused" state on all Main Connections ───────────────────
    // When resuming the global coordinator, clear the pause marker and
    // restore connections to their normal operational state.
    try {
      const connections = await client.smembers(`engine:connections:main`) || []
      for (const connId of connections) {
        const stateKey = `trade_engine_state:${connId}`
        const state = await client.hgetall(stateKey)
        if (state && state.paused_by === "global_coordinator") {
          await client.hdel(stateKey, "status", "paused_at", "paused_by")
        }
      }
      console.log(`[v0] Cleared "Paused" state from ${connections.length} Main Connections`)
    } catch (err) {
      console.warn("[v0] Failed to update Main Connections state:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if connection state update fails
    }

    // ── Resume all paused progressions ──────────────────────────────────
    // Clear the pause marker from every progression so they resume
    // accepting work cycles. Only clear if marked by global_coordinator.
    try {
      const activeConnections = await getActiveConnectionsForEngine()
      const progressionIds = activeConnections.map((c) => c.id)
      
      let resumedCount = 0
      for (const progId of progressionIds) {
        const progKey = `progression:${progId}`
        const progState = await client.hgetall(progKey)
        if (progState && progState.paused_by === "global_coordinator") {
          await client.hdel(progKey, "status", "paused_at", "paused_by")
          resumedCount++
        }
      }
      
      if (resumedCount > 0) {
        console.log(`[v0] Resumed ${resumedCount} progressions`)
      }
    } catch (err) {
      console.warn("[v0] Failed to resume progressions:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if progression resume fails
    }

    // ── Rebuild control orders for all open live positions ───────────────
    // When the coordinator was paused, `syncWithExchange` was skipped and
    // no control orders (SL/TP) were created or healed. Now that we're
    // resuming, kick off a sync immediately on each connection to restore
    // protection orders and catch up on mark prices. Fire-and-forget so
    // the API returns quickly even if this takes a moment.
    try {
      const { initRedis: reInitRedis, getRedisClient: reGetClient } = await import("@/lib/redis-db")
      await reInitRedis()
      const reClient = reGetClient()
      
      // Get all main connections and trigger immediate live sync
      const connections = await reClient.smembers(`engine:connections:main`) || []
      console.log(`[v0] Triggering control order rebuild for ${connections.length} connections`)
      
      // Use fire-and-forget Promise.all to kick off syncs without waiting
      void Promise.all(
        connections.map(async (connId: string) => {
          try {
            const { getConnection } = await import("@/lib/redis-db")
            const connection = await getConnection(connId)
            if (!connection) return
            
            const apiKey = (connection as any).api_key || (connection as any).apiKey || ""
            const apiSecret = (connection as any).api_secret || (connection as any).apiSecret || ""
            if (!apiKey || !apiSecret) return // Paper-only connection
            
            const { createExchangeConnector } = await import("@/lib/exchange-connectors")
            const connector = await createExchangeConnector(connection.exchange, {
              apiKey,
              apiSecret,
              apiType: connection.api_type,
              contractType: connection.contract_type,
              isTestnet: connection.is_testnet === true || connection.is_testnet === "true",
            })
            if (!connector) return
            
            const { syncWithExchange } = await import("@/lib/trade-engine/stages/live-stage")
            await syncWithExchange(connId, connector)
            console.log(`[v0] Control orders rebuilt for connection ${connId}`)
          } catch (syncErr) {
            console.warn(
              `[v0] Failed to rebuild control orders for ${connId}:`,
              syncErr instanceof Error ? syncErr.message : String(syncErr),
            )
          }
        }),
      ).catch(() => {}) // Swallow errors from the fire-and-forget
    } catch (err) {
      console.warn(
        "[v0] Failed to trigger control order rebuild:",
        err instanceof Error ? err.message : String(err),
      )
      // Non-fatal: continue even if rebuild trigger fails
    }
    
    console.log("[v0] Global Trade Engine Coordinator resumed via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine resumed successfully",
      status: "running",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Resume API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}

