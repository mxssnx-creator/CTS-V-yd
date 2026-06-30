/**
 * Trade Engine Auto-Start Service
 * Automatically starts trade engines for enabled connections via their toggles
 * 
 * Keeps engine lifecycle synchronized with current main-enabled connections.
 * Engines are still user-controlled via dashboard toggles; monitor only ensures
 * enabled connections are actually running when global coordinator is running.
 */

import { getGlobalTradeEngineCoordinator } from "./trade-engine"
import { getAllConnections, getRedisClient, initRedis } from "./redis-db"
import { loadSettingsAsync } from "./settings-storage"
import { isConnectionEligibleForEngine } from "./connection-state-utils"

let autoStartInitialized = false
let autoStartTimer: NodeJS.Timeout | null = null
let autoStartInitPromise: Promise<void> | null = null

export function isAutoStartInitialized(): boolean {
  return autoStartInitialized
}

/**
 * Initialize trade engine monitor for auto-recovery/synchronization.
 */
export async function initializeTradeEngineAutoStart(): Promise<void> {
  if (autoStartInitialized) {
    console.log("[v0] [Auto-Start] Already initialized, skipping")
    if (!autoStartTimer) {
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
    console.log("[v0] [Auto-Start] Starting trade engine auto-initialization (sync mode)...")

    // Make the COMPLETE SITE one unique instance (independent of connections)
    const { ensureUniqueSiteInstance } = await import("./redis-db")
    await ensureUniqueSiteInstance().catch(() => {})

    // Check if Global Trade Engine Coordinator is running
    await initRedis()
    const client = getRedisClient()
    const globalState = await client.hgetall("trade_engine:global")
    const globalRunning = globalState?.status === "running"
    
    if (!globalRunning) {
      console.log("[v0] [Auto-Start] Global Trade Engine is not running - monitor initialized, waiting for global start.")
      autoStartInitialized = true
      startConnectionMonitoring()
      return
    }
    
    console.log("[v0] [Auto-Start] Monitoring initialized - enabled connections will be synchronized")
    autoStartInitialized = true
    startConnectionMonitoring()
  } catch (error) {
    console.error("[v0] [Auto-Start] Initialization failed:", error)
    // Do not mark auto-start as initialized after a failed boot. In production
    // cron/serverless mode there may be no durable in-process timer after this
    // request returns; caching a failed init as "ready" makes every later
    // continuity tick skip the real Redis/migration/engine initialization work.
    // Keep the state retryable and surface the failure to the caller.
    autoStartInitialized = false
    throw error
  }
}

/**
 * Execute one auto-start/healing sweep immediately.
 *
 * This is exported for production cron/serverless paths where delayed
 * setTimeout/setInterval callbacks are not durable after the HTTP response
 * returns. Long-lived dev/Node processes still call this from the monitor
 * interval below, but cron callers must await this function directly so both
 * modes perform the same real work before reporting success.
 */
export async function runTradeEngineHealingSweep(isStartup: boolean): Promise<{ startedCount: number; eligibleCount: number; skipped?: string }> {
  try {
    await initRedis()
    const monClient = getRedisClient()
    const monGlobalState = (await monClient.hgetall("trade_engine:global")) as Record<string, string> | null

    const currentStatus = monGlobalState?.status || ""
    const isPaused = currentStatus === "paused"

    if (isPaused) {
      if (isStartup) {
        console.log(
          "[v0] [AutoStart] Startup sweep skipped: global coordinator is paused. " +
            "Engine will resume when coordinator is resumed.",
        )
      }
      return { startedCount: 0, eligibleCount: 0, skipped: "paused" }
    }

    if (currentStatus !== "running") {
      if (isStartup) {
        console.log(
          `[v0] [AutoStart] Startup sweep skipped: global engine not running (status="${currentStatus || "empty"}"). ` +
            "Engine will start only when operator clicks Start.",
        )
      }
      return { startedCount: 0, eligibleCount: 0, skipped: currentStatus || "not_running" }
    }

    const connections = await getAllConnections()
    if (!Array.isArray(connections)) {
      console.warn("[v0] [AutoStart] Connections not array, skipping sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "connections_not_array" }
    }

    const connectionsThatShouldBeRunning = connections.filter((c) => isConnectionEligibleForEngine(c))

    // Settings load is best-effort; engines consult Redis on each tick.
    try { await loadSettingsAsync() } catch { /* non-critical */ }

    const coordinator = getGlobalTradeEngineCoordinator()
    const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)
    if (startedCount > 0 || isStartup) {
      console.log(
        `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
          `(${connectionsThatShouldBeRunning.length} connections eligible)`,
      )
    }
    return { startedCount, eligibleCount: connectionsThatShouldBeRunning.length }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Redis credentials")) {
      console.warn("[v0] [AutoStart] Redis not configured - skipping healing sweep")
      return { startedCount: 0, eligibleCount: 0, skipped: "redis_not_configured" }
    }

    console.warn(
      "[v0] [AutoStart] Error during healing sweep:",
      error instanceof Error ? error.message : String(error),
    )
    throw error
  }
}

/**
 * Persistent self-healing monitor.
 *
 * Replaces the former one-shot `setTimeout`. Runs an initial sweep
 * 2 seconds after init (to let migrations settle) then repeats every
 * 30 seconds. On each tick it starts any enabled connection whose engine
 * is not currently running.
 */
function startConnectionMonitoring(): void {
  if (autoStartTimer) {
    return
  }

  const startupDelay = setTimeout(async () => {
    await runTradeEngineHealingSweep(true).catch(() => {})

    const intervalHandle = setInterval(async () => {
      await runTradeEngineHealingSweep(false).catch(() => {})
    }, 30_000)

    intervalHandle.unref?.()
    autoStartTimer = intervalHandle
  }, 2000)

  startupDelay.unref?.()
  autoStartTimer = startupDelay
}

/**
 * Cancel the self-healing monitor.
 *
 * Clears both the startup delay (if still pending) and the repeating
 * interval (if already armed). Safe to call multiple times.
 */
export function stopConnectionMonitoring(): void {
  if (autoStartTimer) {
    clearTimeout(autoStartTimer)   // works for both setTimeout and setInterval
    clearInterval(autoStartTimer)
    autoStartTimer = null
  }
}
