"use client"

import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Loader2,
  Layers,
  Settings2,
  Workflow,
  Zap,
  ArrowRight,
} from "lucide-react"

interface StrategyTracking {
  base: {
    setsActivelyProcessing: number
    setsRunningNow?: number
    setsWithOpenPositions: number
    setsProgressing: number
    setsTotal: number
    setsCurrent: number
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    pseudoPositionLimit: number
    variantCountMin: number
    variantCountMax: number
    variantCountStep: number
  }
  main: {
    evaluatedFromBase: number
    setsCreated: number
    setsTotal: number
    setsRunningNow?: number
    setsWithOpenPositions: number
    setsProgressing: number
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    minProfitFactor: number
    maxDrawdownTime: number
    variants: {
      default: number
      trailing: number
      block: number
      dca: number
    }
  }
  real: {
    setsCurrent: number
    setsTotal: number
    setsRunningNow?: number
    setsWithOpenPositions: number
    setsProgressing: number
    evaluatedFromMain: number
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    minProfitFactor: number
    maxDrawdownTime: number
    axisAccumulation: {
      prev: Record<string, number>
      last: Record<string, number>
      cont: Record<string, number>
      pause: Record<string, number>
    }
    variantsAccumulated: {
      default: number
      trailing: number
      block: number
      dca: number
    }
    /**
     * Operator's 4-perspective Real stats:
     *   Overall  — cumulative Real Sets ever produced (lifetime)
     *   Accumulated — axis-window accumulation across cycles
     *   General  — this cycle's snapshot
     *   Combined — actively running RIGHT NOW (open or in-formation)
     */
    fourPerspective?: {
      overall: number
      accumulated: number
      general: number
      combined: number
    }
    /**
     * Averaged running counts at the Real stage (averaged over an internal
     * calculation interval — only the averaged counts are shown).
     */
    averages?: {
      activeSets: number
      posPerSet: number
      posOpen: number
      samples: number
    }
  }
  live: {
    setsActive: number
    setsRunningNow?: number
    setsWithOpenPositions: number
    setsProgressing: number
    setsTotal: number
    avgProfitFactor: number
    cap: number
  }
  validPositions?: {
    overall: number
    combined: number
    bySymbol: Record<string, number>
    byDirection: Record<string, number>
    byType: Record<string, number>
  }
  prevPos?: {
    count: number
    successRate: number
    profitFactor: number
    avgDDT: number
    minCount: number
    active: boolean
  }
  stageEvalPercent?: {
    base: number
    main: number
    real: number
  }
}

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then((r) => r.json())

