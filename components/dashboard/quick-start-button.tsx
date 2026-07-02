"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import React, { useState } from "react"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Zap, Loader2, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import { DetailedLoggingDialog } from "./detailed-logging-dialog"
import { QuickstartOverviewDialog } from "./quickstart-overview-dialog"
import { SystemDetailPanel } from "./system-detail-panel"
import { SeedSystemDialog } from "./seed-system-dialog"
import { QuickstartTestProcedureDialog } from "./quickstart-test-procedure-dialog"
import { QuickstartFullSystemTestDialog } from "./quickstart-full-system-test-dialog"
import { EngineProcessingLogDialog } from "./engine-processing-log-dialog"
import { useExchange } from "@/lib/exchange-context"

interface QuickStartButtonProps {
  onQuickStartComplete?: () => void
}

interface QuickStartStep {
  id: string
  name: string
  status: "pending" | "loading" | "success" | "error"
  message?: string
}

interface FunctionalOverview {
  symbolsActive: number
  indicationsCalculated: number
  strategiesEvaluated: number
  baseSetsCreated: boolean
  mainSetsCreated: boolean
  realSetsCreated: boolean
  liveSetsCreated?: boolean
  positionsEntriesCreated: number
  counts?: {
    indicationCycles: number
    strategyCycles: number
    baseStrategies: number
    mainStrategies: number
    realStrategies: number
    liveStrategies: number
  }
}

interface OverallStats {
  symbols: {
    count: number
    processing: string[]
    prehistoricLoaded: number
    prehistoricDataSize: number
  }
  intervalsProcessed: number
  indicationsByType: {
    direction: number
    move: number
    active: number
    optimal: number
    auto: number
    total: number
  }
  pseudoPositions: {
    base: number
    baseByIndicationType: {
      direction: number
      move: number
      active: number
      optimal: number
    }
    main: number
    real: number
    total: number
  }
  livePositions: number
  cycleTimeMs: number
  totalDurationMs: number
}

