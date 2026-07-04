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
  // PROD FIX: Default operator_intent to "running" instead of "stopped"
  // Previously, uninitialized operator_intent defaulted to "stopped", which prevented
  // engine autostart in production mode. Now uninitialized intent enables autostart.
  // Explicit UI/API calls will set intent to "stopped" or "paused" when needed.
  const operatorIntent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || "running"
  const heartbeat = readTradeEngineWorkerHeartbeat(globalState, now)
  const missingFreshWorkerHeartbeat = operatorIntent === "running" && !heartbeat.fresh

  return {
    missingFreshWorkerHeartbeat,
    operatorIntent,
    heartbeat,
    // Missing heartbeat is diagnostic information, not a user-facing error.
    // Explicit UI/API actions can start an engine foreground with allowInProcessStart,
    // while cron/serverless continuity drains queued work when no local runtime is alive.
    error: null,
    warning: missingFreshWorkerHeartbeat
      ? "No fresh trade-engine worker heartbeat is attached yet. The next explicit UI action or continuity sweep will reconcile engine runtime."
      : null,
    requiredTopology:
      "A dedicated engine worker is optional for always-on processing; explicit UI actions and continuity sweeps can reconcile engine runtime when no worker heartbeat exists.",
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
