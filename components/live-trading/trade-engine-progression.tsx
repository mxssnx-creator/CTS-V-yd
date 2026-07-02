'use client';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Progress } from "@/components/ui/progress"
import { Activity, TrendingUp, Clock, Zap } from "lucide-react"
import { useEffect, useState } from "react"
import { CONNECTION_STATE_CHANGED_EVENT, PROGRESSION_STATE_INVALIDATE_EVENT } from "@/lib/connection-events"

interface ProgressionData {
  connectionId: string
  connectionName: string
  exchange: string
  isEnabled: boolean
  isActive: boolean
  isLiveTrading: boolean
  engineState: string
  tradeCount: number
  lastUpdate: string | null
  pseudoPositionCount?: number
  progression?: {
    cyclesCompleted?: number
    successfulCycles?: number
    failedCycles?: number
    cycleSuccessRate?: number
    totalTrades?: number
    successfulTrades?: number
    totalProfit?: number
  }
}

export function TradeEngineProgression() {
  const [progressionData, setProgressionData] = useState<ProgressionData[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const fetchProgression = async () => {
      try {
        const response = await fetch("/api/trade-engine/progression")
        if (response.ok) {
          const data = await response.json()
          setProgressionData(data.connections || [])
          console.log("[v0] Fetched trade engine progression:", data)
        }
      } catch (error) {
        console.error("[v0] Failed to fetch progression:", error)
      } finally {
        setLoading(false)
      }
    }

    fetchProgression()

    const handleInvalidation = () => {
      fetchProgression()
    }

    window.addEventListener(PROGRESSION_STATE_INVALIDATE_EVENT, handleInvalidation)
    window.addEventListener(CONNECTION_STATE_CHANGED_EVENT, handleInvalidation)

    // Poll every 10 seconds
    const interval = setInterval(fetchProgression, 10000)
    return () => {
      clearInterval(interval)
      window.removeEventListener(PROGRESSION_STATE_INVALIDATE_EVENT, handleInvalidation)
      window.removeEventListener(CONNECTION_STATE_CHANGED_EVENT, handleInvalidation)
    }
  }, [])

  const getStateColor = (state: string) => {
    switch (state) {
      case "running":
        return "bg-green-100 text-green-800"
      case "initializing":
        return "bg-blue-100 text-blue-800"
      case "stopped":
        return "bg-gray-100 text-gray-800"
      case "error":
        return "bg-red-100 text-red-800"
      default:
        return "bg-yellow-100 text-yellow-800"
    }
  }

  const getStateIcon = (state: string) => {
      switch (state) {
        case "running":
          return <Zap className="h-4 w-4" />
        case "initializing":
          return <Clock className="h-4 w-4" />
        case "idle":
          return <TrendingUp className="h-4 w-4" />
        default:
          return <Activity className="h-4 w-4" />
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-5 w-5" />
          Trade Engine Activity
        </CardTitle>
        <CardDescription>Real-time trading engine status and progress</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading progression data...</p>
        ) : progressionData.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active connections found</p>
        ) : (
          <div className="space-y-4">
            {progressionData.map((conn) => (
              <div key={conn.connectionId} className="border rounded-lg p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="font-semibold flex items-center gap-2">
                      {conn.connectionName}
                      <Badge variant="outline" className="text-xs">
                        {conn.exchange}
                      </Badge>
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {conn.tradeCount} trades • {conn.pseudoPositionCount || 0} tracked positions • {conn.lastUpdate ? new Date(conn.lastUpdate).toLocaleString() : "Never"}
                    </div>
                  </div>
                  <Badge className={getStateColor(conn.engineState)}>
                    {getStateIcon(conn.engineState)}
                    <span className="ml-1">{conn.engineState}</span>
                  </Badge>
                </div>

                <div className="flex gap-2">
                  {!conn.isEnabled && (
                    <Badge variant="secondary" className="text-xs bg-gray-100">
                      Disabled
                    </Badge>
                  )}
                  {conn.isActive && (
                    <Badge variant="secondary" className="text-xs bg-green-50 text-green-700">
                      Active
                    </Badge>
                  )}
                  {conn.isLiveTrading && (
                    <Badge variant="secondary" className="text-xs bg-blue-50 text-blue-700">
                      Live Trading
                    </Badge>
                  )}
                </div>

                {conn.engineState === "running" && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Cycle Success</span>
                      <span>{Math.round(conn.progression?.cycleSuccessRate || 0)}%</span>
                    </div>
                    <Progress value={Math.max(5, Math.round(conn.progression?.cycleSuccessRate || 0))} className="h-2" />
                    <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
                      <div>Cycles: {conn.progression?.cyclesCompleted || 0}</div>
                      <div>Wins: {conn.progression?.successfulCycles || 0}</div>
                      <div>Fails: {conn.progression?.failedCycles || 0}</div>
                    </div>
                  </div>
                )}

                {conn.engineState === "initializing" && (
                  <div className="space-y-2">
                    <div className="flex justify-between text-xs">
                      <span>Initializing Engine</span>
                      <span>45%</span>
                    </div>
                    <Progress value={45} className="h-2" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