export function QuickStartButton({ onQuickStartComplete }: QuickStartButtonProps) {
  const { setSelectedConnectionId } = useExchange()
  const [isRunning, setIsRunning] = useState(false)
  const [functionalOverview, setFunctionalOverview] = useState<FunctionalOverview | null>(null)
  const [overallStats, setOverallStats] = useState<OverallStats | null>(null)
  const [steps, setSteps] = useState<QuickStartStep[]>([
    { id: "init",    name: "Initialize System",              status: "pending" },
    { id: "migrate", name: "Run Migrations",                 status: "pending" },
    { id: "test",    name: "Verify BingX Credentials",       status: "pending" },
    { id: "start",   name: "Start Global Trade Engine",      status: "pending" },
    { id: "enable",  name: "Enable BingX (BTCUSDT)",         status: "pending" },
    { id: "engine",  name: "Launch Engine + Progression",    status: "pending" },
  ])

  const updateStep = (stepId: string, status: QuickStartStep["status"], message?: string) => {
    setSteps(prev => prev.map(s => s.id === stepId ? { ...s, status, message } : s))
  }

  // Run a step — non-required steps never block the sequence
  const runStep = async (
    id: string,
    label: string,
    fn: () => Promise<string>,
    required = false
  ): Promise<string | null> => {
    updateStep(id, "loading")
    try {
      const msg = await fn()
      updateStep(id, "success", msg)
      return msg
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (required) {
        updateStep(id, "error", msg)
        throw new Error(`${label} failed: ${msg}`)
      }
      updateStep(id, "success", "Skipped")
      return null
    }
  }

  // Timed fetch with configurable timeout (default 12s)
  const timedFetch = (url: string, opts?: RequestInit, ms = 12000): Promise<Response> =>
    Promise.race([
      fetch(url, { ...opts, cache: "no-store" }),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Timeout ${ms / 1000}s: ${url}`)), ms)),
    ])

  const handleQuickStart = async () => {
    setIsRunning(true)
    setFunctionalOverview(null)
    setSteps(prev => prev.map(s => ({ ...s, status: "pending", message: undefined })))

    let enabledConnectionId: string | null = null

    try {
      // STEP 1: Initialize (non-critical) - timeout: 15s
      await runStep("init", "STEP 1: Initialize System", async () => {
        const res = await timedFetch("/api/init", { method: "GET" }, 15000)
        return res.ok ? "System initialized" : "Already ready"
      })

      // STEP 2: Migrations (non-critical)
      await runStep("migrate", "STEP 2: Migrations", async () => {
        const res = await timedFetch("/api/install/database/migrate", { method: "POST" }, 20000)
        if (!res.ok) return "Up to date"
        const d = await res.json().catch(() => ({}))
        const n = d.migrations?.length ?? d.ranCount ?? 0
        return `${n} migration(s) applied`
      })

      // STEP 3: Verify BingX (non-critical - never blocks)
      let balanceInfo = ""
      await runStep("test", "STEP 3: Verify BingX Credentials", async () => {
        const res = await timedFetch("/api/settings/connections/test-bingx", { method: "GET" }, 20000)
        const d = await res.json().catch(() => ({}))
        if (d.success) {
          balanceInfo = d.connection?.testBalance ? ` | Balance: ${d.connection.testBalance}` : ""
          return `Ready - ${d.connection?.name ?? "BingX"}${balanceInfo}`
        }
        return `Credentials check: ${d.error ?? "skipped"}`
      })

      // STEP 4: Start global coordinator (REQUIRED)
      await runStep("start", "STEP 4: Start Global Coordinator", async () => {
        const res = await timedFetch("/api/trade-engine/start", { method: "POST" }, 20000)
        const d = await res.json().catch(() => ({}))
        if (!res.ok && !d.success) throw new Error(d.error ?? `HTTP ${res.status}`)
        const n = d.resumedConnections?.length ?? 0
        return `Coordinator running${n > 0 ? ` | Resumed ${n}` : ""}`
      }, true)

      // STEP 5: Enable BingX with 1 symbol (REQUIRED)
      let quickStartResponse: any = null
      await runStep("enable", "STEP 5: Enable BingX (1 Symbol)", async () => {
        const res = await timedFetch("/api/trade-engine/quick-start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "enable", symbols: ["BTCUSDT"] }),
        }, 25000)
        const d = await res.json().catch(() => ({}))
        quickStartResponse = d
        if (!res.ok && !d.success) throw new Error(d.error ?? `HTTP ${res.status}`)
        if (!d.success) throw new Error(d.error ?? "Enable returned failure")
        enabledConnectionId = d.connection?.id ?? null
        if (enabledConnectionId) {
          setSelectedConnectionId(enabledConnectionId)
        }
        if (d.overallStats) {
          setOverallStats(d.overallStats)
        }
        dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(d, {
          connectionId: enabledConnectionId ?? undefined,
          engine: { action: "enable", status: d.engine?.status ?? d.engineStatus },
          source: "quick-start-button.enable",
        }))
        const syms = Array.isArray(d.connection?.symbols)
          ? d.connection.symbols.join(", ")
          : "BTCUSDT"
        return `${d.connection?.name} enabled | ${syms}`
      }, true)

      // STEP 6: Launch per-connection engine (non-critical fallback)
      await runStep("engine", "STEP 6: Launch BingX Engine", async () => {
        const connId = enabledConnectionId
        if (!connId) return "Skipped - no connection ID"
        const res = await timedFetch(`/api/settings/connections/${connId}/live-trade`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ is_live_trade: true }),
        }, 30000)
        const d = await res.json().catch(() => ({}))
        if (res.ok && d.success) {
          dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(d, {
            connectionId: connId,
            engine: { action: "start", status: d.engineStatus },
            source: "quick-start-button.liveTrade",
          }))
          return `Engine running | Status: ${d.engineStatus}`
        }
        return `Queued (${d.error ?? d.message ?? "coordinator processing"})`
      })

      toast.success("Quick Start complete — BingX engine running with BTCUSDT.")

      // Fetch functional overview in background
      try {
        const res = await timedFetch("/api/trade-engine/functional-overview", {}, 6000)
        if (res.ok) {
          const d = await res.json()
          setFunctionalOverview(d)
        }
      } catch {
        // Non-critical: overview unavailable
      }

      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent("engine-state-changed", { detail: { running: true } }))
      }
      onQuickStartComplete?.()
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Unknown error"
      toast.error(`Quick Start failed: ${msg}`)
    } finally {
      setIsRunning(false)
    }
  }

  const getStepIcon = (status: QuickStartStep["status"]) => {
    switch (status) {
      case "loading":
        return <Loader2 className="w-4 h-4 animate-spin text-blue-500" />
      case "success":
        return <CheckCircle2 className="w-4 h-4 text-green-500" />
      case "error":
        return <AlertCircle className="w-4 h-4 text-red-500" />
      default:
        return <div className="w-4 h-4 rounded-full border-2 border-gray-300" />
    }
  }

  return (
    <Card className="border-blue-200 bg-blue-50">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="text-lg flex items-center gap-2">
              <Zap className="w-5 h-5 text-blue-600" />
              Quick Start (BingX)
            </CardTitle>
            <CardDescription>
              Initialize system, run migrations, test connection, enable BingX, and start trade engine in one click
            </CardDescription>
          </div>
          <Badge variant="outline" className="text-xs">
            {isRunning ? "Running..." : "Ready"}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Steps Progress */}
        <div className="space-y-2">
          {steps.map((step) => (
            <div key={step.id} className="flex items-center gap-3 text-sm">
              {getStepIcon(step.status)}
              <span className="flex-1 font-medium">{step.name}</span>
              {step.message && <span className="text-xs text-gray-600">{step.message}</span>}
            </div>
          ))}
        </div>

        {/* Action Buttons */}
        <div className="flex gap-2 pt-2">
          <Button
            onClick={handleQuickStart}
            disabled={isRunning}
            className="flex-1 gap-2"
            variant="default"
          >
            {isRunning ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Running Quick Start...
              </>
            ) : (
              <>
                <Zap className="w-4 h-4" />
                Start Quick Setup
              </>
            )}
          </Button>
           <Button
             onClick={() => {
               setSteps(steps.map(s => ({ ...s, status: "pending", message: undefined })))
               setIsRunning(false)
             }}
             disabled={isRunning}
             variant="outline"
             size="icon"
           >
             <RefreshCw className="w-4 h-4" />
           </Button>
           
           {/* System Detail Panel button */}
           <SystemDetailPanel />

           {/* Main / Log Overview button */}
           <QuickstartOverviewDialog />

            {/* Detailed Logs Button */}
            <DetailedLoggingDialog />
            
            {/* Seed 2.0 System Monitor Button */}
            <SeedSystemDialog />

             {/* System Test Procedure Dialog */}
             <QuickstartTestProcedureDialog />

             {/* Full System Monitor Test Dialog */}
             <QuickstartFullSystemTestDialog />

             {/* Engine Processing Live Log Dialog */}
             <EngineProcessingLogDialog />
         </div>

        {/* Info Box */}
        <div className="bg-white rounded border border-blue-200 p-3 text-xs text-gray-600">
          <p className="mb-2 font-semibold text-gray-700">This quick start will:</p>
          <ul className="list-disc list-inside space-y-1">
          <li>Initialize the complete system (preset types, connections)</li>
            <li>Run ALL database migrations (schema, indexes, TTL policies)</li>
            <li>Test BingX API connection (verify credentials & check balance)</li>
            <li>Start the trade engine</li>
            <li>Enable BingX for active trading with BTCUSDT</li>
          </ul>
        </div>

        {/* Functional Overview - Displayed after successful completion */}
        {(functionalOverview || overallStats) && (
          <div className="bg-green-50 rounded border border-green-200 p-3 text-xs">
            <p className="mb-2 font-semibold text-green-700">Functional Overview (System Ready):</p>
            <div className="grid grid-cols-2 gap-2 text-gray-700">
              {functionalOverview && (
                <>
                  <div>
                    <span className="font-medium">Symbols Active:</span> {functionalOverview.symbolsActive}
                  </div>
                  <div>
                    <span className="font-medium">Indication Cycles:</span> {functionalOverview.counts?.indicationCycles || functionalOverview.indicationsCalculated}
                  </div>
                  <div>
                    <span className="font-medium">Strategy Cycles:</span> {functionalOverview.counts?.strategyCycles || 0}
                  </div>
                  <div>
                    <span className="font-medium">Strategies Evaluated:</span> {functionalOverview.strategiesEvaluated}
                  </div>
                  <div>
                    <span className="font-medium">Base Strategies:</span> {functionalOverview.counts?.baseStrategies || (functionalOverview.baseSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Main Strategies:</span> {functionalOverview.counts?.mainStrategies || (functionalOverview.mainSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Real Strategies:</span> {functionalOverview.counts?.realStrategies || (functionalOverview.realSetsCreated ? "Active" : "0")}
                  </div>
                  <div>
                    <span className="font-medium">Live Strategies:</span> {functionalOverview.counts?.liveStrategies || (functionalOverview.liveSetsCreated ? "Active" : "0")}
                  </div>
                  <div className="col-span-2">
                    <span className="font-medium">DB Position Entries:</span> {functionalOverview.positionsEntriesCreated}
                  </div>
                </>
              )}
            </div>
          </div>
        )}

        {/* Data Overview - Comprehensive prehistoric and processing stats */}
        {overallStats && (
          <div className="bg-amber-50 rounded border border-amber-200 p-3 text-xs space-y-2">
            <p className="mb-2 font-semibold text-amber-700">Data Overview (Prehistoric & Processing):</p>
            
            {/* Prehistoric Data */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-white rounded p-2 text-center">
                <div className="text-amber-700 font-bold">{overallStats.symbols.prehistoricLoaded}</div>
                <div className="text-muted-foreground text-[10px]">Prehistoric Symbols</div>
              </div>
              <div className="bg-white rounded p-2 text-center">
                <div className="text-amber-700 font-bold">{overallStats.symbols.prehistoricDataSize}</div>
                <div className="text-muted-foreground text-[10px]">Data Keys</div>
              </div>
            </div>

            {/* Intervals */}
            <div className="bg-white rounded p-2 text-center">
              <div className="text-blue-700 font-bold">{overallStats.intervalsProcessed}</div>
              <div className="text-muted-foreground text-[10px]">Intervals Processed</div>
            </div>

            {/* Indications by Type */}
            <div className="space-y-1">
              <div className="text-muted-foreground text-[10px] font-medium">Indications by Type:</div>
              <div className="grid grid-cols-5 gap-1">
                <div className="bg-purple-50 rounded p-1 text-center">
                  <div className="text-purple-700 font-bold text-sm">{overallStats.indicationsByType.direction}</div>
                  <div className="text-muted-foreground text-[8px]">Dir</div>
                </div>
                <div className="bg-purple-50 rounded p-1 text-center">
                  <div className="text-purple-700 font-bold text-sm">{overallStats.indicationsByType.move}</div>
                  <div className="text-muted-foreground text-[8px]">Move</div>
                </div>
                <div className="bg-purple-50 rounded p-1 text-center">
                  <div className="text-purple-700 font-bold text-sm">{overallStats.indicationsByType.active}</div>
                  <div className="text-muted-foreground text-[8px]">Act</div>
                </div>
                <div className="bg-purple-50 rounded p-1 text-center">
                  <div className="text-purple-700 font-bold text-sm">{overallStats.indicationsByType.optimal}</div>
                  <div className="text-muted-foreground text-[8px]">Opt</div>
                </div>
                <div className="bg-purple-50 rounded p-1 text-center">
                  <div className="text-purple-700 font-bold text-sm">{overallStats.indicationsByType.auto}</div>
                  <div className="text-muted-foreground text-[8px]">Auto</div>
                </div>
              </div>
              <div className="text-center text-purple-600 text-[10px]">
                Total: <span className="font-bold">{overallStats.indicationsByType.total}</span>
              </div>
            </div>

            {/* Pseudo Positions */}
            <div className="space-y-1">
              <div className="text-muted-foreground text-[10px] font-medium">Pseudo Positions:</div>
              <div className="grid grid-cols-4 gap-1">
                <div className="bg-green-50 rounded p-1 text-center">
                  <div className="text-green-700 font-bold text-sm">{overallStats.pseudoPositions.base}</div>
                  <div className="text-muted-foreground text-[8px]">Base</div>
                </div>
                <div className="bg-green-50 rounded p-1 text-center">
                  <div className="text-green-700 font-bold text-sm">{overallStats.pseudoPositions.main}</div>
                  <div className="text-muted-foreground text-[8px]">Main</div>
                </div>
                <div className="bg-green-50 rounded p-1 text-center">
                  <div className="text-green-700 font-bold text-sm">{overallStats.pseudoPositions.real}</div>
                  <div className="text-muted-foreground text-[8px]">Real</div>
                </div>
                <div className="bg-green-50 rounded p-1 text-center">
                  <div className="text-green-700 font-bold text-sm">{overallStats.livePositions}</div>
                  <div className="text-muted-foreground text-[8px]">Live</div>
                </div>
              </div>
            </div>

            {/* Timing */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-orange-50 rounded p-2 text-center">
                <div className="text-orange-700 font-bold">{overallStats.cycleTimeMs}</div>
                <div className="text-muted-foreground text-[10px]">Cycle Time (ms)</div>
              </div>
              <div className="bg-orange-50 rounded p-2 text-center">
                <div className="text-orange-700 font-bold">{overallStats.totalDurationMs}</div>
                <div className="text-muted-foreground text-[10px]">Total Duration (ms)</div>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
