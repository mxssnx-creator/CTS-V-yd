import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, updateConnection, setSettings, getSettings, getAllConnections, getRedisClient } from "@/lib/redis-db"
import { getConnectionState, buildMainConnectionEnableUpdate, buildMainConnectionDisableUpdate, buildMainConnectionRemoveUpdate, isConnectionReadyForEngine } from "@/lib/connection-state-helpers"
import { toggleConnectionLimiter } from "@/lib/connection-rate-limiter"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { isTruthyFlag, parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { currentStateSwitchVersion, nextStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"
import { buildMissingTradeEngineWorkerDiagnostic } from "@/lib/trade-engine-worker-heartbeat"

// POST toggle connection active status (inserted/enabled) - INDEPENDENT from Settings
// When enabling, also triggers engine start for this connection
export const dynamic = "force-dynamic"
export const maxDuration = 15

async function queueCoordinatorRefresh(connectionId: string, action: "start" | "stop", reason: string, stateSwitchVersion?: string) {
  const payload = {
    timestamp: new Date().toISOString(),
    connectionId,
    action,
    reason,
    state_switch_version: stateSwitchVersion || null,
  }
  await Promise.all([
    setSettings("engine_coordinator:refresh_requested", payload),
    setSettings(`engine_coordinator:refresh_requested:${connectionId}`, payload),
  ])
}
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const connectionId = id
    const body = await request.json()
    
    // Check rate limit using systemwide limiter
    const limitResult = await toggleConnectionLimiter.checkLimit(connectionId)
    
    if (!limitResult.allowed) {
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum 30 toggle requests per minute. Retry after ${limitResult.retryAfter} seconds.`,
          retryAfter: limitResult.retryAfter,
          resetTime: limitResult.resetTime,
        },
        { status: 429, headers: { "Retry-After": String(limitResult.retryAfter) } }
      )
    }
    
    // Support active fields:
    // - is_active_inserted: whether connection appears in active list
    // - is_enabled_dashboard: whether connection is enabled/active
    // - enabled: plain alias for is_enabled_dashboard (previously ignored,
    //   which made {"enabled":false} silently fall through to current state)
    const hasActiveInserted = body?.is_active_inserted !== undefined
    const hasDashboardEnabled = body?.is_enabled_dashboard !== undefined || body?.enabled !== undefined
    const isActiveInserted = parseBooleanInput(body?.is_active_inserted)
    const isDashboardEnabled = body?.is_enabled_dashboard !== undefined
      ? parseBooleanInput(body?.is_enabled_dashboard)
      : parseBooleanInput(body?.enabled)

    await initRedis()
    let connection = await getConnection(connectionId)
    let resolvedId = connectionId

    // Fallback: try with conn- prefix if not found (handles predefined IDs like bybit-x03 → conn-bybit-x03)
    if (!connection && !connectionId.startsWith("conn-")) {
      const prefixedId = `conn-${connectionId}`
      console.log(`[v0] [Toggle] Not found with id=${connectionId}, trying conn- prefix: ${prefixedId}`)
      connection = await getConnection(prefixedId)
      if (connection) {
        resolvedId = prefixedId
        console.log(`[v0] [Toggle] Resolved to: ${resolvedId}`)
      }
    }

    if (!connection) {
      console.log(`[v0] [Toggle] Connection not found: ${connectionId} (also tried conn-${connectionId})`)
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Get clean connection state
    const state = getConnectionState(connection)
    console.log(`[v0] [Toggle] Toggling ${connection.name} (${connectionId}):`)
    console.log(`[v0] [Toggle]   Before: main_assigned=${state.main_assigned}, main_enabled=${state.main_enabled}`)
    
    // Determine new state based on request
    // If is_active_inserted is explicitly set to false, treat as removal (unassign completely)
    const isRemoval = hasActiveInserted && !isActiveInserted
    const enableMain = isRemoval ? false : (hasDashboardEnabled ? isDashboardEnabled : (hasActiveInserted ? isActiveInserted : state.main_enabled))

    // Check if state actually changes
    const currentMainEnabled = state.main_enabled
    const currentMainAssigned = state.main_assigned
    const needsUpdate = currentMainEnabled !== enableMain || (isRemoval && currentMainAssigned)
    
    let updatedConnection: any
    let engineAction: "start" | "stop" | null = null
    
    let stateSwitchVersion = currentStateSwitchVersion(connection)
    if (needsUpdate) {
      if (isRemoval) {
        // Remove from Main Connections completely - unassign
        stateSwitchVersion = nextStateSwitchVersion(connection)
        updatedConnection = { ...buildMainConnectionRemoveUpdate(connection), state_switch_version: stateSwitchVersion }
        engineAction = "stop"
        console.log(`[v0] [Toggle] REMOVING: main_assigned=false, main_enabled=false (complete unassignment)`)
      } else if (enableMain) {
        // Enable in Main Connections - use clean helper
        stateSwitchVersion = nextStateSwitchVersion(connection)
        updatedConnection = { ...buildMainConnectionEnableUpdate(connection), state_switch_version: stateSwitchVersion }
        engineAction = "start"
        console.log(`[v0] [Toggle] ENABLING: main_assigned=true, main_enabled=true (engine will process)`)
      } else {
        // Disable in Main Connections - use clean helper  
        stateSwitchVersion = nextStateSwitchVersion(connection)
        updatedConnection = { ...buildMainConnectionDisableUpdate(connection), state_switch_version: stateSwitchVersion }
        engineAction = "stop"
        console.log(`[v0] [Toggle] DISABLING: main_enabled=false (engine will stop)`)
      }
    } else {
      // No state change.
      // AUTO-START DISABLED: this branch previously auto-started the engine
      // whenever the connection was enabled but its engine was not running —
      // meaning ANY request to this endpoint (dashboard polls, stray calls,
      // bodies without recognized fields) silently resurrected the engine
      // after an operator stop. Now the engine starts ONLY when the request
      // EXPLICITLY asks for enabled=true (hasDashboardEnabled/hasActiveInserted)
      // — i.e. a real user toggle, not a no-op repeat.
      updatedConnection = connection
      const explicitlyRequestedEnable =
        (hasDashboardEnabled && isDashboardEnabled) || (hasActiveInserted && isActiveInserted)
      if (enableMain && explicitlyRequestedEnable) {
        const coordinator = getGlobalTradeEngineCoordinator()
        if (!coordinator.isEngineRunning(resolvedId)) {
          // Anti-burst guard (2 s) absorbs accidental double-clicks.
          const cooldownKey = `engine_restart_cooldown:${resolvedId}`
          const cooldownClient = getRedisClient()
          const lastRestartRaw = await cooldownClient.get(cooldownKey).catch(() => null)
          const lastRestartMs = Number(lastRestartRaw)
          const RESTART_COOLDOWN_MS = 2_000
          if (Number.isFinite(lastRestartMs) && Date.now() - lastRestartMs < RESTART_COOLDOWN_MS) {
            console.log(
              `[v0] [Toggle] Explicit re-enable - restart attempted ${Date.now() - lastRestartMs}ms ago; skipping (burst guard)`,
            )
          } else {
            engineAction = "start"
            try {
              await cooldownClient.set(cooldownKey, String(Date.now()), { EX: 5 })
            } catch {
              /* best-effort */
            }
            console.log(`[v0] [Toggle] Explicit re-enable - engine not running, starting...`)
          }
        } else {
          console.log(`[v0] [Toggle] Already enabled - engine already running, no restart`)
        }
      } else if (enableMain) {
        console.log(`[v0] [Toggle] Already enabled - no explicit enable in request, engine state untouched`)
      } else {
        console.log(`[v0] [Toggle] Already disabled`)
      }
    }

    // Save connection state only if state changed. Stamp a per-connection
    // switch generation so status/progression readers and coordinator workers
    // can distinguish this operator intent from stale queued start/stop work.
    if (needsUpdate && updatedConnection) {
      stateSwitchVersion = `${Date.now()}`
      updatedConnection = {
        ...updatedConnection,
        state_switch_version: stateSwitchVersion,
        state_switch_action: enableMain ? "enable" : "disable",
        state_switch_at: new Date().toISOString(),
      }
      await updateConnection(resolvedId, updatedConnection)
      await setSettings(`connection_state_switch:${resolvedId}`, {
        version: stateSwitchVersion,
        action: enableMain ? "enable" : "disable",
        updated_at: updatedConnection.state_switch_at,
      }).catch(() => undefined)
      console.log(`[v0] [Toggle] Updated ${connection.name} (resolved id: ${resolvedId})`)
    }

    // Trigger engine action based on toggle state
    let engineStatus = "unchanged"
    let engineWarning: string | null = null
    if (engineAction === "start") {
      try {
        // Log progression event for UI feedback
        await logProgressionEvent(resolvedId, "toggle_enabled", "info", "Connection enabled via dashboard toggle", {
          connectionId: resolvedId,
          connectionName: connection.name,
          exchange: connection.exchange,
        })
        
        // Check if connection has valid credentials
        const apiKey = (updatedConnection.api_key || updatedConnection.apiKey || "") as string
        const apiSecret = (updatedConnection.api_secret || updatedConnection.apiSecret || "") as string
        const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
        
        const isFirstEnable = needsUpdate && enableMain
        if (isFirstEnable) {
          await setSettings(`engine_progression:${resolvedId}`, {
            phase: "initializing",
            progress: 10,
            detail: hasCredentials 
              ? "Connection enabled - engine starting..." 
              : "Connection enabled - engine starting (credentials needed for live trading)",
            updated_at: new Date().toISOString(),
          })
        }
        
        if (!hasCredentials) {
          await logProgressionEvent(resolvedId, "engine_starting_no_credentials", "warning", 
            "Engine starting without API credentials - live trading disabled", {
              connectionId: resolvedId,
              hint: "Add API key and secret in Settings for live trading",
            })
        }
        
        // Update global engine intent first. A real explicit enable action
        // clears any stale operator stop latch and starts/reconciles the
        // process-level coordinator below.
        // clears any stale operator stop latch and then either queues the
        // dedicated coordinator worker or (only in dev/opt-in environments)
        // starts the local in-process runtime below.
        const toggleClient = getRedisClient()
        const globalState: Record<string, string> = await toggleClient.hgetall("trade_engine:global").catch(() => ({})) || {}
        const allConnections = await getAllConnections()
        // Use clean helper function for counting main-enabled connections
        const activeDashboardCount = allConnections.filter((c: any) => 
          c.id === resolvedId || isConnectionReadyForEngine(c)
        ).length
        await toggleClient.hset("trade_engine:global", {
          ...globalState,
          status: "running",
          desired_status: "running",
          operator_intent: "running",
          coordinator_ready: "true",
          operator_stopped: "0",
          operator_stopped_at: "",
          stopped_at: "",
          started_at: globalState.started_at || new Date().toISOString(),
          updated_at: new Date().toISOString(),
          active_connections: String(activeDashboardCount),
        })
        
        // Queue/reconcile by default in production so API workers stay responsive.
        // Local foreground start is reserved for non-production or explicit
        // production opt-in via ALLOW_API_TRADE_ENGINE_FOREGROUND +
        // ENABLE_TRADE_ENGINE_IN_PROCESS.
        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          const localStartAllowed =
            process.env.DISABLE_TRADE_ENGINE_IN_PROCESS !== "1" &&
            process.env.NEXT_RUNTIME !== "edge" &&
            (process.env.NODE_ENV !== "production" ||
              (process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
                process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"))

          if (localStartAllowed) {
            const settings = await loadSettingsAsync()
            const engineConfig = {
              connectionId: resolvedId,
              connection_name: connection.name,
              exchange: connection.exchange,
              engine_type: "main",
              allowInProcessStart: true,
              indicationInterval: settings.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
              strategyInterval: settings.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
              realtimeInterval: settings.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
            }
            const engineStarted = await coordinator.startEngine(resolvedId, engineConfig, { markAssigned: true, forceLocalTakeover: true })
            if (!engineStarted && !coordinator.isEngineRunning(resolvedId)) {
              throw new Error("Coordinator did not start the engine after enable; startup lock may be held by another worker")
            }
            
            console.log(`[v0] [Toggle] ✓ Engine ${engineStarted ? "started" : "already running"} directly for ${connection.name}`)
            await logProgressionEvent(resolvedId, "engine_started_direct", "info", "Main Trade Engine started directly from enable", {
              connectionId: resolvedId,
              connectionName: connection.name,
              exchange: connection.exchange,
            })
            engineStatus = "started"
          } else {
            await queueCoordinatorRefresh(resolvedId, "start", "dashboard_toggle_enable", stateSwitchVersion)
            await queueEngineRefreshRequest({
              connectionId: resolvedId,
              action: "start",
              state_switch_version: stateSwitchVersion,
              reason: "dashboard_toggle_enable",
              timestamp: new Date().toISOString(),
            })
            await logProgressionEvent(resolvedId, "engine_start_queued", "info", "Connection enabled; start queued for coordinator worker", {
              connectionId: resolvedId,
              connectionName: connection.name,
              exchange: connection.exchange,
              hint: "No local engine runtime accepted the foreground start; queued for continuity reconciliation.",
            })
            const queuedGlobalState = await toggleClient.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)) as Record<string, string>
            const workerDiagnostic = buildMissingTradeEngineWorkerDiagnostic(queuedGlobalState)
            engineWarning = workerDiagnostic.error
            engineStatus = "queued"
            console.warn(
              `[v0] [Toggle] Engine start queued for ${connection.name}; foreground start was unavailable`,
            )
          }
        } catch (engineStartError) {
          console.error(`[v0] [Toggle] Failed to start engine directly:`, engineStartError)
          // Still set the flag as fallback - coordinator may pick it up
          await queueCoordinatorRefresh(resolvedId, "start", "dashboard_toggle_enable_fallback", stateSwitchVersion)
          await queueEngineRefreshRequest({
            connectionId: resolvedId,
            action: "start",
            state_switch_version: stateSwitchVersion,
            reason: "dashboard_toggle_enable_fallback",
            timestamp: new Date().toISOString(),
          })
          const fallbackClient = getRedisClient()
          const fallbackGlobalState = await fallbackClient.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)) as Record<string, string>
          const workerDiagnostic = buildMissingTradeEngineWorkerDiagnostic(fallbackGlobalState)
          engineWarning = workerDiagnostic.error
          engineStatus = "queued"
        }
          
        console.log(`[v0] [Toggle] Engine progression initialized for ${connection.name}`)
      } catch (engineError) {
        console.error(`[v0] [Toggle] Failed to initialize engine:`, engineError)
        engineStatus = "error"
        
        await logProgressionEvent(resolvedId, "toggle_error", "error", "Failed to start engine after toggle", {
          error: engineError instanceof Error ? engineError.message : String(engineError),
        })
      }
    } else if (engineAction === "stop") {
      try {
        // Log progression event for UI feedback
        await logProgressionEvent(resolvedId, "toggle_disabled", "info", "Connection disabled via dashboard toggle", {
          connectionId: resolvedId,
          connectionName: connection.name,
        })
        
        // Update engine progression phase to show stopped
        await setSettings(`engine_progression:${resolvedId}`, {
          phase: "idle",
          progress: 0,
          detail: "Connection disabled",
          updated_at: new Date().toISOString(),
        })
        
        // Update global engine state (stored as Redis HASH)
        const disableClient = getRedisClient()
        const disableGlobalState: Record<string, string> = await disableClient.hgetall("trade_engine:global").catch(() => ({} as Record<string, string>)) || {}
        const allConnsForDisable = await getAllConnections()
        // Use clean helper function - exclude current connection
        const activeCount = allConnsForDisable.filter((c: any) => 
          c.id !== resolvedId && isConnectionReadyForEngine(c)
        ).length
        const preservedCoordinatorIntent =
          disableGlobalState?.operator_intent ||
          disableGlobalState?.desired_status ||
          disableGlobalState?.status ||
          "running"
        await disableClient.hset("trade_engine:global", {
          ...disableGlobalState,
          updated_at: new Date().toISOString(),
          active_connections: String(activeCount),
          // Disabling a single connection is a per-engine action. It must not
          // tear down or mark the Global Trade Coordinator as stopped: the
          // coordinator is the process-level supervisor and should keep running
          // so the operator can re-enable this or another connection without a
          // global restart. Only /api/trade-engine/stop owns global shutdown.
          status: disableGlobalState?.status || "running",
          desired_status: disableGlobalState?.desired_status || preservedCoordinatorIntent,
          operator_intent: disableGlobalState?.operator_intent || preservedCoordinatorIntent,
          coordinator_ready: disableGlobalState?.coordinator_ready || "true",
          operator_stopped:
            (disableGlobalState?.operator_intent || disableGlobalState?.desired_status || disableGlobalState?.status) === "running"
              ? "0"
              : disableGlobalState?.operator_stopped || "0",
        })
        
        // DIRECTLY STOP THE ENGINE - don't rely on coordinator polling
        try {
          const coordinator = getGlobalTradeEngineCoordinator()
          await coordinator.stopEngine(resolvedId, { operatorRequested: true })
          console.log(`[v0] [Toggle] ✓ Engine stopped directly for ${connection.name}`)
          await logProgressionEvent(resolvedId, "engine_stopped_direct", "info", "Main Trade Engine stopped directly from disable", {
            connectionId: resolvedId,
            connectionName: connection.name,
          })
        } catch (engineStopError) {
          console.warn(`[v0] [Toggle] Failed to stop engine directly:`, engineStopError)
          // Fallback refresh request so coordinator picks up desired stop state
          await queueCoordinatorRefresh(resolvedId, "stop", "dashboard_toggle_disable_fallback", stateSwitchVersion)
          await queueEngineRefreshRequest({
            connectionId: resolvedId,
            action: "stop",
            state_switch_version: stateSwitchVersion,
            reason: "dashboard_toggle_stop_fallback",
            timestamp: new Date().toISOString(),
          })
          await logProgressionEvent(resolvedId, "engine_stop_fallback_requested", "warning", "Direct stop failed; coordinator refresh requested", {
            connectionId: resolvedId,
            error: engineStopError instanceof Error ? engineStopError.message : String(engineStopError),
          })
        }
        
        engineStatus = "stopped"
        console.log(`[v0] [Toggle] Engine stopped for ${connection.name}`)
      } catch (engineError) {
        console.error(`[v0] [Toggle] Failed to stop engine:`, engineError)
        engineStatus = "error"
      }
    }

    const wasChange = needsUpdate || (engineAction === 'start')
    const effectiveEnabled = enableMain
    return NextResponse.json({
      success: true,
      changed: wasChange,
      action: wasChange ? (effectiveEnabled ? 'enabled' : 'disabled') : (effectiveEnabled ? 'already_enabled' : 'already_disabled'),
      connection: {
        id: resolvedId,
        name: connection.name,
        exchange: connection.exchange,
        is_active_inserted: updatedConnection.is_active_inserted,
        is_enabled_dashboard: updatedConnection.is_enabled_dashboard,
        is_enabled: updatedConnection.is_enabled,
        is_inserted: updatedConnection.is_inserted,
      },
      engine: {
        action: engineAction,
        status: engineStatus,
        warning: engineWarning,
      },
      progressionUrl: `/api/connections/progression/${resolvedId}`,
    })
  } catch (error) {
    console.error(`[v0] [Toggle] Error:`, error)
    return NextResponse.json(
      { error: "Failed to update active status", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}


// Backward compatibility: accept PUT as alias for POST
export async function PUT(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  return POST(request, context)
}
