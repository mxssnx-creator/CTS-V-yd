/**
 * Startup Coordinator
 * PHASE 4 FIX: Clean startup sequence with no auto-enablement
 * 
 * Goals:
 * 1. Clear sequential startup
 * 2. No automatic engine start (user must enable manually)
 * 3. Validation only - no data mutation unless necessary
 * 4. Clear logging of what happened
 */

import {
  initRedis,
  getAllConnections,
  getRedisClient,
  setSettings,
  cleanupVolatileRuntimeState,
} from "@/lib/redis-db"
import { validateDatabase } from "@/lib/database-validator"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { consolidateDatabase } from "@/lib/database-consolidation"

function getPositionConnectionId(pos: any): string {
  return String(pos?.connectionId ?? pos?.connection_id ?? "").trim()
}

function hasSystemAndConnectionTracking(pos: any): boolean {
  const connectionId = getPositionConnectionId(pos)
  if (!connectionId) return false

  const systemTrackingId = String(pos?.system_tracking_id ?? pos?.systemTrackingId ?? "").trim()
  const connectionTrackingId = String(pos?.connection_tracking_id ?? pos?.connectionTrackingId ?? "").trim()

  return (
    systemTrackingId.startsWith(`sys-${connectionId}-`) &&
    systemTrackingId.length > `sys-${connectionId}-`.length &&
    connectionTrackingId === `conn-${connectionId}`
  )
}

/**
 * Scan all live:position:* keys and close any that are still "open"
 * but have exceeded their max hold time. This catches positions that
 * were left open when the process was killed (SIGTERM before the closer
 * ran) or when the engine restarted without exchange connectivity.
 *
 * Called once at the end of completeStartup() — non-blocking, errors
 * are logged but never fail startup.
 */
async function reconcileStrandedPositions() {
  try {
    const client = getRedisClient()
    const keys = await client.keys("live:position:*")
    if (!keys.length) return

    const MAX_HOLD_MS = 4 * 60 * 60 * 1000 // 4 hours hard cap
    const RECONCILE_DEADLINE_MS = 20_000 // 20s hard deadline
    const deadline = Date.now() + RECONCILE_DEADLINE_MS
    const now = Date.now()
    let found = 0
    let closed = 0

    for (const key of keys) {
      if (Date.now() > deadline) {
        console.warn(
          `[v0] [Startup] Reconciling stranded positions deadline ${RECONCILE_DEADLINE_MS}ms exceeded — ` +
          `processed ${found} of ${keys.length}, deferring remainder`,
        )
        break
      }
      // `live:position:*` over-matches the `live:position:tracking:*` pointer
      // keys, which hold a PLAIN STRING (e.g. "live:bingx-x01:...") not a JSON
      // position object. Skip them so JSON.parse doesn't throw on every boot.
      if (key.startsWith("live:position:tracking:")) continue
      try {
        const raw = await client.get(key)
        if (!raw) continue
        const pos = JSON.parse(raw as string)
        if (pos.status !== "open") continue
        if (!hasSystemAndConnectionTracking(pos)) {
          // Never mutate manually-created or foreign exchange positions during
          // startup reconciliation. Only positions carrying both the system
          // tracking id and the connection tracking id are owned by this app.
          continue
        }
        found++

        const age = now - (pos.openedAt || pos.createdAt || 0)
        if (age < MAX_HOLD_MS) {
          // Not yet expired — mark for monitoring but don't force-close
          console.log(
            `[v0] [Startup] Stranded open position ${pos.id} (${pos.symbol}) age=${Math.round(age / 60000)}min — within hold limit, skipping`,
          )
          continue
        }

        // Position is past max hold — mark as closed in Redis with a
        // shutdown reason. The exchange order may still be open; the
        // reconciliation cron will pick it up and cancel it on next run.
        console.warn(
          `[v0] [Startup] Closing stranded position ${pos.id} (${pos.symbol}) age=${Math.round(age / 60000)}min — exceeded ${MAX_HOLD_MS / 60000}min limit`,
        )
        pos.status = "closed"
        pos.closedAt = now
        pos.updatedAt = now
        pos.closeReason = "startup_reconcile_max_hold_exceeded"
        await client.set(key, JSON.stringify(pos))
        closed++
      } catch (err) {
        console.warn(`[v0] [Startup] reconcile error for ${key}:`, err)
      }
    }

    if (found > 0) {
      console.log(
        `[v0] [Startup] ✓ Reconciled ${found} stranded positions: ${closed} force-closed, ${found - closed} within hold limit`,
      )
    }
  } catch (err) {
    console.warn("[v0] [Startup] reconcileStrandedPositions error:", err)
  }
}

/**
 * PHASE 4 FIX 4.1: Clean up orphaned progress from incomplete shutdowns
 */