export function StrategyPipeline({ connectionId }: { connectionId: string }) {
  const { data, isLoading, error } = useSWR<StrategyTracking>(
    `/api/connections/progression/${connectionId}/tracking/strategies`,
    fetcher,
    { refreshInterval: 5000, revalidateOnFocus: false },
  )

  if (isLoading && !data) {
    return (
      <div className="flex items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        Loading strategy pipeline...
      </div>
    )
  }

  if (error || !data) {
    return (
      <div className="p-4 text-sm text-destructive">
        Failed to load strategy tracking. {error?.message}
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* ── PIPELINE CASCADE ─────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Strategy Pipeline Cascade</CardTitle>
          <p className="text-xs text-muted-foreground">
            Base (independent) → Main (variants per Base) → Real (accumulation) → Live (top 500)
          </p>
        </CardHeader>
        <CardContent>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <StageBadge label="Base" count={data.base.setsCurrent} total={data.base.setsTotal} />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge label="Main" count={data.main.setsCreated} total={data.main.setsTotal} />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge
              label="Real"
              count={data.real.setsCurrent}
              total={data.real.setsTotal}
              accent="primary"
            />
            <ArrowRight className="hidden h-4 w-4 text-muted-foreground sm:block" />
            <StageBadge
              label="Live"
              count={data.live.setsActive}
              total={data.live.cap}
              accent="success"
            />
          </div>

          {/* Stage pass-through % — how much of each stage's input survives
              the filter into the next stage. Base is the 100% entry point. */}
          {data.stageEvalPercent && (
            <div className="mt-3 grid grid-cols-3 gap-2 border-t border-border pt-3">
              <StageEvalPct label="Base evals" value={data.stageEvalPercent.base} />
              <StageEvalPct label="Main evals" value={data.stageEvalPercent.main} />
              <StageEvalPct label="Real evals" value={data.stageEvalPercent.real} accent />
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── VALID POSITIONS COUNTS (operator spec) ──────────────────────
          "add to statistics and overviews.. Valid Positions Counts ..
           Overall, Combined (Accumulated)."
          One Real Set produced = one tick on the lifetime counter.
          "Combined" filters to those whose parent Base is currently
          running (= alive accumulation).
          ───────────────────────────────────────────────────────────── */}
      {data.validPositions && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="h-4 w-4" />
              Valid Positions Counts
              <Badge variant="outline" className="ml-auto font-mono text-[10px]">
                LIFETIME · ACCUMULATED
              </Badge>
            </CardTitle>
            <p className="text-xs text-muted-foreground">
              Real-stage Sets that survived PF/DDT filters — the engine&apos;s
              valid trading signals. Overall is lifetime; Combined is the
              currently-running subset.
            </p>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric
                label="Overall"
                value={data.validPositions.overall}
                hint="Lifetime count of Real Sets ever produced (cumulative across cycles)."
              />
              <Metric
                label="Combined"
                value={data.validPositions.combined}
                accent="success"
                hint="Sets whose parent Base setKey is currently in active_config_keys (running right now). This is the accumulated 'alive' total."
              />
              <Metric
                label="Long"
                value={data.validPositions.byDirection.long ?? 0}
                hint="Valid positions oriented long (cumulative)."
              />
              <Metric
                label="Short"
                value={data.validPositions.byDirection.short ?? 0}
                hint="Valid positions oriented short (cumulative)."
              />
            </div>
            {Object.keys(data.validPositions.bySymbol).length > 0 && (
              <div className="mt-4">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  By Symbol
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                  {Object.entries(data.validPositions.bySymbol)
                    .sort(([, a], [, b]) => Number(b) - Number(a))
                    .slice(0, 12)
                    .map(([sym, n]) => (
                      <div
                        key={sym}
                        className="flex items-center justify-between rounded-md border bg-muted/30 px-2 py-1.5"
                      >
                        <span className="font-mono text-[11px] text-muted-foreground">
                          {sym}
                        </span>
                        <span className="font-mono text-sm tabular-nums">
                          {n}
                        </span>
                      </div>
                    ))}
                </div>
              </div>
            )}
            {Object.keys(data.validPositions.byType).length > 0 && (
              <div className="mt-3">
                <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
                  By Indication Type
                </div>
                <div className="flex flex-wrap gap-2">
                  {Object.entries(data.validPositions.byType)
                    .sort(([, a], [, b]) => Number(b) - Number(a))
                    .map(([type, n]) => (
                      <Badge
                        key={type}
                        variant="secondary"
                        className="font-mono"
                      >
                        {type}: {n}
                      </Badge>
                    ))}
                </div>
              </div>
            )}
            {data.prevPos && (
              <div className="mt-4 rounded-md border border-primary/30 bg-primary/[0.04] p-3">
                <div className="mb-2 flex items-baseline justify-between">
                  <div className="text-[11px] uppercase tracking-wide text-primary/80 font-semibold">
                    Prev-Pos Influence
                    <Badge
                      variant={data.prevPos.active ? "default" : "outline"}
                      className="ml-2 font-mono text-[10px]"
                    >
                      {data.prevPos.active ? "ACTIVE" : "BOOTSTRAPPING"}
                    </Badge>
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    threshold ≥ {data.prevPos.minCount} closed positions
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  <Metric
                    label="Closed Positions"
                    value={data.prevPos.count}
                    hint="Total closed pseudo-positions accumulated across the run. Below threshold means the engine is in bootstrap mode (no historic blend)."
                  />
                  <Metric
                    label="Success Rate"
                    value={`${(data.prevPos.successRate * 100).toFixed(1)}%`}
                    hint="Wins / total. Drives Real-stage size/leverage tuning per (symbol×type×direction)."
                  />
                  <Metric
                    label="Profit Factor"
                    value={data.prevPos.profitFactor.toFixed(3)}
                    hint="Gross profit / gross loss. Used as MIN-blend against indication PF at Base when above threshold."
                  />
                  <Metric
                    label="Avg DDT (min)"
                    value={Math.round(data.prevPos.avgDDT)}
                    hint="Average position drawdown duration in minutes."
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Layers className="h-4 w-4" />
            Base — Independent Sets
            <Badge variant="destructive" className="ml-auto font-mono text-[10px]">
              LIMIT-GATED
            </Badge>
            <Badge variant="secondary" className="font-mono">
              {data.base.setsActivelyProcessing} processing
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Each Base Set has its OWN pseudo-positions (independent), one per
            (indication_type × direction). Position Limits + per-Direction caps
            apply HERE only (max 1 long + 1 short).
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.base.setsCurrent} />
            <Metric label="Sets (total)" value={data.base.setsTotal} />
            <Metric label="Avg PF" value={data.base.avgProfitFactor.toFixed(3)} />
            <Metric
              label="Avg Pos / Set (Overall)"
              value={data.base.avgPosPerSet.toFixed(1)}
              hint="Average positions per Set across ALL Base Sets in process this cycle (total entries ÷ all created Sets) — NOT limited to Sets with open positions. See 'Sets Running Now' below for the open/active count."
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Sets Running Now"
              value={data.base.setsRunningNow ?? data.base.setsWithOpenPositions}
              accent="success"
              hint="Canonical 'active' count: Sets whose setKey is in pseudo_positions:active_config_keys right now (open pseudo-position OR in-formation)."
            />
            <Metric
              label="Progressing Sets"
              value={data.base.setsProgressing}
              accent="primary"
              hint="Sets in mid-calculation this cycle (entries being formed, before open). Cloning/filtering input."
            />
          </div>
          <div className="mt-3 rounded-md border bg-muted/30 p-3">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Pseudo-position limit per Base Set
            </div>
            <div className="font-mono text-lg tabular-nums">
              {data.base.pseudoPositionLimit}
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Variant count slider: {data.base.variantCountMin}–{data.base.variantCountMax}{" "}
              (step {data.base.variantCountStep})
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── MAIN STAGE ──────────────────��────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Workflow className="h-4 w-4" />
            Main — Variant Sets per Base
            <Badge variant="outline" className="ml-auto font-mono text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
              FREE CALCULATION
            </Badge>
            <Badge variant="secondary" className="font-mono">
              {data.main.evaluatedFromBase} evaluated
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Variant Sets <strong>CLONE</strong> Base&apos;s pseudo-positions and
            strategically adjust them into new relative Sets — they do NOT open
            new exchange positions. Block + DCA clone Base&apos;s COMPLETE
            positions through different config gates. NO Position Limits /
            Direction caps — calculated freely. Filter: PF ≥{" "}
            {data.main.minProfitFactor.toFixed(2)}, DDT ≤{" "}
            {data.main.maxDrawdownTime}m
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.main.setsCreated} />
            <Metric label="Sets (total)" value={data.main.setsTotal} />
            <Metric label="Avg PF" value={data.main.avgProfitFactor.toFixed(3)} />
            <Metric
              label="Avg DDT (min)"
              value={Math.round(data.main.avgDrawdownTime)}
            />
            <Metric
              label="Avg Pos / Set (Overall)"
              value={data.main.avgPosPerSet.toFixed(1)}
              hint="Average positions per Set across ALL Main Sets in process this cycle (total entries ÷ all created Sets) — NOT limited to Sets with open positions. See 'Sets Running Now' below for the open/active count."
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Sets Running Now"
              value={data.main.setsRunningNow ?? data.main.setsWithOpenPositions}
              accent="success"
              hint="Cloning/filtering of Base — Main Sets whose parent Base setKey is currently in active_config_keys. Main does not open new exchange positions."
            />
            <Metric
              label="Progressing Sets"
              value={data.main.setsProgressing}
              accent="primary"
              hint="Sets in mid-calculation this cycle (variant clones being formed)."
            />
          </div>
          <div className="mt-3">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Variants per Base Set (cloned & adjusted)
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <VariantBox label="Default" value={data.main.variants.default} />
              <VariantBox label="Trailing" value={data.main.variants.trailing} />
              <VariantBox
                label="Block"
                value={data.main.variants.block}
                hint="Clones Base positions"
              />
              <VariantBox
                label="DCA"
                value={data.main.variants.dca}
                hint="Clones Base positions"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── REAL STAGE — ACCUMULATION ───────────────────────────────── */}
      <Card className="border-primary/40 bg-primary/5">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Settings2 className="h-4 w-4 text-primary" />
            Real — Position-Counts Accumulation
            <Badge variant="outline" className="ml-auto font-mono text-[10px] border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
              FREE CALCULATION
            </Badge>
            <Badge variant="default" className="font-mono">
              {data.real.setsTotal} accumulated
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Multi-axis variant accumulation happens HERE. Real <strong>CLONES
            </strong> Main&apos;s already-cloned positions and strategically
            adjusts them along the position-count axis (prev / last / cont /
            pause). NO new exchange positions opened, NO Position Limits /
            Direction caps. Filter: PF ≥{" "}
            {data.real.minProfitFactor.toFixed(2)}, DDT ≤{" "}
            {data.real.maxDrawdownTime}m
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Sets (current)" value={data.real.setsCurrent} />
            <Metric label="Sets (cumulative)" value={data.real.setsTotal} />
            <Metric label="Avg PF" value={data.real.avgProfitFactor.toFixed(3)} />
            <Metric
              label="Avg Pos / Set (Overall)"
              value={data.real.avgPosPerSet.toFixed(1)}
              hint="Average positions per Set across ALL Real Sets in process this cycle (total entries ÷ all created Sets) — NOT limited to Sets with open positions. See 'Sets Running Now' below for the open/active count."
            />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Sets Running Now"
              value={data.real.setsRunningNow ?? data.real.setsWithOpenPositions}
              accent="success"
              hint="Cloning/filtering of Main — Real Sets whose parent Base setKey is currently in active_config_keys. Real does not open new exchange positions."
            />
            <Metric
              label="Progressing Sets"
              value={data.real.setsProgressing}
              accent="primary"
              hint="Sets in mid-calculation this cycle (axis-adjusted clones being formed)."
            />
          </div>

          {/* ── REAL 4-PERSPECTIVE STATS PANEL (operator spec) ───────────
              "in Strategies Real ensure correct stats..
               Overall, Accumulated, General, Combined."
              These four perspectives together let an operator triangulate
              what's actually happening at the Real stage:
                Overall     = lifetime cumulative Real Sets ever produced
                Accumulated = axis-window accumulation (∑ prev/last/cont/pause)
                General     = this cycle's snapshot (just-created Real Sets)
                Combined    = actively running RIGHT NOW (open or in-formation)
              ──────────────────────────────────────────────────────────── */}
          {data.real.fourPerspective && (
            <div className="mt-4 rounded-md border border-primary/30 bg-primary/[0.04] p-3">
              <div className="mb-2 flex items-baseline justify-between">
                <div className="text-[11px] uppercase tracking-wide text-primary/80 font-semibold">
                  Real Stats — 4 Perspectives
                </div>
                <div className="text-[10px] text-muted-foreground">
                  lifetime · axis · current · alive
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <PerspectiveTile
                  label="Overall"
                  value={data.real.fourPerspective.overall}
                  hint="Cumulative Real Sets ever produced (lifetime). Includes already-progressed Sets that have since closed."
                />
                <PerspectiveTile
                  label="Accumulated"
                  value={data.real.fourPerspective.accumulated}
                  hint="Sum of position-count axis windows across cycles (prev × last × cont × pause)."
                />
                <PerspectiveTile
                  label="General"
                  value={data.real.fourPerspective.general}
                  hint="This cycle's Real-stage snapshot (post-PF/DDT filter, post-cap)."
                />
                <PerspectiveTile
                  label="Combined"
                  value={data.real.fourPerspective.combined}
                  highlight
                  hint="Actively running RIGHT NOW — Real Sets whose parent Base setKey is in pseudo_positions:active_config_keys (open or in-formation)."
                />
              </div>
            </div>
          )}

          {/* ── REAL AVERAGED COUNTS ─────────────────────────────────────
              Averaged running counts at the Real stage: Active Sets,
              Positions per Set, and total Open Positions. These smooth out
              per-cycle noise so operators see the steady-state size of the
              Real stage rather than a single jittery snapshot. */}
          {data.real.averages && (
            <div className="mt-4 rounded-md border border-border bg-muted/30 p-3">
              <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground font-semibold">
                Real Averages
              </div>
              <div className="grid grid-cols-3 gap-2">
                <PerspectiveTile
                  label="Active Sets"
                  value={data.real.averages.activeSets}
                  hint="Average number of Real Sets running, averaged over the calculation interval."
                />
                <PerspectiveTile
                  label="Pos / Set"
                  value={data.real.averages.posPerSet}
                  hint="Average positions (entries) held per running Real Set."
                />
                <PerspectiveTile
                  label="Open Positions"
                  value={data.real.averages.posOpen}
                  hint="Average total open positions across running Real Sets."
                />
              </div>
            </div>
          )}

          {/* Position-count axis accumulation */}
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Position-Count Axis Accumulation (cumulative across cycles)
            </div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <AxisCard
                label="Previous (1–12)"
                values={data.real.axisAccumulation.prev}
              />
              <AxisCard
                label="Last (1–4)"
                values={data.real.axisAccumulation.last}
              />
              <AxisCard
                label="Continuous (1–8)"
                values={data.real.axisAccumulation.cont}
              />
              <AxisCard
                label="Pause (1–8)"
                values={data.real.axisAccumulation.pause}
              />
            </div>
          </div>

          {/* Variant accumulation */}
          <div className="mt-4">
            <div className="mb-2 text-[11px] uppercase tracking-wide text-muted-foreground">
              Variants Accumulated at Real
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <VariantBox
                label="Default"
                value={data.real.variantsAccumulated.default}
              />
              <VariantBox
                label="Trailing"
                value={data.real.variantsAccumulated.trailing}
              />
              <VariantBox
                label="Block"
                value={data.real.variantsAccumulated.block}
              />
              <VariantBox
                label="DCA"
                value={data.real.variantsAccumulated.dca}
              />
            </div>
          </div>
        </CardContent>
      </Card>

      {/* ── LIVE STAGE ───────────────────────────────────────────────── */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Zap className="h-4 w-4" />
            Live — Top {data.live.cap} on Exchange
            <Badge variant="default" className="ml-auto font-mono">
              {data.live.setsActive} active
            </Badge>
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Best Sets ranked by avgPF, one pseudo-position per Set on exchange
          </p>
        </CardHeader>
        <CardContent>
          <div className="grid gap-3 sm:grid-cols-3">
            <Metric label="Active now" value={data.live.setsActive} />
            <Metric label="Cap" value={data.live.cap} />
            <Metric label="Avg PF" value={data.live.avgProfitFactor.toFixed(3)} />
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Sets Running Now"
              value={data.live.setsRunningNow ?? data.live.setsWithOpenPositions}
              accent="success"
              hint="Sets with executed/holding orders on the exchange. These directly mirror the running pseudo-positions."
            />
            <Metric
              label="Progressing Sets"
              value={data.live.setsProgressing}
              accent="primary"
              hint="Real-stage Sets being ranked & capped for live execution this cycle."
            />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SUB: Real 4-Perspective tile (Overall / Accumulated / General / Combined)
// ─────────────────────────────────────────────────────────────────────────
function PerspectiveTile({
  label,
  value,
  hint,
  highlight,
}: {
  label: string
  value: number
  hint?: string
  highlight?: boolean
}) {
  return (
    <div
      className={
        "flex flex-col rounded-md border px-2.5 py-1.5 " +
        (highlight
          ? "border-emerald-500/50 bg-emerald-500/10"
          : "border-border bg-card/50")
      }
      title={hint}
    >
      <div
        className={
          "text-[10px] uppercase tracking-wide " +
          (highlight ? "text-emerald-700 dark:text-emerald-400 font-semibold" : "text-muted-foreground")
        }
      >
        {label}
      </div>
      <div className="font-mono text-base tabular-nums">
        {value.toLocaleString()}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────
// SUB-COMPONENTS
// ─────────────────────────────────────────────────────────────────────────

function StageBadge({
  label,
  count,
  total,
  accent,
}: {
  label: string
  count: number
  total: number
  accent?: "primary" | "success"
}) {
  const ringClass =
    accent === "primary"
      ? "border-primary/40 bg-primary/5"
      : accent === "success"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-border bg-card"
  return (
    <div className={`flex flex-1 flex-col rounded-md border px-3 py-2 ${ringClass}`}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-xl tabular-nums">{count}</span>
        <span className="text-xs text-muted-foreground">/ {total} total</span>
      </div>
    </div>
  )
}

function StageEvalPct({
  label,
  value,
  accent,
}: {
  label: string
  value: number
  accent?: boolean
}) {
  return (
    <div
      className={`flex flex-col rounded-md border px-3 py-2 ${
        accent ? "border-primary/40 bg-primary/5" : "border-border bg-card"
      }`}
    >
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <span className="font-mono text-lg tabular-nums">{value.toFixed(1)}%</span>
    </div>
  )
}

function Metric({
  label,
  value,
  accent,
  hint,
}: {
  label: string
  value: number | string
  accent?: "primary" | "success"
  hint?: string
}) {
  const ringClass =
    accent === "primary"
      ? "border-primary/40 bg-primary/5"
      : accent === "success"
        ? "border-emerald-500/40 bg-emerald-500/5"
        : "border-border bg-card"
  return (
    <div className={`rounded-md border p-2 ${ringClass}`} title={hint}>
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-lg tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function VariantBox({
  label,
  value,
  hint,
}: {
  label: string
  value: number
  hint?: string
}) {
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-mono text-base tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-[10px] text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function AxisCard({
  label,
  values,
}: {
  label: string
  values: Record<string, number>
}) {
  const entries = Object.entries(values).sort(([a], [b]) => Number(a) - Number(b))
  const total = entries.reduce((s, [, v]) => s + v, 0)
  return (
    <div className="rounded-md border bg-card p-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {label}
        </span>
        <span className="font-mono text-xs tabular-nums">{total}</span>
      </div>
      <div className="mt-1 grid grid-cols-4 gap-1">
        {entries.length === 0 ? (
          <span className="col-span-4 text-[10px] text-muted-foreground">
            no data
          </span>
        ) : (
          entries.map(([w, v]) => (
            <div
              key={w}
              className="flex items-center justify-between rounded bg-muted/50 px-1 text-[10px]"
              title={`window=${w} → ${v}`}
            >
              <span className="text-muted-foreground">{w}</span>
              <span className="font-mono tabular-nums">{v}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
