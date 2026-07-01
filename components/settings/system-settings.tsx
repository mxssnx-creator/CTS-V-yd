"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, Loader2, Zap, Clock } from "lucide-react"
import { toast } from "@/lib/simple-toast"

interface RiskSettings {
  enabled: boolean
  maxOpenPositions: string
  dailyLossLimitPercent: number
  maxDrawdownPercent: number
  positionSizeLimit: number
  stopLossEnabled: boolean
  takeProfitEnabled: boolean
}

interface EngineSettings {
  presetTradeEngine: boolean
  mainTradeEngine: boolean
  realtimePositionsEngine: boolean
  riskManagementEngine: boolean
}

// ── Engine + cron + progression timing knobs ─────────────────────────────
// Mirror of `EngineTimings` in `lib/engine-timings.ts`. Kept as a structural
// type (not an `import type`) because the lib file is server-side only and
// pulling it client-side would drag the Redis client and the rest of its
// transitive imports into the bundle.
//
// Values are persisted in `settings:system` as snake_case keys. We display
// camelCase in the UI for consistency with the other settings blocks and
// the API normalises both forms on read (see REDIS_KEY_MAP in engine-timings).
interface EngineTimings {
  cronSyncIntervalSeconds: number
  liveSyncIntervalMs: number
  liveSyncPauseMs: number
  heartbeatIntervalMs: number
  strategyFlowMinIntervalMs: number
  strategyFlowHardThrottleMs: number
  strategyFlowMaxIntervalMs: number
  lockExtendIntervalMs: number
  maxPositionHoldMs: number
  progressionBufferFlushMs: number
  // ── API Timeouts ──────────────────────────────────────────────────────────
  // Configurable timeouts for exchange API calls to handle varying network latency
  apiTimeoutMs: number             // General API timeout (default 40s for BingX)
  apiPlaceOrderTimeoutMs: number   // Specific timeout for order placement
  apiCancelOrderTimeoutMs: number  // Specific timeout for order cancellation
  apiPositionTimeoutMs: number     // Specific timeout for position queries
  // ── Hedge / Directional Accumulation (read-live, no engine restart) ────────
  // Read at every cycle from strategy-coordinator and live-stage via getEngineTimings().
  // Stored as number in Redis (0/1 for boolean). Live-settings contract: hot-path,
  // changes apply within ~10 s (engine-timings cache TTL), no engine restart needed.
  normalizeEnabled: number         // 0=off, 1=on
  normalizeThresholdPct: number    // imbalance % before normalization kicks in
  normalizeMaxPerDirection: number // per-direction cap for hedge accumulator
  normalizeVolumeMode: string      // "neutralize" | "rebalance" | "reduce"

  // ── Position Ceilings (live settings, updated on write) ──────────────────
  // Max concurrent positions per direction. Read at every cycle.
  // Stored as number in Redis. Live-settings contract: hot-path,
  // changes apply within ~10 s (engine-timings cache TTL), no engine restart needed.
  maxPositionsLong: number         // Max concurrent long positions (default 1)
  maxPositionsShort: number        // Max concurrent short positions (default 1)

  // Three-progression loop tunables
  prehistoricIntervalMs: number
  prehistoricCyclePauseMs: number
  realtimeIntervalMs: number
  realtimeCyclePauseMs: number
  livePositionsCyclePauseMs: number
}