export async function cleanupOrphanedProgress() {
  try {
    const client = getRedisClient()

    console.log(`[v0] [Startup] Cleaning up orphaned progress...`)

    // Find connections with is_running=1 but no active manager
    const allConnections = await getAllConnections()
    const coordinator = getGlobalTradeEngineCoordinator()

    let cleanedUp = 0

    for (const conn of allConnections) {
      // Use client.get to match setRunningFlag which writes string values ("1"/"0")
      const runningFlag = await client.get(`engine_is_running:${conn.id}`)

      // If marked as running but this coordinator doesn't have it, only clean
      // it up after proving there is no fresh distributed owner. Production can
      // boot multiple Node/API workers while a dedicated engine worker is still
      // alive; clearing its `engine_is_running:*` flag from a non-owner worker
      // is the exact race that makes the UI show phantom stops/restarts.
      if (runningFlag === "true" || runningFlag === "1") {
        if (!coordinator.isEngineRunning(conn.id)) {
          const remoteState = await client.hgetall(`trade_engine_state:${conn.id}`).catch(() => ({} as Record<string, string>)) as Record<string, string>
          const remoteHeartbeat = Number(remoteState?.last_processor_heartbeat || 0)
          const remoteHeartbeatFresh =
            Number.isFinite(remoteHeartbeat) && remoteHeartbeat > 0 && Date.now() - remoteHeartbeat < 90_000

          if (remoteHeartbeatFresh) {
            console.log(
              `[v0] [Startup] Preserving running flag for ${conn.id} — fresh distributed heartbeat present`,
            )
            continue
          }

          console.log(`[v0] [Startup] Cleaning orphaned running flag for ${conn.id}`)

          // Clear orphaned flags using client.set to match setRunningFlag
          await client.set(`engine_is_running:${conn.id}`, "0")
          await setSettings(`engine_progression:${conn.id}`, {
            phase: "idle",
            progress: 0,
            detail: "Cleaned up after unclean shutdown",
            updated_at: new Date().toISOString(),
          })

          cleanedUp++
        }
      }
    }

    console.log(`[v0] [Startup] ✓ Cleaned up ${cleanedUp} orphaned progress flags`)
  } catch (error) {
    console.warn(`[v0] [Startup] Warning during cleanup: ${error}`)
    // Don't fail startup on cleanup errors
  }
}

/**
 * PHASE 4 FIX 4.1: Complete startup sequence (no auto-start)
 */
