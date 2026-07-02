export const CONNECTION_STATE_CHANGED_EVENT = "connection-state:changed"
export const TRADE_ENGINE_STATUS_INVALIDATE_EVENT = "trade-engine-status:invalidate"
export const PROGRESSION_STATE_INVALIDATE_EVENT = "progression-state:invalidate"

export type ConnectionMutationEngineDetail = {
  action?: string | null
  status?: string | null
  [key: string]: unknown
}

export type ConnectionMutationEventDetail = {
  connectionId?: string
  connection?: {
    id?: string
    name?: string
    exchange?: string
    [key: string]: unknown
  }
  engine?: ConnectionMutationEngineDetail
  progressionUrl?: string
  source?: string
  [key: string]: unknown
}

export function dispatchConnectionMutationEvents(detail: ConnectionMutationEventDetail) {
  if (typeof window === "undefined") return

  const connectionId = detail.connection?.id ?? detail.connectionId
  const eventDetail = {
    ...detail,
    connectionId,
    connection: detail.connection ?? (connectionId ? { id: connectionId } : undefined),
  }

  window.dispatchEvent(new CustomEvent(CONNECTION_STATE_CHANGED_EVENT, { detail: eventDetail }))
  window.dispatchEvent(new CustomEvent(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, { detail: eventDetail }))
  window.dispatchEvent(new CustomEvent(PROGRESSION_STATE_INVALIDATE_EVENT, { detail: eventDetail }))
}

export function buildConnectionMutationEventDetail(
  response: any,
  fallback: ConnectionMutationEventDetail = {},
): ConnectionMutationEventDetail {
  const connection = response?.connection ?? fallback.connection
  const connectionId = connection?.id ?? response?.connectionId ?? fallback.connectionId
  const fallbackEngine = fallback.engine as ConnectionMutationEngineDetail | undefined
  const engine = response?.engine ?? {
    action: response?.action ?? fallbackEngine?.action,
    status: response?.engineStatus ?? response?.status ?? fallbackEngine?.status,
    ...(fallbackEngine ?? {}),
  }
  return {
    ...fallback,
    connectionId,
    connection: connection ?? (connectionId ? { id: connectionId } : undefined),
    engine,
    progressionUrl: response?.progressionUrl ?? response?.progression_url ?? fallback.progressionUrl,
    response,
  }
}
