/**
 * Detailed Tracking Module
 * ────────────────────────────────────────────────────────────────────────
 * Provides authoritative read APIs for the dashboard's "Indications" and
 * "Strategies" detail panels.
 *
 * ARCHITECTURE (canonical, matches lib/strategy-coordinator.ts):
 *
 *   ┌──────────┐
 *   │ INDICATIONS (per type, with pseudo-position limit per Set)       │
 *   │   • direction / move / active / active_advanced / optimal / auto │
 *   │   • each indication Set has its own positions (capped by limit)  │
 *   │   • windowed counts: Last 5 / Last 60 min / Active                │
 *   └─────────────┬─────────────────────────────────────────────────────┘
 *                 │ feeds → strategy-coordinator
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ BASE  — INDEPENDENT Sets (one per indication_type × direction)  │
 *   │   • each Base Set has its OWN pseudo-positions (independent)    │
 *   │   • count ≈ 1,000 across symbols (filter: PF >= 1.0)            │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ promote when avgPF >= 1.2 + DDT <= 24h
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ MAIN  — VARIANT Sets per Base (NO new positions; reuse Base's)  │
 *   │   • Default / Trailing / Block / DCA                            │
 *   │   • Block + DCA: validate Base's COMPLETE positions via gates   │
 *   │   • Trailing: per-base (start, stop) trailing matrix expansion  │
 *   │   • Pos-count variants are validated here via axisWindows tag   │
 *   │     (prev 1-12 × last 1-4 × cont 1-8 × pause 1-8 = up to 384)   │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ promote when avgPF >= 1.4 + DDT <= 16h
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ REAL  — ACCUMULATION stage (cumulative across cycles)           │
 *   │   • This is where multiplied/dimensional sets ACCUMULATE        │
 *   │   • per-axis counts: prev / last / cont / pause                 │
 *   │   • per-variant counts: default / block / dca / trailing        │
 *   │   • cumulative entries_count grows across cycles                │
 *   └─────────────┬───────────────────────────────────────────────────┘
 *                 │ rank by avgPF, take top 500
 *                 ▼
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │ LIVE  — TOP 500 Sets, one pseudo-position per Set on exchange   │
 *   └─────────────────────────────────────────────────────────────────┘
 */

import { getRedisClient } from "@/lib/redis-db"

const INDICATION_TYPES = ["direction", "move", "active", "active_advanced", "optimal", "auto"] as const

function aggregateWindowByType(hash: Record<string, string>): Record<string, number> {
  const totals: Record<string, number> = {}
  for (const t of INDICATION_TYPES) totals[t] = 0

  // Current writers use per-symbol fields ("BTCUSDT:direction"). Older
  // production data may still contain plain legacy fields ("direction").
  // When both shapes exist, prefer the per-symbol snapshot and ignore the
  // legacy plain field for that type; otherwise a mixed deployment doubles
  // the count and makes sibling type totals look unstable/identical.
  const hasSymbolField: Record<string, boolean> = {}
  for (const t of INDICATION_TYPES) hasSymbolField[t] = false
  for (const field of Object.keys(hash)) {
    const idx = field.lastIndexOf(":")
    if (idx <= 0) continue
    const type = field.slice(idx + 1)
    if (type in hasSymbolField) hasSymbolField[type] = true
  }

  for (const [field, raw] of Object.entries(hash)) {
    const idx = field.lastIndexOf(":")
    const type = idx > 0 ? field.slice(idx + 1) : field
    if (!(type in totals)) continue
    if (idx <= 0 && hasSymbolField[type]) continue
    totals[type] += Number(raw) || 0
  }

  return totals
}

// ─────────────────────────────────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────────────────────────────────

export interface IndicationTracking {
  // Active right now (the important "asked value")
  active: {
    total: number
    byType: Record<string, number>
  }
  // Evaluated counts over time windows
  evaluatedLast5: {
    total: number
    byType: Record<string, number>
  }
  evaluatedLast60min: {
    total: number
    byType: Record<string, number>
  }
  // Pseudo-position limit per indication Set (settings-driven)
  pseudoPositionLimit: number
  // How many of the indication Sets are currently at limit (capacity-bound)
  setsAtLimit: number
  totalIndicationSets: number
}