// Mirror of `DEFAULT_ENGINE_TIMINGS`. Used when loadSettings can't fetch
// the system settings (first-run, Redis hiccup) so the inputs aren't
// blank — operator sees the actual defaults the engine will use.
const DEFAULT_TIMINGS: EngineTimings = {
  cronSyncIntervalSeconds:   15,
  liveSyncIntervalMs:          200,
  liveSyncPauseMs:              50,
  heartbeatIntervalMs:       1_000,
  strategyFlowMinIntervalMs: 1_500,
  strategyFlowHardThrottleMs:  750,
  strategyFlowMaxIntervalMs: 15_000,
  lockExtendIntervalMs:     15_000,
  maxPositionHoldMs:    4 * 60 * 60 * 1000,
  progressionBufferFlushMs:  3_000,
  // ── API Timeouts (live settings, updated on write) ────────────────────────
  apiTimeoutMs:            40_000, // 40s general timeout for BingX API
  apiPlaceOrderTimeoutMs:  40_000, // 40s for order placement
  apiCancelOrderTimeoutMs: 20_000, // 20s for cancellation
  apiPositionTimeoutMs:    20_000, // 20s for position queries
  // ── Three-progression defaults. NOTE: per the no-pause refactor, the
  // Prehistoric loop ignores its interval/pause fields at runtime and
  // always cycles back-to-back via setTimeout(_, 0). The fields are
  // surfaced here so operators see what was historically configured,
  // but edits to them have no effect on the running engine.
  prehistoricIntervalMs:     1_000,
  prehistoricCyclePauseMs:      50,
  realtimeIntervalMs:        300,
  realtimeCyclePauseMs:         50,
  livePositionsCyclePauseMs:    300,
// ── Hedge / Directional Accumulation defaults ──────────────────────────────
   // Disabled by default to preserve existing behaviour for existing installs.
   // Operator enables explicitly once the accumulator behaviour is wanted.
   normalizeEnabled:            0,
   normalizeThresholdPct:       10,
   normalizeMaxPerDirection:    200,
   normalizeVolumeMode:         "neutralize",
   // ── Position Ceilings defaults ────────────────────────────────────────
   maxPositionsLong:            1,   // Default: 1 concurrent long position
   maxPositionsShort:           1,   // Default: 1 concurrent short position
}

