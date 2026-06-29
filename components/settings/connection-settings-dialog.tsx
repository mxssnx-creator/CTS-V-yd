"use client"

import { DEFAULT_VOLUME_STEP_RATIO, MAX_VOLUME_STEP_RATIO, MIN_VOLUME_FACTOR, MIN_VOLUME_STEP_RATIO } from "@/lib/constants"
import { useState, useEffect, useCallback, useMemo } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Loader2,
  Save,
  RefreshCw,
  Plus,
  X,
  TrendingUp,
  Zap,
  ArrowDownUp,
  ListFilter,
  Sparkles,
  Database,
  Activity,
  Bookmark,
  Trash2,
  Check,
  FolderOpen,
  ChevronDown,
  ChevronUp,
  Flame,
  CheckSquare,
  Square,
} from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { toast } from "@/lib/simple-toast"
// Collapsed to a single-line import: an earlier edit cycle left a stale
// HMR module record for this file in `.next/cache`, causing the named
// export `StrategyCoordinationSection` to resolve to `undefined` at
// render time ("StrategyCoordinationSection is not defined"). A
// fresh import shape forces the bundler to emit a new module id.
import { StrategyCoordinationSection, DEFAULT_COORDINATION_SETTINGS, type CoordinationSettings } from "@/components/settings/strategy-coordination-section"

// ─────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────

interface ConnectionSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  connectionName: string
  exchange?: string
}

interface SettingsPreset {
  name:       string
  created_at: string
  updated_at: string
  payload:    Record<string, unknown>
}

// ─────────────────────────────────────────────────────────────────────
// DATA SHAPES
// ─────────────────────────────────────────────────────────────────────

const INDICATION_TYPES = ["direction", "move", "active", "optimal", "auto"] as const
type IndicationType = (typeof INDICATION_TYPES)[number]

interface IndicationParams {
  enabled: boolean
  range: number
  timeout: number
  interval: number
}
type ChannelProfile = Record<IndicationType, IndicationParams>

const STRATEGY_TYPES = ["base", "main", "real"] as const
type StrategyType = (typeof STRATEGY_TYPES)[number]

interface StrategyParams {
  enabled: boolean
  min_profit_factor: number
  max_drawdown_time: number
  max_positions: number
}
type StrategyChannel = Record<StrategyType, StrategyParams>

type SymbolOrder =
  | "volume_24h"
  | "volume_1h"
  | "volatility_24h"
  | "volatility_1h"
  | "newest"
  | "manual"

