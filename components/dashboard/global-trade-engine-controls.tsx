"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Play, Pause, Square, Activity, Clock, Zap, Target } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { PresetSelectionDialog } from "./preset-selection-dialog"

interface EngineStatus {
  running: boolean
  paused: boolean
  operatorIntent?: string
  actualRuntimeStatus?: string
  workerAttached?: boolean
  globalHeartbeatFresh?: boolean
  connectionHeartbeatFresh?: boolean
  diagnosticHint?: string | null
  connectedExchanges: number
  activePositions: number
  totalProfit: number
  uptime: number
  lastUpdate: Date
  cycleStats?: {
    mainEngineCycleCount: number
    presetEngineCycleCount: number
    activeOrderCycleCount: number
    avgMainCycleDuration: number
    avgPresetCycleDuration: number
    avgOrderCycleDuration: number
  }
}

export function GlobalTradeEngineControls() {
  const [status, setStatus] = useState<EngineStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const [isStarting, setIsStarting] = useState(false)
  const [isPausing, setIsPausing] = useState(false)
  const [isResuming, setIsResuming] = useState(false)
  const [isStopping, setIsStopping] = useState(false)
  const [presetDialogOpen, setPresetDialogOpen] = useState(false)

  useEffect(() => {
    // Load initial status immediately
    loadStatus()
    // Poll at 8s to keep status fresh without hammering the API
    const interval = setInterval(loadStatus, 8000)
    
    // Listen for engine state change events (from quick-start button, etc)
    const handleEngineStateChange = () => {
      loadStatus()
    }
    
    window.addEventListener("engine-state-changed", handleEngineStateChange)
    window.addEventListener("connection-toggled", handleEngineStateChange)
    
    return () => {
      clearInterval(interval)
      window.removeEventListener("engine-state-changed", handleEngineStateChange)
      window.removeEventListener("connection-toggled", handleEngineStateChange)
    }
  }, [])

  const loadStatus = async () => {
    try {
      const response = await fetch("/api/trade-engine/status", {
        cache: "no-store",
        headers: { 
          "Cache-Control": "no-cache, no-store, must-revalidate",
          "Pragma": "no-cache",
        },
      })
      if (response.ok) {
        const data = await response.json()
        const statusData: EngineStatus = {
          running: data.actualRuntimeStatus === "running" || data.running === true,
          paused: data.paused === true || data.paused === "true",
          operatorIntent: data.operatorIntent || data.operatorStatus,
          actualRuntimeStatus: data.actualRuntimeStatus,
          workerAttached: data.workerAttached === true,
          globalHeartbeatFresh: data.globalHeartbeatFresh === true,
          connectionHeartbeatFresh: data.connectionHeartbeatFresh === true,
          diagnosticHint: data.diagnostics?.hint || null,
          connectedExchanges: data.connectedExchanges || data.summary?.total || 0,
          activePositions: data.activePositions || data.summary?.totalPositions || 0,
          totalProfit: data.totalProfit || 0,
          uptime: data.uptime || 0,
          lastUpdate: new Date(data.lastUpdate || Date.now()),
          cycleStats: data.cycleStats,
        }
        setStatus(statusData)
      }
    } catch {
      // silently ignore status load errors
    }
  }

  const handleStart = async () => {
    setIsStarting(true)
    try {
      const response = await fetch("/api/trade-engine/start", { 
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const data = await response.json()

      if (response.ok && data.success) {
        toast.success(data.message || "Global Trade Engine started successfully")
        await loadStatus()
        setTimeout(loadStatus, 500)
        setTimeout(loadStatus, 1500)
      } else {
        toast.error(data.error || "Failed to start engine")
        // Even on error, refresh status to get accurate state
        await loadStatus()
      }
    } catch {
      toast.error("Failed to start engine")
      // Refresh status even on exception to get accurate state
      await loadStatus()
    } finally {
      setIsStarting(false)
    }
  }

  const handlePause = async () => {
    setIsPausing(true)
    try {
      const response = await fetch("/api/trade-engine/pause", { method: "POST" })
      const data = await response.json()

      if (response.ok) {
        toast.success("Global Trade Engine paused")
        await loadStatus()
        setTimeout(loadStatus, 500)
      } else {
        toast.error(data.error || "Failed to pause engine")
        await loadStatus()
      }
    } catch {
      toast.error("Failed to pause engine")
      await loadStatus()
    } finally {
      setIsPausing(false)
    }
  }

  const handleResume = async () => {
    setIsResuming(true)
    try {
      const response = await fetch("/api/trade-engine/resume", { method: "POST" })
      const data = await response.json()

      if (response.ok) {
        toast.success("Global Trade Engine resumed")
        await loadStatus()
        setTimeout(loadStatus, 500)
      } else {
        toast.error(data.error || "Failed to resume engine")
        await loadStatus()
      }
    } catch {
      toast.error("Failed to resume engine")
      await loadStatus()
    } finally {
      setIsResuming(false)
    }
  }

  const handleStop = async () => {
    setIsStopping(true)
    try {
      const response = await fetch("/api/trade-engine/stop", { method: "POST" })
      const data = await response.json()

      if (response.ok) {
        toast.success("Global Trade Engine stopped")
        await loadStatus()
        setTimeout(loadStatus, 500)
      } else {
        toast.error(data.error || "Failed to stop engine")
        await loadStatus()
      }
    } catch {
      toast.error("Failed to stop engine")
      await loadStatus()
    } finally {
      setIsStopping(false)
    }
  }

  const handleSelectPreset = async (presetId: string) => {
    try {
      const response = await fetch("/api/presets/activate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ presetId }),
      })

      if (response.ok) {
        const data = await response.json()
        toast.success(`Preset activated: ${data.name || "Preset"}`)
        
        // Dispatch event to refresh all UI components
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("preset-activated", { detail: { presetId } }))
        }
      } else {
        const data = await response.json()
        throw new Error(data.error || "Failed to activate preset")
      }
    } catch (error) {
      throw error
    }
  }

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000)
    const minutes = Math.floor(seconds / 60)
    const hours = Math.floor(minutes / 60)
    const days = Math.floor(hours / 24)

    if (days > 0) return `${days}d ${hours % 24}h`
    if (hours > 0) return `${hours}h ${minutes % 60}m`
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`
    return `${seconds}s`
  }

  const getStatusBadge = () => {
    if (!status) return <Badge variant="outline">Unknown</Badge>
    const intentRunning = status.operatorIntent === "running"
    const heartbeatFresh = status.workerAttached || status.connectionHeartbeatFresh || status.globalHeartbeatFresh
    if (!status.running && intentRunning && !heartbeatFresh) {
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-700">Queued / waiting for worker</Badge>
    }
    if (!status.running) return <Badge variant="secondary">Stopped</Badge>
    if (status.paused)
      return (
        <Badge variant="outline" className="bg-yellow-500/10 text-yellow-600">
          Paused
        </Badge>
      )
    return (
      <Badge variant="default" className="bg-green-500/10 text-green-600">
        Running
      </Badge>
    )
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Activity className="h-4 w-4" />
              Trade Engine
            </CardTitle>
          </div>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {/* Status Overview */}
        <div className="grid grid-cols-2 md:grid-cols-2 gap-2">
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Exchanges</p>
            <p className="text-lg font-bold">{status?.connectedExchanges || 0}</p>
          </div>
          <div className="space-y-0.5">
            <p className="text-xs text-muted-foreground">Positions</p>
            <p className="text-lg font-bold">{status?.activePositions || 0}</p>
          </div>
        </div>

        {/* Control Buttons */}
        <div className="flex gap-1.5 pt-2">
          {!status?.running && (
            <Button onClick={handleStart} disabled={isStarting} size="sm" className="flex-1 text-xs">
              <Play className="h-3 w-3 mr-1" />
              {isStarting ? "Starting..." : "Start"}
            </Button>
          )}

          {status?.running && !status?.paused && (
            <Button onClick={handlePause} disabled={isPausing} variant="outline" size="sm" className="flex-1 text-xs">
              <Pause className="h-3 w-3 mr-1" />
              {isPausing ? "..." : "Pause"}
            </Button>
          )}

          {status?.running && status?.paused && (
            <Button onClick={handleResume} disabled={isResuming} size="sm" className="flex-1 text-xs">
              <Play className="h-3 w-3 mr-1" />
              {isResuming ? "..." : "Resume"}
            </Button>
          )}

          {/* Stop button — always shown when running or paused */}
          {(status?.running || status?.paused) && (
            <Button
              onClick={handleStop}
              disabled={isStopping}
              variant="outline"
              size="sm"
              className="flex-1 text-xs text-red-600 hover:text-red-700 hover:bg-red-50 dark:hover:bg-red-950/30 border-red-200 dark:border-red-800"
            >
              <Square className="h-3 w-3 mr-1" />
              {isStopping ? "..." : "Stop"}
            </Button>
          )}

          {/* Preset Selection Button */}
          <Button
            onClick={() => setPresetDialogOpen(true)}
            variant="outline"
            size="sm"
            className="flex-1 text-xs"
          >
            <Target className="h-3 w-3 mr-1" />
            Preset
          </Button>
        </div>

        {status?.diagnosticHint && (
          <p className="text-xs text-amber-700 dark:text-amber-300">{status.diagnosticHint}</p>
        )}

        <PresetSelectionDialog
          open={presetDialogOpen}
          onOpenChange={setPresetDialogOpen}
          onSelectPreset={handleSelectPreset}
        />
      </CardContent>
    </Card>
  )
}
