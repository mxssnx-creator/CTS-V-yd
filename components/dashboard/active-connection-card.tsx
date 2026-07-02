"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import { useState, useEffect, useCallback, useRef } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import {
  ChevronDown,
  Info,
  Settings2,
  Trash2,
  Loader2,
  Wifi,
  WifiOff,
  Clock,
  Activity,
} from "lucide-react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { ConnectionInfoDialog } from "@/components/settings/connection-info-dialog"
import { ConnectionSettingsDialog } from "@/components/settings/connection-settings-dialog"
import { ProgressionLogsDialog } from "@/components/dashboard/progression-logs-dialog"
// ── Additional diagnostic dialogs surfaced for operator review ─────
// All three render their own button + DialogTrigger, so they slot in
// as buttons inside the "Diagnostic Tools" row at the bottom of the
// expanded card. The operator can compare them side-by-side and decide
// which to keep / consolidate later.
import { ConnectionDetailedLogDialog } from "@/components/dashboard/connection-detailed-log-dialog"
import { EngineProcessingLogDialog }   from "@/components/dashboard/engine-processing-log-dialog"
import { DetailedLoggingDialog }       from "@/components/dashboard/detailed-logging-dialog"
import { VolumeConfigurationPanel } from "@/components/dashboard/volume-configuration-panel"
import { DEFAULT_VOLUME_STEP_RATIO } from "@/lib/constants"
import { OrderSettingsPanel } from "@/components/dashboard/order-settings-panel"
import { MainTradeCard } from "@/components/dashboard/main-trade-card"
import { PresetTradeCard } from "@/components/dashboard/preset-trade-card"
import type { Connection } from "@/lib/db-types"
import type { ActiveConnection } from "@/lib/active-connections"
import { toast } from "@/lib/simple-toast"

interface ProgressionData {
  phase: string
  progress: number
  message: string
  subPhase: string | null
  startedAt: string | null
  updatedAt: string | null
  details: {
    historicalDataLoaded: boolean
    indicationsCalculated: boolean
    strategiesProcessed: boolean
    liveProcessingActive: boolean
    liveTradingActive: boolean
  }
  prehistoricProgress?: {
    symbolsProcessed: number
    symbolsTotal: number
    candlesLoaded: number
    candlesTotal: number
    indicatorsCalculated: number
    currentSymbol: string
    duration: number
    percentComplete: number
  }
  error: string | null
}

const PHASE_LABELS: Record<string, string> = {
  disabled: "Disabled",
  idle: "Idle",
  initializing: "Initializing",
  prehistoric_data: "Loading Historical Data",
  indications: "Processing Indications",
  strategies: "Calculating Strategies",
  realtime: "Real-time Processing",
  live_trading: "Live Trading Active",
  stopped: "Stopped",
  error: "Error",
  unknown: "Starting Up",
}

const toBoolean = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true" || value === "yes" || value === "on"
const liveTradeUiFlag = (details: any): boolean =>
  toBoolean(details?.live_trade_requested) || toBoolean(details?.is_live_trade)

interface ActiveConnectionCardProps {
  connection: ActiveConnection & { details?: Connection }
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onToggle: (connectionId: string, desiredState: boolean) => Promise<void>
  onRemove: (connectionId: string, name: string) => Promise<void>
  isToggling: boolean
  isRemoving?: boolean
  globalEngineRunning: boolean
}