// Mirror of `ENGINE_TIMING_BOUNDS`. The API clamps server-side too;
// these bounds are for early UX feedback + input min/max attributes.
const TIMING_BOUNDS: Record<keyof EngineTimings, { min: number; max: number; unit: string; live: boolean; help: string }> = {
  cronSyncIntervalSeconds: {
    min: 5, max: 60, unit: "sec", live: true,
    help: "Sub-minute sync cadence. The cron handler self-loops inside each 60s Vercel invocation, sleeping this many seconds between sweeps. 15s = 4 sweeps/min.",
  },
  liveSyncIntervalMs: {
    min: 100, max: 60_000, unit: "ms", live: true,
    help: "Realtime processor's exchange-sync cadence (start-to-start). Default 200 ms matches the live exchange-positions update rate. Lower = faster close-on-SL/TP detection but more REST calls; min 100 ms.",
  },
  liveSyncPauseMs: {
    min: 10, max: 200, unit: "ms", live: true,
    help: "Breath after each completed sync cycle before the next can fire — mirrors the main progression cyclePauseMs pattern. Ensures previous sync's Redis writes / control-order placements are durable before the next sync reads.",
  },
  heartbeatIntervalMs: {
    min: 250, max: 30_000, unit: "ms", live: true,
    help: "How often the engine writes its 'still alive' heartbeat to Redis. Independent of live sync.",
  },
  strategyFlowMinIntervalMs: {
    min: 250, max: 60_000, unit: "ms", live: true,
    help: "Minimum gap between strategy-flow re-runs WHEN the indication fingerprint changed.",
  },
  strategyFlowHardThrottleMs: {
    min: 100, max: 30_000, unit: "ms", live: true,
    help: "Absolute floor — strategy flow NEVER re-runs faster than this, fingerprint change or not.",
  },
  strategyFlowMaxIntervalMs: {
    min: 1_000, max: 5 * 60_000, unit: "ms", live: true,
    help: "Heartbeat re-run interval — strategy flow ALWAYS re-runs after this even if fingerprint is unchanged.",
  },
  lockExtendIntervalMs: {
    min: 1_000, max: 60_000, unit: "ms", live: false,
    help: "Engine extends its progression lock every N ms. Restart engine to apply.",
  },
  maxPositionHoldMs: {
    min: 0, max: 7 * 24 * 60 * 60_000, unit: "ms", live: true,
    help: "Force-close positions held longer than this. 0 = disabled (positions held indefinitely).",
  },
  progressionBufferFlushMs: {
    min: 500, max: 60_000, unit: "ms", live: false,
    help: "Progression log buffer flushes after this interval OR when it hits 50 entries. Restart engine to apply.",
  },
  // ── API Timeouts ──────────────────────────────────────────────────────────
  apiTimeoutMs: {
    min: 5_000, max: 120_000, unit: "ms", live: true,
    help: "General API timeout for all exchange calls. 40s accommodates BingX latency. Range 5–120 seconds.",
  },
  apiPlaceOrderTimeoutMs: {
    min: 5_000, max: 120_000, unit: "ms", live: true,
    help: "Specific timeout for order placement. Critical path — higher value reduces 'order timeout' errors.",
  },
  apiCancelOrderTimeoutMs: {
    min: 5_000, max: 60_000, unit: "ms", live: true,
    help: "Timeout for order cancellation. Range 5–60 seconds. Shorter is safer for position management.",
  },
  apiPositionTimeoutMs: {
    min: 5_000, max: 60_000, unit: "ms", live: true,
    help: "Timeout for position queries and balance checks. Range 5–60 seconds.",
  },
  // ── Three-progression tunables ────────────────────────────────────────
  // Important: the Prehistoric loop runs continuously back-to-back per
  // the architectural spec — its interval/pause fields below are kept
  // for back-compat but are NO-OPS at runtime. The UI flags them as
  // read-only via `live: false` so operators can see the historical
  // value without being misled into thinking edits take effect.
  prehistoricIntervalMs: {
    min: 200, max: 60_000, unit: "ms", live: false,
    help: "(no-op) Prehistoric Progression runs continuously back-to-back; this field is kept for back-compat only. The historical-Set processor's per-timeframe last_calc_at gate is the real throttle.",
  },
  prehistoricCyclePauseMs: {
    min: 10, max: 500, unit: "ms", live: false,
    help: "(no-op) Prehistoric loop has no inter-cycle pause; the next cycle is scheduled on the next event-loop tick.",
  },
  realtimeIntervalMs: {
    min: 200, max: 60_000, unit: "ms", live: true,
    help: "Realtime Progression start-to-start cadence — drives the shared ind+pseudo+strat pipeline per symbol.",
  },
  realtimeCyclePauseMs: {
    min: 10, max: 500, unit: "ms", live: true,
    help: "Breath after each Realtime cycle completes. Lower = tighter cadence, higher CPU; higher = quieter.",
  },
  livePositionsCyclePauseMs: {
    min: 10, max: 200, unit: "ms", live: true,
    help: "Breath after each LivePositions sync (exchange mark price + SL/TP cross + protection orders). Default 50 ms gives the 200 ms cadence a comfortable margin.",
  },
  // ── Hedge / Directional Accumulation ────────────────────────────────────
  normalizeEnabled: {
    min: 0, max: 1, unit: "bool", live: true,
    help: "Master on/off for hedge accumulation. When ON, the live-stage and StrategyCoordinator apply net-direction adjustments whenever the long/short imbalance for a Base Set exceeds normalizeThresholdPct%.",
  },
  normalizeThresholdPct: {
    min: 0, max: 50, unit: "%", live: true,
    help: "Imbalance threshold — |long−short|/(long+short) must exceed this ratio before normalize applies. Range 0–50, default 10.",
  },
normalizeMaxPerDirection: {
     min: 1, max: 500, unit: "", live: true,
     help: "Per-direction hard cap for the hedge accumulator. No more than this many concurrent open-sub-sets per direction are allowed before excess causes shedding.",
   },
  normalizeVolumeMode: {
    min: 0, max: 0, unit: "enum", live: true,
    help: "How accumulated volume is adjusted on normalize trigger: neutralize (net-delta only), rebalance (full vol. toward dominant), reduce (scale by imbalance ratio). Default: neutralize.",
  },
  // ── Position Ceilings ─────────────────────────────────────────────────────
  maxPositionsLong: {
    min: 1, max: 50, unit: "positions", live: true,
    help: "Max concurrent long positions. Range 1–50. Default 1 (conservative). Increase to allow more simultaneous long entries.",
  },
  maxPositionsShort: {
    min: 1, max: 50, unit: "positions", live: true,
    help: "Max concurrent short positions. Range 1–50. Default 1 (conservative). Increase to allow more simultaneous short entries.",
  },
}

