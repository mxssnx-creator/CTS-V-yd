"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { CheckCircle, AlertCircle, XCircle, Activity, RefreshCw, Play, Square, Clock, BarChart3 } from "lucide-react"

interface EngineStatus {
  connectionId: string
  connectionName: string
  status: "running" | "stopped" | "error" | "idle"
  health: {
    overall: "healthy" | "degraded" | "unhealthy"
    components: {
      indications: ComponentHealth
      strategies: ComponentHealth
      realtime: ComponentHealth
    }
  }
  metrics: {
    indicationCycleCount: number
    strategyCycleCount: number
    realtimeCycleCount: number
    indicationAvgDuration: number
    strategyAvgDuration: number
    realtimeAvgDuration: number
    cycleTimeMs?: number
  }
  summary?: {
    symbolsActive?: number
    prehistoricDataSize?: number
    indicationTypes?: { direction?: number; move?: number; active?: number; optimal?: number; auto?: number; total?: number }
    strategyCounts?: { base?: number; main?: number; real?: number }
    realtimeCycles?: number
  }
}

interface ComponentHealth {
  status: "healthy" | "degraded" | "unhealthy"
  lastCycleDuration: number
  errorCount: number
  successRate: number
}

export function TradeEngineStatus() {
  const [enginesStatus, setEnginesStatus] = useState<EngineStatus[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [globalStatus, setGlobalStatus] = useState<{
    isRunning: boolean
    queued: boolean
    activeEngines: number
    totalConnections: number
  }>({ isRunning: false, queued: false, activeEngines: 0, totalConnections: 0 })

  const loadEnginesStatus = async () => {
    setIsLoading(true)
    try {
      // Get global status
      const globalResponse = await fetch("/api/trade-engine/status")
      if (globalResponse.ok) {
        const globalData = await globalResponse.json()
        setGlobalStatus({
          isRunning: globalData.actualRuntimeStatus === "running" || globalData.running === true,
          queued: globalData.actualRuntimeStatus === "queued",
          activeEngines: globalData.activeEngineCount,
          totalConnections: globalData.connections?.length || 0,
        })

        // Get individual engine statuses
        const engines: EngineStatus[] = []
        for (const conn of globalData.connections || []) {
          const connResponse = await fetch(`/api/trade-engine/${conn.id}/status`)
          if (connResponse.ok) {
            const connData = await connResponse.json()
            engines.push({
              connectionId: conn.id,
              connectionName: conn.name,
              status: connData.status || "idle",
              health: connData.health || {
                overall: "healthy",
                components: {
                  indications: {
                    status: "healthy",
                    lastCycleDuration: 0,
                    errorCount: 0,
                    successRate: 100,
                  },
                  strategies: {
                    status: "healthy",
                    lastCycleDuration: 0,
                    errorCount: 0,
                    successRate: 100,
                  },
                  realtime: {
                    status: "healthy",
                    lastCycleDuration: 0,
                    errorCount: 0,
                    successRate: 100,
                  },
                },
              },
              metrics: {
                indicationCycleCount: connData.indication_cycle_count || 0,
                strategyCycleCount: connData.strategy_cycle_count || 0,
                realtimeCycleCount: connData.realtime_cycle_count || 0,
                indicationAvgDuration: connData.indication_avg_duration_ms || 0,
                strategyAvgDuration: connData.strategy_avg_duration_ms || 0,
                realtimeAvgDuration: connData.realtime_avg_duration_ms || 0,
              },
            })
          }
        }
        setEnginesStatus(engines)
      }
    } catch (error) {
      console.error("[v0] Failed to load trade engine status:", error)
    } finally {
      setIsLoading(false)
    }
  }

  const startEngine = async (connectionId: string) => {
    try {
      const response = await fetch("/api/trade-engine/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectionId }),
      })

      if (response.ok) {
        await loadEnginesStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to start engine:", error)
    }
  }

  const stopEngine = async (connectionId: string) => {
    try {
      const response = await fetch(`/api/trade-engine/${connectionId}/stop`, {
        method: "POST",
      })

      if (response.ok) {
        await loadEnginesStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to stop engine:", error)
    }
  }

  const startAllEngines = async () => {
    try {
      const response = await fetch("/api/trade-engine/start", {
        method: "POST",
      })

      if (response.ok) {
        await loadEnginesStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to start all engines:", error)
    }
  }

  const stopAllEngines = async () => {
    try {
      const response = await fetch("/api/trade-engine/stop", {
        method: "POST",
      })

      if (response.ok) {
        await loadEnginesStatus()
      }
    } catch (error) {
      console.error("[v0] Failed to stop all engines:", error)
    }
  }

  useEffect(() => {
    loadEnginesStatus()
    const interval = setInterval(loadEnginesStatus, 10000) // Update every 10 seconds
    return () => clearInterval(interval)
  }, [])

  const getHealthIcon = (status: "healthy" | "degraded" | "unhealthy") => {
    switch (status) {
      case "healthy":
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case "degraded":
        return <AlertCircle className="h-5 w-5 text-yellow-500" />
      case "unhealthy":
        return <XCircle className="h-5 w-5 text-red-500" />
    }
  }

  const getHealthColor = (status: "healthy" | "degraded" | "unhealthy") => {
    switch (status) {
      case "healthy":
        return "text-green-500"
      case "degraded":
        return "text-yellow-500"
      case "unhealthy":
        return "text-red-500"
    }
  }

  return (
    <div className="space-y-4">
      {/* Global Controls */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Trade Engine Coordinator</CardTitle>
              <CardDescription>Real-time status and control for all trade engines</CardDescription>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={loadEnginesStatus} disabled={isLoading}>
                <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              {globalStatus.isRunning ? (
                <Button variant="destructive" size="sm" onClick={stopAllEngines}>
                  <Square className="h-4 w-4 mr-2" />
                  Stop All
                </Button>
              ) : (
                <Button variant="default" size="sm" onClick={startAllEngines}>
                  <Play className="h-4 w-4 mr-2" />
                  Start All
                </Button>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <span className="text-sm font-medium">Active Engines</span>
              </div>
              <div className="text-2xl font-bold">
                {globalStatus.activeEngines}/{globalStatus.totalConnections}
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-sm font-medium">Status</span>
              <div>
                <Badge variant={globalStatus.isRunning ? "default" : "secondary"}>
                  {globalStatus.isRunning ? "RUNNING" : (globalStatus.queued ? "QUEUED / WAITING FOR WORKER" : "STOPPED")}
                </Badge>
              </div>
            </div>
            <div className="space-y-1">
              <span className="text-sm font-medium">Total Cycles</span>
              <div className="text-2xl font-bold">
                {enginesStatus.reduce((sum, e) => sum + e.metrics.strategyCycleCount, 0)}
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Individual Engine Status */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {enginesStatus.map((engine) => (
          <Card key={engine.connectionId}>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base">{engine.connectionName}</CardTitle>
                  <CardDescription className="text-xs">{engine.connectionId}</CardDescription>
                </div>
                <div className="flex items-center gap-2">
                  {getHealthIcon(engine.health.overall)}
                  <Badge
                    variant={
                      engine.status === "running" ? "default" : engine.status === "error" ? "destructive" : "secondary"
                    }
                  >
                    {engine.status}
                  </Badge>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4 max-h-[70vh] overflow-y-auto">
              {/* Component Health */}
              <div className="space-y-2">
                <div className="text-xs font-medium text-muted-foreground">Component Health</div>
                {Object.entries(engine.health.components).map(([name, component]) => (
                  <div key={name} className="flex items-center justify-between text-sm">
                    <span className="capitalize">{name}</span>
                    <div className="flex items-center gap-2">
                      <Progress value={component.successRate} className="w-24 h-2" />
                      <span className={`text-xs font-medium ${getHealthColor(component.status)}`}>
                        {component.successRate.toFixed(0)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>

              {/* Performance Metrics */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
                <div>
                  <div className="text-muted-foreground">Indications</div>
                  <div className="font-medium">{engine.metrics.indicationCycleCount}</div>
                  <div className="text-muted-foreground">{engine.metrics.indicationAvgDuration.toFixed(0)}ms</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Strategies</div>
                  <div className="font-medium">{engine.metrics.strategyCycleCount}</div>
                  <div className="text-muted-foreground">{engine.metrics.strategyAvgDuration.toFixed(0)}ms</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Realtime</div>
                  <div className="font-medium">{engine.metrics.realtimeCycleCount}</div>
                  <div className="text-muted-foreground">{engine.metrics.realtimeAvgDuration.toFixed(0)}ms</div>
                </div>
              </div>

              {engine.summary && (
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[10px] border-t pt-3">
                  <div><span className="text-muted-foreground">Symbols:</span> {engine.summary.symbolsActive || 0}</div>
                  <div><span className="text-muted-foreground">Prehistoric:</span> {engine.summary.prehistoricDataSize || 0}</div>
                  <div><span className="text-muted-foreground">Cycle(ms):</span> {engine.metrics.cycleTimeMs || 0}</div>
                  <div><span className="text-muted-foreground">Realtime Cycles:</span> {engine.summary.realtimeCycles || 0}</div>
                </div>
              )}
              {/* Controls */}
              <div className="flex gap-2">
                {engine.status === "running" ? (
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => stopEngine(engine.connectionId)}
                    className="flex-1"
                  >
                    <Square className="h-3 w-3 mr-1" />
                    Stop
                  </Button>
                ) : (
                  <Button
                    variant="default"
                    size="sm"
                    onClick={() => startEngine(engine.connectionId)}
                    className="flex-1"
                  >
                    <Play className="h-3 w-3 mr-1" />
                    Start
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {enginesStatus.length === 0 && !isLoading && (
        <Card>
          <CardContent className="py-12 text-center">
            <Activity className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-semibold mb-2">No Trade Engines Found</h3>
            <p className="text-sm text-muted-foreground mb-4">
              Create a connection in Settings to start monitoring trade engines
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
