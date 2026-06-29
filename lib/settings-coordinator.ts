import { initRedis, getSettings, setSettings, getConnection, getRedisClient } from "@/lib/redis-db"

/**
 * Settings Coordinator
 * 
 * Manages the propagation of settings changes to running engines.
 * When a connection's settings are updated, this module:
 * 1. Writes a change event to Redis so engines know to reload
 * 2. Determines if the change requires an engine restart vs hot reload
 * 3. Provides a polling mechanism for engines to detect changes
 */

// Fields that require a full engine restart when changed
const RESTART_REQUIRED_FIELDS = [
  "api_key", "api_secret", "exchange", "is_testnet",
  "api_type", "api_subtype", "is_enabled", "progression_epoch",
  "api_type", "api_subtype", "is_enabled",
  // Browser/dialog saves must not stop or restart a live engine. Symbol and
  // mode changes are handled by the hot-reload path, which invalidates symbol
  // caches, refreshes per-cycle settings, and lets progression recoordination
  // update Redis state without tearing down live trade.
]

// Fields that can be hot-reloaded without restart
const HOT_RELOAD_FIELDS = [
  "name", "volume_factor", "margin_type", "position_mode",
  "connection_settings", "strategies", "indications",
  "active_indications", "preset_type",
  "symbols", "active_symbols", "force_symbols", "symbol_count", "symbol_order",
  "is_live_trade", "is_preset_trade", "connection_method",
  "live_volume_factor", "preset_volume_factor", "volume_factor_live",
  "volume_factor_preset", "volume_step_ratio",
]

export type ChangeType = "restart" | "reload" | "cosmetic"

export interface SettingsChangeEvent {
  connectionId: string
  changedFields: string[]
  changeType: ChangeType
  timestamp: string
  previousValues?: Record<string, unknown>
  newValues?: Record<string, unknown>
}