export function SystemSettings() {
  const [riskSettings, setRiskSettings] = useState<RiskSettings | null>(null)
  const [engineSettings, setEngineSettings] = useState<EngineSettings | null>(null)
  const [timings, setTimings] = useState<EngineTimings>(DEFAULT_TIMINGS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      // Fetch in parallel — independent endpoints, no reason to serialise.
      const [riskRes, systemRes] = await Promise.all([
        fetch("/api/settings/risk-and-engines").catch(() => null),
        // Cache: no-store so refreshing the page right after a save shows
        // the just-written values (Vercel can otherwise serve a stale
        // edge-cached GET for several seconds).
        fetch("/api/settings/system", { cache: "no-store" }).catch(() => null),
      ])

      if (riskRes && riskRes.ok) {
        const data = await riskRes.json()
        setRiskSettings(data.riskManagement)
        setEngineSettings(data.engines)
      }

      if (systemRes && systemRes.ok) {
        const sys = await systemRes.json().catch(() => null)
        // /api/settings/system returns the full hash; pluck only the
        // timing keys, falling back to defaults for any that are absent
        // (e.g. a fresh deploy where nobody has saved yet).
        if (sys) {
          const next: EngineTimings = { ...DEFAULT_TIMINGS }
          const readNum = (snake: string, camel: keyof EngineTimings) => {
            const raw = sys[snake] ?? (sys as any)[camel]
            if (raw === undefined || raw === null || raw === "") return
            const n = parseFloat(String(raw))
            if (Number.isFinite(n)) (next as any)[camel] = n
          }
          readNum("cron_sync_interval_seconds",    "cronSyncIntervalSeconds")
          readNum("live_sync_interval_ms",         "liveSyncIntervalMs")
          readNum("live_sync_pause_ms",            "liveSyncPauseMs")
          readNum("heartbeat_interval_ms",         "heartbeatIntervalMs")
          readNum("strategy_flow_min_interval_ms", "strategyFlowMinIntervalMs")
          readNum("strategy_flow_hard_throttle_ms","strategyFlowHardThrottleMs")
          readNum("strategy_flow_max_interval_ms", "strategyFlowMaxIntervalMs")
          readNum("lock_extend_interval_ms",       "lockExtendIntervalMs")
          readNum("max_position_hold_ms",          "maxPositionHoldMs")
          readNum("progression_buffer_flush_ms",   "progressionBufferFlushMs")
          readNum("api_timeout_ms",                "apiTimeoutMs")
          readNum("api_place_order_timeout_ms",    "apiPlaceOrderTimeoutMs")
          readNum("api_cancel_order_timeout_ms",   "apiCancelOrderTimeoutMs")
          readNum("api_position_timeout_ms",       "apiPositionTimeoutMs")
          readNum("prehistoric_interval_ms",       "prehistoricIntervalMs")
          readNum("prehistoric_cycle_pause_ms",    "prehistoricCyclePauseMs")
          readNum("realtime_interval_ms",          "realtimeIntervalMs")
          readNum("realtime_cycle_pause_ms",       "realtimeCyclePauseMs")
          readNum("live_positions_cycle_pause_ms", "livePositionsCyclePauseMs")

          // ── Hedge / directional normalize (numeric + string fields) ──────────
          const rawEn = sys["neutralize_enabled"] ?? (sys as any)["normalizeEnabled"]
          if (rawEn !== undefined && rawEn !== null && rawEn !== "") {
            (next as any).normalizeEnabled = rawEn === "1" || rawEn === 1 || rawEn === true ? 1 : 0
          }
          readNum("neutralize_threshold_pct",     "normalizeThresholdPct")
          readNum("neutralize_max_per_direction", "normalizeMaxPerDirection")
          readNum("max_positions_long",           "maxPositionsLong")
          readNum("max_positions_short",          "maxPositionsShort")
          const readNormalizeStr = (snake: string, camel: keyof EngineTimings) => {
            const raw = sys[snake] ?? (sys as any)[camel]
            if (typeof raw === "string" && raw.trim() !== "") return raw.trim()
            return undefined
          }
          const normalizedVolumeMode =
            readNormalizeStr("neutralize_volume_mode", "normalizeVolumeMode") ?? "neutralize"
          if (["neutralize", "rebalance", "reduce"].includes(normalizedVolumeMode)) {
            ;(next as any)["normalizeVolumeMode"] = normalizedVolumeMode
          } else {
            // Invalid/absent: fall back to the default. 'as any' silences the union-type
            // mismatch between EngineTimings and the 'any' map cast to it.
            ;(next as any)["normalizeVolumeMode"] = "neutralize"
          }

          setTimings(next)
        }
      }
    } catch (error) {
      console.error("[v0] Error loading settings:", error)
      toast.error("Failed to load settings")
    } finally {
      setLoading(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      // POST risk/engines and PATCH system in parallel. They write to
      // disjoint Redis hashes so order does not matter, and parallel halves
      // the round-trip on slow connections. Settle pattern so a failure on
      // one block still records the other (and surfaces both errors).
      const [riskRes, sysRes] = await Promise.allSettled([
        fetch("/api/settings/risk-and-engines", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            riskManagement: riskSettings,
            engines: engineSettings,
          }),
        }),
        fetch("/api/settings/system", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          // Send snake_case to match the canonical Redis hash schema and
          // the existing PATCH validators in /api/settings/system.
          body: JSON.stringify({
            cron_sync_interval_seconds:    timings.cronSyncIntervalSeconds,
            live_sync_interval_ms:         timings.liveSyncIntervalMs,
            live_sync_pause_ms:            timings.liveSyncPauseMs,
            heartbeat_interval_ms:         timings.heartbeatIntervalMs,
            strategy_flow_min_interval_ms: timings.strategyFlowMinIntervalMs,
            strategy_flow_hard_throttle_ms:timings.strategyFlowHardThrottleMs,
            strategy_flow_max_interval_ms: timings.strategyFlowMaxIntervalMs,
            lock_extend_interval_ms:       timings.lockExtendIntervalMs,
            max_position_hold_ms:          timings.maxPositionHoldMs,
            progression_buffer_flush_ms:   timings.progressionBufferFlushMs,
            api_timeout_ms:                timings.apiTimeoutMs,
            api_place_order_timeout_ms:    timings.apiPlaceOrderTimeoutMs,
            api_cancel_order_timeout_ms:   timings.apiCancelOrderTimeoutMs,
            api_position_timeout_ms:       timings.apiPositionTimeoutMs,
            // ── Hedge / Directional Accumulation settings ───────────────────
            normalize_enabled:             timings.normalizeEnabled,
            normalize_threshold_pct:       timings.normalizeThresholdPct,
            normalize_max_per_direction:   timings.normalizeMaxPerDirection,
            // string — not numeric — included verbatim
            normalize_volume_mode:         timings.normalizeVolumeMode,
            // ── Position Ceilings ─────────────────────────────────────────
            max_positions_long:            timings.maxPositionsLong,
            max_positions_short:           timings.maxPositionsShort,
          }),
        }),
      ])

      const riskOk = riskRes.status === "fulfilled" && riskRes.value.ok
      const sysOk  = sysRes.status === "fulfilled" && sysRes.value.ok

      if (riskOk && sysOk) {
        toast.success("Settings saved successfully")
      } else if (!riskOk && !sysOk) {
        toast.error("Failed to save settings (both blocks)")
      } else if (!riskOk) {
        toast.error("Saved engine timings, but risk/engines block failed")
      } else {
        toast.error("Saved risk/engines, but engine timings block failed")
      }
    } catch (error) {
      console.error("[v0] Error saving settings:", error)
      toast.error("Failed to save settings")
    } finally {
      setSaving(false)
    }
  }

  if (loading || !riskSettings || !engineSettings) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Trade Engines */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Zap className="h-5 w-5 text-blue-600" />
            <div>
              <CardTitle>Trade Engines</CardTitle>
              <CardDescription>Enable or disable individual trade processing engines</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Preset Trade Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Preset Trade Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Runs preset strategies using common indicators
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.presetTradeEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    presetTradeEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Main Trade Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Main Trade Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Processes step indication based trades
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.mainTradeEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    mainTradeEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Realtime Positions Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg hover:bg-slate-50 transition">
              <div className="flex-1">
                <Label className="font-medium text-sm cursor-pointer">Realtime Positions Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Monitors positions via WebSocket real-time updates
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.realtimePositionsEngine}
                onChange={(e) =>
                  setEngineSettings({
                    ...engineSettings,
                    realtimePositionsEngine: e.target.checked,
                  })
                }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Risk Management Engine */}
            <div className="flex items-center justify-between p-3 border rounded-lg bg-slate-50 opacity-50 cursor-not-allowed">
              <div className="flex-1">
                <Label className="font-medium text-sm">Risk Management Engine</Label>
                <p className="text-xs text-muted-foreground mt-1">
                  Enforces position and loss limits (disabled)
                </p>
              </div>
              <input
                type="checkbox"
                checked={engineSettings.riskManagementEngine}
                disabled
                className="w-5 h-5 rounded opacity-50 cursor-not-allowed"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Risk Management Settings */}
      <Card className="border-amber-200 bg-amber-50/50">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle>Risk Management Settings</CardTitle>
              <CardDescription>Configure position and loss limits</CardDescription>
            </div>
            <Badge variant="secondary" className="bg-amber-200 text-amber-900">
              Currently Disabled
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4 opacity-60 pointer-events-none">
          <div className="p-3 bg-amber-100 border border-amber-300 rounded-lg flex gap-2">
            <AlertCircle className="h-5 w-5 text-amber-700 shrink-0 mt-0.5" />
            <div className="text-sm text-amber-900">
              <p className="font-medium">Risk management is currently disabled for safety.</p>
              <p className="text-xs mt-1">These settings are defaults and are shown for reference only.</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Max Open Positions */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Max Open Positions</Label>
              <Input
                type="text"
                value={riskSettings.maxOpenPositions}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Limit: <span className="font-mono font-bold">{riskSettings.maxOpenPositions}</span>
              </p>
            </div>

            {/* Daily Loss Limit */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Daily Loss Limit</Label>
              <Input
                type="number"
                value={riskSettings.dailyLossLimitPercent}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Default: <span className="font-mono font-bold">{riskSettings.dailyLossLimitPercent}%</span> of account
              </p>
            </div>

            {/* Max Drawdown */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Max Drawdown</Label>
              <Input
                type="number"
                value={riskSettings.maxDrawdownPercent}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Default: <span className="font-mono font-bold">{riskSettings.maxDrawdownPercent}%</span> of account
              </p>
            </div>

            {/* Position Size Limit */}
            <div className="space-y-2">
              <Label className="text-sm font-medium">Position Size Limit</Label>
              <Input
                type="number"
                value={riskSettings.positionSizeLimit}
                disabled
                className="bg-white"
              />
              <p className="text-xs text-muted-foreground">
                Maximum: <span className="font-mono font-bold">${riskSettings.positionSizeLimit.toLocaleString()}</span>
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Hedge / Directional Normalisation ──────────────────────────────── */}
      {/*
       * Hedge Accumulation controls: when the engine runs per-Base set and a
       * symbol receives N long + M short signals, the per-direction hedge
       * count tracks the imbalance. When `normalizeEnabled` is ON the live-
       * stage and StrategyCoordinator apply these rules:
       *
       *   normalizeThresholdPct    — imbalance % (|L−S|/(L+S)) above which
       *                              normalize kicks in. Default 10%.
       *   normalizeMaxPerDirection — feeds the coordinator's per-Base sub-set
       *                              cap; below this cap no shed happens.
       *   normalizeVolumeMode      — how additional volume is adjusted:
       *      "neutralize" — add only the net-delta (min exposure)
       *      "rebalance"  — add full volume but rebalance toward dominant side
       *      "reduce"     — scale-down by the ratio of net to total
       *
       * Persisted in `settings:system` hash under `neutralize_*` key names
       * (snake_case for canonical Redis schema). `engine-timings.ts` reads and
       * caches these values; StrategyCoordinator and live-stage read them via
       * `getEngineTimings()` at cycle start.
       */}
      <Card className="border-emerald-200 bg-emerald-50/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <CardTitle>Hedge / Directional Accumulation</CardTitle>
            <Badge variant="secondary" className="bg-emerald-100 text-emerald-700">LIVE</Badge>
          </div>
          <CardDescription>
            When enabled, imbalances between long and short signals for the same
            Base Set adjust downstream volume and position counts.
            The live-stage accumulate path and StrategyCoordinator hedge netter
            read these values via <code className="font-mono">getEngineTimings()</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            {/* enable / disable */}
            <div className="flex items-center justify-between p-4 border rounded-lg">
              <div>
                <Label className="font-medium text-sm">Enable Hedge Accumulation</Label>
                <p className="text-xs text-muted-foreground">
                  Apply net-direction and volume-ratio adjustments during Real→Live.
                </p>
              </div>
              <input
                type="checkbox"
                id="hedge-enabled"
                checked={timings.normalizeEnabled === 1}
onChange={(e) =>
                   setTimings({
                     ...timings,
                     normalizeEnabled: e.target.checked ? 1 : 0,
                   })
                 }
                className="w-5 h-5 rounded cursor-pointer"
              />
            </div>

            {/* Imbalance threshold % */}
            <div className="space-y-2 p-4 border rounded-lg">
              <Label className="text-sm font-medium">Imbalance Threshold (%)</Label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={0}
                  max={50}
                  step={1}
value={timings.normalizeThresholdPct}
                   onChange={(e) =>
                     setTimings({ ...timings, normalizeThresholdPct: Number(e.target.value) })
                   }
                  className="flex-1"
                />
<span className="text-sm font-semibold w-12 text-right">
                   {timings.normalizeThresholdPct}%
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                |long − short| / (long + short) must exceed this % before normalization applies.
                Spec default 10.
              </p>
            </div>

            {/* Max per direction */}
            <div className="space-y-2 p-4 border rounded-lg">
              <Label className="text-sm font-medium">Max Open Per Direction</Label>
              <div className="flex items-center gap-3">
                <input
                  type="range"
                  min={1}
                  max={500}
                  step={1}
value={timings.normalizeMaxPerDirection}
                   onChange={(e) =>
                     setTimings({ ...timings, normalizeMaxPerDirection: Number(e.target.value) })
                   }
                  className="flex-1"
                />
<span className="text-sm font-semibold w-12 text-right">
                   {timings.normalizeMaxPerDirection}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Hard cap: no more than this many concurrent open-sets per direction
                per Base Set. Spec default 20.
              </p>
            </div>

            {/* Volume mode */}
            <div className="space-y-2 p-4 border rounded-lg">
              <Label className="text-sm font-medium">Volume Adjustment Mode</Label>
<select
                 value={timings.normalizeVolumeMode}
                 onChange={(e) =>
                   setTimings({
                     ...timings,
                     normalizeVolumeMode: e.target.value as "neutralize" | "rebalance" | "reduce",
                   })
                }
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
              >
                <option value="neutralize">Neutralize — net-delta only</option>
                <option value="rebalance">Rebalance — full vol. toward dominant</option>
                <option value="reduce">Reduce — scale by imbalance ratio</option>
              </select>
              <p className="text-xs text-muted-foreground">
                Strategy for adjusting volume when a directional imbalance triggers
                normalization. Spec default: neutralize.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

{/* API Timeouts */}
      <Card className="border-orange-200 bg-orange-50/30">
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-orange-600" />
            <div>
              <CardTitle>API Timeouts</CardTitle>
              <CardDescription>
                Configure request timeouts for exchange API calls. Higher values reduce "timeout" errors on slow networks;
                lower values fail faster on unresponsive exchanges.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 bg-orange-100 border border-orange-300 rounded-lg flex gap-2">
            <AlertCircle className="h-5 w-5 text-orange-700 shrink-0 mt-0.5" />
            <div className="text-sm text-orange-900">
              <p className="font-medium">Critical for reliable trading</p>
              <p className="text-xs mt-1">
                API timeouts prevent indefinite hangs when exchanges respond slowly. BingX typically responds within 5–10s
                under normal conditions. Set higher on unstable networks, lower on fast networks.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(["apiTimeoutMs", "apiPlaceOrderTimeoutMs", "apiCancelOrderTimeoutMs", "apiPositionTimeoutMs"] as (keyof EngineTimings)[]).map((key) => {
              const b = TIMING_BOUNDS[key]
              const labelText = key
                .replace(/([A-Z])/g, " $1")
                .replace(/^./, (c) => c.toUpperCase())
                .replace(/\bMs\b/, "(ms)")
              return (
                <div key={key} className="space-y-2 p-3 border rounded-lg bg-white">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium leading-tight">{labelText}</Label>
                    <Badge variant="secondary" className="bg-orange-100 text-orange-700 text-[10px]">Live</Badge>
                  </div>
                  <div className="flex items-center gap-3">
                    <input
                      type="number"
                      min={b.min}
                      max={b.max}
                      step={1000}
                      value={timings[key] as number}
                      onChange={(e) => setTimings({ ...timings, [key]: Number(e.target.value) })}
                      className="flex-1 h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
                    />
                    <span className="text-sm font-semibold w-16 text-right">{((timings[key] as number) / 1000).toFixed(1)}s</span>
                  </div>
                  <p className="text-xs text-muted-foreground">{b.help}</p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

{/* Engine Timings & Cron Schedule */}
       <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <Clock className="h-5 w-5 text-blue-600" />
            <div>
              <CardTitle>Engine Timings &amp; Cron Schedule</CardTitle>
              <CardDescription>
                Tunable cadence for the realtime tick, strategy flow, cron sweep, and progression buffer.
                Changes labelled <Badge variant="secondary" className="mx-1 py-0 px-1.5 text-[10px]">Live</Badge>
                take effect within ~10 s (in-memory cache TTL). Changes labelled{" "}
                <Badge variant="outline" className="mx-1 py-0 px-1.5 text-[10px]">Restart</Badge>
                require restarting the engine to apply.
              </CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="p-3 bg-blue-50 border border-blue-200 rounded-lg flex gap-2">
            <AlertCircle className="h-5 w-5 text-blue-700 shrink-0 mt-0.5" />
            <div className="text-sm text-blue-900">
              <p className="font-medium">Sub-minute cron cadence</p>
              <p className="text-xs mt-1">
                Vercel cron schedules at minute granularity. The sync-live-positions handler self-loops within each 60-second invocation,
                sleeping <code className="font-mono">cron_sync_interval_seconds</code> between sweeps to give you faster effective cadence
                (e.g. 15 s = 4 sweeps per cron tick).
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {(Object.keys(TIMING_BOUNDS) as (keyof EngineTimings)[]).map((key) => {
              const b = TIMING_BOUNDS[key]
              const labelText = key
                // camelCase → "Camel Case"
                .replace(/([A-Z])/g, " $1")
                .replace(/^./, (c) => c.toUpperCase())
                .replace(/\bMs\b/, "(ms)")
                .replace(/\bSeconds\b/, "(sec)")
              return (
                <div key={key} className="space-y-2 p-3 border rounded-lg bg-slate-50/50">
                  <div className="flex items-center justify-between gap-2">
                    <Label className="text-sm font-medium leading-tight">{labelText}</Label>
                    {b.live ? (
                      <Badge variant="secondary" className="py-0 px-1.5 text-[10px] shrink-0">Live</Badge>
                    ) : (
                      <Badge variant="outline" className="py-0 px-1.5 text-[10px] shrink-0">Restart</Badge>
                    )}
                  </div>
                  <Input
                    type="number"
                    min={b.min}
                    max={b.max}
                    step={b.unit === "sec" ? 1 : 100}
                    value={timings[key]}
                    onChange={(e) => {
                      const raw = e.target.value
                      // Allow empty string while typing — only commit a
                      // valid number into state. Clamp on save server-side.
                      if (raw === "") {
                        setTimings({ ...timings, [key]: 0 })
                        return
                      }
                      const n = parseFloat(raw)
                      if (Number.isFinite(n)) {
                        setTimings({ ...timings, [key]: n })
                      }
                    }}
                    className="bg-white font-mono"
                  />
                  <p className="text-xs text-muted-foreground leading-snug">{b.help}</p>
                  <p className="text-[10px] text-muted-foreground font-mono">
                    Range: {b.min.toLocaleString()}{key === "maxPositionHoldMs" && b.min === 0 ? " (off)" : ""} – {b.max.toLocaleString()} {b.unit}
                  </p>
                </div>
              )
            })}
          </div>
        </CardContent>
      </Card>

      {/* Save Button */}
      <div className="flex gap-2 justify-end">
        <Button variant="outline" onClick={loadSettings} disabled={saving}>
          Reset
        </Button>
        <Button onClick={handleSave} disabled={saving}>
          {saving ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </div>
  )
}
