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

export async function queueEngineRefreshRequest(request: EngineRefreshRequest): Promise<void> {
  await setSettings(`${ENGINE_REFRESH_REQUEST_PREFIX}${request.connectionId}`, request)
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
