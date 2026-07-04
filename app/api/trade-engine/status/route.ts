import { NextResponse } from "next/server"
import { getRedisClient, initRedis, getActiveConnectionsForEngine } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { buildMissingTradeEngineWorkerDiagnostic, readTradeEngineWorkerHeartbeat } from "@/lib/trade-engine-worker-heartbeat"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"

const STATUS_CACHE_TTL_MS = Number(process.env.TRADE_ENGINE_STATUS_CACHE_MS || 1_500)
const statusCacheGlobal = globalThis as unknown as {
  __trade_engine_status_cache?: { expiresAt: number; body: unknown }
}

// RUNTIME FIX: Patch IndicationProcessor cache on every API call
// This fixes the "Cannot read properties of undefined (reading 'get')" error
function patchIndicationProcessorCaches(coordinator: any) {
  if (!coordinator) return
  
  try {
    // Access all engine managers and patch their indication processors
    const engines = coordinator.engines || coordinator._engines || new Map()
    for (const [, manager] of engines) {
      if (manager?.indicationProcessor) {
        const proc = manager.indicationProcessor
        if (!proc.marketDataCache || !(proc.marketDataCache instanceof Map)) {
          proc.marketDataCache = new Map()
        }
        if (!proc.settingsCache) {
          proc.settingsCache = { data: null, timestamp: 0 }
        }
        if (!proc.CACHE_TTL) {
          proc.CACHE_TTL = 500
        }
      }
    }
  } catch (e) {
    // Silently ignore patch errors
  }
}

// FAKE-DATA WRITER REMOVED (no-fake-data directive):
// `generateIndicationsIfNeeded()` previously lived here and wrote synthetic
// indications with HARDCODED profitFactor (1.2/1.1/1.3) and confidence
// values into `indications:{conn}` on every status poll, bypassing the real
// IndicationProcessor pipeline. It was a workaround for a since-fixed
// processor bug. All indications now come exclusively from the real engine.