function parseVolumeFactor(raw: unknown, fallback: number): number {
  if (raw === undefined || raw === null || raw === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : fallback
}

function parseVolumeStepRatio(raw: unknown, fallback = DEFAULT_VOLUME_STEP_RATIO): number {
  const parsed = parseVolumeFactor(raw, fallback)
  return Math.max(MIN_VOLUME_STEP_RATIO, Math.min(MAX_VOLUME_STEP_RATIO, parsed))
}

interface OverviewSettings {
  volumeFactorBase:   number
  volumeFactorLive:   number
  volumeFactorPreset: number
  volumeStepRatio: number
  marginMode:  "cross" | "isolated"
  volumeType:  "usdt" | "contract" | "spot"
  positionMode: "one_way" | "hedge"
  leveragePercentage: number
  useMaximalLeverage: boolean
  /**
   * When true: do NOT place exchange-side reduce-only SL/TP control
   * orders for live positions on this connection. The engine instead
   * monitors markPrice each reconcile/sync cycle and force-closes the
   * position via a market reduce-only order when the desired band is
   * crossed. Existing control orders on open positions are swept on the
   * next cycle after the flag flips on.
   */
  useSystemCloseOnly: boolean
}

interface SymbolsSettings {
  symbols:     string[]
  symbolOrder: SymbolOrder
  symbolCount: number
}

const DEFAULT_INDICATION_PROFILE: ChannelProfile = {
  direction: { enabled: true,  range: 5,  timeout: 30, interval: 1 },
  move:      { enabled: true,  range: 10, timeout: 30, interval: 1 },
  active:    { enabled: true,  range: 15, timeout: 60, interval: 5 },
  optimal:   { enabled: false, range: 20, timeout: 60, interval: 5 },
  auto:      { enabled: false, range: 25, timeout: 90, interval: 15 },
}
// Operator-spec defaults: base PF 1.0, main/real PF 1.2; max positions
// raised for high-throughput pipelines (base/main: 5000, real: 2000).
// Operator spec: base PF=1.0, main/real PF=1.2; max positions raised for high-throughput pipelines.
const DEFAULT_STRATEGY_PROFILE: StrategyChannel = {
  base: { enabled: true, min_profit_factor: 1.0, max_drawdown_time: 160, max_positions: 10000 },
  main: { enabled: true, min_profit_factor: 1.2, max_drawdown_time: 160, max_positions: 10000 },
  real: { enabled: true, min_profit_factor: 1.2, max_drawdown_time: 160, max_positions: 5000  },
}

// ─────────────────────────────────────────────────────────────────────
// COMPONENT
// ─────────────────────────────────────────────────────────────────────

export function ConnectionSettingsDialog({
  open,
  onOpenChange,
  connectionId,
  connectionName,
  exchange = "bingx",
}: ConnectionSettingsDialogProps) {
  const [tab, setTab] = useState<"overview" | "live" | "symbols" | "indications" | "strategies">("overview")

  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [exchangeKey, setExchangeKey] = useState<string>(exchange)

  // ── Overview state ──────────────────────────────────────────────
  const [overview, setOverview] = useState<OverviewSettings>({
    volumeFactorBase: MIN_VOLUME_FACTOR,
    volumeFactorLive: MIN_VOLUME_FACTOR,
    volumeFactorPreset: MIN_VOLUME_FACTOR,
    volumeStepRatio: DEFAULT_VOLUME_STEP_RATIO,
    marginMode: "cross",
    volumeType: "usdt",
    positionMode: "one_way",
    leveragePercentage: 100,
    useMaximalLeverage: true,
    useSystemCloseOnly: false,
  })

  // ── Symbols state ───────────────────────────────────────────────
  // Operator spec: default symbolOrder = volatility_1h, symbolCount = 20
  const [symbolsCfg, setSymbolsCfg] = useState<SymbolsSettings>({
    symbols: [],
    symbolOrder: "volatility_1h",
    symbolCount: 20,
  })
  const [symbolInput, setSymbolInput] = useState("")
  const [exchangeSymbols, setExchangeSymbols] = useState<string[]>([])
  // Full ticker objects (includes atr1h when sort=volatility_1h)
  const [exchangeTickers, setExchangeTickers] = useState<Array<{ symbol: string; priceChangePercent: number; volume: number; atr1h?: number }>>([])
  const [loadingSymbols, setLoadingSymbols] = useState(false)
  // Separate loading flag for the 1h volatility auto-select (kline fetch takes ~2s)
  const [loadingVolatility1h, setLoadingVolatility1h] = useState(false)
  // The symbols the engine is currently running with (from active_symbols).
  // Shown as a read-only preview so the operator knows what takes effect
  // before and after saving.
  const [activeSymbols, setActiveSymbols] = useState<string[]>([])

  // ── Indications & Strategies state (per channel) ────────────────
  const [indMain,   setIndMain]   = useState<ChannelProfile>(DEFAULT_INDICATION_PROFILE)
  const [indPreset, setIndPreset] = useState<ChannelProfile>(DEFAULT_INDICATION_PROFILE)
  const [stratMain,   setStratMain]   = useState<StrategyChannel>(DEFAULT_STRATEGY_PROFILE)
  const [stratPreset, setStratPreset] = useState<StrategyChannel>(DEFAULT_STRATEGY_PROFILE)
  const [coordination, setCoordination] = useState<CoordinationSettings>(DEFAULT_COORDINATION_SETTINGS)

  // ── Settings presets ────────────────────────────────────────────
  const [presets,        setPresets]        = useState<SettingsPreset[]>([])
  const [presetsOpen,    setPresetsOpen]    = useState(false)
  const [presetName,     setPresetName]     = useState("")
  const [presetSaving,   setPresetSaving]   = useState(false)
  const [presetLoading,  setPresetLoading]  = useState<string | null>(null) // name of preset being loaded
  const [presetDeleting, setPresetDeleting] = useState<string | null>(null) // name being deleted
  const [presetConfirm,  setPresetConfirm]  = useState<string | null>(null) // name awaiting delete confirm

  const fetchPresets = useCallback(async () => {
    try {
      const res = await fetch(`/api/settings/connections/${connectionId}/settings-presets`)
      if (!res.ok) return
      const data = await res.json()
      setPresets(Array.isArray(data.presets) ? data.presets : [])
    } catch {
      // non-fatal
    }
  }, [connectionId])

  const savePreset = useCallback(async () => {
    const trimmed = presetName.trim()
    if (!trimmed) return
    setPresetSaving(true)
    try {
      // Build current dialog state as payload — same shape as saveAll sends
      const payload = {
        volume_factor_live:   overview.volumeFactorLive,
        volume_factor_preset: overview.volumeFactorPreset,
        volume_step_ratio:   overview.volumeStepRatio,
        margin_mode:          overview.marginMode,
        volume_type:          overview.volumeType,
        position_mode:        overview.positionMode,
        leveragePercentage:   overview.leveragePercentage,
        useMaximalLeverage:   overview.useMaximalLeverage,
        use_system_close_only: overview.useSystemCloseOnly,
        symbol_order:         symbolsCfg.symbolOrder,
        symbol_count:         symbolsCfg.symbolCount,
        symbols:              symbolsCfg.symbols,
        strategies:           { main: stratMain, preset: stratPreset },
        coordination_settings: coordination,
        prevPosMinCount:      coordination.prevPosMinCount,
        mainEvalPosCount:     coordination.mainEvalPosCount,
        realEvalPosCount:     coordination.realEvalPosCount,
        prevPosWindow:        coordination.prevPosWindow,
        minStep:              coordination.minStep ?? 5,
        control_orders:       true,
        variant_trailing:     coordination.variants.trailing !== false,
        variant_block:        coordination.variants.block    !== false,
        variant_dca:          coordination.variants.dca      === true,
      }
      const res = await fetch(`/api/settings/connections/${connectionId}/settings-presets`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name: trimmed, payload }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>
        throw new Error((err.error as string) || "Save failed")
      }
      const saved = await res.json()
      toast.success(saved.isNew ? "Preset saved" : "Preset updated", { description: `"${trimmed}"` })
      setPresetName("")
      await fetchPresets()
    } catch (err) {
      toast.error("Preset save failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setPresetSaving(false)
    }
  }, [connectionId, presetName, overview, symbolsCfg, stratMain, stratPreset, coordination, fetchPresets])

  const loadPreset = useCallback(async (preset: SettingsPreset) => {
    setPresetLoading(preset.name)
    try {
      const p = preset.payload
      if (!p || typeof p !== "object") throw new Error("Preset payload is empty")

      // Apply overview settings
      setOverview(prev => ({
        ...prev,
        volumeFactorBase:   parseVolumeFactor(p.volume_factor, prev.volumeFactorBase),
        volumeFactorLive:   parseVolumeFactor(p.volume_factor_live, prev.volumeFactorLive),
        volumeFactorPreset: parseVolumeFactor(p.volume_factor_preset, prev.volumeFactorPreset),
        volumeStepRatio:   parseVolumeStepRatio(p.volume_step_ratio ?? p.volumeStepRatio, prev.volumeStepRatio),
        marginMode:        (p.margin_mode    as "cross" | "isolated") || prev.marginMode,
        volumeType:        (p.volume_type    as "usdt" | "contract" | "spot") || prev.volumeType,
        positionMode:      (p.position_mode  as "one_way" | "hedge") || prev.positionMode,
        leveragePercentage: Number(p.leveragePercentage)   || prev.leveragePercentage,
        useMaximalLeverage: p.useMaximalLeverage !== false && p.useMaximalLeverage !== "false",
        useSystemCloseOnly: p.use_system_close_only === true || p.useSystemCloseOnly === true,
      }))

      // Apply symbols settings
      setSymbolsCfg(prev => ({
        ...prev,
        symbolOrder: (p.symbol_order as typeof prev.symbolOrder) || prev.symbolOrder,
        symbolCount: Number(p.symbol_count) || prev.symbolCount,
        symbols:     Array.isArray(p.symbols) ? (p.symbols as string[]) : prev.symbols,
      }))

      // Apply strategy channel settings
      const strats = p.strategies as Record<string, unknown> | undefined
      if (strats?.main) setStratMain(prev => ({ ...prev, ...(strats.main as object) }))
      if (strats?.preset) setStratPreset(prev => ({ ...prev, ...(strats.preset as object) }))

      // Apply coordination
      const coord = (p.coordination_settings || p.coordinationSettings) as Partial<CoordinationSettings> | undefined
      if (coord && typeof coord === "object") {
        setCoordination(prev => ({
          ...prev,
          ...coord,
          variants: { ...prev.variants, ...(coord.variants ?? {}) },
        }))
      }

      toast.success("Preset loaded", { description: `"${preset.name}" — review and save to apply` })
    } catch (err) {
      toast.error("Failed to load preset", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setPresetLoading(null)
    }
  }, [])

  const deletePreset = useCallback(async (name: string) => {
    setPresetDeleting(name)
    setPresetConfirm(null)
    try {
      const res = await fetch(`/api/settings/connections/${connectionId}/settings-presets`, {
        method:  "DELETE",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ name }),
      })
      if (!res.ok) throw new Error("Delete failed")
      toast.success("Preset deleted", { description: `"${name}"` })
      await fetchPresets()
    } catch (err) {
      toast.error("Delete failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setPresetDeleting(null)
    }
  }, [connectionId, fetchPresets])

  // ─────────────────────────────────────────────────────────────────
  // LOAD — fetch saved settings from Redis and hydrate all dialog state
  // ──────────────────────────────────────────────────────��──────────

  const loadAllSettings = useCallback(async () => {
    setLoading(true)
    try {
      const [settingsRes, indRes, symRes] = await Promise.all([
        fetch(`/api/settings/connections/${connectionId}/settings`).catch(() => null),
        fetch(`/api/settings/connections/${connectionId}/active-indications`).catch(() => null),
        fetch(`/api/settings/connections/${connectionId}/symbols`).catch(() => null),
      ])

      if (settingsRes?.ok) {
        const data = await settingsRes.json()
        const settings = data.settings || {}
        const conn     = data.connection || {}
        setExchangeKey(String(conn.exchange || exchange).toLowerCase())
        setOverview({
          volumeFactorBase:   parseVolumeFactor(settings.volume_factor, parseVolumeFactor(conn.volume_factor, MIN_VOLUME_FACTOR)),
          // Read live/preset factor from BOTH the settings hash (volume_factor_live) and
          // the connection hash (live_volume_factor) so changes made via the card's inline
          // volume sliders (which write to the connection hash via the /volume route) are
          // always reflected when the dialog opens.
          volumeFactorLive:   parseVolumeFactor(settings.volume_factor_live, parseVolumeFactor(conn.live_volume_factor, MIN_VOLUME_FACTOR)),
          volumeFactorPreset: parseVolumeFactor(settings.volume_factor_preset, parseVolumeFactor(conn.preset_volume_factor, MIN_VOLUME_FACTOR)),
          volumeStepRatio:   parseVolumeStepRatio(settings.volume_step_ratio ?? conn.volume_step_ratio),
          marginMode:  (settings.margin_mode || conn.margin_type || "cross") as "cross" | "isolated",
          volumeType:  (settings.volume_type || (conn.api_type === "futures_inverse" ? "contract" : conn.api_type === "spot" ? "spot" : "usdt")) as "usdt" | "contract" | "spot",
          positionMode: (settings.position_mode || conn.position_mode || "one_way") as "one_way" | "hedge",
          leveragePercentage: Number(settings.leveragePercentage) || 100,
          useMaximalLeverage: settings.useMaximalLeverage !== false && settings.useMaximalLeverage !== "false",
          useSystemCloseOnly: settings.use_system_close_only === true || settings.useSystemCloseOnly === true,
        })
        setSymbolsCfg(prev => ({
          ...prev,
          symbols:     Array.isArray(settings.symbols) ? settings.symbols : prev.symbols,
          symbolOrder: (settings.symbol_order as SymbolOrder) || prev.symbolOrder,
          symbolCount: Number(settings.symbol_count) || prev.symbolCount,
        }))
        const rawActive = conn.active_symbols || settings.active_symbols
        const parsedActive: string[] = (() => {
          if (Array.isArray(rawActive)) return rawActive.filter(Boolean)
          if (typeof rawActive === "string" && rawActive.startsWith("[")) {
            try { return JSON.parse(rawActive).filter(Boolean) } catch { /* fall through */ }
          }
          if (typeof rawActive === "string" && rawActive.length > 0) return [rawActive]
          return []
        })()
        setActiveSymbols(parsedActive)

        const mergeStratChannel = (saved: unknown, defaults: StrategyChannel): StrategyChannel => {
          if (!saved || typeof saved !== "object") return defaults
          const s = saved as Record<string, unknown>
          const mergeStage = (stage: StrategyType): StrategyParams => {
            const rawVal = s[stage]
            const raw = (rawVal && typeof rawVal === "object" ? rawVal : {}) as Record<string, unknown>
            const def = defaults[stage]
            return {
              enabled:           typeof raw.enabled === "boolean" ? raw.enabled : def.enabled,
              min_profit_factor: Number.isFinite(Number(raw.min_profit_factor)) && Number(raw.min_profit_factor) >= 0.1 ? Number(raw.min_profit_factor) : def.min_profit_factor,
              max_drawdown_time: Number.isFinite(Number(raw.max_drawdown_time)) && Number(raw.max_drawdown_time) >= 20  ? Number(raw.max_drawdown_time)  : def.max_drawdown_time,
              max_positions:     Number.isFinite(Number(raw.max_positions))     && Number(raw.max_positions)     >= 1   ? Number(raw.max_positions)      : def.max_positions,
            }
          }
          return { base: mergeStage("base"), main: mergeStage("main"), real: mergeStage("real") }
        }
        if (settings.strategies?.main)   setStratMain(mergeStratChannel(settings.strategies.main, DEFAULT_STRATEGY_PROFILE))
        if (settings.strategies?.preset) setStratPreset(mergeStratChannel(settings.strategies.preset, DEFAULT_STRATEGY_PROFILE))

        const coord = settings.coordination_settings || settings.coordinationSettings
        if (coord) {
          setCoordination(prev => ({
            ...DEFAULT_COORDINATION_SETTINGS,
            ...prev,
            ...coord,
            axes:     { ...DEFAULT_COORDINATION_SETTINGS.axes,     ...(coord.axes     || {}) },
            variants: { ...DEFAULT_COORDINATION_SETTINGS.variants, ...(coord.variants || {}) },
            blockVolumeRatio: typeof coord.blockVolumeRatio === "number" ? coord.blockVolumeRatio : DEFAULT_COORDINATION_SETTINGS.blockVolumeRatio,
            blockMaxStack:    typeof coord.blockMaxStack    === "number" ? coord.blockMaxStack    : DEFAULT_COORDINATION_SETTINGS.blockMaxStack,
            blockPauseCountRatio: typeof coord.blockPauseCountRatio === "number" ? coord.blockPauseCountRatio : DEFAULT_COORDINATION_SETTINGS.blockPauseCountRatio,
            blockActiveRealEnabled: typeof coord.blockActiveRealEnabled === "boolean" ? coord.blockActiveRealEnabled : typeof coord.blockActiveLiveEnabled === "boolean" ? coord.blockActiveLiveEnabled : DEFAULT_COORDINATION_SETTINGS.blockActiveRealEnabled,
            blockActiveLiveEnabled: typeof coord.blockActiveLiveEnabled === "boolean" ? coord.blockActiveLiveEnabled : DEFAULT_COORDINATION_SETTINGS.blockActiveLiveEnabled,
            prevPosMinCount: (() => {
              const flat = Number((settings as Record<string, unknown>).prevPosMinCount ?? (settings as Record<string, unknown>).prevPiMinCount)
              if (Number.isFinite(flat) && flat >= 1) return Math.min(50, Math.floor(flat))
              const nested = Number((coord as Record<string, unknown>).prevPosMinCount ?? (coord as Record<string, unknown>).prevPiMinCount)
              if (Number.isFinite(nested) && nested >= 1) return Math.min(50, Math.floor(nested))
              return DEFAULT_COORDINATION_SETTINGS.prevPosMinCount
            })(),
            mainEvalPosCount: (() => {
              const snap = (n: number) => Math.min(50, Math.max(5, Math.round(n / 5) * 5))
              const flat = Number((settings as Record<string, unknown>).mainEvalPosCount)
              if (Number.isFinite(flat) && flat >= 1) return snap(flat)
              const nested = Number((coord as Record<string, unknown>).mainEvalPosCount)
              if (Number.isFinite(nested) && nested >= 1) return snap(nested)
              return DEFAULT_COORDINATION_SETTINGS.mainEvalPosCount
            })(),
            realEvalPosCount: (() => {
              const flat = Number((settings as Record<string, unknown>).realEvalPosCount)
              if (Number.isFinite(flat) && flat >= 1) return Math.min(50, Math.max(1, flat))
              const nested = Number((coord as Record<string, unknown>).realEvalPosCount)
              if (Number.isFinite(nested) && nested >= 1) return Math.min(50, Math.max(1, nested))
              return DEFAULT_COORDINATION_SETTINGS.realEvalPosCount
            })(),
            minStep: (() => {
              const flat = Number((settings as Record<string, unknown>).minStep)
              if (Number.isFinite(flat) && flat >= 2) return Math.min(30, Math.max(2, Math.round(flat)))
              const nested = Number((coord as Record<string, unknown>).minStep)
              if (Number.isFinite(nested) && nested >= 2) return Math.min(30, Math.max(2, Math.round(nested)))
              return DEFAULT_COORDINATION_SETTINGS.minStep ?? 5
            })(),
            trailingMinStep: (() => {
              const flat = Number((settings as Record<string, unknown>).trailingMinStep)
              if (Number.isFinite(flat) && flat >= 2) return Math.min(30, Math.max(2, Math.round(flat)))
              const nested = Number((coord as Record<string, unknown>).trailingMinStep)
              if (Number.isFinite(nested) && nested >= 2) return Math.min(30, Math.max(2, Math.round(nested)))
              return DEFAULT_COORDINATION_SETTINGS.trailingMinStep ?? 6
            })(),
          }))
        }
      }

      if (indRes?.ok) {
        const data = await indRes.json()
        const channels = data.channels || {}
        if (channels.main)   setIndMain(channels.main)
        if (channels.preset) setIndPreset(channels.preset)
      }

      if (symRes?.ok) {
        const data = await symRes.json()
        if (Array.isArray(data.symbols) && data.symbols.length > 0) {
          setExchangeSymbols(data.symbols)
        }
      }
    } catch (err) {
      console.error("[v0] [Settings Dialog] loadAllSettings error:", err)
    } finally {
      setLoading(false)
    }
  // Reload settings whenever the active connection or exchange changes.
  // connectionId and exchange are stable — both come from props and don't change
  // within a single dialog open. Excluding them from the dep array intentionally
  // to avoid re-triggering on every render cycle.

  }, [connectionId, exchange])

  // ─────────────────────────────────────────────────────────────────
  // SAVE
  // ─��──────────────────────────────────��────────────────────────────

  const saveAll = useCallback(async () => {
    setSaving(true)
    try {
      const payload = {
        // Overview
        volume_factor_live:   overview.volumeFactorLive,
        volume_factor_preset: overview.volumeFactorPreset,
        volume_step_ratio:   overview.volumeStepRatio,
        margin_mode: overview.marginMode,
        volume_type: overview.volumeType,
        position_mode: overview.positionMode,
        leveragePercentage: overview.leveragePercentage,
        useMaximalLeverage: overview.useMaximalLeverage,
        use_system_close_only: overview.useSystemCloseOnly,
        useSystemCloseOnly:    overview.useSystemCloseOnly, // backwards-compat alias
        // Symbols
        symbols:      symbolsCfg.symbols,
        symbol_order: symbolsCfg.symbolOrder,
        symbol_count: symbolsCfg.symbolCount,
        // Strategies (per channel)
        strategies: {
          main:   stratMain,
          preset: stratPreset,
        },
        // Strategy coordination (axes + variants toggles).
        // These MUST be top-level keys in the payload — NOT nested inside
        // `strategies`. Previously they were mis-indented one level too deep,
        // which caused them to be persisted as `strategies.coordination_settings`
        // and never reached the engine's connection_settings hash reader.
        coordination_settings: coordination,
        coordinationSettings:  coordination, // legacy alias
        // Flat top-level mirrors so the engine + `getStrategyTracking`
        // can read them as plain `connection_settings` HASH fields
        // without parsing the nested coordination JSON every cycle.
        prevPosMinCount:  coordination.prevPosMinCount,
        mainEvalPosCount: coordination.mainEvalPosCount,
        realEvalPosCount: coordination.realEvalPosCount,
        prevPosWindow:    coordination.prevPosWindow,
        minStep:          coordination.minStep ?? 5,
        trailingMinStep:  coordination.trailingMinStep ?? 6,
        // Control orders (SL/TP placement toggle) — operator spec: on by default
        control_orders:   true,
        // Flat variant toggles for backwards compat with old hash readers
        variant_trailing: coordination.variants.trailing !== false,
        variant_block:    coordination.variants.block    !== false,
        variant_dca:      coordination.variants.dca      === true,
      }

      // Save in a deterministic order. The settings PATCH already mirrors
      // volume factors into both the connection hash and `connection_settings`,
      // so issuing a parallel `/volume` write here created a race between two
      // change envelopes and occasionally hot-reloaded stale values.
      const settingsRes = await fetch(`/api/settings/connections/${connectionId}/settings`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      })
      if (!settingsRes.ok) throw new Error("Settings save failed")

      const indRes = await fetch(`/api/settings/connections/${connectionId}/active-indications`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ channels: { main: indMain, preset: indPreset } }),
      })
      if (!indRes.ok) throw new Error("Indications save failed")

      // Re-read active_symbols from the updated settings response so the
      // toast can show what the engine will actually run next cycle.
      let resolvedDesc = `Updated ${connectionName}`
      try {
        const saved = await settingsRes.clone().json().catch(() => ({})) as Record<string, unknown>
        const settingsData = (saved.settings || {}) as Record<string, unknown>
        const rawResolved = settingsData.active_symbols || settingsData.symbols
        const resolvedList: string[] = (() => {
          if (Array.isArray(rawResolved)) return (rawResolved as string[]).filter(Boolean)
          if (typeof rawResolved === "string" && rawResolved.startsWith("[")) {
            try { return (JSON.parse(rawResolved) as string[]).filter(Boolean) } catch { /* fall through */ }
          }
          return []
        })()
        if (resolvedList.length > 0) {
          resolvedDesc = `Symbols: ${resolvedList.join(", ")}`
          setActiveSymbols(resolvedList)
        }
      } catch { /* non-fatal — description falls back to connection name */ }

      toast.success("Settings saved", { description: resolvedDesc })
      window.dispatchEvent(new CustomEvent("connection-settings-updated", {
        detail: {
          connectionId,
          settings: {
            ...payload,
            live_volume_factor: overview.volumeFactorLive,
            preset_volume_factor: overview.volumeFactorPreset,
            volume_step_ratio: overview.volumeStepRatio,
          },
        },
      }))
      onOpenChange(false)
    } catch (err) {
      console.error("[v0] [Settings Dialog] save error:", err)
      toast.error("Save failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }, [connectionId, connectionName, overview, symbolsCfg, stratMain, stratPreset, indMain, indPreset, coordination, onOpenChange])

  // ─────────────────────────────────────────────────────────────────
  // SYMBOL HELPERS
  // ─────────────────────────────────────────────────────────────────

  const fetchExchangeSymbols = useCallback(async () => {
    if (!exchangeKey) return
    setLoadingSymbols(true)
    try {
      const res = await fetch(
        `/api/settings/connections/${connectionId}/symbols?order=${symbolsCfg.symbolOrder}&count=50`
      ).catch(() => null)
      if (res?.ok) {
        const data = await res.json()
        const list: string[] = Array.isArray(data.symbols) ? data.symbols
          : Array.isArray(data.available) ? data.available : []
        setExchangeSymbols(list)
        // Store full ticker objects for the ranked preview table
        if (Array.isArray(data.tickers)) {
          setExchangeTickers(data.tickers)
        }
      }
    } catch { /* non-fatal */ }
    finally { setLoadingSymbols(false) }
  }, [connectionId, exchangeKey, symbolsCfg.symbolOrder])

  // Auto-selects top-N symbols by true 1h ATR volatility.
  // Fetches live klines for the top-50 volume pool, re-ranks by (high−low)/open,
  // then populates `symbolsCfg.symbols` and switches symbolOrder to volatility_1h
  // so the engine's PATCH resolver auto-applies them on the next engine start.
  const autoSelectByVolatility1h = useCallback(async () => {
    setLoadingVolatility1h(true)
    try {
      const res = await fetch(
        `/api/settings/connections/${connectionId}/symbols?order=volatility_1h&count=${Math.max(symbolsCfg.symbolCount, 20)}`
      ).catch(() => null)
      if (!res?.ok) throw new Error("Failed to fetch 1h volatility symbols")
      const data = await res.json()
      const tickers: Array<{ symbol: string; priceChangePercent: number; volume: number; atr1h?: number }> =
        Array.isArray(data.tickers) ? data.tickers : []
      const symbols: string[] = tickers.map((t) => t.symbol)
      if (symbols.length === 0) throw new Error("No symbols returned")

      setExchangeSymbols(symbols)
      setExchangeTickers(tickers)
      setSymbolsCfg(prev => ({
        ...prev,
        symbols: symbols.slice(0, prev.symbolCount),
        symbolOrder: "volatility_1h",
      }))
      toast.success(
        `Auto-selected top ${Math.min(symbols.length, symbolsCfg.symbolCount)} by 1h ATR`,
        { description: symbols.slice(0, symbolsCfg.symbolCount).join(", ") },
      )
    } catch (err) {
      toast.error("Auto-select failed", { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setLoadingVolatility1h(false)
    }
  }, [connectionId, symbolsCfg.symbolCount])

  // Auto-populate exchange symbol suggestions when dialog opens or symbol
  // order/exchange changes so the Symbols tab picker is always pre-loaded.
  useEffect(() => {
    if (!open) return
    fetchExchangeSymbols()

  }, [open, exchangeKey, symbolsCfg.symbolOrder])

  const addSymbol = useCallback((sym: string) => {
    const clean = sym.trim().toUpperCase()
    if (!clean) return
    setSymbolsCfg(prev =>
      prev.symbols.includes(clean) ? prev : { ...prev, symbols: [...prev.symbols, clean] },
    )
    setSymbolInput("")
  }, [])

  const removeSymbol = useCallback((sym: string) => {
    setSymbolsCfg(prev => ({ ...prev, symbols: prev.symbols.filter(s => s !== sym) }))
  }, [])

  const orderLabel: Record<SymbolOrder, string> = {
    volume_24h:     "Top Volume (24h)",
    volume_1h:      "Top Volume (1h)",
    volatility_24h: "Top Volatility (24h)",
    volatility_1h:  "Top Volatility (1h)",
    newest:         "Newest Listings",
    manual:         "Manual",
  }

  const availableSymbols = useMemo(
    () => exchangeSymbols.filter(s => !symbolsCfg.symbols.includes(s)).slice(0, 25),
    [exchangeSymbols, symbolsCfg.symbols],
  )

  // ──────────────────────────────────────────────��──────────────────
  // OPEN EFFECT — fires when the dialog opens; loads settings + presets.
  // Declared after all useCallback refs so they are in scope.
  // ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!open) return
    setTab("overview")
    setPresetsOpen(false)
    setPresetName("")
    setPresetConfirm(null)
    loadAllSettings()
    fetchPresets()
    // Opening the dialog resets the transient preset state and refreshes data.
    // Stable stable refs — intentionally omit from dep array to avoid
    // retriggering on every render. `open` is the only signal we need.

  }, [open])

  // ─────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────���────────

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl h-[90dvh] max-h-[90dvh] overflow-hidden flex flex-col p-0 [&>button]:z-10">
        {/* Header */}
        <DialogHeader className="px-5 pt-4 pb-3 border-b shrink-0">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0">
              <DialogTitle className="text-base font-semibold truncate">
                Update Settings — {connectionName}
              </DialogTitle>
              <DialogDescription className="text-xs">
                Configure live execution, volumes, symbols, indications and strategies for this connection.
              </DialogDescription>
            </div>
            <Badge variant="outline" className="text-[10px] uppercase">
              {exchangeKey}
            </Badge>
          </div>
        </DialogHeader>

        {/* Top Tabs */}
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex-1 flex flex-col overflow-hidden min-h-0">
          <TabsList className="mx-5 mt-3 grid grid-cols-5 h-9 shrink-0 z-10">
            <TabsTrigger value="overview" className="text-xs gap-1.5">
              <Activity className="h-3.5 w-3.5" /> Overview
            </TabsTrigger>
            <TabsTrigger value="live" className="text-xs gap-1.5">
              <Flame className="h-3.5 w-3.5" /> Live
            </TabsTrigger>
            <TabsTrigger value="symbols" className="text-xs gap-1.5">
              <Database className="h-3.5 w-3.5" /> Symbols
            </TabsTrigger>
            <TabsTrigger value="indications" className="text-xs gap-1.5">
              <TrendingUp className="h-3.5 w-3.5" /> Indications
            </TabsTrigger>
            <TabsTrigger value="strategies" className="text-xs gap-1.5">
              <Zap className="h-3.5 w-3.5" /> Strategies
            </TabsTrigger>
          </TabsList>

          {/* The ScrollArea must receive a concrete height so Radix can
              measure its internal viewport and position the scroll thumb.
              `min-h-0` is critical on flex children: without it the flex
              item expands to fit its content and never scrolls. The
              `overflow-hidden` on the `Tabs` parent above combined with
              `flex-1 min-h-0` here constrains the height to the remaining
              space below the TabsList. */}
          <ScrollArea className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
            {loading && (
              <div className="flex items-center justify-center py-12 text-muted-foreground gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading settings…
              </div>
            )}

            {!loading && (
              <>
                {/* OVERVIEW ──────────────────────────────────────── */}
                <TabsContent value="overview" className="mt-0 space-y-5">

                  {/* ── Settings Presets ─────────────────────────── */}
                  <div className="rounded-lg border border-border bg-muted/20 overflow-hidden">
                    {/* Header row — always visible */}
                    <button
                      type="button"
                      onClick={() => setPresetsOpen(p => !p)}
                      className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-muted/40 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2">
                        <Bookmark className="h-3.5 w-3.5 text-primary" />
                        <span className="text-xs font-semibold">Settings Presets</span>
                        {presets.length > 0 && (
                          <span className="inline-flex items-center justify-center rounded-full bg-primary/15 text-primary text-[10px] font-semibold px-1.5 min-w-[18px] h-[18px]">
                            {presets.length}
                          </span>
                        )}
                      </div>
                      {presetsOpen
                        ? <ChevronUp  className="h-3.5 w-3.5 text-muted-foreground" />
                        : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                      }
                    </button>

                    {presetsOpen && (
                      <div className="border-t border-border px-3 pb-3 pt-2 space-y-3">
                        {/* Saved preset list */}
                        {presets.length === 0 ? (
                          <p className="text-[11px] text-muted-foreground text-center py-2">
                            No saved presets yet. Use the form below to save the current settings.
                          </p>
                        ) : (
                          <div className="space-y-1.5">
                            {presets.map((preset) => (
                              <div
                                key={preset.name}
                                className="flex items-center gap-2 rounded-md border border-border bg-background px-2.5 py-2"
                              >
                                {/* Name + timestamp */}
                                <div className="flex-1 min-w-0">
                                  <div className="text-xs font-medium truncate">{preset.name}</div>
                                  <div className="text-[10px] text-muted-foreground">
                                    {preset.updated_at
                                      ? new Date(preset.updated_at).toLocaleString(undefined, {
                                          month: "short", day: "numeric",
                                          hour: "2-digit", minute: "2-digit",
                                        })
                                      : ""}
                                  </div>
                                </div>

                                {/* Load button */}
                                <button
                                  type="button"
                                  onClick={() => loadPreset(preset)}
                                  disabled={presetLoading === preset.name}
                                  className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                  {presetLoading === preset.name
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <FolderOpen className="h-3 w-3" />
                                  }
                                  Load
                                </button>

                                {/* Delete button — two-step confirm */}
                                {presetConfirm === preset.name ? (
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      onClick={() => deletePreset(preset.name)}
                                      disabled={presetDeleting === preset.name}
                                      className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium bg-destructive/10 hover:bg-destructive/20 text-destructive transition-colors disabled:opacity-50"
                                    >
                                      {presetDeleting === preset.name
                                        ? <Loader2 className="h-3 w-3 animate-spin" />
                                        : <Check className="h-3 w-3" />
                                      }
                                      Confirm
                                    </button>
                                    <button
                                      type="button"
                                      onClick={() => setPresetConfirm(null)}
                                      className="rounded px-1.5 py-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                                    >
                                      <X className="h-3 w-3" />
                                    </button>
                                  </div>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => setPresetConfirm(preset.name)}
                                    className="rounded p-1 text-muted-foreground hover:text-destructive transition-colors"
                                    title="Delete preset"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {/* Save new / overwrite form */}
                        <div className="flex items-center gap-2 pt-1">
                          <Input
                            value={presetName}
                            onChange={(e) => setPresetName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); savePreset() } }}
                            placeholder="Preset name…"
                            maxLength={48}
                            className="h-8 text-xs flex-1"
                          />
                          <button
                            type="button"
                            onClick={savePreset}
                            disabled={!presetName.trim() || presetSaving}
                            className="flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                          >
                            {presetSaving
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <Save className="h-3.5 w-3.5" />
                            }
                            Save
                          </button>
                        </div>
                        <p className="text-[10px] text-muted-foreground">
                          Saves current dialog state. Loading a preset applies it to all fields — click Save Settings to apply to the engine.
                        </p>
                      </div>
                    )}
                  </div>

                  <Separator className="my-1" />

                  {/* ── Minimal Position Step — promoted to page 1 per operator spec ─ */}
                  <SectionHeading icon={Sparkles} title="Minimal Base Pseudo Positions Range Step" subtitle="Minimum step size for Base pseudo-position windows (2–30, default 5). Higher values create fewer, smoother position ranges." />
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Base Min Step (2–30)</Label>
                      <span className="text-xs font-mono tabular-nums font-semibold">{coordination.minStep ?? 5}</span>
                    </div>
                    <Slider
                      min={2} max={30} step={1}
                      value={[coordination.minStep ?? 5]}
                      onValueChange={([v]) => setCoordination(p => ({ ...p, minStep: v }))}
                      className="py-2"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>2 — fastest</span><span className="text-muted-foreground/60">default 5</span><span>30 — smooth</span>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">Trailing Min Step (2–30)</Label>
                      <span className="text-xs font-mono tabular-nums font-semibold">{coordination.trailingMinStep ?? 6}</span>
                    </div>
                    <Slider
                      min={2} max={30} step={1}
                      value={[coordination.trailingMinStep ?? 6]}
                      onValueChange={([v]) => setCoordination(p => ({ ...p, trailingMinStep: v }))}
                      className="py-2"
                    />
                    <div className="flex justify-between text-[10px] text-muted-foreground">
                      <span>2 — include fast trailing</span><span className="text-muted-foreground/60">default 6</span><span>30 — only slow trailing</span>
                    </div>
                  </div>

                  <Separator className="my-2" />

                  {/* ── Quick Variant Toggles ─ */}
                  <SectionHeading icon={Zap} title="Strategy Variants" subtitle="Enable or disable the main categorical variants that run on top of base sets." />
                  <div className="grid gap-2">
                    {(["trailing", "block", "dca"] as const).map((key) => {
                      const labels: Record<string, { label: string; desc: string }> = {
                        trailing: { label: "Trailing", desc: "Fires on consecutive wins — aggressive momentum follow." },
                        block:    { label: "Block",    desc: "Add-on entries when continuousCount is 1–2 (independent of axes)." },
                        dca:      { label: "DCA",      desc: "Dollar-cost averaging after prior losses (independent of axes)." },
                      }
                      const enabled = typeof coordination.variants[key] === "boolean" ? coordination.variants[key] : (key !== "dca")
                      return (
                        <div key={key} className={`flex items-center justify-between gap-3 rounded-md border px-3 py-2 transition-colors ${enabled ? "border-primary/30 bg-primary/5" : "border-border bg-muted/20"}`}>
                          <div>
                            <div className="text-xs font-medium">{labels[key].label}</div>
                            <div className="text-[10px] text-muted-foreground leading-relaxed">{labels[key].desc}</div>
                          </div>
                          <Switch
                            checked={enabled}
                            onCheckedChange={(v) => setCoordination(p => ({ ...p, variants: { ...p.variants, [key]: v } }))}
                          />
                        </div>
                      )
                    })}
                  </div>

                  <Separator className="my-2" />

                  <SectionHeading icon={ArrowDownUp} title="Volume Factors" subtitle="Multiplier applied to position size for live and preset channels. Base channel uses internal ratios (system-managed, not configurable)." />
                  <VolumeSlider
                    label="Live"
                    description="Applied while a Live position is open."
                    value={overview.volumeFactorLive}
                    onChange={(v) => setOverview(p => ({ ...p, volumeFactorLive: v }))}
                  />
                  <VolumeSlider
                    label="Preset"
                    description="Applied to the preset profile when active."
                    value={overview.volumeFactorPreset}
                    onChange={(v) => setOverview(p => ({ ...p, volumeFactorPreset: v }))}
                  />
                  <VolumeStepSlider
                    value={overview.volumeStepRatio}
                    onChange={(v) => setOverview(p => ({ ...p, volumeStepRatio: v }))}
                  />

                  <Separator className="my-4" />
                  <SectionHeading icon={ListFilter} title="Position Mode" subtitle="Margin and volume denomination applied to all orders." />

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Margin Mode</Label>
                      <Select
                        value={overview.marginMode}
                        onValueChange={(v) => setOverview(p => ({ ...p, marginMode: v as "cross" | "isolated" }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="cross">Cross Margin</SelectItem>
                          <SelectItem value="isolated">Isolated Margin</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Volume Type</Label>
                      <Select
                        value={overview.volumeType}
                        onValueChange={(v) => setOverview(p => ({ ...p, volumeType: v as "usdt" | "contract" | "spot" }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="usdt">USDT-M Linear</SelectItem>
                          <SelectItem value="contract">Coin-M Inverse</SelectItem>
                          <SelectItem value="spot">Spot</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Position Mode</Label>
                      <Select
                        value={overview.positionMode}
                        onValueChange={(v) => setOverview(p => ({ ...p, positionMode: v as "one_way" | "hedge" }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="one_way">One-Way</SelectItem>
                          <SelectItem value="hedge">Hedge</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className={`space-y-1.5 ${overview.useMaximalLeverage ? "opacity-50 pointer-events-none" : ""}`}>
                      <Label className="text-xs">Leverage %</Label>
                      <NumberField
                        label=""
                        suffix="%"
                        min={1}
                        max={100}
                        step={1}
                        value={overview.leveragePercentage}
                        onChange={(v) => setOverview(p => ({ ...p, leveragePercentage: v }))}
                        disabled={overview.useMaximalLeverage}
                      />
                    </div>
                  </div>

                  <div className="flex items-center justify-between rounded-md border border-border p-3 mt-3">
                    <div className="space-y-0.5">
                      <Label className="text-xs font-medium">Use Maximal Leverage</Label>
                      <p className="text-[11px] text-muted-foreground">
                        {overview.useMaximalLeverage
                          ? "On — engine uses the exchange's maximum supported leverage."
                          : "Off — engine uses Leverage % of exchange max."}
                      </p>
                    </div>
                    <Switch
                      checked={overview.useMaximalLeverage}
                      onCheckedChange={(v) => setOverview(p => ({ ...p, useMaximalLeverage: v }))}
                    />
                  </div>

                  <Separator className="my-4" />
                  <SectionHeading
                    icon={Zap}
                    title="Close Mechanism"
                    subtitle="Choose whether SL/TP are placed on the venue as control orders, or driven by the engine via system close."
                  />

                  <div className="flex items-start justify-between gap-4 rounded-md border border-amber-500/30 bg-amber-500/5 p-3">
                    <div className="flex-1 min-w-0 space-y-1">
                      <Label className="text-xs font-medium">Live Trade Without Control Orders (System Close)</Label>
                      <p className="text-[11px] leading-relaxed text-muted-foreground">
                        When ON, the engine does <strong>not</strong> place reduce-only SL/TP orders on the
                        exchange. Every reconcile and sync tick re-evaluates
                        <code className="text-[10px] px-1 mx-0.5 rounded bg-muted">markPrice</code>
                        against the desired SL/TP band and force-closes the position via a single market
                        reduce-only order when crossed. Any leftover exchange control orders on open positions
                        are swept on the next cycle.
                      </p>
                      <p className="text-[10px] text-amber-600 dark:text-amber-400">
                        Live progress check is wired into every ongoing cycle — every close is verified post-fill.
                      </p>
                    </div>
                    <Switch
                      checked={overview.useSystemCloseOnly}
                      onCheckedChange={(checked) => setOverview(p => ({ ...p, useSystemCloseOnly: checked }))}
                    />
                  </div>
                </TabsContent>

                {/* LIVE ─────────────────────────────────────────── */}
                <TabsContent value="live" className="mt-0 space-y-5">
                  <div className="relative overflow-hidden rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 via-background to-cyan-500/10 p-4">
                    <div className="absolute right-0 top-0 h-24 w-24 rounded-full bg-emerald-500/10 blur-2xl" />
                    <div className="relative flex items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/15">
                            <Flame className="h-4 w-4 text-emerald-500" />
                          </div>
                          <div>
                            <div className="text-sm font-semibold">Live Exchange Execution</div>
                            <div className="text-[11px] text-muted-foreground">Venue sizing, leverage caps, order protection and live-stage limits.</div>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5 pt-2">
                          <Badge variant="outline" className="text-[10px] uppercase">{exchangeKey}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{overview.marginMode} margin</Badge>
                          <Badge variant="secondary" className="text-[10px]">{overview.positionMode.replace("_", " ")}</Badge>
                          <Badge variant="secondary" className="text-[10px]">{activeSymbols.length || symbolsCfg.symbolCount} symbols</Badge>
                        </div>
                      </div>
                      <div className="rounded-lg border border-emerald-500/20 bg-background/70 px-3 py-2 text-right shadow-sm">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Reload mode</div>
                        <div className="text-xs font-semibold text-emerald-600 dark:text-emerald-400">Hot reload, no restart</div>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border bg-card p-4 space-y-4">
                      <SectionHeading icon={ArrowDownUp} title="Sizing & Balance Caps" subtitle="Live notional and balance-step recalculation controls." />
                      <VolumeSlider
                        label="Live Volume Factor"
                        description="Multiplier used only for exchange live orders."
                        value={overview.volumeFactorLive}
                        onChange={(v) => setOverview(p => ({ ...p, volumeFactorLive: v }))}
                      />
                      <VolumeStepSlider
                        value={overview.volumeStepRatio}
                        onChange={(v) => setOverview(p => ({ ...p, volumeStepRatio: v }))}
                      />
                      <div className="space-y-1.5 rounded-lg border border-dashed p-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <Label className="text-xs">Live Symbol Cap</Label>
                            <div className="text-[10px] text-muted-foreground">Maximum exchange symbols this connection can run after save.</div>
                          </div>
                          <span className="text-xs font-mono tabular-nums">{symbolsCfg.symbolCount}</span>
                        </div>
                        <Slider
                          min={1} max={32} step={1}
                          value={[symbolsCfg.symbolCount]}
                          onValueChange={([v]) => setSymbolsCfg(p => ({ ...p, symbolCount: v }))}
                          className="py-1"
                        />
                        <div className="flex justify-between text-[10px] text-muted-foreground"><span>1</span><span>32 max</span></div>
                      </div>
                    </div>

                    <div className="rounded-xl border bg-card p-4 space-y-4">
                      <SectionHeading icon={ListFilter} title="Exchange Mode" subtitle="Venue mode applied to live orders without restarting the engine." />
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs">Margin Mode</Label>
                          <Select value={overview.marginMode} onValueChange={(v) => setOverview(p => ({ ...p, marginMode: v as "cross" | "isolated" }))}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="cross">Cross Margin</SelectItem>
                              <SelectItem value="isolated">Isolated Margin</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs">Position Mode</Label>
                          <Select value={overview.positionMode} onValueChange={(v) => setOverview(p => ({ ...p, positionMode: v as "one_way" | "hedge" }))}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="one_way">One-way</SelectItem>
                              <SelectItem value="hedge">Hedge</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-1.5 col-span-2">
                          <Label className="text-xs">Volume Type</Label>
                          <Select value={overview.volumeType} onValueChange={(v) => setOverview(p => ({ ...p, volumeType: v as "usdt" | "contract" | "spot" }))}>
                            <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              <SelectItem value="usdt">USDT-M Linear</SelectItem>
                              <SelectItem value="contract">Coin-M Inverse</SelectItem>
                              <SelectItem value="spot">Spot</SelectItem>
                            </SelectContent>
                          </Select>
                        </div>
                      </div>

                      <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/5 p-3">
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <Label className="text-xs">Use Exchange Max Leverage</Label>
                            <div className="text-[10px] text-muted-foreground">When enabled, live orders use the exchange max; otherwise the percentage cap below is applied.</div>
                          </div>
                          <Switch checked={overview.useMaximalLeverage} onCheckedChange={(v) => setOverview(p => ({ ...p, useMaximalLeverage: v }))} />
                        </div>
                        <div className={`space-y-1 ${overview.useMaximalLeverage ? "opacity-50" : ""}`}>
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Leverage Cap</Label>
                            <span className="text-xs font-mono">{overview.useMaximalLeverage ? "MAX" : `${overview.leveragePercentage}%`}</span>
                          </div>
                          <Slider
                            min={1} max={100} step={1}
                            value={[overview.leveragePercentage]}
                            onValueChange={([v]) => setOverview(p => ({ ...p, leveragePercentage: v }))}
                            disabled={overview.useMaximalLeverage}
                            className="py-1"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="rounded-xl border bg-card p-4 space-y-4">
                      <SectionHeading icon={Zap} title="Protection & Close Logic" subtitle="Choose exchange control orders or engine-side system close." />
                      <div className={`rounded-lg border p-3 transition-colors ${overview.useSystemCloseOnly ? "border-amber-500/40 bg-amber-500/10" : "border-emerald-500/30 bg-emerald-500/10"}`}>
                        <div className="flex items-start justify-between gap-4">
                          <div className="space-y-1">
                            <Label className="text-xs font-semibold">System Close Only</Label>
                            <div className="text-[11px] leading-relaxed text-muted-foreground">
                              {overview.useSystemCloseOnly
                                ? "Exchange SL/TP control orders are not placed; reconcile/sync ticks close by market reduce-only when the band is crossed."
                                : "Reduce-only SL/TP control orders are placed on the venue and verified by reconcile/sync ticks."}
                            </div>
                          </div>
                          <Switch checked={overview.useSystemCloseOnly} onCheckedChange={(checked) => setOverview(p => ({ ...p, useSystemCloseOnly: checked }))} />
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[11px]">
                        <div className="rounded-md border bg-muted/30 p-2"><div className="text-muted-foreground">Control orders</div><div className="font-semibold">{overview.useSystemCloseOnly ? "Disabled" : "Enabled"}</div></div>
                        <div className="rounded-md border bg-muted/30 p-2"><div className="text-muted-foreground">Close verification</div><div className="font-semibold">Every sync tick</div></div>
                      </div>
                    </div>

                    <div className="rounded-xl border bg-card p-4 space-y-4">
                      <SectionHeading icon={TrendingUp} title="Real → Live Limits" subtitle="Exchange promotion gates used by the live pipeline." />
                      <div className="space-y-3">
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Live Min Profit Factor</Label>
                            <span className="text-xs font-mono">{stratMain.real.min_profit_factor.toFixed(1)}</span>
                          </div>
                          <Slider
                            min={0.1} max={3} step={0.1}
                            value={[stratMain.real.min_profit_factor]}
                            onValueChange={([v]) => setStratMain(p => ({ ...p, real: { ...p.real, min_profit_factor: Number(v.toFixed(1)) } }))}
                            className="py-1"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Max Drawdown Time</Label>
                            <span className="text-xs font-mono">{stratMain.real.max_drawdown_time}m</span>
                          </div>
                          <Slider
                            min={20} max={1440} step={20}
                            value={[stratMain.real.max_drawdown_time]}
                            onValueChange={([v]) => setStratMain(p => ({ ...p, real: { ...p.real, max_drawdown_time: v } }))}
                            className="py-1"
                          />
                        </div>
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between">
                            <Label className="text-xs">Live Position Cap</Label>
                            <span className="text-xs font-mono">{stratMain.real.max_positions}</span>
                          </div>
                          <Slider
                            min={1} max={10000} step={100}
                            value={[stratMain.real.max_positions]}
                            onValueChange={([v]) => setStratMain(p => ({ ...p, real: { ...p.real, max_positions: v } }))}
                            className="py-1"
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 text-[11px] leading-relaxed text-muted-foreground">
                    <span className="font-medium text-foreground">Stable save behavior:</span> Live settings are written to the connection hash, mirrored into connection settings, then delivered as hot-reload events. Running live positions keep their engine process while sizing, symbols, leverage and protection options refresh for the next cycle.
                  </div>
                </TabsContent>

                {/* SYMBOLS ──────────────────────────────────────── */}
                <TabsContent value="symbols" className="mt-0 space-y-5">
                  <SectionHeading icon={Database} title="Symbol Selection" subtitle="Choose how the engine ranks and picks symbols from the exchange." />

                  {/* ── 1h Volatility Auto-Select ─────────────────── */}
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2.5">
                    <div className="flex items-center gap-2">
                      <Flame className="h-4 w-4 text-amber-500 shrink-0" />
                      <div className="flex-1 min-w-0">
                        <div className="text-xs font-semibold">Auto-select by 1h Volatility</div>
                <div className="text-[11px] text-muted-foreground">
                  Fetches the last 1h kline for each candidate and ranks by{" "}
                  <span className="font-mono">(high−low)/open×100</span>. Pool is pre-filtered to{" "}
                  <span className="font-mono">&gt;$5M</span> 24h volume to exclude micro-caps. Fills
                  the symbol list with the top-N most volatile and sets order to{" "}
                  <span className="font-mono">volatility_1h</span>.
                </div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs gap-1.5 bg-amber-500 hover:bg-amber-600 text-white border-0"
                        onClick={autoSelectByVolatility1h}
                        disabled={loadingVolatility1h || loadingSymbols}
                      >
                        {loadingVolatility1h
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Flame className="h-3.5 w-3.5" />
                        }
                        {loadingVolatility1h ? "Fetching 1h klines…" : `Top ${symbolsCfg.symbolCount} by 1h ATR`}
                      </Button>
                      <span className="text-[10px] text-muted-foreground">
                        {loadingVolatility1h
                          ? "Querying BingX klines in parallel…"
                          : "Runs live against the exchange API — takes ~2s for 20 symbols."}
                      </span>
                    </div>
                  </div>

                  {/* Ranked ticker table — shown after a 1h ATR fetch */}
                  {exchangeTickers.length > 0 && exchangeTickers.some((t) => t.atr1h !== undefined) && (
                    <div className="rounded-lg border border-border overflow-hidden">
                      <div className="px-3 py-1.5 bg-muted/40 border-b border-border flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide font-medium text-muted-foreground">
                          1h ATR Ranking
                        </span>
                        <span className="text-[10px] text-muted-foreground">Click to toggle</span>
                      </div>
                      <div className="divide-y divide-border max-h-48 overflow-y-auto">
                        {exchangeTickers
                          .filter((t) => t.atr1h !== undefined)
                          .sort((a, b) => (b.atr1h ?? 0) - (a.atr1h ?? 0))
                          .slice(0, 25)
                          .map((t, i) => {
                            const isSelected = symbolsCfg.symbols.includes(t.symbol)
                            return (
                              <button
                                key={t.symbol}
                                type="button"
                                onClick={() => isSelected ? removeSymbol(t.symbol) : addSymbol(t.symbol)}
                                className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-accent transition-colors ${isSelected ? "bg-primary/5" : ""}`}
                              >
                                <span className="w-5 text-[10px] text-muted-foreground tabular-nums">
                                  {i + 1}
                                </span>
                                {isSelected
                                  ? <CheckSquare className="h-3.5 w-3.5 text-primary shrink-0" />
                                  : <Square className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
                                }
                                <span className="font-mono font-medium flex-1">{t.symbol}</span>
                                <span className={`text-[10px] tabular-nums font-mono ${(t.atr1h ?? 0) >= 1.5 ? "text-amber-500" : (t.atr1h ?? 0) >= 0.8 ? "text-yellow-500" : "text-muted-foreground"}`}>
                                  {(t.atr1h ?? 0).toFixed(2)}% ATR
                                </span>
                              </button>
                            )
                          })}
                      </div>
                    </div>
                  )}

                  {/* Currently-active symbols — read-only status banner */}
                  {activeSymbols.length > 0 && (
                    <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1">
                      <div className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium">
                        Currently active on engine
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {activeSymbols.map((s) => (
                          <Badge key={s} variant="outline" className="text-[10px] font-mono">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label className="text-xs">Order from Exchange</Label>
                      <Select
                        value={symbolsCfg.symbolOrder}
                        onValueChange={(v) => setSymbolsCfg(p => ({ ...p, symbolOrder: v as SymbolOrder }))}
                      >
                        <SelectTrigger className="h-9 text-xs"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {(Object.keys(orderLabel) as SymbolOrder[]).map((k) => (
                            <SelectItem key={k} value={k}>{orderLabel[k]}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">Symbol Count</Label>
                        <span className="text-xs font-mono tabular-nums">{symbolsCfg.symbolCount}</span>
                      </div>
                      <Slider
                        min={1} max={32} step={1}
                        value={[symbolsCfg.symbolCount]}
                        onValueChange={([v]) => setSymbolsCfg(p => ({ ...p, symbolCount: v }))}
                        className="py-2"
                      />
                      <div className="flex justify-between text-[10px] text-muted-foreground">
                        <span>1</span><span>default 15</span><span>32</span>
                      </div>
                    </div>
                  </div>

                  {/* Resolution notice — explicit curated list wins over auto-rank.
                      When the operator has hand-picked symbols (manual entry or
                      toggled from the 1h ATR table) that exact list is saved and
                      applied verbatim, regardless of the ranking order. Only when
                      the list is empty does the engine auto-fetch the top-N. */}
                  {symbolsCfg.symbols.length > 0 ? (
                    <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">Explicit selection:</span>{" "}
                      On save, your curated list of <span className="font-mono font-medium">{symbolsCfg.symbols.length}</span>{" "}
                      symbol{symbolsCfg.symbols.length === 1 ? "" : "s"} is applied exactly as selected.
                      {symbolsCfg.symbolOrder !== "manual" && (
                        <span className="ml-1">
                          The <span className="font-medium">{orderLabel[symbolsCfg.symbolOrder]}</span> order only seeded the ranking —
                          it will not re-fetch and overwrite your picks.
                        </span>
                      )}
                    </div>
                  ) : symbolsCfg.symbolOrder !== "manual" ? (
                    <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-muted-foreground">
                      <span className="font-medium text-foreground">Auto-assign:</span>{" "}
                      No manual override — on save the engine will fetch the top <span className="font-mono font-medium">{symbolsCfg.symbolCount}</span> symbols
                      by <span className="font-medium">{orderLabel[symbolsCfg.symbolOrder]}</span> from the exchange and apply them.
                      {availableSymbols.length > 0 && (
                        <span className="ml-1">
                          Likely: <span className="font-mono">{availableSymbols.slice(0, symbolsCfg.symbolCount).join(", ")}</span>
                        </span>
                      )}
                    </div>
                  ) : null}

                  <Separator />

                  {/* Symbol chips — manual override list */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label className="text-xs">
                        {symbolsCfg.symbolOrder === "manual" ? "Symbols" : "Manual Override"}{" "}
                        ({symbolsCfg.symbols.length})
                      </Label>
                      <Button
                        type="button"
                        size="sm" variant="outline"
                        className="h-7 text-xs gap-1"
                        onClick={fetchExchangeSymbols}
                        disabled={loadingSymbols}
                      >
                        {loadingSymbols ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                        Refresh listings
                      </Button>
                    </div>

                    <div className="flex flex-wrap gap-1.5 min-h-[2.5rem] rounded-md border border-dashed p-2">
                      {symbolsCfg.symbols.length === 0 && (
                        <span className="text-[11px] text-muted-foreground italic">
                          {symbolsCfg.symbolOrder === "manual"
                            ? "No symbols — add at least one below or switch to auto-assign."
                            : `No manual override — engine will auto-assign top-${symbolsCfg.symbolCount} on save.`}
                        </span>
                      )}
                      {symbolsCfg.symbols.map((s) => (
                        <Badge key={s} variant="secondary" className="gap-1 pr-1 text-[10px]">
                          {s}
                          <button
                            type="button"
                            className="rounded-sm p-0.5 hover:bg-destructive/20"
                            onClick={() => removeSymbol(s)}
                            aria-label={`Remove ${s}`}
                          >
                            <X className="h-2.5 w-2.5" />
                          </button>
                        </Badge>
                      ))}
                    </div>

                    <div className="flex gap-2">
                      <Input
                        placeholder="Add symbol e.g. BTCUSDT"
                        value={symbolInput}
                        onChange={(e) => setSymbolInput(e.target.value.toUpperCase())}
                        onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), addSymbol(symbolInput))}
                        className="h-8 text-xs"
                      />
                      <Button
                        type="button"
                        size="sm"
                        className="h-8 text-xs gap-1"
                        onClick={() => addSymbol(symbolInput)}
                      >
                        <Plus className="h-3 w-3" /> Add
                      </Button>
                    </div>

                    {availableSymbols.length > 0 && (
                      <div className="rounded-md border bg-muted/30 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">
                          Suggested ({orderLabel[symbolsCfg.symbolOrder]})
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {availableSymbols.map((s) => (
                            <button
                              key={s}
                              type="button"
                              className="rounded-md border bg-background px-2 py-0.5 text-[10px] hover:bg-accent"
                              onClick={() => addSymbol(s)}
                            >
                              + {s}
                            </button>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                </TabsContent>

                {/* INDICATIONS ─────────────────────────────────── */}
                <TabsContent value="indications" className="mt-0">
                  <Tabs defaultValue="main" className="w-full">
                    <TabsList className="grid grid-cols-2 h-8 mb-4 w-fit">
                      <TabsTrigger value="main"   className="text-xs px-4">Main</TabsTrigger>
                      <TabsTrigger value="preset" className="text-xs px-4">Preset</TabsTrigger>
                    </TabsList>
                    <TabsContent value="main">
                      <IndicationProfileEditor profile={indMain} onChange={setIndMain} />
                    </TabsContent>
                    <TabsContent value="preset">
                      <IndicationProfileEditor profile={indPreset} onChange={setIndPreset} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>

                {/* STRATEGIES ──────────��──────────────────────── */}
                <TabsContent value="strategies" className="mt-0">
                  <Tabs defaultValue="main" className="w-full">
                    <TabsList className="grid grid-cols-3 h-8 mb-4 w-fit">
                      <TabsTrigger value="main" className="text-xs px-4">Main</TabsTrigger>
                      <TabsTrigger value="preset" className="text-xs px-4">Preset</TabsTrigger>
                      <TabsTrigger value="coordination" className="text-xs px-4">Coordination</TabsTrigger>
                    </TabsList>
                    <TabsContent value="main" className="space-y-4">
                      <StrategyProfileEditor profile={stratMain} onChange={setStratMain} />
                      <StrategyOptionsPanel
                        variants={coordination.variants}
                        onChange={(v) => setCoordination((p) => ({ ...p, variants: { ...p.variants, ...v } }))}
                      />
                    </TabsContent>
                    <TabsContent value="preset" className="space-y-4">
                      <StrategyProfileEditor profile={stratPreset} onChange={setStratPreset} />
                      <StrategyOptionsPanel
                        variants={coordination.variants}
                        onChange={(v) => setCoordination((p) => ({ ...p, variants: { ...p.variants, ...v } }))}
                      />
                    </TabsContent>
                    <TabsContent value="coordination">
                      <StrategyCoordinationSection value={coordination} onChange={setCoordination} />
                    </TabsContent>
                  </Tabs>
                </TabsContent>
              </>
            )}
          </ScrollArea>
        </Tabs>

        <DialogFooter className="px-5 py-3 border-t bg-muted/30 shrink-0">
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancel
          </Button>
          <Button size="sm" onClick={saveAll} disabled={saving || loading} className="gap-1.5">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
            {saving ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ────────────────────────────────────���────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────���───────────

function SectionHeading({
  icon: Icon, title, subtitle,
}: { icon: React.ComponentType<{ className?: string }>; title: string; subtitle?: string }) {
  return (
    <div className="flex items-start gap-2">
      <div className="mt-0.5 flex h-6 w-6 items-center justify-center rounded-md bg-primary/10">
        <Icon className="h-3.5 w-3.5 text-primary" />
      </div>
      <div className="flex-1">
        <div className="text-sm font-medium">{title}</div>
        {subtitle && <div className="text-[11px] text-muted-foreground">{subtitle}</div>}
      </div>
    </div>
  )
}

function VolumeSlider({
  label, description, value, onChange,
}: {
  label: string; description: string; value: number; onChange: (v: number) => void
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">{label}</Label>
          <div className="text-[10px] text-muted-foreground">{description}</div>
        </div>
        <span className="text-xs font-mono tabular-nums w-12 text-right">{value.toFixed(2)}×</span>
      </div>
      <Slider
        min={0.1} max={5} step={0.05}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className="py-1"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>0.1×</span><span>1.0×</span><span>5.0×</span>
      </div>
    </div>
  )
}

function VolumeStepSlider({
  value, onChange,
}: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <Label className="text-xs">Volume Step Ratio</Label>
          <div className="text-[10px] text-muted-foreground">Recalculate volume after balance crosses the next profit step; drawdowns reset immediately.</div>
        </div>
        <span className="text-xs font-mono tabular-nums w-16 text-right">{value.toFixed(1)}×</span>
      </div>
      <Slider
        min={MIN_VOLUME_STEP_RATIO} max={MAX_VOLUME_STEP_RATIO} step={0.2}
        value={[value]}
        onValueChange={([v]) => onChange(v)}
        className="py-1"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>0.2</span><span>0.6 default</span><span>1.8</span>
      </div>
    </div>
  )
}

function IndicationProfileEditor({
  profile, onChange,
}: { profile: ChannelProfile; onChange: (p: ChannelProfile) => void }) {
  const update = (type: IndicationType, patch: Partial<IndicationParams>) => {
    onChange({ ...profile, [type]: { ...profile[type], ...patch } })
  }
  return (
    <div className="space-y-3">
      {INDICATION_TYPES.map((type) => {
        const p = profile[type]
        return (
          <div key={type} className={`rounded-md border p-3 transition-opacity ${p.enabled ? "" : "opacity-60"}`}>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => update(type, { enabled: v })}
                />
                <Label className="text-sm font-medium capitalize">{type}</Label>
              </div>
              <Badge variant={p.enabled ? "default" : "outline"} className="text-[9px]">
                {p.enabled ? "Enabled" : "Disabled"}
              </Badge>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <NumberField
                label="Range" suffix="" min={1} max={100} step={1}
                value={p.range} onChange={(v) => update(type, { range: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Timeout" suffix="s" min={5} max={600} step={5}
                value={p.timeout} onChange={(v) => update(type, { timeout: v })} disabled={!p.enabled}
              />
              <NumberField
                label="Interval" suffix="m" min={1} max={120} step={1}
                value={p.interval} onChange={(v) => update(type, { interval: v })} disabled={!p.enabled}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Stage accent colours ─���─────────────────────���─────────────────────
const STAGE_ACCENT: Record<StrategyType, { border: string; bg: string; dot: string; label: string }> = {
  base: {
    border: "border-orange-300/40",
    bg:     "bg-orange-50/30 dark:bg-orange-950/10",
    dot:    "bg-orange-400",
    label:  "Base",
  },
  main: {
    border: "border-yellow-300/40",
    bg:     "bg-yellow-50/30 dark:bg-yellow-950/10",
    dot:    "bg-yellow-400",
    label:  "Main",
  },
  real: {
    border: "border-emerald-300/40",
    bg:     "bg-emerald-50/30 dark:bg-emerald-950/10",
    dot:    "bg-emerald-400",
    label:  "Real",
  },
}

function StrategyProfileEditor({
  profile, onChange,
}: { profile: StrategyChannel; onChange: (p: StrategyChannel) => void }) {
  const update = (type: StrategyType, patch: Partial<StrategyParams>) => {
    onChange({ ...profile, [type]: { ...profile[type], ...patch } })
  }
  return (
    <div className="space-y-2.5">
      {STRATEGY_TYPES.map((type) => {
        const p = profile[type]
        const ac = STAGE_ACCENT[type]
        return (
          <div
            key={type}
            className={`rounded-lg border ${ac.border} ${ac.bg} p-3.5 transition-opacity ${p.enabled ? "" : "opacity-50"}`}
          >
            {/* Header row */}
            <div className="flex items-center justify-between mb-3.5">
              <div className="flex items-center gap-2.5">
                <span className={`h-2 w-2 rounded-full ${ac.dot} shrink-0`} />
                <span className="text-sm font-semibold tracking-tight">{ac.label} Stage</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={`text-[10px] font-medium ${p.enabled ? "text-foreground" : "text-muted-foreground"}`}>
                  {p.enabled ? "Active" : "Disabled"}
                </span>
                <Switch
                  checked={p.enabled}
                  onCheckedChange={(v) => update(type, { enabled: v })}
                />
              </div>
            </div>

            {/* Min PF slider */}
            <div className="space-y-2 mb-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs font-medium">Min Profit Factor</Label>
                  <div className="text-[10px] text-muted-foreground">Minimum PF required to pass this stage</div>
                </div>
                <span className="font-mono text-sm tabular-nums font-semibold min-w-[3rem] text-right">
                  {p.min_profit_factor.toFixed(1)}
                </span>
              </div>
              <Slider
                min={0.1} max={3} step={0.1}
                value={[p.min_profit_factor]}
                onValueChange={([v]) => update(type, { min_profit_factor: Number(v.toFixed(1)) })}
                disabled={!p.enabled}
                className="py-1"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>0.1</span>
                <span className="text-muted-foreground/60">
                  {type === "base" ? "default 1.0" : "default 1.2"}
                </span>
                <span>3.0</span>
              </div>
            </div>

            {/* Max DDT slider */}
            <div className="space-y-2 mb-3">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs font-medium">Max Drawdown Time</Label>
                  <div className="text-[10px] text-muted-foreground">Maximum allowed drawdown duration</div>
                </div>
                <span className="font-mono text-sm tabular-nums font-semibold min-w-[4rem] text-right">
                  {p.max_drawdown_time} min
                </span>
              </div>
              <Slider
                min={20} max={800} step={2}
                value={[p.max_drawdown_time]}
                onValueChange={([v]) => update(type, { max_drawdown_time: v })}
                disabled={!p.enabled}
                className="py-1"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>20 min</span>
                <span className="text-muted-foreground/60">default 160</span>
                <span>800 min</span>
              </div>
            </div>

            {/* Max Positions slider — raised ceiling for high-throughput pipelines */}
            <div className="space-y-2 pt-1 border-t border-border/40">
              <div className="flex items-center justify-between">
                <div>
                  <Label className="text-xs font-medium">Max Positions</Label>
                  <div className="text-[10px] text-muted-foreground">Maximum concurrent pseudo-positions for this stage</div>
                </div>
                <span className="font-mono text-sm tabular-nums font-semibold min-w-[4rem] text-right">
                  {p.max_positions.toLocaleString()}
                </span>
              </div>
              <Slider
                min={100} max={50000} step={100}
                value={[p.max_positions]}
                onValueChange={([v]) => update(type, { max_positions: v })}
                disabled={!p.enabled}
                className="py-1"
              />
              <div className="flex justify-between text-[10px] text-muted-foreground">
                <span>100</span>
                <span className="text-muted-foreground/60">{type === "real" ? "default 5,000" : "default 10,000"}</span>
                <span>50,000</span>
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ── Strategy Options Panel ────────────────────────────────────────────
// Surfaces the Trailing / Block / DCA variant toggles directly in the
// Strategies tab so operators can enable / disable them without opening
// the deeper Coordination sub-tab.
const VARIANT_META: {
  key:   keyof CoordinationSettings["variants"]
  label: string
  desc:  string
  defaultOn: boolean
}[] = [
  {
    key: "trailing",
    label: "Trailing",
    desc:  "Fires when last-N results show consecutive wins. Aggressively follows momentum.",
    defaultOn: true,
  },
  {
    key: "block",
    label: "Block",
    desc:  "Add-on entries when continuousCount is in the 1–2 range. Independent of axes.",
    defaultOn: true,
  },
  {
    key: "dca",
    label: "DCA",
    desc:  "Dollar-cost averaging on prior losses. Gate: prevLosses ≥ 1. Off by default.",
    defaultOn: false,
  },
]

function StrategyOptionsPanel({
  variants,
  onChange,
}: {
  variants: CoordinationSettings["variants"]
  onChange: (patch: Partial<CoordinationSettings["variants"]>) => void
}) {
  return (
    <div className="rounded-lg border border-border bg-card/60 p-3.5 space-y-3">
      <div className="flex items-center gap-2">
        <div className="flex h-5 w-5 items-center justify-center rounded bg-primary/10">
          <Zap className="h-3 w-3 text-primary" />
        </div>
        <span className="text-sm font-semibold">Strategy Options</span>
        <span className="text-[10px] text-muted-foreground ml-1">Categorical variants applied on top of axis sets</span>
      </div>

      <div className="grid gap-2">
        {VARIANT_META.map(({ key, label, desc, defaultOn }) => {
          // `variants[key]` may be undefined if loaded from older persisted data
          // that predates the field — fall back to the spec default.
          const enabled = typeof variants[key] === "boolean" ? variants[key] : defaultOn
          return (
            <div
              key={key}
              className={`flex items-start justify-between gap-3 rounded-md border px-3 py-2.5 transition-colors ${
                enabled
                  ? "border-primary/30 bg-primary/5"
                  : "border-border bg-muted/20"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{label}</span>
                  {!defaultOn && (
                    <span className="text-[9px] uppercase tracking-wide rounded-sm px-1 py-0.5 bg-muted text-muted-foreground font-medium">
                      off by default
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-muted-foreground leading-relaxed mt-0.5">{desc}</div>
              </div>
              <Switch
                checked={enabled}
                onCheckedChange={(v) => onChange({ [key]: v })}
                className="mt-0.5 shrink-0"
              />
            </div>
          )
        })}
      </div>
    </div>
  )
}

function NumberField({
  label, value, onChange, suffix, min, max, step, disabled,
}: {
  label: string
  value: number
  onChange: (v: number) => void
  suffix: string
  min: number
  max: number
  step: number
  disabled?: boolean
}) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground uppercase tracking-wide">{label}</Label>
      <div className="relative">
        <Input
          type="number"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (!Number.isFinite(v)) return
            onChange(Math.max(min, Math.min(max, v)))
          }}
          className="h-8 text-xs pr-7 tabular-nums"
        />
        {suffix && (
          <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground pointer-events-none">
            {suffix}
          </span>
        )}
      </div>
    </div>
  )
}
