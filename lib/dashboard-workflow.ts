import { getAllConnections, getConnectionPositions, getConnectionTrades, getRedisClient, getSettings, initRedis } from "@/lib/redis-db"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { getProgressionLogs } from "@/lib/engine-progression-logs"
import {
  hasConnectionCredentials,
  isConnectionDashboardEnabled,
  isConnectionEligibleForEngine,
  isConnectionInActivePanel,
  isConnectionLiveTradeEnabled,
  isConnectionPresetTradeEnabled,
} from "@/lib/connection-state-utils"


async function scanKeys(client: any, pattern: string, limit = 500): Promise<string[]> {
  const keys: string[] = []
  let cursor = "0"
  do {
    const result = await client.scan(cursor, "MATCH", pattern, "COUNT", 100).catch(() => null)
    if (!result) break
    cursor = String(Array.isArray(result) ? result[0] : result.cursor || "0")
    const batch = (Array.isArray(result) ? result[1] : result.keys || []) as string[]
    keys.push(...batch)
  } while (cursor !== "0" && keys.length < limit)
  return keys.slice(0, limit)
}

type WorkflowConnection = {
  id: string
  name: string
  exchange: string
  hasCredentials: boolean
  isActivePanel: boolean
  isDashboardEnabled: boolean
  liveTradeEnabled: boolean
  presetTradeEnabled: boolean
  testStatus: string
}


const SNAPSHOT_TTL_MS = 1000
// When a specific connectionId is requested (e.g. from the Logistics sidebar
// page) we bypass the shared cache because different callers want different
// focus connections.
let cachedSnapshot: any | null = null
let cachedSnapshotAt = 0
let snapshotInFlight: Promise<any> | null = null

export async function getDashboardWorkflowSnapshot(options?: { preferredConnectionId?: string }) {
  const preferredConnectionId = options?.preferredConnectionId

  if (preferredConnectionId) {
    // Per-connection requests are uncached to avoid mixing focus connections.
    return buildDashboardWorkflowSnapshot(preferredConnectionId)
  }

  const now = Date.now()
  if (cachedSnapshot && now - cachedSnapshotAt < SNAPSHOT_TTL_MS) {
    return cachedSnapshot
  }

  if (snapshotInFlight) {
    return snapshotInFlight
  }

  snapshotInFlight = buildDashboardWorkflowSnapshot()

  try {
    const snapshot = await snapshotInFlight
    cachedSnapshot = snapshot
    cachedSnapshotAt = Date.now()
    return snapshot
  } finally {
    snapshotInFlight = null
  }
}