export async function GET() {
  try {
    const now = Date.now()
    const cached = statusCacheGlobal.__trade_engine_status_cache
    if (cached && cached.expiresAt > now) {
      return NextResponse.json(cached.body)
    }

    await initRedis()
    const client = getRedisClient()
    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Apply cache fix to all indication processors
    patchIndicationProcessorCaches(coordinator)

    // Read global engine state once — operator intent lives here.
    const engineHash: Record<string, string> =
      (await client.hgetall("trade_engine:global").catch(() => null) as Record<string, string> | null) ?? {}

    const operatorIntent = engineHash.operator_intent || engineHash.desired_status || engineHash.status || "stopped"
    const globalCoordinatorIntent = engineHash.desired_status || engineHash.status || operatorIntent
    const isGloballyRunning = operatorIntent === "running" || globalCoordinatorIntent === "running"
    const isGloballyPaused  = operatorIntent === "paused"
    // Reads trade_engine:global.last_heartbeat_at via the shared worker heartbeat helper.
    const workerHeartbeat = readTradeEngineWorkerHeartbeat(engineHash)
    const globalHeartbeatAt = workerHeartbeat.lastHeartbeatAt || 0
    const hasFreshGlobalHeartbeat = workerHeartbeat.fresh
    const workerDiagnostic = buildMissingTradeEngineWorkerDiagnostic(engineHash)

    
    // Also check in-memory coordinator state
    const coordinatorRunning = coordinator?.isRunning() || false

    // RECONCILIATION DIRECTION FIX (no-auto-start directive):
    // Redis `trade_engine:global.status` is the OPERATOR's source of truth.
    // The previous code did the reverse — when the in-memory coordinator
    // still thought it was running (e.g. stopAll() threw midway, leaving
    // isGloballyRunning=true in memory), this GET handler force-rewrote
    // status="running" into Redis, silently resurrecting an engine the
    // operator had explicitly stopped. Every dashboard poll re-applied it,
    // making Stop impossible to win.
    // Correct direction: if Redis says NOT running but the coordinator
    // still is, stop the coordinator to honour the operator's intent.
    if (coordinatorRunning && !isGloballyRunning && !isGloballyPaused) {
      console.log(
        "[v0] [StatusAPI] Coordinator running but operator status is",
        engineHash.status || "(unset)",
        "— stopping coordinator to honour operator intent (was previously resurrecting Redis)."
      )
      // Best-effort, non-blocking: the status read must stay fast.
      coordinator?.stopAll().catch((e: unknown) => {
        console.error("[v0] [StatusAPI] Failed to stop orphaned coordinator:", (e as Error)?.message)
      })
    }

    // Only a local coordinator manager proves in-process runtime liveness here.
    // Per-connection processor heartbeats are folded into the final response
    // after connection statuses are loaded below.
    const hasRuntimeProof = coordinatorRunning
    
    // Get active connections
    const connections = await getActiveConnectionsForEngine()
    const coordinatorEngineCount = coordinator?.getActiveEngineCount() || 0
    const hasLocalEngineRuntime = coordinatorEngineCount > 0
    
    if (connections.length === 0) {
      // Get all connections to explain why none are active
      const { getAllConnections } = await import("@/lib/redis-db")
      const allConnections = await getAllConnections()
      
      // Analyze why no connections are active
      const analysis = {
        total: allConnections.length,
        withCredentials: allConnections.filter((c: any) => 
          !!(c.api_key) && c.api_key.length > 10 && !!(c.api_secret) && c.api_secret.length > 10
        ).length,
        inActivePanel: allConnections.filter((c: any) => 
          c.is_active_inserted === "1" || c.is_active_inserted === true
        ).length,
        dashboardEnabled: allConnections.filter((c: any) => 
          c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true
        ).length,
      }
      
      return NextResponse.json({
        success: true,
        running: false,
        isRunning: false,
        paused: isGloballyPaused,
        status: isGloballyPaused ? "paused" : (isGloballyRunning ? "degraded" : "stopped"),
        actualStatus: isGloballyPaused ? "paused" : (isGloballyRunning ? "degraded" : "stopped"),
        operatorIntent,
        globalCoordinatorIntent,
        workerAttached: hasLocalEngineRuntime,
        globalHeartbeatFresh: hasFreshGlobalHeartbeat,
        connectionHeartbeatFresh: false,
        actualRuntimeStatus: isGloballyPaused ? "paused" : (isGloballyRunning ? "starting" : "stopped"),
        activeWorkerId: engineHash.active_worker_id || null,
        lastHeartbeatAt: globalHeartbeatAt || null,
        activeEngineCount: coordinator?.getActiveEngineCount() || 0,
        connections: [],
        summary: { total: 0, running: 0, stopped: 0, totalTrades: 0, totalPositions: 0, errors: 0 },
        analysis,
        diagnostics: {
          worker: workerDiagnostic,
        },
        requirements: {
          message: workerDiagnostic.error || "No connections eligible for processing",
          needed: [
            analysis.withCredentials === 0 ? "Add API credentials to a connection" : null,
            analysis.inActivePanel === 0 ? "Add a connection to the Active panel" : null,
            analysis.dashboardEnabled === 0 ? "Enable a connection via the dashboard toggle" : null,
          ].filter(Boolean),
          setupEndpoint: "POST /api/system/demo-setup with api_key, api_secret, exchange"
        }
      })
    }

    // Build connection status for ACTIVE connections only
    const connectionStatuses = await Promise.all(
      connections.map(async (conn: any) => {
        try {
          // Get progression state
          const progressionState = await ProgressionStateManager.getProgressionState(conn.id)
          
          // Get positions and trades counts
          const positionsKey = `positions:${conn.id}`
          const tradesKey = `trades:${conn.id}`
          
          const positionsCount = await client.scard(positionsKey)
          const tradesCount = await client.scard(tradesKey)
          const engineState = await client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>))
          const processorHeartbeat = Number((engineState as any)?.last_processor_heartbeat || 0)
          const hasFreshDistributedHeartbeat =
            Number.isFinite(processorHeartbeat) && processorHeartbeat > 0 && Date.now() - processorHeartbeat < 90_000

          // Determine if this connection's engine is actively running either in
          // THIS worker or in another production worker with a fresh Redis
          // heartbeat. Redis `trade_engine:global.status=running` is only
          // operator intent; the heartbeat is the distributed proof of real
          // engine progress and avoids both false "running" and false "stopped"
          // in multi-worker/OpenNext deployments.
          const connectionRunning =
            isGloballyRunning && !isGloballyPaused && (hasLocalEngineRuntime || hasFreshDistributedHeartbeat)

          return {
            id: conn.id,
            name: conn.name,
            exchange: conn.exchange,
            status: connectionRunning ? "running" : "stopped",
            workerAttached: hasLocalEngineRuntime,
            distributedHeartbeatFresh: hasFreshDistributedHeartbeat,
            connectionHeartbeatFresh: hasFreshDistributedHeartbeat,
            actualRuntimeStatus: connectionRunning ? "running" : (isGloballyPaused ? "paused" : (isGloballyRunning ? "starting" : "stopped")),
            lastProcessorHeartbeat: processorHeartbeat || null,
            assigned: conn.is_active_inserted === true || conn.is_active_inserted === "1" || conn.is_assigned === true || conn.is_assigned === "1" || conn.is_dashboard_inserted === true || conn.is_dashboard_inserted === "1",
            processingEnabled: conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "1",
            enabled: conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "1",
            activelyUsing: conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "1",
            positions: positionsCount,
            trades: tradesCount,
            progression: {
              cycles_completed: progressionState.cyclesCompleted || 0,
              successful_cycles: progressionState.successfulCycles || 0,
              failed_cycles: progressionState.failedCycles || 0,
            },
            state: progressionState,
          }
        } catch (error) {
          console.error(`[v0] [Status] Error processing connection ${conn.id}:`, error)
          return {
            id: conn.id,
            name: conn.name,
            exchange: conn.exchange,
            status: "error",
            assigned: conn.is_active_inserted === true || conn.is_active_inserted === "1" || conn.is_assigned === true || conn.is_assigned === "1" || conn.is_dashboard_inserted === true || conn.is_dashboard_inserted === "1",
            processingEnabled: false,
            enabled: false,
            activelyUsing: false,
            positions: 0,
            trades: 0,
            progression: { cycles_completed: 0, successful_cycles: 0, failed_cycles: 0 },
            state: {},
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      })
    )

    // Calculate summary
    const summary = {
      total: connectionStatuses.length,
      running: connectionStatuses.filter((c: any) => c.status === "running").length,
      stopped: connectionStatuses.filter((c: any) => c.status === "stopped" || c.status === "error").length,
      totalTrades: connectionStatuses.reduce((sum: number, c: any) => sum + (c.trades || 0), 0),
      totalPositions: connectionStatuses.reduce((sum: number, c: any) => sum + (c.positions || 0), 0),
      errors: connectionStatuses.filter((c: any) => c.error).length,
    }

    const distributedEngineCount = connectionStatuses.filter((c: any) => c.distributedHeartbeatFresh).length
    const activeEngineCount = Math.max(coordinatorEngineCount, distributedEngineCount)
    const effectivelyRunning = isGloballyRunning && !isGloballyPaused && (hasRuntimeProof || distributedEngineCount > 0)

    const responseBody = {
      success: true,
      running: effectivelyRunning,
      paused: isGloballyPaused,
      status: effectivelyRunning ? "running" : (isGloballyPaused ? "paused" : (isGloballyRunning ? "degraded" : "stopped")),
      activeEngineCount,
      workerAttached: hasLocalEngineRuntime,
      distributedEngineCount,
      operatorIntent,
      globalCoordinatorIntent,
      operatorStatus: operatorIntent,
      actualRuntimeStatus: effectivelyRunning ? "running" : (isGloballyPaused ? "paused" : (isGloballyRunning ? "starting" : "stopped")),
      actualStatus: effectivelyRunning ? "running" : (isGloballyPaused ? "paused" : "degraded"),
      globalHeartbeatFresh: hasFreshGlobalHeartbeat,
      connectionHeartbeatFresh: distributedEngineCount > 0,
      activeWorkerId: engineHash.active_worker_id || null,
      lastHeartbeatAt: globalHeartbeatAt || null,
      diagnostics: {
        rootCause:
          workerDiagnostic.error ||
          (isGloballyRunning && activeEngineCount === 0
            ? "Global Redis operator intent is running, but no local manager or fresh distributed processor heartbeat is attached. The server boot auto-start/continuity sweep should attach processing; if it does not, check production boot logs and cron execution."
            : null),
        hint:
          activeEngineCount === 0
            ? "No local engine runtime is attached yet; explicit UI actions and continuity sweeps will attach engine work in this process."
            : null,
        requiredWorkerEnv: "Optional for dedicated-worker deployments: set ENABLE_TRADE_ENGINE_AUTOSTART=1 on exactly one long-lived worker/process; normal production Node processes auto-start foreground work from boot and continuity sweeps unless disabled.",
        worker: workerDiagnostic,
      },
      connections: connectionStatuses,
      summary,
    }

    console.log(`[v0] [Status] Returning ${connectionStatuses.length} active connections, global running: ${isGloballyRunning}`)
    statusCacheGlobal.__trade_engine_status_cache = {
      expiresAt: Date.now() + Math.max(0, STATUS_CACHE_TTL_MS),
      body: responseBody,
    }
    return NextResponse.json(responseBody)
  } catch (error) {
    console.error("[v0] [Status] Error:", error)
    return NextResponse.json(
      {
        success: false,
        running: false,
        paused: false,
        status: "error",
        connections: [],
        summary: { total: 0, running: 0, stopped: 0, totalTrades: 0, totalPositions: 0, errors: 1 },
        error: error instanceof Error ? error.message : "Failed to fetch trade engine status",
      },
      { status: 500 }
    )
  }
}
