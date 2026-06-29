"use client"

/**
 * Strategy Coordination Settings Section
 *
 * Lives inside the Strategies tab of the Connection Settings dialog and
 * gives the operator a single, organised surface for the *Position-Count
 * coordination* layer added on top of base strategy evaluation. It groups
 * settings that previously lived only as code constants in
 * `lib/strategy-coordinator.ts` into a per-connection, persisted form.
 *
 * Two distinct sub-sections:
 *
 * 1. **Position-Count Axes** — the four step-1 axes that gate
 *    Main-stage related Set creation. Each axis has:
 *      • an enable toggle (the axis can be disabled entirely)
 *      • a max-window slider (1..N; N defaults to spec maxima
 *        12 / 4 / 8 / 8 for prev / last / cont / pause respectively)
 *
 * 2. **Variant Profiles** — the *categorical* variants evaluated on top
 *    of the axes:
 *      • Default       (always on; not toggleable)
 *      • Trailing      (gated on lastWins ≥ 2 + no continuous)
 *      • Block         (gated on continuousCount 1..2; INDEPENDENT of
 *                       Pos-count axes per the user's spec)
 *      • DCA           (gated on prevLosses ≥ 1; INDEPENDENT of axes)
 *
 * Pause is intentionally modeled only as a Position-Count axis above; it
 * pauses/calibrates further calculations by count window and is not a
 * general strategy variant. Block + DCA are flagged "Independent" in the UI so the operator
 * understands they don't fold into the axis windows above.
 *
 * The component is *purely controlled* — it accepts the current
 * `CoordinationSettings` value plus an `onChange` callback. Persistence
 * is the parent dialog's responsibility; the parent already round-trips
 * settings through the connection-settings API.
 */

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"

export interface CoordinationSettings {
  // ── Position-Count axes ─────────────────────────────────────────────
  axes: {
    prev:  { enabled: boolean; maxWindow: number }
    last:  { enabled: boolean; maxWindow: number }
    cont:  { enabled: boolean; maxWindow: number }
    pause: { enabled: boolean; maxWindow: number }
  }
  // ── Categorical variant profiles ────────────────────────────────────
  variants: {
    trailing: boolean
    block:    boolean
    dca:      boolean
  }
  // ── Block-strategy: completed-position block count × vol-ratio coordination ─
  // Knobs that flow into the Block variant's runtime size scaling.
  // The coordinator multiplies each Block sub-config's base size by
  //   m(blockCount) = 1 + (blockCount − 1) × blockVolumeRatio
  // for every blockCount in [1..blockMaxStack]. pause count is derived as
  // round(blockCount × blockPauseCountRatio).
  blockVolumeRatio: number // 0.25..3.0 per spec band (UI clamps; engine re-clamps)
  blockMaxStack:    number // 1..10 block sizes processed independently
  blockPauseCountRatio: number // 1..4, step 0.5
  blockActiveRealEnabled: boolean // active real-position Block overlay, default true
  blockActiveLiveEnabled: boolean // active live-position Block overlay, default true

  /**
   * ── Prev-PI threshold (operator spec) ──────────────────────────────
   *
   * Activation threshold for the historic-PI blend at Base stage and
   * the per-variant Real-stage tuner. Below this many CLOSED positions
   * in the (symbol × indicationType × direction) bucket, the engine
   * runs in BOOTSTRAP mode (= raw indication PF, no historic blend) so
   * fresh boots can produce trades immediately. At/above the threshold
   * the engine engages historic PF min-blend and Real-stage size/leverage
   * tuning. Default 5 = smallest statistically meaningful denominator.
   * Backed by `connection_settings:{conn}.prevPosMinCount`.
   */
  prevPosMinCount: number // 1..50, default 5

  /**
   * ── Base PF rolling-window size ─────────────────────────────────────
   * The eval gates average historic Profit Factor over the LAST N closed
   * positions of each (indication × direction) bucket — not the lifetime
   * mean. This is N. A tighter window reacts faster to a strategy that has
   * started degrading; a wider one is steadier but stickier. Must be ≥
   * prevPosMinCount to be meaningful (the blend only activates once a
   * bucket has prevPosMinCount samples). Range 5..200 step 5, default 25.
   * Backed by `connection_settings:{conn}.prevPosWindow`.
   */
  prevPosWindow: number

