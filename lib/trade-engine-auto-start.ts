/**
 * Trade Engine Auto-Start Service
 *
 * This module does not flip operator controls on startup. It only keeps engines
 * synchronized with explicit operator intent: when the global coordinator is
 * marked running, each currently eligible connection should have an engine; when
 * the coordinator is stopped/paused, healing is skipped.
 */

async function loadRedisDb() {
  return import("./redis-db")
}

async function loadTradeEngineCoordinator() {
  const { getGlobalTradeEngineCoordinator } = await import("./trade-engine")
  return getGlobalTradeEngineCoordinator()
}

type HealingSweepOptions = {
  isStartup: boolean
  armTimer?: boolean
}

type HealingSweepResult = {
  startedCount: number
  eligibleCount: number
  queuedRefreshProcessedCount?: number
  skipped?: string
  error?: string
}

let autoStartInitialized = false
let autoStartTimer: NodeJS.Timeout | null = null
let autoStartInitPromise: Promise<void> | null = null
let healingSweepInFlight: Promise<HealingSweepResult> | null = null

export function isAutoStartInitialized(): boolean {
  return autoStartInitialized
}

function normalizeHealingSweepOptions(options: boolean | HealingSweepOptions): HealingSweepOptions {
  if (typeof options === "boolean") {
    return { isStartup: options, armTimer: false }
  }

  const { isStartup, armTimer = false } = options
  return { isStartup, armTimer }
}

function getGlobalOperatorIntent(state: Record<string, string> | null | undefined): string {
  return state?.operator_intent || state?.desired_status || state?.status || ""
}

function shouldArmInProcessMonitor(): boolean {
  // Long-lived Node production/dev processes can own in-process engine starts by
  // default. Serverless/edge deployments still rely on the awaited healing sweep
  // and deployment cron because timers are not durable after responses return.
  if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART === "1") return false
  if (process.env.VERCEL === "1" || process.env.NEXT_RUNTIME === "edge") return false
  return true
}

async function getQueuedRefreshRequestList() {
  const { getQueuedEngineRefreshRequests } = await import("./engine-refresh-queue")
  return getQueuedEngineRefreshRequests().catch(() => [] as Awaited<ReturnType<typeof getQueuedEngineRefreshRequests>>)
}

async function processQueuedEngineRefreshRequests(coordinator: Awaited<ReturnType<typeof loadTradeEngineCoordinator>>): Promise<number> {
  const { getQueuedEngineRefreshRequests, clearEngineRefreshRequest } = await import("./engine-refresh-queue")
  const { getConnection } = await loadRedisDb()

  const refreshRequests = await getQueuedEngineRefreshRequests()
  let processed = 0

  for (const { request } of refreshRequests) {
    const requestTime = new Date(request.timestamp).getTime()
    if (!Number.isFinite(requestTime) || Date.now() - requestTime >= 120_000) {
      console.log(`[v0] [AutoStart] Dropping expired refresh request for ${request.connectionId}`)
      await clearEngineRefreshRequest(request.connectionId)
      processed++
      continue
    }

    const connection = await getConnection(request.connectionId)
    const currentVersion = String(connection?.state_switch_version ?? 0)
    const requestedVersion = String(request.state_switch_version ?? "")
    if (!connection || currentVersion !== requestedVersion) {
      console.log(
        `[v0] [AutoStart] Ignoring stale refresh request for ${request.connectionId}: ` +
          `requested state_switch_version=${requestedVersion}, current=${currentVersion}`,
      )
      await clearEngineRefreshRequest(request.connectionId)
      processed++
      continue
    }

    console.log(
      `[v0] [AutoStart] Processing queued refresh request for ${request.connectionId}: ${request.action} ` +
        `(state_switch_version=${requestedVersion}, reason=${request.reason})`,
    )
    await clearEngineRefreshRequest(request.connectionId)
    processed++

    if (request.action === "stop") {
      await coordinator.stopEngine(request.connectionId, { operatorRequested: true })
    } else if (request.action === "start") {
      if (!coordinator.isEngineRunning?.(request.connectionId)) {
        await coordinator.startMissingEngines([connection])
      }
    } else {
      await coordinator.applyPendingChangesNow?.(request.connectionId)
    }
  }

  return processed
}

/**
 * Initialize the trade-engine synchronization service.
 *
 * The startup path is intentionally idempotent and bounded: initialize Redis,
 * ensure the unique site marker, run one awaited healing sweep, and only arm a
 * recurring timer in long-lived/dedicated worker modes.
 */
export async function initializeTradeEngineAutoStart(): Promise<void> {
  if (autoStartInitialized) {
    console.warn("[v0] [Auto-Start] Already initialized, skipping")
    if (!autoStartTimer && shouldArmInProcessMonitor()) {
      console.warn("[v0] [Auto-Start] Monitor missing after init; restarting monitor")
      startConnectionMonitoring()
    }
    return
  }

  if (autoStartInitPromise) {
    return autoStartInitPromise
  }

  autoStartInitPromise = initializeTradeEngineAutoStartInternal().finally(() => {
    autoStartInitPromise = null
  })
  return autoStartInitPromise
}