export interface StrategyStageTracking {
  base: {
    setsActivelyProcessing: number   // Sets alive this cycle (per-symbol snapshot)
    setsRunningNow: number           // ★ canonical "active": setKey ∈ active_config_keys
    setsWithOpenPositions: number    // Sets currently holding ≥ 1 open pseudo-position
    setsProgressing: number          // Sets in active calculation this cycle
    setsTotal: number                 // total Base Sets (cumulative)
    setsCurrent: number               // Base Sets in last cycle
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    pseudoPositionLimit: number       // configurable; 25 default
    // Variant configuration (sliders)
    variantCountMin: number           // 10 default
    variantCountMax: number           // 50 default
    variantCountStep: number          // 10 default
  }
  main: {
    // Sets evaluated FROM Base (these became Main candidates)
    evaluatedFromBase: number
    setsCreated: number               // current cycle: variants per qualifying Base
    setsTotal: number                 // cumulative across cycles
    setsRunningNow: number           // ★ parentSetKey ∈ active_config_keys (clone-and-filter)
    setsWithOpenPositions: number    // CLONED positions from Base — count of Sets actually holding
    setsProgressing: number          // Sets currently in calculation
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number             // entries ÷ all created Main Sets (overall, not open-only)
    minProfitFactor: number           // gate threshold (e.g. 1.2)
    maxDrawdownTime: number           // gate threshold (e.g. 1440 min)
    // Variant breakdown — Main CLONES Base's positions and strategically
    // adjusts them into new relative Sets (does NOT open new positions).
    // Indexed by variant name ("default" | "trailing" | "block" | "dca")
    variants: Record<string, number>
  }
  real: {
    // ── Accumulation stage ──
    // Multi-dimensional axis expansion accumulates HERE.
    // Real CLONES Main's already-cloned positions and strategically
    // adjusts them across the position-count axis windows.
    setsCurrent: number               // current cycle Real Sets (post filter+sort+cap)
    setsTotal: number                 // cumulative Real Sets across cycles
    setsRunningNow: number           // ★ parent ∈ active_config_keys (alive right now)
    setsWithOpenPositions: number    // alias of setsRunningNow (operator-friendly label)
    setsProgressing: number          // Sets currently in calculation
    evaluatedFromMain: number         // Main Sets evaluated (input to Real)
    avgProfitFactor: number
    avgDrawdownTime: number
    avgPosPerSet: number
    minProfitFactor: number           // 1.4 gate
    maxDrawdownTime: number           // 960 min gate
    /**
     * Operator's 4-perspective Real stats (per spec):
     *   - overall:     cumulative Real Sets ever produced (lifetime)
     *   - accumulated: axis-window accumulation across cycles (∑ axes)
     *   - general:     this cycle (latest snapshot)
     *   - combined:    actively-running RIGHT NOW (= setsRunningNow)
     * The dashboard surfaces all four as a small panel so operators see
     * "lifetime / axis / current / alive" at a glance.
     */
    fourPerspective: {
      overall: number
      accumulated: number
      general: number
      combined: number
    }
    // ── Position-count axis accumulation ──
    // prev (1-12) × last (1-4) × cont (1-8) × pause (1-8) = up to 384
    axisAccumulation: {
      prev: Record<string, number>    // window → count of Sets in that window
      last: Record<string, number>
      cont: Record<string, number>
      pause: Record<string, number>
    }
    // Per-variant cumulative counts at Real (post-filter)
    // Indexed by variant name ("default" | "trailing" | "block" | "dca")
    variantsAccumulated: Record<string, number>
    /**
     * ── Averaged running counts (operator spec) ──────────────────────
     * Averages of the live Real-stage counts sampled over a fixed
     * calculation interval (the interval itself is an internal detail and
     * is NOT surfaced in the UI — only these averaged counts are shown):
     *   - activeSets:    avg number of Real Sets running
     *   - posPerSet:     avg positions (entries) held per running Set
     *   - posOpen:       avg total open positions across running Sets
     *   - samples:       how many samples backed the averages (diagnostic)
     */
    averages: {
      activeSets: number
      posPerSet: number
      posOpen: number
      samples: number
    }
  }
  live: {
    setsActive: number                // currently on exchange with open positions
    setsRunningNow: number           // ★ alias of setsActive (running orders)
    setsWithOpenPositions: number    // alias of setsActive (real exchange orders)
    setsProgressing: number          // Sets being evaluated for live execution
    setsTotal: number                 // cumulative selected/created Live sets
    setsCandidatesTotal: number       // cumulative Live candidates before active model selection
    dispatchCandidates: number        // latest cycle candidates before selection
    dispatchSelectedCount: number     // latest cycle selected active Live sets
    dispatchSuppressedCount: number   // latest cycle candidates not selected for dispatch
    avgProfitFactor: number
    cap: number                       // maxLiveSets, default 500
  }
  /**
   * ── Valid Positions Counts (operator spec) ─────────────────────────
   * "add to statistics and overviews.. Valid Positions Counts ..
   *  Overall, Combined (Accumulated)."
   *
   * Maintained by `lib/pos-history.ts::bumpValidPositions`, fired from
   * `evaluateRealSets` once per Real Set produced.
   *   - overall:  lifetime count of valid Real Sets ever produced
   *   - combined: Sets whose parent Base is currently running (alive)
   *   - bySymbol/byDirection/byType: dimensional breakdowns
   */
  validPositions: {
    overall: number
    combined: number
    bySymbol: Record<string, number>
    byDirection: Record<string, number>
    byType: Record<string, number>
  }
  /**
   * Connection-level prev-pos summary so settings panels and dashboard
   * tiles can render "what's the engine learning right now" without
   * reading raw redis hashes.
   */
  prevPos: {
    count: number
    successRate: number
    profitFactor: number
    avgDDT: number
    /** Operator-tunable activation threshold (default 5). */
    minCount: number
    /** True when current count clears `minCount` and PF blending is active. */
    active: boolean
  }
  /**
   * ── Stage pass-through percentages (operator spec) ──────────────────
   * "Percentages of Sets evals Base, Main, Real Stages." Modeled as the
   * cascade survival rate of the filter pipeline:
   *   - base: 100% (entry point — every evaluated Base Set counts)
   *   - main: Main evaluated / Base evaluated  (how much survived Base→Main)
   *   - real: Real evaluated / Main evaluated  (how much survived Main→Real)
   * Each value is a 0–100 percentage, clamped to [0,100].
   */
  stageEvalPercent: {
    base: number
    main: number
    real: number
  }
}

