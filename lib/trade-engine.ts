/**
 * Global Trade Engine Coordinator V4.0
 * @version 4.0.0 - Force engine restart on version change to fix stale closures
 *
 * NOTE: The legacy `indication-processor-patch` side-effect import was
 * removed — it monkey-patched cache initialisation that the underlying
 * class now handles natively (instance fields backed by module-level
 * shared singletons in `indication-processor-fixed` v5.0.1+). The patch
 * file itself is preserved as a no-op stub for backward compatibility
 * with any external imports of its named exports.
 */

const COORDINATOR_VERSION = "4.2.0"

// STABILITY: NEVER stop or clear live engines on version change.
//
// Previously this block tore down the global coordinator singleton every
// time the module was reloaded (HMR, serverless cold-warm, redeploy). That
// caused the symptom the user described: "GlobalTradeCoordinator
// automatically stopping / Trade Engines restarting / no-sense
// reassignments". The coordinator is supposed to be a long-lived overall
// state holder; replacing it on every module reload is exactly the wrong
// behaviour.
//
// We now record the running version for diagnostics only — no destructive
// cleanup. The singleton on `globalThis.__tradeEngineCoordinator` is
// preserved across reloads.
const coordGlobal = globalThis as unknown as {
  __coordinator_version?: string
  __global_coordinator?: unknown
}
if (coordGlobal.__coordinator_version && coordGlobal.__coordinator_version !== COORDINATOR_VERSION) {
  console.log(
    `[v0] Coordinator version ${coordGlobal.__coordinator_version} -> ${COORDINATOR_VERSION} ` +
      `(keeping live coordinator and engines)`,
  )
}
coordGlobal.__coordinator_version = COORDINATOR_VERSION

console.log(`[v0] Global Trade Engine V${COORDINATOR_VERSION} loading with cache patch...`)

import { TradeEngineManager, type EngineConfig } from "./trade-engine/engine-manager"
import { getSettings, setSettings } from "./redis-db"
import {
  // Cross-process ownership primitive. The coordinator acquires the
  // per-connection lock BEFORE constructing or reusing the manager;
  // the manager extends/releases it during its lifecycle. See
  // `lib/trade-engine/progression-lock.ts` for the full schema.
  acquireProgressionLock,
  forceBreakProgressionLock,
  type LockHandle,
} from "./trade-engine/progression-lock"
import { clearEngineRefreshRequest, getQueuedEngineRefreshRequests, recordEngineRefreshRequestFailure } from "./engine-refresh-queue"

// Re-export TradeEngine class and config from subdirectory for convenient imports
export { TradeEngine, type TradeEngineConfig, TRADE_SERVICE_NAME } from "./trade-engine/trade-engine"
export { TradeEngineManager, type EngineConfig } from "./trade-engine/engine-manager"

export interface EngineStatus {
  status: "idle" | "running" | "stopped" | "paused" | "error"
  startedAt?: Date
  stoppedAt?: Date
  errorMessage?: string
}

export interface ConnectionStatus {
  connectionId: string
  status: "active" | "inactive" | "error"
  lastActivity?: Date
  errorCount: number
}

export interface StartEngineOptions {
  markAssigned?: boolean
  /** Force this process to own the runtime for explicit UI/API starts. */
  forceLocalTakeover?: boolean
}

export interface StopEngineOptions {
  operatorRequested?: boolean
}

export interface HealthStatus {
  overall: "healthy" | "degraded" | "unhealthy"
  components: Record<string, ComponentHealth>
  lastCheck: Date
}

export interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
}

/**
 * GlobalTradeEngineCoordinator
 *
 * Manages TradeEngineManagers for all connections system-wide.
 * Acts as the central coordinator for trade processing across multiple exchanges.
 */
export class GlobalTradeEngineCoordinator {
  private engineManagers: Map<string, TradeEngineManager> = new Map()
  private startingEngines = new Set<string>()  // PHASE 1 FIX: Startup lock to prevent duplicate starts
  private stoppingEngines = new Set<string>()  // PHASE 2 FIX: Stop lock to prevent race conditions
  private isGloballyRunning = false
  private isPaused = false
  private healthCheckTimer?: NodeJS.Timeout
  private coordinationMetricsTimer?: NodeJS.Timeout
  private coordinationMetrics: {
    totalSymbolsProcessed: number
    totalCycles: number
    avgCycleDuration: number
    lastMetricsUpdate: Date
  } = {
    totalSymbolsProcessed: 0,
    totalCycles: 0,
    avgCycleDuration: 0,
    lastMetricsUpdate: new Date(),
  }

  /**
   * Whether this Node process is allowed to own long-running trade loops.
   * Production UI/API workers must default to "queue only": starting the
   * realtime coordinator in the request worker can starve health/settings
   * routes after enable/disable or settings saves. Dedicated workers (or
   * explicit diagnostics) opt in with one of these env flags.
   */
  private canOwnEngineRuntime(): boolean {
    // In dev/test environments, always allow owning engine runtime
    // In production, require explicit opt-in via environment variables
    const isDev = process.env.NODE_ENV !== "production"
    const allowExplicit = 
      process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" ||
      process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"
    
    return isDev || allowExplicit
  }

  constructor() {
    console.log("[v0] GlobalTradeEngineCoordinator initialized with advanced coordination")
    // The coordinator is a long-lived overall state holder. Its background
    // monitors must run as long as the singleton exists — not gated behind
    // `startAll()` (which the user may never call when engines are toggled
    // individually from the dashboard). Both methods are idempotent w.r.t.
    // their internal `*Timer` fields, so calling them again later is safe.
    try { this.startGlobalHealthMonitoring() } catch (e) {
      console.warn("[v0] [Coordinator] health monitor init failed:", e)
    }
    try { this.startCoordinationMetricsTracking() } catch (e) {
      console.warn("[v0] [Coordinator] metrics tracker init failed:", e)
    }
  }

  /**
   * Redis `trade_engine:global.status` is the operator-intent source of truth.
   * Connection engines may only be started/restarted while the global
   * coordinator is explicitly enabled.  This prevents settings saves,
   * dashboard refreshes, auto-start sweeps, or watchdog recovery from
   * resurrecting progressions after the operator has stopped/paused the
   * coordinator or after production Redis has not restored the global state yet.
   */
  private async isGlobalCoordinatorEnabled(context: string): Promise<boolean> {
    try {
      const { getRedisClient, initRedis } = await import("@/lib/redis-db")
      await initRedis()
      const client = getRedisClient()
      const globalState = (await client.hgetall("trade_engine:global").catch(() => null)) as Record<string, string> | null
      const operatorStopped =
        globalState?.operator_stopped === "1" || globalState?.operator_stopped === "true"
      const intent = operatorStopped
        ? "stopped"
        : globalState?.operator_intent || globalState?.desired_status || globalState?.status || ""
      const enabled = intent === "running"
      this.isPaused = intent === "paused"
      this.isGloballyRunning = enabled && Array.from(this.engineManagers.values()).some((manager) => manager.isEngineRunning)
      if (!enabled) {
        console.warn(
          `[v0] [Coordinator] ${context} skipped — global coordinator is not enabled ` +
            `(intent="${intent || "empty"}", legacy_status="${globalState?.status || "empty"}")`,
        )
      }
      return enabled
    } catch (err) {
      console.warn(
        `[v0] [Coordinator] ${context} could not verify global coordinator state; refusing to start/restart connection engines:`,
        err instanceof Error ? err.message : String(err),
      )
      return false
    }
  }

  /**
   * Initialize engine for a specific connection
   */
  async initializeEngine(connectionId: string, config: EngineConfig): Promise<TradeEngineManager> {
    console.log(`[v0] Initializing TradeEngine for connection: ${connectionId}`)

    // Check if engine already exists
    if (this.engineManagers.has(connectionId)) {
      console.log(`[v0] Engine already exists for connection: ${connectionId}`)
      return this.engineManagers.get(connectionId)!
    }

    // Create new engine manager
    const manager = new TradeEngineManager(config)
    this.engineManagers.set(connectionId, manager)

    // Initialize database state
    try {
      await this.ensureEngineState(connectionId)
    } catch (error) {
      console.error(`[v0] Failed to initialize engine state for ${connectionId}:`, error)
    }

    console.log(`[v0] TradeEngine initialized for connection: ${connectionId}`)
    return manager
  }