async function clearEngineRestartFlags(connectionId: string): Promise<void> {
  try {
    const client = getRedisClient()
    if (!client) return
    await Promise.all([
      client.hdel(
        `settings:trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
      ).catch(() => 0),
      client.hdel(
        `trade_engine_state:${connectionId}`,
        "restart_required",
        "restart_reason",
        "restart_requested_at",
      ).catch(() => 0),
    ])
  } catch {
    /* non-critical: stale restart flags should never block a settings save */
  }
}

/**
 * Determine the type of change based on which fields were modified
 */
export function classifyChange(changedFields: string[]): ChangeType {
  if (changedFields.some(f => RESTART_REQUIRED_FIELDS.includes(f))) {
    return "restart"
  }
  if (changedFields.some(f => HOT_RELOAD_FIELDS.includes(f))) {
    return "reload"
  }
  return "cosmetic"
}

/**
 * Notify the system that a connection's settings have changed.
 * Writes a change event to Redis that running engines can detect.
 */
export async function notifySettingsChanged(
  connectionId: string,
  changedFields: string[],
  previousValues?: Record<string, unknown>,
  newValues?: Record<string, unknown>
): Promise<SettingsChangeEvent> {
  await initRedis()
  
  const changeType = classifyChange(changedFields)
  const event: SettingsChangeEvent = {
    connectionId,
    changedFields,
    changeType,
    timestamp: new Date().toISOString(),
    previousValues,
    newValues,
  }

  // Write both durable signals before the API handler returns success:
  // 1. `settings_change:{id}` is the reload/restart envelope consumed by
  //    engine-owning processes (possibly in a different worker).
  // 2. `settings:dirty:{id}` is the low-latency dirty flag consumed by
  //    processor-level caches. It is intentionally mandatory: a settings
  //    PATCH response must not report success until both signals are persisted.
  await setSettings(`settings_change:${connectionId}`, event)
  await setSettings(`settings:dirty:${connectionId}`, "1")
  
  // Increment a global change counter for this connection
  const counter = await getSettings(`settings_change_counter:${connectionId}`)
  const newCounter = (Number(counter) || 0) + 1
  await setSettings(`settings_change_counter:${connectionId}`, String(newCounter))

  console.log(`[v0] [SettingsCoordinator] Change event for ${connectionId}: type=${changeType}, fields=[${changedFields.join(",")}]`)

  // If restart required, update engine state to signal restart needed
  if (changeType === "restart") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      await setSettings(`trade_engine_state:${connectionId}`, {
        ...engineState,
        restart_required: true,
        restart_reason: `Settings changed: ${changedFields.join(", ")}`,
        restart_requested_at: new Date().toISOString(),
      })
      console.log(`[v0] [SettingsCoordinator] Engine restart flagged for ${connectionId}`)
    }
  }

  // If hot-reload, update engine state to signal reload needed without
  // clearing progression counters or stopping the global coordinator.
  if (changeType === "reload") {
    const engineState = await getSettings(`trade_engine_state:${connectionId}`)
    if (engineState && (engineState.status === "running" || engineState.status === "ready")) {
      await clearEngineRestartFlags(connectionId)
      await setSettings(`trade_engine_state:${connectionId}`, {
        ...engineState,
        restart_required: undefined,
        restart_reason: undefined,
        restart_requested_at: undefined,
        reload_required: true,
        reload_fields: changedFields,
        reload_requested_at: new Date().toISOString(),
      })
      // Keep progression/stat counters intact on hot reload. Operators expect
      // settings-dialog saves to update the next cycle in-place; resetting the
      // canonical progression hash here made dashboard stats disappear and looked
      // like the global coordinator had stopped. Stamp only an audit timestamp.
      try {
        const client = getRedisClient()
        if (client) {
          await client.hset(`progression:${connectionId}`, {
            settings_changed_at: new Date().toISOString(),
          })
        }
      } catch { /* non-critical */ }
      console.log(`[v0] [SettingsCoordinator] Engine hot-reload flagged for ${connectionId}`)
    }
  }

  return event
}

/**
 * Check if a connection has pending settings changes that the engine hasn't processed yet.
 */
export async function getPendingChanges(connectionId: string): Promise<SettingsChangeEvent | null> {
  await initRedis()
  const event = await getSettings(`settings_change:${connectionId}`)
  return event as SettingsChangeEvent | null
}

/**
 * Clear pending changes after the engine has processed them.
 */
export async function clearPendingChanges(connectionId: string): Promise<void> {
  await initRedis()
  await setSettings(`settings_change:${connectionId}`, null)
  
  // Also clear restart/reload flags from engine state
  const engineState = await getSettings(`trade_engine_state:${connectionId}`)
  if (engineState) {
    const cleaned = { ...engineState }
    delete cleaned.restart_required
    delete cleaned.restart_reason
    delete cleaned.restart_requested_at
    delete cleaned.reload_required
    delete cleaned.reload_fields
    delete cleaned.reload_requested_at
    await setSettings(`trade_engine_state:${connectionId}`, cleaned)
  }
}

/**
 * Get the change counter for a connection (engines can poll this).
 */
export async function getChangeCounter(connectionId: string): Promise<number> {
  await initRedis()
  const counter = await getSettings(`settings_change_counter:${connectionId}`)
  return Number(counter) || 0
}

/**
 * Compute which fields changed between two connection objects.
 * Handles nested fields like force_symbols within connection_settings.
 */
export function detectChangedFields(
  previous: Record<string, unknown>,
  updated: Record<string, unknown>
): string[] {
  const changed: string[] = []
  const allKeys = new Set([...Object.keys(previous), ...Object.keys(updated)])
  
  for (const key of allKeys) {
    if (key === "updated_at" || key === "created_at") continue
    const prevVal = JSON.stringify(previous[key])
    const newVal = JSON.stringify(updated[key])
    if (prevVal !== newVal) {
      changed.push(key)
    }
  }
  
  // ── Symbol count changes need special handling ──────────────────────
  // force_symbols is nested within connection_settings, so a change to it
  // won't appear in the top-level allKeys. Compare symbol counts explicitly:
  // if they differ, it's a progression-level change (not just strategy reload).
  const prevSymbols = previous.force_symbols as string[] | undefined || []
  const updatedSymbols = updated.force_symbols as string[] | undefined || []
  if ((prevSymbols || []).length !== (updatedSymbols || []).length) {
    changed.push("symbol_count")  // Mark as a distinct "symbol count changed" signal
  }
  
  return changed
}
