"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import React, { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Plus, AlertTriangle, RotateCcw } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import type { Connection } from "@/lib/db-types"
import type { ActiveConnection } from "@/lib/active-connections"
import { BASE_EXCHANGES } from "@/lib/connection-utils"
import { COMPONENT_VERSIONS } from "@/lib/system-version"
import { AddActiveConnectionDialog } from "./add-active-connection-dialog"
import { ActiveConnectionCard } from "./active-connection-card"
import { QuickStartButton } from "./quick-start-button"

interface ActiveConnectionWithDetails extends ActiveConnection {
  details?: Connection
}

const toBoolean = (value: unknown): boolean => value === true || value === "1" || value === "true"

export function DashboardActiveConnectionsManager() {
  // Version marker with system version tracking - forces browser cache refresh
  const VERSION = `${COMPONENT_VERSIONS.dashboardManager}-20260226`
  
  const [activeConnections, setActiveConnections] = useState<ActiveConnectionWithDetails[]>([])
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [addDialogOpen, setAddDialogOpen] = useState(false)
  const [togglingIds, setTogglingIds] = useState<Set<string>>(new Set())
  const [removingIds, setRemovingIds] = useState<Set<string>>(new Set())
  const [resetting, setResetting] = useState(false)
  const [globalEngineRunning, setGlobalEngineRunning] = useState(false)
  const [globalEngineQueued, setGlobalEngineQueued] = useState(false)
  const [globalEngineDiagnosticHint, setGlobalEngineDiagnosticHint] = useState<string | null>(null)
  const [globalEngineLoading, setGlobalEngineLoading] = useState(true)
  const globalEngineRef = React.useRef(false)
  const activeConnectionsRef = React.useRef<ActiveConnectionWithDetails[]>([])
  // Refs used to skip the interval reload while a toggle/remove is in flight,
  // preventing the 8s poll from stomping on optimistic UI state.
  const togglingRef = React.useRef<Set<string>>(new Set())
  const removingRef = React.useRef<Set<string>>(new Set())
  // savingRef: connections mid-settings-save. During the 2s recoordination
  // window after a PATCH /settings, the backend may briefly return stale flags.
  // Connections in this set are preserved in loadConnections even if Redis
  // temporarily shows is_active_inserted=0.
  const savingRef = React.useRef<Set<string>>(new Set())
  React.useEffect(() => { togglingRef.current = togglingIds }, [togglingIds])
  React.useEffect(() => { removingRef.current = removingIds }, [removingIds])



  const updateActiveConnections = (updater: ActiveConnectionWithDetails[] | ((prev: ActiveConnectionWithDetails[]) => ActiveConnectionWithDetails[])) => {
    if (typeof updater === "function") {
      setActiveConnections(prev => {
        const next = updater(prev)
        activeConnectionsRef.current = next
        return next
      })
    } else {
      activeConnectionsRef.current = updater
      setActiveConnections(updater)
    }
  }

  const loadConnections = async (opts?: { force?: boolean }) => {
    // Skip background reloads while a toggle or remove is in flight to avoid
    // stomping on optimistic UI state (and clobbering an unassign with a stale list).
    if (!opts?.force && (togglingRef.current.size > 0 || removingRef.current.size > 0)) {
      return
    }
    try {
      const timestamp = new Date().getTime()
      const response = await fetch(`/api/settings/connections?v=${VERSION}&t=${timestamp}`, {
        cache: "no-store",
        headers: {
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
          "X-Component-Version": VERSION,
        },
      })

      if (!response.ok) {
        setLoading(false)
        return
      }

      const data = await response.json()
      const allConnections: Connection[] = Array.isArray(data) ? data : (data?.connections || [])
      
      const activeConns: ActiveConnectionWithDetails[] = []
      const seenIds = new Set<string>()
      
      for (const conn of allConnections) {
        // STABLE ASSIGNMENT RULE (fixes "connection gets re-added after enable/delete"):
        // A card appears ONLY when the user explicitly assigned the connection to the
        // Main Connections panel. We do NOT auto-include based on exchange type —
        // that caused bybit/bingx cards to re-materialize on every 8s poll even after
        // the user removed/disabled them.
        const isActiveInserted =
          toBoolean(conn.is_active_inserted) ||
          toBoolean(conn.is_dashboard_inserted) ||
          toBoolean((conn as any).is_assigned)

        // isEnabledDashboard = connection's dashboard toggle is ON (processing enabled)
        const isEnabledDashboard =
          toBoolean(conn.is_enabled_dashboard)

        if (isActiveInserted || isEnabledDashboard) {
          // Normalise IDs: strip the "conn-" prefix so that both the raw
          // predefined key (e.g. "bingx-x01") and its stored form
          // ("conn-bingx-x01") collapse to the same canonical token.
          // Without this, getAllConnections() returning both forms would
          // create two separate cards for the same physical connection.
          const canonId = conn.id.replace(/^conn-/, "")
          if (seenIds.has(canonId)) continue
          seenIds.add(canonId)
          const exchange = (conn.exchange || "").toLowerCase().trim()
          const isBase = BASE_EXCHANGES.includes(exchange)
          activeConns.push({
            id: `active-${conn.id}`,
            connectionId: conn.id,
            exchangeName: conn.exchange ? conn.exchange.charAt(0).toUpperCase() + conn.exchange.slice(1) : "Unknown",
            isActive: isEnabledDashboard,
            isBaseEnabled: isBase,
            addedAt: conn.created_at || new Date().toISOString(),
            details: conn,
          })
        }
      }

      // ── Merge-not-replace for in-flight toggles / settings-saves ────
      // If a connection is currently mid-toggle/mid-remove/mid-save, we
      // don't want a transient Redis read (flags briefly 0 due to write
      // ordering, recoordination window, or a partial response) to drop
      // the card and re-add it on the next poll. Preserve the optimistic
      // entry until the operation settles.
      const inFlight = new Set<string>([
        ...togglingRef.current,
        ...removingRef.current,
        ...savingRef.current,
      ])
      if (inFlight.size > 0) {
        const fetchedIds = new Set(activeConns.map(ac => ac.connectionId))
        const previous = activeConnectionsRef.current
        for (const prev of previous) {
          if (inFlight.has(prev.connectionId) && !fetchedIds.has(prev.connectionId)) {
            activeConns.push(prev)
          }
        }
      }
      updateActiveConnections(activeConns)
    } catch (error) {
      console.error("[Manager] Error loading connections:", error)
    } finally {
      setLoading(false)
    }
  }

  const checkGlobalEngine = async () => {
    try {
      const res = await fetch("/api/trade-engine/status")
      if (res.ok) {
        const data = await res.json()
        const wasRunning = globalEngineRef.current
        const nowRunning = data.actualRuntimeStatus === "running" || data.running === true
        const heartbeatFresh = data.workerAttached === true || data.connectionHeartbeatFresh === true || data.globalHeartbeatFresh === true
        const intentRunning = data.operatorIntent === "running" || data.operatorStatus === "running"
        globalEngineRef.current = nowRunning
        setGlobalEngineRunning(nowRunning)
        setGlobalEngineQueued(intentRunning && !heartbeatFresh)
        setGlobalEngineDiagnosticHint(data.diagnostics?.hint || null)
        if (!wasRunning && nowRunning) {
          loadConnections()
        }
      }
    } catch {
      // Keep previous state on error
    } finally {
      setGlobalEngineLoading(false)
    }
  }

  useEffect(() => {
  loadConnections()
  checkGlobalEngine()
  const connInterval = setInterval(loadConnections, 8000)
  const engineInterval = setInterval(checkGlobalEngine, 5000)
    
    // Listen for relevant events and refresh
    const handleEngineStateChange = () => {
      checkGlobalEngine()
    }

    // After settings are saved via the ConnectionSettingsDialog, force-refresh
    // the connections list after a short delay so the updated flags (symbols,
    // is_enabled_dashboard, etc.) are reflected without waiting for the 8s poll.
    const handleSettingsUpdated = (e: Event) => {
      const detail = (e as CustomEvent).detail
      const connId: string | undefined = detail?.connectionId
      if (connId) {
        // Guard this connection against transient disappearance during the
        // recoordination window (PATCH → archiveProgression → Redis writes).
        // The card stays pinned in the list even if a background poll fires
        // before the flags are stable.
        savingRef.current.add(connId)
        // Release the guard after 4s — well past the ~1s recoordination window.
        setTimeout(() => { savingRef.current.delete(connId) }, 4000)
      }
      // Small delay so the PATCH write + recoordination settle before we re-fetch.
      setTimeout(() => loadConnections({ force: true }), 800)
      // Also check the global engine state in case a restart was triggered.
      setTimeout(checkGlobalEngine, 1200)
    }
    
    if (typeof window !== 'undefined') {
      window.addEventListener('engine-state-changed', handleEngineStateChange)
      window.addEventListener('connection-settings-updated', handleSettingsUpdated)
    }
    
    return () => {
      clearInterval(connInterval)
      clearInterval(engineInterval)
      if (typeof window !== 'undefined') {
        window.removeEventListener('engine-state-changed', handleEngineStateChange)
        window.removeEventListener('connection-settings-updated', handleSettingsUpdated)
      }
    }
  }, [])

  const handleToggle = async (connectionId: string, desiredState: boolean) => {
    const currentState = activeConnectionsRef.current.find(ac => ac.connectionId === connectionId)?.isActive ?? false
    const newState = desiredState
    if (newState === currentState) return

    setTogglingIds(prev => new Set(prev).add(connectionId))

    const connInfo = activeConnections.find(ac => ac.connectionId === connectionId)
    const connName = connInfo?.exchangeName ? `${connInfo.exchangeName} (${connectionId})` : connectionId

    try {
      const toggleRes = await fetch(`/api/settings/connections/${connectionId}/toggle-dashboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled_dashboard: newState }),
        cache: "no-store"
      })

      if (!toggleRes.ok) {
        const errorData = await toggleRes.json().catch(() => ({ error: "Unknown error" }))
        throw new Error(`Toggle API failed: ${errorData.error}`)
      }

      updateActiveConnections(prev => prev.map(ac =>
        ac.connectionId === connectionId ? { ...ac, isActive: newState } : ac
      ))

      const toggleData = await toggleRes.json().catch(() => ({} as any))
      dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(toggleData, {
        connectionId,
        connection: { id: connectionId, name: connInfo?.exchangeName },
        engine: { action: newState ? "start" : "stop", status: toggleData.engine?.status },
        source: "dashboard-active-connections-manager.toggleDashboard",
      }))
      if (!newState) {
        const liveTradeRes = await fetch(`/api/settings/connections/${connectionId}/live-trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_live_trade: false }),
          cache: "no-store"
        }).catch(() => null)
        if (liveTradeRes?.ok) {
          const liveTradeData = await liveTradeRes.json().catch(() => ({} as any))
          dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(liveTradeData, {
            connectionId,
            connection: { id: connectionId, name: connInfo?.exchangeName },
            engine: { action: "stop", status: liveTradeData.engineStatus },
            source: "dashboard-active-connections-manager.liveTradeOff",
          }))
        }
        toast.success("Connection deactivated", { description: "Engine stopped" })
      } else if (toggleData.changed) {
        toast.success("Connection added to Main Connections", {
          description: "Use the Live Trade slider to enable real exchange trading",
        })
      } else {
        toast.info("Connection already in Main Connections")
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("connection-toggled", { detail: { connectionId, newState } }))
        window.dispatchEvent(new CustomEvent("engine-state-changed", { detail: { connectionId, newState } }))
      }

      // ── Hold optimistic state longer (3s vs 800ms) ──────────────────
      // The toggle endpoint returns immediately after writing the
      // connection flags, but downstream side-effects (engine start,
      // global state hash update, progression init) may race the very
      // next poll. Holding the optimistic state for 3s gives the
      // back-end time to converge BEFORE we re-fetch the truth — this
      // is what kept "just-enabled" cards disappearing for a tick
      // before re-appearing, producing the visual flicker.
      setTimeout(() => {
        loadConnections({ force: true })
        checkGlobalEngine()
      }, 3000)
    } catch (error) {
      console.error(`[Manager] Toggle error for ${connName}:`, error)
      updateActiveConnections(prev => prev.map(ac =>
        ac.connectionId === connectionId ? { ...ac, isActive: currentState } : ac
      ))
      toast.error("Failed to update connection status")
    } finally {
      setTogglingIds(prev => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
    }
  }

  const handleRemove = async (connectionId: string, connectionName: string) => {
    try {
      setRemovingIds(prev => new Set(prev).add(connectionId))

      // Stop engine first (non-critical)
      const liveTradeRes = await fetch(`/api/settings/connections/${connectionId}/live-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_live_trade: false }),
        cache: "no-store"
      }).catch(() => null)
      if (liveTradeRes?.ok) {
        const liveTradeData = await liveTradeRes.json().catch(() => ({} as any))
        dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(liveTradeData, {
          connectionId,
          connection: { id: connectionId, name: connectionName },
          engine: { action: "stop", status: liveTradeData.engineStatus },
          source: "dashboard-active-connections-manager.remove.liveTradeOff",
        }))
      }

      // Remove from active panel
      const removeRes = await fetch(`/api/settings/connections/${connectionId}/active`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        cache: "no-store"
      })

      if (!removeRes.ok) {
        const errorData = await removeRes.json().catch(() => ({ error: "Unknown error" }))
        throw new Error(errorData.error || removeRes.statusText)
      }

      updateActiveConnections(prev => prev.filter(ac => ac.connectionId !== connectionId))

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("connection-removed", {
          detail: { connectionId, name: connectionName }
        }))
      }

      toast.success("Connection removed", {
        description: `${connectionName} has been removed from active connections`
      })

      setTimeout(() => loadConnections({ force: true }), 500)
    } catch (error) {
      console.error(`[Manager] Remove error for ${connectionName}:`, error)
      toast.error("Failed to remove connection", {
        description: error instanceof Error ? error.message : "Unknown error"
      })
    } finally {
      setRemovingIds(prev => {
        const next = new Set(prev)
        next.delete(connectionId)
        return next
      })
    }
  }

  const handleResetDashboard = async () => {
    try {
      setResetting(true)
      const response = await fetch("/api/settings/connections/reset-dashboard-state", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      
      if (!response.ok) {
        throw new Error("Failed to reset dashboard state")
      }
      
      const data = await response.json()
      toast.success("Dashboard reset complete", {
        description: `${data.updatedCount} connections disabled`
      })
      
      // Reload connections
      setTimeout(() => loadConnections({ force: true }), 300)
    } catch (error) {
      toast.error("Failed to reset dashboard", {
        description: error instanceof Error ? error.message : "Unknown error"
      })
    } finally {
      setResetting(false)
    }
  }

  if (loading) {
    return (
      <div className="text-center py-8 text-muted-foreground">
        Loading active connections...
      </div>
    )
  }



  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="font-semibold text-sm">Main Connections (Active Connections)</h3>
          <p className="text-xs text-muted-foreground">
            All connections disabled by default. Enable to start engine progression.
          </p>
        </div>
        <Button
          onClick={() => setAddDialogOpen(true)}
          size="sm"
          className="gap-1"
        >
          <Plus className="h-4 w-4" />
          Add Connection
        </Button>
      </div>

      {/* Quick Start Button - One-click setup for testing with BingX */}
      <QuickStartButton onQuickStartComplete={() => loadConnections()} />

      <AddActiveConnectionDialog
        open={addDialogOpen}
        onOpenChange={setAddDialogOpen}
        onConnectionAdded={() => loadConnections()}
      />

      {!globalEngineLoading && !globalEngineRunning && activeConnections.some(c => c.isActive) && (
        <div className="flex items-center gap-3 p-3 rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
              {globalEngineQueued ? "Queued / waiting for worker" : "Engine starting up"}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {globalEngineDiagnosticHint || "Engine is initializing for enabled connections. Status will update shortly."}
            </p>
          </div>
        </div>
      )}

      {activeConnections.length === 0 ? (
        <Card>
          <CardContent className="pt-6 text-center text-muted-foreground">
            <p className="mb-3">No active connections</p>
            <p className="text-sm text-muted-foreground">
              Use the &ldquo;Add Connection&rdquo; button to add a connection, or configure connections in Settings first.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="flex flex-col gap-3">
          {activeConnections.map((conn) => (
            <ActiveConnectionCard
              key={conn.id}
              connection={conn}
              expanded={expandedId === conn.id}
              onExpand={(open) => setExpandedId(open ? conn.id : null)}
              onToggle={handleToggle}
              onRemove={handleRemove}
              isToggling={togglingIds.has(conn.connectionId)}
              isRemoving={removingIds.has(conn.connectionId)}
              globalEngineRunning={globalEngineRunning}
            />
          ))}
        </div>
      )}
    </div>
  )
}