  /**
   * ── Main-stage validation min position-count ───────────────────────
   * Operator spec: At Main, only Base Sets whose `entryCount >=
   * mainEvalPosCount` are run through PF + DDT validation. Sets with
   * fewer completed pseudo-positions are SKIPPED (not counted as passed,
   * not promoted) — they re-enter the validation pool on subsequent
   * cycles once enough positions have closed.
   * Range 5..50 step 5, default 15.
   */
  mainEvalPosCount: number

  /**
   * ── Real-stage validation min position-count ───────────────────────
   * Same semantics as `mainEvalPosCount` but applied at Real (Main →
   * Real promotion). Range 5..50 step 5, default 10.
   */
  realEvalPosCount: number

  /**
   * ── Minimal Step (pseudo-position window floor) ─────────────────────
   * Filters the `stepsOptions` array in `IndicationConfigManager` so only
   * step-window sizes ≥ minStep are generated and evaluated. A lower value
   * (e.g. 3) includes fast short-window configs that react quickly but
   * can produce more losing trades on noisy data. Raising the floor (e.g.
   * 10–15) keeps only longer, smoother windows that typically yield higher
   * signal quality at the cost of slower response.
   *
   * Range 2..30 step 1, default 5.
   * Backed by `connection_settings:{conn}.minStep`.
   */
  minStep: number

  /**
   * Minimum Base step-window size that is allowed to fan out into
   * independent trailing Sets. Default 6 keeps very noisy 2–5 step Base
   * windows on the non-trailing path while still allowing normal Base Sets
   * to be evaluated. Backed by connection_settings:{conn}.trailingMinStep.
   */
  trailingMinStep: number
}

/**
 * Operator-spec defaults.
 * - trailing: on, block: on, dca: off (per directive)
 * - minStep: 5 (default; range 2-30)
 * - trailingMinStep: 6 (default; range 2-30)
 * - PF defaults set in DEFAULT_STRATEGY_PROFILE (base=1.0, main/real=1.2)
 */
export const DEFAULT_COORDINATION_SETTINGS: CoordinationSettings = {
  axes: {
    prev:  { enabled: true,  maxWindow: 12 },
    last:  { enabled: true,  maxWindow: 4  },
    cont:  { enabled: true,  maxWindow: 8  },
    pause: { enabled: true,  maxWindow: 8  },
  },
  variants: {
    trailing: true,
    block:    true,
    dca:      false, // off by default per operator spec
  },
  blockVolumeRatio: 1.0,
  blockMaxStack:    10,
  blockPauseCountRatio: 1.0,
  blockActiveRealEnabled: true,
  blockActiveLiveEnabled: true,
  prevPosMinCount:   5,
  prevPosWindow:    25,
  mainEvalPosCount: 15,
  realEvalPosCount: 10,
  minStep:           5,
  trailingMinStep:   6,
}

interface StrategyCoordinationSectionProps {
  value: CoordinationSettings
  onChange: (next: CoordinationSettings) => void
}

// Axis metadata — labels, spec ceilings, and short descriptions. Driven
// off this map so the JSX below stays compact and DRY.
const AXES: Array<{
  key: keyof CoordinationSettings["axes"]
  label: string
  range: string
  ceiling: number
  description: string
}> = [
  {
    key: "prev",
    label: "Previous",
    range: "1–12",
    ceiling: 12,
    description:
      "Closed-position lookback bucket. Step-1 windows control how far back the coordinator reads when validating Sets.",
  },
  {
    key: "last",
    label: "Last (of previous)",
    range: "1–4",
    ceiling: 4,
    description:
      "Magnitude of the last-N wins / losses dimension. Drives trailing aggressiveness and the pause count-axis.",
  },
  {
    key: "cont",
    label: "Continuous",
    range: "1–8",
    ceiling: 8,
    description:
      "Open continuous positions. Larger windows allow longer add-on stacks before the gate closes.",
  },
  {
    key: "pause",
    label: "Position-count Pause",
    range: "1–8",
    ceiling: 8,
    description:
      "Last-N count window used to pause/calibrate further position-count calculations. This stays under axis semantics and is not a dispatchable strategy variant.",
  },
]