// ─────────────────────────────────────────────────────────────────────────
// READ APIS
// ─────────────────────────────────────────────────────────────────────────

/**
 * Get indication tracking with windowed counts and active state.
 * Active is the most important "asked value" (not yet expired/closed).
 */
export async function getIndicationTracking(
  connectionId: string,
): Promise<IndicationTracking> {
  const client = getRedisClient()
  const progKey = `progression:${connectionId}`
  const settingsKey = `connection_settings:${connectionId}`

  const [progHash, settingsHash, setActiveHash, setW5Hash, setW60Hash] = await Promise.all([
    client.hgetall(progKey).catch(() => ({})),
    client.hgetall(settingsKey).catch(() => ({})),
    client.hgetall(`indication_sets_active:${connectionId}`).catch(() => ({})),
    client.hgetall(`indication_sets_window:${connectionId}:last5`).catch(() => ({})),
    client.hgetall(`indication_sets_window:${connectionId}:last60min`).catch(() => ({})),
  ])

  const prog = (progHash || {}) as Record<string, string>
  const settings = (settingsHash || {}) as Record<string, string>
  // indication_sets_active:{id} fields are written as "{symbol}:{type}" (e.g. "BTCUSDT:direction").
  // Do not read the raw indications_active:{id} namespace here: raw signal
  // processors and set processors used to share that key in production, which
  // mixed 0/1 raw signal counts with 30+ set-qualified config counts. This
  // endpoint is the set-detail reader, so it uses only indication_sets_*.
  // Aggregate by type across all symbols using lastIndexOf(":") as the split point — same
  // pattern as stats/route.ts so both readers are consistent.
  const active = (setActiveHash || {}) as Record<string, string>

  const types = INDICATION_TYPES
  const byType = aggregateWindowByType(active)
  const totalActive = Object.values(byType).reduce((s, v) => s + v, 0)

  // ── Windowed evaluated counts (Last 5 cycles / Last 60 min) ─────────────
  // Source: indication_sets_window:{id}:last5 / last60min hashes written by
  // the set processor per type. These are intentionally separate from raw
  // indications_window:* hashes so set details cannot be polluted by raw signal
  // counts or legacy mixed deployments.
  const w5 = (setW5Hash || {}) as Record<string, string>
  const w60 = (setW60Hash || {}) as Record<string, string>
  const w5ByType = aggregateWindowByType(w5)
  const w60ByType = aggregateWindowByType(w60)

  const last5ByType: Record<string, number> = {}
  const last60ByType: Record<string, number> = {}
  let last5Total = 0
  let last60Total = 0
  for (const t of types) {
    // Window hash fields may be legacy plain type strings or current
    // "{symbol}:{type}" fields. Aggregate both shapes to keep production
    // counts stable across overlapping/retried cycles.
    const v5  = w5ByType[t] || 0
    const v60 = w60ByType[t] || 0
    // No cumulative fallback here. Detailed indication tracking is a current
    // set-processing view; falling back to all-time progression counters made
    // production "Last 5" and "Last 60" panels show inflated historical totals
    // when no fresh set-window snapshot existed yet.
    last5ByType[t] = v5
    last60ByType[t] = v60
    last5Total  += last5ByType[t]
    last60Total += last60ByType[t]
  }

  // Pseudo position limit per indication Set (default 25)
  const pseudoPositionLimit = Number(settings.indicationPseudoPositionLimit || "25")

  // How many indication Sets are currently at their limit.
  // Derived live: if setsAtLimit was never written, compute from sets_total and
  // active counts as a best-effort proxy.
  const setsAtLimit = Number(prog.indication_sets_at_limit || "0")
  // totalIndicationSets: prefer dedicated counter written by processor/cron,
  // fall back to cumulative indications_count (proxy: total indications ≈ total sets if 1/set).
  const totalIndicationSets = totalActive || last5Total || 0

  return {
    active: { total: totalActive, byType },
    evaluatedLast5: { total: last5Total, byType: last5ByType },
    evaluatedLast60min: { total: last60Total, byType: last60ByType },
    pseudoPositionLimit,
    setsAtLimit,
    totalIndicationSets,
  }
}