  /**
   * Start engine for a specific connection
   * PHASE 1 FIX: Added startup lock to prevent duplicate engines
   */
  async startEngine(connectionId: string, config: EngineConfig, options: StartEngineOptions = {}): Promise<boolean> {
    const forceLocalTakeover = options.forceLocalTakeover === true || config.allowInProcessStart === true

    if (!this.canOwnEngineRuntime()) {
      console.warn(
        `[v0] [Coordinator] startEngine(${connectionId}) queued-only in this production API worker; ` +
          "set ENABLE_TRADE_ENGINE_IN_PROCESS=1 on the coordinator worker to own runtime loops.",
      )
      return false
    }

    // Self-heal background timers on every public entry-point — see
    // `ensureBackgroundTimers` doc-block. No-op if already armed.
    this.ensureBackgroundTimers()

    // A queued start can race with a later dashboard disable/settings change in
    // production. Re-read the per-connection operator intent immediately before
    // acquiring locks so stale queued starts cannot resurrect a disabled
    // connection or start processing with stale assignment flags.
    try {
      const { initRedis, getConnection } = await import("@/lib/redis-db")
      const { isConnectionReadyForEngine } = await import("@/lib/connection-state-helpers")
      await initRedis()
      const currentConnection = await getConnection(connectionId)
      if (!currentConnection || !isConnectionReadyForEngine(currentConnection)) {
        console.log(
          `[v0] [Coordinator] startEngine(${connectionId}) skipped — connection is no longer assigned/enabled`,
        )
        return false
      }
    } catch (intentErr) {
      console.warn(
        `[v0] [Coordinator] startEngine(${connectionId}) could not verify current connection intent; refusing stale start:`,
        intentErr instanceof Error ? intentErr.message : String(intentErr),
      )
      return false
    }

    if (!(await this.isGlobalCoordinatorEnabled(`startEngine(${connectionId})`))) {
      return false
    }

    // Step 1: Check if already starting
    if (this.startingEngines.has(connectionId)) {
      console.warn(`[v0] [STARTUP LOCK] Engine already starting for ${connectionId}, skipping duplicate start request`)
      return false
    }

    // Step 2: Check if already running (check in-memory manager first, then Redis hint)
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      const runningFlag = await client.get(`engine_is_running:${connectionId}`)
      const manager = this.engineManagers.get(connectionId)
      const managerRunning = !!manager?.isEngineRunning

      if (runningFlag === "true" || runningFlag === "1") {
        if (managerRunning) {
          console.log(`[v0] [STARTUP LOCK] Engine already running for ${connectionId}, skipping...`)
          return true
        }
        const remoteState = await client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>))
        const remoteHeartbeat = Number((remoteState as any)?.last_processor_heartbeat || 0)
        const remoteHeartbeatFresh =
          Number.isFinite(remoteHeartbeat) && remoteHeartbeat > 0 && Date.now() - remoteHeartbeat < 90_000
        if (remoteHeartbeatFresh && !forceLocalTakeover) {
          console.warn(
            `[v0] [STARTUP LOCK] Engine ${connectionId} is owned by another worker with a fresh heartbeat; not clearing distributed running flag`,
          )
          return true
        }
        if (remoteHeartbeatFresh && forceLocalTakeover) {
          console.warn(
            `[v0] [STARTUP LOCK] Engine ${connectionId} has only a distributed heartbeat; explicit local start is taking ownership`,
          )
        }
        // Redis flag can become stale across crashes/restarts; clear stale state
        // before continuing. Leaving it set made status endpoints report a
        // phantom running engine while startEngine was still trying to recover,
        // and prevented later diagnostics from distinguishing a real owner from
        // a dead flag. A fresh remote heartbeat above is the proof that the flag
        // belongs to a real engine in another worker and must not be cleared.
        console.warn(`[v0] [STARTUP LOCK] Stale running flag detected for ${connectionId}; clearing and continuing with startup`)
        await client.del(`engine_is_running:${connectionId}`).catch(() => 0)
      }
    } catch (e) {
      console.warn(`[v0] [STARTUP LOCK] Could not check running status: ${e}`)
    }

    // Step 3: Add to lock set
    this.startingEngines.add(connectionId)
    console.log(`[v0] [STARTUP LOCK] Added ${connectionId} to startup lock`)

    let lockHandle: LockHandle | undefined
    try {
      // ── Step 3b: Acquire the cross-process ownership lock ──────────
      // This is the SECOND guard — the in-process `startingEngines`
      // set blocks duplicate starts within this Node worker; the
      // Redis lock blocks duplicate starts across workers, dev
      // reloads, serverless instances, etc.
      //
      // Self-heal: if THIS process already has a running manager for
      // the connection, the persistent lock value (data lives on
      // globalThis so it survives module re-evaluation) was set by
      // an earlier incarnation of OUR engine — overwrite it with a
      // fresh handle so the new manager carries a fresh epoch.
      // This breaks the start→bail→start flap that occurred after
      // Next.js HMR cycles or full dev-server restarts.
      const localManagerAlive =
        this.engineManagers.get(connectionId)?.isEngineRunning === true
      let acquired = await acquireProgressionLock(connectionId, undefined, {
        selfOwnedIfAlive: localManagerAlive,
      })
      if (!acquired.acquired || !acquired.handle) {
        const ownerHeartbeatFreshnessMs = 90_000
        let ownerHeartbeatFresh = false
        try {
          const { getRedisClient } = await import("@/lib/redis-db")
          const client = getRedisClient()
          const ownerState = await client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>))
          const ownerHeartbeat = Number((ownerState as any)?.last_processor_heartbeat || 0)
          ownerHeartbeatFresh =
            Number.isFinite(ownerHeartbeat) && ownerHeartbeat > 0 && Date.now() - ownerHeartbeat < ownerHeartbeatFreshnessMs
        } catch { /* heartbeat read is best-effort */ }

        if (ownerHeartbeatFresh) {
          if (!forceLocalTakeover) {
            console.warn(
              `[v0] [STARTUP LOCK] Engine ${connectionId} is owned by another worker (${acquired.existingOwner ?? "unknown"}) with a fresh heartbeat. Leaving existing owner untouched.`,
            )
            return true
          }
          console.warn(
            `[v0] [STARTUP LOCK] Engine ${connectionId} has a distributed owner (${acquired.existingOwner ?? "unknown"}); explicit local start is taking ownership.`,
          )
        }

        console.warn(
          `[v0] [STARTUP LOCK] Engine ${connectionId} is owned by another worker (${acquired.existingOwner ?? "unknown"}) with a stale heartbeat. Requesting prior progress stop and retrying once.`,
        )
        try {
          const { getRedisClient } = await import("@/lib/redis-db")
          const client = getRedisClient()
          await Promise.all([
            client.hset(`trade_engine_state:${connectionId}`, {
              stop_requested: "1",
              stop_reason: "superseded_by_new_start",
              stop_requested_at: new Date().toISOString(),
            }),
            client.hset(`progression:${connectionId}`, {
              stop_requested: "1",
              stop_reason: "superseded_by_new_start",
              stop_requested_at: new Date().toISOString(),
            }),
          ])
        } catch { /* best-effort signal for the previous worker */ }
        try {
          await this.stopEngine(connectionId)
        } catch { /* local worker may not own the previous engine */ }
        try {
          await forceBreakProgressionLock(connectionId)
        } catch { /* TTL fallback */ }
        acquired = await acquireProgressionLock(connectionId, undefined, {
          selfOwnedIfAlive: false,
          staleAfterMs: 0,
        })
        if (!acquired.acquired || !acquired.handle) {
          console.warn(
            `[v0] [STARTUP LOCK] Retry failed for ${connectionId}; still owned by ${acquired.existingOwner ?? "unknown"}.`,
          )
          return false
        }
      }
      // Cannot start engine ${connectionId}: Leaving existing owner untouched; return false remains the retry-failure path above.
      lockHandle = acquired.handle
      console.log(
        `[v0] [STARTUP LOCK] Acquired progression lock for ${connectionId} (epoch=${lockHandle.epoch}${acquired.healedStaleLock ? ", healed stale" : ""})`,
      )

      // Step 4: Initialize engine if needed
      let manager = this.engineManagers.get(connectionId)
      if (!manager) {
        console.log(`[v0] Starting TradeEngine for connection: ${connectionId}`)
        manager = await this.initializeEngine(connectionId, config)
      } else {
        console.log(`[v0] [STARTUP LOCK] Reusing existing engine manager for: ${connectionId}`)
      }

      // Step 5: Start the engine — pass the lock handle so it can
      // extend/release the slot and stamp the epoch.
      await manager.start(config, lockHandle)
      if (!manager.isEngineRunning) {
        throw new Error(`TradeEngine manager for ${connectionId} did not reach running state`)
      }
      // Manager now owns the lock; clear our local reference so the
      // finally-block doesn't try to break it on success.
      lockHandle = undefined
      console.log(`[v0] [STARTUP LOCK] TradeEngine successfully started for connection: ${connectionId}`)

      // ── Set isGloballyRunning so the watchdog monitors this engine ────
      // `startEngine` is the entry-point for individual connection starts
      // (dashboard toggle, settings save, quickstart) — none of which go
      // through `startAll()`. Without this flag the watchdog short-circuits
      // (`if (!this.isGloballyRunning) return`) and never recovers stalls.
      this.isGloballyRunning = true

      // ── Mark connection as assigned now that engine is live ───────────
      // is_active_inserted/is_assigned control Main Connections visibility.
      // Do NOT set is_enabled_dashboard here: that flag is the explicit
      // processing switch and must not be backfilled by engine-start paths.
      try {
        // Use updateConnection (not raw hset) so the getAllConnections()
        // 2-second in-memory cache is invalidated immediately.
        const { updateConnection: _uc } = await import("@/lib/redis-db")
        await _uc(connectionId, {
          is_active_inserted: "1",
          is_assigned: "1",
        })
      } catch { /* non-critical — dashboard can lag */ }
      return true
    } catch (err) {
      // On startup failure, give the lock back so a retry can succeed
      // without waiting for the TTL to expire. We use force-break
      // here (NOT release-with-owner) because the manager may have
      // partially started, and we want a clean slate.
      if (lockHandle) {
        try {
          await forceBreakProgressionLock(connectionId)
        } catch {
          /* TTL will reclaim */
        }
      }
      throw err
    } finally {
      // Step 6: Remove from lock set (always, even on error)
      this.startingEngines.delete(connectionId)
      console.log(`[v0] [STARTUP LOCK] Removed ${connectionId} from startup lock`)
    }
  }

  /**
   * Stop engine for a specific connection
   * PHASE 2 FIX: Added stop lock to prevent concurrent stop requests and race conditions
   */
  async stopEngine(connectionId: string, _options: StopEngineOptions = {}): Promise<void> {
    // Step 1: Check if already stopping
    if (this.stoppingEngines.has(connectionId)) {
      console.log(`[v0] [STOP LOCK] Engine already stopping for ${connectionId}, skipping duplicate stop request`)
      return
    }

    // Step 2: Add to stop lock set
    this.stoppingEngines.add(connectionId)
    console.log(`[v0] [STOP LOCK] Added ${connectionId} to stop lock`)

    try {
      console.log(`[v0] Stopping TradeEngine for connection: ${connectionId}`)

      const manager = this.engineManagers.get(connectionId)

      if (!manager) {
        console.log(`[v0] No in-memory engine found for connection: ${connectionId}; running Redis cleanup anyway`)
        await this.cleanupStoppedRuntimeState(connectionId)
        return
      }

      await manager.stop()
      this.engineManagers.delete(connectionId)

      await this.cleanupStoppedRuntimeState(connectionId)

      console.log(`[v0] ✓ TradeEngine stopped for connection: ${connectionId}`)
    } finally {
      // Step 3: Remove from stop lock set (always, even on error)
      this.stoppingEngines.delete(connectionId)
      console.log(`[v0] [STOP LOCK] Removed ${connectionId} from stop lock`)
    }
  }

  /**
   * Best-effort runtime cleanup shared by both normal stops and "no local
   * manager" stops. This intentionally does NOT mutate Main Connections
   * assignment/enabled flags (`is_active_inserted`, `is_dashboard_inserted`,
   * `is_assigned`, `is_active`). Assignment is user intent and is only cleared
   * by explicit remove/unassign flows; a normal engine stop should only clear
   * runtime-only Redis state and mark the engine runtime as stopped.
   */
  private async cleanupStoppedRuntimeState(connectionId: string): Promise<void> {
    try {
      const { getRedisClient, initRedis, setSettings } = await import("@/lib/redis-db")
      await initRedis().catch(() => undefined)
      const redisClient = getRedisClient()
      const nowIso = new Date().toISOString()
      const nowMs = String(Date.now())
      const stateRuntimeFieldsToClear = [
        "stop_requested",
        "stop_reason",
        "stop_requested_at",
        "running",
        "is_running",
        "engine_started",
        "started_at",
        "last_processor_heartbeat",
      ]
      const progressionRuntimeFieldsToClear = [
        "stop_requested",
        "stop_reason",
        "stop_requested_at",
        "is_running",
        "running",
        "engine_started",
        "prehistoric_phase_active",
      ]

      await Promise.all([
        redisClient.del(`engine_is_running:${connectionId}`).catch(() => 0),
        redisClient.hdel(`trade_engine_state:${connectionId}`, ...stateRuntimeFieldsToClear).catch(() => 0),
        redisClient.hdel(`settings:trade_engine_state:${connectionId}`, ...stateRuntimeFieldsToClear).catch(() => 0),
        redisClient.hset(`trade_engine_state:${connectionId}`, {
          status: "stopped",
          stopped_at: nowIso,
          updated_at: nowIso,
        }).catch(() => 0),
        redisClient.hset(`settings:trade_engine_state:${connectionId}`, {
          status: "stopped",
          stopped_at: nowIso,
          updated_at: nowIso,
        }).catch(() => 0),
        redisClient.hdel(`progression:${connectionId}`, ...progressionRuntimeFieldsToClear).catch(() => 0),
        redisClient.hset(`progression:${connectionId}`, {
          ended_at: nowMs,
          last_update: nowIso,
        }).catch(() => 0),
        setSettings(`engine_progression:${connectionId}`, {
          phase: "stopped",
          progress: 0,
          detail: "Engine stopped",
          updated_at: nowIso,
        }).catch(() => undefined),
      ])
      console.log(`[v0] ✓ Cleaned stopped runtime state for ${connectionId}`)
    } catch (redisErr) {
      console.warn(`[v0] [STOP LOCK] Could not clean stopped runtime state for ${connectionId}:`, redisErr)
    }
  }

  /**
   * Public restart entry point — used by the settings-watcher when a
   * `restart_required` change is detected. Serializes via the
   * escalation mutex (shared with the watchdog) so we never fire two
   * concurrent restarts for the same connection.
   */
  async restartEngine(connectionId: string): Promise<void> {
    if (!(await this.isGlobalCoordinatorEnabled(`restartEngine(${connectionId})`))) {
      return
    }
    if (this.escalatingEngines.has(connectionId)) {
      console.log(
        `[v0] [Coordinator] restartEngine(${connectionId}) skipped — restart already in flight`,
      )
      return
    }
    this.escalatingEngines.add(connectionId)
    try {
      const hasLocalRunningManager = this.engineManagers.get(connectionId)?.isEngineRunning === true
      if (hasLocalRunningManager) {
        // A local restart can stop normally so the manager releases its own
        // lock/heartbeat before we acquire a replacement generation below.
        try {
          await this.stopEngine(connectionId)
        } catch (stopErr) {
          console.warn(
            `[v0] [Coordinator] restartEngine stop failed for ${connectionId}:`,
            stopErr instanceof Error ? stopErr.message : String(stopErr),
          )
        }
      } else if (await this.markRemoteRestartRequestIfFresh(connectionId)) {
        console.log(
          `[v0] [Coordinator] restartEngine(${connectionId}) queued for remote owner has fresh heartbeat; treat the distributed owner as active`,
        )
        return
      }

      // Pre-emptively break the progression lock only after proving there is no
      // local manager to stop normally and no remote owner with a fresh heartbeat.
      try {
        await forceBreakProgressionLock(connectionId)
      } catch { /* TTL will reclaim */ }
      try {
        if (!hasLocalRunningManager) await this.stopEngine(connectionId)
      } catch (stopErr) {
        console.warn(
          `[v0] [Coordinator] restartEngine stop failed for ${connectionId}:`,
          stopErr instanceof Error ? stopErr.message : String(stopErr),
        )
      }
      try {
        await this.startEngineFromConnectionConfig(connectionId)
      } catch (startErr) {
        console.error(
          `[v0] [Coordinator] restartEngine start failed for ${connectionId}:`,
          startErr instanceof Error ? startErr.message : String(startErr),
        )
      }
    } finally {
      this.escalatingEngines.delete(connectionId)
    }
  }

  private async markRemoteRestartRequestIfFresh(connectionId: string): Promise<boolean> {
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      const remoteState = await client.hgetall(`trade_engine_state:${connectionId}`).catch(() => ({} as Record<string, string>))
      const remoteHeartbeat = Number((remoteState as any)?.last_processor_heartbeat || 0)
      if (!(Number.isFinite(remoteHeartbeat) && remoteHeartbeat > 0 && Date.now() - remoteHeartbeat < 90_000)) {
        return false
      }
      await client.hset(`trade_engine_state:${connectionId}`, {
        restart_request: "1",
        settings_change_marker: new Date().toISOString(),
        restart_requested_at: new Date().toISOString(),
      })
      return true
    } catch (error) {
      console.warn(
        `[v0] [Coordinator] remote restart marker failed for ${connectionId}:`,
        error instanceof Error ? error.message : String(error),
      )
      return false
    }
  }

  /**
   * Public fast-path for the API route. When connection settings are
   * saved we immediately call this so the running manager (if any in
   * THIS process) applies the change inline rather than waiting for
   * its 3 s watcher tick. Cross-process scenarios still converge via
   * the watcher polling the change counter — this is a latency
   * optimization, not a correctness one.
   */
  async applyPendingChangesNow(connectionId: string): Promise<void> {
    const manager = this.engineManagers.get(connectionId)
    if (!manager || !manager.isEngineRunning) return
    try {
      await manager.applyPendingSettingsChangeNow()
    } catch (err) {
      console.warn(
        `[v0] [Coordinator] applyPendingChangesNow failed for ${connectionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }


  /**
   * Public event-state drain for queued engine refresh requests.
   *
   * Explicit connection switch actions enqueue a durable refresh request and
   * then call this targeted fast path so the local coordinator can process the
   * changed connection immediately instead of waiting for the 10-second health
   * monitor tick. The health monitor still calls this without a connection id
   * as a safety net for requests written by other processes/serverless calls.
   */
  public async drainQueuedRefreshRequestsNow(connectionId?: string): Promise<void> {
    const refreshRequests = await getQueuedEngineRefreshRequests()
    const targetedRequests = connectionId
      ? refreshRequests.filter(({ request }) => request.connectionId === connectionId)
      : refreshRequests

    if (targetedRequests.length === 0) return

    const { getConnection } = await import("@/lib/redis-db")
    const now = Date.now()

    for (const { request } of targetedRequests) {
      const requestTime = new Date(request.timestamp).getTime()
      if (!Number.isFinite(requestTime) || now - requestTime >= 30000) {
        console.log(`[v0] [Coordinator] Dropping expired refresh request for ${request.connectionId}`)
        await clearEngineRefreshRequest(request.connectionId)
        continue
      }

      const connection = await getConnection(request.connectionId)
      const currentVersion = String(connection?.state_switch_version ?? 0)
      const requestedVersion = String(request.state_switch_version ?? "")
      if (!connection || currentVersion !== requestedVersion) {
        console.log(
          `[v0] [Coordinator] Ignoring stale refresh request for ${request.connectionId}: ` +
            `requested state_switch_version=${requestedVersion}, current=${currentVersion}`,
        )
        await clearEngineRefreshRequest(request.connectionId)
        continue
      }

      console.log(
        `[v0] [Coordinator] Refresh requested for ${request.connectionId}: ${request.action} ` +
          `(state_switch_version=${requestedVersion}, reason=${request.reason})`,
      )

      try {
        if (request.action === "stop") {
          await this.stopEngine(request.connectionId, { operatorRequested: true })
        } else if (request.action === "start") {
          if (!this.canOwnEngineRuntime()) {
            console.log(
              `[v0] [Coordinator] Leaving start request queued for ${request.connectionId}; ` +
                "this production API worker is not allowed to own engine loops.",
            )
            continue
          }
          if (!this.isEngineRunning(request.connectionId)) {
            await this.startEngineFromConnectionConfig(request.connectionId)
          }
        } else {
          // Settings/progression refresh requests must be hot-applied to the
          // target connection only. Calling refreshEngines() here performed
          // a full eligible-connection reconciliation every 10s and caused
          // repeated reinitializations right after progress started.
          await this.applyPendingChangesNow(request.connectionId)
        }
        await clearEngineRefreshRequest(request.connectionId)
      } catch (error) {
        console.warn(
          `[v0] [Coordinator] Refresh request failed for ${request.connectionId}; ` +
            `leaving queued for retry until expiry (attempt=${Number(request.retryCount ?? 0) + 1}):`,
          error instanceof Error ? error.message : String(error),
        )
        await recordEngineRefreshRequestFailure(request, error)
      }
    }
  }

  /**
   * Invalidate the symbol cache on a running engine so it re-reads
   * force_symbols / active_symbols from Redis on the next cycle.
   * Called by migration 033 after writing force_symbols to ensure the
   * live engine adopts the 15-symbol set without a full restart.
   */
  public invalidateSymbolsCacheForConnection(connectionId: string): void {
    const manager = this.engineManagers.get(connectionId)
    if (manager) {
      manager.invalidateSymbolsCache()
      console.log(`[v0] [Coordinator] invalidated symbol cache for ${connectionId}`)
    }
  }

  /**
   * Restart an engine using its stored connection config — used by the
   * watchdog escalation path after a confirmed stall. Loads the same
   * settings the normal start flow would (per-connection intervals
   * fall back to global app settings), so the restarted engine is
   * indistinguishable from a fresh dashboard toggle except that it
   * carries a NEW progression epoch.
   *
   * Returns silently on missing connection / missing settings; the
   * watchdog will simply retry on the next pass.
   */
  private async startEngineFromConnectionConfig(connectionId: string): Promise<void> {
    try {
      if (!(await this.isGlobalCoordinatorEnabled(`startEngineFromConnectionConfig(${connectionId})`))) {
        return
      }
      const { getConnection } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")
      const connection = await getConnection(connectionId)
      if (!connection) {
        console.warn(
          `[v0] [Coordinator] restart skipped — connection ${connectionId} not found`,
        )
        return
      }
      const settings = await loadSettingsAsync()
      const config: EngineConfig = {
        connectionId,
        allowInProcessStart: true,
        indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
        strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
        realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
      }
      await this.startEngine(connectionId, config)
    } catch (err) {
      console.warn(
        `[v0] [Coordinator] startEngineFromConnectionConfig failed for ${connectionId}:`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Toggle engine state with proper synchronization
   * PHASE 2 FIX: Ensures safe enable/disable by waiting for any ongoing state changes
   */
  async toggleEngine(connectionId: string, enabled: boolean, config?: EngineConfig): Promise<void> {
    // Wait for any ongoing state changes to complete
    const maxWaits = 100 // 5 seconds max
    let waits = 0
    while (
      (this.startingEngines.has(connectionId) || this.stoppingEngines.has(connectionId)) &&
      waits < maxWaits
    ) {
      await new Promise((r) => setTimeout(r, 50))
      waits++
    }

    if (waits >= maxWaits) {
      console.warn(
        `[v0] [TOGGLE] Timeout waiting for engine state change for ${connectionId}, proceeding anyway`
      )
    }

    if (enabled) {
      if (config) {
        await this.startEngine(connectionId, config)
      } else {
        console.warn(`[v0] [TOGGLE] Cannot start engine ${connectionId} - missing config`)
      }
    } else {
      await this.stopEngine(connectionId)
    }
  }

  /**
   * Check if engine is currently running
   */
  isEngineRunning(connectionId: string): boolean {
    const manager = this.engineManagers.get(connectionId)
    return manager ? manager.isEngineRunning : false
  }

  /**
   * Start all engines for enabled connections (modern Redis-based)
   */
  async startAll(): Promise<void> {
    try {
      console.log("[v0] [Coordinator] Starting global trade engine...")
      
      // Import Redis functions
      const { initRedis, getAssignedAndEnabledConnections, getAllConnections } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")
      
      // Initialize Redis and get connections
      await initRedis()
      const allConnections = await getAllConnections()
      
      // NOTE: Removed auto-enable logic
      // Connections must be explicitly:
      // 1. Created in base connections
      // 2. Assigned to main connections via add-to-active flow
      // 3. Enabled via dashboard toggle
      // This ensures user control over which connections are processed
      
      // Get assigned + enabled connections (user must explicitly assign to main)
      const connections = await getAssignedAndEnabledConnections()
      
      console.log(`[v0] [Coordinator] Connection audit: total=${allConnections.length}, inserted+enabled=${connections.length}`)
      
      // Show which connections would be processed
      if (connections.length > 0) {
        connections.slice(0, 5).forEach((c: any) => {
          console.log(`  - ${c.name || c.id}: exchange=${c.exchange}, inserted=${c.is_inserted}, dashboard_enabled=${c.is_enabled_dashboard}`)
        })
      }
      
      if (!Array.isArray(connections)) {
        console.error("[v0] [Coordinator] ERROR: connections is not an array")
        return
      }
      
      // All assigned+enabled connections run — credentials are checked per-operation,
      // not at engine startup. Demo/testnet/predefined connections run without real API keys.
      const validConnections = connections.filter((c) => {
        const hasCredentials = ((c.api_key || c.apiKey || "").length > 5 && (c.api_secret || c.apiSecret || "").length > 5)
        const isTestnet = c.is_testnet === "1" || c.is_testnet === true
        const isDemoMode = c.demo_mode === "1" || c.demo_mode === true
        const isPredefined = c.is_predefined === "1" || c.is_predefined === true
        // Allow any assigned+enabled connection: with credentials, or testnet/demo/predefined mode
        return hasCredentials || isTestnet || isDemoMode || isPredefined || true // allow all assigned+enabled
      })
      
      console.log(`[v0] [Coordinator] Starting engines for ${validConnections.length}/${connections.length} assigned+enabled connections`)
      
      if (validConnections.length === 0) {
        console.log("[v0] [Coordinator] No assigned+enabled connections found. Engine ready, waiting for connections.")
        this.isGloballyRunning = true
        return
      }
      
      const settings = await loadSettingsAsync()
      let successCount = 0
      
      for (const connection of validConnections) {
        try {
          const config: EngineConfig = {
            connectionId: connection.id,
            allowInProcessStart: true,
            indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
          }
          
          await this.startEngine(connection.id, config)
          successCount++
          console.log(`[v0] [Coordinator] ✓ Started: ${connection.name}`)
        } catch (error) {
          console.error(`[v0] [Coordinator] ✗ Failed to start ${connection.name}:`, error)
        }
      }
      
      this.isGloballyRunning = true
      console.log(`[v0] [Coordinator] ✓ Global engine started: ${successCount}/${validConnections.length} connections active`)
    } catch (error) {
      console.error("[v0] [Coordinator] Failed to start global engine:", error)
    }
  }

  /**
   * Idempotent background-timer self-heal.
   *
   * STABILITY: HMR / module-reload events historically fired in
   * production (e.g. when a settings save bounced a route handler) and
   * were observed to leave the coordinator singleton alive but with
   * `healthCheckTimer` / `coordinationMetricsTimer` cleared. The
   * watchdog re-arm and refresh-request handling are *exactly* the
   * mechanisms that keep engines processing; losing them silently is
   * the worst-case stability failure.
   *
   * This method is called from every public coordinator entry-point
   * (`startMissingEngines`, `refreshEngines`, `startEngine`,
   * `getAllEnginesStatus`, `pause`, `resume`, …) so the very next
   * caller after such an event re-arms both timers. The constructor
   * already calls them once; the underlying `startGlobal*` helpers are
   * themselves idempotent (they early-return when the timer field is
   * already set), so calling this on every entry-point is essentially
   * free in steady state.
   */
  ensureBackgroundTimers(): void {
    try {
      this.startGlobalHealthMonitoring()
    } catch (e) {
      console.warn("[v0] [Coordinator] ensureBackgroundTimers: health monitor restart failed:", e)
    }
    try {
      this.startCoordinationMetricsTracking()
    } catch (e) {
      console.warn("[v0] [Coordinator] ensureBackgroundTimers: metrics tracker restart failed:", e)
    }
  }

  /**
   * Drop "zombie" engine-manager entries — Map slots whose manager is
   * not actually running and whose creation predates `staleAgeMs`. We
   * see these accumulate when an engine fails to fully initialise
   * (e.g. credentials were revoked) and the failure path leaves a
   * not-running manager in the Map. They prevent `startMissingEngines`
   * from ever retrying that connection because the connectionId
   * appears "owned".
   *
   * Safe to call any time — a manager that *is* running is never
   * pruned.
   */
  private pruneZombieManagers(staleAgeMs = 30_000): number {
    let pruned = 0
    const now = Date.now()
    for (const [connectionId, mgr] of this.engineManagers.entries()) {
      if (mgr.isEngineRunning) continue
      // `createdAt` is set on TradeEngineManager construction; if it's
      // missing (older instances) we treat the entry as immediately
      // prunable, which is the conservative behaviour — a not-running
      // manager has no semantics worth preserving.
      const createdAt = (mgr as any).createdAt as number | undefined
      const ageMs = createdAt ? now - createdAt : Number.POSITIVE_INFINITY
      if (ageMs >= staleAgeMs) {
        this.engineManagers.delete(connectionId)
        pruned++
        console.log(
          `[v0] [Coordinator] Pruned zombie manager for ${connectionId} (age=${
            Number.isFinite(ageMs) ? `${ageMs}ms` : "unknown"
          }, isEngineRunning=false)`,
        )
      }
    }
    return pruned
  }

  /**
   * Start engines for connections that should be running but don't have engines
   * Does NOT stop engines - leaves that to explicit user actions via dashboard toggles
   * Respects pause state - does not start engines when coordinator is paused
   */
  async startMissingEngines(connections: any[]): Promise<number> {
    try {
      console.log("[v0] [Coordinator] === START MISSING ENGINES ===")

      // ── DEV ONE-ENGINE OOM GUARD ──────────────────────────────────────────
      // This is the single chokepoint through which BOTH the auto-start healing
      // sweep and the operator Start route request engines. On the low-RAM dev
      // VM (4.39 GB, no swap) two engines running their prehistoric StrategySet
      // pass at once reliably OOM-kills the worker. Both bingx-x01 and bybit-x03
      // are always inited + visible, but in DEVELOPMENT only ONE engine may run
      // at a time. We keep any connection the operator explicitly enabled
      // (is_enabled_dashboard="1"); otherwise we default to the primary
      // bingx-x01. Every other connection (e.g. bybit) stays engine-idle until
      // the operator enables it. Production is unaffected — all eligible engines
      // run there.
      if (process.env.NODE_ENV !== "production" && Array.isArray(connections) && connections.length > 1) {
        const explicitlyEnabled = connections.filter(
          (c) => String(c?.is_enabled_dashboard) === "1",
        )
        const pool = explicitlyEnabled.length > 0 ? explicitlyEnabled : connections
        const primary = pool.find((c) => c?.id === "bingx-x01") ?? pool[0]
        const capped = primary ? [primary] : []
        if (capped.length !== connections.length) {
          console.log(
            `[v0] [Coordinator] DEV one-engine guard: capping ${connections.length} eligible ` +
              `connections → running only "${capped[0]?.id ?? "none"}" (others stay engine-idle to avoid OOM)`,
          )
        }
        connections = capped
      }

      if (!(await this.isGlobalCoordinatorEnabled("startMissingEngines"))) {
        return 0
      }

      // Self-heal: make sure the watchdog and metrics tracker are armed
      // before we start any new engines (otherwise any stalls on
      // freshly-started engines wouldn't be recovered).
      this.ensureBackgroundTimers()

      // Prune dead Map entries before computing `runningIds` so a
      // failed-init manager doesn't shadow a connection that should
      // legitimately be (re-)started.
      this.pruneZombieManagers()

      const { getAssignedAndEnabledConnections } = await import("@/lib/redis-db")
      const { isConnectionEligibleForEngine } = await import("@/lib/connection-state-utils")
      const { logProgressionEvent } = await import("@/lib/engine-progression-logs")

      // Re-check eligibility at the engine-start chokepoint. For targeted
      // event-state starts (usually one connection), avoid loading every
      // assigned connection from Redis; that all-connections read was a major
      // production memory spike during progression/toggle bursts.
      if (connections.length <= 2) {
        connections = connections.filter((c: any) => isConnectionEligibleForEngine(c))
      } else {
        const strictlyEligibleIds = new Set((await getAssignedAndEnabledConnections()).map((c: any) => c.id))
        connections = connections.filter((c: any) => strictlyEligibleIds.has(c.id))
      }

      const enabledIds = new Set(connections.map(c => c.id))
      // Only count managers whose engine is actually running, not zombie Map entries from stale closures
      const runningIds = new Set(
        Array.from(this.engineManagers.entries())
          .filter(([, mgr]) => mgr.isEngineRunning)
          .map(([id]) => id),
      )
      
      console.log(`[v0] [Coordinator] Missing engines check: shouldBeRunning=${enabledIds.size}, currentlyRunning=${runningIds.size}`)
      const configuredMaxActive = Number(process.env.MAX_ACTIVE_TRADE_ENGINES || process.env.TRADE_ENGINE_MAX_ACTIVE || 0)
      const maxActiveEngines = Number.isFinite(configuredMaxActive) && configuredMaxActive > 0
        ? configuredMaxActive
        : (process.env.NODE_ENV === "production" ? 2 : Number.POSITIVE_INFINITY)
      
      // Start engines for connections that should be running but aren't
      let started = 0
      for (const connection of connections) {
        if (runningIds.size + started >= maxActiveEngines) {
          console.warn(
            `[v0] [Coordinator] Active engine cap reached (${runningIds.size + started}/${maxActiveEngines}); ` +
              `leaving ${connection.id} queued for the next event/healing pass`,
          )
          continue
        }
        if (!runningIds.has(connection.id)) {
          try {
            const hasCredentials = Boolean((connection.api_key || connection.apiKey) && (connection.api_secret || connection.apiSecret))
            if (!hasCredentials) {
              console.log(
                `[v0] [Coordinator] START: ${connection.name} (${connection.exchange}) without credentials ` +
                  "— running Main/strategy pipeline only; exchange order placement remains credential-gated",
              )
              await logProgressionEvent(
                connection.id,
                "engine_starting_without_credentials",
                "warning",
                "Coordinator starting engine without credentials; live order placement remains blocked",
                {
                  connectionId: connection.id,
                  connectionName: connection.name,
                  exchange: connection.exchange,
                },
              )
            }
            
            console.log(`[v0] [Coordinator] START: ${connection.name} (${connection.exchange})`)
            await logProgressionEvent(connection.id, "engine_starting", "info", "Coordinator starting engine", {
              connectionId: connection.id,
              connectionName: connection.name,
              exchange: connection.exchange,
            })
            
            const { loadSettingsAsync } = await import("@/lib/settings-storage")
            const settings = await loadSettingsAsync()
            
            const config: EngineConfig = {
              connectionId: connection.id,
              allowInProcessStart: true,
              engine_type: "main", // Main Trade Engine for indications, strategies, pseudo positions
              indicationInterval: settings.mainEngineIntervalMs ? Math.max(1, settings.mainEngineIntervalMs / 1000) : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? Math.max(1, settings.strategyUpdateIntervalMs / 1000) : 10,
              realtimeInterval: settings.realtimeIntervalMs ? Math.max(0.1, settings.realtimeIntervalMs / 1000) : 0.3,
            }
            
            const didStart = await this.startEngine(connection.id, config)
            if (!didStart) {
              await logProgressionEvent(connection.id, "engine_start_skipped", "warning", "Coordinator start skipped - engine is already owned by another worker or starting", {
                connectionId: connection.id,
                engineType: "main",
              })
              continue
            }
            started++

            // Mirror only assignment/visibility. Do not set is_enabled_dashboard
            // here: it is the explicit processing switch and legacy assigned rows
            // must not be auto-enabled by engine-start paths.
            try {
              const { updateConnection } = await import("@/lib/redis-db")
              await updateConnection(connection.id, {
                is_active_inserted: "1",
                is_assigned: "1",
              })
            } catch (flagErr) {
              console.warn(
                `[v0] [Coordinator] Could not update assignment flags for ${connection.id}:`,
                flagErr instanceof Error ? flagErr.message : flagErr,
              )
            }
            
            await logProgressionEvent(connection.id, "engine_started", "info", "Main Trade Engine started for progression", {
              connectionId: connection.id,
              engineType: "main",
              config,
            })
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            console.error(`[v0] [Coordinator] ERROR starting ${connection.name}:`, errorMsg)
            await logProgressionEvent(connection.id, "engine_start_error", "error", "Coordinator failed to start engine", {
              error: errorMsg,
            })
          }
        }
      }
      
      console.log(`[v0] [Coordinator] === START MISSING ENGINES COMPLETE: started=${started} ===`)
      return started
    } catch (error) {
      console.error("[v0] [Coordinator] Error starting missing engines:", error)
      return 0
    }
  }

  /**
   * Refresh engines - only start engines for newly enabled connections
   * Does NOT stop engines - leaves that to explicit user actions via dashboard toggles
   * Called periodically or when connections toggle
   */
  async refreshEngines(): Promise<void> {
    try {
      console.log("[v0] [Coordinator] === REFRESH ENGINES START (START ONLY) ===")

      if (!(await this.isGlobalCoordinatorEnabled("refreshEngines"))) {
        return
      }

      // Self-heal background timers + drop dead Map slots before we
      // reconcile so a zombie manager doesn't shadow a connection that
      // legitimately needs (re-)starting.
      this.ensureBackgroundTimers()
      this.pruneZombieManagers()

      const { initRedis, getAssignedAndEnabledConnections, getAllConnections } = await import("@/lib/redis-db")
      const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
      
      await initRedis()
      const enabledConnections = await getAssignedAndEnabledConnections()
      const allConnections = await getAllConnections()
      
      const enabledIds = new Set(enabledConnections.map(c => c.id))
      // Only count managers whose engine is actually running (not just present in the Map)
      const runningIds = new Set(
        Array.from(this.engineManagers.entries())
          .filter(([, mgr]) => mgr.isEngineRunning)
          .map(([id]) => id)
      )
      
      console.log(`[v0] [Coordinator] State: enabled=${enabledConnections.length}, running=${runningIds.size}`)
      
      // Start engines for newly enabled connections
      let started = 0
      let skipped = 0
      for (const connection of enabledConnections) {
        if (!runningIds.has(connection.id)) {
          try {
            const hasCredentials = Boolean((connection.api_key || connection.apiKey) && (connection.api_secret || connection.apiSecret))
            if (!hasCredentials) {
              console.log(
                `[v0] [Coordinator] START: ${connection.name} (${connection.exchange}) without credentials ` +
                  "— running Main/strategy pipeline only; exchange order placement remains credential-gated",
              )
              await logProgressionEvent(
                connection.id,
                "engine_starting_without_credentials",
                "warning",
                "Coordinator starting engine without credentials; live order placement remains blocked",
                {
                  connectionId: connection.id,
                  connectionName: connection.name,
                  exchange: connection.exchange,
                },
              )
            }
            
            console.log(`[v0] [Coordinator] START: ${connection.name} (${connection.exchange})`)
            await logProgressionEvent(connection.id, "engine_starting", "info", "Coordinator starting engine", {
              connectionId: connection.id,
              connectionName: connection.name,
              exchange: connection.exchange,
            })
            
            const { loadSettingsAsync } = await import("@/lib/settings-storage")
            const settings = await loadSettingsAsync()
            
            const config: EngineConfig = {
              connectionId: connection.id,
              allowInProcessStart: true,
              engine_type: "main", // Main Trade Engine for indications, strategies, pseudo positions
              indicationInterval: settings.mainEngineIntervalMs ? Math.max(1, settings.mainEngineIntervalMs / 1000) : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? Math.max(1, settings.strategyUpdateIntervalMs / 1000) : 10,
              realtimeInterval: settings.realtimeIntervalMs ? Math.max(0.1, settings.realtimeIntervalMs / 1000) : 0.3,
            }
            
            const didStart = await this.startEngine(connection.id, config)
            if (!didStart) {
              await logProgressionEvent(connection.id, "engine_start_skipped", "warning", "Coordinator start skipped - engine is already owned by another worker or starting", {
                connectionId: connection.id,
                engineType: "main",
              })
              continue
            }
            started++
            
            await logProgressionEvent(connection.id, "engine_started", "info", "Main Trade Engine started for progression", {
              connectionId: connection.id,
              engineType: "main",
              config,
            })
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error)
            console.error(`[v0] [Coordinator] ERROR starting ${connection.name}:`, errorMsg)
            await logProgressionEvent(connection.id, "engine_start_error", "error", "Coordinator failed to start engine", {
              error: errorMsg,
            })
          }
        }
      }
      
      // NOTE: Intentionally NOT stopping engines for disabled connections
      // Engine stopping should only happen via explicit user actions (dashboard toggles)
      // This prevents automatic reassignment and maintains user control
      const stopped = 0
      
      console.log(`[v0] [Coordinator] === REFRESH COMPLETE: started=${started}, stopped=${stopped} (engines not stopped per user control policy), skipped=${skipped} ===`)
    } catch (error) {
      console.error("[v0] [Coordinator] Error refreshing engines:", error)
    }
  }

  /**
   * Start all engines - alias for startAll()
   */
  async startAllEngines(): Promise<void> {
    return this.startAll()
  }

  /**
   * Stop all engines
   */
  async stopAll(): Promise<void> {
    console.log("[v0] Stopping all TradeEngines...")

    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer)
      this.healthCheckTimer = undefined
    }
    if (this.coordinationMetricsTimer) {
      clearInterval(this.coordinationMetricsTimer)
      this.coordinationMetricsTimer = undefined
    }

    for (const [connectionId, manager] of this.engineManagers.entries()) {
      try {
        await manager.stop()
        console.log(`[v0] Stopped engine: ${connectionId}`)
      } catch (error) {
        console.error(`[v0] Failed to stop engine for connection ${connectionId}:`, error)
      }
    }

    this.engineManagers.clear()
    this.isGloballyRunning = false
    this.isPaused = false

    console.log("[v0] All TradeEngines stopped")
  }

  // Alias for backward compat
  async stopAllEngines(): Promise<void> {
    return this.stopAll()
  }

  /**
   * Pause all engines. Redis `trade_engine:global` is the authority, so the
   * paused intent is written before local teardown or reconciliation begins.
   */
  async pause(): Promise<void> {
    console.log("[v0] [Coordinator] PAUSING global trade engine - publishing paused intent...")

    this.isPaused = true
    this.isGloballyRunning = false

    const stateSnapshot: Record<string, boolean> = {}
    const nowIso = new Date().toISOString()

    try {
      const { initRedis, getRedisClient, getActiveConnectionsForEngine } = await import("@/lib/redis-db")
      await initRedis()
      const client = getRedisClient()
      const currentGlobalState = (await client.hgetall("trade_engine:global").catch(() => ({}))) as Record<string, string>
      const previousStatus = currentGlobalState.status === "paused"
        ? currentGlobalState.previous_status || "running"
        : currentGlobalState.status || currentGlobalState.operator_intent || "running"

      for (const [connectionId, manager] of this.engineManagers.entries()) {
        stateSnapshot[connectionId] = manager.isEngineRunning
      }

      await client.hset("trade_engine:global", {
        status: "paused",
        operator_intent: "paused",
        desired_status: "paused",
        paused_at: nowIso,
        paused_by: "global_coordinator",
        previous_status: previousStatus,
        engine_state_snapshot: JSON.stringify(stateSnapshot),
        engine_state_paused_at: nowIso,
      })

      const remoteConnectionIds = new Set<string>(Array.from(this.engineManagers.keys()))
      try {
        const activeConnections = await getActiveConnectionsForEngine()
        for (const connection of activeConnections) remoteConnectionIds.add(connection.id)
      } catch { /* best-effort remote pause fanout */ }

      await Promise.all(Array.from(remoteConnectionIds).map((connectionId) => Promise.all([
        client.hset(`trade_engine_state:${connectionId}`, {
          status: "paused",
          pause_requested: "1",
          pause_reason: "global_coordinator",
          pause_requested_at: nowIso,
          paused_at: nowIso,
          paused_by: "global_coordinator",
        }).catch(() => 0),
        client.hset(`progression:${connectionId}`, {
          status: "paused",
          pause_requested: "1",
          pause_reason: "global_coordinator",
          pause_requested_at: nowIso,
          paused_at: nowIso,
          paused_by: "global_coordinator",
        }).catch(() => 0),
      ])))
      console.log(`[v0] [Coordinator] Published paused intent for ${remoteConnectionIds.size} connection(s)`)
    } catch (err) {
      console.warn("[v0] [Coordinator] Failed to publish paused Redis intent before local stop:", err)
      throw err
    }

    const allConnectionIds = Array.from(this.engineManagers.keys())
    console.log(`[v0] [Coordinator] Stopping ${allConnectionIds.length} local trade engine(s)...`)

    for (const connectionId of allConnectionIds) {
      try {
        const manager = this.engineManagers.get(connectionId)
        if (manager?.isEngineRunning) {
          await manager.stop()
          console.log(`[v0] [Coordinator] ✓ Stopped local engine for connection: ${connectionId}`)
        }
      } catch (error) {
        console.error(`[v0] [Coordinator] Failed to stop engine for connection ${connectionId}:`, error)
      }
    }

    console.log("[v0] [Coordinator] ✓ Global trade engine PAUSED - intent is authoritative in Redis")
  }

  /**
   * Resume all engines. Reads Redis intent instead of relying on local
   * `isPaused`, then writes running intent before calling startEngine() so
   * resume-triggered starts pass the global-intent guard.
   */
  async resume(options: { force?: boolean } = {}): Promise<void> {
    console.log("[v0] [Coordinator] RESUMING global trade engine - publishing running intent...")

    try {
      const { initRedis, getAssignedAndEnabledConnections, getRedisClient } = await import("@/lib/redis-db")
      const { loadSettingsAsync } = await import("@/lib/settings-storage")

      await initRedis()
      const client = getRedisClient()
      const globalState = (await client.hgetall("trade_engine:global").catch(() => ({}))) as Record<string, string>
      const currentIntent = globalState.operator_intent || globalState.desired_status || globalState.status || ""
      const redisPaused = globalState?.status === "paused" || globalState?.operator_intent === "paused"

      if (!options.force && !this.isPaused && !redisPaused) {
        console.log(`[v0] [Coordinator] Resume requested while global intent is "${currentIntent || "empty"}" and coordinator is not paused; nothing to resume`)
        return
      }

      const restoredStatus = "running"
      const nowIso = new Date().toISOString()
      // Publish running intent before calling startEngine(); startEngine()
      // intentionally refuses to start unless this hash says the coordinator
      // is globally enabled. Clear operator_stopped so an explicit resume
      // wins over an older stop marker.
      await client.hset("trade_engine:global", {
        status: restoredStatus,
        operator_intent: restoredStatus,
        desired_status: restoredStatus,
        operator_stopped: "0",
        resumed_at: nowIso,
        updated_at: nowIso,
      })
      await client.hdel("trade_engine:global", "paused_at", "paused_by", "previous_status")

      this.isPaused = false
      this.isGloballyRunning = true
      this.ensureBackgroundTimers()

      const connections = await getAssignedAndEnabledConnections()
      if (!Array.isArray(connections)) {
        console.error("[v0] [Coordinator] ERROR: connections is not an array during resume")
        return
      }

      let stateSnapshot: Record<string, boolean> = {}
      try {
        if (globalState.engine_state_snapshot) {
          stateSnapshot = JSON.parse(globalState.engine_state_snapshot)
          console.log("[v0] [Coordinator] Restored engine state snapshot from pause")
        }
      } catch (err) {
        console.warn("[v0] [Coordinator] Failed to restore engine state snapshot:", err)
      }

      const settings = await loadSettingsAsync()
      let resumedCount = 0

      for (const connection of connections) {
        try {
          const connectionId = connection.id
          const wasRunningBeforePause = stateSnapshot[connectionId]
          if (wasRunningBeforePause === false) {
            console.log(`[v0] [Coordinator] ⊘ Skipped: ${connection.name} (was not running before pause)`)
            continue
          }

          await Promise.all([
            client.hdel(`trade_engine_state:${connectionId}`, "pause_requested", "pause_reason", "pause_requested_at", "paused_at", "paused_by").catch(() => 0),
            client.hdel(`progression:${connectionId}`, "pause_requested", "pause_reason", "pause_requested_at", "paused_at", "paused_by").catch(() => 0),
          ])

          const config: EngineConfig = {
            connectionId,
            allowInProcessStart: true,
            indicationInterval: settings.mainEngineIntervalMs ? Math.max(1, settings.mainEngineIntervalMs / 1000) : 5,
            strategyInterval: settings.strategyUpdateIntervalMs ? Math.max(1, settings.strategyUpdateIntervalMs / 1000) : 10,
            realtimeInterval: settings.realtimeIntervalMs ? Math.max(0.1, settings.realtimeIntervalMs / 1000) : 0.3,
          }

          const didStart = await this.startEngine(connectionId, config)
          if (didStart) resumedCount++
          const wasRunning = wasRunningBeforePause === true ? " (was running)" : " (no state record, defaulting to resume)"
          console.log(`[v0] [Coordinator] ${didStart ? "✓ Resumed" : "⊘ Resume start skipped"}: ${connection.name}${wasRunning}`)
        } catch (error) {
          console.error(`[v0] [Coordinator] Failed to resume engine for connection ${connection.id}:`, error)
        }
      }

      console.log(`[v0] [Coordinator] ✓ Global trade engine RESUMED: ${resumedCount} engines restarted`)
    } catch (error) {
      console.error("[v0] [Coordinator] Failed to resume engines:", error)
      throw error
    }
  }

  /**
   * Get engine manager for a specific connection
   */
  getEngineManager(connectionId: string): TradeEngineManager | null {
    return this.engineManagers.get(connectionId) || null
  }

  /**
   * Get status of all engines.
   *
   * Status reads are by far the most frequent coordinator entry-point
   * (the dashboard polls every few seconds). We piggyback the background
   * timer self-heal here so even a system that's never explicitly
   * "started" but is being observed will keep its watchdog armed.
   */
  async getAllEnginesStatus(): Promise<Record<string, any>> {
    this.ensureBackgroundTimers()
    const status: Record<string, any> = {}

    for (const [connectionId, manager] of this.engineManagers.entries()) {
      try {
        status[connectionId] = await manager.getStatus()
      } catch (error) {
        status[connectionId] = { error: error instanceof Error ? error.message : "Unknown error" }
      }
    }

    return status
  }

  /**
   * Get status of a specific engine
   */
  async getEngineStatus(connectionId: string): Promise<any | null> {
    const manager = this.engineManagers.get(connectionId)
    if (!manager) return null

    return manager.getStatus()
  }

  /**
   * Get global system health
   */
  async getGlobalHealth(): Promise<HealthStatus> {
    const allStatus = await this.getAllEnginesStatus()
    const components: Record<string, ComponentHealth> = {}

    let healthyCount = 0
    let degradedCount = 0
    let unhealthyCount = 0

    for (const [connectionId, status] of Object.entries(allStatus)) {
      if (status.health) {
        components[connectionId] = {
          status: status.health.overall,
          lastCycleDuration: 0,
          errorCount: 0,
          successRate: 100,
        }

        if (status.health.overall === "healthy") healthyCount++
        else if (status.health.overall === "degraded") degradedCount++
        else unhealthyCount++
      }
    }

    let overall: "healthy" | "degraded" | "unhealthy" = "healthy"
    if (unhealthyCount > 0) overall = "unhealthy"
    else if (degradedCount > 0) overall = "degraded"

    return {
      overall,
      components,
      lastCheck: new Date(),
    }
  }

  /**
   * Ensure engine state exists in Redis
   */
  private async ensureEngineState(connectionId: string): Promise<void> {
    try {
      // Check if state exists in Redis (consistent with engine-manager's updateEngineState)
      const stateKey = `trade_engine_state:${connectionId}`
      const existing = await getSettings(stateKey)

      if (!existing) {
        // Create initial state in Redis
        const initialState = {
          connection_id: connectionId,
          status: "idle",
          prehistoric_data_loaded: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        }
        await setSettings(stateKey, initialState)
        console.log(`[v0] Created engine state for connection: ${connectionId}`)
      }
    } catch (error) {
      console.error(`[v0] Failed to ensure engine state for ${connectionId}:`, error)
    }
  }

  /**
   * Start global health monitoring with connection refresh detection +
   * per-engine stall watchdog.
   *
   * Watchdog: every 10s we read each running engine's
   * `last_processor_heartbeat` from `trade_engine_state:{id}`. If it's
   * older than `STALL_THRESHOLD_MS` we call `manager.rearmIfStalled()`,
   * which re-arms only the missing processor timers in place. We do NOT
   * stop + restart the engine, do NOT rebuild the manager, do NOT replay
   * prehistoric ��� that was the cause of the user's "no-sense
   * reassignments / restarts" complaint.
   */
  /**
   * Per-connection stall counters. When the watchdog detects a stall it calls
   * `manager.rearmIfStalled()` (cheap, in-place). We intentionally avoid
   * automatic full stop/start escalation because QuickStart's prehistoric
   * phase can run long enough to trip heartbeat checks; forced restarts reset
   * progress, create duplicate epochs, and were the source of repeated
   * QuickStart crashes. Resets to 0 once the engine reports a fresh heartbeat.
   *
   * Map<connectionId, consecutiveStallCount>
   */
  private stallEscalation: Map<string, number> = new Map()

  /**
   * Mutex for in-flight escalation restarts. The watchdog runs every
   * 10 s and a full stop+restart can take longer than that, so the
   * next tick MUST NOT fire a second escalation while the previous
   * one is still draining. Without this guard, two concurrent
   * restarts would each acquire-then-break the lock and produce the
   * "doubled progression / stopping-restarting" symptom.
   */
  private escalatingEngines: Set<string> = new Set()

  private startGlobalHealthMonitoring(): void {
    if (this.healthCheckTimer) {
      // Already running — keep the existing timer.
      return
    }
    const healthCheckInterval = 10000 // 10s
    // ── Stall thresholds (relaxed from earlier 60s / 2 attempts) ───
    // Real-world Redis pauses on cold-started serverless instances
    // can routinely sit on 30-60s; aggressive thresholds caused the
    // watchdog to nuke healthy engines that were just about to come
    // back. New values give the engine generous recovery room:
    //
    //   • 90 s without heartbeat before we even *consider* stall.
    //   • Automatic full stop+restart escalation is disabled by default;
    //     repeated stalls keep re-arming in-place and preserving the active
    //     progression/session so QuickStart stats remain continuous.
    //
    // Result: the watchdog can heal dropped timers without resetting UI progress.
    const STALL_THRESHOLD_MS = 90_000
    const ESCALATION_THRESHOLD = 4
    const FULL_RESTART_ESCALATION_ENABLED = false

    console.log("[v0] Starting global trade engine health monitoring (refresh detection + stall watchdog)")

    this.healthCheckTimer = setInterval(async () => {
      try {
        // -- 1. Refresh-request handling ----------------------------------
        await this.drainQueuedRefreshRequestsNow()

        // -- 2. Per-engine stall watchdog (in-place re-arm) ---------------
        //
        // Only run when the operator has explicitly enabled the global
        // coordinator.  Settings/dashboard routes can leave local managers
        // around briefly during stop/restart races; the watchdog must never
        // re-arm or force-restart those managers while Redis says the global
        // coordinator is stopped/paused.
        if (!(await this.isGlobalCoordinatorEnabled("watchdog"))) {
          this.stallEscalation.clear()
          return
        }
        const now = Date.now()
        for (const [connectionId, manager] of this.engineManagers.entries()) {
          if (!manager.isEngineRunning) continue
          try {
            const state = (await getSettings(`trade_engine_state:${connectionId}`)) || {}
            // Prefer the unified processor heartbeat; fall back to
            // last_indication_run for engines that haven't been upgraded
            // yet (heartbeat key is added in this same change-set).
            const lastHb =
              Number(state.last_processor_heartbeat) ||
              (state.last_processor_heartbeat ? new Date(state.last_processor_heartbeat).getTime() : 0) ||
              (state.last_indication_run ? new Date(state.last_indication_run).getTime() : 0)
            if (lastHb === 0) {
              // lastHb=0 can mean "engine just started, no heartbeat yet"
              // OR "engine was running but Redis was down so heartbeats
              // couldn't be written."  If the engine state shows it was
              // running and we're past the stall threshold since
              // `last_state_update`, treat as a stall.
              const stateUpdatedAt = Number(state.last_state_update) || 0
              if (stateUpdatedAt > 0 && now - stateUpdatedAt > STALL_THRESHOLD_MS) {
                // Fall through to stall handling below — the engine was
                // running but Red is back and heartbeats are zero.
                console.warn(
                  `[v0] [Watchdog] Engine ${connectionId} has zero heartbeats but shows running for ${Math.round((now - stateUpdatedAt) / 1000)}s — treating as stalled (Redis outage recovery)`,
                )
                // Synthesize a lastHb so the age check below fires
                this.stallEscalation.set(connectionId, (this.stallEscalation.get(connectionId) ?? 0) + 1)
                const manager = this.engineManagers.get(connectionId)
                if (manager?.rearmIfStalled) {
                  try { await manager.rearmIfStalled() } catch {}
                }
                continue
              }
              continue // engine started but no heartbeat yet
            }
            const age = now - lastHb
            if (age > STALL_THRESHOLD_MS) {
              const consecutiveStalls = (this.stallEscalation.get(connectionId) ?? 0) + 1
              this.stallEscalation.set(connectionId, consecutiveStalls)

              if (!FULL_RESTART_ESCALATION_ENABLED || consecutiveStalls < ESCALATION_THRESHOLD) {
                // ── Tier 1: in-place re-arm ──────────────────────────
                // Cheapest recovery — re-attaches missing processor
                // timers without rebuilding the manager. Most stalls
                // are just a dropped timer (HMR race / unhandled
                // rejection / Redis pause) and this fixes them.
                console.warn(
                  `[v0] [Watchdog] Engine ${connectionId} stalled (last heartbeat ${age}ms ago, attempt ${consecutiveStalls}${FULL_RESTART_ESCALATION_ENABLED ? `/${ESCALATION_THRESHOLD}` : ", restart escalation disabled"}) — re-arming in place`,
                )
                try {
                  const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
                  await logProgressionEvent(
                    connectionId,
                    "engine_stall_recovered",
                    "warning",
                    `Engine stalled for ${Math.round(age / 1000)}s — watchdog re-arming in place (attempt ${consecutiveStalls}${FULL_RESTART_ESCALATION_ENABLED ? `/${ESCALATION_THRESHOLD}` : ", restart escalation disabled"})`,
                    { ageMs: age, connectionId, attempt: consecutiveStalls, fullRestartEscalationEnabled: FULL_RESTART_ESCALATION_ENABLED },
                  )
                } catch {
                  // Logging is best-effort; never block recovery on it.
                }
                try {
                  await manager.rearmIfStalled()
                } catch (rearmError) {
                  console.error(
                    `[v0] [Watchdog] rearmIfStalled threw for ${connectionId}:`,
                    rearmError instanceof Error ? rearmError.message : String(rearmError),
                  )
                }
              } else {
                // ── Tier 2: full stop + restart with new epoch ───────
                // In-place re-arm didn't bring the heartbeat back.
                // The engine is wedged hard (e.g. stuck inside a long
                // Redis-pipeline await, or a never-resolving await on
                // network I/O). The ONLY safe recovery is to drop
                // the lock, tear down the manager, and start fresh.
                //
                // ── Concurrency guards ────────────────────────────────
                //   1. Mutex: if an escalation for this connection is
                //      already in flight, skip THIS tick. The previous
                //      escalation will complete and the next health
                //      check will reassess.
                //   2. Ownership: only escalate engines we actually own
                //      in THIS process. The local manager must be
                //      present in our map; otherwise we're looking at
                //      a cross-process scenario and the OTHER process
                //      owns the recovery responsibility.
                if (this.escalatingEngines.has(connectionId)) {
                  console.warn(
                    `[v0] [Watchdog] Engine ${connectionId} escalation already in-flight — skipping duplicate restart`,
                  )
                  // Don't clear the stall counter — let the in-flight
                  // escalation finish and the next tick re-evaluate.
                  continue
                }
                const localManager = this.engineManagers.get(connectionId)
                if (!localManager) {
                  console.warn(
                    `[v0] [Watchdog] Engine ${connectionId} not in local map — skipping escalation (cross-process owner)`,
                  )
                  this.stallEscalation.delete(connectionId)
                  continue
                }
                console.error(
                  `[v0] [Watchdog] Engine ${connectionId} STILL stalled after ${consecutiveStalls} attempts (${age}ms) — escalating to full restart`,
                )
                this.stallEscalation.delete(connectionId)
                this.escalatingEngines.add(connectionId)
                try {
                  const { logProgressionEvent } = await import("@/lib/engine-progression-logs")
                  await logProgressionEvent(
                    connectionId,
                    "engine_force_restart",
                    "error",
                    `Engine wedged after ${consecutiveStalls} re-arm attempts — forcing stop+restart with new generation`,
                    { ageMs: age, connectionId, attempts: consecutiveStalls },
                  )
                } catch {
                  /* best-effort */
                }
                // Break the lock pre-emptively so the restart can
                // acquire a fresh slot without waiting for the TTL.
                try {
                  await forceBreakProgressionLock(connectionId)
                } catch {
                  /* TTL will reclaim */
                }
                // Stop + restart sequentially. The mutex above
                // prevents this whole block from running concurrently
                // for the same connection.
                try {
                  await this.stopEngine(connectionId)
                } catch (stopErr) {
                  console.warn(
                    `[v0] [Watchdog] force stop threw for ${connectionId}:`,
                    stopErr instanceof Error ? stopErr.message : String(stopErr),
                  )
                }
                try {
                  await this.startEngineFromConnectionConfig(connectionId)
                } catch (startErr) {
                  console.error(
                    `[v0] [Watchdog] force restart failed for ${connectionId}:`,
                    startErr instanceof Error ? startErr.message : String(startErr),
                  )
                } finally {
                  // Mutex MUST always be released, even on failure,
                  // so the next health-check tick can retry.
                  this.escalatingEngines.delete(connectionId)
                }
              }
            } else {
              // Healthy heartbeat — clear any in-flight escalation
              // counter so a future stall starts from scratch at
              // tier 1 instead of immediately escalating.
              if (this.stallEscalation.has(connectionId)) {
                this.stallEscalation.delete(connectionId)
              }
            }
          } catch (perEngineError) {
            // One bad engine read must not break the whole monitor.
            console.warn(
              `[v0] [Watchdog] Read error for ${connectionId}:`,
              perEngineError instanceof Error ? perEngineError.message : String(perEngineError),
            )
          }
        }

        // -- 3. Aggregate health ------------------------------------------
        if (!this.isGloballyRunning) return
        const health = await this.getGlobalHealth()
        if (health.overall !== "healthy") {
          console.warn(`[v0] Global trade engine health: ${health.overall}`)
        }
        for (const [connectionId, component] of Object.entries(health.components)) {
          if (component.status !== "healthy") {
            console.warn(`[v0] Connection ${connectionId} is ${component.status}`)
          }
        }
      } catch (error) {
        // The monitor itself must NEVER throw out — that would silently
        // kill the timer. Catch everything and continue on the next tick.
        console.error("[v0] Global health monitoring error:", error)
      }
    }, healthCheckInterval)
    // Don't keep the process alive solely for this monitor.
    if (typeof this.healthCheckTimer.unref === "function") this.healthCheckTimer.unref()
  }

  /**
   * Check if coordinator is running
   */
  isRunning(): boolean {
    return this.isGloballyRunning
  }

  /**
   * Check if coordinator is paused
   */
  isPausedState(): boolean {
    return this.isPaused
  }

  /**
   * Get count of active engines
   */
  getActiveEngineCount(): number {
    return this.engineManagers.size
  }

  private startCoordinationMetricsTracking(): void {
    if (this.coordinationMetricsTimer) {
      // Idempotent: don't replace an already-armed timer. (Previous
      // behaviour cleared and re-armed, which on rapid re-init could leak
      // listeners through the inner `getAllEnginesStatus` import chain.)
      return
    }
    const metricsInterval = 60000 // Update every 60 seconds

    this.coordinationMetricsTimer = setInterval(async () => {
      try {
        const allStatus = await this.getAllEnginesStatus()

        let totalSymbols = 0
        let totalCycles = 0
        let totalDuration = 0
        let engineCount = 0

        for (const status of Object.values(allStatus)) {
          if (status.preset_symbols_processed) {
            totalSymbols += status.preset_symbols_processed
            totalCycles += status.preset_cycle_count || 0
            totalDuration += status.preset_avg_duration_ms || 0
            engineCount++
          }
        }

        this.coordinationMetrics = {
          totalSymbolsProcessed: totalSymbols,
          totalCycles: totalCycles,
          avgCycleDuration: engineCount > 0 ? totalDuration / engineCount : 0,
          lastMetricsUpdate: new Date(),
        }

        console.log(
          `[v0] Coordination Metrics: ${totalSymbols} symbols, ${totalCycles} cycles, ${Math.round(this.coordinationMetrics.avgCycleDuration)}ms avg`,
        )
      } catch (error) {
        console.error("[v0] Coordination metrics tracking error:", error)
      }
    }, metricsInterval)
    // Don't keep the process alive solely for this metrics timer.
    if (typeof this.coordinationMetricsTimer.unref === "function") this.coordinationMetricsTimer.unref()
  }

  /**
   * Get coordination metrics
   */
  getCoordinationMetrics() {
    return { ...this.coordinationMetrics }
  }
}

/**
 * The global trade engine coordinator singleton instance
 *
 * STABILITY: This module used to "aggressively clean up" on version-change
 * by clearing every registered engine timer AND calling `manager.stop()` on
 * every running engine AND clearing the singleton. That ran on every HMR
 * reload, every serverless warm-restart, and every redeploy — which is
 * exactly what produced the "engines auto-restart for no reason / no-sense
 * reassignments / GlobalTradeCoordinator stops itself" symptom.
 *
 * The coordinator is supposed to be a SOLID overall state holder. We now
 * only log a soft diagnostic on version change and preserve every live
 * engine across module reloads. Real cleanup remains the job of explicit
 * `coordinator.stopEngine()` / `coordinator.stopAll()` calls.
 */
const engineGlobalThis = globalThis as unknown as {
  __tradeEngineCoordinator?: GlobalTradeEngineCoordinator
  __tradeEngineVersion?: string
  __engine_timers?: Set<ReturnType<typeof setInterval>>
}

const TRADE_ENGINE_VERSION = "5.2.0"

if (engineGlobalThis.__tradeEngineVersion && engineGlobalThis.__tradeEngineVersion !== TRADE_ENGINE_VERSION) {
  // Soft diagnostic only. NO timer clear, NO manager.stop(), NO singleton reset.
  console.log(
    `[v0] Trade Engine version ${engineGlobalThis.__tradeEngineVersion} -> ${TRADE_ENGINE_VERSION} ` +
      `(keeping ${engineGlobalThis.__engine_timers?.size ?? 0} live timers and ` +
      `${engineGlobalThis.__tradeEngineCoordinator ? "existing" : "no"} coordinator)`,
  )
}
engineGlobalThis.__tradeEngineVersion = TRADE_ENGINE_VERSION
let globalCoordinator: GlobalTradeEngineCoordinator | null = engineGlobalThis.__tradeEngineCoordinator || null

// ── Coordinator singleton lock (prevents concurrent initialization race) ──
// If two requests call getGlobalTradeEngineCoordinator() simultaneously,
// the double-check-lock pattern (check + assign under critical section)
// ensures only one constructor runs, avoiding duplicate instances.
let _coordinatorInitLock = false

console.log(`[v0] Global Trade Engine V${TRADE_ENGINE_VERSION} loaded`)

/**
 * Get the global trade engine coordinator singleton instance
 * @returns The GlobalTradeEngineCoordinator instance or null if not initialized
 */
export function getTradeEngine(): GlobalTradeEngineCoordinator | null {
  return globalCoordinator
}

/**
 * Initialize the global trade engine coordinator
 * This should be called once during application startup
 */
export function initializeGlobalCoordinator(): GlobalTradeEngineCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new GlobalTradeEngineCoordinator()
    engineGlobalThis.__tradeEngineCoordinator = globalCoordinator
    console.log("[v0] Global trade engine coordinator initialized")
  }
  return globalCoordinator
}

export function getGlobalCoordinator(): GlobalTradeEngineCoordinator | null {
  return globalCoordinator
}

export function getGlobalTradeEngineCoordinator(): GlobalTradeEngineCoordinator {
  // ── Double-check lock pattern (prevents concurrent initialization) ──
  // First check: fast path when already initialized (no lock overhead).
  // Second check (after acquiring lock): prevents duplicate construction
  // if two concurrent requests entered the first-check window.
  if (!globalCoordinator) {
    // Acquire lock to prevent concurrent initialization.
    if (!_coordinatorInitLock) {
      _coordinatorInitLock = true
      try {
        // Second check: another request may have initialized while we waited.
        if (!globalCoordinator) {
          globalCoordinator = new GlobalTradeEngineCoordinator()
          engineGlobalThis.__tradeEngineCoordinator = globalCoordinator
          console.log("[v0] Global trade engine coordinator auto-initialized")
        }
      } finally {
        _coordinatorInitLock = false
      }
    } else {
      // We can only reach here if the constructor RE-ENTERED this getter while
      // still running (the lock is held but `globalCoordinator` isn't assigned
      // yet). Node is single-threaded and the lock's critical section is fully
      // synchronous (no await between `new` and the assignment), so a true
      // concurrent caller is impossible — a spin-wait could never make progress
      // and the previous code returned an UNASSIGNED orphan coordinator (its own
      // duplicate timers, invisible to getGlobalCoordinator()), which could
      // drive wrong start/stop decisions and instability.
      //
      // Construct-and-ASSIGN so the singleton is never orphaned. If the
      // in-progress constructor later finishes, last-assignment-wins still
      // leaves a single valid, globally-visible coordinator.
      if (!globalCoordinator) {
        console.warn("[v0] Coordinator getter re-entered during init; assigning singleton now")
        globalCoordinator = new GlobalTradeEngineCoordinator()
        engineGlobalThis.__tradeEngineCoordinator = globalCoordinator
      }
    }
  }
  return globalCoordinator
}

export async function getTradeEngineStatus(connectionId: string): Promise<any | null> {
  if (!globalCoordinator) {
    console.log("[v0] No global coordinator initialized yet")
    return null
  }

  return globalCoordinator.getEngineStatus(connectionId)
}

export function initializeTradeEngine(): GlobalTradeEngineCoordinator {
  return initializeGlobalCoordinator()
}

export type TradeEngineInterface = GlobalTradeEngineCoordinator