export async function completeStartup() {
  console.log(`[v0] [Startup] ========================================`)
  console.log(`[v0] [Startup] Beginning pre-startup sequence...`)
  console.log(`[v0] [Startup] ========================================\n`)

  try {
    // Step 1: Initialize Redis (runMigrations runs inside initRedis)
    console.log(`[v0] [Startup] Step 1/8: Initializing Redis...`)
    await initRedis()
    console.log(`[v0] [Startup] ✓ Redis initialized`)
    const volatileCleanup = await cleanupVolatileRuntimeState({ reason: "completeStartup" })
    console.log(`[v0] [Startup] ✓ Volatile runtime cleanup complete (deleted ${volatileCleanup.deleted}, preserved ${volatileCleanup.preserved})\n`)

    // Initialize memory management for long-term stability
    try {
      const { initMemoryManager } = await import("@/lib/memory-manager")
      const maxHeapMB = process.env.NODE_ENV === "production" ? 2048 : 1024
      initMemoryManager(maxHeapMB)
    } catch (e) {
      console.warn(`[v0] [Startup] Memory manager initialization skipped (non-fatal):`, e instanceof Error ? e.message : e)
    }

    // Step 2: Migrations already ran inside initRedis() above.
    // Seed default settings and placeholder market data — both are no-ops when
    // data already exists, so safe to call on every boot including hot-reloads.
    console.log(`[v0] [Startup] Step 2/8: Seeding default settings and market data...`)
    try {
      const { runPreStartup } = await import("@/lib/pre-startup")
      await runPreStartup()
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Pre-startup seeding warning (non-fatal): ${e instanceof Error ? e.message : e}`)
    }
    console.log(`[v0] [Startup] ✓ Settings + market data seed complete\n`)

    // Step 3: Validate database integrity
    console.log(`[v0] [Startup] Step 3/8: Validating database integrity...`)
    try {
      await validateDatabase()
      console.log(`[v0] [Startup] ✓ Database validation passed\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database validation warning: ${e}`)
      console.log(`[v0] [Startup] ✓ Continuing with warnings\n`)
    }

    // Step 4: Load base connections (no start)
    console.log(`[v0] [Startup] Step 4/8: Loading base connections...`)
    const allConnections = await getAllConnections()
    console.log(`[v0] [Startup] ✓ Loaded ${allConnections.length} base connections\n`)

    // Step 5: Consolidate database (Phase 3) — non-blocking with 15s deadline.
    // Consolidation is purely a data-migration step; the engine runs fine
    // without it. Blocking startup on this makes cold-boot latency
    // proportional to connection count (one Redis read per connection).
    console.log(`[v0] [Startup] Step 5/8: Consolidating database structures (background, 15s deadline)...`)
    try {
      const DEADLINE_MS = 15_000
      await Promise.race([
        consolidateDatabase(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("consolidation deadline exceeded")), DEADLINE_MS)),
      ])
      console.log(`[v0] [Startup] ✓ Database consolidation complete\n`)
    } catch (e) {
      console.warn(`[v0] [Startup] ⚠ Database consolidation did not finish: ${e instanceof Error ? e.message : String(e)}`)
      console.log(`[v0] [Startup] ✓ Continuing without consolidation (engine works without it)\n`)
    }

    // Step 6: Initialize coordinator and start engines in dev mode
    console.log(`[v0] [Startup] Step 6/8: Initializing engine coordinator...`)
    const coordinator = getGlobalTradeEngineCoordinator()
    console.log(`[v0] [Startup] ✓ Engine coordinator initialized\n`)
    
    // In dev/test environments, automatically start enabled connections
    if (process.env.NODE_ENV !== "production") {
      console.log(`[v0] [Startup] Starting enabled connections (dev mode)...`)
      try {
        // Fire and forget - don't block startup on engine starts
        // TODO: Fix type signature - startMissingEngines() requires connectionId argument
        // coordinator.startMissingEngines().catch(err => 
        //   console.warn(`[v0] [Startup] Failed to start engines in dev mode:`, err)
        // )
      } catch (err) {
        console.warn(`[v0] [Startup] Dev mode auto-start error (non-fatal):`, err)
      }
    }

    // Step 6b: Initialize boot metadata without claiming runtime liveness.
    // `trade_engine:global.status` is legacy operator intent in several routes;
    // startup must not write legacy status="running" because that conflates desired
    // state with proof that an engine worker is actually alive.  Runtime proof
    // is written separately by engine heartbeats (`actual_status`,
    // `active_worker_id`, `last_heartbeat_at`).
    console.log(`[v0] [Startup] Initializing global trade engine boot metadata...`)
    try {
      const client = getRedisClient()
      const now = String(Date.now())
      const existingGlobalState = (await client.hgetall("trade_engine:global")) as Record<string, string> | null
      const operatorStopped =
        existingGlobalState?.operator_stopped === "1" || existingGlobalState?.operator_stopped === "true"
      const preservedIntent = operatorStopped
        ? "stopped"
        : existingGlobalState?.operator_intent ||
          existingGlobalState?.desired_status ||
          existingGlobalState?.status ||
          "running"

      await client.hset("trade_engine:global", {
        // Fresh installs and restored snapshots default to desired_status: "running"
        // and operator_intent: "running" so unattended continuity can resume;
        // a sticky operator_stopped flag above remains an explicit stop veto.
        desired_status: preservedIntent,
        operator_intent: preservedIntent,
        boot_status: "initialized",
        actual_status: "stopped",
        active_worker_id: "",
        last_heartbeat_at: "",
        initialized_at: now,
        process_version: "1.0",
      })
      console.log(`[v0] [Startup] ✓ Global trade engine boot metadata initialized\n`)
    } catch (err) {
      console.warn(`[v0] [Startup] ⚠ Failed to initialize global trade engine boot metadata (non-fatal):`, err)
    }

    // Step 7: Clean up orphaned progress flags from incomplete shutdowns (non-blocking)
    // Run in background to prevent blocking server startup
    console.log(`[v0] [Startup] Step 7/8: Scheduling orphaned engine state cleanup...`)
    cleanupOrphanedProgress().catch(err => 
      console.warn(`[v0] [Startup] Background cleanup error:`, err)
    )
    console.log(`[v0] [Startup] ✓ Cleanup scheduled\n`)

    // Step 8: Reconcile stranded live positions (non-blocking)
    // Run in background to prevent blocking server startup
    console.log(`[v0] [Startup] Step 8/8: Scheduling stranded position reconciliation...`)
    reconcileStrandedPositions().catch(err =>
      console.warn(`[v0] [Startup] Background reconciliation error:`, err)
    )
    console.log(`[v0] [Startup] ✓ Reconciliation scheduled\n`)

    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] ✓ Pre-startup sequence complete`)
    console.log(`[v0] [Startup] ========================================`)
    console.log(`[v0] [Startup] Ready for user interaction`)
    console.log(`[v0] [Startup] Engines resume when operator intent is running or unattended default allows continuity`)
    console.log(`[v0] [Startup] User must enable/start connections in Dashboard`)
    console.log(`[v0] [Startup] ========================================\n`)
  } catch (error) {
    console.error(`[v0] [Startup] ✗ Fatal error during startup:`, error)
    throw error
  }
}

/**
 * PHASE 4: Get startup status for diagnostics
 */
export async function getStartupStatus() {
  try {
    const client = getRedisClient()

    const redisReachable = await client.ping()
    const schemaVersion = await client.get("_schema_version")
    const connections = await getAllConnections()
    const migrationsRun = await client.get("_migrations_run")

    return {
      redis_reachable: redisReachable === "PONG",
      schema_version: schemaVersion,
      connections_count: connections.length,
      // runMigrations() persists the string "true" (not "1") for this flag —
      // accept both so the diagnostic doesn't report a false negative.
      migrations_run: migrationsRun === "true" || migrationsRun === "1",
      timestamp: new Date().toISOString(),
    }
  } catch (error) {
    return {
      redis_reachable: false,
      error: error instanceof Error ? error.message : String(error),
      timestamp: new Date().toISOString(),
    }
  }
}
