/**
 * Connection State Management Helpers
 * Provides clean helpers for building connection update objects for Main Connections
 */

export interface ConnectionState {
  main_assigned: boolean
  main_enabled: boolean
  is_inserted: boolean
  is_enabled_dashboard: boolean
}

/**
 * Parse connection state to understand its role in Main Connections
 */
export function getConnectionState(conn: any): ConnectionState {
  // Handle boolean, string "1"/"true", and integer 1 (after numeric parseHash fix)
  const toBoolean = (val: any) => val === true || val === 1 || val === "1" || val === "true"
  
  return {
    main_assigned: toBoolean(conn.is_assigned) || toBoolean(conn.is_active_inserted),
    // main_enabled: true when either is_enabled_dashboard or is_active_inserted is set.
    // Migrations seed is_active_inserted without is_enabled_dashboard; OR keeps them equivalent.
    main_enabled: toBoolean(conn.is_enabled_dashboard) || toBoolean(conn.is_active_inserted),
    is_inserted: toBoolean(conn.is_inserted),
    is_enabled_dashboard: toBoolean(conn.is_enabled_dashboard),
  }
}

/**
 * Build update object to ENABLE a connection in Main Connections
 * - Keep is_inserted stable
 * - Set is_assigned=1, is_enabled_dashboard=1, is_active=1
 */
export function buildMainConnectionEnableUpdate(conn: any): Record<string, any> {
  return {
    ...conn,
    is_assigned: "1",
    is_active_inserted: "1",
    is_enabled_dashboard: "1",
    is_active: "1",
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build update object to DISABLE a connection in Main Connections
 * - Keep is_inserted stable
 * - Set is_enabled_dashboard=0, is_active=0
 * - ALWAYS keep is_assigned=1 so the card stays visible in the panel
 *   (disappear bug: a connection seeded with only is_enabled_dashboard=1 and
 *   no is_assigned flag would vanish from the list on first disable because
 *   both visible-flags became 0. Explicitly pinning is_assigned=1 here
 *   ensures the card persists in a disabled/inactive state.)
 */
export function buildMainConnectionDisableUpdate(conn: any): Record<string, any> {
  return {
    ...conn,
    is_assigned: "1",          // keep card visible after disable
    is_active_inserted: "0",   // disable from active panel so engine skips this connection
    is_enabled_dashboard: "0", // keep both flags in sync
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build update object to REMOVE a connection from Main Connections panel
 * - Unassign from Active panel (is_active_inserted=0, is_assigned=0)
 * - Disable processing (is_enabled_dashboard=0, is_active=0)
 * - KEEP is_inserted stable so the connection remains visible in Settings
 */
export function buildMainConnectionRemoveUpdate(conn: any): Record<string, any> {
  return {
    ...conn,
    is_assigned: "0",
    is_active_inserted: "0",
    is_dashboard_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    // NOTE: is_inserted is intentionally NOT set to 0 — connection remains in Settings
    updated_at: new Date().toISOString(),
  }
}

/**
 * Check if a connection is ready for the main trade engine
 * (assigned, enabled, with valid API type)
 */
export function isConnectionReadyForEngine(conn: any): boolean {
  const toBoolean = (val: any) => val === true || val === 1 || val === "1" || val === "true"
  
  return (
    toBoolean(conn.is_assigned) &&
    // Use OR: either flag being set means the connection is active/ready
    (toBoolean(conn.is_enabled_dashboard) || toBoolean(conn.is_active_inserted)) &&
    !!conn.exchange &&
    !!conn.api_type
  )
}

/**
 * Get active main connections for trade engine
 */
export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const { getAllConnections } = await import('./redis-db')
  const allConns = await getAllConnections()
  return allConns.filter(isConnectionReadyForEngine)
}