const VARIANTS: Array<{
  key: keyof CoordinationSettings["variants"]
  label: string
  badge: string
  axisIndependent: boolean
  description: string
}> = [
  {
    key: "trailing",
    label: "Trailing",
    badge: "Recent winners",
    axisIndependent: false,
    description:
      "Scale-in profile for runs of recent winners with no open position. Higher leverage, longer DDT bias.",
  },
  {
    key: "block",
    label: "Block",
    badge: "Independent · Add-on",
    axisIndependent: true,
    description:
      "Completed-position recovery profile that processes every configured block count independently over the selected Set.",
  },
  {
    key: "dca",
    label: "DCA",
    badge: "Independent · Recovery",
    axisIndependent: true,
    description:
      "Recovery profile after recent losses (prevLosses ≥ 1). Reduce / close states with conservative sizing. Evaluated INDEPENDENTLY of position-count axes.",
  },
]

export function StrategyCoordinationSection({
  value,
  onChange,
}: StrategyCoordinationSectionProps) {
  // ── Helpers ─ partial setters for axes & variants. Keeping the
  // mutator surface inline (rather than reducer / context) keeps the
  // component drop-in for the existing dialog's controlled-state
  // pattern.
  const setAxis = (
    key: keyof CoordinationSettings["axes"],
    patch: Partial<{ enabled: boolean; maxWindow: number }>,
  ) => {
    onChange({
      ...value,
      axes: {
        ...value.axes,
        [key]: { ...value.axes[key], ...patch },
      },
    })
  }

  const setVariant = (
    key: keyof CoordinationSettings["variants"],
    enabled: boolean,
  ) => {
    onChange({
      ...value,
      variants: { ...value.variants, [key]: enabled },
    })
  }

  return (
    <div className="space-y-4">
      {/* ── Position-Count Axes card ─────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Position-Count Axes</CardTitle>
              <CardDescription className="text-xs">
                Step-1 windows that gate Main-stage related Set creation. Each
                validated Base Set fans out into related Sets across these
                axes. Counts surface in the dashboard&apos;s axis strip.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              4 axes
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {AXES.map((axis) => {
            const state = value.axes[axis.key]
            return (
              <div
                key={axis.key}
                className="flex flex-col gap-2 rounded-lg border border-border/60 p-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2">
                    <Label className="text-sm font-semibold capitalize">
                      {axis.label}
                    </Label>
                    <Badge variant="outline" className="text-[10px] tabular-nums">
                      {axis.range}
                    </Badge>
                  </div>
                  <Switch
                    checked={state.enabled}
                    onCheckedChange={(checked) =>
                      setAxis(axis.key, { enabled: checked })
                    }
                  />
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {axis.description}
                </p>
                <div className="flex items-center gap-3 pt-1">
                  <Label className="text-xs text-muted-foreground min-w-[80px]">
                    Max window
                  </Label>
                  <Slider
                    value={[state.maxWindow]}
                    min={1}
                    max={axis.ceiling}
                    step={1}
                    onValueChange={(v) =>
                      setAxis(axis.key, { maxWindow: v[0] })
                    }
                    disabled={!state.enabled}
                    className="flex-1"
                  />
                  <span className="text-xs font-semibold tabular-nums w-8 text-right">
                    {state.maxWindow}
                  </span>
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Position-Count Cartesian Fan-out (read-only spec) ────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Position-Count Sets — Cartesian Fan-out
              </CardTitle>
              <CardDescription className="text-xs">
                Each validated Base Set fans out at Main into additional
                Position-Count Sets along three axes plus a direction split.{" "}
                <strong>Previous</strong> is a PF filter — only emits when the
                mean PF of the last N completed positions meets Main&apos;s
                threshold. <strong>Last</strong> tags each Set by outcome
                (positive / negative aggregate of last M completed
                positions). <strong>Continuous</strong> contributes to
                position count:{" "}
                <span className="font-mono text-[11px]">
                  entries = base + cont
                </span>
                . Open positions are excluded — only completed ones count.
                Real-stage hedge-netting collapses bucket{" "}
                <span className="font-mono text-[11px]">
                  (symbol × indication × triple × outcome)
                </span>{" "}
                to the dominant direction; Live opens/closes partial
                positions on hedge-count deltas.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              5 × 4 × 8 × 2
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs">
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Previous</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  PF filter
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                4 → 12 step 2
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                4, 6, 8, 10, 12
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Last</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  pos / neg
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                1 → 4 step 1
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                1, 2, 3, 4
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Continuous</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  pos count
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">
                1 → 8 step 1
              </div>
              <div className="font-mono text-[11px] text-muted-foreground">
                1, 2, …, 8
              </div>
            </div>
            <div className="rounded-md border border-border/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold">Direction</div>
                <Badge variant="outline" className="text-[9px] tabular-nums">
                  Cartesian
                </Badge>
              </div>
              <div className="text-muted-foreground tabular-nums">2 values</div>
              <div className="font-mono text-[11px] text-muted-foreground">
                long, short
              </div>
            </div>
          </div>
          <p className="text-xs text-muted-foreground leading-relaxed pt-1">
            Worst-case fan-out per Base = 5 × 4 × 8 × 2 ={" "}
            <strong>320</strong> Sets. Typical (prev PF-filter rejects ~half;
            last single-outcome-tagged): ≈ 128–192. After Real hedge-net
            cancellation: ≈ 96 surviving Sets per Base reaching Live. No
            lock — recompute every cycle; hedge-count deltas drive partial
            open/close at Live.
          </p>
        </CardContent>
      </Card>

      {/* ── Variant profiles card ────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">Variant Profiles</CardTitle>
              <CardDescription className="text-xs">
                Categorical Set variants evaluated alongside the axes above.
                Block and DCA are evaluated <em>independently</em> of the
                position-count axes per spec.
              </CardDescription>
            </div>
            <Badge variant="secondary" className="text-[10px]">
              3 variants
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {VARIANTS.map((variant) => {
            const enabled = value.variants[variant.key]
            return (
              <div
                key={variant.key}
                className="flex items-start justify-between gap-3 rounded-lg border border-border/60 p-3"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Label className="text-sm font-semibold capitalize">
                      {variant.label}
                    </Label>
                    <Badge
                      variant={variant.axisIndependent ? "default" : "outline"}
                      className="text-[10px]"
                    >
                      {variant.badge}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed mt-1">
                    {variant.description}
                  </p>
                </div>
                <Switch
                  checked={enabled}
                  onCheckedChange={(checked) =>
                    setVariant(variant.key, checked)
                  }
                />
              </div>
            )
          })}
        </CardContent>
      </Card>

      {/* ── Block tuning card ────────────────────────────────────────
          Completed-position Block coordination knobs:
            • Volume-ratio slider → additive multiplier per block count
            • Max-stack stepper   → number of independent block counts
            • Pause ratio         → post-success pause window per block count */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Block — Completed Position Count × Vol-Ratio
              </CardTitle>
              <CardDescription className="text-xs">
                Adjusts how the Block variant scales add-on size by completed
                block count. The emitted overlay&apos;s
                size multiplier follows{" "}
                <span className="font-mono text-[11px]">
                  m(block) = 1 + (block − 1) × ratio
                </span>{" "}
                and every block count up to <strong>max stack</strong> is
                processed independently, so coverage is bounded and parallel.
              </CardDescription>
            </div>
            <Badge
              variant={value.variants.block ? "default" : "outline"}
              className="text-[10px]"
            >
              {value.variants.block ? "Active" : "Disabled"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Volume ratio */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Volume Ratio</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Additive scaling step per completed-position block count.
                  1.0 ≈ doubles per block step (spec default); 0.25 is
                  conservative; 3.0 is aggressive. Engine clamps to
                  0.25–3.0 even if the value is bypassed.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                0.25–3.0
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockVolumeRatio]}
                min={0.25}
                max={3.0}
                step={0.05}
                onValueChange={(v) =>
                  onChange({ ...value, blockVolumeRatio: Number(v[0].toFixed(2)) })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.blockVolumeRatio.toFixed(2)}×
              </span>
            </div>
            <div className="grid grid-cols-3 gap-2 pt-1 text-[11px]">
              {[1, 2, 3].map((n) => {
                const mul = 1 + (n - 1) * value.blockVolumeRatio
                return (
                  <div
                    key={n}
                    className="rounded-md border border-border/60 p-2 flex items-center justify-between gap-2"
                  >
                    <span className="text-muted-foreground">
                      block={n}
                    </span>
                    <span className="font-mono tabular-nums font-semibold">
                      ×{mul.toFixed(2)}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* Active Real position overlay */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-semibold">Active Real Position Block</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Adds an independent Block overlay for currently running Real-stage
                  positions, separate from completed-position block-count calcs.
                </p>
              </div>
              <Switch
                checked={value.blockActiveRealEnabled}
                onCheckedChange={(checked) =>
                  onChange({ ...value, blockActiveRealEnabled: checked })
                }
                disabled={!value.variants.block}
              />
            </div>
          </div>

          {/* Active live position overlay */}
          <div className="rounded-lg border border-border/60 p-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <Label className="text-sm font-semibold">Active Live Position Block</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Adds an independent Block overlay for currently running live
                  positions, separate from completed-position block-count calcs.
                </p>
              </div>
              <Switch
                checked={value.blockActiveLiveEnabled}
                onCheckedChange={(checked) =>
                  onChange({ ...value, blockActiveLiveEnabled: checked })
                }
                disabled={!value.variants.block}
              />
            </div>
          </div>

          {/* Max stack */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Max Stack</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Number of independent Block sizes processed in parallel.
                  Default 10 emits all block counts 1 through 10. Engine clamps to 1–10.
                  Default 3 emits block counts 1, 2, and 3. Engine clamps to 2–8.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                1–10
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockMaxStack]}
                min={1}
                max={10}
                step={1}
                onValueChange={(v) =>
                  onChange({ ...value, blockMaxStack: v[0] })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.blockMaxStack}
              </span>
            </div>
          </div>

          {/* Pause count ratio */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">Pause Count Ratio</Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Converts each Block count into a post-success pause/cooldown
                  window: pause = round(block count × ratio). Default 1.0.
                </p>
              </div>
              <Badge variant="outline" className="text-[10px] tabular-nums">
                1–4 · step 0.5
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.blockPauseCountRatio]}
                min={1}
                max={4}
                step={0.5}
                onValueChange={(v) =>
                  onChange({ ...value, blockPauseCountRatio: Number(v[0].toFixed(1)) })
                }
                disabled={!value.variants.block}
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.blockPauseCountRatio.toFixed(1)}×
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── Prev-PI Influence card ───────────────────────────────────
          Operator spec: "make sure strategies are evaluating prev pis
          and profitfactors min from historic … prev pis cnts are
          working and added to settings,strategy".

          One number — the activation threshold below which the engine
          runs in BOOTSTRAP mode (raw indication PF, no historic blend).
          At/above the threshold, Base avgProfitFactor becomes the MIN
          of (live PF, historic PF) and Real-stage size/leverage tuning
          activates per (symbol × indicationType × direction). */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Prev-PI Influence — Historic Blend Threshold
              </CardTitle>
              <CardDescription className="text-xs">
                Activation gate for the historic-PF blend at Base and the
                Real-stage size/leverage tuner. Below this many CLOSED
                positions in the{" "}
                <span className="font-mono text-[11px]">
                  (symbol × indicationType × direction)
                </span>{" "}
                bucket the engine runs in <strong>bootstrap</strong> mode
                (raw indication PF, no blend) so fresh boots can produce
                trades immediately. At/above the threshold the engine
                MIN-blends realised PF into{" "}
                <span className="font-mono text-[11px]">
                  avgProfitFactor
                </span>{" "}
                — historic underperformance pulls the bar down so Base
                → Main filters reject it. Default 5 = smallest
                statistically meaningful denominator.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              1–50
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                Min closed positions for blend
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 5
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.prevPosMinCount]}
                min={1}
                max={50}
                step={1}
                onValueChange={(v) =>
                  onChange({ ...value, prevPosMinCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.prevPosMinCount}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              Lower = engages historic blend faster (small samples can be
              noisy). Higher = waits for more data before letting history
              influence current decisions. The Real-stage tuner uses the
              same threshold to gate per-variant size/leverage adjustments
              (Block size scaling, DCA leverage capping, Pos-coord axis
              size). Counts and live status are surfaced on the Strategy
              Pipeline dashboard tile.
            </p>
          </div>

          {/* Cumulative last-N window — feeds BOTH windowed PF and DDT */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                PF / DDT window (last N positions)
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 25
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.prevPosWindow]}
                min={5}
                max={200}
                step={5}
                onValueChange={(v) =>
                  onChange({ ...value, prevPosWindow: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-10 text-right">
                {value.prevPosWindow}
              </span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              One cumulative window over the{" "}
              <strong>last N completed positions</strong> of each (indication ×
              direction) bucket. Both the historic Profit Factor and the
              average Drawdown-Time are computed over this same sample — not the
              lifetime mean. A tighter window reacts faster when a strategy
              starts degrading; a wider window is steadier but slower to demote
              a fading Set. Should be ≥ the min-blend threshold above.
            </p>
          </div>
        </CardContent>
      </Card>
      {/* ── Stage Validation Position-Count card ─────────────────────
          Operator spec:
            • Main evaluates Base with PF + DDT for X pre pseudo
              positions per Set (min positions to validate). Default 15.
            • Real evaluates Main the same way. Default 10.
          If a Set has fewer positions than the threshold it is SKIPPED
          (not validated, not promoted, no count bump) — re-evaluated
          on subsequent cycles once enough positions accumulate. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Stage Validation — Min Positions per Set
              </CardTitle>
              <CardDescription className="text-xs">
                Minimum completed pseudo-positions a Set must contain
                before its <strong>profit-factor</strong> and{" "}
                <strong>drawdown-time</strong> are evaluated for promotion
                to the next stage. Below the threshold the Set is
                <em> skipped</em> (not validated, not counted) — it
                re-enters the validation pool on subsequent cycles once
                enough positions have closed. Drawdown-time ceiling at
                Main + Real is <strong>5 hours</strong>.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              8–80 step 2
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Main */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">
                  Main — Min positions to validate
                </Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Base → Main: a Base Set is validated against{" "}
                  <span className="font-mono text-[11px]">minPF</span> and{" "}
                  <span className="font-mono text-[11px]">maxDDT (5h)</span>{" "}
                  only when its entry count meets this threshold.
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 15
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.mainEvalPosCount]}
                min={8}
                max={80}
                step={2}
                onValueChange={(v) =>
                  onChange({ ...value, mainEvalPosCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.mainEvalPosCount}
              </span>
            </div>
          </div>
          {/* Real */}
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <Label className="text-sm font-semibold">
                  Real — Min positions to validate
                </Label>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  Main → Real: a Main Set is validated against{" "}
                  <span className="font-mono text-[11px]">minPF</span> and{" "}
                  <span className="font-mono text-[11px]">maxDDT (5h)</span>{" "}
                  only when its entry count meets this threshold.
                </p>
              </div>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 10
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.realEvalPosCount]}
                min={8}
                max={80}
                step={2}
                onValueChange={(v) =>
                  onChange({ ...value, realEvalPosCount: v[0] })
                }
                className="flex-1"
              />
              <span className="text-xs font-semibold tabular-nums w-8 text-right">
                {value.realEvalPosCount}
              </span>
            </div>
          </div>

        </CardContent>
      </Card>

      {/* ── Minimal Step card ─────────────────────────────────────────
          Controls which step-window sizes the indication config manager
          generates. Only step values ≥ minStep are included in
          stepsOptions, filtering out fast short-window configs that
          tend to produce more losing trades on noisy/flat markets. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <CardTitle className="text-sm">
                Minimal Base Pseudo-Position Range Step
              </CardTitle>
              <CardDescription className="text-xs">
                Minimum step size used when generating pseudo-position windows
                for Base-stage indication configs (range 2–30, monotonic step
                5 by default). Only step values <strong>≥ this floor</strong>{" "}
                are created and evaluated. Raising the value removes fast
                short-window configs that react quickly but fire on noise.
                Lower = more configs; higher = fewer, smoother signals.
              </CardDescription>
            </div>
            <Badge variant="outline" className="text-[10px] tabular-nums">
              2–30, step 1
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-border/60 p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm font-semibold">
                Min position-creation step
              </Label>
              <Badge variant="secondary" className="text-[10px] tabular-nums">
                default 5
              </Badge>
            </div>
            <div className="flex items-center gap-3 pt-1">
              <Slider
                value={[value.minStep ?? 5]}
                min={1}
                max={30}
                step={1}
                onValueChange={(v) =>
                  onChange({ ...value, minStep: v[0] })
                }
                className="flex-1"
              />
              <span className="text-sm font-semibold tabular-nums w-8 text-right">
                {value.minStep ?? 5}
              </span>
            </div>
            <div className="flex justify-between text-[10px] text-muted-foreground pt-0.5">
              <span>2 (all)</span>
              <span className="text-muted-foreground/60">default 5</span>
              <span>30 (slowest)</span>
            </div>
            <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
              At default 5 the engine creates windows [5, 10, 15, 20, 25, 30].
              Setting to 2 adds the fastest 2 and 3 step windows. Setting to 10 removes
              the shortest noisy windows. Changes take effect from the next
              indication-config regeneration cycle.
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
