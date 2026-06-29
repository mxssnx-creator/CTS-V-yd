"use client"

export const dynamic = "force-dynamic"

import { useState, useEffect, useCallback, useRef } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Progress } from "@/components/ui/progress"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import {
  RefreshCw, ChevronDown, ChevronRight, Activity, Zap, GitBranch,
  Filter, Target, Database, Bot, Layers, TrendingUp, ArrowRight,
  Network, LineChart, Cpu, Shield, BarChart3,
} from "lucide-react"
import { AuthGuard } from "@/components/auth-guard"
import { useExchange } from "@/lib/exchange-context"
import { cn } from "@/lib/utils"

// ─── Types ───────────────────────────────────────────────────────────────────

interface StageDetailStats {
  avgProfitFactor?: number
  avgPosPerSet?: number
}

interface EngineStats {
  indicationCycleCount: number
  strategyCycleCount: number
  totalIndicationsCount: number
  totalStrategyCount: number
  baseStrategyCount: number
  mainStrategyCount: number
  realStrategyCount: number
  liveStrategyCount: number
  positionsCount: number
  indicationsByType: Record<string, number>
  cycleSuccessRate: number
  cyclesCompleted: number
  strategyDetail?: {
    base?: StageDetailStats
    real?: StageDetailStats
  }
  stageBase?: StageDetailStats
  stageReal?: StageDetailStats
  baseAvgProfitFactor?: number
  realActivePosAvg?: number
  openPositions?: {
    real?: {
      activeAvg?: number
    }
  }
  progression?: {
    strategy_base_avg_profit_factor?: number | string
  }
}

interface LivePosition {
  id: string
  symbol: string
  direction: "long" | "short"
  status: "pending" | "open" | "partially_filled" | "filled" | "closed" | "error" | "simulated"
  quantity: number
  executedQuantity: number
  entryPrice: number
  averageExecutionPrice: number
  takeProfit: number
  stopLoss: number
  orderId?: string
  exchangeData?: { unrealizedPnl?: number; roi?: number; markPrice?: number }
  createdAt: number
}
interface QueueData {
  queueSize: number; processingRate: number; successRate: number
  avgLatency: number; completedOrders: number; failedOrders: number
  workflowHealth: string; processingPressure: number
  workflow: Array<{ id: string; label: string; status: "complete" | "warning" | "pending"; detail: string }>
  focusConnection: { id: string; name: string; exchange: string; liveTradeEnabled: boolean } | null
  progression: { cyclesCompleted: number; successfulCycles: number; cycleSuccessRate: number; totalTrades: number } | null
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M"
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K"
  return String(n)
}

function positiveNumber(...values: Array<number | string | null | undefined>): number | null {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return null
}

// ─── Atoms ───────────────────────────────────────────────────────────────────

function Dot({ on }: { on: boolean }) {
  return (
    <span className="relative flex h-1.5 w-1.5 shrink-0">
      {on && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />}
      <span className={cn("relative inline-flex h-1.5 w-1.5 rounded-full", on ? "bg-emerald-500" : "bg-muted-foreground/30")} />
    </span>
  )
}

function Tag({ children, color = "default" }: { children: React.ReactNode; color?: "blue" | "purple" | "green" | "orange" | "red" | "default" }) {
  const map = {
    blue:    "bg-blue-500/10 text-blue-400 border-blue-500/20",
    purple:  "bg-purple-500/10 text-purple-400 border-purple-500/20",
    green:   "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
    orange:  "bg-orange-500/10 text-orange-400 border-orange-500/20",
    red:     "bg-red-500/10 text-red-400 border-red-500/20",
    default: "bg-muted/40 text-muted-foreground border-border",
  }
  return <span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium", map[color])}>{children}</span>
}

// ─── KPI Strip ───────────────────────────────────────────────────────────────

function KPI({ label, value, color = "default" }: { label: string; value: string | number; color?: "blue" | "purple" | "green" | "orange" | "default" }) {
  const val = typeof value === "number" ? fmt(value) : value
  const valColor = {
    blue:    "text-blue-400",
    purple:  "text-purple-400",
    green:   "text-emerald-400",
    orange:  "text-orange-400",
    default: "text-foreground",
  }[color]
  return (
    <div className="flex flex-col gap-0.5 border-r border-border px-3 last:border-r-0 first:pl-0">
      <span className="text-[9px] uppercase tracking-widest text-muted-foreground">{label}</span>
      <span className={cn("text-sm font-bold tabular-nums leading-none", valColor)}>{val}</span>
    </div>
  )
}

