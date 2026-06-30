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
  // Timers are useful for long-lived dedicated workers. Hosted/serverless web
  // processes should rely on the cron route because intervals are not durable
  // after the request completes and can add avoidable UI latency.
  if (process.env.VERCEL === "1" || process.env.NEXT_RUNTIME === "edge") return false
  return process.env.ENABLE_TRADE_ENGINE_AUTOSTART === "1" || process.env.ENABLE_IN_PROCESS_CONTINUITY === "1"
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
    console.log("[v0] [Auto-Start] Already initialized, skipping")
    if (!autoStartTimer && shouldArmInProcessMonitor()) {
      console.log("[v0] [Auto-Start] Monitor missing after init; restarting monitor")
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

    const { initRedis, ensureUniqueSiteInstance } = await loadRedisDb()
    await initRedis()
    await ensureUniqueSiteInstance().catch(() => {})

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
    const { initRedis, getRedisClient, getAllConnections } = await loadRedisDb()
    const { loadSettingsAsync } = await import("./settings-storage")
    const { isConnectionEligibleForEngine } = await import("./connection-state-utils")

    await initRedis()
    const client = getRedisClient()
    const globalState = (await client.hgetall("trade_engine:global")) as Record<string, string> | null
    const operatorIntent = getGlobalOperatorIntent(globalState)

    if (operatorIntent === "paused") {
      if (isStartup) {
        console.log("[v0] [AutoStart] Startup sweep skipped: global coordinator is paused")
      }
      return { startedCount: 0, eligibleCount: 0, skipped: "paused" }
    }

    if (operatorIntent !== "running") {
      if (isStartup) {
        console.log(
          `[v0] [AutoStart] Startup sweep skipped: global engine not running (intent="${operatorIntent || "empty"}"). ` +
            "Engine will start only when operator clicks Start.",
        )
      }
      return { startedCount: 0, eligibleCount: 0, skipped: operatorIntent || "not_running" }
    }

    const connections = await getAllConnections()
    if (!Array.isArray(connections)) {
      console.warn("[v0] [AutoStart] Connections not array, skipping sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "connections_not_array" }
    }

    const eligibleConnections = connections.filter((connection) => isConnectionEligibleForEngine(connection))

    // Best-effort warm load. Engines still read Redis settings while ticking.
    await loadSettingsAsync().catch(() => {})

    const coordinator = await loadTradeEngineCoordinator()
    const startedCount = await coordinator.startMissingEngines(eligibleConnections)
    if (startedCount > 0 || isStartup) {
      console.log(
        `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
          `(${eligibleConnections.length} connections eligible)`,
      )
    }

    return { startedCount, eligibleCount: eligibleConnections.length }
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
