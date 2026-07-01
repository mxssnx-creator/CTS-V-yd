const WORKER_HEARTBEAT_FRESH_MS = 90_000

export type TradeEngineWorkerHeartbeat = {
  activeWorkerId: string | null
  lastHeartbeatAt: number | null
  fresh: boolean
  ageMs: number | null
}

export const TRADE_ENGINE_WORKER_HEARTBEAT_FRESH_MS = WORKER_HEARTBEAT_FRESH_MS

export function readTradeEngineWorkerHeartbeat(
  globalState: Record<string, string> | null | undefined,
  now = Date.now(),
): TradeEngineWorkerHeartbeat {
  const lastHeartbeatAt = Number(globalState?.last_heartbeat_at || 0)
  const validHeartbeat = Number.isFinite(lastHeartbeatAt) && lastHeartbeatAt > 0
  const ageMs = validHeartbeat ? Math.max(0, now - lastHeartbeatAt) : null

  return {
    activeWorkerId: globalState?.active_worker_id || null,
    lastHeartbeatAt: validHeartbeat ? lastHeartbeatAt : null,
    fresh: validHeartbeat && ageMs !== null && ageMs < WORKER_HEARTBEAT_FRESH_MS,
    ageMs,
  }
}

export function buildMissingTradeEngineWorkerDiagnostic(
  globalState: Record<string, string> | null | undefined,
  now = Date.now(),
) {
  const operatorIntent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || "stopped"
  const heartbeat = readTradeEngineWorkerHeartbeat(globalState, now)
  const missingFreshWorkerHeartbeat = operatorIntent === "running" && !heartbeat.fresh

  return {
    missingFreshWorkerHeartbeat,
    operatorIntent,
    heartbeat,
    error: missingFreshWorkerHeartbeat
      ? "trade_engine:global.status is running, but no fresh trade-engine worker heartbeat exists. Run exactly one dedicated Node worker with ENABLE_TRADE_ENGINE_AUTOSTART=1; add ENABLE_IN_PROCESS_CONTINUITY=1 only if in-process timers are expected."
      : null,
    requiredTopology:
      "Dedicated worker topology: exactly one Node process owns trade engine loops with ENABLE_TRADE_ENGINE_AUTOSTART=1. UI/API workers must not run engines in-process unless they are that dedicated worker.",
  }
}

export async function writeTradeEngineWorkerHeartbeat(
  client: { hset: (key: string, value: Record<string, string>) => Promise<unknown> },
  workerId: string,
  now = Date.now(),
): Promise<void> {
  await client.hset("trade_engine:global", {
    actual_status: "running",
    active_worker_id: workerId,
    last_heartbeat_at: String(now),
    last_heartbeat_iso: new Date(now).toISOString(),
    updated_at: new Date(now).toISOString(),
  })
}