export function ActiveConnectionCard({
  connection,
  expanded,
  onExpand,
  onToggle,
  onRemove,
  isToggling,
  isRemoving = false,
  globalEngineRunning,
}: ActiveConnectionCardProps) {
  const [progression, setProgression] = useState<ProgressionData | null>(null)
  // Lightweight Real-stage averages + stage eval percentages, fetched on the
  // same poll cadence as progression (no extra timer).
  const [realAverages, setRealAverages] = useState<{
    activeSets: number
    posPerSet: number
    posOpen: number
  } | null>(null)
  const [stageEvalPercent, setStageEvalPercent] = useState<{
    base: number
    main: number
    real: number
  } | null>(null)
  const [infoDialogOpen, setInfoDialogOpen] = useState(false)
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false)
  const [logsDialogOpen, setLogsDialogOpen] = useState(false)
  // Seed live-trade / preset switches from the connection prop so they
  // render correctly on first mount before the engine-states poll fires.
  // The poll (every 3–8 s) then corrects any drift against the DB flag.
  const toInitBool = (v: unknown) =>
    v === true || v === 1 || v === "1" || v === "true"
  const [liveTrade, setLiveTrade] = useState(() =>
    liveTradeUiFlag(connection.details as any)
  )
  const [presetMode, setPresetMode] = useState(() =>
    toInitBool((connection.details as any)?.is_preset_trade)
  )
  const [liveTradeLoading, setLiveTradeLoading] = useState(false)
  const [presetModeLoading, setPresetModeLoading] = useState(false)
  // Refs that mirror the loading states — mutated synchronously so the
  // engine-states poller (a closure captured at effect-mount time) can
  // read the current value without stale-closure issues.
  const liveTradeLoadingRef  = useRef(false)
  const presetModeLoadingRef = useRef(false)
  const [liveVolumeFactor, setLiveVolumeFactor] = useState(0.1)
  const [presetVolumeFactor, setPresetVolumeFactor] = useState(0.1)
  const [volumeStepRatio, setVolumeStepRatio] = useState(DEFAULT_VOLUME_STEP_RATIO)
  const [orderType, setOrderType] = useState<"market" | "limit">("market")
  const [volumeType, setVolumeType] = useState<"usdt" | "contract">("usdt")
  const [mainTradeStatus, setMainTradeStatus] = useState<"idle" | "active" | "paused" | "stopped">("idle")
  const [presetTradeStatus, setPresetTradeStatus] = useState<"idle" | "active" | "paused" | "stopped">("idle")
  // Live engine-stats counters displayed under the progress bar
  // Ref to current phase — used inside stable interval callback to avoid recreating on every phase change
  const phaseRef = useRef<string>("idle")
  const [liveStats, setLiveStats] = useState<{
    indicationCycles: number
    strategyCycles: number
    indications: number
    strategies: number
    positions: number
  } | null>(null)
  const [prehistoricStats, setPrehistoricStats] = useState<{
    // Indication breakdown
    indicationsDirection: number
    indicationsMove: number
    indicationsActive: number
    indicationsOptimal: number
    indicationsAuto: number
    indicationsTotal: number
    // Strategy stages
    stratBase: number
    stratMain: number
    stratReal: number
    stratLive: number
    // Stage ratios and metrics
    basePassRatio: number
    mainPassRatio: number
    realPassRatio: number
    livePassRatio: number
    avgProfitFactorBase: number
    avgProfitFactorMain: number
    avgProfitFactorReal: number
    avgProfitFactorLive: number
    avgDrawdownTimeBase: number
    avgDrawdownTimeMain: number
    avgDrawdownTimeReal: number
    avgHoldTimeLive: number
    avgPosEvalReal: number
    avgPosEvalLive: number   // avg realised ROI per closed position
    // Evaluated / passed counts per stage
    baseEvaluated: number
    basePassed: number
    mainEvaluated: number
    mainPassed: number
    realEvaluated: number
    realPassed: number
    liveEvaluated: number
    livePassed: number
    countPosEvalReal: number
    countPosEvalLive: number
    liveTotalPnl: number
    liveAvgPnl: number
    liveAvgPosSizeUsd: number
    // Live exchange execution metrics
    liveOrdersPlaced: number
    liveOrdersFilled: number
    liveOrdersFailed: number
    liveOrdersRejected: number
    liveOrdersSimulated: number
    /**
     * Number of upstream Real-stage Set signals that were merged into
     * an already-open exchange position instead of creating a new one
     * (so we never spam the venue with duplicate orders for the same
     * symbol+direction). This is the canonical "Pos Accumulated"
     * counter the user wants surfaced at the Real → Live boundary.
     */
    liveOrdersAccumulated: number
    livePositionsCreated: number
    livePositionsClosed: number
    livePositionsOpen: number
    liveWins: number
    liveVolumeUsdTotal: number
    liveFillRate: number
    liveWinRate: number
    // ── Mirroring pipeline: open-position counts + Live USD ─────
    // Pseudo / Real / Live are the SAME signal mirrored through
    // evaluation stages — not additive pools. Volume lives only on
    // the Live exchange (real money). Pseudo and Real expose counts.
    pseudoOpen: number
    pseudoRunningSets: number
    realOpen: number
    liveOpenPositions: number
    liveVolumeUsd: number
    // ── Per-symbol roll-ups (live exchange) ─────────────────────
    // `liveBySymbol`     — open positions grouped by symbol/direction.
    //                       Source: `openPositions.live.bySymbol` from /stats.
    // `liveOrdersBySymbol` — cumulative placed/filled orders grouped by
    //                       symbol/direction. Source: `liveExecution.ordersBySymbol`.
    // Both surface in the Realtime Execution panel as "BTCUSDT L:2 S:1"
    // chip strips so the operator can read the per-symbol breakdown
    // without opening the positions dialog.
    liveBySymbol: Array<{
      symbol: string
      long: number
      short: number
      volumeUsd: number
      marginUsd: number
      unrealizedPnl: number
    }>
    liveOrdersBySymbol: Array<{
      symbol: string
      long:  { placed: number; filled: number }
      short: { placed: number; filled: number }
    }>
    // ── Portfolio-wide live aggregate (single canonical source) ─
    // Mirrored from `openPositions.live.aggregate.*`. Used for the
    // PnL / ROI labels in the Realtime Execution panel so the values
    // never diverge across render sites.
    liveAggUnrealizedPnl: number
    liveAggPortfolioRoiPct: number
    // Prehistoric metadata
    rangeDays: number
    timeframeSeconds: number
    intervalsProcessed: number
    missingIntervalsLoaded: number
    currentSymbol: string
    isComplete: boolean
  } | null>(null)
  // Live engine-running state — synced bidirectionally with the Enable / Live /
  // Preset sliders. The DB flag remains the source of truth for the slider's
  // `checked` value; this state lets the UI surface a drift indicator when the
  // engine actually running does not match the flag.
  const [engineStates, setEngineStates] = useState<{
    engineRunning: boolean
    runningHint: boolean
    enabled: { flag: boolean; running: boolean; inSync: boolean }
    live:    { flag: boolean; running: boolean; inSync: boolean }
    preset:  { flag: boolean; running: boolean; inSync: boolean }
  } | null>(null)
  const details = connection.details

  // Sync local toggle states and volume factors from connection details
  useEffect(() => {
    if (details) {
      setLiveTrade(liveTradeUiFlag(details))
      setPresetMode(toBoolean(details.is_preset_trade))
      setLiveVolumeFactor(Number(details.live_volume_factor) || 1.0)
      setPresetVolumeFactor(Number(details.preset_volume_factor) || 1.0)
      setVolumeStepRatio(Number(details.volume_step_ratio) || DEFAULT_VOLUME_STEP_RATIO)
      setOrderType(details.order_type as "market" | "limit" || "market")
      setVolumeType(details.volume_type as "usdt" | "contract" || "usdt")
    }
  }, [details])

  // Poll per-connection engine-states endpoint so the Enable / Live / Preset
  // sliders stay in sync with actual engine state. Uses a self-scheduling
  // timeout that picks a faster cadence when the connection is marked active.
  useEffect(() => {
    let cancelled = false
    let timeoutId: ReturnType<typeof setTimeout>

    const fetchEngineStates = async () => {
      try {
        const res = await fetch(
          `/api/connections/${connection.connectionId}/engine-states`,
          { cache: "no-store" }
        )
        if (!res.ok) return
        const data = await res.json()
        if (cancelled || !data?.success) return
        setEngineStates({
          engineRunning: !!data.engineRunning,
          runningHint:   !!data.runningHint,
          enabled: data.enabled,
          live:    data.live,
          preset:  data.preset,
        })
        // Re-sync local toggle state to the DB flag (authoritative) so drift
        // is corrected on every poll cycle. Guard: skip the write while a
        // toggle is in-flight — setLiveTradeLoading(true) sets the ref
        // synchronously, so if an in-progress POST hasn't landed yet the
        // poller won't flip the switch back to the old server value and
        // cause a visible flicker on the switch.
        if (typeof data?.live?.flag === "boolean" && !liveTradeLoadingRef.current) {
          setLiveTrade(data.live.flag)
        }
        if (typeof data?.preset?.flag === "boolean" && !presetModeLoadingRef.current) {
          setPresetMode(data.preset.flag)
        }
      } catch {
        /* non-critical polling */
      }
    }

    const scheduleNext = () => {
      const delay = connection.isActive ? 3000 : 8000
      timeoutId = setTimeout(async () => {
        await fetchEngineStates()
        if (!cancelled) scheduleNext()
      }, delay)
    }

    fetchEngineStates()
    scheduleNext()

    return () => {
      cancelled = true
      clearTimeout(timeoutId)
    }
  }, [connection.connectionId, connection.isActive])
  // Save volume factor changes to backend
  const handleLiveVolumeChange = useCallback(async (value: number) => {
    setLiveVolumeFactor(value)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/volume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ live_volume_factor: value }),
      })
      if (!res.ok) throw new Error("Failed to save live volume factor")
      window.dispatchEvent(new CustomEvent("connection-settings-updated", {
        detail: { connectionId: connection.connectionId, settings: { live_volume_factor: value, volume_factor_live: value } },
      }))
    } catch (error) {
      console.error("[v0] Failed to save live volume factor:", error)
    }
  }, [connection.connectionId])

  const handlePresetVolumeChange = useCallback(async (value: number) => {
    setPresetVolumeFactor(value)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/volume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_volume_factor: value }),
      })
      if (!res.ok) throw new Error("Failed to save preset volume factor")
      window.dispatchEvent(new CustomEvent("connection-settings-updated", {
        detail: { connectionId: connection.connectionId, settings: { preset_volume_factor: value, volume_factor_preset: value } },
      }))
    } catch (error) {
      console.error("[v0] Failed to save preset volume factor:", error)
    }
  }, [connection.connectionId])

  const handleVolumeStepRatioChange = useCallback(async (value: number) => {
    setVolumeStepRatio(value)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/volume`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ volume_step_ratio: value }),
      })
      if (!res.ok) throw new Error("Failed to save volume step ratio")
      window.dispatchEvent(new CustomEvent("connection-settings-updated", {
        detail: { connectionId: connection.connectionId, settings: { volume_step_ratio: value } },
      }))
    } catch (error) {
      console.error("[v0] Failed to save volume step ratio:", error)
    }
  }, [connection.connectionId])

  // Poll progression
  const fetchProgression = useCallback(async () => {
    try {
      const res = await fetch(`/api/connections/progression/${connection.connectionId}/stats`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      })
      if (res.ok) {
        const data = await res.json()
        if (res.ok) {
          // The /stats payload exposes prehistoric data under `historic`, not
          // `prehistoricProgress` (the shape the legacy /progression endpoint
          // used). Map it explicitly — otherwise every consumer of
          // progression.prehistoricProgress (Symbols X/N, candles, percent)
          // silently reads undefined and the numbers vanish from the UI.
          const h = data.historic
          const meta = data.metadata ?? {}
          const nextProgression: ProgressionData = {
            phase:     String(meta.phase    || data.phase    || "idle"),
            progress:  Number(meta.progress ?? data.progress ?? 0),
            message:   String(data.message  || meta.message  || ""),
            subPhase:  data.subPhase  != null ? String(data.subPhase)  : null,
            // startedAt/updatedAt may be epoch-ms numbers from metadata — convert to ISO string
            startedAt: (() => {
              const v = meta.startedAt ?? data.startedAt
              if (v == null) return null
              const n = Number(v)
              return Number.isFinite(n) && n > 1_000_000_000_000
                ? new Date(n).toISOString()
                : String(v)
            })(),
            updatedAt: (() => {
              const v = meta.lastUpdate ?? data.updatedAt
              if (v == null) return null
              const n = Number(v)
              return Number.isFinite(n) && n > 1_000_000_000_000
                ? new Date(n).toISOString()
                : String(v)
            })(),
            error:     data.error     != null && typeof data.error !== "object"
                         ? String(data.error)
                         : null,
            details: {
              historicalDataLoaded:  toBoolean(data.details?.historicalDataLoaded),
              indicationsCalculated: toBoolean(data.details?.indicationsCalculated),
              strategiesProcessed:   toBoolean(data.details?.strategiesProcessed),
              liveProcessingActive:  toBoolean(data.details?.liveProcessingActive),
              liveTradingActive:     toBoolean(data.details?.liveTradingActive),
            },
            prehistoricProgress: h
              ? {
                  symbolsProcessed:    Number(h.symbolsProcessed)    || 0,
                  symbolsTotal:        Number(h.symbolsTotal)        || 0,
                  candlesLoaded:       Number(h.candlesLoaded ?? h.framesProcessed) || 0,
                  candlesTotal:        Number(h.candlesTotal)        || 0,
                  indicatorsCalculated:Number(h.indicatorsCalculated)|| 0,
                  currentSymbol:       String(h.currentSymbol || ""),
                  duration:            Number(h.duration)            || 0,
                  percentComplete:     Number(h.progressPercent)     || 0,
                }
              : undefined,
          }
          setProgression(nextProgression as any)
          // Persist so the UI shows last-known progress immediately on reload
          // instead of blank/zero while the first poll completes.
          // NOTE: cache the SAME object we render — the previous code cached
          // `data.progression`, a key that does not exist in the /stats
          // payload, so reloads restored an empty {} and blanked the card.
          try {
            sessionStorage.setItem(
              `acc:progression:${connection.connectionId}`,
              JSON.stringify({ ...nextProgression, _cachedAt: Date.now() })
            )
          } catch { /* sessionStorage unavailable */ }
        }
      }
    } catch {
      // Non-critical polling — swallow silently
    }
    // Real-stage averaged counts + stage eval %. Folded into the same poll so
    // we don't spin up a second interval. Failures are non-fatal.
    try {
      const tRes = await fetch(`/api/connections/progression/${connection.connectionId}/tracking/strategies`, {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
      })
      if (tRes.ok) {
        const tData = await tRes.json()
        const tracking = tData?.tracking ?? tData
        if (tracking?.real?.averages) {
          setRealAverages({
            activeSets: Number(tracking.real.averages.activeSets) || 0,
            posPerSet: Number(tracking.real.averages.posPerSet) || 0,
            posOpen: Number(tracking.real.averages.posOpen) || 0,
          })
        }
        if (tracking?.stageEvalPercent) {
          setStageEvalPercent({
            base: Number(tracking.stageEvalPercent.base) || 0,
            main: Number(tracking.stageEvalPercent.main) || 0,
            real: Number(tracking.stageEvalPercent.real) || 0,
          })
        }
      }
    } catch {
      // Non-critical polling — swallow silently
    }
  }, [connection.connectionId])

  // Keep phaseRef current so the stable interval can read it without recreating
  useEffect(() => {
    phaseRef.current = progression?.phase || "idle"
  }, [progression?.phase])

  // Restore last-known progression from sessionStorage on mount so the card
  // shows previous progress immediately on page reload instead of blank.
  useEffect(() => {
    try {
      const cached = sessionStorage.getItem(`acc:progression:${connection.connectionId}`)
      if (cached) {
        const parsed = JSON.parse(cached)
        const age = Date.now() - (parsed._cachedAt ?? 0)
        if (age < 10 * 60 * 1000) {
          const { _cachedAt: _, ...prog } = parsed
          setProgression(prog)
        }
      }
    } catch { /* ignore corrupted data */ }

  }, [connection.connectionId])

  useEffect(() => {
    fetchProgression()

    // Single stable interval — reads phaseRef.current on each tick to decide the next delay.
    // Using a self-scheduling timeout so interval length adapts without recreating the effect.
    let timeoutId: ReturnType<typeof setTimeout>
    const scheduleNext = () => {
      const phase = phaseRef.current
      // Poll at 2 s during any actively-progressing or live phase.
      // live_trading needs fast refresh for order/position updates.
      // "unknown" means the engine just started — keep polling fast.
      const isActivePhase = phase &&
        phase !== "idle" &&
        phase !== "stopped" &&
        phase !== "disabled"
      const delay = isActivePhase ? 2000 : 5000
      timeoutId = setTimeout(async () => {
        await fetchProgression()
        scheduleNext()
      }, delay)
    }
    scheduleNext()

    const handleConnectionToggled = () => { fetchProgression() }
    const handleLiveTradeToggled = (event: Event) => {
      const customEvent = event as CustomEvent
      if (customEvent.detail?.connectionId === connection.connectionId) {
        // `live-trade-toggled` is fired by QuickstartOptionsBar when the user
        // toggles "Control Orders".  We do NOT apply newState here because:
        //   1. The card already has its own optimistic state when the card
        //      itself fires this event (handleLiveTradeToggle).
        //   2. Applying newState = true optimistically and then having the
        //      engine-states poll return flag: false causes the switch to
        //      visibly revert 3-8 s later — confusing and incorrect.
        // Instead, we just schedule an immediate re-fetch so the card picks
        // up the server's canonical live.flag as soon as possible.
        fetchProgression()
      }
    }
    const handleSettingsUpdated = (event: Event) => {
      const customEvent = event as CustomEvent
      if (customEvent.detail?.connectionId === connection.connectionId) {
        // `connection-settings-updated` carries { connectionId, settings } from volume sliders.
        // Apply any volume changes embedded in the settings bag.
        const updatedSettings = customEvent.detail?.settings || {}
        const liveFactor = Number(updatedSettings.live_volume_factor ?? updatedSettings.volume_factor_live)
        const presetFactor = Number(updatedSettings.preset_volume_factor ?? updatedSettings.volume_factor_preset)
        const stepRatio = Number(updatedSettings.volume_step_ratio)
        if (Number.isFinite(liveFactor) && liveFactor > 0) setLiveVolumeFactor(liveFactor)
        if (Number.isFinite(presetFactor) && presetFactor > 0) setPresetVolumeFactor(presetFactor)
        if (Number.isFinite(stepRatio) && stepRatio > 0) setVolumeStepRatio(stepRatio)
        fetchProgression()
      }
    }

    // Subscribe to cross-component events so this card re-fetches when
    // the operator toggles a connection, enables live trading, changes
    // the global engine state, or saves connection settings elsewhere in
    // the app. All listeners are cleaned up in the returned teardown below.
    // `connection-settings-updated` is scoped per-connection (same shape
    // as live-trade-toggled) so only the affected card refreshes.
    if (typeof window !== "undefined") {
      window.addEventListener("connection-toggled", handleConnectionToggled)
      window.addEventListener("live-trade-toggled", handleLiveTradeToggled)
      window.addEventListener("engine-state-changed", handleConnectionToggled)
      window.addEventListener("connection-settings-updated", handleSettingsUpdated)
    }

    return () => {
      clearTimeout(timeoutId)
      if (typeof window !== "undefined") {
        window.removeEventListener("connection-toggled", handleConnectionToggled)
        window.removeEventListener("live-trade-toggled", handleLiveTradeToggled)
        window.removeEventListener("engine-state-changed", handleConnectionToggled)
        window.removeEventListener("connection-settings-updated", handleSettingsUpdated)
      }
    }
  }, [fetchProgression, connection.connectionId])

  // Fetch live stats every 4s from the canonical /stats endpoint (per-connection, cumulative)
  useEffect(() => {
    if (!connection.isActive && !globalEngineRunning) {
      setLiveStats(null)
      return
    }

    const fetchLiveStats = async () => {
      try {
        // Use canonical stats endpoint — same source as progression info, per-connection
        const res = await fetch(
          `/api/connections/progression/${connection.connectionId}/stats`,
          { cache: "no-store" }
        )
        if (!res.ok) return
        const data = await res.json()
        // Cycles label in the header should report the real interval-
        // frame count — every loop tick the indication processor fired
        // since the engine started — NOT the "live cycle" subset that
        // only counts ticks which actually generated indications. The
        // user reported "showing very Low number or Just '1'" which is
        // exactly what `indicationCycles` (= live || churn) does on a
        // freshly started engine that has not yet produced any indication
        // (e.g. during prehistoric warmup). We now read the explicit
        // churn counter from `cycleCounters.indication`, falling through
        // to the older shapes for backwards compat with the previous
        // payload.
        const cc = data.realtime?.cycleCounters || {}
        setLiveStats({
          indicationCycles:
            Number(cc.indication) ||
            data.realtime?.indicationCycles ||
            data.indicationCycleCount ||
            0,
          strategyCycles:
            Number(cc.strategy) ||
            data.realtime?.strategyCycles ||
            data.strategyCycleCount ||
            0,
          // ── Indications / Strategies — actively processing Sets ───────
          // Operators want the "Ind." / "Strat." counters on the live
          // card to reflect what's processing RIGHT NOW (Sets currently
          // producing qualified entries on the latest cycle), not the
          // cumulative `indicationsTotal` / `strategiesTotal` which
          // only ever grew. Source = `activeProgressing.{indications|
          // strategies}.total.sets`. Falls back to the legacy
          // cumulative counters when the new field is absent (older
          // API revs).
          // For Ind./Strat. counters: prefer "alive now" (non-zero sets from
          // activeProgressing.total.sets). Fall back to the cumulative total
          // (`indicationsTotal`) when the active-sets hash is empty — e.g.
          // when no per-cycle threshold crossing has been written yet, or when
          // the indication processor hasn't qualified anything this tick. This
          // keeps the tile non-zero so the operator can see the engine is
          // actually processing data.
          indications: (() => {
            const activeNow = data.activeProgressing?.indications?.total?.sets ?? 0
            if (activeNow > 0) return activeNow
            const activeCnt = data.activeCounts?.indications?.total ?? 0
            if (activeCnt > 0) return activeCnt
            const rt = data.realtime?.indicationsTotal ?? 0
            if (rt > 0) return rt
            const total = data.totalIndicationsCount ?? 0
            if (total > 0) return total
            // Final fallback: breakdown cumulative total (type-summed, most durable)
            return data.breakdown?.indications?.total ?? 0
          })(),
          strategies: (() => {
            const activeNow = data.activeProgressing?.strategies?.total?.sets ?? 0
            if (activeNow > 0) return activeNow
            const activeCnt = data.activeCounts?.strategies?.total ?? 0
            if (activeCnt > 0) return activeCnt
            const rt = data.realtime?.strategiesTotal ?? 0
            if (rt > 0) return rt
            const total = data.totalStrategyCount ?? 0
            if (total > 0) return total
            return data.breakdown?.strategies?.total ?? 0
          })(),
          // Positions: prefer pseudo open (evaluation pipeline) because live
          // exchange positions are 0 unless an order filled. This way the
          // tile shows "5" (pseudo evaluation positions) when evaluating.
          positions: (() => {
            const pseudo = data.openPositions?.pseudo?.open ?? 0
            const live   = data.openPositions?.live?.open   ?? 0
            const rt     = data.realtime?.positionsOpen     ?? 0
            return live > 0 ? live : pseudo > 0 ? pseudo : rt
          })(),
        })

        // Also populate prehistoric stats from the same response
        const bd = data.breakdown || {}
        const sd = data.strategyDetail || {}
        const pm = data.prehistoricMeta || {}
        const ind = bd.indications || {}
        const strat = bd.strategies || {}
        setPrehistoricStats({
          indicationsDirection: ind.direction || 0,
          indicationsMove:      ind.move      || 0,
          indicationsActive:    ind.active    || 0,
          indicationsOptimal:   ind.optimal   || 0,
          indicationsAuto:      ind.auto      || 0,
          indicationsTotal:     ind.total     || 0,
          stratBase:  strat.base || 0,
          stratMain:  strat.main || 0,
          stratReal:  strat.real || 0,
          stratLive:  strat.live || 0,
          basePassRatio:       sd.base?.passRatio      || 0,
          mainPassRatio:       sd.main?.passRatio      || 0,
          realPassRatio:       sd.real?.passRatio      || 0,
          livePassRatio:       sd.live?.passRatio      || 0,
          avgProfitFactorBase: sd.base?.avgProfitFactor || 0,
          avgProfitFactorMain: sd.main?.avgProfitFactor || 0,
          avgProfitFactorReal: sd.real?.avgProfitFactor || 0,
          avgProfitFactorLive: sd.live?.avgProfitFactor || 0,
          avgDrawdownTimeBase: sd.base?.avgDrawdownTime || 0,
          avgDrawdownTimeMain: sd.main?.avgDrawdownTime || 0,
          avgDrawdownTimeReal: sd.real?.avgDrawdownTime || 0,
          avgHoldTimeLive:     sd.live?.avgDrawdownTime || 0, // minutes
          avgPosEvalReal:      sd.real?.avgPosEvalReal  || 0,
          avgPosEvalLive:      sd.live?.avgPosEvalReal  || 0, // ROI fraction
          // ── Evaluated / passed counts (per-stage, NO cross-tier mixing) ──
          // Bug history: previous implementation cross-fell-back per stage,
          // e.g. `basePassed || (strat.main || 0)` meant "if Base has no
          // explicit `passed` counter, use the CURRENT Main set count as a
          // proxy for `things that passed gating into the next tier`."
          // That premise is broken on two axes:
          //   1. `evaluated`/`passed` are CUMULATIVE per-cycle counters,
          //      while `strat.*` are CURRENT live set counts — temporal
          //      mismatch that produces wild values after set decay/bloom.
          //   2. Falling back to the NEXT tier's count regularly yielded
          //      `passed > evaluated` (mathematically impossible), e.g.
          //      "Main 1.9K sets, eval 2/6 pass" where the 6 was actually
          //      `strat.real`, not anything that Main itself passed.
          // Fix: each tier reads ONLY its own counters from `sd.<tier>.*`.
          // We also switch `||` → `??` so a legitimate `0` is not treated
          // as "missing" and the display shows real zeros honestly.
          // The display-side clamp `passed = min(passed, evaluated)` below
          // is a final safety net against any backend invariant breakage.
          baseEvaluated:    Math.max(0, sd.base?.evaluated ?? 0),
          basePassed:       Math.max(0, Math.min(sd.base?.passed ?? 0, sd.base?.evaluated ?? Number.POSITIVE_INFINITY)),
          mainEvaluated:    Math.max(0, sd.main?.evaluated ?? 0),
          mainPassed:       Math.max(0, Math.min(sd.main?.passed ?? 0, sd.main?.evaluated ?? Number.POSITIVE_INFINITY)),
          realEvaluated:    Math.max(0, sd.real?.evaluated ?? 0),
          realPassed:       Math.max(0, Math.min(sd.real?.passed ?? 0, sd.real?.evaluated ?? Number.POSITIVE_INFINITY)),
          // Live: `evaluated` = orders placed, `passed` = orders filled.
          // Same clamp keeps `filled ≤ placed`.
          liveEvaluated:    Math.max(0, sd.live?.evaluated ?? 0),
          livePassed:       Math.max(0, Math.min(sd.live?.passed ?? 0, sd.live?.evaluated ?? Number.POSITIVE_INFINITY)),
          countPosEvalReal: sd.real?.countPosEval || 0,
          countPosEvalLive: sd.live?.countPosEval || 0,
          liveTotalPnl:     sd.live?.totalPnl    || 0,
          liveAvgPnl:       sd.live?.avgPnl      || 0,
          liveAvgPosSizeUsd: sd.live?.avgPosPerSet || 0,
          // Live exchange execution — sourced from the /stats endpoint
          // (fetched response is bound to `data`, not `json`).
          liveOrdersPlaced:      data?.liveExecution?.ordersPlaced     || 0,
          liveOrdersFilled:      data?.liveExecution?.ordersFilled     || 0,
          liveOrdersFailed:      data?.liveExecution?.ordersFailed     || 0,
          liveOrdersRejected:    data?.liveExecution?.ordersRejected   || 0,
          liveOrdersSimulated:   data?.liveExecution?.ordersSimulated  || 0,
          liveOrdersAccumulated: data?.liveExecution?.ordersAccumulated || 0,
          livePositionsCreated:  data?.liveExecution?.positionsCreated || 0,
          livePositionsClosed:   data?.liveExecution?.positionsClosed  || 0,
          livePositionsOpen:     data?.openPositions?.live?.open || data?.liveExecution?.positionsOpen || 0,
          liveWins:              data?.liveExecution?.wins             || 0,
          // USDT figures shown on the card represent the **used balance
          // (margin)** committed to live exchange positions, NOT the
          // leveraged notional (qty × price). The /stats route exposes
          // both: `marginUsdTotal` (preferred, capital at risk) and
          // `volumeUsdTotal` (legacy, leveraged notional). We prefer
          // margin and fall back to notional only when the connection
          // started before margin tracking existed (counter is 0).
          liveVolumeUsdTotal:    Number(data?.liveExecution?.marginUsdTotal)
                                   || Number(data?.liveExecution?.volumeUsdTotal)
                                   || 0,
          liveFillRate:          data?.liveExecution?.fillRate         || 0,
          liveWinRate:           data?.liveExecution?.winRate          || 0,
          // ── Mirroring pipeline open-position counts ─────────────
          // Counts only for pseudo/real; USD only at the live exchange
          // layer. We prefer the per-position margin aggregate
          // (`marginUsd`, capital committed) and fall back to the
          // leveraged `volumeUsd` for legacy clients.
          pseudoOpen:            Number(data?.openPositions?.pseudo?.open)        || 0,
          pseudoRunningSets:     Number(data?.openPositions?.pseudo?.runningSets) || 0,
          realOpen:              Number(data?.openPositions?.real?.open)          || 0,
          liveOpenPositions:     Number(data?.openPositions?.live?.open)          || 0,
          liveVolumeUsd:         Number(data?.openPositions?.live?.marginUsd)
                                   || Number(data?.openPositions?.live?.volumeUsd)
                                   || 0,
          // Per-symbol roll-ups (see type declaration above).
          liveBySymbol:          Array.isArray(data?.openPositions?.live?.bySymbol)
                                   ? data.openPositions.live.bySymbol
                                   : [],
          liveOrdersBySymbol:    Array.isArray(data?.liveExecution?.ordersBySymbol)
                                   ? data.liveExecution.ordersBySymbol
                                   : [],
          // Portfolio-wide live aggregate — canonical PnL / ROI sources.
          liveAggUnrealizedPnl:    Number(data?.openPositions?.live?.aggregate?.totalUnrealizedPnl) || 0,
          liveAggPortfolioRoiPct:  Number(data?.openPositions?.live?.aggregate?.portfolioRoiPct)   || 0,
          rangeDays:               pm.rangeDays              || 1,
          timeframeSeconds:        pm.timeframeSeconds        || 1,
          intervalsProcessed:      pm.intervalsProcessed      || 0,
          missingIntervalsLoaded:  pm.missingIntervalsLoaded  || 0,
          currentSymbol:           pm.currentSymbol           || "",
          isComplete:              pm.isComplete              || false,
        })
      } catch { /* non-critical */ }
    }

    fetchLiveStats()
    const interval = setInterval(fetchLiveStats, 4000)
    return () => clearInterval(interval)
  }, [globalEngineRunning, connection.connectionId, connection.isActive])

  // Handle Live Trade toggle ��� no longer gated on connection.isActive:
  // the /live-trade route auto-starts the engine when Live is turned on,
  // so the user can flip Live and the engine comes up with the flag set.
  const handleLiveTradeToggle = async (newState: boolean) => {
    const connName = connection.exchangeName
    const previousState = liveTrade
    setLiveTrade(newState)
    liveTradeLoadingRef.current = true
    setLiveTradeLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/live-trade`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_live_trade: newState }),
        cache: "no-store"
      })

      const data = await res.json().catch(() => ({ error: "Failed to parse response" }))

      if (res.ok && data.success) {
        const requestedState = typeof data.live_trade_requested === "boolean" ? data.live_trade_requested : newState
        const effectiveState = typeof data.is_live_trade === "boolean" ? data.is_live_trade : requestedState
        setLiveTrade(requestedState)
        toast.success(
          requestedState
            ? (effectiveState ? `Live Trading starting on ${connName}...` : `Live Trading requested on ${connName}; waiting for valid credentials`)
            : `Live Trading stopped on ${connName}`,
        )
        dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
          connectionId: connection.connectionId,
          connection: { id: connection.connectionId, name: connection.exchangeName },
          engine: { action: requestedState ? "start" : "stop", status: data.engineStatus },
          source: "active-connection-card.liveTrade",
        }))
        if (typeof window !== "undefined") {
          window.dispatchEvent(new CustomEvent("live-trade-toggled", {
            detail: { connectionId: connection.connectionId, newState: requestedState, effectiveState }
          }))
        }
      } else {
        setLiveTrade(previousState)
        toast.error(`Failed to toggle Live Trade: ${data.error || "Unknown error"}`)
      }
    } catch {
      setLiveTrade(previousState)
      toast.error("Failed to toggle Live Trade")
    } finally {
      liveTradeLoadingRef.current = false
      setLiveTradeLoading(false)
    }
  }

  // Handle Preset Mode toggle — no longer gated on connection.isActive,
  // same rationale as handleLiveTradeToggle above.
  const handlePresetModeToggle = async (newState: boolean) => {
    presetModeLoadingRef.current = true
    setPresetModeLoading(true)
    try {
      const res = await fetch(`/api/settings/connections/${connection.connectionId}/preset-toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_preset_trade: newState }),
      })
      if (res.ok) {
        setPresetMode(newState)
        toast.success(newState ? "Preset Mode engine starting..." : "Preset Mode engine stopped")
      } else {
        const err = await res.json().catch(() => ({ error: "Failed" }))
        toast.error(err.error || "Failed to toggle Preset Mode")
      }
    } catch {
      toast.error("Failed to toggle Preset Mode")
    } finally {
      presetModeLoadingRef.current = false
      setPresetModeLoading(false)
    }
  }

  const phase = progression?.phase || "idle"
  // Override the engine's coarse phase progress with the live prehistoric
  // symbols-processed percent while we're in `prehistoric_data`. The
  // engine sets the phase to 15% the moment it enters that phase and
  // doesn't touch it again until the realtime processor takes over —
  // resulting in a progress bar that looks frozen for minutes during
  // a long historic load. Spec ask: "Show Correct Progress Bar (with
  // Percentage) for PreHistoric Calculations within UIs".
  //
  // Falls back to the engine's value when:
  //   • the prehistoric percent is 0 (nothing to render yet), or
  //   • we're in any other phase (engine progress is correct elsewhere).
  const enginePhaseProgress = progression?.progress || 0
  const prehistoricPercent = progression?.prehistoricProgress?.percentComplete ?? 0
  const progress =
    phase === "prehistoric_data" && prehistoricPercent > 0
      ? prehistoricPercent
      : enginePhaseProgress
  const isRunning = phase === "live_trading"
  // "unknown" = engine just started, no phase written yet → show amber "Starting..."
  const isStarting = (
    phase !== "idle" && phase !== "stopped" && phase !== "live_trading" && phase !== "error" && phase !== "disabled"
  ) && (progress < 100 || phase === "unknown")
  const hasError = phase === "error"

  const cardBorderClass = isRunning
    ? "border-green-300 dark:border-green-800"
    : isStarting
      ? "border-amber-300 dark:border-amber-800"
      : hasError
        ? "border-red-300 dark:border-red-800"
        : "border-border"

  const statusBadge = isRunning
    ? { label: "Live", className: "bg-green-600 text-white" }
    : isStarting
      ? { label: "Starting...", className: "bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300" }
      : hasError
        ? { label: "Error", className: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300" }
        : connection.isActive && !globalEngineRunning
          ? { label: "Paused", className: "bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300" }
          : connection.isActive
            ? { label: "Ready", className: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300" }
            : { label: "Off", className: "text-muted-foreground" }

  const connName = details?.name || connection.connectionId
  const testStatus = details?.last_test_status

  return (
    <>
      <Collapsible open={expanded} onOpenChange={onExpand}>
        <Card className={`transition-colors ${cardBorderClass}`}>
          <CardHeader className="pb-2 px-4 pt-4">
            {/* Row 1: Name, exchange badge, status badge, expand button */}
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {connection.isActive ? (
                    <Wifi className="h-3.5 w-3.5 text-green-500 shrink-0" />
                  ) : (
                    <WifiOff className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  )}
                  <CardTitle className="text-sm font-semibold truncate">{connName}</CardTitle>
                </div>
                <Badge variant="outline" className="text-[10px] shrink-0">
                  {details?.exchange || connection.exchangeName}
                </Badge>
                <Badge variant="secondary" className={`text-[10px] shrink-0 ${statusBadge.className}`}>
                  {statusBadge.label}
                </Badge>
                {testStatus && (
                  <Badge
                    variant="outline"
                    className={`text-[10px] shrink-0 ${
                      testStatus === "success"
                        ? "border-green-300 text-green-700 dark:text-green-400"
                        : testStatus === "error" || testStatus === "failed"
                          ? "border-red-300 text-red-700 dark:text-red-400"
                          : ""
                    }`}
                  >
                    {testStatus === "success" ? "Tested" : testStatus === "error" || testStatus === "failed" ? "Test Failed" : testStatus}
                  </Badge>
                )}
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {/* Info button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setInfoDialogOpen(true)}
                  title="Connection Info"
                >
                  <Info className="h-3.5 w-3.5" />
                </Button>
                {/* Settings button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setSettingsDialogOpen(true)}
                  title="Connection Settings"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                </Button>
                {/* Logs button */}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => setLogsDialogOpen(true)}
                  title="Procedure Logs"
                >
                  <Activity className="h-3.5 w-3.5" />
                </Button>
                {/* Expand toggle */}
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="h-7 w-7 p-0">
                    <ChevronDown className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
              </div>
            </div>

            {/* Row 2: Connection info line */}
            <CardDescription className="text-[11px] mt-1 flex items-center gap-2 flex-wrap">
              {details?.api_type && (
                <span className="capitalize">{details.api_type.replace(/_/g, " ")}</span>
              )}
              {details?.connection_method && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="capitalize">{details.connection_method}</span>
                </>
              )}
              {details?.margin_type && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="capitalize">{details.margin_type}</span>
                </>
              )}
              {!details?.is_testnet && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="text-green-600 dark:text-green-400 font-medium">Live</span>
                </>
              )}
              {details?.last_test_time && (
                <>
                  <span className="text-muted-foreground/50">|</span>
                  <span className="flex items-center gap-0.5">
                    <Clock className="h-3 w-3" />
                    {new Date(details.last_test_time).toLocaleTimeString()}
                  </span>
                </>
              )}
            </CardDescription>

            {/* Row 3: Three toggle switches */}
            <div className="flex items-center gap-4 mt-2.5 pt-2 border-t border-border/50">
              {/* Enable toggle — no pre-condition on global engine; toggle-dashboard API starts the engine */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`enable-${connection.connectionId}`}
                  checked={connection.isActive}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={(checked) => {
                    onToggle(connection.connectionId, checked)
                  }}
                  disabled={isToggling}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`enable-${connection.connectionId}`}
                  className="text-xs font-medium cursor-pointer"
                >
                  {isToggling ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Enable
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      Enable
                      {engineStates && !engineStates.enabled.inSync && (
                        <span
                          title={engineStates.enabled.flag
                            ? "Flag is ON but engine is not running — will reconcile shortly"
                            : "Engine is running but flag is OFF — will stop shortly"}
                          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  )}
                </Label>
              </div>

              <Separator orientation="vertical" className="h-4" />

              {/* Live Trade toggle — independent mode flag. The route will start the
                  engine automatically if it is not already running, so we no longer
                  disable the switch just because Enable is off. */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`live-${connection.connectionId}`}
                  checked={liveTrade}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={handleLiveTradeToggle}
                  disabled={liveTradeLoading}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`live-${connection.connectionId}`}
                  className={`text-xs font-medium cursor-pointer ${
                    liveTrade ? "text-green-600 dark:text-green-400" : ""
                  }`}
                >
                  {liveTradeLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Live Trade
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      <Activity className="h-3 w-3" /> Live Trade
                      {engineStates && liveTrade && !engineStates.live.inSync && (
                        <span
                          title="Live flag ON but engine state differs — reconciling"
                          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  )}
                </Label>
              </div>

              <Separator orientation="vertical" className="h-4" />

              {/* Preset Mode toggle — independent mode flag, same semantics as Live. */}
              <div className="flex items-center gap-2">
                <Switch
                  id={`preset-${connection.connectionId}`}
                  checked={presetMode}
                  onClick={(event) => event.stopPropagation()}
                  onCheckedChange={handlePresetModeToggle}
                  disabled={presetModeLoading}
                  className="scale-[0.8]"
                />
                <Label
                  htmlFor={`preset-${connection.connectionId}`}
                  className={`text-xs font-medium cursor-pointer ${
                    presetMode ? "text-purple-600 dark:text-purple-400" : ""
                  }`}
                >
                  {presetModeLoading ? (
                    <span className="flex items-center gap-1">
                      <Loader2 className="h-3 w-3 animate-spin" /> Preset Mode
                    </span>
                  ) : (
                    <span className="flex items-center gap-1">
                      Preset Mode
                      {engineStates && presetMode && !engineStates.preset.inSync && (
                        <span
                          title="Preset flag ON but engine state differs — reconciling"
                          className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500 animate-pulse"
                          aria-hidden="true"
                        />
                      )}
                    </span>
                  )}
                </Label>
              </div>

              {/* Spacer + Remove */}
              <div className="ml-auto">
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30"
                      disabled={isRemoving}
                    >
                      {isRemoving ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove from Active List</AlertDialogTitle>
                      <AlertDialogDescription>
                        {`Remove "${connName}" from active connections? All engines will be stopped.`}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <div className="flex gap-2 justify-end">
                      <AlertDialogCancel disabled={isRemoving}>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => onRemove(connection.connectionId, connName)}
                        disabled={isRemoving}
                        className="bg-red-600 hover:bg-red-700"
                      >
                        {isRemoving ? (
                          <span className="flex items-center gap-2">
                            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Removing...
                          </span>
                        ) : (
                          "Remove"
                        )}
                      </AlertDialogAction>
                    </div>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </CardHeader>

          {/* Per-connection stats row — shown whenever active with data, even in idle/stopped phases.
              Layout: Symbols | Cycles | Pseudo|Live. Indications / Strategies / Sets moved to the
              Realtime Execution panel where they belong semantically (live ticking data, not
              connection-level overview). The Symbols tile here surfaces the prehistoric backfill
              progress so the operator can read both the realtime tick count AND backfill coverage
              at a glance, even when the engine is paused. */}
          {connection.isActive && liveStats && (phase === "idle" || phase === "stopped" || phase === "disabled") && (
            <CardContent className="pt-0 pb-2 px-4">
              <div className="flex items-center gap-3 flex-wrap pt-1 border-t border-border/40">
                {(() => {
                  const symbolsProcessed = progression?.prehistoricProgress?.symbolsProcessed ?? 0
                  const symbolsTotal     = progression?.prehistoricProgress?.symbolsTotal     ?? 0
                  const tiles: Array<{ label: string; value: string | number; title?: string }> = []
                  if (symbolsProcessed > 0 || symbolsTotal > 0) {
                    tiles.push({
                      label: "Symbols",
                      value: symbolsTotal > 0 ? `${symbolsProcessed}/${symbolsTotal}` : symbolsProcessed,
                      title: "Prehistoric backfill coverage — symbols processed vs total.",
                    })
                  }
                  tiles.push({
                    label: "Cycles",
                    value: liveStats.indicationCycles,
                    title: "Realtime indication processor ticks since engine start.",
                  })
                  tiles.push({
                    label: (prehistoricStats?.liveOpenPositions ?? 0) > 0 ? "Live" : "Pseudo",
                    value: liveStats.positions,
                    title: (prehistoricStats?.liveOpenPositions ?? 0) > 0
                      ? "Open exchange positions (live)."
                      : "Open pseudo positions (evaluation stage).",
                  })
                  return tiles.map(({ label, value, title }) => (
                    <div key={label} className="flex items-center gap-1 text-[10px]" title={title}>
                      <span className="text-muted-foreground">{label}</span>
                      <span className="font-semibold tabular-nums">
                        {typeof value === "number" && value >= 1000
                          ? `${(value / 1000).toFixed(1)}K`
                          : value}
                      </span>
                    </div>
                  ))
                })()}
              </div>
            </CardContent>
          )}

          {/* Progress bar when engine has active progression data.
              "unknown" is omitted — it means no phase written yet, treat like idle. */}
          {(connection.isActive || phase === "live_trading") && phase !== "idle" && phase !== "stopped" && phase !== "disabled" && phase !== "unknown" && (
            <CardContent className="pt-0 pb-3 px-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground font-medium">
                    {PHASE_LABELS[phase] || phase}
                  </span>
                  <span className="text-muted-foreground tabular-nums">{progress}%</span>
                </div>
                <Progress value={progress} className="h-1.5" />
                {progression?.message && (
                  <p className="text-[11px] text-muted-foreground truncate">
                    {progression.message}
                    {progression.subPhase && <span className="ml-1">- {progression.subPhase}</span>}
                  </p>
                )}

                {/* Per-connection engine stats — always shown when connection is active.
                    Layout matches the idle variant: Symbols | Cycles | Pseudo|Live.
                    Indications / Strategies / Sets live in the Realtime Execution panel.
                    When liveStats hasn't loaded yet we render with 0-fallbacks so the
                    tiles are always visible once we leave prehistoric_data phase. */}
                <div className="flex items-center gap-3 mt-1.5 flex-wrap">
                  {(() => {
                    const symbolsProcessed = progression?.prehistoricProgress?.symbolsProcessed ?? 0
                    const symbolsTotal     = progression?.prehistoricProgress?.symbolsTotal     ?? 0
                    const tiles: Array<{ label: string; value: string | number; title?: string }> = []
                    if (symbolsProcessed > 0 || symbolsTotal > 0) {
                      tiles.push({
                        label: "Symbols",
                        value: symbolsTotal > 0 ? `${symbolsProcessed}/${symbolsTotal}` : symbolsProcessed,
                        title: "Prehistoric backfill coverage — symbols processed vs total.",
                      })
                    }
                    tiles.push({
                      label: "Cycles",
                      value: liveStats?.indicationCycles ?? 0,
                      title: "Realtime indication processor ticks since engine start.",
                    })
                    tiles.push({
                      label: (prehistoricStats?.liveOpenPositions ?? 0) > 0 ? "Live" : "Pseudo",
                      value: liveStats?.positions ?? 0,
                      title: (prehistoricStats?.liveOpenPositions ?? 0) > 0
                        ? "Open exchange positions (live)."
                        : "Open pseudo positions (evaluation stage).",
                    })
                    return tiles.map(({ label, value, title }) => (
                      <div key={label} className="flex items-center gap-1 text-[10px]" title={title}>
                        <span className="text-muted-foreground">{label}</span>
                        <span className="font-semibold tabular-nums">
                          {typeof value === "number" && value >= 1000
                            ? `${(value / 1000).toFixed(1)}K`
                            : value}
                        </span>
                      </div>
                    ))
                  })()}
                </div>

                {/* ── Mirroring pipeline counts ──────────────────────
                    Base → Main → Real → Exchange flow. Pseudo/Real
                    are eval stages (count only — no real USD); Live
                    is the exchange itself (count + real USD volume).
                    Do NOT sum across stages — they mirror the same
                    signal. */}
                {prehistoricStats && (
                  prehistoricStats.pseudoOpen > 0 ||
                  prehistoricStats.realOpen > 0 ||
                  prehistoricStats.liveOpenPositions > 0 ||
                  prehistoricStats.liveVolumeUsd > 0
                ) && (
                  <div className="flex items-center gap-3 mt-1 flex-wrap text-[10px]">
                    <div
                      className="flex items-center gap-1"
                      title={
                        `${prehistoricStats.pseudoOpen} pseudo positions under continuous strategy evaluation\n` +
                        `across ${prehistoricStats.pseudoRunningSets} running Set${prehistoricStats.pseudoRunningSets === 1 ? "" : "s"}. No real USD at this stage.`
                      }
                    >
                      <span className="text-muted-foreground">Pseudo</span>
                      <span className="font-semibold text-green-700 dark:text-green-400 tabular-nums">
                        {prehistoricStats.pseudoOpen}
                      </span>
                    </div>
                    {/* Real count — clamped so it never reads 0 while Live > 0.
                        Live positions cannot exist without an upstream Real
                        promotion having occurred, so when the real-stage scan
                        returns 0 but the exchange has N live positions we
                        surface N here instead. This was the "pseudo 5, real 0
                        while there are some" bug: real-stage's
                        `evaluateToRealPositions()` only runs on Main→Real
                        promotion ticks, leaving the realOpen counter at 0
                        between ticks while live positions are still alive. */}
                    <div
                      className="flex items-center gap-1"
                      title={
                        prehistoricStats.realOpen >= prehistoricStats.liveOpenPositions
                          ? "Main→Real validated promotions awaiting mirror into exchange orders — count only."
                          : "Currently live exchange positions traced back to their upstream Real promotion (Real scan is between ticks)."
                      }
                    >
                      <span className="text-muted-foreground">Real</span>
                      <span className="font-semibold text-emerald-700 dark:text-emerald-400 tabular-nums">
                        {Math.max(prehistoricStats.realOpen, prehistoricStats.liveOpenPositions)}
                      </span>
                    </div>
                    <div
                      className="flex items-center gap-1"
                      title="Open positions actually on the exchange. Equivalent Sets with the same ranges consolidate into a single exchange order."
                    >
                      <span className="text-muted-foreground">Exchange</span>
                      <span className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                        {prehistoricStats.liveOpenPositions}
                      </span>
                    </div>
                    <div
                      className="flex items-center gap-1"
                      title={
                        "USDT used balance committed to live exchange positions — the actual capital at risk (sum of notional/leverage), " +
                        "NOT the leveraged exposure."
                      }
                    >
                      <span className="text-muted-foreground">USDT</span>
                      <span className="font-semibold text-amber-700 dark:text-amber-400 tabular-nums">
                        {prehistoricStats.liveVolumeUsd >= 1_000_000
                          ? `$${(prehistoricStats.liveVolumeUsd / 1_000_000).toFixed(2)}M`
                          : prehistoricStats.liveVolumeUsd >= 1_000
                            ? `$${(prehistoricStats.liveVolumeUsd / 1_000).toFixed(1)}K`
                            : `$${prehistoricStats.liveVolumeUsd.toFixed(0)}`}
                      </span>
                    </div>
                  </div>
                )}

                {/* Rich prehistoric progress display */}
                {(phase === "prehistoric_data" || (prehistoricStats && (prehistoricStats.indicationsTotal > 0 || prehistoricStats.stratBase > 0))) && (
                  <div className="mt-2 p-2 bg-amber-50/50 dark:bg-amber-950/20 rounded border border-amber-200/50 dark:border-amber-800/30 space-y-2">
                    {/* Header row */}
                    <div className="flex items-center justify-between">
                      <div className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">
                        Historical Processing
                      </div>
                      <div className="flex items-center gap-1.5 text-[9px]">
                        {prehistoricStats && (
                          <>
                            <span className="text-muted-foreground">
                              {prehistoricStats.rangeDays}d range
                            </span>
                            <span className="text-muted-foreground/50">|</span>
                            <span className="text-muted-foreground font-mono">
                              {prehistoricStats.timeframeSeconds === 1 ? "1s" : `${prehistoricStats.timeframeSeconds}s`}
                            </span>
                            {prehistoricStats.isComplete && (
                              <>
                                <span className="text-muted-foreground/50">|</span>
                                <span className="text-green-600 dark:text-green-400 font-medium">complete</span>
                              </>
                            )}
                          </>
                        )}
                      </div>
                    </div>

                    {/*
                      Symbols & candles row.

                      Previously this block was gated on `progression?.prehistoricProgress`,
                      so whenever that endpoint returned a sparse payload (e.g. before the
                      first prehistoric cycle landed or while the in-memory progression
                      manager was still initialising) the entire row vanished — giving the
                      "less info than before" impression the user reported.

                      We now merge both canonical sources and always render as long as
                      *either* has data. `progression.prehistoricProgress` is preferred
                      for symbols/candles (it mirrors the trade_engine_state snapshot),
                      with `prehistoricStats` fields as a fallback that is populated from
                      `/stats` on the 4s live-stats tick.
                    */}
                    {(() => {
                      const pp = progression?.prehistoricProgress
                      const symbolsProcessed = pp?.symbolsProcessed ?? 0
                      const symbolsTotal = pp?.symbolsTotal ?? 0
                      const candlesLoaded = pp?.candlesLoaded ?? 0
                      const indicatorsCalculated = pp?.indicatorsCalculated ?? (prehistoricStats?.isComplete ? 0 : 0)
                      const intervalsProcessed = prehistoricStats?.intervalsProcessed ?? 0
                      const missingIntervals = prehistoricStats?.missingIntervalsLoaded ?? 0
                      const currentSymbol = pp?.currentSymbol || prehistoricStats?.currentSymbol || ""
                      const hasData =
                        Boolean(pp) ||
                        symbolsProcessed > 0 ||
                        candlesLoaded > 0 ||
                        intervalsProcessed > 0 ||
                        indicatorsCalculated > 0

                      if (!hasData) return null

                      const formatK = (n: number) =>
                        n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n)

                      return (
                        <div className="flex items-center gap-3 text-[10px] flex-wrap">
                          {symbolsTotal > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Symbols</span>
                              <span className="font-medium tabular-nums">
                                {symbolsProcessed}/{symbolsTotal}
                              </span>
                            </div>
                          )}
                          {candlesLoaded > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Candles</span>
                              <span className="font-medium tabular-nums">
                                {formatK(candlesLoaded)}
                              </span>
                            </div>
                          )}
                          {indicatorsCalculated > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Indicators</span>
                              <span className="font-medium tabular-nums">
                                {formatK(indicatorsCalculated)}
                              </span>
                            </div>
                          )}
                          {intervalsProcessed > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Intervals</span>
                              <span className="font-medium tabular-nums">
                                {formatK(intervalsProcessed)}
                              </span>
                            </div>
                          )}
                          {missingIntervals > 0 && (
                            <div className="flex items-center gap-1">
                              <span className="text-muted-foreground">Gaps filled</span>
                              <span className="font-medium tabular-nums">
                                {formatK(missingIntervals)}
                              </span>
                            </div>
                          )}
                          {/* ── Real-stage averaged counts + stage eval % ── */}
                          {realAverages && (
                            <>
                              <div className="flex items-center gap-1" title="Average number of Real Sets running.">
                                <span className="text-muted-foreground">Avg Sets</span>
                                <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {realAverages.activeSets.toFixed(1)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1" title="Average positions (entries) held per running Real Set.">
                                <span className="text-muted-foreground">Avg Pos/Set</span>
                                <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {realAverages.posPerSet.toFixed(1)}
                                </span>
                              </div>
                              <div className="flex items-center gap-1" title="Average total open positions across running Real Sets.">
                                <span className="text-muted-foreground">Avg Open</span>
                                <span className="font-medium tabular-nums text-emerald-700 dark:text-emerald-400">
                                  {realAverages.posOpen.toFixed(1)}
                                </span>
                              </div>
                            </>
                          )}
                          {stageEvalPercent && (
                            <div
                              className="flex items-center gap-1"
                              title="Stage pass-through: Base is the 100% entry point; Main = survived Base→Main; Real = survived Main→Real."
                            >
                              <span className="text-muted-foreground">Evals B/M/R</span>
                              <span className="font-medium tabular-nums text-sky-700 dark:text-sky-400">
                                {stageEvalPercent.base.toFixed(0)}% / {stageEvalPercent.main.toFixed(0)}% / {stageEvalPercent.real.toFixed(0)}%
                              </span>
                            </div>
                          )}
                          {currentSymbol && phase === "prehistoric_data" && (
                            <div className="flex items-center gap-1 ml-auto">
                              <span className="text-muted-foreground">Now:</span>
                              <span className="font-mono font-medium text-[9px]">{currentSymbol}</span>
                            </div>
                          )}
                        </div>
                      )
                    })()}

                    {/* Indications breakdown */}
                    {prehistoricStats && prehistoricStats.indicationsTotal > 0 && (
                      <div className="space-y-0.5">
                        <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                          Indications Evaluated ({prehistoricStats.indicationsTotal.toLocaleString()})
                        </div>
                        <div className="grid grid-cols-5 gap-1">
                          {[
                            { label: "Dir", value: prehistoricStats.indicationsDirection },
                            { label: "Move", value: prehistoricStats.indicationsMove },
                            { label: "Act", value: prehistoricStats.indicationsActive },
                            { label: "Opt", value: prehistoricStats.indicationsOptimal },
                            { label: "Auto", value: prehistoricStats.indicationsAuto },
                          ].map(({ label, value }) => (
                            <div key={label} className="text-center">
                              <div className="text-[8px] text-muted-foreground">{label}</div>
                              <div className="text-[10px] font-semibold tabular-nums">
                                {value >= 1000 ? `${(value / 1000).toFixed(1)}K` : value}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* Strategy stages breakdown */}
                    {prehistoricStats && (
                      prehistoricStats.stratBase > 0 ||
                      prehistoricStats.stratMain > 0 ||
                      prehistoricStats.stratReal > 0 ||
                      prehistoricStats.livePositionsCreated > 0 ||
                      // Also surface the section during pure prehistoric
                      // processing — the historic PF aggregate is written
                      // even before any Set is "created" in the realtime
                      // sense, so we open the section when any stage's PF
                      // is non-zero. See historic PF block in
                      // lib/trade-engine/config-set-processor.ts.
                      prehistoricStats.avgProfitFactorBase > 0 ||
                      prehistoricStats.avgProfitFactorMain > 0 ||
                      prehistoricStats.avgProfitFactorReal > 0
                    ) && (
                      <div className="space-y-1">
                        <div className="text-[9px] font-medium text-muted-foreground uppercase tracking-wide">
                          Strategy Sets with Open Positions
                        </div>
                        {/* Stage rows: Base → Main → Real → Live (exchange-side outcomes) */}
                        {[
                          {
                            label: "Base",
                            count:     prehistoricStats.stratBase,
                            evaluated: prehistoricStats.baseEvaluated,
                            passed:    prehistoricStats.basePassed,
                            passRatio: prehistoricStats.basePassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorBase,
                            avgDDT:    prehistoricStats.avgDrawdownTimeBase,
                            avgPosEval: null as number | null,
                            countPosEval: null as number | null,
                            color: "text-blue-600 dark:text-blue-400",
                            isLive: false,
                          },
                          {
                            label: "Main",
                            count:     prehistoricStats.stratMain,
                            evaluated: prehistoricStats.mainEvaluated,
                            passed:    prehistoricStats.mainPassed,
                            passRatio: prehistoricStats.mainPassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorMain,
                            avgDDT:    prehistoricStats.avgDrawdownTimeMain,
                            avgPosEval: null as number | null,
                            countPosEval: null as number | null,
                            color: "text-purple-600 dark:text-purple-400",
                            isLive: false,
                          },
                          {
                            label: "Real",
                            count:     prehistoricStats.stratReal,
                            evaluated: prehistoricStats.realEvaluated,
                            passed:    prehistoricStats.realPassed,
                            passRatio: prehistoricStats.realPassRatio,
                            avgPF:     prehistoricStats.avgProfitFactorReal,
                            avgDDT:    prehistoricStats.avgDrawdownTimeReal,
                            avgPosEval: prehistoricStats.avgPosEvalReal,
                            countPosEval: prehistoricStats.countPosEvalReal,
                            color: "text-green-600 dark:text-green-400",
                            isLive: false,
                          },
                          {
                            // Live tier — real exchange positions history, sourced from
                            // local Redis archive (no exchange history calls).
                            label: "Live",
                            count:     prehistoricStats.livePositionsCreated,
                            evaluated: prehistoricStats.liveEvaluated,  // orders placed
                            passed:    prehistoricStats.livePassed,     // orders filled
                            passRatio: prehistoricStats.livePassRatio,  // fill rate %
                            avgPF:     prehistoricStats.avgProfitFactorLive,
                            avgDDT:    prehistoricStats.avgHoldTimeLive, // avg hold time
                            avgPosEval: prehistoricStats.avgPosEvalLive, // realised ROI
                            countPosEval: prehistoricStats.countPosEvalLive,
                            color: "text-amber-600 dark:text-amber-400",
                            isLive: true,
                          },
                        ].map(({ label, count, evaluated, passed, passRatio, avgPF, avgDDT, avgPosEval, countPosEval, color, isLive }) => (
                          // Render the row whenever ANY metric for the stage
                          // has data — count, evaluated/passed, OR an avg
                          // profit factor. Previously this was gated on
                          // `count > 0`, which hid Base/Main/Real PF entirely
                          // during pure prehistoric processing (set count is
                          // populated by realtime strategy-coordinator only,
                          // but the PF aggregate is now also written by the
                          // prehistoric path — see config-set-processor's
                          // historic PF aggregation block).
                          (count > 0 || evaluated > 0 || avgPF > 0 || (label === "Real" && (prehistoricStats.realOpen > 0 || prehistoricStats.liveOpenPositions > 0))) && (
                            <div key={label} className="space-y-0.5">
                              {/* Main row: label, sets/positions count, pass/fill ratio, PF */}
                              <div className="flex items-center gap-2 text-[10px]">
                                <span className={`font-semibold w-7 shrink-0 ${color}`}>{label}</span>
                                <span className="font-semibold tabular-nums">
                                  {count >= 1000 ? `${(count / 1000).toFixed(1)}K` : count} {isLive ? "pos" : "sets"}
                                </span>
                                {/* ── Open-position count for Real stage ───────
                                    Real-stage's `count` field is the cumulative
                                    Set tally — it does NOT surface the actual
                                    currently-open Real positions. Operators
                                    repeatedly reported "Stage Real showing no
                                    open Positions" because of this. We clamp to
                                    `Math.max(realOpen, liveOpenPositions)` so
                                    the value never reads 0 while live mirrors
                                    are still on the exchange (Live positions
                                    cannot exist without an upstream Real
                                    promotion). */}
                                {label === "Real" && (() => {
                                  const realOpenClamped = Math.max(
                                    prehistoricStats.realOpen || 0,
                                    prehistoricStats.liveOpenPositions || 0,
                                  )
                                  if (realOpenClamped <= 0) return null
                                  return (
                                    <span
                                      className="text-muted-foreground"
                                      title="Currently-open validated Real positions awaiting mirror into exchange orders (clamped to live count so it never reads 0 while live mirrors are still alive)."
                                    >
                                      <span className="text-emerald-700 dark:text-emerald-400 font-semibold tabular-nums">
                                        {realOpenClamped}
                                      </span>{" "}
                                      open
                                    </span>
                                  )
                                })()}
                                {evaluated > 0 && (
                                  <span className="text-muted-foreground">
                                    {isLive ? "placed " : "eval "}
                                    <span className="text-foreground font-medium tabular-nums">
                                      {evaluated >= 1000 ? `${(evaluated / 1000).toFixed(1)}K` : evaluated}
                                    </span>
                                    {passed > 0 && (
                                      <span className="text-foreground font-medium tabular-nums ml-0.5">
                                        /{passed >= 1000 ? `${(passed / 1000).toFixed(1)}K` : passed} {isLive ? "filled" : "pass"}
                                      </span>
                                    )}
                                  </span>
                                )}
                                {passRatio > 0 && (
                                  <span className="text-muted-foreground">
                                    <span className={`font-medium ${passRatio >= 50 ? "text-green-600 dark:text-green-400" : passRatio >= 25 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                                      {passRatio.toFixed(1)}%
                                    </span>
                                  </span>
                                )}
                                <span className="text-muted-foreground ml-auto">
                                  PF <span className={`font-medium ${avgPF >= 1.4 ? "text-green-600 dark:text-green-400" : avgPF >= 1.0 ? "text-foreground" : "text-red-500"}`}>
                                    {avgPF > 0 ? avgPF.toFixed(2) : "—"}
                                  </span>
                                </span>
                                <span className="text-muted-foreground">
                                  {isLive ? "Hold" : "DDT"} <span className="text-foreground font-medium">
                                    {avgDDT > 0 ? `${Math.round(avgDDT)}m` : "—"}
                                  </span>
                                </span>
                              </div>
                              {/* Real-stage extra row: PosEval avg + count + Pos Accumulated */}
                              {avgPosEval !== null && !isLive && (
                                <div className="flex items-center gap-2 text-[10px] pl-7">
                                  <span className="text-muted-foreground">PosEval avg</span>
                                  <span className={`font-medium ${avgPosEval >= 0.7 ? "text-green-600 dark:text-green-400" : avgPosEval >= 0.4 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                                    {avgPosEval > 0 ? avgPosEval.toFixed(3) : "—"}
                                  </span>
                                  {countPosEval !== null && countPosEval > 0 && (
                                    <span className="text-muted-foreground">
                                      count <span className="text-foreground font-medium tabular-nums">{countPosEval}</span>
                                    </span>
                                  )}
                                  {/* Pos Accumulated — the Real → Live consolidation counter.
                                     Counts how many Real-stage Set signals for this connection
                                     were merged into an already-open exchange position rather
                                     than spawning a new one. Spec: *"ON Real Show count Sets
                                     and Pos Accumulated"*. */}
                                  {label === "Real" && prehistoricStats.liveOrdersAccumulated > 0 && (
                                    <span
                                      className="text-muted-foreground ml-auto"
                                      title="Real-stage signals merged into existing exchange positions to avoid duplicate orders on the same symbol+direction."
                                    >
                                      Pos Accum <span className="text-cyan-600 dark:text-cyan-400 font-semibold tabular-nums">
                                        {prehistoricStats.liveOrdersAccumulated}
                                      </span>
                                    </span>
                                  )}
                                </div>
                              )}
                              {/* Live-tier exclusive sub-row: realised ROI, win-rate, total PnL */}
                              {isLive && (
                                <div className="flex items-center gap-2 text-[10px] pl-7">
                                  <span className="text-muted-foreground">ROI avg</span>
                                  {/* Narrow `avgPosEval` (typed `number | null`
                                      across all tiers) before arithmetic so
                                      strict TS doesn't flag possible-null
                                      access. The live tier always populates
                                      it from `avgPosEvalLive`, but the union
                                      type comes from the other tiers. */}
                                  <span className={`font-medium tabular-nums ${(avgPosEval ?? 0) > 0 ? "text-green-600 dark:text-green-400" : (avgPosEval ?? 0) < 0 ? "text-red-500" : "text-foreground"}`}>
                                    {avgPosEval !== null && avgPosEval !== 0 ? `${(avgPosEval * 100).toFixed(2)}%` : "—"}
                                  </span>
                                  <span className="text-muted-foreground">
                                    WR <span className={`font-medium ${prehistoricStats.liveWinRate >= 60 ? "text-green-600 dark:text-green-400" : prehistoricStats.liveWinRate >= 40 ? "text-amber-600 dark:text-amber-400" : "text-red-500"}`}>
                                      {prehistoricStats.liveWinRate > 0 ? `${prehistoricStats.liveWinRate.toFixed(1)}%` : "—"}
                                    </span>
                                  </span>
                                  <span className="text-muted-foreground ml-auto">
                                    PnL <span className={`font-semibold tabular-nums ${prehistoricStats.liveTotalPnl > 0 ? "text-green-600 dark:text-green-400" : prehistoricStats.liveTotalPnl < 0 ? "text-red-500" : "text-foreground"}`}>
                                      {prehistoricStats.liveTotalPnl !== 0
                                        ? `${prehistoricStats.liveTotalPnl > 0 ? "+" : ""}$${Math.abs(prehistoricStats.liveTotalPnl).toFixed(2)}`
                                        : "—"}
                                    </span>
                                  </span>
                                  {countPosEval !== null && countPosEval > 0 && (
                                    <span className="text-muted-foreground">
                                      n=<span className="text-foreground font-medium tabular-nums">{countPosEval}</span>
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>
                          )
                        ))}
                      </div>
                    )}

                    {/* ── Realtime Execution sub-section ────────────────
                        Visually split inside the existing detailed panel:
                        the historic backfill content (symbols/candles/
                        intervals + indications + strategy stages) keeps the
                        amber theme above; below this divider the realtime
                        engine pulse (Ind / Strat / Sets, Positions per
                        symbol, Orders per symbol, PnL / WR / USDT) is
                        re-themed in blue.

                        Show gate (broadened): visible whenever the
                        realtime processor is actively ticking — not just
                        once an exchange order has been placed. This is
                        the panel that surfaces Ind / Strat / Sets, so it
                        must appear during pure pseudo/real evaluation
                        runs too.

                        The inner status chips deliberately keep their
                        semantic colours (green for fills/wins, amber for
                        rejected, red for failed/PnL-loss) so the operator
                        can still read outcome quality at a glance. */}
                    {prehistoricStats && liveStats && (
                      phase === "realtime" ||
                      phase === "live_trading" ||
                      liveStats.indicationCycles > 0 ||
                      prehistoricStats.liveOrdersPlaced > 0 ||
                      prehistoricStats.liveOrdersSimulated > 0 ||
                      prehistoricStats.livePositionsCreated > 0
                    ) && (
                      <div className="space-y-1 -mx-2 -mb-2 mt-1 px-2 pt-2 pb-2 border-t-2 border-blue-300/60 dark:border-blue-700/50 bg-blue-50/60 dark:bg-blue-950/25 rounded-b">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <div className="text-[9px] font-semibold text-blue-700 dark:text-blue-400 uppercase tracking-wide">
                              Realtime Execution
                            </div>
                            <span
                              className="inline-block h-1.5 w-1.5 rounded-full bg-blue-500 dark:bg-blue-400 animate-pulse"
                              aria-hidden="true"
                            />
                          </div>
                          {prehistoricStats.livePositionsOpen > 0 && (
                            <div className="flex items-center gap-1 text-[9px]">
                              <span className="relative flex h-1.5 w-1.5">
                                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                              </span>
                              <span className="font-semibold text-green-600 dark:text-green-400 tabular-nums">
                                {prehistoricStats.livePositionsOpen} open
                              </span>
                            </div>
                          )}
                        </div>

                        {/* ── Indications / Strategies / Sets sub-row ──
                            Moved here from the connection overview row so
                            "what's processing right now" stays scoped to
                            the realtime panel. Each tile reads from a
                            single canonical source — `liveStats.{ind|strat}`
                            (already wired to `activeProgressing.*.total.sets`
                            with cumulative fall-throughs) and the
                            per-stage `breakdown.strategies.real` for the
                            Sets total (= Real-stage validated set count,
                            the canonical "strategies total"). */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                          <span
                            className="text-muted-foreground"
                            title="Indications currently being produced by the realtime processor (active sets × types). Use the cumulative number in the historic block above for lifetime totals."
                          >
                            Ind. <span className="text-foreground font-semibold tabular-nums">
                              {liveStats.indications >= 1000 ? `${(liveStats.indications / 1000).toFixed(1)}K` : liveStats.indications}
                            </span>
                          </span>
                          <span
                            className="text-muted-foreground"
                            title="Strategies actively evaluating this cycle (sourced from activeProgressing.strategies.total.sets, with cumulative breakdown fall-through)."
                          >
                            Strat. <span className="text-foreground font-semibold tabular-nums">
                              {liveStats.strategies >= 1000 ? `${(liveStats.strategies / 1000).toFixed(1)}K` : liveStats.strategies}
                            </span>
                          </span>
                          <span
                            className="text-muted-foreground"
                            title="Validated Real-stage Sets — the canonical 'strategies total' (cumulative). Real is the cascade-filter terminus; downstream Live mirrors a subset of these Sets."
                          >
                            Sets <span className="text-foreground font-semibold tabular-nums">
                              {prehistoricStats.stratReal >= 1000 ? `${(prehistoricStats.stratReal / 1000).toFixed(1)}K` : prehistoricStats.stratReal}
                            </span>
                          </span>
                          {liveStats.indicationCycles > 0 && (
                            <span
                              className="ml-auto text-muted-foreground"
                              title="Indication processor ticks since engine start."
                            >
                              Cycles <span className="text-foreground font-semibold tabular-nums">
                                {liveStats.indicationCycles >= 1000 ? `${(liveStats.indicationCycles / 1000).toFixed(1)}K` : liveStats.indicationCycles}
                              </span>
                            </span>
                          )}
                        </div>

                        {/* ── Positions row (per-symbol, long/short) ────
                            Reads from `openPositions.live.bySymbol`
                            (sorted by descending position count).
                            Shows a totals chip at the front and per-symbol
                            chips after. Direction is conveyed by L/S
                            tokens to keep the strip compact. */}
                        {(prehistoricStats.liveBySymbol.length > 0 || prehistoricStats.liveOpenPositions > 0) && (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                            <span
                              className="text-muted-foreground"
                              title="Open exchange positions grouped by symbol. L=long, S=short."
                            >
                              Positions <span className="text-foreground font-semibold tabular-nums">
                                {prehistoricStats.liveOpenPositions}
                              </span>
                            </span>
                            {(() => {
                              const longTotal  = prehistoricStats.liveBySymbol.reduce((s, e) => s + e.long,  0)
                              const shortTotal = prehistoricStats.liveBySymbol.reduce((s, e) => s + e.short, 0)
                              return (longTotal + shortTotal) > 0 ? (
                                <span className="text-muted-foreground">
                                  <span className="text-green-600 dark:text-green-400 font-semibold tabular-nums">L:{longTotal}</span>
                                  {" / "}
                                  <span className="text-red-500 font-semibold tabular-nums">S:{shortTotal}</span>
                                </span>
                              ) : null
                            })()}
                            {prehistoricStats.liveBySymbol.slice(0, 6).map((e) => (
                              <span
                                key={e.symbol}
                                className="text-muted-foreground"
                                title={
                                  `${e.symbol} — ${e.long} long, ${e.short} short. ` +
                                  `Margin $${e.marginUsd.toFixed(2)}, unrealized ${e.unrealizedPnl >= 0 ? "+" : ""}$${e.unrealizedPnl.toFixed(2)}.`
                                }
                              >
                                <span className="font-mono text-foreground">{e.symbol}</span>
                                {e.long > 0 && (
                                  <> <span className="text-green-600 dark:text-green-400 font-semibold tabular-nums">L:{e.long}</span></>
                                )}
                                {e.short > 0 && (
                                  <> <span className="text-red-500 font-semibold tabular-nums">S:{e.short}</span></>
                                )}
                              </span>
                            ))}
                            {prehistoricStats.liveBySymbol.length > 6 && (
                              <span className="text-muted-foreground">
                                +{prehistoricStats.liveBySymbol.length - 6} more
                              </span>
                            )}
                          </div>
                        )}

                        {/* ── Orders row (totals + per-symbol breakdown) ──
                            Multiple orders can land on the same symbol/
                            direction (accumulations). The per-symbol chip
                            strip reads `liveExecution.ordersBySymbol`
                            (placed/filled) so the operator can see how
                            many distinct exchange orders the realtime
                            processor has fired for each pair. Falls back
                            to global totals only when the array is empty. */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                          <span className="text-muted-foreground">
                            Orders <span className="text-foreground font-semibold tabular-nums">
                              {prehistoricStats.liveOrdersPlaced}
                            </span>
                          </span>
                          {prehistoricStats.liveOrdersFilled > 0 && (
                            <span className="text-muted-foreground">
                              filled <span className="text-green-600 dark:text-green-400 font-semibold tabular-nums">
                                {prehistoricStats.liveOrdersFilled}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveOrdersRejected > 0 && (
                            <span className="text-muted-foreground">
                              rejected <span className="text-amber-600 dark:text-amber-400 font-semibold tabular-nums">
                                {prehistoricStats.liveOrdersRejected}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveOrdersFailed > 0 && (
                            <span className="text-muted-foreground">
                              failed <span className="text-red-500 font-semibold tabular-nums">
                                {prehistoricStats.liveOrdersFailed}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveOrdersSimulated > 0 && (
                            <span className="text-muted-foreground">
                              sim <span className="text-blue-600 dark:text-blue-400 font-semibold tabular-nums">
                                {prehistoricStats.liveOrdersSimulated}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveOrdersAccumulated > 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Real-stage Set signals merged into an existing exchange position instead of opening a new one — keeps live exposure consolidated."
                            >
                              accum <span className="text-cyan-600 dark:text-cyan-400 font-semibold tabular-nums">
                                {prehistoricStats.liveOrdersAccumulated}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveFillRate > 0 && (
                            <span className="ml-auto text-muted-foreground">
                              fill <span className={`font-semibold ${prehistoricStats.liveFillRate >= 80 ? "text-green-600 dark:text-green-400" : prehistoricStats.liveFillRate >= 50 ? "text-amber-600 dark:text-amber-400" : "text-foreground"}`}>
                                {prehistoricStats.liveFillRate.toFixed(1)}%
                              </span>
                            </span>
                          )}
                        </div>

                        {/* Per-symbol order chips (e.g. BTCUSDT L:3/2 S:1/1
                            = 3 long placed of which 2 filled, 1 short
                            placed of which 1 filled). Only renders when
                            the server reported per-symbol data. */}
                        {prehistoricStats.liveOrdersBySymbol.length > 0 && (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                            <span className="text-muted-foreground text-[9px] uppercase tracking-wide">By symbol</span>
                            {prehistoricStats.liveOrdersBySymbol.slice(0, 6).map((o) => (
                              <span
                                key={o.symbol}
                                className="text-muted-foreground"
                                title={
                                  `${o.symbol} — ` +
                                  `long ${o.long.placed} placed / ${o.long.filled} filled, ` +
                                  `short ${o.short.placed} placed / ${o.short.filled} filled.`
                                }
                              >
                                <span className="font-mono text-foreground">{o.symbol}</span>
                                {(o.long.placed + o.long.filled) > 0 && (
                                  <> <span className="text-green-600 dark:text-green-400 font-semibold tabular-nums">L:{o.long.placed}/{o.long.filled}</span></>
                                )}
                                {(o.short.placed + o.short.filled) > 0 && (
                                  <> <span className="text-red-500 font-semibold tabular-nums">S:{o.short.placed}/{o.short.filled}</span></>
                                )}
                              </span>
                            ))}
                            {prehistoricStats.liveOrdersBySymbol.length > 6 && (
                              <span className="text-muted-foreground">
                                +{prehistoricStats.liveOrdersBySymbol.length - 6} more
                              </span>
                            )}
                          </div>
                        )}

                        {/* PnL / WR / PF / ROI row — single canonical
                            sources only (no cross-stage summation):
                              PnL  = openPositions.live.aggregate.totalUnrealizedPnl (open) + strategyDetail.live.totalPnl (realised)
                              WR   = liveExecution.winRate
                              PF   = strategyDetail.live.avgProfitFactor
                              ROI  = openPositions.live.aggregate.portfolioRoiPct (open) + strategyDetail.live.avgPosEvalReal (avg realised)
                        */}
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                          <span
                            className="text-muted-foreground"
                            title="Total realised PnL across all closed live positions (strategyDetail.live.totalPnl)."
                          >
                            PnL <span className={`font-semibold tabular-nums ${prehistoricStats.liveTotalPnl > 0 ? "text-green-600 dark:text-green-400" : prehistoricStats.liveTotalPnl < 0 ? "text-red-500" : "text-foreground"}`}>
                              {prehistoricStats.liveTotalPnl >= 0 ? "+" : ""}${prehistoricStats.liveTotalPnl.toFixed(2)}
                            </span>
                          </span>
                          {prehistoricStats.liveAggUnrealizedPnl !== 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Unrealised PnL across all currently-open live positions (openPositions.live.aggregate.totalUnrealizedPnl)."
                            >
                              open <span className={`font-semibold tabular-nums ${prehistoricStats.liveAggUnrealizedPnl > 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                                {prehistoricStats.liveAggUnrealizedPnl >= 0 ? "+" : ""}${prehistoricStats.liveAggUnrealizedPnl.toFixed(2)}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveWinRate > 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Win rate across closed live positions — wins / closed (liveExecution.winRate)."
                            >
                              WR <span className={`font-semibold tabular-nums ${prehistoricStats.liveWinRate >= 60 ? "text-green-600 dark:text-green-400" : prehistoricStats.liveWinRate >= 40 ? "text-amber-600 dark:text-amber-400" : "text-red-500"}`}>
                                {prehistoricStats.liveWinRate.toFixed(1)}%
                              </span>
                            </span>
                          )}
                          {prehistoricStats.avgProfitFactorLive > 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Profit factor on the live tier — sum(+PnL) / |sum(-PnL)| across closed live positions (strategyDetail.live.avgProfitFactor)."
                            >
                              PF <span className={`font-semibold tabular-nums ${prehistoricStats.avgProfitFactorLive >= 1.4 ? "text-green-600 dark:text-green-400" : prehistoricStats.avgProfitFactorLive >= 1 ? "text-foreground" : "text-red-500"}`}>
                                {prehistoricStats.avgProfitFactorLive.toFixed(2)}
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveAggPortfolioRoiPct !== 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Portfolio ROI — unrealised PnL / committed margin across all currently-open live positions."
                            >
                              ROI live <span className={`font-semibold tabular-nums ${prehistoricStats.liveAggPortfolioRoiPct > 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                                {prehistoricStats.liveAggPortfolioRoiPct >= 0 ? "+" : ""}{prehistoricStats.liveAggPortfolioRoiPct.toFixed(2)}%
                              </span>
                            </span>
                          )}
                          {prehistoricStats.avgPosEvalLive !== 0 && (
                            <span
                              className="text-muted-foreground"
                              title="Average ROI per closed live position (strategyDetail.live.avgPosEvalReal, stored as fraction)."
                            >
                              ROI avg <span className={`font-semibold tabular-nums ${prehistoricStats.avgPosEvalLive > 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                                {prehistoricStats.avgPosEvalLive >= 0 ? "+" : ""}{(prehistoricStats.avgPosEvalLive * 100).toFixed(2)}%
                              </span>
                            </span>
                          )}
                          {prehistoricStats.liveVolumeUsdTotal > 0 && (
                            <span
                              className="ml-auto text-muted-foreground"
                              title={
                                "USDT used balance committed (cumulative margin = sum of notional/leverage across every fill + accumulation). " +
                                "Reflects actual capital deployed, NOT leveraged exposure."
                              }
                            >
                              USDT <span className="text-foreground font-semibold tabular-nums">
                                ${prehistoricStats.liveVolumeUsdTotal >= 1000
                                  ? `${(prehistoricStats.liveVolumeUsdTotal / 1000).toFixed(1)}K`
                                  : prehistoricStats.liveVolumeUsdTotal.toFixed(2)}
                              </span>
                            </span>
                          )}
                        </div>

                        {/* ── Positions lifecycle row (created/closed/wins) ──
                            Kept separate from the "Positions per symbol"
                            row above so the per-symbol chips don't get
                            mixed up with lifetime lifecycle counters. */}
                        {(prehistoricStats.livePositionsCreated > 0 || prehistoricStats.liveWins > 0) && (
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
                            <span className="text-muted-foreground">
                              Created <span className="text-foreground font-semibold tabular-nums">
                                {prehistoricStats.livePositionsCreated}
                              </span>
                            </span>
                            {/* Only show closed count when positions were actually created in
                                this session — avoids the reconcile-sweep artifact where the
                                sweep detects exchange positions from a previous session as
                                "closed" before any new position was created. */}
                            {prehistoricStats.livePositionsClosed > 0 && prehistoricStats.livePositionsCreated > 0 && (
                              <span className="text-muted-foreground">
                                closed <span className="text-foreground font-semibold tabular-nums">
                                  {prehistoricStats.livePositionsClosed}
                                </span>
                              </span>
                            )}
                            {prehistoricStats.liveWins > 0 && (
                              <span className="text-muted-foreground">
                                wins <span className="text-green-600 dark:text-green-400 font-semibold tabular-nums">
                                  {prehistoricStats.liveWins}
                                </span>
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}

                    {/* Missing intervals info */}
                    {prehistoricStats && prehistoricStats.missingIntervalsLoaded > 0 && (
                      <div className="text-[9px] text-muted-foreground">
                        Loaded {prehistoricStats.missingIntervalsLoaded.toLocaleString()} missing intervals
                      </div>
                    )}
                  </div>
                )}

                {progression?.error && (
                  <p className="text-[11px] text-red-500 font-medium truncate">
                    {progression.error}
                  </p>
                )}
              </div>
            </CardContent>
          )}

          {/* Expanded details with modern configuration panels */}
          <CollapsibleContent>
            <CardContent className="pt-0 pb-4 px-4 space-y-4">
              <Separator className="mb-3" />

              {/* Connection Details */}
              {details && (
                <div className="grid grid-cols-3 gap-x-4 gap-y-2.5 text-xs">
                  <div>
                    <div className="text-muted-foreground mb-0.5">Exchange</div>
                    <div className="font-medium">{details.exchange}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">API Type</div>
                    <div className="font-medium capitalize">{details.api_type?.replace(/_/g, " ") || "-"}</div>
                  </div>
                  <div>
                    <div className="text-muted-foreground mb-0.5">Method</div>
                    <div className="font-medium capitalize">{details.connection_method || "-"}</div>
                  </div>
                </div>
              )}

              <Separator />

              {/* Volume Configuration Panel */}
              <VolumeConfigurationPanel
                liveVolumeFactor={liveVolumeFactor}
                presetVolumeFactor={presetVolumeFactor}
                volumeStepRatio={volumeStepRatio}
                onLiveVolumeChange={handleLiveVolumeChange}
                onPresetVolumeChange={handlePresetVolumeChange}
                onVolumeStepRatioChange={handleVolumeStepRatioChange}
                orderType={orderType}
                onOrderTypeChange={setOrderType}
                volumeType={volumeType}
                onVolumeTypeChange={setVolumeType}
                enginePhase={phase}
                globalEngineRunning={globalEngineRunning}
              />

              <Separator />

              {/* Order Settings Panel */}
              <OrderSettingsPanel
                orderType={orderType}
                marketSettings={{ slippageTolerance: 0.06, autoExecution: true }}
                limitSettings={{ priceOffset: 0.5, timeoutSeconds: 300 }}
              />

              <Separator />

              {/* Main Trade Card */}
              <MainTradeCard
                config={{
                  enabled: true,
                  status: mainTradeStatus,
                  entrySettings: {
                    indicationBased: true,
                    confirmationRequired: 2,
                    sizeCalculationMethod: "percentage",
                  },
                  exitSettings: {
                    takeProfitPercent: 5,
                    stopLossPercent: 2,
                    trailingStopEnabled: false,
                  },
                  positionManagement: {
                    maxPositionsTotal: 10,
                    maxPerSymbol: 2,
                    positionScaling: true,
                    partialExitRules: "None",
                  },
                  statistics: {
                    activePositions: 3,
                    unrealizedPnL: 1245.5,
                    unrealizedPnLPercent: 2.45,
                    winRate: 65,
                    maxDailyDrawdown: 1.2,
                    averageEntryPrice: 0,
                  },
                }}
                onStatusChange={setMainTradeStatus}
              />

              <Separator />

              {/* Preset Trade Card */}
              <PresetTradeCard
                config={{
                  enabled: true,
                  status: presetTradeStatus,
                  activePreset: "preset-1",
                  presetType: "auto-optimal",
                  availablePresets: [
                    {
                      id: "preset-1",
                      name: "Auto-Optimal",
                      description: "Auto-tuned indicators and strategies",
                      type: "auto-optimal",
                      createdDate: "2024-03-15",
                      backtestScore: 87.5,
                    },
                    {
                      id: "preset-2",
                      name: "Conservative",
                      description: "Low-risk conservative trading",
                      type: "conservative",
                      createdDate: "2024-03-10",
                      backtestScore: 72.3,
                    },
                  ],
                  autoUpdateEnabled: true,
                  statistics: {
                    coordinatedPositions: 5,
                    testProgress: 0,
                    activeTrades: 3,
                    presetPnL: 2450.75,
                    presetPnLPercent: 3.2,
                    expectedWinRate: 72,
                  },
                }}
                onStatusChange={setPresetTradeStatus}
              />

              {/* Engine progression details when running */}
              {progression && phase !== "idle" && phase !== "stopped" && phase !== "disabled" && (
                <div className="mt-3 pt-3 border-t">
                  <h4 className="text-[10px] font-semibold text-muted-foreground mb-2 uppercase tracking-wider">
                    Engine Progression
                  </h4>
                  <div className="grid grid-cols-3 gap-x-4 gap-y-2 text-xs">
                    <div>
                      <div className="text-muted-foreground mb-0.5">Phase</div>
                      <div className="font-medium">{PHASE_LABELS[phase] || phase}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Progress</div>
                      <div className="font-medium tabular-nums">{progress}%</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Updated</div>
                      <div className="font-medium">
                        {progression.updatedAt ? new Date(progression.updatedAt).toLocaleTimeString() : "-"}
                      </div>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Historical</div>
                      <Badge variant={progression.details?.historicalDataLoaded ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.historicalDataLoaded ? "Loaded" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Indications</div>
                      <Badge variant={progression.details?.indicationsCalculated ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.indicationsCalculated ? "Done" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Strategies</div>
                      <Badge variant={progression.details?.strategiesProcessed ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.strategiesProcessed ? "Done" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Live Processing</div>
                      <Badge variant={progression.details?.liveProcessingActive ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.liveProcessingActive ? "Active" : "Pending"}
                      </Badge>
                    </div>
                    <div>
                      <div className="text-muted-foreground mb-0.5">Live Trading</div>
                      <Badge variant={progression.details?.liveTradingActive ? "default" : "secondary"} className="text-[10px]">
                        {progression.details?.liveTradingActive ? "Active" : "Pending"}
                      </Badge>
                    </div>
                  </div>
                </div>
              )}
              {/* ── Diagnostic Tools row ───────────────────────────
                  Renders the additional dialogs the user asked us to
                  expose so they can pick which to keep. Each component
                  brings its own DialogTrigger button — we just lay them
                  out in a flexible row with a sub-heading for context.
                  Once the operator decides which to keep, the unwanted
                  imports + entries can be removed without touching the
                  rest of the card. */}
              <div className="mt-3 pt-3 border-t border-dashed">
                <div className="flex items-center gap-1.5 mb-2">
                  <Activity className="h-3 w-3 text-muted-foreground" />
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    Diagnostic Tools
                  </span>
                  <Badge variant="outline" className="text-[9px] h-3.5 px-1 ml-auto">
                    review
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {/* Per-connection categorized log dialog */}
                  {details && <ConnectionDetailedLogDialog connection={details as any} />}
                  {/* Engine processing log + live stats */}
                  <EngineProcessingLogDialog connectionId={connection.connectionId} />
                  {/* System-wide detailed logging stream */}
                  <DetailedLoggingDialog />
                </div>
              </div>
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Dialogs */}
      <ConnectionInfoDialog
        open={infoDialogOpen}
        onOpenChange={setInfoDialogOpen}
        connectionId={connection.connectionId}
        connectionName={connName}
      />
      {/* Lazy-mount the settings dialog so its heavy subtree (incl. the
          Strategy Coordination section) only enters the React tree when
          the user actually opens it. This (a) isolates the parent error
          boundary on the Active Connections panel from any transient
          module-load issues in the dialog's deep imports, and (b) keeps
          the initial dashboard render cheaper for connections that the
          operator never opens. */}
      {settingsDialogOpen && (
        <ConnectionSettingsDialog
          open={settingsDialogOpen}
          onOpenChange={setSettingsDialogOpen}
          connectionId={connection.connectionId}
          connectionName={connName}
        />
      )}
      <ProgressionLogsDialog
        open={logsDialogOpen}
        onOpenChange={setLogsDialogOpen}
        connectionId={connection.connectionId}
        connectionName={connName}
        progression={progression}
      />
    </>
  )
}