/**
 * Get strategy stage tracking. Reflects the canonical pipeline:
 *   Base (independent) → Main (variants per Base) → Real (accumulation) → Live (top 500)
 *
 * Keep this export at module top-level. The deployment syntax verifier asserts
 * it is not nested inside `getIndicationTracking`; this guards against the
 * merge-truncation regression that previously left an unclosed block above.
 */
export async function getStrategyTracking(
  connectionId: string,
): Promise<StrategyStageTracking> {
  const client = getRedisClient()
  const progKey = `progression:${connectionId}`
  const baseDetailKey = `strategy_detail:${connectionId}:base`
  const mainDetailKey = `strategy_detail:${connectionId}:main`
  const realDetailKey = `strategy_detail:${connectionId}:real`
  const settingsKey = `connection_settings:${connectionId}`
  const activeKey = `strategies_active:${connectionId}`

  const [progHash, baseDetail, mainDetail, realDetail, settingsHash, activeHash] =
    await Promise.all([
      client.hgetall(progKey).catch(() => ({})),
      client.hgetall(baseDetailKey).catch(() => ({})),
      client.hgetall(mainDetailKey).catch(() => ({})),
      client.hgetall(realDetailKey).catch(() => ({})),
      client.hgetall(settingsKey).catch(() => ({})),
      client.hgetall(activeKey).catch(() => ({})),
    ])

  const prog = (progHash || {}) as Record<string, string>
  const base = (baseDetail || {}) as Record<string, string>
  const main = (mainDetail || {}) as Record<string, string>
  const real = (realDetail || {}) as Record<string, string>
  const settings = (settingsHash || {}) as Record<string, string>
  const activeStrats = (activeHash || {}) as Record<string, string>

  // Canonical per-stage Max-Drawdown-Time ceilings (the SAME source the
  // engine DDT gate reads in `strategy-coordinator.loadAppPFThresholds`):
  // app-level `maxDrawdownTime{Main,Real,Live}Hours`, stored in hours,
  // displayed here in minutes to match `avgDrawdownTime`. Default 4h. This
  // keeps the dashboard threshold identical to what the engine enforces
  // (the old connection-hash `maxDrawdownTimeMain/Real` keys were never
  // written, so they showed stale defaults that didn't match the gate).
  const { getAppSettings } = await import("@/lib/redis-db")
  const appSettings = (await getAppSettings().catch(() => ({}))) || {}
  const ddtHoursToMin = (raw: unknown, fallbackHours: number): number => {
    const n = Number(raw)
    const h = !Number.isFinite(n) || n <= 0 ? fallbackHours : Math.max(1, Math.min(72, n))
    return h * 60
  }
  // Per-connection overlay: the engine gate now resolves DDT as
  // connection hash → global app setting → default, so the display must do
  // the same to stay identical to what's enforced.
  const resolveDdtMin = (key: string, fallbackHours: number): number => {
    const raw =
      (settings as Record<string, string>)[key] ??
      (appSettings as Record<string, unknown>)[key]
    return ddtHoursToMin(raw, fallbackHours)
  }
  const mainDdtCeilingMin = resolveDdtMin("maxDrawdownTimeMainHours", 4)
  const realDdtCeilingMin = resolveDdtMin("maxDrawdownTimeRealHours", 4)

  // Canonical per-stage min Profit-Factor thresholds — read from the SAME
  // source + key names + defaults the engine gate uses in
  // `strategy-coordinator.loadAppPFThresholds` (`mainProfitFactor` /
  // `realProfitFactor`, connection hash overlaid on global app settings,
  // clamp [0,5], defaults main 1.2 / real 1.2). The old display read
  // `settings.minProfitFactorMain` / `minProfitFactorReal` (legacy keys)
  // which are NEVER written anywhere — so the dashboard PF
  // ceiling permanently diverged from the gate the engine enforced.
  const resolvePF = (key: string, fallback: number): number => {
    // connection hash wins, else global app setting, else default.
    const raw =
      (settings as Record<string, string>)[key] ??
      (appSettings as Record<string, unknown>)[key]
    const n = Number(raw)
    if (!Number.isFinite(n) || n < 0) return fallback
    return Math.max(0, Math.min(5, n))
  }
  const mainPFThreshold = resolvePF("mainProfitFactor", 1.2)
  const realPFThreshold = resolvePF("realProfitFactor", 1.2)

  // Variant breakdowns
  const mainVariants = await readVariantBreakdown(client, connectionId, "main")
  const realVariants = await readVariantBreakdown(client, connectionId, "real")

  // Axis accumulation at Real stage
  const axisAccumulation = await readAxisAccumulation(client, connectionId)

  // ── Valid Positions + Prev-pos rollup ──
  // Both are connection-scoped HASHes maintained by `lib/pos-history.ts`.
  // We resolve them in parallel with the rest of the tracking reads so
  // dashboard refreshes stay one round-trip in the steady state.
  const { getValidPositions, getPosHistoryOverall } = await import(
    "@/lib/pos-history",
  )
  // Backwards-compat: the operator setting key was historically
  // `prevPiMinCount`. The new code-side name is `prevPosMinCount`. We
  // accept either to avoid silently losing the operator's tuning when
  // the rename ships, with the new key taking precedence.
  const csRecord = settings as Record<string, string>
  const prevPosMinCountSetting = Number(
    csRecord.prevPosMinCount || csRecord.prevPiMinCount || "5",
  )
  const prevPosMinCount =
    Number.isFinite(prevPosMinCountSetting) && prevPosMinCountSetting > 0
      ? Math.min(50, Math.floor(prevPosMinCountSetting))
      : 5
  const [validPositions, prevPos] = await Promise.all([
    getValidPositions(connectionId),
    getPosHistoryOverall(connectionId, prevPosMinCount),
  ])

  // Active sets currently processing (counted across symbols)
  let baseActivelyProcessing = 0
  let liveActive = 0
  for (const [k, v] of Object.entries(activeStrats)) {
    if (k.endsWith(":base")) baseActivelyProcessing += Number(v || "0")
    if (k.endsWith(":live")) liveActive += Number(v || "0")
  }

  // Live data: read from `strategy_detail:{conn}:live` for symmetry.
  // NOTE: hgetall returns null (does NOT throw) for missing keys — the
  // .catch alone never fires, so the `|| {}` coercion is required or this
  // crashes with "Cannot read properties of null" on a fresh DB.
  const liveDetailKey = `strategy_detail:${connectionId}:live`
  const liveDetail = ((await client.hgetall(liveDetailKey).catch(() => ({}))) || {}) as Record<string, string>

  // ── Pre-derive Real 4-perspective so the UI doesn't have to ──
  // Overall is cumulative across cycles, accumulated is the axis sum
  // (already pre-computed by the coordinator under `stat_accumulated`,
  // with a graceful fallback to summing `axisAccumulation` here).
  const realOverall    = Number(prog.strategies_real_total || "0")
  const realGeneral    = Number(prog.strategies_real_current || real.created_sets || "0")
  const realCombined   = Number(real.sets_running_now || real.sets_with_open_positions || "0")
  const realAccumulated = (() => {
    const fromCoord = Number(real.stat_accumulated || "")
    if (Number.isFinite(fromCoord) && fromCoord > 0) return fromCoord
    let sum = 0
    for (const axis of ["prev", "last", "cont", "pause"] as const) {
      for (const v of Object.values(axisAccumulation[axis] || {})) sum += Number(v) || 0
    }
    return sum
  })()

  // ── Real averaged running counts ──────────────────────────────────
  // Average the per-cycle Real samples written by the coordinator
  // (`real_samples:{conn}`, a bounded ring of {t, sets, pps, open}) over a
  // fixed calculation interval. The interval is an internal detail; only
  // the resulting averaged counts are surfaced. lrange is O(N) over a
  // ≤600-entry capped list and never blocks.
  const REAL_AVG_INTERVAL_MS = 5 * 60 * 1000
  const realAverages = await (async () => {
    try {
      const raw = (await client
        .lrange(`real_samples:${connectionId}`, 0, -1)
        .catch(() => [])) as string[]
      const cutoff = Date.now() - REAL_AVG_INTERVAL_MS
      let nSets = 0, nPps = 0, nOpen = 0, count = 0
      for (const entry of raw) {
        try {
          const s = JSON.parse(entry) as { t: number; sets: number; pps: number; open: number }
          if (!s || typeof s.t !== "number" || s.t < cutoff) continue
          nSets += Number(s.sets) || 0
          nPps  += Number(s.pps) || 0
          nOpen += Number(s.open) || 0
          count++
        } catch { /* skip malformed sample */ }
      }
      if (count === 0) {
        // No samples in-window: fall back to the latest live snapshot so the
        // tiles show the current values rather than zero on a fresh boot.
        // For posPerSet, use the avg_pos_per_set from the tracking data.
        // For posOpen, calculate it as a percentage: (sets with open / total sets) * 100
        const realSetsWithOpen = Number(real.sets_with_open_positions || "0")
        const realSetsTotal = Number(real.sets_total || "0")
        const posOpenPercent = realSetsTotal > 0 
          ? Math.round((realSetsWithOpen / realSetsTotal) * 10000) / 100
          : 0
        
        return {
          activeSets: realCombined,
          posPerSet: Number(real.avg_pos_per_set || "0"),
          posOpen: posOpenPercent,
          samples: 0,
        }
      }
      return {
        activeSets: Number((nSets / count).toFixed(2)),
        posPerSet: Number((nPps / count).toFixed(2)),
        posOpen: Number((nOpen / count).toFixed(2)),
        samples: count,
      }
    } catch {
      return { activeSets: 0, posPerSet: 0, posOpen: 0, samples: 0 }
    }
  })()

  // ── Stage pass-through percentages (cascade survival rate) ────────
  // Uses the cumulative lifetime counters the coordinator maintains so the
  // ratios are stable instead of oscillating with per-cycle snapshots:
  //   strategies_{stage}_total      = Sets the stage OUTPUT (promoted)
  //   strategies_{stage}_evaluated  = Sets that ENTERED the stage (input)
  // base = 100% (pipeline entry; every Base set that exists passed by definition)
  // main = Main output / Main input (Base→Main survival; expected ~1%)
  // real = Real output / Real evaluated pool (Main inputs + Real fan-out)
  // Each clamped to [0,100].
  // CUMULATIVE FUNNEL (operator spec) — kept identical to the /stats route so
  // both surfaces agree. Main still computes its candidate pool as input +
  // related fan-out. Real stores that unified pool directly in
  // `strategies_real_evaluated`, matching `strategy_detail:*:real.evaluated`.
  const baseOutput    = Number(prog.strategies_base_total            || "0")
  const baseInput     = Number(prog.strategies_base_evaluated        || "0")
  const mainOutput    = Number(prog.strategies_main_total            || "0")
  const mainInput     = Number(prog.strategies_main_evaluated        || "0")
  const mainCreated   = Number(prog.strategies_main_related_created  || "0")
  const realOutput    = Number(prog.strategies_real_total            || "0")
  const realInput     = Number(prog.strategies_real_evaluated        || "0")
  const pct = (num: number, den: number): number =>
    den > 0 ? Math.max(0, Math.min(100, Number(((num / den) * 100).toFixed(1)))) : 0
  // base = evaluated ÷ overall generated (entry point → ~100% when any exist).
  // main = main output ÷ (passed-forward-from-base + additionally-created-at-main).
  // real = real output ÷ Real evaluated pool (already includes Real fan-out).
  const stageEvalPercent = {
    base: pct(baseInput, baseOutput),
    main: pct(mainOutput, mainInput + mainCreated),
    real: pct(realOutput, realInput),
  }

  return {
    base: {
      setsActivelyProcessing: baseActivelyProcessing,
      setsRunningNow: Number(base.sets_running_now || base.sets_with_open_positions || "0"),
      setsWithOpenPositions: Number(base.sets_running_now || base.sets_with_open_positions || "0"),
      setsProgressing: Number(base.sets_progressing || base.created_sets || "0"),
      setsTotal: Number(prog.strategies_base_total || "0"),
      setsCurrent: Number(prog.strategies_base_current || base.created_sets || "0"),
      avgProfitFactor: Number(base.avg_profit_factor || "0"),
      avgDrawdownTime: Number(base.avg_drawdown_time || "0"),
      avgPosPerSet: Number(base.avg_pos_per_set || "0"),
      pseudoPositionLimit: Number(settings.strategyBasePseudoPositionLimit || "25"),
      variantCountMin: Number(settings.strategyVariantCountMin || "10"),
      variantCountMax: Number(settings.strategyVariantCountMax || "50"),
      variantCountStep: Number(settings.strategyVariantCountStep || "10"),
    },
    main: {
      evaluatedFromBase: Number(main.evaluated || "0"),
      setsCreated: Number(prog.strategies_main_current || main.created_sets || "0"),
      setsTotal: Number(prog.strategies_main_total || "0"),
      setsRunningNow: Number(main.sets_running_now || main.sets_with_open_positions || "0"),
      setsWithOpenPositions: Number(main.sets_running_now || main.sets_with_open_positions || "0"),
      setsProgressing: Number(main.sets_progressing || main.created_sets || "0"),
      avgProfitFactor: Number(main.avg_profit_factor || "0"),
      avgDrawdownTime: Number(main.avg_drawdown_time || "0"),
      avgPosPerSet: Number(main.avg_pos_per_set || "0"),
      minProfitFactor: mainPFThreshold,
      maxDrawdownTime: mainDdtCeilingMin,
      variants: mainVariants,
    },
    real: {
      setsCurrent: realGeneral,
      setsTotal: realOverall,
      setsRunningNow: realCombined,
      setsWithOpenPositions: realCombined,
      setsProgressing: Number(real.sets_progressing || real.created_sets || "0"),
      evaluatedFromMain: Number(real.evaluated || "0"),
      avgProfitFactor: Number(real.avg_profit_factor || "0"),
      avgDrawdownTime: Number(real.avg_drawdown_time || "0"),
      avgPosPerSet: Number(real.avg_pos_per_set || "0"),
      minProfitFactor: realPFThreshold,
      maxDrawdownTime: realDdtCeilingMin,
      axisAccumulation,
      variantsAccumulated: realVariants,
      fourPerspective: {
        overall:     realOverall,
        accumulated: realAccumulated,
        general:     realGeneral,
        combined:    realCombined,
      },
      averages: realAverages,
    },
    live: {
      setsActive: liveActive,
      setsRunningNow: Number(liveDetail.sets_running_now || liveDetail.sets_with_open_positions || liveActive),
      setsWithOpenPositions: Number(liveDetail.sets_running_now || liveDetail.sets_with_open_positions || liveActive),
      setsProgressing: Number(liveDetail.sets_progressing || "0"),
      setsTotal: Number(prog.strategies_live_total || "0"),
      setsCandidatesTotal: Number(prog.strategies_live_candidates_total || "0"),
      dispatchCandidates: Number(liveDetail.dispatch_candidates || "0"),
      dispatchSelectedCount: Number(liveDetail.dispatch_selected_count || liveDetail.sets_running_now || liveActive),
      dispatchSuppressedCount: Number(liveDetail.dispatch_suppressed_count || "0"),
      avgProfitFactor: Number(prog.live_avg_profit_factor || "0"),
      cap: Number(settings.maxLiveSets || "500"),
    },
    validPositions,
    prevPos: {
      count: prevPos.count,
      successRate: prevPos.successRate,
      profitFactor: prevPos.profitFactor,
      avgDDT: prevPos.avgDDT,
      minCount: prevPosMinCount,
      active: prevPos.hasSignal,
    },
    stageEvalPercent,
  }
}

