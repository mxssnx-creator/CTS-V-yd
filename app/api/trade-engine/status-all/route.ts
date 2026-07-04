import { NextResponse } from "next/server"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { getActiveConnectionsForEngine, getRedisClient, initRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"

function isEnabledFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}


function withTimeout<T>(promise: Promise<T>, timeoutMs: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<T>((resolve) => {
      timer = setTimeout(() => resolve(fallback), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function parseSymbols(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string" && item.length > 0)
  }
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parseSymbols(parsed)
    } catch {
      return value.split(",").map((item) => item.trim()).filter(Boolean)
    }
  }
  return []
}

async function stripConsumedRuntimeFlags(
  client: ReturnType<typeof getRedisClient>,
  connectionId: string,
  status: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const pending = (await withTimeout(
    client.hgetall(`settings:settings_change:${connectionId}`).catch(() => ({} as Record<string, string>)),
    750,
    {} as Record<string, string>,
  )) as Record<string, string>
  if (pending && typeof pending.connectionId === "string" && pending.connectionId.length > 0) return status

  const cleaned = { ...status }
  delete cleaned.restart_required
  delete cleaned.restart_reason
  delete cleaned.restart_requested_at
  delete cleaned.reload_required
  delete cleaned.reload_fields
  delete cleaned.reload_requested_at

  await withTimeout(Promise.all([
    client
      .hdel(
        `settings:trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
        "reload_required",
        "reload_fields",
        "reload_requested_at",
      )
      .catch(() => 0),
    client
      .hdel(
        `trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
        "reload_required",
        "reload_fields",
        "reload_requested_at",
      )
      .catch(() => 0),
  ]), 750, [0, 0])

  return cleaned
}

export const dynamic = "force-dynamic"
export async function GET() {
  try {
    console.log("[v0] Fetching all trade engine statuses")
    await initRedis()
    const client = getRedisClient()
    const globalState = await withTimeout(
      client.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)),
      1000,
      {} as Record<string, string>,
    )
    const globallyRunning = globalState.status === "running"
    const globallyPaused = globalState.status === "paused"

    const coordinator = getGlobalTradeEngineCoordinator()
    
    // Null check on coordinator
    if (!coordinator) {
      console.warn("[v0] Coordinator is null - engines may not be initialized yet")
      return NextResponse.json({
        success: false,
        error: "Trade engine coordinator not initialized",
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
        timestamp: new Date().toISOString(),
      }, { status: 503 })
    }

    const connections = await withTimeout(getActiveConnectionsForEngine(), 2000, [])
    
    // Ensure connections is an array
    if (!Array.isArray(connections)) {
      console.error("[v0] Connections is not an array:", typeof connections)
      return NextResponse.json({
        success: false,
        error: "Invalid connections data",
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
        timestamp: new Date().toISOString(),
      }, { status: 500 })
    }

    const activeConnections = connections.filter((c) => {
      const assigned =
        isEnabledFlag(c.is_assigned) ||
        isEnabledFlag(c.is_active_inserted) ||
        isEnabledFlag(c.is_dashboard_inserted)
      return assigned && isEnabledFlag(c.is_enabled_dashboard)
    })

    const engineStatuses = await Promise.all(
      activeConnections.map(async (conn) => {
        try {
          const redisStatePromise = client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>))
          const settingsStatePromise = client.hgetall(`settings:trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>))
          const status = await withTimeout(coordinator.getEngineStatus(conn.id), 1200, null)
          const redisStatus = status ?? {
            ...(await withTimeout(redisStatePromise, 750, {} as Record<string, string>)),
            ...(await withTimeout(settingsStatePromise, 750, {} as Record<string, string>)),
          }
          const isRunning = globallyRunning && !globallyPaused
          const configuredSymbols = parseSymbols(conn.active_symbols || conn.symbols)
          const statusSymbols = parseSymbols(redisStatus?.symbols || redisStatus?.active_symbols)
          const effectiveSymbols = configuredSymbols.length > 0 ? configuredSymbols : statusSymbols
          const rawEngineStatus = {
            ...((redisStatus ?? {
              status: globallyPaused ? "paused" : (isRunning ? "running" : "stopped"),
              source: "trade_engine:global",
            }) as Record<string, unknown>),
            ...(effectiveSymbols.length > 0
              ? {
                  symbols: effectiveSymbols,
                  active_symbols: effectiveSymbols,
                  symbol_count: effectiveSymbols.length,
                }
              : {}),
          }
          const engineStatus = await stripConsumedRuntimeFlags(client, conn.id, rawEngineStatus)

          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            assigned: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            processingEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isActive: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            isLiveTrading: isEnabledFlag(conn.is_live_trade),
            isEngineRunning: isRunning,
            engineStatus,
          }
        } catch (error) {
          console.error(`[v0] Failed to get status for ${conn.id}:`, error)
          return {
            connectionId: conn.id,
            connectionName: conn.name,
            exchange: conn.exchange,
            assigned: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            processingEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isEnabled: isEnabledFlag(conn.is_enabled_dashboard),
            isActive: isEnabledFlag(conn.is_active_inserted) || isEnabledFlag(conn.is_assigned) || isEnabledFlag(conn.is_dashboard_inserted),
            isLiveTrading: isEnabledFlag(conn.is_live_trade),
            isEngineRunning: false,
            error: error instanceof Error ? error.message : "Unknown error",
          }
        }
      })
    )

    const runningCount = engineStatuses.filter((s) => s.isEngineRunning).length
    const totalCount = engineStatuses.length

    console.log(`[v0] Engine status: ${runningCount}/${totalCount} running`)

    return NextResponse.json({
      success: true,
      engines: engineStatuses,
      summary: {
        total: totalCount,
        running: runningCount,
        stopped: totalCount - runningCount,
      },
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] Failed to fetch engine statuses:", error)
    await SystemLogger.logError(error, "trade-engine", "GET /api/trade-engine/status-all")

    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch engine statuses",
        details: error instanceof Error ? error.message : String(error),
        engines: [],
        summary: { total: 0, running: 0, stopped: 0 },
      },
      { status: 500 }
    )
  }
}
