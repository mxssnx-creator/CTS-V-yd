export function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === "1" || value === "true"
}

export function hasConnectionCredentials(connection: any, minLength = 10, allowPlaceholder = true): boolean {
  const apiKey = connection?.api_key || connection?.apiKey || ""
  const apiSecret = connection?.api_secret || connection?.apiSecret || ""

  if (!allowPlaceholder) {
    if (String(apiKey).includes("PLACEHOLDER") || String(apiSecret).includes("PLACEHOLDER")) {
      return false
    }
  }

  return apiKey.length >= minLength && apiSecret.length >= minLength
}

// ========== BASE CONNECTION STATE (Settings Panel) ==========
export function isConnectionInBasePanel(connection: any): boolean {
  return isTruthyFlag(connection?.is_inserted)
}

export function isConnectionBaseEnabled(connection: any): boolean {
  return isTruthyFlag(connection?.is_enabled)
}

// ========== MAIN CONNECTION STATE (Dashboard Panel) ==========
// NEW: Renamed from is_active_inserted → is_assigned for clarity
export function isConnectionAssignedToMain(connection: any): boolean {
  // Support old and new naming during migration. Assignment/visibility is
  // separate from processing enablement.
  return (
    isTruthyFlag(connection?.is_assigned) ||
    isTruthyFlag(connection?.is_active_inserted) ||
    isTruthyFlag(connection?.is_dashboard_inserted)
  )
}

export function isConnectionProcessingEnabled(connection: any): boolean {
  return isTruthyFlag(connection?.is_enabled_dashboard)
}

export function isConnectionDashboardEnabled(connection: any): boolean {
  return isConnectionProcessingEnabled(connection)
}

// ========== COMBINED STATE CHECKS ==========
export function isConnectionInActivePanel(connection: any): boolean {
  // Deprecated: use isConnectionAssignedToMain instead
  return isConnectionAssignedToMain(connection)
}

export function isConnectionMainProcessing(connection: any): boolean {
  // Connection is processing if BOTH assigned AND dashboard-enabled.
  // is_active_inserted / is_assigned are panel-assignment flags only;
  // is_enabled_dashboard is the explicit processing switch.
  return isConnectionAssignedToMain(connection) && isConnectionProcessingEnabled(connection)
}

export function isConnectionSystemEnabled(connection: any): boolean {
  return isTruthyFlag(connection?.is_enabled)
}

export function isConnectionLiveTradeEnabled(connection: any): boolean {
  return isTruthyFlag(connection?.is_live_trade) || isTruthyFlag(connection?.live_trade_enabled)
}

export function isConnectionPresetTradeEnabled(connection: any): boolean {
  return isTruthyFlag(connection?.is_preset_trade) || isTruthyFlag(connection?.preset_trade_enabled)
}

export function isConnectionWorking(connection: any): boolean {
  const status = connection?.last_test_status || connection?.test_status || connection?.connection_status
  return status === "success" || status === "ok" || status === "connected"
}

// ========== ENGINE ELIGIBILITY ==========
export function isConnectionEligibleForEngine(connection: any): boolean {
  // Engine processing requires assignment plus the dashboard processing toggle.
  // Base `is_enabled` / legacy `enabled` are intentionally ignored here; they
  // only describe base connection availability/settings visibility.
  const isProcessingEnabled = isConnectionMainProcessing(connection)

  // Any credentials count — placeholder and testnet are accepted; credentials are
  // validated per-operation by the exchange connector, not at eligibility check time.
  const hasCredentials = hasConnectionCredentials(connection, 5, true)
  const isTestnet = isTruthyFlag(connection?.is_testnet)
  const isDemoMode = isTruthyFlag(connection?.demo_mode)
  const isPredefined = isTruthyFlag(connection?.is_predefined)

  return isProcessingEnabled && (hasCredentials || isTestnet || isDemoMode || isPredefined)
}

export function isOpenPosition(position: any): boolean {
  return position?.status === "open" || position?.status === "active" || isTruthyFlag(position?.is_open)
}
