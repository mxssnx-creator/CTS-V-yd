'use client'

import { useState, useEffect } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Activity, CheckCircle2, Circle } from 'lucide-react'
import type { ProcessingMetrics } from '@/lib/processing-metrics'

interface ProcessingProgressPanelProps {
  connectionId?: string
}

export function ProcessingProgressPanel({ connectionId }: ProcessingProgressPanelProps) {
  const [metrics, setMetrics] = useState<ProcessingMetrics | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connectionId || connectionId === 'demo-mode') {
      setLoading(false)
      return
    }

    const fetchMetrics = async () => {
      try {
        const response = await fetch(`/api/metrics/processing?connectionId=${encodeURIComponent(connectionId)}`)
        if (!response.ok) throw new Error('Failed to fetch metrics')
        const data = await response.json()
        if (data.success) {
          setMetrics(data.data.current)
          setError(null)
        } else {
          setError(data.error)
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Unknown error')
      } finally {
        setLoading(false)
      }
    }

    fetchMetrics()
    const interval = setInterval(fetchMetrics, 5000)
    return () => clearInterval(interval)
  }, [connectionId])

  // ── Combined pipeline progress ────────────────────────────────────────────
  // All stages are one pipeline — Historical → Indications → Strategies → Live.
  // Divided into three equal segments (33 / 33 / 34) so the single bar
  // advances continuously as the engine moves through each stage without
  // jumping or resetting between them.
  const combinedProgress = (() => {
    if (!metrics) return 0
    const prehistoric = metrics.phases.prehistoric
    const realtime    = metrics.phases.realtime
    const indication  = metrics.phases.indication
    const strategy    = metrics.phases.strategy

    // Segment 1: Prehistoric (0–33)
    if (prehistoric.status !== 'completed') {
      return (Math.min(100, prehistoric.progress) / 100) * 33
    }
    // Segment 2: Indications (33–66)
    if (indication.status !== 'completed') {
      return 33 + (Math.min(100, indication.progress) / 100) * 33
    }
    // Segment 3: Strategies / Realtime (66–100)
    const stratPct = strategy.status === 'completed'
      ? 100
      : Math.max(realtime.progress, strategy.progress)
    return 66 + (Math.min(100, stratPct) / 100) * 34
  })()

  const overallStatus = (() => {
    if (!metrics) return 'idle'
    const phases = Object.values(metrics.phases)
    if (phases.some(p => p.status === 'error')) return 'error'
    if (phases.some(p => p.status === 'running')) return 'running'
    if (phases.every(p => p.status === 'completed')) return 'completed'
    return 'idle'
  })()

  const pipelineStages: Array<{ key: string; label: string; status: string }> = metrics
    ? [
        { key: 'prehistoric', label: 'Historical',  status: metrics.phases.prehistoric.status },
        { key: 'indication',  label: 'Indications', status: metrics.phases.indication.status  },
        { key: 'strategy',    label: 'Strategies',  status: metrics.phases.strategy.status    },
        { key: 'realtime',    label: 'Live',         status: metrics.phases.realtime.status    },
      ]
    : [
        { key: 'prehistoric', label: 'Historical',  status: 'idle' },
        { key: 'indication',  label: 'Indications', status: 'idle' },
        { key: 'strategy',    label: 'Strategies',  status: 'idle' },
        { key: 'realtime',    label: 'Live',         status: 'idle' },
      ]

  return (
    <Card className="bg-gradient-to-br from-slate-900 to-slate-800 border-slate-700">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm font-medium text-slate-300 flex items-center gap-2">
          <Activity className="w-4 h-4" />
          Processing Pipeline
          {metrics && (
            <Badge
              variant="outline"
              className={`ml-auto text-[10px] py-0 px-1 ${
                overallStatus === 'completed'
                  ? 'bg-green-900 text-green-200 border-green-700'
                  : overallStatus === 'running'
                    ? 'bg-blue-900 text-blue-200 border-blue-700'
                    : overallStatus === 'error'
                      ? 'bg-red-900 text-red-200 border-red-700'
                      : 'bg-slate-700 text-slate-300 border-slate-600'
              }`}
            >
              {overallStatus}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {loading && (
          <div className="text-slate-400">Loading...</div>
        )}

        {!loading && (error || !metrics) && (
          <div className="text-slate-400 text-xs">
            {error ? `Error: ${error}` : 'No data yet — start the engine to see pipeline progress.'}
          </div>
        )}

        {/* ── Combined progress bar ── */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[10px]">
            <span className="text-slate-400">Combined Progress</span>
            <span className="text-slate-200 tabular-nums font-medium">{combinedProgress.toFixed(0)}%</span>
          </div>
          <div className="w-full bg-slate-700 rounded h-2 overflow-hidden">
            <div
              className="h-full rounded transition-all duration-500"
              style={{
                width: `${Math.min(100, combinedProgress)}%`,
                background: combinedProgress >= 100
                  ? '#22c55e'
                  : 'linear-gradient(to right, #3b82f6, #22c55e)',
              }}
            />
          </div>
        </div>

        {/* ── Stage pills — no individual loops, one pipeline ── */}
        <div className="flex flex-wrap gap-1.5">
          {pipelineStages.map(({ key, label, status }) => (
            <div
              key={key}
              className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[10px] ${
                status === 'completed'
                  ? 'border-green-700/60 bg-green-900/30 text-green-300'
                  : status === 'running'
                    ? 'border-blue-700/60 bg-blue-900/30 text-blue-300'
                    : status === 'error'
                      ? 'border-red-700/60 bg-red-900/30 text-red-300'
                      : 'border-slate-700/60 bg-slate-800/30 text-slate-500'
              }`}
            >
              {status === 'completed'
                ? <CheckCircle2 className="w-2.5 h-2.5 shrink-0" />
                : status === 'running'
                  ? <span className="relative flex h-1.5 w-1.5 shrink-0"><span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75" /><span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-blue-400" /></span>
                  : <Circle className="w-2.5 h-2.5 opacity-30 shrink-0" />
              }
              {label}
            </div>
          ))}
        </div>

        {/* ── Summary metrics ── */}
        {metrics && (
          <>
            <div className="pt-2 border-t border-slate-700 space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-400">Avg Cycle Duration:</span>
                <span className="text-slate-200 font-medium">{metrics.performanceMetrics.avgCycleDuration.toFixed(0)}ms</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Total Processing Time:</span>
                <span className="text-slate-200 font-medium">{(metrics.performanceMetrics.totalProcessingTime / 1000).toFixed(1)}s</span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-700 space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-400">Positions Created:</span>
                <span className="text-slate-200 font-medium">{metrics.pseudoPositions.totalCreated}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Positions Active:</span>
                <span className="text-green-400 font-medium">{metrics.pseudoPositions.currentActive}</span>
              </div>
            </div>

            <div className="pt-2 border-t border-slate-700 text-slate-500 text-xs">
              Last updated: {new Date(metrics.timestamp).toLocaleTimeString()}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}
