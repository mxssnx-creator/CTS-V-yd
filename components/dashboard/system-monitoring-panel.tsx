"use client"

import { useState, useEffect } from "react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Activity } from "lucide-react"

interface CompactMonitor {
  engineCycles: number
  activePositions: number
  cpu: number
  memory: number
  redisKeys: number
  lastUpdate: string
}

export function SystemMonitoringPanel() {
  const [data, setData] = useState<CompactMonitor | null>(null)

  useEffect(() => {
    loadData()
    const interval = setInterval(loadData, 45000) // Increased from 8s to 45s
    return () => clearInterval(interval)
  }, [])

  const positiveNumber = (value: unknown): number | null => {
    const parsed = Number(value)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
  }

  const formatPercent = (value: number): string => {
    if (value > 0) return `${value}%`
    return "<0.1%"
  }

  const loadData = async () => {
    try {
      const [monitoringResponse, statsResponse] = await Promise.all([
        fetch(`/api/system/monitoring?t=${Date.now()}`, { cache: "no-store" }),
        fetch(`/api/main/system-stats-v3?t=${Date.now()}`, { cache: "no-store" }).catch(() => null),
      ])
      if (monitoringResponse.ok) {
        const mon = await monitoringResponse.json()
        const stats = statsResponse?.ok ? await statsResponse.json().catch(() => null) : null
        const cpu = positiveNumber(mon.cpu) ?? 0.1
        const memory = positiveNumber(mon.memory) ?? 0.1
        const dbKeys = positiveNumber(mon.database?.keys)
          ?? positiveNumber(mon.database?.totalKeys)
          ?? positiveNumber(stats?.database?.totalKeys)
          ?? positiveNumber(mon.database?.size)
          ?? -1

        setData({
          // Primary: indication cycles (live hash); fallback: strategy cycles
          engineCycles: mon.engines?.indications?.cycleCount || mon.engines?.strategies?.cycleCount || 0,
          activePositions: mon.database?.positions1h || 0,
          cpu: Number(mon.cpu ?? mon.system?.cpuUsage ?? 0),
          memory: Number(mon.memory ?? mon.system?.memoryUsage ?? 0),
          redisKeys: Number(mon.database?.keys ?? mon.database?.totalKeys ?? 0),
          lastUpdate: new Date().toLocaleTimeString(),
        })
      }
    } catch (err) {
      console.error("[Monitor] Error:", err)
    }
  }

  if (!data) return null

  return (
    <Card className="border-primary/10 bg-card/50">
      <CardContent className="p-3">
        <div className="flex items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-0.5">
            <Activity className="w-3 h-3 text-green-500" />
            <span className="text-muted-foreground">Engine</span>
            <span className="font-bold text-blue-600">{data.engineCycles}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Pos</span>
            <span className="font-bold text-purple-600">{data.activePositions}</span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">CPU</span>
            <span className={`font-bold ${data.cpu > 80 ? "text-red-600" : data.cpu > 60 ? "text-orange-600" : "text-green-600"}`}>
              {formatPercent(data.cpu)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">Mem</span>
            <span className={`font-bold ${data.memory > 80 ? "text-red-600" : data.memory > 60 ? "text-orange-600" : "text-green-600"}`}>
              {formatPercent(data.memory)}
            </span>
          </div>

          <div className="flex items-center gap-1">
            <span className="text-muted-foreground">DB</span>
            <span className="font-bold text-slate-600">{data.redisKeys > 0 ? data.redisKeys : "—"}</span>
          </div>

          <Badge variant="outline" className="text-xs h-5">{data.lastUpdate}</Badge>
        </div>
      </CardContent>
    </Card>
  )
}