// ─────────────────────────────────────────────────────────────────────────
// HELPERS
// ──────────────────────────────────────────────────────────────────────��──

async function readVariantBreakdown(
  client: any,
  connectionId: string,
  stage: "main" | "real",
): Promise<Record<string, number>> {
  const variants = ["default", "trailing", "block", "dca"]
  const result: Record<string, number> = {}
  await Promise.all(
    variants.map(async (v) => {
      const key = `strategy_variant_${stage}:${connectionId}:${v}`
      try {
        const h = (await client.hgetall(key)) || {}
        // created_sets is the cumulative variant Set count
        result[v] = Number((h as any).created_sets || "0")
      } catch {
        result[v] = 0
      }
    }),
  )
  return result as any
}

async function readAxisAccumulation(
  client: any,
  connectionId: string,
): Promise<{
  prev: Record<string, number>
  last: Record<string, number>
  cont: Record<string, number>
  pause: Record<string, number>
}> {
  const axes = ["prev", "last", "cont", "pause"]
  const result: Record<string, Record<string, number>> = {
    prev: {},
    last: {},
    cont: {},
    pause: {},
  }
  await Promise.all(
    axes.map(async (axis) => {
      const key = `strategy_axis_real:${connectionId}:${axis}`
      try {
        const h = (await client.hgetall(key)) || {}
        for (const [window, count] of Object.entries(h)) {
          result[axis][window] = Number(count as string)
        }
      } catch { /* leave empty */ }
    }),
  )
  return result as any
}
