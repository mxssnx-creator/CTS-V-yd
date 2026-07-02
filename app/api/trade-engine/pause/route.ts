import { NextResponse } from "next/server"
import { getTradeEngine } from "@/lib/trade-engine"
import { initRedis, getRedisClient, getActiveConnectionsForEngine } from "@/lib/redis-db"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

/**
 * POST /api/trade-engine/pause
 * Pause the Global Trade Engine Coordinator
 * Pauses all trading operations across all connections and marks Main Connections + Progressions as "Paused"
 */
export async function POST() {
  try {
    await initRedis()
    const client = getRedisClient()
    const coordinator = getTradeEngine()

    if (!coordinator) {
      return NextResponse.json({ success: false, error: "Trade engine coordinator not initialized" }, { status: 503 })
    }

    // ── Update Redis global state to "paused" before stopping engines ──
    // trade_engine:global is the authority checked by every worker. Publish
    // paused intent first so remote owners stop doing work immediately and
    // so no reconciliation/start path can race in as "running".
    const currentGlobalState = await client.hgetall("trade_engine:global").catch(() => ({}))
    const previousStatus = (currentGlobalState as any).status === "paused"
      ? (currentGlobalState as any).previous_status || "running"
      : (currentGlobalState as any).status || (currentGlobalState as any).operator_intent || "running"
    const pausedAt = new Date().toISOString()

    await client.hset("trade_engine:global", { 
      status: "paused",
      operator_intent: "paused",
      desired_status: "paused",
      paused_at: pausedAt,
      paused_by: "global_coordinator",
      previous_status: previousStatus,
    })
    console.log(`[v0] Global pause intent published (was: ${previousStatus})`)

    await coordinator.pause()
    
    // ── Set all Main Connections to "Paused" state ──────────────────
    // When the global coordinator is paused, all enabled Main Connections
    // (connections visible in the dashboard) should reflect that they are
    // paused. This is independent from their individual is_enabled status
    // — they remain enabled, but their operational state becomes "Paused".
    try {
      const connections = await client.smembers(`engine:connections:main`) || []
      for (const connId of connections) {
        await client.hset(`trade_engine_state:${connId}`, {
          status: "paused",
          paused_at: pausedAt,
          paused_by: "global_coordinator",
        })
      }
      console.log(`[v0] Set ${connections.length} Main Connections to "Paused" state`)
    } catch (err) {
      console.warn("[v0] Failed to update Main Connections state:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if connection state update fails
    }

    // ── Pause all active progressions ──────────────────────────────────
    // Mark every active progression as paused so they stop accepting new
    // work cycles and can be resumed independently later. Store the pause
    // timestamp so the progression stats endpoint can detect pause duration.
    try {
      const activeConnections = await getActiveConnectionsForEngine()
      const progressionIds = activeConnections.map((c) => c.id)
      
      for (const progId of progressionIds) {
        await client.hset(`progression:${progId}`, {
          status: "paused",
          paused_at: pausedAt,
          paused_by: "global_coordinator",
        })
      }
      
      if (progressionIds.length > 0) {
        console.log(`[v0] Paused ${progressionIds.length} progressions`)
      }
    } catch (err) {
      console.warn("[v0] Failed to pause progressions:", err instanceof Error ? err.message : String(err))
      // Non-fatal: continue even if progression pause fails
    }
    
    console.log("[v0] Global Trade Engine Coordinator paused via API")

    return NextResponse.json({
      success: true,
      message: "Trade engine paused successfully",
      status: "paused",
    })
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    console.error("[v0] Pause API error:", errorMessage)

    return NextResponse.json({ success: false, error: errorMessage }, { status: 500 })
  }
}
