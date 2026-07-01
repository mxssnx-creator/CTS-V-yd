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

const toBoolean = (val: any) => val === true || val === 1 || val === "1" || val === "true"

/**
 * Parse connection state to understand its role in Main Connections
 */
export function getConnectionState(conn: any): ConnectionState {
  return {
    main_assigned: isConnectionAssignedToMain(conn),
    main_enabled: isConnectionProcessingEnabled(conn),
    is_inserted: toBoolean(conn?.is_inserted),
    is_enabled_dashboard: isConnectionProcessingEnabled(conn),
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
 */
export function buildMainConnectionDisableUpdate(conn: any): Record<string, any> {
  return {
    ...conn,
    is_assigned: "1",
    is_active_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

/**
 * Build update object to REMOVE a connection from Main Connections panel
 */
export function buildMainConnectionRemoveUpdate(conn: any): Record<string, any> {
  return {
    ...conn,
    is_assigned: "0",
    is_active_inserted: "0",
    is_dashboard_inserted: "0",
    is_enabled_dashboard: "0",
    is_active: "0",
    updated_at: new Date().toISOString(),
  }
}

export function isConnectionAssignedToMain(conn: any): boolean {
  return toBoolean(conn?.is_assigned) || toBoolean(conn?.is_active_inserted) || toBoolean(conn?.is_dashboard_inserted)
}

export function isConnectionProcessingEnabled(conn: any): boolean {
  return toBoolean(conn?.is_enabled_dashboard)
}

export function isConnectionReadyForEngine(conn: any): boolean {
  return isConnectionAssignedToMain(conn) && isConnectionProcessingEnabled(conn) && !!conn?.exchange && !!conn?.api_type
}

/**
 * Get active main connections for trade engine
 */
export async function getActiveConnectionsForEngine(): Promise<any[]> {
  const { getAllConnections } = await import('./redis-db')
  const allConns = await getAllConnections()
  return allConns.filter(isConnectionReadyForEngine)
}
