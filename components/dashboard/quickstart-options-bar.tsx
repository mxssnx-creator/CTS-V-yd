"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
/**
 * QuickStart Options Bar — compact, collapsible strip mounted at the very
 * top of the QuickStart card (directly under `QuickstartConnectionControls`).
 *
 * Surfaces the most-used per-connection knobs so the operator doesn't have
 * to open the full Connection Settings dialog mid-run:
 *
 *   • Control Orders         — on/off → POST /live-trade
 *                              (toggles `is_live_trade` on the active
 *                              connection; gates whether real exchange
 *                              orders are emitted from the Live stage)
 *
 *   • Profit-Factor Mins     — 4 sliders (Base / Main / Real / Live)
 *                              0.5 – 1.5 step 0.1 default 0.9
 *                              persists into
 *                              `connection_settings.profitFactorMin.{stage}`
 *                              via PATCH /settings (merged, not replaced)
 *
 *   • Volume Factor          — single slider 0.1 – 10 step 0.1 default 1.0
 *                              persists into the canonical Redis fields
 *                              `live_volume_factor` via POST /volume
 *                              (same endpoint the dashboard volume panel
 *                              uses, so the two stay in sync)
 *
 *   • Strategies Pos. Counts — Block + DCA on/off switches
 *                              persists into
 *                              `connection_settings.coordination_settings`
 *                              `.variants.{block,dca}` via PATCH /settings
 *                              (matches the existing coordination section
 *                              UI in the Connection Settings dialog so
 *                              changes here flip the same engine toggles)
 *
 * Save model
 * ─────────
 * Every knob saves on commit (slider release / switch toggle) with a
 * 350 ms trailing debounce per-field so dragging a slider doesn't fire
 * one PATCH per pixel. Concurrent saves are coalesced — the latest
 * value always wins. A subtle inline status chip ("Saving…" → "Saved")
 * confirms the round-trip without stealing focus.
 *
 * No selection → the bar renders disabled inputs with a tooltip
 * explaining that the operator must pick a connection first
 * (`QuickstartConnectionControls` is right above and points the way).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  CheckCircle2,
  AlertCircle,
  Sliders,
  Zap,
  Boxes,
  Layers,
  TrendingUp,
} from "lucide-react"
import { useExchange } from "@/lib/exchange-context"

// ── stage labels ────────────────────────────────────────────────────────
//
// Centralised so the slider grid below stays declarative. The order is
// pipeline order (Base → Main → Real → Live) which matches the engine
// stage progression and how operators reason about thresholds.
type Stage = "base" | "main" | "real" | "live"
const STAGES: Array<{ key: Stage; label: string }> = [
  { key: "base", label: "Base" },
  { key: "main", label: "Main" },
  { key: "real", label: "Real" },
  { key: "live", label: "Live" },
]

// ── persistence shape ──────────────────────────────────────────────────
//
// Mirrors the slice of `connection_settings` we own. PATCH merges into
// the existing object, so unrelated keys (coordination axes, strategies,
// indications, …) are preserved untouched.
interface ProfitFactorMin {
  base: number
  main: number
  real: number
  live: number
}
const toBooleanFlag = (value: unknown): boolean =>
  value === true || value === 1 || value === "1" || value === "true" || value === "yes" || value === "on"
const DEFAULT_PF_MIN: ProfitFactorMin = {
  base: 0.9,
  main: 0.9,
  real: 0.9,
  live: 0.9,
}

// Slider configuration — kept here so the UI and the engine-side clamp
// can drift independently if the spec ever widens the band. The clamp
// inside `clampPfMin` re-applies the same band defensively in case a
// future code path bypasses the slider step.
const PF_MIN = 0.5
const PF_MAX = 1.5
const PF_STEP = 0.1

function clampPfMin(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 0.9
  return Math.max(PF_MIN, Math.min(PF_MAX, Math.round(n * 10) / 10))
}

// Volume factor — uses the same band as the volume route (0.1–10).
const VF_MIN = 0.1
const VF_MAX = 10
const VF_STEP = 0.1
function clampVf(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 1
  return Math.max(VF_MIN, Math.min(VF_MAX, Math.round(n * 10) / 10))
}

// Minimal step count — minimum consecutive steps before placing pseudo position
const MSC_MIN = 0
const MSC_MAX = 20
const MSC_STEP = 1
function clampMsc(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 3
  return Math.max(MSC_MIN, Math.min(MSC_MAX, Math.round(n)))
}

// Max concurrent trades — maximum number of concurrent open positions
const MCT_MIN = 1
const MCT_MAX = 32
const MCT_STEP = 1
function clampMct(raw: unknown): number {
  const n = Number(raw)
  if (!Number.isFinite(n)) return 10
  return Math.max(MCT_MIN, Math.min(MCT_MAX, Math.round(n)))
}

// ── debounce helper ────────────────────────────────────────────────────
//
// Returns a stable function that defers the supplied callback by `ms`
// and resets the timer on every call. Each saver gets its OWN debounce
// timer so dragging one slider doesn't reset a save in flight for another.
function useDebouncedSaver<T extends (...args: any[]) => void | Promise<void>>(
  fn: T,
  ms: number,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const fnRef = useRef(fn)
  fnRef.current = fn
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
    }
  }, [])
  return useCallback(
    (...args: Parameters<T>) => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current)
      timeoutRef.current = setTimeout(() => {
        void fnRef.current(...args)
      }, ms)
    },
    [ms],
  )
}

// ── component ──────────────────────────────────────────────────────────
export function QuickstartOptionsBar() {
  const { selectedConnectionId } = useExchange()
  const cid = selectedConnectionId

  // Collapsed by default — the strip is informational once configured.
  // Persist the open/closed flag in localStorage so the operator's
  // preference survives navigation; defaults to OFF so first-time users
  // see the bar in its quietest form.
  const [open, setOpen] = useState<boolean>(false)
  useEffect(() => {
    try {
      const v = localStorage.getItem("qs:options:open")
      if (v === "1") setOpen(true)
    } catch { /* localStorage unavailable */ }
  }, [])
  const toggleOpen = useCallback(() => {
    setOpen((prev) => {
      const next = !prev
      try { localStorage.setItem("qs:options:open", next ? "1" : "0") } catch { /* noop */ }
      return next
    })
  }, [])

  // Hydration state — `null` until the first fetch resolves so the
  // sliders don't flash defaults over saved values.
  const [hydrated, setHydrated] = useState(false)
  const [loading, setLoading] = useState(false)
  // Default false — hydrate() will set the correct value once the
  // settings fetch returns. Defaulting to true caused a false "Orders ON"
  // flash before the first fetch resolved.
  const [controlOrders, setControlOrders] = useState(false)
  const [pfMin, setPfMin] = useState<ProfitFactorMin>(DEFAULT_PF_MIN)
  const [volumeFactor, setVolumeFactor] = useState<number>(0.1)
  const [minimalStepCount, setMinimalStepCount] = useState<number>(3)
  const [maxConcurrentTrades, setMaxConcurrentTrades] = useState<number>(10)
  const [blockEnabled, setBlockEnabled] = useState(true)
  const [dcaEnabled, setDcaEnabled] = useState(false)
  // Trailing-stop master variant gate. Engine-side default is also true
  // (`coord.variants.trailing !== false` in strategy-coordinator), so an
  // operator who never touches this control still gets trailing.
  const [trailingEnabled, setTrailingEnabled] = useState(true)

  // Per-field save status — drives the inline chip. We track a single
  // shared status because the operator typically only mutates one knob
  // at a time, and a shared chip stays out of the way.
  const [saveStatus, setSaveStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle")
  const saveStatusTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const showSaved = useCallback(() => {
    setSaveStatus("saved")
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
    saveStatusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 1500)
  }, [])
  const showError = useCallback(() => {
    setSaveStatus("error")
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
    saveStatusTimerRef.current = setTimeout(() => setSaveStatus("idle"), 3000)
  }, [])
  useEffect(() => () => {
    if (saveStatusTimerRef.current) clearTimeout(saveStatusTimerRef.current)
  }, [])

  // ── hydrate when selection changes ───────────────────────────────────
  //
  // Fetch the canonical state from three endpoints in parallel:
  //   • /settings   — full connection_settings (pfMin, coordination.variants)
  //   • /volume     — live_volume_factor
  //   • /live-trade — current is_live_trade flag (we read it off /settings
  //                   list to avoid a fourth fetch — the GET /settings
  //                   response above embeds the whole connection record)
  const hydrate = useCallback(async () => {
    if (!cid) {
      setHydrated(true)
      return
    }
    setLoading(true)
    try {
      const [settingsRes, volumeRes] = await Promise.all([
        fetch(`/api/settings/connections/${cid}/settings?t=${Date.now()}`, {
          cache: "no-store",
        }),
        fetch(`/api/settings/connections/${cid}/volume?t=${Date.now()}`, {
          cache: "no-store",
        }),
      ])

      if (settingsRes.ok) {
        const data = await settingsRes.json()
        const conn = data?.connection || {}
        const settings = (data?.settings && typeof data.settings === "object")
          ? data.settings
          : {}

        // Prefer `live_trade_requested` — set by the server to the operator's
        // intended state even when the actual `is_live_trade` flag stays false
        // (e.g. because API credentials aren't configured yet).  This way the
        // switch correctly shows "ON" after a page reload when the user had
        // previously enabled Control Orders.
        const liveRequested = toBooleanFlag(conn.live_trade_requested)
        const liveEffective = toBooleanFlag(conn.is_live_trade)
        setControlOrders(liveRequested || liveEffective)

        // Profit-factor min — fall through both the new namespaced
        // location and a legacy flat one in case older settings drafts
        // wrote at the top level. Always clamp on read so a stale value
        // outside the band can't render an out-of-range slider thumb.
        const raw =
          settings.profitFactorMin ||
          settings.profit_factor_min ||
          {}
        setPfMin({
          base: clampPfMin(raw.base ?? settings.profitFactorMinBase ?? DEFAULT_PF_MIN.base),
          main: clampPfMin(raw.main ?? settings.profitFactorMinMain ?? DEFAULT_PF_MIN.main),
          real: clampPfMin(raw.real ?? settings.profitFactorMinReal ?? DEFAULT_PF_MIN.real),
          live: clampPfMin(raw.live ?? settings.profitFactorMinLive ?? DEFAULT_PF_MIN.live),
        })

        // Minimal step count — for pseudo position placement
        setMinimalStepCount(clampMsc(settings.minimal_step_count ?? settings.minimalStepCount ?? 3))

        // Max concurrent trades — limit concurrent open positions
        setMaxConcurrentTrades(clampMct(settings.max_concurrent_trades ?? settings.maxConcurrentTrades ?? 10))

        // Block / DCA toggles live inside the existing coordination
        // settings block — same source the Connection Settings dialog
        // edits, so changes here are reflected there and vice-versa.
        const coord =
          settings.coordination_settings ||
          settings.coordinationSettings ||
          {}
        const variants = coord.variants || {}
        // Defaults: trailing ON, block ON, dca OFF — matches the engine-side
        // defaults in `lib/strategy-coordinator.ts`. Use `!== false` so absent
        // keys default to true (don't surprise operators who never touched
        // coordination — the previous run was already trailing).
        setTrailingEnabled(variants.trailing !== false)
        setBlockEnabled(variants.block !== false)
        setDcaEnabled(variants.dca === true)
      }

      if (volumeRes.ok) {
        const data = await volumeRes.json()
        setVolumeFactor(clampVf(data?.live_volume_factor ?? 1))
      }
    } catch (err) {
      console.error("[v0] [QSOptions] hydrate failed:", err)
    } finally {
      setLoading(false)
      setHydrated(true)
    }
  }, [cid])

  useEffect(() => {
    setHydrated(false)
    void hydrate()
  }, [hydrate])

  // ── persistence primitives ───────────────────────────────────────────
  //
  // Each saver is its own function so the debounced wrapper can compose
  // independent timers. All savers funnel through the shared status
  // setter so the operator gets one consistent chip.
  const patchSettings = useCallback(
    async (patch: Record<string, unknown>) => {
      if (!cid) return
      setSaveStatus("saving")
      try {
        const res = await fetch(
          `/api/settings/connections/${cid}/settings`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(patch),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        showSaved()
        // Notify ExchangeContext and ActiveConnectionCard that settings changed
        // so they reload without waiting for their natural poll cadence.
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("connection-settings-updated", {
              detail: { connectionId: cid, settings: patch },
            }),
          )
        }
      } catch (err) {
        console.error("[v0] [QSOptions] PATCH settings failed:", err)
        showError()
      }
    },
    [cid, showSaved, showError],
  )

  const saveVolume = useCallback(
    async (next: number) => {
      if (!cid) return
      setSaveStatus("saving")
      try {
        const res = await fetch(
          `/api/settings/connections/${cid}/volume`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ live_volume_factor: next }),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        showSaved()
      } catch (err) {
        console.error("[v0] [QSOptions] POST volume failed:", err)
        showError()
      }
    },
    [cid, showSaved, showError],
  )

  const saveLiveTrade = useCallback(
    async (next: boolean, previous: boolean) => {
      if (!cid) return
      setSaveStatus("saving")
      try {
        const res = await fetch(
          `/api/settings/connections/${cid}/live-trade`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ is_live_trade: next }),
          },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)

        // Read the server's actual resulting flag (may differ from `next` when
        // credentials are missing — server sets `live_trade_requested=true` but
        // keeps `is_live_trade=false`). Apply the truth so the switch doesn't
        // stay ON when the server couldn't honour the toggle.
        let actualState = next
        let data: any = {}
        try {
          data = await res.json()
          if (typeof data?.live_trade_requested === "boolean") {
            // The server echoes back `live_trade_requested` as the intended state
            // and `is_live_trade` as the effective state (may be false if blocked).
            // For the UI switch we use `live_trade_requested` — the operator
            // intended it, and the system will honour it once creds are added.
            actualState = data.live_trade_requested
          } else if (typeof data?.is_live_trade === "boolean") {
            actualState = data.is_live_trade
          }
        } catch { /* keep optimistic value on parse failure */ }

        setControlOrders(actualState)
        showSaved()

        // Broadcast so ActiveConnectionCard's Live Trade switch syncs
        // immediately instead of waiting for its 3–8 s engine-states poll.
        dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
          connectionId: cid,
          engine: { action: actualState ? "start" : "stop", status: data?.engineStatus },
          source: "quickstart-options-bar.liveTrade",
        }))
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("live-trade-toggled", {
              detail: { connectionId: cid, newState: actualState },
            }),
          )
        }
      } catch (err) {
        // On network failure revert to the exact previous UI state. Using
        // `!next` made stale/double events look inverted when the user was
        // turning Control Orders off.
        setControlOrders(previous)
        console.error("[v0] [QSOptions] POST live-trade failed:", err)
        showError()
      }
    },
    [cid, showSaved, showError],
  )

  // Reverse sync — when ActiveConnectionCard (or any other surface) toggles
  // live-trade, update this bar's switch so both surfaces always agree.
  useEffect(() => {
    if (!cid) return
    const handler = (e: Event) => {
      const ev = e as CustomEvent
      if (ev.detail?.connectionId === cid && typeof ev.detail?.newState === "boolean") {
        setControlOrders(ev.detail.newState)
      }
    }
    window.addEventListener("live-trade-toggled", handler)
    return () => window.removeEventListener("live-trade-toggled", handler)
  }, [cid])

  // Debounced savers — one per knob group. Sliders rapid-fire on drag,
  // switches fire once on toggle (debounce is harmless for them and
  // keeps the call path uniform).
  const debouncedSavePf     = useDebouncedSaver(patchSettings, 350)
  const debouncedSaveVolume = useDebouncedSaver(saveVolume, 350)
  const debouncedSaveCoord  = useDebouncedSaver(patchSettings, 100)
  // Live switch is intentionally NOT debounced: it is a safety-critical
  // operator intent bit, so send the exact checked value immediately and avoid
  // stale queued saves inverting rapid on/off clicks.
  const debouncedSaveLive   = saveLiveTrade

  // ── handlers ─────────────────────────────────────────────────────────
  const handlePfChange = useCallback(
    (stage: Stage, raw: number) => {
      const v = clampPfMin(raw)
      // Update the staged value FIRST so the slider thumb tracks the
      // drag smoothly, then schedule the debounced save with the merged
      // PF-min object. We compute it inline rather than off `pfMin`
      // state to avoid stale-closure races between adjacent slider drags.
      setPfMin((prev) => {
        const next = { ...prev, [stage]: v }
        debouncedSavePf({ profitFactorMin: next })
        return next
      })
    },
    [debouncedSavePf],
  )

  const handleVolumeChange = useCallback(
    (raw: number) => {
      const v = clampVf(raw)
      setVolumeFactor(v)
      debouncedSaveVolume(v)
    },
    [debouncedSaveVolume],
  )

  const handleMinimalStepCountChange = useCallback(
    (raw: number) => {
      const v = clampMsc(raw)
      setMinimalStepCount(v)
      debouncedSaveCoord({
        minimal_step_count: v,
      })
    },
    [debouncedSaveCoord],
  )

  const handleMaxConcurrentTradesChange = useCallback(
    (raw: number) => {
      const v = clampMct(raw)
      setMaxConcurrentTrades(v)
      debouncedSaveCoord({
        max_concurrent_trades: v,
      })
    },
    [debouncedSaveCoord],
  )

  const handleControlOrdersChange = useCallback(
    (next: boolean) => {
      setControlOrders((previous) => {
        void debouncedSaveLive(next, previous)
        return next
      })
    },
    [debouncedSaveLive],
  )

  const handleTrailingChange = useCallback(
    (next: boolean) => {
      setTrailingEnabled(next)
      // Merge with the current Block + DCA flags so PATCH doesn't drop
      // them. The variants object is replace-merged in connection
      // settings, so any unspecified key would be set back to default
      // (= true) on the server, but we send all three explicitly to
      // make the wire shape match the dashboard's mental model.
      debouncedSaveCoord({
        coordination_settings: {
          variants: { trailing: next, block: blockEnabled, dca: dcaEnabled },
        },
      })
    },
    [blockEnabled, dcaEnabled, debouncedSaveCoord],
  )

  const handleBlockChange = useCallback(
    (next: boolean) => {
      setBlockEnabled(next)
      // Merge with the current trailing + dca flags so PATCH doesn't
      // drop them.
      debouncedSaveCoord({
        coordination_settings: {
          variants: { trailing: trailingEnabled, block: next, dca: dcaEnabled },
        },
      })
    },
    [trailingEnabled, dcaEnabled, debouncedSaveCoord],
  )

  const handleDcaChange = useCallback(
    (next: boolean) => {
      setDcaEnabled(next)
      debouncedSaveCoord({
        coordination_settings: {
          variants: { trailing: trailingEnabled, block: blockEnabled, dca: next },
        },
      })
    },
    [trailingEnabled, blockEnabled, debouncedSaveCoord],
  )

  // ── render helpers ───────────────────────────────────────────────────
  const disabled = !cid
  const disabledReason = "Select a connection above first."

  const statusChip = useMemo(() => {
    if (saveStatus === "saving") {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground">
          <Loader2 className="w-3 h-3 animate-spin" />
          Saving…
        </span>
      )
    }
    if (saveStatus === "saved") {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-green-600 dark:text-green-400">
          <CheckCircle2 className="w-3 h-3" />
          Saved
        </span>
      )
    }
    if (saveStatus === "error") {
      return (
        <span className="inline-flex items-center gap-1 text-[10px] text-red-600 dark:text-red-400">
          <AlertCircle className="w-3 h-3" />
          Failed
        </span>
      )
    }
    return null
  }, [saveStatus])

  // ── render ───────────────────────────────────────────────────────────
  return (
    <TooltipProvider delayDuration={200}>
      <div className="border-b border-primary/10 bg-muted/20">
        {/* ── header strip (always visible, click to toggle) ─────────── */}
        <button
          type="button"
          onClick={toggleOpen}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/40 transition-colors"
          aria-expanded={open}
          aria-controls="qs-options-panel"
        >
          <Sliders className="w-3.5 h-3.5 text-foreground/70" />
          <span className="text-xs font-semibold text-foreground">Options</span>

          {/* Quick-status pills so the operator sees the most important
              state without expanding the panel. */}
          <div className="ml-2 flex items-center gap-1">
            <Badge
              variant={controlOrders ? "default" : "outline"}
              className={`h-4 text-[9px] px-1.5 py-0 ${
                controlOrders
                  ? "bg-green-600 hover:bg-green-700 text-white"
                  : ""
              }`}
            >
              Orders {controlOrders ? "ON" : "OFF"}
            </Badge>
            <Badge
              variant="outline"
              className="h-4 text-[9px] px-1.5 py-0 tabular-nums"
              title="Volume factor"
            >
              Vol ×{volumeFactor.toFixed(1)}
            </Badge>
          </div>

          {/* save status (replaces nothing — sits inline) */}
          <div className="ml-auto flex items-center gap-2">
            {statusChip}
            {loading && !hydrated && (
              <Loader2 className="w-3 h-3 animate-spin text-muted-foreground" />
            )}
            {open ? (
              <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
            ) : (
              <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
            )}
          </div>
        </button>

        {/* ── expandable panel ───────────────────────────────────────── */}
        {open && (
          <div
            id="qs-options-panel"
            className="px-3 pb-3 pt-1 space-y-2.5"
          >
            {/* ── Row 1: Control Orders + Volume Factor ──────────────── */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {/* Control Orders */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={`flex items-center justify-between gap-3 rounded-md border bg-card px-2.5 py-1.5 ${
                      disabled ? "opacity-60" : ""
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Zap className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-[11px] font-semibold text-foreground">
                          Control Orders
                        </div>
                        <div className="text-[9px] text-muted-foreground leading-tight">
                          Live exchange orders {controlOrders ? "enabled" : "disabled"}
                        </div>
                      </div>
                    </div>
                    <Switch
                      checked={controlOrders}
                      disabled={disabled}
                      onClick={(event) => event.stopPropagation()}
                      onCheckedChange={handleControlOrdersChange}
                      aria-label="Control orders"
                    />
                  </div>
                </TooltipTrigger>
                {disabled && (
                  <TooltipContent side="bottom">{disabledReason}</TooltipContent>
                )}
              </Tooltip>

              {/* Volume Factor */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div
                    className={`flex items-center gap-3 rounded-md border bg-card px-2.5 py-1.5 ${
                      disabled ? "opacity-60" : ""
                    }`}
                  >
                    <Boxes className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-[11px] font-semibold text-foreground">
                          Volume Factor
                        </span>
                        <span className="text-[11px] font-bold tabular-nums text-foreground">
                          ×{volumeFactor.toFixed(1)}
                        </span>
                      </div>
                      <Slider
                        value={[volumeFactor]}
                        min={VF_MIN}
                        max={VF_MAX}
                        step={VF_STEP}
                        disabled={disabled}
                        onValueChange={(v) => handleVolumeChange(v[0])}
                        className="mt-1"
                        aria-label="Volume factor"
                      />
                    </div>
                  </div>
                </TooltipTrigger>
                {disabled && (
                  <TooltipContent side="bottom">{disabledReason}</TooltipContent>
                )}
              </Tooltip>
            </div>

            {/* ── Row 1.25: Max Concurrent Trades ────────────────────── */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`flex items-center gap-3 rounded-md border bg-card px-2.5 py-1.5 ${
                    disabled ? "opacity-60" : ""
                  }`}
                >
                  <TrendingUp className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-foreground">
                        Max Concurrent Trades
                      </span>
                      <span className="text-[11px] font-bold tabular-nums text-foreground">
                        {maxConcurrentTrades}
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      Max concurrent positions · 1 – 32
                    </div>
                    <Slider
                      value={[maxConcurrentTrades]}
                      min={MCT_MIN}
                      max={MCT_MAX}
                      step={MCT_STEP}
                      disabled={disabled}
                      onValueChange={(v) => handleMaxConcurrentTradesChange(v[0])}
                      className="mt-1"
                      aria-label="Max concurrent trades"
                    />
                  </div>
                </div>
              </TooltipTrigger>
              {disabled && (
                <TooltipContent side="bottom">{disabledReason}</TooltipContent>
              )}
            </Tooltip>

            {/* ── Row 1.5: Minimal Step Count ────────────────────────── */}
            <Tooltip>
              <TooltipTrigger asChild>
                <div
                  className={`flex items-center gap-3 rounded-md border bg-card px-2.5 py-1.5 ${
                    disabled ? "opacity-60" : ""
                  }`}
                >
                  <Layers className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[11px] font-semibold text-foreground">
                        Minimal Step Count
                      </span>
                      <span className="text-[11px] font-bold tabular-nums text-foreground">
                        {minimalStepCount}
                      </span>
                    </div>
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      Min steps for pseudo pos. · 0 – 20
                    </div>
                    <Slider
                      value={[minimalStepCount]}
                      min={MSC_MIN}
                      max={MSC_MAX}
                      step={MSC_STEP}
                      disabled={disabled}
                      onValueChange={(v) => handleMinimalStepCountChange(v[0])}
                      className="mt-1"
                      aria-label="Minimal step count"
                    />
                  </div>
                </div>
              </TooltipTrigger>
              {disabled && (
                <TooltipContent side="bottom">{disabledReason}</TooltipContent>
              )}
            </Tooltip>

            {/* ── Row 2: Profit-Factor Mins (4-up grid) ──────────────── */}
            <div
              className={`rounded-md border bg-card p-2 ${disabled ? "opacity-60" : ""}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Layers className="w-3.5 h-3.5 text-foreground/70" />
                <span className="text-[11px] font-semibold text-foreground">
                  Profit Factor Min
                </span>
                <span className="text-[9px] text-muted-foreground">
                  per stage · 0.5 – 1.5 · step 0.1
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {STAGES.map((s) => {
                  const v = pfMin[s.key]
                  return (
                    <div
                      key={s.key}
                      className="flex flex-col gap-1 rounded bg-muted/30 px-2 py-1.5"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                          {s.label}
                        </span>
                        <span className="text-[11px] font-bold tabular-nums text-foreground">
                          {v.toFixed(1)}
                        </span>
                      </div>
                      <Slider
                        value={[v]}
                        min={PF_MIN}
                        max={PF_MAX}
                        step={PF_STEP}
                        disabled={disabled}
                        onValueChange={(arr) => handlePfChange(s.key, arr[0])}
                        aria-label={`Profit factor min ${s.label}`}
                      />
                    </div>
                  )
                })}
              </div>
            </div>

            {/* ── Row 3: Strategies Pos. Counts (Trailing + Block + DCA) ── */}
            <div
              className={`rounded-md border bg-card p-2 ${disabled ? "opacity-60" : ""}`}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <Boxes className="w-3.5 h-3.5 text-foreground/70" />
                <span className="text-[11px] font-semibold text-foreground">
                  Strategies Pos. Counts
                </span>
                <span className="text-[9px] text-muted-foreground">
                  per-variant gate toggles
                </span>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {/* Trailing — placed first per operator spec: it gates the
                    trailing-stop ratchet on every Set (multi-step state
                    machine in pseudo-position-manager and the live SL
                    pull-through in syncLiveFromPseudo). When OFF, Sets
                    fall back to a static SL at `stoploss_ratio × fillPrice`
                    and the live exchange SL stops getting ratcheted. */}
                <div className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-foreground flex items-center gap-1">
                      <TrendingUp className="w-3 h-3 text-foreground/70" />
                      Trailing
                    </div>
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      Ratcheting stop-loss
                    </div>
                  </div>
                  <Switch
                    checked={trailingEnabled}
                    disabled={disabled}
                    onCheckedChange={handleTrailingChange}
                    aria-label="Trailing-stop variant"
                  />
                </div>

                {/* Block */}
                <div className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-foreground">
                      Block
                    </div>
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      Live pos × vol-ratio add-ons
                    </div>
                  </div>
                  <Switch
                    checked={blockEnabled}
                    disabled={disabled}
                    onCheckedChange={handleBlockChange}
                    aria-label="Block strategy"
                  />
                </div>

                {/* DCA */}
                <div className="flex items-center justify-between gap-2 rounded bg-muted/30 px-2 py-1.5">
                  <div className="min-w-0">
                    <div className="text-[11px] font-semibold text-foreground">
                      DCA
                    </div>
                    <div className="text-[9px] text-muted-foreground leading-tight">
                      Loss-streak averaging entries
                    </div>
                  </div>
                  <Switch
                    checked={dcaEnabled}
                    disabled={disabled}
                    onCheckedChange={handleDcaChange}
                    aria-label="DCA strategy"
                  />
                </div>
              </div>
            </div>

            {/* footer hint when no connection — surfaces inside the panel
                in case the user hasn't seen the picker above. */}
            {disabled && (
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground italic">
                <AlertCircle className="w-3 h-3" />
                {disabledReason}
              </div>
            )}
          </div>
        )}
      </div>
    </TooltipProvider>
  )
}
