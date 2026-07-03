"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Tabs, TabsContent } from "@/components/ui/tabs"
import { Info } from "lucide-react"
import { StatisticsOverview } from "@/components/settings/statistics-overview"

interface SystemTabProps {
  settings: any
  handleSettingChange: (key: string, value: any) => void
}

export function SystemTab({ settings, handleSettingChange }: SystemTabProps) {
  return (
    <Tabs defaultValue="system" className="space-y-4">
      <TabsContent value="system" className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>System Configuration</CardTitle>
            <CardDescription>Core system settings, database management, and application logs</CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="space-y-4">
              <h3 className="text-lg font-semibold">Database Configuration</h3>
              <p className="text-xs text-muted-foreground">
                The system uses Redis for high-performance in-memory data storage.
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Database Type</Label>
                  <div className="flex items-center gap-3 p-4 border rounded-lg bg-primary/5">
                    <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse"></div>
                    <div>
                      <p className="font-semibold text-lg">Redis</p>
                      <p className="text-xs text-muted-foreground">In-Memory Data Store</p>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <strong>Redis</strong> provides high-performance data storage with millisecond latency, 
                    perfect for real-time trading applications.
                  </p>
                </div>

                <div className="space-y-2">
                  <Label>Connection Status</Label>
                  <div className="p-3 border rounded-lg bg-muted/30">
                    <p className="text-sm">
                      <strong>Mode:</strong> {settings.databaseType === "redis" ? "Persistent Redis" : "In-Memory Fallback"}
                    </p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Configure REDIS_URL environment variable for persistent storage.
                      Without it, data will be stored in-memory and lost on restart.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Position Limits</h3>
              <p className="text-xs text-muted-foreground">Maximum positions per configuration per direction</p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Max Long Positions per Config</Label>
                    <span className="text-sm font-semibold">{settings.maxPositionsLong ?? 1}</span>
                  </div>
                  <Slider
                    value={[settings.maxPositionsLong ?? 1]}
                    onValueChange={(v) => handleSettingChange("maxPositionsLong", v[0])}
                    min={1}
                    max={5}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">Max 1 recommended for independent config processing</p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Max Short Positions per Config</Label>
                    <span className="text-sm font-semibold">{settings.maxPositionsShort ?? 1}</span>
                  </div>
                  <Slider
                    value={[settings.maxPositionsShort ?? 1]}
                    onValueChange={(v) => handleSettingChange("maxPositionsShort", v[0])}
                    min={1}
                    max={5}
                    step={1}
                  />
                  <p className="text-xs text-muted-foreground">Max 1 recommended for independent config processing</p>
                </div>
              </div>

              {/* ── Canonical Per-Direction Cap (cross-section mirror) ──
                  This is the SAME value as Settings → Strategy → Base →
                  "Per Direction Pos Limit". The Base-stage pseudo-position
                  manager (`PseudoPositionManager.getMaxActivePerDirection`)
                  reads only this key, regardless of which UI surface
                  edited it. We mirror it on the System tab so an operator
                  exploring "global system limits" finds it without having
                  to drill into the Strategy tab. Both surfaces write to
                  `maxActiveBasePseudoPositionsPerDirection` — there is no
                  duplicate state. */}
              <div className="space-y-2 pt-2 border-t border-dashed border-border/40">
                <div className="flex items-center justify-between">
                  <Label>Per-Direction Pos Limit (canonical)</Label>
                  <span className="text-sm font-semibold">
                    {settings.maxActiveBasePseudoPositionsPerDirection ?? 1}
                  </span>
                </div>
                <Slider
                  value={[settings.maxActiveBasePseudoPositionsPerDirection ?? 1]}
                  onValueChange={(v) =>
                    handleSettingChange("maxActiveBasePseudoPositionsPerDirection", v[0])
                  }
                  min={1}
                  max={10}
                  step={1}
                />
                <p className="text-xs text-muted-foreground">
                  Caps the number of <strong>active Base-stage pseudo-positions per
                  direction (long / short)</strong> across all symbols. This is the
                  master gate the engine consults before creating a new pseudo
                  position; the per-config sliders above are downstream guards.
                  Default <strong>1</strong> matches the spec; raise to allow concurrent
                  Base evaluations in the same direction.
                </p>
                <p className="text-[11px] text-muted-foreground italic">
                  Mirror of <code>Settings → Strategy → Base → Per Direction Pos Limit</code>.
                  Both surfaces write to <code>maxActiveBasePseudoPositionsPerDirection</code>.
                </p>
              </div>

              {/* ── Strategy pipeline ceilings ──────────────────────────
                  These are the same safety rails consumed by
                  `StrategyCoordinator`: per-Set entry count, Main axis
                  fan-out, Real-stage safety ceiling, operator Real pass-
                  through cap, and Live dispatch cap. Keep them together so
                  an operator can tune the whole Strategies pipeline from
                  Settings → System instead of editing env vars. */}
              <div className="space-y-4 pt-2 border-t border-dashed border-border/40">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold">Strategies Pipeline Ceilings</h4>
                  <p className="text-xs text-muted-foreground">
                    Resource ceilings for Strategy Set creation and live dispatch.
                    Lower values improve production liveness; higher values widen
                    the strategy funnel on larger workers.
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Entries per Strategy Set</Label>
                      <span className="text-sm font-semibold tabular-nums">
                        {(settings.strategyMaxEntriesPerSet ?? 250).toLocaleString()}
                      </span>
                    </div>
                    <Slider
                      value={[settings.strategyMaxEntriesPerSet ?? 250]}
                      onValueChange={(v) => handleSettingChange("strategyMaxEntriesPerSet", v[0])}
                      min={50}
                      max={750}
                      step={50}
                    />
                    <p className="text-xs text-muted-foreground">
                      Maximum config entries packed into each Strategy Set.
                      Default <strong>250</strong>.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Main Axis Sets per Symbol</Label>
                      <span className="text-sm font-semibold tabular-nums">
                        {(settings.strategyMainAxisSetsCeiling ?? 50).toLocaleString()}
                      </span>
                    </div>
                    <Slider
                      value={[settings.strategyMainAxisSetsCeiling ?? 50]}
                      onValueChange={(v) => handleSettingChange("strategyMainAxisSetsCeiling", v[0])}
                      min={10}
                      max={5000}
                      step={10}
                    />
                    <p className="text-xs text-muted-foreground">
                      Per-symbol ceiling for Main-stage position-count axis fan-out.
                      Default <strong>50</strong> in production.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Real Sets Safety Ceiling</Label>
                      <span className="text-sm font-semibold tabular-nums">
                        {(settings.strategyRealSetsSafetyCeiling ?? 100).toLocaleString()}
                      </span>
                    </div>
                    <Slider
                      value={[settings.strategyRealSetsSafetyCeiling ?? 100]}
                      onValueChange={(v) => {
                        handleSettingChange("strategyRealSetsSafetyCeiling", v[0])
                        if ((settings.maxRealSets ?? 100) > v[0]) handleSettingChange("maxRealSets", v[0])
                      }}
                      min={25}
                      max={25000}
                      step={25}
                    />
                    <p className="text-xs text-muted-foreground">
                      Hard memory-safety ceiling for Real-stage Sets.
                      <code>maxRealSets</code> cannot exceed this value.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Max Real Sets per Cycle</Label>
                      <span className="text-sm font-semibold tabular-nums">
                        {(settings.maxRealSets ?? 100).toLocaleString()}
                      </span>
                    </div>
                    <Slider
                      value={[Math.min(settings.maxRealSets ?? 100, settings.strategyRealSetsSafetyCeiling ?? 100)]}
                      onValueChange={(v) => handleSettingChange("maxRealSets", v[0])}
                      min={25}
                      max={settings.strategyRealSetsSafetyCeiling ?? 100}
                      step={25}
                    />
                    <p className="text-xs text-muted-foreground">
                      Operator cap on Real Sets that propagate toward Live after
                      PF/DDT filtering and variant-fair ranking.
                    </p>
                  </div>

                  <div className="space-y-2 md:col-span-2">
                    <div className="flex items-center justify-between">
                      <Label>Live Exchange Dispatch Sets</Label>
                      <span className="text-sm font-semibold tabular-nums">
                        {(settings.strategyLiveSetsCeiling ?? 90).toLocaleString()}
                      </span>
                    </div>
                    <Slider
                      value={[settings.strategyLiveSetsCeiling ?? 90]}
                      onValueChange={(v) => handleSettingChange("strategyLiveSetsCeiling", v[0])}
                      min={1}
                      max={500}
                      step={1}
                    />
                    <p className="text-xs text-muted-foreground">
                      Maximum qualifying Sets considered for live exchange order
                      dispatch per symbol. BingX default <strong>90</strong> leaves
                      room under its open-order limits for SL/TP control orders.
                    </p>
                  </div>
                </div>
              </div>
            </div>

              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-semibold">Database Operation Limits</h3>
                <p className="text-xs text-muted-foreground">
                  Control maximum database write operations to prevent unbounded growth
                </p>

                <div className="space-y-4">
                  {/* Per Second Limit */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Operations per Second</Label>
                      <span className="text-sm font-semibold">
                        {settings.databaseLimitPerSecond === 0
                          ? "Unlimited"
                          : `${(settings.databaseLimitPerSecond / 1000).toFixed(1)}k`}
                      </span>
                    </div>
                    <Slider
                      value={[settings.databaseLimitPerSecond ?? 10000]}
                      onValueChange={(v) => handleSettingChange("databaseLimitPerSecond", v[0])}
                      min={0}
                      max={100000}
                      step={1000}
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 0 for unlimited, or choose a per-second limit (1k - 100k). Default: 10k ops/sec.
                    </p>
                    {settings.databaseLimitPerSecond > 0 && (
                      <div className="p-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-900">
                        <strong>Current Limit:</strong> {(settings.databaseLimitPerSecond / 1000).toFixed(1)}k operations/sec
                      </div>
                    )}
                  </div>

                  {/* Per Minute Limit */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Operations per Minute</Label>
                      <span className="text-sm font-semibold">
                        {settings.databaseLimitPerMinute === 0
                          ? "Unlimited"
                          : `${(settings.databaseLimitPerMinute / 1000).toFixed(0)}k`}
                      </span>
                    </div>
                    <Slider
                      value={[settings.databaseLimitPerMinute ?? 500000]}
                      onValueChange={(v) => handleSettingChange("databaseLimitPerMinute", v[0])}
                      min={0}
                      max={3000000}
                      step={100000}
                    />
                    <p className="text-xs text-muted-foreground">
                      Set to 0 for unlimited operations, or choose a limit (100k - 3M per minute).
                      Default: 500k. Applies to trades, positions, and other write operations.
                    </p>
                    {settings.databaseLimitPerMinute > 0 && (
                      <div className="mt-2 p-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-900">
                        <strong>Current Limit:</strong> {(settings.databaseLimitPerMinute / 1000).toFixed(0)}k operations/min
                      </div>
                    )}
                  </div>
                </div>
              </div>

             <div className="space-y-4 border-t pt-4">
               <h3 className="text-lg font-semibold">Indication Timeout</h3>
               <p className="text-xs text-muted-foreground">Time to wait for valid indication evaluation (100ms - 3000ms)</p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Indication Timeout</Label>
                  <span className="text-sm font-semibold">{settings.indicationTimeoutMs ?? 1000}ms</span>
                </div>
                <Slider
                  value={[settings.indicationTimeoutMs ?? 1000]}
                  onValueChange={(v) => handleSettingChange("indicationTimeoutMs", v[0])}
                  min={100}
                  max={3000}
                  step={100}
                />
                <p className="text-xs text-muted-foreground">
                  After a valid indication evaluation, wait this duration before processing next.
                  Lower values = faster but more CPU. Higher values = more reliable but slower response.
                </p>
              </div>
            </div>

            {/* Prehistoric / historical calc look-back window. Controls how far back
                the engine fetches and processes historical market data during the
                prehistoric phase. 1–50h, step 1, default 8h. */}
            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Historical Calc Range</h3>
              <p className="text-xs text-muted-foreground">
                Look-back window (in hours) for the prehistoric data calculation on
                engine start. Lower values = faster warm-up, higher values = more
                historical context for indications and strategies. Once the calc
                completes, the engine stops spinning on empty cycles and switches
                to adaptive idle backoff (up to 1s) until new data arrives.
              </p>

               <div className="space-y-2">
                 <div className="flex items-center justify-between">
                   <Label>Historical Range</Label>
                   <span className="text-sm font-semibold tabular-nums">
                     {settings.prehistoric_range_hours ?? 8}h
                   </span>
                 </div>
                 <Slider
                   value={[settings.prehistoric_range_hours ?? 8]}
                   onValueChange={(v) => handleSettingChange("prehistoric_range_hours", v[0])}
                   min={1}
                   max={50}
                   step={1}
                 />
                 <div className="flex justify-between text-[10px] text-muted-foreground">
                   <span>1h</span>
                   <span>Default 8h</span>
                   <span>50h</span>
                 </div>

                 {/* New UI control for Prehistoric Progression Timeout */}
                 <div className="space-y-2 pt-2 border-t border-dashed border-border/40">
                   <div className="flex items-center justify-between">
                     <Label>Prehistoric Progression Timeout</Label>
                     <span className="text-sm font-semibold tabular-nums">
                       {settings.prehistoric_progression_timeout_minutes ?? 10} min
                     </span>
                   </div>
                   <p className="text-xs text-muted-foreground">
                     Maximum wall-clock time allowed for the prehistoric progression's per-cycle map operation.
                     If exceeded, the progression cycle will time out and the engine will continue to run (prevents long-hangs).
                     Range: 5–25 minutes. Default: 10 minutes.
                   </p>
                   <Slider
                     value={[settings.prehistoric_progression_timeout_minutes ?? 10]}
                     onValueChange={(v) => handleSettingChange("prehistoric_progression_timeout_minutes", v[0])}
                     min={5}
                     max={25}
                     step={2.5 as any}
                   />
                 </div>
               </div>
            </div>

            {/* Cycle Pause — pause between engine cycles (indication / strategy / realtime).
                Changes take effect within ~10s as the engine refreshes the cached value. */}
            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Engine Cycle Pause</h3>
              <p className="text-xs text-muted-foreground">
                Pause between successive engine cycles (10ms – 200ms). Prevents the
                event loop from starving under heavy workloads and keeps average
                cycle time stable. Default 50ms.
              </p>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label>Cycle Pause</Label>
                  <span className="text-sm font-semibold tabular-nums">
                    {settings.cyclePauseMs ?? 50}ms
                  </span>
                </div>
                <Slider
                  value={[settings.cyclePauseMs ?? 50]}
                  onValueChange={(v) => handleSettingChange("cyclePauseMs", v[0])}
                  min={10}
                  max={200}
                  step={10}
                />
                <div className="flex justify-between text-[10px] text-muted-foreground">
                  <span>10ms</span>
                  <span>Default 50ms</span>
                  <span>200ms</span>
                </div>
                <p className="text-xs text-muted-foreground">
                  Lower values = higher throughput but more CPU pressure.
                  Higher values = lower CPU and more time for other I/O between cycles.
                  Applied to indication, strategy and realtime loops.
                </p>
              </div>
            </div>

            {/* ───────────────────────────── Set Compaction ─────────────────────────────
                Operator-controlled rearrange policy for every Set pool in the
                pipeline (indication-sets, strategy-sets, the Strategy
                Coordinator entry pool).

                The rule (per spec): on reaching `floor × (1 + pct/100)` entries,
                the buffer is compacted back down to `floor` — newest at last
                for chronological pools, highest-PF at top for strategy pools.
                See `lib/sets-compaction.ts` for the runtime implementation.

                Defaults — floor=250, pct=20 — produce the spec's exact
                shape (300 ceiling → trim back to 250, 20% headroom). Per-type
                overrides let the operator tune this for individual pools
                whose entry shape costs more or less to recompute. */}
            <div className="space-y-4 border-t pt-4">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Capacity & Stage Limits</h3>
                <span className="text-xs text-muted-foreground">
                  Symbol fan-out, Set compaction, and stage promotion gates
                </span>
              </div>
              <div className="space-y-4 rounded-lg border p-3 bg-muted/20">
                <div>
                  <h4 className="text-sm font-semibold">Symbol Fan-Out</h4>
                  <p className="text-xs text-muted-foreground">
                    Mirrors Exchange → Symbol Configuration and writes the same canonical settings keys.
                  </p>
                </div>

                <div className="grid md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Symbol Order Type</Label>
                    <Select
                      value={settings.symbolOrderType || "volume24h"}
                      onValueChange={(value) => handleSettingChange("symbolOrderType", value)}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="volume24h">24h Volume (Highest First)</SelectItem>
                        <SelectItem value="marketCap">Market Cap (Largest First)</SelectItem>
                        <SelectItem value="priceChange24h">24h Price Change</SelectItem>
                        <SelectItem value="volatility">Volatility (Most Volatile)</SelectItem>
                        <SelectItem value="trades24h">24h Trades (Most Active)</SelectItem>
                        <SelectItem value="alphabetical">Alphabetical (A-Z)</SelectItem>
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      Canonical key: <code>symbolOrderType</code>.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <Label>Symbol Count</Label>
                      <span className="text-sm font-semibold tabular-nums">{settings.numberOfSymbolsToSelect || 8}</span>
                    </div>
                    <Slider
                      min={2}
                      max={30}
                      step={1}
                      value={[settings.numberOfSymbolsToSelect || 8]}
                      onValueChange={([value]) => handleSettingChange("numberOfSymbolsToSelect", value)}
                    />
                    <p className="text-xs text-muted-foreground">
                      Canonical key: <code>numberOfSymbolsToSelect</code> (the exchange fan-out symbol count).
                    </p>
                  </div>
                </div>

                <div className="grid md:grid-cols-2 gap-4 text-xs">
                  <div className="space-y-2">
                    <Label>Main Symbols</Label>
                    <div className="flex flex-wrap gap-2 rounded border p-2 min-h-10 bg-background">
                      {(settings.mainSymbols || ["BTC", "ETH", "BNB", "XRP", "ADA", "SOL"]).map((symbol: string) => (
                        <span key={symbol} className="px-2 py-1 rounded-full bg-primary/10 text-primary">{symbol}</span>
                      ))}
                    </div>
                    <p className="text-muted-foreground">
                      Edit membership on Exchange; System displays the canonical <code>mainSymbols</code> list.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <Label>Forced Symbols</Label>
                    <div className="flex flex-wrap gap-2 rounded border p-2 min-h-10 bg-background">
                      {(settings.forcedSymbols || ["XRP", "BCH"]).map((symbol: string) => (
                        <span key={symbol} className="px-2 py-1 rounded-full bg-accent text-accent-foreground">{symbol}</span>
                      ))}
                    </div>
                    <p className="text-muted-foreground">
                      Always included via canonical <code>forcedSymbols</code>; edit the list on Exchange.
                    </p>
                  </div>
                </div>
              </div>

              <p className="text-xs text-muted-foreground">
                Buffers grow to <strong>floor × (1 + threshold%)</strong> entries
                before being compacted back to <strong>floor</strong> — newest
                kept at the end. Default 250 / 20% means buffers fill to 300
                then trim to 250 (drops 20%, oldest first for chronological
                pools, lowest-PF first for strategy pools).
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Compaction Floor</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.setCompactionFloor ?? 250}
                    </span>
                  </div>
                  <Slider
                    value={[settings.setCompactionFloor ?? 250]}
                    onValueChange={(v) => handleSettingChange("setCompactionFloor", v[0])}
                    min={50}
                    max={1000}
                    step={10}
                  />
                  <p className="text-xs text-muted-foreground">
                    Post-compaction buffer size (entries kept after rearrange).
                  </p>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Threshold %</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.setCompactionThresholdPct ?? 20}%
                    </span>
                  </div>
                  <Slider
                    value={[settings.setCompactionThresholdPct ?? 20]}
                    onValueChange={(v) => handleSettingChange("setCompactionThresholdPct", v[0])}
                    min={0}
                    max={100}
                    step={5}
                  />
                  <p className="text-xs text-muted-foreground">
                    Headroom above floor before compaction fires. 20% → ceiling
                    = floor × 1.2.
                  </p>
                </div>
              </div>

              {(() => {
                // Show the resolved ceiling so operators can see the effect of
                // their changes without doing the math by hand.
                const f = Number(settings.setCompactionFloor ?? 250)
                const p = Number(settings.setCompactionThresholdPct ?? 20)
                const ceiling = Math.max(f, Math.ceil(f * (1 + Math.max(0, Math.min(500, p)) / 100)))
                return (
                  <div className="flex items-center gap-2 p-3 border rounded-lg bg-muted/30 text-xs">
                    <Info className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <p className="text-muted-foreground">
                      Buffers fill to <strong className="text-foreground">{ceiling}</strong> entries
                      then compact to <strong className="text-foreground">{f}</strong>{" "}
                      ({"drops "}<strong className="text-foreground">{ceiling - f}</strong>{" entries per cycle"}).
                    </p>
                  </div>
                )
              })()}

              {/* Per-type overrides. Each pool reads its own floor first, then
                  falls back to the global floor above. Empty / 0 = use global. */}
              <details className="border rounded-lg group">
                <summary className="flex items-center justify-between cursor-pointer px-3 py-2 text-sm font-medium hover:bg-muted/30">
                  <span>Per-Type Overrides</span>
                  <span className="text-xs text-muted-foreground group-open:hidden">Set 0 = use global</span>
                </summary>
                <div className="p-3 border-t space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Optional per-pool floor overrides. Leave at 0 to inherit the
                    global value. Threshold % is shared across all pools — change
                    it above to affect everyone.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {([
                      { key: "indication.direction", label: "Indication · Direction" },
                      { key: "indication.move",      label: "Indication · Move" },
                      { key: "indication.active",    label: "Indication · Active" },
                      { key: "indication.optimal",   label: "Indication · Optimal" },
                      { key: "indication.active_advanced", label: "Indication · Active Advanced" },
                      { key: "strategy.base",        label: "Strategy · Base" },
                      { key: "strategy.main",        label: "Strategy · Main" },
                      { key: "strategy.real",        label: "Strategy · Real" },
                      { key: "strategy.live",        label: "Strategy · Live" },
                      { key: "coordinator.entries",  label: "Coordinator · Entries" },
                    ] as const).map((row) => {
                      const overrides = settings.setCompactionByType ?? {}
                      const current = Number(overrides?.[row.key]?.floor ?? 0)
                      return (
                        <div key={row.key} className="flex items-center justify-between gap-3 px-2 py-1.5 rounded border bg-card">
                          <Label className="text-xs leading-tight">{row.label}</Label>
                          <input
                            type="number"
                            min={0}
                            max={5000}
                            step={10}
                            value={current}
                            onChange={(e) => {
                              const next = Math.max(0, Math.min(5000, Math.floor(Number(e.target.value) || 0)))
                              const merged = {
                                ...(settings.setCompactionByType || {}),
                                [row.key]: next > 0 ? { floor: next } : undefined,
                              }
                              // Drop undefined keys so the persisted object stays clean.
                              const clean: Record<string, any> = {}
                              for (const [k, v] of Object.entries(merged)) {
                                if (v) clean[k] = v
                              }
                              handleSettingChange("setCompactionByType", clean)
                            }}
                            className="w-24 h-8 px-2 text-xs tabular-nums rounded border bg-background"
                            placeholder="0"
                            aria-label={`${row.label} floor override`}
                          />
                        </div>
                      )
                    })}
                  </div>
                </div>
              </details>

              <div className="space-y-4 rounded-lg border p-3 bg-muted/20">
                <div>
                  <h4 className="text-sm font-semibold">Strategy Stage Thresholds</h4>
                  <p className="text-xs text-muted-foreground">
                    Mirrors Strategy → Base stage promotion gates and writes the same PF, DDT, and min-position keys.
                  </p>
                </div>

                <div className="grid md:grid-cols-4 gap-4">
                  {([
                    { key: "baseProfitFactor", label: "Base PF", value: settings.baseProfitFactor ?? 0.9 },
                    { key: "mainProfitFactor", label: "Main PF", value: settings.mainProfitFactor ?? 1.0 },
                    { key: "realProfitFactor", label: "Real PF", value: settings.realProfitFactor ?? 1.0 },
                    { key: "liveProfitFactor", label: "Live PF", value: settings.liveProfitFactor ?? 1.0 },
                  ] as const).map((row) => (
                    <div key={row.key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{row.label}</Label>
                        <span className="text-sm font-semibold tabular-nums">{Number(row.value).toFixed(1)}</span>
                      </div>
                      <Slider
                        min={0}
                        max={2}
                        step={0.1}
                        value={[row.value]}
                        onValueChange={([value]) => handleSettingChange(row.key, value)}
                      />
                    </div>
                  ))}
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                  {([
                    { key: "maxDrawdownTimeMainHours", label: "Main DDT Ceiling", value: settings.maxDrawdownTimeMainHours ?? 4 },
                    { key: "maxDrawdownTimeRealHours", label: "Real DDT Ceiling", value: settings.maxDrawdownTimeRealHours ?? 4 },
                    { key: "maxDrawdownTimeLiveHours", label: "Live DDT Ceiling", value: settings.maxDrawdownTimeLiveHours ?? 4 },
                  ] as const).map((row) => (
                    <div key={row.key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{row.label}</Label>
                        <span className="text-sm font-semibold tabular-nums">{row.value}h</span>
                      </div>
                      <Slider
                        min={1}
                        max={72}
                        step={1}
                        value={[row.value]}
                        onValueChange={([value]) => handleSettingChange(row.key, value)}
                      />
                    </div>
                  ))}
                </div>

                <div className="grid md:grid-cols-3 gap-4">
                  {([
                    { key: "stageMinPosCountBase", label: "Base → Main Min Positions", value: settings.stageMinPosCountBase ?? 0, defaultText: "Default 15" },
                    { key: "stageMinPosCountMain", label: "Main → Real Min Positions", value: settings.stageMinPosCountMain ?? 0, defaultText: "Default 15" },
                    { key: "stageMinPosCountReal", label: "Real → Live Min Positions", value: settings.stageMinPosCountReal ?? 0, defaultText: "Default 10" },
                  ] as const).map((row) => (
                    <div key={row.key} className="space-y-2">
                      <div className="flex items-center justify-between">
                        <Label>{row.label}</Label>
                        <span className="text-sm font-semibold tabular-nums">{row.value === 0 ? row.defaultText : row.value}</span>
                      </div>
                      <Slider
                        min={0}
                        max={50}
                        step={5}
                        value={[row.value]}
                        onValueChange={([value]) => handleSettingChange(row.key, value)}
                      />
                    </div>
                  ))}
                </div>

                <p className="text-xs text-muted-foreground">
                  Also surfaced in this System tab: <code>maxRealSets</code>, <code>indicationTimeoutMs</code>,
                  indication retention, global <code>setCompactionFloor</code>/<code>setCompactionThresholdPct</code>,
                  indication compaction overrides, and strategy compaction overrides above.
                </p>
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Data Retention Settings</h3>
              <p className="text-xs text-muted-foreground">Configure automatic cleanup of old data</p>

              <div className="grid md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Market Data Retention (Days)</Label>
                  <Select
                    value={String(settings.market_data_retention_days || 30)}
                    onValueChange={(value) => handleSettingChange("market_data_retention_days", Number.parseInt(value))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="7">7 days</SelectItem>
                      <SelectItem value="14">14 days</SelectItem>
                      <SelectItem value="30">30 days</SelectItem>
                      <SelectItem value="60">60 days</SelectItem>
                      <SelectItem value="90">90 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Historical market data older than this will be removed</p>
                </div>

                <div className="space-y-2">
                  <Label>Indication State Retention (Hours)</Label>
                  <Select
                    value={String(settings.indication_state_retention_hours || 48)}
                    onValueChange={(value) =>
                      handleSettingChange("indication_state_retention_hours", Number.parseInt(value))
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="24">24 hours</SelectItem>
                      <SelectItem value="48">48 hours</SelectItem>
                      <SelectItem value="72">72 hours</SelectItem>
                      <SelectItem value="168">7 days</SelectItem>
                    </SelectContent>
                  </Select>
                  <p className="text-xs text-muted-foreground">Old indication states older than this will be removed</p>
                </div>
              </div>
            </div>

            {/* API and Exchange Operation Timeouts */}
            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">API & Exchange Timeouts</h3>
              <p className="text-xs text-muted-foreground">
                Configure timeout limits for exchange API calls and operations. Critical for handling network latency and preventing hanging requests.
              </p>

              <div className="grid md:grid-cols-2 gap-4">
                {/* General API Call Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>API Call Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.apiCallTimeoutMs ?? 20000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.apiCallTimeoutMs ?? 20000]}
                    onValueChange={(v) => handleSettingChange("apiCallTimeoutMs", v[0])}
                    min={5000}
                    max={60000}
                    step={1000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Default timeout for general API calls (5s - 60s). Default: 20s
                  </p>
                </div>

                {/* Order Placement Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Order Placement Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.orderPlacementTimeoutMs ?? 40000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.orderPlacementTimeoutMs ?? 40000]}
                    onValueChange={(v) => handleSettingChange("orderPlacementTimeoutMs", v[0])}
                    min={10000}
                    max={120000}
                    step={5000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for placing orders on exchange (10s - 120s). Default: 40s
                  </p>
                </div>

                {/* Order Status/Fill Detection Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Order Status Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.orderStatusTimeoutMs ?? 20000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.orderStatusTimeoutMs ?? 20000]}
                    onValueChange={(v) => handleSettingChange("orderStatusTimeoutMs", v[0])}
                    min={5000}
                    max={60000}
                    step={1000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for checking order status and fill detection (5s - 60s). Default: 20s
                  </p>
                </div>

                {/* Position Sync Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Position Sync Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.positionSyncTimeoutMs ?? 20000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.positionSyncTimeoutMs ?? 20000]}
                    onValueChange={(v) => handleSettingChange("positionSyncTimeoutMs", v[0])}
                    min={5000}
                    max={60000}
                    step={1000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for syncing positions with exchange (5s - 60s). Default: 20s
                  </p>
                </div>

                {/* Order Cancellation Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Order Cancellation Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.orderCancellationTimeoutMs ?? 15000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.orderCancellationTimeoutMs ?? 15000]}
                    onValueChange={(v) => handleSettingChange("orderCancellationTimeoutMs", v[0])}
                    min={5000}
                    max={60000}
                    step={1000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for canceling orders (5s - 60s). Default: 15s
                  </p>
                </div>

                {/* Balance/Account Query Timeout */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>Account Query Timeout</Label>
                    <span className="text-sm font-semibold tabular-nums">
                      {settings.accountQueryTimeoutMs ?? 15000}ms
                    </span>
                  </div>
                  <Slider
                    value={[settings.accountQueryTimeoutMs ?? 15000]}
                    onValueChange={(v) => handleSettingChange("accountQueryTimeoutMs", v[0])}
                    min={3000}
                    max={45000}
                    step={1000}
                  />
                  <p className="text-xs text-muted-foreground">
                    Timeout for balance and account info queries (3s - 45s). Default: 15s
                  </p>
                </div>
              </div>

              <div className="p-3 border rounded-lg bg-blue-50 text-xs text-blue-900">
                <strong>Note:</strong> Longer timeouts handle high-latency networks but may cause slower failure detection. 
                Shorter timeouts fail faster but may cause false timeouts on congested networks. Adjust based on your exchange's typical response time.
              </div>
            </div>

            <div className="space-y-4 border-t pt-4">
              <h3 className="text-lg font-semibold">Database Statistics</h3>
              <StatisticsOverview settings={settings} />
            </div>
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  )
}
