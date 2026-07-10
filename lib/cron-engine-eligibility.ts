import { isConnectionReadyForEngine } from "@/lib/connection-state-helpers"

export async function getCronEngineEligibleConnections(
  getAssignedAndEnabledConnections: () => Promise<any[]>,
  getQueuedEngineRefreshRequests: () => Promise<Array<{ request: any }>>,
  getConnection: (connectionId: string) => Promise<any>,
): Promise<any[]> {
  const activeConnections = await getAssignedAndEnabledConnections()
  const byId = new Map<string, any>()
  for (const connection of activeConnections) {
    if (connection?.id && isConnectionReadyForEngine(connection)) {
      byId.set(connection.id, connection)
    }
  }

  const queuedRequests = await getQueuedEngineRefreshRequests().catch(() => [] as Array<{ request: any }>)
  for (const { request } of queuedRequests) {
    if (request?.action !== "start" || !request.connectionId) continue

    const requestTime = new Date(request.timestamp).getTime()
    if (!Number.isFinite(requestTime) || Date.now() - requestTime >= 120_000) continue

    const connection = await getConnection(request.connectionId).catch(() => null)
    if (!connection || !isConnectionReadyForEngine(connection)) continue

    const currentVersion = String(connection.state_switch_version ?? 0)
    const requestedVersion = String(request.state_switch_version ?? "")
    if (requestedVersion && currentVersion !== requestedVersion) continue

    byId.set(connection.id, connection)
  }

  return Array.from(byId.values())
}