// ─── Row ─────────────────────────────────────────────────────────────────────

function Row({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between gap-3 py-[3px]">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className={cn("text-[11px] font-medium", mono && "font-mono text-[10px] text-muted-foreground")}>{value}</span>
    </div>
  )
}

// ─── Expandable Block ─────────────────────────────────────────────────────────

type AccentKey = "blue" | "purple" | "green" | "orange"

function Block({
  icon: Icon, title, sub, accent = "blue", children, open: defaultOpen = false, right,
}: {
  icon: React.ElementType; title: string; sub?: string; accent?: AccentKey
  children?: React.ReactNode; open?: boolean; right?: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  const bar  = { blue: "bg-blue-500", purple: "bg-purple-500", green: "bg-emerald-500", orange: "bg-orange-500" }[accent]
  const ic   = { blue: "text-blue-400", purple: "text-purple-400", green: "text-emerald-400", orange: "text-orange-400" }[accent]

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="group flex w-full items-center gap-2 rounded-md py-1.5 pl-2 pr-1.5 text-left transition-colors hover:bg-muted/20">
          <span className={cn("h-3.5 w-0.5 shrink-0 rounded-full", bar)} />
          <Icon className={cn("h-3 w-3 shrink-0", ic)} />
          <span className="flex-1 min-w-0">
            <span className="text-[11px] font-medium leading-none">{title}</span>
            {sub && <span className="ml-1.5 text-[10px] text-muted-foreground">{sub}</span>}
          </span>
          {right}
          {open
            ? <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground/50" />
            : <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground/30 group-hover:text-muted-foreground/50" />
          }
        </button>
      </CollapsibleTrigger>
      {children && (
        <CollapsibleContent>
          <div className="ml-5 mt-0.5 border-l border-border/50 pb-2 pl-3 space-y-0.5">
            {children}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

// ─── Section Header ───────────────────────────────────────────────────────────

function SectionHeader({ num, label, sub, color }: { num: number; label: string; sub: string; color: AccentKey }) {
  const bg = { blue: "bg-blue-500", purple: "bg-purple-500", green: "bg-emerald-500", orange: "bg-orange-500" }[color]
  return (
    <div className="flex items-center gap-2 pb-1 pt-2">
      <span className={cn("flex h-4 w-4 shrink-0 items-center justify-center rounded-sm text-[9px] font-bold text-white", bg)}>{num}</span>
      <span className="text-[11px] font-semibold uppercase tracking-wider">{label}</span>
      <span className="text-[10px] text-muted-foreground">{sub}</span>
    </div>
  )
}

// ─── Funnel ──────────────────────────────────────────────────────────────────

function Funnel({ stats }: { stats: EngineStats | null }) {
  const stages = [
    { label: "Base",  value: stats?.baseStrategyCount  || 0, max: 8,  color: "bg-purple-500/20 text-purple-400 border-purple-500/30" },
    { label: "Main",  value: stats?.mainStrategyCount  || 0, max: 8,  color: "bg-purple-500/30 text-purple-300 border-purple-500/40" },
    { label: "Real",  value: stats?.realStrategyCount  || 0, max: 8,  color: "bg-emerald-500/20 text-emerald-400 border-emerald-500/30" },
    { label: "Live",  value: stats?.liveStrategyCount  || 0, max: 8,  color: "bg-emerald-500/30 text-emerald-300 border-emerald-500/40" },
  ]
  return (
    <div className="flex items-center gap-1">
      {stages.map((s, i) => (
        <div key={s.label} className="flex items-center gap-1">
          <div className={cn("flex flex-col items-center rounded border px-2.5 py-1 text-center", s.color)}>
            <span className="text-[10px] font-medium leading-none">{s.label}</span>
            <span className="mt-0.5 text-base font-bold tabular-nums leading-none">{s.value}</span>
          </div>
          {i < stages.length - 1 && <ArrowRight className="h-2.5 w-2.5 shrink-0 text-muted-foreground/30" />}
        </div>
      ))}
    </div>
  )
}

// ─── Main System Tab ─────────────────────────────────────────────────────────

function MainSystemTab({ stats }: { stats: EngineStats | null }) {
  const s = stats
  const byType = s?.indicationsByType || {}
  const indCycles = s?.indicationCycleCount || 0
  const strCycles = s?.strategyCycleCount   || 0
  const indTotal  = s?.totalIndicationsCount || 0
  const strTotal  = s?.totalStrategyCount    || 0
  const baseAvgProfitFactor = positiveNumber(
    s?.strategyDetail?.base?.avgProfitFactor,
    s?.stageBase?.avgProfitFactor,
    s?.baseAvgProfitFactor,
    s?.progression?.strategy_base_avg_profit_factor,
  )
  const realAvgPositions = positiveNumber(
    s?.strategyDetail?.real?.avgPosPerSet,
    s?.stageReal?.avgPosPerSet,
    s?.realActivePosAvg,
    s?.openPositions?.real?.activeAvg,
  )

  return (
    <div className="space-y-3">

      {/* KPI row */}
      <div className="flex flex-wrap items-center rounded-md border bg-muted/10 px-3 py-2 gap-y-2">
        <KPI label="Ind Cycles" value={indCycles}  color="blue" />
        <KPI label="Indications" value={indTotal}  color="blue" />
        <KPI label="Str Cycles"  value={strCycles} color="purple" />
        <KPI label="Strategies"  value={strTotal}  color="purple" />
        <KPI label="Positions"   value={s?.positionsCount || 0} color="green" />
        <KPI label="Cycle Rate"  value={indCycles > 0 ? `${(indTotal / indCycles).toFixed(1)}/c` : "—"} />
      </div>

      {/* Funnel */}
      <div className="flex items-center justify-between rounded-md border bg-muted/5 px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Strategy Funnel</span>
        <Funnel stats={s} />
      </div>

      {/* Phase 1 */}
      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5">
          <SectionHeader num={1} label="Initialization" sub="startup · symbol load · prehistoric data" color="blue" />
        </div>
        <div className="px-3 py-1.5 space-y-0.5">
          <Block icon={Database} title="Load Settings" sub="Redis hash → trade interval, timeframe, risk params" accent="blue">
            <Row label="Trade interval"        value="1.0 s (non-overlapping)" />
            <Row label="Position monitor"       value="0.3 s" />
            <Row label="Candle timeframe"       value="1 s OHLCV" />
            <Row label="History range"          value="5 days" />
            <Row label="Concurrency"            value="10 parallel loads" />
            <Row label="Config key" mono value={`settings:trade_engine_state:{connId}`} />
          </Block>
          <Block icon={BarChart3} title="Load Symbols" sub="main symbol list or exchange top-N by volume" accent="blue">
            <Row label="Mode A" value="Configured list + forced symbols" />
            <Row label="Mode B" value="Top N by 24h volume from exchange" />
            <Row label="Storage" mono value="Redis SADD, unique only" />
            <Row label="QuickStart" value="Most volatile 1h symbol per exchange" />
          </Block>
          <Block icon={Database} title="Prehistoric Data Load" sub="parallel OHLCV fetch for all symbols" accent="blue"
            right={<Tag color="blue">Parallel</Tag>}>
            <Row label="Candles per symbol" value="~432,000 (5d × 1s)" />
            <Row label="Storage key" mono value={`prehistoric:{connId}:{symbol}:candles`} />
            <Row label="Completion flag" mono value={`prehistoric:{connId}:{symbol}:completed`} />
            <Row label="Fallback" value="Live candles only (reduced accuracy)" />
          </Block>
          <Block icon={Network} title="Market Data Stream" sub="WebSocket subscription → 1s candle per symbol" accent="blue">
            <Row label="Protocol" value="Exchange WebSocket (kline 1s)" />
            <Row label="Reconnect" value="Exponential backoff, auto-retry" />
            <Row label="Redis emit" mono value={`market_data:{connId}:{symbol}`} />
          </Block>
        </div>
      </div>

      {/* Phase 2 */}
      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5 flex items-center justify-between">
          <SectionHeader num={2} label="Trade Loop" sub="1 s non-overlapping · indication → strategy → position" color="purple" />
          <Tag color="purple">≈{strCycles > 0 ? (strTotal / strCycles).toFixed(0) : "—"} sets/cycle</Tag>
        </div>
        <div className="px-3 py-1.5 space-y-0.5">

          <Block icon={Zap} title="Indication Processing" sub="4 types × 2 directions = 8 signals/symbol/cycle" accent="blue" open>
            {/* per-type mini bars */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 py-1">
              {[
                { k: "direction", label: "Direction", desc: "Reversal — close vs open, 2–30 steps" },
                { k: "move",      label: "Move",      desc: "Momentum — trend follow, 2–30 steps" },
                { k: "active",    label: "Active",    desc: "Breakout — 0.5–2.5% vol threshold" },
                { k: "optimal",   label: "Optimal",   desc: "High-precision multi-filter signal" },
              ].map(t => {
                const cnt = byType[t.k] || 0
                const maxCnt = Math.max(...Object.values(byType).map(Number), 1)
                return (
                  <div key={t.k}>
                    <div className="flex items-center justify-between mb-0.5">
                      <span className="text-[10px] font-medium text-blue-400">{t.label}</span>
                      <span className="text-[10px] font-mono text-muted-foreground">{fmt(cnt)}</span>
                    </div>
                    <Progress value={(cnt / maxCnt) * 100} className="h-0.5 rounded-none [&>div]:bg-blue-500" />
                    <span className="text-[9px] text-muted-foreground/60">{t.desc}</span>
                  </div>
                )
              })}
            </div>
            <Row label="Total session indications" value={<span className="text-blue-400 font-bold">{fmt(indTotal)}</span>} />
            <Row label="Avg per cycle" value={indCycles > 0 ? `${(indTotal / indCycles).toFixed(1)}` : "—"} />
            <Row label="Storage" mono value={`progression:{connId} → indications_*_count`} />
          </Block>

          <Block icon={GitBranch} title="Base Stage" sub="924 combos/set · PF ≥ 0.55 to pass" accent="purple">
            <Row label="Sets per cycle" value={`${s?.baseStrategyCount || 0} / 8`} />
            <Row label="TP levels" value="11 (0.5 % → 5.0 %, step 0.45 %)" />
            <Row label="SL levels" value="21 (0.1 % → 2.0 %, step 0.095 %)" />
            <Row label="Trailing modes" value="4 — OFF / Std / Aggr / Cons" />
            <Row label="Combinations" value="11 × 21 × 4 = 924 per Set" />
            <Row label="Avg profit factor" value={baseAvgProfitFactor !== null ? baseAvgProfitFactor.toFixed(2) : "—"} />
            <Row label="Pass threshold" value="profit_factor ≥ 0.55" />
          </Block>

          <Block icon={Filter} title="Main Stage" sub="consistency filter · PF ≥ 0.65 × 3 consecutive" accent="purple">
            <Row label="Sets this cycle" value={`${s?.mainStrategyCount || 0}`} />
            <Row label="Threshold" value="PF ≥ 0.65" />
            <Row label="Consistency" value="Must pass ≥ 3 consecutive cycles" />
            <Row label="Storage" mono value={`progression:{connId} → strategies_main_total`} />
          </Block>

          <Block icon={Target} title="Real Stage" sub="high-confidence · PF ≥ 1.4 + conf ≥ 0.65" accent="purple">
            <Row label="Sets this cycle" value={`${s?.realStrategyCount || 0}`} />
            <Row label="PF threshold" value="≥ 1.4" />
            <Row label="Confidence" value="≥ 0.65" />
            <Row label="Avg positions" value={realAvgPositions !== null ? realAvgPositions.toFixed(2) : "—"} />
            <Row label="Max drawdown time" value="≤ 960 min (16 h)" />
            <Row label="Live gate" value="is_live_trade=1 + valid credentials" />
          </Block>

          <Block icon={TrendingUp} title="Live Stage" sub="exchange orders · PF ≥ 1.4 + conf ≥ 0.65 + DDT ≤ 2h" accent="green"
            right={<Tag color={s && s.liveStrategyCount > 0 ? "green" : "default"}>{s?.liveStrategyCount || 0} sets</Tag>}>
            <Row label="Sets this cycle" value={<span className={cn("font-bold", (s?.liveStrategyCount || 0) > 0 ? "text-emerald-400" : "text-muted-foreground")}>{s?.liveStrategyCount || 0}</span>} />
            <Row label="PF threshold" value="≥ 1.4 (same as REAL)" />
            <Row label="Confidence" value="≥ 0.65" />
            <Row label="Max drawdown time" value="≤ 120 min (2 h)" />
            <Row label="Max live sets" value="500 (ranked by PF)" />
            <Row label="Execution" value="Market order via exchange connector" />
            <Row label="Guard" value="is_live_trade flag on connection" />
          </Block>

          <Block icon={LineChart} title="Pseudo Positions" sub="virtual tracking — no real capital" accent="green">
            <Row label="Active positions" value={<span className="text-emerald-400 font-bold">{fmt(s?.positionsCount || 0)}</span>} />
            <Row label="Creation filter" value="PF ≥ 0.6 at any stage" />
            <Row label="Set DB capacity" value="250 positions / Set (tunable 50–750)" />
            <Row label="Storage" mono value={`pseudo_positions:{connId}`} />
          </Block>

          <Block icon={Database} title="Logging" sub="async · never blocks trade loop" accent="orange">
            <Row label="Log key" mono value={`engine:logs:{connId}`} />
            <Row label="Format" value="Redis LIST of JSON (LPUSH, capped)" />
            <Row label="Metrics" mono value={`progression:{connId} HASH`} />
          </Block>
        </div>
      </div>

      {/* Phase 3 */}
      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5">
          <SectionHeader num={3} label="Position Management" sub="real orders · 0.3 s monitor · feedback loop" color="green" />
        </div>
        <div className="px-3 py-1.5 space-y-0.5">
          <Block icon={TrendingUp} title="Promote to Real" sub="live-stage.ts → executeLivePosition() → exchange order" accent="green">
            <Row label="Threshold" value="PF ≥ 0.8 over ≥ 5 cycles" />
            <Row label="Gate" value="is_live_trade=1 + credentials valid" />
            <Row label="Order type" value="Market order at fill price" />
            <Row label="Risk" value="Minimal qty + exchange-level TP/SL" />
          </Block>
          <Block icon={Activity} title="Position Monitor (0.3 s)" sub="TP/SL hit · trailing adjust · P&L update" accent="green">
            <Row label="Price source" value="Market data stream (no REST call)" />
            <Row label="Trailing update" value="Re-priced on favorable tick" />
            <Row label="Max real positions" value="Configurable (default 5)" />
            <Row label="Latency" value="&lt; 50 ms" />
          </Block>
          <Block icon={BarChart3} title="Feedback Loop" sub="closed positions update strategy rankings" accent="green">
            <Row label="Metric" value="Realized PF of closed pseudo positions" />
            <Row label="Ranking" value="EMA over last 20 closures" />
            <Row label="Effect" value="Higher-ranked Sets promoted faster" />
          </Block>
        </div>
      </div>
    </div>
  )
}

// ─── Preset Mode Tab ─────────────────────────────────────────────────────────

function PresetModeTab() {
  const indicators = [
    { name: "RSI 14",        desc: "Overbought / oversold" },
    { name: "MACD 12/26/9",  desc: "Momentum divergence" },
    { name: "BB 20,2",       desc: "Volatility breakout" },
    { name: "Parabolic SAR", desc: "Reversal stop" },
    { name: "EMA 9/21/50",   desc: "Trend direction" },
    { name: "Stoch 14,3,3",  desc: "Oscillator" },
    { name: "ADX 14",        desc: "Trend strength" },
    { name: "SMA 50/200",    desc: "Long-term context" },
  ]
  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Preset Mode</span> uses classic technical indicators with confluence filtering.
          Unlike Main System, signals execute directly — no pseudo position stage. Minimum 2 indicators must agree for a trade signal.
        </p>
      </div>

      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5">
          <SectionHeader num={1} label="Indicators" sub="computed on each candle close per symbol" color="blue" />
        </div>
        <div className="px-3 py-1.5">
          <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 py-1">
            {indicators.map(ind => (
              <div key={ind.name} className="flex items-center justify-between py-[3px]">
                <span className="text-[10px] font-medium text-blue-400">{ind.name}</span>
                <span className="text-[10px] text-muted-foreground">{ind.desc}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5">
          <SectionHeader num={2} label="Confluence & Execution" sub="min 2 agree → market order → ATR-based TP/SL" color="purple" />
        </div>
        <div className="px-3 py-1.5 space-y-0.5">
          <Block icon={Filter} title="Confluence Filter" sub="trend-strength indicators weighted higher" accent="purple" open>
            <Row label="Minimum agreement" value="2 of N indicators" />
            <Row label="Signal threshold" value="PF ≥ 0.6 (backtested quality)" />
            <Row label="ADX / EMA weight" value="Higher (trend confirmation)" />
            <Row label="NEUTRAL suppression" value="No signal if no agreement" />
          </Block>
          <Block icon={Target} title="Execution" sub="ATR-based TP/SL · fixed risk % sizing" accent="green">
            <Row label="Order type" value="Market at current price" />
            <Row label="TP" value="1.5× ATR from entry" />
            <Row label="SL" value="1.0× ATR from entry" />
            <Row label="Size" value="Fixed risk % of account" />
          </Block>
          <Block icon={Activity} title="Analytics" sub="P&L every 0.3 s · auto-pause on losses" accent="orange">
            <Row label="Metrics" value="Win rate, avg profit, max DD, Sharpe-like" />
            <Row label="Auto-pause" value="N consecutive losses (configurable)" />
            <Row label="Limitation" value="No adaptive feedback loop" />
          </Block>
        </div>
      </div>
    </div>
  )
}

// ─── Bots Tab ─────────────────────────────────────────────────────────────────

function BotsTab() {
  const bots = [
    {
      icon: Layers, title: "Grid Bot", accent: "blue" as AccentKey,
      sub: "range-bound buy-low / sell-high at fixed grid lines",
      rows: [
        ["Grid lines", "5 – 50 levels"],
        ["Order size", "Capital ÷ levels"],
        ["Profit source", "Grid spacing % per crossing"],
        ["Optimal market", "Sideways / ranging"],
        ["Range break", "Pauses — waits for re-entry"],
      ],
    },
    {
      icon: TrendingUp, title: "DCA Bot", accent: "purple" as AccentKey,
      sub: "accumulate on dips · take profit on recovery",
      rows: [
        ["Entry spacing", "N% price drop from last entry"],
        ["Max safety orders", "5 (configurable)"],
        ["TP", "% above avg entry (all orders)"],
        ["Optimal market", "Downtrend w/ expected recovery"],
        ["Risk note", "Large exposure on sustained drop"],
      ],
    },
    {
      icon: GitBranch, title: "Arbitrage Bot", accent: "orange" as AccentKey,
      sub: "inter-exchange price diff · buy low sell high simultaneously",
      rows: [
        ["Type", "Inter-exchange (e.g. BingX ↔ Bybit)"],
        ["Detection", "Real-time bid/ask spread monitor"],
        ["Min spread", "Fees + slippage + profit margin"],
        ["Latency req.", "Sub-100 ms execution"],
        ["Requirement", "Balance on both exchanges"],
      ],
    },
    {
      icon: Activity, title: "Market Making Bot", accent: "green" as AccentKey,
      sub: "post limit orders at mid ± spread · capture bid-ask",
      rows: [
        ["Spread", "0.05 – 0.5 % (configurable)"],
        ["Refresh", "Every N s or on fill"],
        ["Inventory mgmt", "Adjust quote size by position"],
        ["Optimal market", "Liquid pairs, high volume"],
        ["Risk", "Directional exposure in trends"],
      ],
    },
  ]

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-muted/5 px-3 py-2">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          <span className="font-semibold text-foreground">Trading Bots</span> run continuously with custom configs,
          independent of Main System and Preset Mode. Each bot type has distinct mechanics and risk profiles.
        </p>
      </div>

      <div className="rounded-md border bg-card">
        <div className="border-b px-3 py-1.5">
          <SectionHeader num={1} label="Bot Types" sub="click to expand mechanics & risk" color="blue" />
        </div>
        <div className="px-3 py-1.5 space-y-0.5">
          {bots.map(bot => (
            <Block key={bot.title} icon={bot.icon} title={bot.title} sub={bot.sub} accent={bot.accent}>
              {bot.rows.map(([l, v]) => <Row key={l} label={l} value={v} />)}
            </Block>
          ))}
          <Block icon={Cpu} title="Common Config" sub="shared parameters across all bot types" accent="blue">
            {[
              ["Symbol", "Trading pair, e.g. BTCUSDT"],
              ["Exchange", "Target connection (BingX, Bybit…)"],
              ["Capital", "USDT amount or % of account"],
              ["Leverage", "1× spot – 20× futures"],
              ["Global SL", "% to halt bot on drawdown"],
              ["Global TP", "% session target"],
              ["Auto-restart", "Resume after TP/SL hit"],
            ].map(([l, v]) => <Row key={l} label={l} value={v} />)}
          </Block>
        </div>
      </div>
    </div>
  )
}

// ─── Live Positions Section ───────────────────────────────────────────────────

function LivePositionsSection({ positions }: { positions: LivePosition[] }) {
  const active = positions.filter(p => p.status === "open" || p.status === "pending" || p.status === "partially_filled")
  const simulated = positions.filter(p => p.status === "simulated")
  const all = positions

  if (all.length === 0) return null

  const statusColor = (s: LivePosition["status"]) => {
    if (s === "open" || s === "filled") return "green"
    if (s === "pending" || s === "partially_filled") return "orange"
    if (s === "simulated") return "blue"
    if (s === "error") return "red"
    return "default"
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Activity className="h-3 w-3 text-emerald-400" />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Live Exchange Positions</span>
          {active.length > 0 && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-emerald-500" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {active.length > 0 && <Tag color="green">{active.length} active</Tag>}
          {simulated.length > 0 && <Tag color="blue">{simulated.length} sim</Tag>}
          <Tag color="default">{all.length} total</Tag>
        </div>
      </div>
      <div className="px-3 py-2 space-y-1">
        {all.slice(0, 10).map(pos => (
          <div key={pos.id} className="flex items-center gap-2 rounded border px-2 py-1">
            <Tag color={pos.direction === "long" ? "green" : "red"}>{pos.direction.toUpperCase()}</Tag>
            <span className="text-[10px] font-medium tabular-nums w-24 truncate">{pos.symbol}</span>
            <Tag color={statusColor(pos.status) as any}>{pos.status}</Tag>
            {pos.orderId && (
              <span className="text-[9px] font-mono text-muted-foreground hidden sm:inline truncate max-w-[80px]" title={pos.orderId}>
                #{pos.orderId.slice(0, 8)}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
              qty {pos.executedQuantity > 0 ? pos.executedQuantity.toFixed(4) : pos.quantity.toFixed(4)}
            </span>
            {pos.exchangeData?.unrealizedPnl !== undefined && (
              <span className={cn("text-[10px] font-mono tabular-nums", (pos.exchangeData.unrealizedPnl || 0) >= 0 ? "text-emerald-400" : "text-red-400")}>
                {pos.exchangeData.unrealizedPnl >= 0 ? "+" : ""}{pos.exchangeData.unrealizedPnl.toFixed(2)}
              </span>
            )}
            {pos.exchangeData?.roi !== undefined && (
              <span className={cn("text-[9px] tabular-nums", (pos.exchangeData.roi || 0) >= 0 ? "text-emerald-400/70" : "text-red-400/70")}>
                {pos.exchangeData.roi.toFixed(1)}%
              </span>
            )}
            <span className="text-[9px] text-muted-foreground/50 tabular-nums">
              {new Date(pos.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
        ))}
        {all.length > 10 && (
          <p className="text-[10px] text-muted-foreground text-center pt-1">+{all.length - 10} more positions</p>
        )}
      </div>
    </div>
  )
}

// ─── Queue Card ───────────────────────────────────────────────────────────────

function QueueSection({ queueData }: { queueData: QueueData | null }) {
  if (!queueData) return null
  const q = queueData
  const healthColor = q.workflowHealth === "healthy" ? "green" : q.workflowHealth === "degraded" ? "orange" : "red"

  return (
    <div className="rounded-md border bg-card">
      <div className="flex items-center justify-between border-b px-3 py-1.5">
        <div className="flex items-center gap-1.5">
          <Database className="h-3 w-3 text-muted-foreground" />
          <span className="text-[11px] font-semibold uppercase tracking-wider">Order Queue</span>
        </div>
        <Tag color={healthColor as any}>{q.workflowHealth || "unknown"}</Tag>
      </div>
      <div className="px-3 py-2 space-y-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {[
            { l: "Queue",     v: q.queueSize         },
            { l: "Rate/s",    v: q.processingRate     },
            { l: "Success",   v: `${q.successRate}%`  },
            { l: "Latency",   v: `${q.avgLatency}ms`  },
            { l: "Completed", v: q.completedOrders    },
            { l: "Failed",    v: q.failedOrders       },
          ].map(m => (
            <div key={m.l} className="flex flex-col">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground">{m.l}</span>
              <span className="text-xs font-bold tabular-nums">{m.v}</span>
            </div>
          ))}
        </div>
        {typeof q.processingPressure === "number" && (
          <div className="space-y-0.5">
            <div className="flex justify-between text-[10px] text-muted-foreground">
              <span>Pressure</span><span>{q.processingPressure}%</span>
            </div>
            <Progress value={q.processingPressure} className="h-1" />
          </div>
        )}
        {q.workflow?.length > 0 && (
          <div className="space-y-1 pt-1">
            <span className="text-[9px] uppercase tracking-wider text-muted-foreground">Workflow Phases</span>
            <div className="grid grid-cols-2 gap-1.5">
              {q.workflow.map(p => (
                <div key={p.id} className="flex items-center justify-between rounded border px-2 py-1 gap-2">
                  <div className="min-w-0">
                    <div className="text-[10px] font-medium truncate">{p.label}</div>
                    <div className="text-[9px] text-muted-foreground truncate">{p.detail}</div>
                  </div>
                  <Tag color={p.status === "complete" ? "green" : p.status === "warning" ? "orange" : "default"}>
                    {p.status}
                  </Tag>
                </div>
              ))}
            </div>
          </div>
        )}
        {queueData.focusConnection && (
          <div className="flex items-center gap-2 border-t pt-2 mt-1 text-[10px] text-muted-foreground">
            <Shield className="h-2.5 w-2.5 shrink-0" />
            <span>Focus:</span>
            <span className="font-medium text-foreground">{queueData.focusConnection.name}</span>
            <Tag color="blue">{queueData.focusConnection.exchange.toUpperCase()}</Tag>
            {queueData.focusConnection.liveTradeEnabled && <Tag color="green">Live</Tag>}
            {queueData.progression && (
              <span className="ml-auto">
                {queueData.progression.cyclesCompleted} cycles · {queueData.progression.cycleSuccessRate.toFixed(0)}% ok
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Tab Nav ──────────────────────────────────────────────────────────────────

type Tab = "main" | "preset" | "bots"

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { key: Tab; icon: React.ElementType; label: string }[] = [
    { key: "main",   icon: Activity,  label: "Main System"  },
    { key: "preset", icon: LineChart, label: "Preset Mode"  },
    { key: "bots",   icon: Bot,       label: "Trading Bots" },
  ]
  return (
    <div className="flex items-center gap-0.5 rounded-md border bg-muted/20 p-0.5">
      {tabs.map(t => (
        <button
          key={t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            "flex items-center gap-1.5 rounded px-3 py-1.5 text-[11px] font-medium transition-colors",
            active === t.key
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <t.icon className="h-3 w-3" />
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

function LogisticsContent() {
  const { selectedConnectionId } = useExchange()
  const connId = selectedConnectionId || "bingx-x01"

  const [tab,          setTab]          = useState<Tab>("main")
  const [stats,        setStats]        = useState<EngineStats | null>(null)
  const [queueData,    setQueueData]    = useState<QueueData | null>(null)
  const [livePos,      setLivePos]      = useState<LivePosition[]>([])
  const [lastRefresh,  setLastRefresh]  = useState<Date | null>(null)
  const [refreshing,   setRefreshing]   = useState(false)
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  const loadAll = useCallback(async (silent: boolean = false) => {
    if (!silent) setRefreshing(true)
    try {
      const [statsRes, queueRes, livePosRes] = await Promise.allSettled([
        fetch(`/api/trading/engine-stats?connection_id=${connId}`, { cache: "no-store" }),
        // Forward the connectionId so the queue card focuses on the same
        // exchange connection the sidebar exchange selector has chosen.
        fetch(`/api/logistics/queue?connectionId=${encodeURIComponent(connId)}`, { cache: "no-store" }),
        fetch(`/api/trading/live-positions?connection_id=${connId}`, { cache: "no-store" }),
      ])
      if (statsRes.status === "fulfilled" && statsRes.value.ok)
        setStats(await statsRes.value.json())
      if (queueRes.status === "fulfilled" && queueRes.value.ok)
        setQueueData(await queueRes.value.json())
      if (livePosRes.status === "fulfilled" && livePosRes.value.ok) {
        const d = await livePosRes.value.json()
        setLivePos(Array.isArray(d) ? d : (d?.positions || []))
      }
      setLastRefresh(new Date())
    } catch { /* non-critical */ }
    finally { if (!silent) setRefreshing(false) }
  }, [connId])

  useEffect(() => {
    loadAll()
    clearInterval(pollRef.current)
    pollRef.current = setInterval(() => loadAll(true), 3000)
    return () => clearInterval(pollRef.current)
  }, [loadAll])

  const engineRunning = (stats?.indicationCycleCount || 0) > 0
  const refreshLabel  = lastRefresh ? lastRefresh.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"

  return (
    <div className="flex flex-col flex-1 overflow-auto">
      {/* Top bar */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b bg-background/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <Dot on={engineRunning} />
          <span className="text-xs font-semibold uppercase tracking-wider">Logistics</span>
          <Tag color={engineRunning ? "green" : "default"}>{engineRunning ? "Live" : "Idle"}</Tag>
          <span className="text-[10px] text-muted-foreground hidden sm:inline">{connId}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground hidden sm:inline">Updated {refreshLabel}</span>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => loadAll()} disabled={refreshing}>
            <RefreshCw className={cn("h-3 w-3", refreshing && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Content */}
      <div className="flex flex-col gap-3 p-4">
        {/* Tab bar */}
        <TabBar active={tab} onChange={setTab} />

        {/* Queue section — always visible */}
        <QueueSection queueData={queueData} />

        {/* Live exchange positions — always visible when data exists */}
        <LivePositionsSection positions={livePos} />

        {/* Tab content */}
        {tab === "main"   && <MainSystemTab stats={stats} />}
        {tab === "preset" && <PresetModeTab />}
        {tab === "bots"   && <BotsTab />}
      </div>
    </div>
  )
}

export default function LogisticsPage() {
  return (
    <AuthGuard>
      <LogisticsContent />
    </AuthGuard>
  )
}
