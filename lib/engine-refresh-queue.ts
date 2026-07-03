import { getRedisClient, getSettings, setSettings } from "./redis-db"

export const ENGINE_REFRESH_REQUEST_PREFIX = "engine_coordinator:refresh_requested:"
const ENGINE_REFRESH_REQUEST_INDEX = "engine_coordinator:refresh_requested:index"

export type EngineRefreshAction = "start" | "stop" | "refresh" | "restart"

export interface EngineRefreshRequest {
  connectionId: string
  action: EngineRefreshAction | string
  state_switch_version: string | number
  reason: string
  timestamp: string
  retryCount?: number
  lastError?: string
  lastErrorAt?: string
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
  // This targeted drain keeps the timer as a safety net while explicit actions
  // (enable/disable/progression/state changes) converge immediately.
  if (process.env.NEXT_RUNTIME === "edge") return

  try {
    const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
    const coordinator = getGlobalTradeEngineCoordinator()
    await coordinator.drainQueuedRefreshRequestsNow?.(request.connectionId)
  } catch (error) {
    console.warn(
      `[v0] [EngineRefreshQueue] Immediate targeted refresh failed (${request.reason || request.action}):`,
      error instanceof Error ? error.message : String(error),
    )
  }
}

export async function queueEngineRefreshRequest(request: EngineRefreshRequest): Promise<void> {
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, request)
  await (getRedisClient().sadd?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, request.connectionId) ?? Promise.resolve(0)).catch(() => 0)
  // Do not block API/settings/progression writes on local coordinator work.
  // In long-lived production workers this runs on the next turn; in serverless
  // the durable queued request remains for the coordinator watchdog/cron.
  void triggerImmediateEngineRefresh(request)
}

export async function getQueuedEngineRefreshRequests(): Promise<Array<{ key: string; request: EngineRefreshRequest }>> {
  const client = getRedisClient()
  let connectionIds = await (client.smembers?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`) ?? Promise.resolve([] as string[])).catch(() => [] as string[])
  if (!connectionIds || connectionIds.length === 0) {
    // Backward-compatible fallback for queues written before the index existed.
    const keys = await client.keys(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}*`).catch(() => [] as string[])
    connectionIds = keys
      .filter((redisKey: string) => !redisKey.endsWith(ENGINE_REFRESH_REQUEST_INDEX))
      .map((redisKey: string) => redisKey.replace(/^settings:/, "").slice(ENGINE_REFRESH_REQUEST_PREFIX.length))
      .filter(Boolean)
  }

  const requests = await Promise.all(
    Array.from(new Set(connectionIds)).map(async (connectionId) => {
      const key = `${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`
      const request = await getSettings(key).catch(() => null)
      return request?.connectionId && request?.timestamp ? { key, request: request as EngineRefreshRequest } : null
    }),
  )
  return requests.filter((item): item is { key: string; request: EngineRefreshRequest } => !!item)
}

export async function clearEngineRefreshRequest(connectionId: string): Promise<void> {
  const client = getRedisClient()
  await Promise.all([
    client.del(`settings:${ENGINE_REFRESH_REQUEST_PREFIX}${connectionId}`).catch(() => 0),
    (client.srem?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, connectionId) ?? Promise.resolve(0)).catch(() => 0),
  ])
}

export async function recordEngineRefreshRequestFailure(
  request: EngineRefreshRequest,
  error: unknown,
): Promise<void> {
  const retryCount = Number(request.retryCount ?? 0)
  const lastError = error instanceof Error ? error.message : String(error)
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, {
    ...request,
    retryCount: Number.isFinite(retryCount) ? retryCount + 1 : 1,
    lastError,
    lastErrorAt: new Date().toISOString(),
  })
  await (getRedisClient().sadd?.(`settings:${ENGINE_REFRESH_REQUEST_INDEX}`, request.connectionId) ?? Promise.resolve(0)).catch(() => 0)
}
