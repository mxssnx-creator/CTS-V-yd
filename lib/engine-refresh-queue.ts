import { getRedisClient, getSettings, setSettings } from "./redis-db"

export const ENGINE_REFRESH_REQUEST_PREFIX = "engine_coordinator:refresh_requested:"

export type EngineRefreshAction = "start" | "stop" | "refresh"

export interface EngineRefreshRequest {
  connectionId: string
  action: EngineRefreshAction | string
  state_switch_version: string | number
  reason: string
  timestamp: string
}

export function nextStateSwitchVersion(connection: any): string {
  const current = Number(connection?.state_switch_version ?? 0)
  return String((Number.isFinite(current) ? current : 0) + 1)
}

export function currentStateSwitchVersion(connection: any): string {
  return String(connection?.state_switch_version ?? 0)
}

async function triggerImmediateEngineRefresh(request: EngineRefreshRequest): Promise<void> {
  // Event-state fast path: act on the changed connection only. Running a full
  // healing sweep from every toggle was fast but too memory-heavy because it
  // loaded all eligible connections and could fan out multiple engine starts.
  // This targeted path keeps the timer as a safety net while explicit actions
  // (enable/disable/progression/state changes) converge immediately.
  if (process.env.NEXT_RUNTIME === "edge") return

  try {
    const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
    const { getConnection, getRedisClient } = await import("./redis-db")
    const coordinator = getGlobalTradeEngineCoordinator()
    const action = request.action

    if (action === "stop") {
      if (coordinator.isEngineRunning(request.connectionId)) {
        await coordinator.stopEngine(request.connectionId, { operatorRequested: true })
      }
      return
    }

    const connection = await getConnection(request.connectionId).catch(() => null)
    if (!connection) return

    if (String(connection.state_switch_version ?? 0) !== String(request.state_switch_version ?? "")) {
      return
    }

    if (action === "start") {
      const globalState = await getRedisClient().hgetall("trade_engine:global").catch(() => ({} as Record<string, string>))
      const intent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || ""
      if (intent === "running" && !coordinator.isEngineRunning(request.connectionId)) {
        await coordinator.startMissingEngines([connection])
      }
      return
    }

    await coordinator.applyPendingChangesNow?.(request.connectionId)
  } catch (error) {
    console.warn(
      `[v0] [EngineRefreshQueue] Immediate targeted refresh failed (${request.reason || request.action}):`,
async function triggerImmediateEngineRefresh(reason: string): Promise<void> {
  // Event-state fast path: explicit UI/API state changes should be acted on
  // immediately by the current process instead of waiting for the 30s healing
  // sweep. This is best-effort and intentionally no-ops in Edge/serverless
  // runtimes where a different worker may own the long-lived engine.
  if (process.env.NEXT_RUNTIME === "edge") return

  try {
    const { runTradeEngineHealingSweep } = await import("./trade-engine-auto-start")
    await runTradeEngineHealingSweep({ isStartup: false })
  } catch (error) {
    console.warn(
      `[v0] [EngineRefreshQueue] Immediate refresh trigger failed (${reason}):`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export async function queueEngineRefreshRequest(request: EngineRefreshRequest): Promise<void> {
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, request)
  await triggerImmediateEngineRefresh(request)
  await triggerImmediateEngineRefresh(request.reason || request.action || "queued_refresh")
}

export async function getQueuedEngineRefreshRequests(): Promise<Array<{ key: string; request: EngineRefreshRequest }>> {
  const client = getRedisClient()
  const keys = await client.keys(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}*`).catch(() => [] as string[])
  const requests = await Promise.all(
    keys.map(async (redisKey) => {
      const key = redisKey.replace(/^settings:/, "")
      const request = await getSettings(key).catch(() => null)
      return request?.connectionId && request?.timestamp ? { key, request: request as EngineRefreshRequest } : null
    }),
  )
  return requests.filter((item): item is { key: string; request: EngineRefreshRequest } => !!item)
}

export async function clearEngineRefreshRequest(connectionId: string): Promise<void> {
  await getRedisClient().del(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`).catch(() => 0)
}