async function buildDashboardWorkflowSnapshot(preferredConnectionId?: string) {
  await initRedis()

  const client = getRedisClient()
  const allConnections = await getAllConnections()
  const globalState = await client.hgetall("trade_engine:global")
  const globalStatus = globalState?.status || "stopped"

  const normalizedConnections: WorkflowConnection[] = allConnections.map((connection: any) => {
    return {
      id: connection.id,
      name: connection.name || connection.exchange || connection.id,
      exchange: connection.exchange || "unknown",
      hasCredentials: hasConnectionCredentials(connection, 10),
      isActivePanel: isConnectionInActivePanel(connection),
      isDashboardEnabled: isConnectionDashboardEnabled(connection),
      liveTradeEnabled: isConnectionLiveTradeEnabled(connection),
      presetTradeEnabled: isConnectionPresetTradeEnabled(connection),
      testStatus: connection.last_test_status || connection.test_status || "untested",
    }
  })

  const eligibleConnections = allConnections.filter((connection: any) => isConnectionEligibleForEngine(connection))
  const eligibleIds = new Set(eligibleConnections.map((conn: any) => conn.id))

  // When a preferredConnectionId is supplied (from a sidebar page that has a
  // specific exchange selected), honor it instead of the heuristic pick — but
  // still fall back to the heuristic if the preferred id isn't present.
  const preferredFocus = preferredConnectionId
    ? normalizedConnections.find((conn) => conn.id === preferredConnectionId)
    : undefined

  const focusConnection =
    preferredFocus ||
    normalizedConnections.find((conn) => eligibleIds.has(conn.id)) ||
    normalizedConnections.find((conn) => conn.isActivePanel && conn.isDashboardEnabled) ||
    normalizedConnections.find((conn) => conn.isActivePanel) ||
    normalizedConnections[0] ||
    null

  let connectionMetrics = {
    progression: null as null | Awaited<ReturnType<typeof ProgressionStateManager.getProgressionState>>,
    positions: 0,
    trades: 0,
    logs: [] as Awaited<ReturnType<typeof getProgressionLogs>>,
    engineCycles: { indication: 0, strategy: 0, realtime: 0, total: 0 },
    engineDurations: { indicationAvgMs: 0, strategyAvgMs: 0, realtimeAvgMs: 0 },
    comprehensiveStats: null as null | {
      symbols: { prehistoricLoaded: number; prehistoricDataSize: number; intervalsProcessed: number }
      indicationsByType: { direction: number; move: number; active: number; optimal: number; auto: number; total: number }
      pseudoPositions: { base: number; main: number; real: number; total: number }
      livePositions: number
    }
  }

  if (focusConnection) {
    const connId = focusConnection.id

    const [progression, positions, trades, logs, engineState, progHash] = await Promise.all([
      ProgressionStateManager.getProgressionState(connId),
      getConnectionPositions(connId),
      getConnectionTrades(connId),
      getProgressionLogs(connId),
      getSettings(`trade_engine_state:${connId}`),
      // progression:{connId} is a raw hash updated EVERY cycle — primary source for live counts
      client.hgetall(`progression:${connId}`).catch(() => ({})),
    ])

    const ph = (progHash || {}) as Record<string, string>

    // Cycle counts: prefer live progression hash (updated every cycle) over engine state
    // (engine state is only persisted every 50-100 cycles)
    const indicationCycles =
      parseInt(ph.indication_cycle_count || "0", 10) ||
      Number((engineState as any)?.indication_cycle_count || 0)
    const strategyCycles =
      parseInt(ph.strategy_cycle_count || "0", 10) ||
      Number((engineState as any)?.strategy_cycle_count || 0)
    const realtimeCycles = Number((engineState as any)?.realtime_cycle_count || 0)

    // Indication counts: use counter keys (engine writes incr counters, not sets)
    const totalIndicationsCount = parseInt(ph.indications_count || "0", 10)
    const directionIndications = parseInt(ph.indications_direction_count || "0", 10)
    const moveIndications      = parseInt(ph.indications_move_count      || "0", 10)
    const activeIndications    = parseInt(ph.indications_active_count    || "0", 10)
    const optimalIndications   = parseInt(ph.indications_optimal_count   || "0", 10)
    const autoIndications      = parseInt(ph.indications_auto_count      || "0", 10)

    // Strategy set counts from settings:strategies:* hash keys
    let baseSets = 0, mainSets = 0, realSets = 0
    try {
      const stratKeys = await scanKeys(client, `settings:strategies:${connId}:*:sets`, 250)
      for (const k of stratKeys) {
        const h = await client.hgetall(k).catch(() => ({})) || {}
        const c = parseInt((h as Record<string, string>).count || "0", 10)
        if (k.includes(":base:"))      baseSets += c
        else if (k.includes(":main:")) mainSets += c
        else if (k.includes(":real:")) realSets += c
      }
    } catch { /* non-critical */ }

    // Prehistoric symbols from set (still uses sadd)
    const prehistoricSymbols = await client.scard(`prehistoric:${connId}:symbols`).catch(() => 0)
    let prehistoricDataSize = 0
    try {
      const keys = await scanKeys(client, `prehistoric:${connId}:*`, 1000)
      prehistoricDataSize = keys.length
    } catch { /* ignore */ }

    // Intervals processed: stored as string counter
    const intervalsProcessed =
      parseInt(await client.get(`intervals:${connId}:processed_count`).catch(() => "0") as string || "0", 10)

    connectionMetrics = {
      progression,
      positions: positions.length,
      trades: trades.length,
      logs: logs.slice(0, 50),
      engineCycles: {
        indication: indicationCycles,
        strategy: strategyCycles,
        realtime: realtimeCycles,
        total: indicationCycles + strategyCycles + realtimeCycles,
      },
      engineDurations: {
        indicationAvgMs: Number((engineState as any)?.indication_avg_duration_ms || 0),
        strategyAvgMs: Number((engineState as any)?.strategy_avg_duration_ms || 0),
        realtimeAvgMs: Number((engineState as any)?.realtime_avg_duration_ms || 0),
      },
      comprehensiveStats: {
        symbols: {
          prehistoricLoaded: prehistoricSymbols,
          prehistoricDataSize,
          intervalsProcessed,
        },
        indicationsByType: {
          direction: directionIndications,
          move: moveIndications,
          active: activeIndications,
          optimal: optimalIndications,
          auto: autoIndications,
          total: totalIndicationsCount || (directionIndications + moveIndications + activeIndications + optimalIndications + autoIndications),
        },
        pseudoPositions: {
          base: baseSets,
          main: mainSets,
          real: realSets,
          // Cascade pipeline — Base → Main → Real is eval → filter → adjust on
          // the SAME underlying pseudo-position population. `total` = Real-stage
          // survivors only; summing the three would multi-count the same items.
          total: realSets,
        },
        livePositions: 0,
      },
    }
  }

  const [recentGlobalLogs, quickstartStateRaw] = await Promise.all([
    getProgressionLogs("global"),
    client.get("quickstart:last_run").catch(() => null),
  ])
  let quickstartState: null | {
    connectionId?: string
    connectionName?: string
    exchange?: string
    timestamp?: string
    durationMs?: number
  } = null
  if (quickstartStateRaw) {
    try {
      quickstartState = JSON.parse(quickstartStateRaw as string)
    } catch {
      quickstartState = null
    }
  }

  const workflowPhases = [
    {
      id: "credentials",
      label: "Credentials",
      status: normalizedConnections.some((conn) => conn.hasCredentials) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.hasCredentials)
        ? "API credentials detected for at least one connection"
        : "Add API key and secret in Settings to unlock exchange-backed processing",
    },
    {
      id: "active-panel",
      label: "Active Panel",
      status: normalizedConnections.some((conn) => conn.isActivePanel) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.isActivePanel)
        ? "Connection is inserted into the dashboard active panel"
        : "Use Add Connection or Quick Start to insert a connection into the active panel",
    },
    {
      id: "dashboard-enable",
      label: "Dashboard Enable",
      status: normalizedConnections.some((conn) => conn.isDashboardEnabled) ? "complete" : "pending",
      detail: normalizedConnections.some((conn) => conn.isDashboardEnabled)
        ? "Dashboard enable toggle is active for at least one connection"
        : "Toggle Enable on an active connection to start engine-side processing",
    },
    {
      id: "global-engine",
      label: "Global Engine",
      status: globalStatus === "running" ? "complete" : globalStatus === "paused" ? "warning" : "pending",
      detail:
        globalStatus === "running"
          ? "Global coordinator is running"
          : globalStatus === "paused"
            ? "Global coordinator is paused"
            : "Start the global coordinator to begin processing cycles",
    },
    {
      id: "engine-eligible",
      label: "Eligible Processing",
      status: eligibleConnections.length > 0 ? "complete" : normalizedConnections.length > 0 ? "warning" : "pending",
      detail:
        eligibleConnections.length > 0
          ? `${eligibleConnections.length} connection(s) currently eligible for engine processing`
          : normalizedConnections.length > 0
            ? "Connections exist but none currently satisfy all engine eligibility checks"
            : "No connections configured yet",
    },
  ]

  return {
    timestamp: new Date().toISOString(),
    globalStatus,
    overview: {
      totalConnections: normalizedConnections.length,
      activePanelConnections: normalizedConnections.filter((conn) => conn.isActivePanel).length,
      dashboardEnabledConnections: normalizedConnections.filter((conn) => conn.isDashboardEnabled).length,
      eligibleEngineConnections: eligibleConnections.length,
      liveTradeConnections: normalizedConnections.filter((conn) => conn.liveTradeEnabled).length,
      presetTradeConnections: normalizedConnections.filter((conn) => conn.presetTradeEnabled).length,
    },
    workflowPhases,
    focusConnection,
    connectionMetrics,
    recentGlobalLogs: recentGlobalLogs.slice(0, 20),
    quickstartState,
  }
}