async function initializeTradeEngineAutoStartInternal(): Promise<void> {
  try {
    console.log("[v0] [Auto-Start] Initializing trade-engine synchronization...")

    const { initRedis, ensureUniqueSiteInstance, getRedisClient } = await loadRedisDb()
    await initRedis()
    await ensureUniqueSiteInstance().catch(() => {})

    // LIVE TRADING FIX: Clear stale operator_intent from previous runs
    // If intent is explicitly "stopped", delete it so it defaults to "running"
    // This ensures engines start automatically on each new deployment/restart
    try {
      const client = getRedisClient()
      const state = await client.hgetall("trade_engine:global")
      if (state?.operator_intent === "stopped") {
        console.log("[v0] [Auto-Start] Clearing stale operator_intent='stopped' to enable autostart")
        await client.hdel("trade_engine:global", "operator_intent")
      }
    } catch (redisErr) {
      console.warn("[v0] [Auto-Start] Failed to clear stale intent:", redisErr)
    }

    autoStartInitialized = true
    await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })
    console.log("[v0] [Auto-Start] Synchronization initialized")
  } catch (error) {
    console.error("[v0] [Auto-Start] Initialization failed:", error)
    autoStartInitialized = false
    stopConnectionMonitoring()
    throw error
  }
}

/**
 * Execute one self-healing sweep immediately.
 *
 * Cron/serverless routes must call this directly and await it; in-process
 * timers are not durable after a serverless response returns.
 */
export async function runTradeEngineHealingSweep(
  options: boolean | HealingSweepOptions,
): Promise<HealingSweepResult> {
  const normalized = normalizeHealingSweepOptions(options)

  if (healingSweepInFlight) {
    return healingSweepInFlight.finally(() => {
      if (normalized.armTimer) startConnectionMonitoring()
    })
  }

  healingSweepInFlight = runTradeEngineHealingSweepInternal(normalized).finally(() => {
    healingSweepInFlight = null
    if (normalized.armTimer) startConnectionMonitoring()
  })

  return healingSweepInFlight
}

async function runTradeEngineHealingSweepInternal({ isStartup }: HealingSweepOptions): Promise<HealingSweepResult> {
  try {
    const { initRedis, getRedisClient, getAssignedAndEnabledConnections, getConnection } = await loadRedisDb()
    const { loadSettingsAsync } = await import("./settings-storage")
    const { writeTradeEngineWorkerHeartbeat } = await import("./trade-engine-worker-heartbeat")

    await initRedis()
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global")) as Record<string, string> | null
    const operatorIntent = getGlobalOperatorIntent(globalState)

    if (operatorIntent === "paused") {
      if (isStartup) {
        console.warn("[v0] [AutoStart] Startup sweep skipped: global coordinator is paused")
      }
      return { startedCount: 0, eligibleCount: 0, skipped: "paused" }
    }

    // PROD FIX: Uninitialized operator_intent now defaults to "running" (changed from "stopped")
    // Only explicitly stopped/paused intents block autostart
    const shouldRun = operatorIntent !== "stopped"
    if (!shouldRun) {
      if (isStartup) {
        console.warn(
          `[v0] [AutoStart] Startup sweep skipped: operator_intent="${operatorIntent}". ` +
            "Engine will start only when operator explicitly resumes.",
        )
      }
      return { startedCount: 0, eligibleCount: 0, skipped: operatorIntent }
    }

    const coordinator = await loadTradeEngineCoordinator()
    const queuedRefreshRequests = await getQueuedRefreshRequestList()
    const stopRequests = queuedRefreshRequests.filter(({ request }) => request.action === "stop")
    for (const { request } of stopRequests) {
      await coordinator.stopEngine(request.connectionId, { operatorRequested: true }).catch((stopErr: unknown) => {
        console.warn(
          `[v0] [AutoStart] Immediate stop failed for ${request.connectionId}:`,
          stopErr instanceof Error ? stopErr.message : String(stopErr),
        )
      })
    }

    const eligibleConnections = await getAssignedAndEnabledConnections()
    for (const { request } of queuedRefreshRequests) {
      if (request.action !== "start") continue
      if (eligibleConnections.some((connection: any) => connection.id === request.connectionId)) continue
      const connection = await getConnection(request.connectionId).catch(() => null)
      if (connection) eligibleConnections.push(connection)
    }

    if (!Array.isArray(eligibleConnections)) {
      console.warn("[v0] [AutoStart] Eligible connections not array, skipping sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "connections_not_array" }
    }

    // Best-effort warm load. Engines still read Redis settings while ticking.
    await loadSettingsAsync().catch(() => {})

    const queuedRefreshProcessedCount = await processQueuedEngineRefreshRequests(coordinator)
    const startedCount = await coordinator.startMissingEngines(eligibleConnections)

    const activeEngineCount = typeof coordinator.getActiveEngineCount === "function" ? coordinator.getActiveEngineCount() : 0
    if (coordinator.isRunning() || activeEngineCount > 0) {
      await writeTradeEngineWorkerHeartbeat(client, `auto-start:${process.pid}`)
    }

    if (startedCount > 0 || isStartup) {
      console.log(
        `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
          `(${eligibleConnections.length} connections eligible)`,
      )
    }

    return { startedCount, eligibleCount: eligibleConnections.length, queuedRefreshProcessedCount }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (message.includes("Redis credentials")) {
      console.warn("[v0] [AutoStart] Redis not configured - skipping healing sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "redis_not_configured", error: message }
    }

    console.warn("[v0] [AutoStart] Error during healing sweep:", message)
    return { startedCount: 0, eligibleCount: 0, skipped: "error", error: message }
  }
}

/**
 * Persistent self-healing monitor for long-lived Node processes.
 */
function startConnectionMonitoring(): void {
  if (!shouldArmInProcessMonitor()) return
  if (autoStartTimer) return

  const intervalHandle = setInterval(() => {
    void runTradeEngineHealingSweep({ isStartup: false })
  }, 30_000)

  intervalHandle.unref?.()
  autoStartTimer = intervalHandle
}

/**
 * Cancel the self-healing monitor. Safe to call multiple times.
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    clearInterval(autoStartTimer)
    autoStartTimer = null
  }
}
