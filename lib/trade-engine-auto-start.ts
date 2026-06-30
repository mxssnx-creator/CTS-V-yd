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
    const operatorIntent = globalState?.operator_intent || globalState?.desired_status || globalState?.status || ""
    const globalRunning = operatorIntent === "running"
    
    if (!globalRunning) {
      console.log("[v0] [Auto-Start] Global Trade Engine is not running - monitor initialized, waiting for global start.")
      autoStartInitialized = true
      await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })
      return
    }
    
    console.log("[v0] [Auto-Start] Monitoring initialized - enabled connections will be synchronized")
    autoStartInitialized = true
    await runTradeEngineHealingSweep({ isStartup: true, armTimer: true })
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

/**
 * Execute one trade-engine self-healing sweep immediately.
 *
 * Cron/serverless routes must call this directly and await it; in-process
 * timers are not durable after a serverless response returns.
 */
export async function runTradeEngineHealingSweep({
  isStartup,
  armTimer = false,
}: {
  isStartup: boolean
  armTimer?: boolean
}): Promise<void> {
  try {
    await initRedis()
    const monClient = getRedisClient()
    const monGlobalState = (await monClient.hgetall("trade_engine:global")) as Record<
      string,
      string
    > | null

    // CRITICAL FIX: re-assert "running" status when:
    //   - a base connection is configured AND eligible (autoActive), AND
    //   - the operator did NOT explicitly stop the engine
    //     (operator_stopped="1" is the sticky veto flag), AND
    //   - the global coordinator is NOT paused (paused status must be
    //     honored — skip healing sweep when paused).
    //
    // Without this self-heal the engine stays "stopped" after a redeploy
    // / snapshot restore — even though no operator ever clicked Stop —
    // matching the reported "low counts, no progressions" symptom.
    const operatorStopped =
      monGlobalState?.operator_stopped === "1" || monGlobalState?.operator_stopped === "true"
    const currentStatus = monGlobalState?.status || ""
    const isPaused = currentStatus === "paused"
    void operatorStopped

    // ── Skip healing sweep if paused ─────────────────────────────────
    // When the global coordinator is paused, the auto-start monitor
    // must not restart engines or attempt to resurrect the coordinator.
    // The pause state is an explicit user action that should be honored.
    if (isPaused) {
      if (isStartup) {
        console.log(
          "[v0] [AutoStart] Startup sweep skipped: global coordinator is paused. " +
            "Engine will resume when coordinator is resumed.",
        )
      }
      return
    }

    const BASE_CONNECTION_IDS = ["bingx-x01"]

    async function runHealingSweep(isStartup: boolean): Promise<void> {
      try {
        await initRedis()
        const monClient = getRedisClient()
        const monGlobalState = (await monClient.hgetall("trade_engine:global")) as Record<
          string,
          string
        > | null

        // CRITICAL FIX: re-assert "running" status when:
        //   - a base connection is configured AND eligible (autoActive), AND
        //   - the operator did NOT explicitly stop the engine
        //     (operator_stopped="1" is the sticky veto flag), AND
        //   - the global coordinator is NOT paused (paused status must be
        //     honored — skip healing sweep when paused).
        //
        // Without this self-heal the engine stays "stopped" after a redeploy
        // / snapshot restore — even though no operator ever clicked Stop —
        // matching the reported "low counts, no progressions" symptom.
        const operatorStopped =
          monGlobalState?.operator_stopped === "1" || monGlobalState?.operator_stopped === "true"
        const operatorIntent = monGlobalState?.operator_intent || monGlobalState?.desired_status || monGlobalState?.status || ""
        const currentStatus = operatorIntent
        const isPaused = currentStatus === "paused"

        // ── Skip healing sweep if paused ─────────────────────────────────
        // When the global coordinator is paused, the auto-start monitor
        // must not restart engines or attempt to resurrect the coordinator.
        // The pause state is an explicit user action that should be honored.
        if (isPaused) {
          if (isStartup) {
            console.log(
              "[v0] [AutoStart] Startup sweep skipped: global coordinator is paused. " +
                "Engine will resume when coordinator is resumed.",
            )
          }
          return
        }

        if (currentStatus !== "running") {
          // AUTO-START DISABLED: never auto-resurrect the global engine.
          // Only the operator's explicit Start action (via dashboard / QuickStart)
          // may set trade_engine:global operator intent to running. The monitor just skips
          // its sweep and waits for the next tick.
          if (isStartup) {
            console.log(
              `[v0] [AutoStart] Startup sweep skipped: global engine not running (status="${currentStatus || "empty"}"). ` +
              "Engine will start only when operator clicks Start.",
            )
          }
          return
        }

        // ── Idempotent base-connection activation (DISABLED) ─────────────���─────
        // AUTO-START DISABLED: Connections no longer auto-enable on boot.
        // Users must explicitly enable connections via the dashboard toggle.
        // This allows starting without immediately running all engines.
        //
        // REMOVED: code that was setting is_enabled_dashboard="1" automatically.
        // The healing sweep will now skip this activation block entirely.

        const connections = await getAllConnections()
        if (!Array.isArray(connections)) {
          console.warn("[v0] [AutoStart] Connections not array, skipping sweep")
          return
        }

        // Use isConnectionEligibleForEngine which checks is_active_inserted but
        // NOT is_enabled_dashboard.  The dashboard toggle gates live-trade/preset
        // operations; it must not prevent the healing sweep from restarting an
        // engine that the operator explicitly started — especially during the boot
        // window before migration 037 seeds is_enabled_dashboard=1.
        const connectionsThatShouldBeRunning = connections.filter((c) =>
          isConnectionEligibleForEngine(c)
    if (currentStatus !== "running") {
      // AUTO-START DISABLED: never auto-resurrect the global engine.
      // Only the operator's explicit Start action (via dashboard / QuickStart)
      // may set trade_engine:global status=running. The monitor just skips
      // its sweep and waits for the next tick.
      if (isStartup) {
        console.log(
          `[v0] [AutoStart] Startup sweep skipped: global engine not running (status="${currentStatus || "empty"}"). ` +
            "Engine will start only when operator clicks Start.",
        )
      }
      return
    }

    // ── Idempotent base-connection activation (DISABLED) ───────────────
    // AUTO-START DISABLED: Connections no longer auto-enable on boot.
    // Users must explicitly enable connections via the dashboard toggle.
    // This allows starting without immediately running all engines.
    //
    // REMOVED: code that was setting is_enabled_dashboard="1" automatically.
    // The healing sweep will now skip this activation block entirely.

    const connections = await getAllConnections()
    if (!Array.isArray(connections)) {
      console.warn("[v0] [AutoStart] Connections not array, skipping sweep")
      return
    }

    // Use isConnectionEligibleForEngine which checks is_active_inserted but
    // NOT is_enabled_dashboard.  The dashboard toggle gates live-trade/preset
    // operations; it must not prevent the healing sweep from restarting an
    // engine that the operator explicitly started — especially during the boot
    // window before migration 037 seeds is_enabled_dashboard=1.
    const connectionsThatShouldBeRunning = connections.filter((c) =>
      isConnectionEligibleForEngine(c)
    )

    // Settings load is best-effort; engines consult Redis on each tick.
    try { await loadSettingsAsync() } catch { /* non-critical */ }

    try {
      const coordinator = getGlobalTradeEngineCoordinator()
      const startedCount = await coordinator.startMissingEngines(connectionsThatShouldBeRunning)
      if (startedCount > 0 || isStartup) {
        console.log(
          `[v0] [AutoStart] Healing sweep: ${startedCount} engines started ` +
            `(${connectionsThatShouldBeRunning.length} connections eligible)`,
        )
      }
    } catch (startError) {
      console.warn("[v0] [AutoStart] Failed to start missing engines:", startError)
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("Redis credentials")) {
      console.warn("[v0] [AutoStart] Redis not configured - skipping healing sweep")
    } else {
      console.warn(
        "[v0] [AutoStart] Error during healing sweep:",
        error instanceof Error ? error.message : String(error),
      )
    }
  } finally {
    if (armTimer) {
      armConnectionMonitoringInterval()
    }
  }
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
/**
 * Persistent self-healing monitor.
 *
 * The startup sweep is run by initializeTradeEngineAutoStart() before it
 * reports success. This function only arms the recurring background interval
 * used by long-lived Node processes; cron/serverless callers should use
 * runTradeEngineHealingSweep({ isStartup: true }) directly instead.
 */
function startConnectionMonitoring(): void {
  armConnectionMonitoringInterval()
}

function armConnectionMonitoringInterval(): void {
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
  const intervalHandle = setInterval(async () => {
    await runTradeEngineHealingSweep({ isStartup: false })
  }, 30_000) // 30 seconds

  intervalHandle.unref?.()
  autoStartTimer = intervalHandle
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
