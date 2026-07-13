"use client"


export const dynamic = "force-dynamic"
import { Card, CardContent } from "@/components/ui/card"
import { useState, useMemo, useEffect } from "react"
import { Button } from "@/components/ui/button"
import { PresetCardCompact } from "@/components/presets/preset-card-compact"
import { Plus, RefreshCw, BarChart3, CheckCircle2, Target, TrendingUp } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { useExchange } from "@/lib/exchange-context"
import { PageHeader } from "@/components/page-header"

interface PresetTemplate {
  id: string
  name: string
  description: string
  strategyType: string
  symbol: string
  enabled: boolean
  config: {
    tp: number
    sl: number
    leverage: number
    volume: number
  }
  stats: {
    winRate: number
    avgProfit: number
    successCount: number
  }
}

export default function PresetsPage() {
  const { selectedConnectionId } = useExchange()
  const [presets, setPresets] = useState<PresetTemplate[]>([])
  const [isDemo, setIsDemo] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [sortBy, setSortBy] = useState<"name" | "profit" | "winrate">("profit")
  const [filterType, setFilterType] = useState<string | null>(null)

  // Load presets on mount and when connection changes
  useEffect(() => {
    const loadPresets = async () => {
      setIsLoading(true)
      try {
        // Determine which connection to use (fallback to demo if none selected)
        const connectionToUse = selectedConnectionId || "demo-mode"

        const response = await fetch(`/api/data/presets?connectionId=${encodeURIComponent(connectionToUse)}`)
        if (!response.ok) {
          throw new Error(`Failed to fetch presets: ${response.statusText}`)
        }

        const data = await response.json()
        if (data.success) {
          setPresets(data.data || [])
          setIsDemo(data.isDemo)
        } else {
          throw new Error(data.error || "Unknown error")
        }
      } catch (error) {
        console.error("[Presets] Failed to load:", error)
        toast.error("Failed to load presets")
        setPresets([])
      } finally {
        setIsLoading(false)
      }
    }

    loadPresets()
  }, [selectedConnectionId])

  const strategyTypes = Array.from(new Set(presets.map((p) => p.strategyType)))

  const filteredAndSorted = useMemo(() => {
    let result = [...presets]

    if (filterType) {
      result = result.filter((p) => p.strategyType === filterType)
    }

    switch (sortBy) {
      case "profit":
        result.sort((a, b) => b.stats.avgProfit - a.stats.avgProfit)
        break
      case "winrate":
        result.sort((a, b) => b.stats.winRate - a.stats.winRate)
        break
      case "name":
        result.sort((a, b) => a.name.localeCompare(b.name))
        break
    }

    return result
  }, [presets, sortBy, filterType])

  const stats = useMemo(() => {
    const total = presets.length
    const enabled = presets.filter((p) => p.enabled).length
    const avgProfit = total > 0 ? presets.reduce((sum, p) => sum + p.stats.avgProfit, 0) / total : 0
    const avgWinRate = total > 0 ? presets.reduce((sum, p) => sum + p.stats.winRate, 0) / total : 0

    return { total, enabled, avgProfit, avgWinRate }
  }, [presets])

  /*
   * Rewrote this page to:
   *   - Use the shared PageHeader so the spacing/typography matches the
   *     rest of the sidebar pages (previously it shipped a bespoke `<h1>`
   *     header out of alignment with Live Trading / Indications).
   *   - Replace hard-coded `bg-slate-50`, `text-blue-600`, etc. with
   *     design tokens + accent tints that survive dark mode.
   *   - Adopt the same "icon pill + stat number" pattern the other
   *     sidebar pages now use so the dashboard reads as one system.
   */
  return (
    <div className="p-4 space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader title="Trading Presets" description="Pre-configured strategy templates" />
        <div className="flex gap-2">
          <Button size="sm" className="h-8 text-xs">
            <Plus className="h-3 w-3 mr-1" />
            New Preset
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs">
            <RefreshCw className="h-3 w-3 mr-1" />
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {[
          { icon: BarChart3,   label: "Total",      value: stats.total, tint: "text-primary" },
          { icon: CheckCircle2,label: "Enabled",    value: stats.enabled, tint: "text-green-500" },
          { icon: TrendingUp,  label: "Avg Profit", value: stats.avgProfit.toFixed(2) + "%", tint: stats.avgProfit > 0 ? "text-green-500" : "text-red-500" },
          { icon: Target,      label: "Avg WR",     value: stats.avgWinRate.toFixed(0) + "%", tint: "text-primary" },
        ].map((stat) => (
          <Card key={stat.label} className="border-border bg-card">
            <CardContent className="p-2 flex items-center gap-2">
              <div className={`rounded bg-muted/60 p-1.5 ${stat.tint}`}>
                <stat.icon className="h-3.5 w-3.5" />
              </div>
              <div className="min-w-0">
                <div className={`text-base font-bold tabular-nums ${stat.tint}`}>{stat.value}</div>
                <div className="text-[10px] text-muted-foreground uppercase tracking-wide">{stat.label}</div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap text-xs px-3 py-2 bg-muted/40 rounded-md border border-border">
        <div className="flex gap-1 flex-wrap">
          <Button
            variant={filterType === null ? "default" : "outline"}
            size="sm"
            onClick={() => setFilterType(null)}
            className="h-7 text-xs"
          >
            All ({presets.length})
          </Button>
          {strategyTypes.map((type) => (
            <Button
              key={type}
              variant={filterType === type ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterType(type)}
              className="h-7 text-xs"
            >
              {type} ({presets.filter((p) => p.strategyType === type).length})
            </Button>
          ))}
        </div>
        <div className="flex gap-1">
          {([
            { k: "profit",  label: "Profit" },
            { k: "winrate", label: "Win Rate" },
            { k: "name",    label: "Name" },
          ] as const).map(({ k, label }) => (
            <Button
              key={k}
              variant={sortBy === k ? "default" : "outline"}
              size="sm"
              onClick={() => setSortBy(k)}
              className="h-7 text-xs"
            >
              {label}
            </Button>
          ))}
        </div>
      </div>

      <div className="space-y-1.5 max-h-[calc(100vh-300px)] overflow-y-auto">
        {filteredAndSorted.length > 0 ? (
          filteredAndSorted.map((preset) => (
            <PresetCardCompact
              key={preset.id}
              preset={preset}
              onToggle={(id, enabled) => {
                setPresets((prev) => prev.map((p) => (p.id === id ? { ...p, enabled } : p)))
              }}
              onStart={() => {
                toast.success("Preset started")
              }}
              onDelete={(id) => {
                setPresets((prev) => prev.filter((p) => p.id !== id))
                toast.success("Preset deleted")
              }}
              onDuplicate={(id) => {
                const preset = presets.find((p) => p.id === id)
                if (preset) {
                  setPresets((prev) => [
                    ...prev,
                    { ...preset, id: `${preset.id}-copy`, name: `${preset.name} (Copy)` },
                  ])
                  toast.success("Preset duplicated")
                }
              }}
            />
          ))
        ) : (
          <div className="text-center py-12 text-muted-foreground text-sm">
            No presets found
          </div>
        )}
      </div>
    </div>
  )
}
