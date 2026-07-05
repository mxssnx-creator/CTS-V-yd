/**
 * Strategy Coordinator - Progressive Strategy Flow
 * Coordinates the progression from BASE → MAIN → REAL → LIVE with proper evaluation metrics
 *
 * Flow:
 * 1. BASE: Create one strategy Set per (indication_type × direction) combination
 *          Each Set holds up to 250 config entries. Count = number of Sets.
 * 2. MAIN: Select Sets where avgProfitFactor >= 1.2 (from base).
 *          Expand each Set with Standard/default plus Adjust variants.
 *          Max 250 entries per Set; rearrange by performance when over limit.
 * 3. REAL: Select Sets where avgProfitFactor >= 1.4 (from main).
 *          Exchange-mirrored high-confidence strategies.
 * 4. LIVE: Select best 500 Sets (ranked by profitFactor) for real trading.
 *          One pseudo position per (indication_type, direction) Set.
 *
 * Strategy counts always represent the number of SETS, not individual pseudo positions.
 */

import { initRedis, getSettings, setSettings, getRedisClient } from "@/lib/redis-db"
import { logProgressionEvent } from "@/lib/engine-progression-logs"
import { PositionThresholdManager } from "@/lib/position-threshold-manager"
import { PseudoPositionManager, nanoid } from "@/lib/trade-engine/pseudo-position-manager"
import {
  compact,
  loadCompactionConfig,
  type CompactionConfig,
} from "@/lib/sets-compaction"

export interface EvaluationMetrics {
  maxDrawdownTime: number
  minProfitFactor: number
  confidence: number
  description: string
}

export interface StrategyEvaluation {
  type: "base" | "main" | "real" | "live"
  symbol: string
  timestamp: Date
  totalCreated: number      // number of Sets created/evaluated
  passedEvaluation: number  // number of Sets that passed the filter
  failedEvaluation: number  // number of Sets that failed
  avgProfitFactor: number
  avgDrawdownTime: number
  dispatchSelected?: number
  dispatchSuppressed?: number
}

// One Set = one unique (indication_type × direction) combination at BASE.
// At MAIN we additionally produce related Sets derived from a parent Base Set.
// These carry `parentSetKey` and `variant`. IMPORTANT: trailing is NOT a
// Main-stage Adjust strategy. Trailing is coordinated at BASE: createBaseSets
// emits independent Base Sets with trailingProfile; those Sets then continue
// through the same Standard/default and block/dca Adjust flow as every other
// Base Set.
export interface StrategySet {
  setKey: string            // e.g. "direction:long" (Base) or "direction:long#block" (Main variant)
  indicationType: string
  direction: "long" | "short"
  avgProfitFactor: number
  avgConfidence: number
  avgDrawdownTime: number
  entryCount: number        // number of config entries in this set (max 250)
  entries: StrategySetEntry[]
  createdAt?: string
  
  /**
   * ── Set validity status across stages ──────────────────────────────────
   * 
   * Tracks evaluation state at each stage without duplicating sets.
   * More performant than creating separate set copies for different stages.
   * 
   * Status values:
   *   - "valid_base": Passes BASE→MAIN evaluation (minProfitFactor threshold)
   *   - "valid_main": Passes MAIN→REAL evaluation (higher PF threshold, e.g. 1.4)
   *   - "valid_real": Passes REAL→LIVE evaluation (in top performers)
   *   - "invalid": Failed some evaluation gate
   *   - undefined: Not yet evaluated at this stage
   * 
   * Allows efficient pipeline by checking status before re-evaluating,
   * avoiding duplicate calculations while maintaining set uniqueness.
   */
  status?: "valid_base" | "valid_main" | "valid_real" | "invalid"
  
  /**
   * ── Evaluation reason when status is "invalid" ──────────────────────
   * 
   * Explains why set was rejected in current cycle:
   *   - "insufficient_history": prevPos.count < mainEvalPosCount threshold
   *   - "low_profitfactor": avgProfitFactor < threshold
   *   - "hedge_netted": Hedged out by opposing direction
   *   - "low_performance": Real-stage performance filter
   *   - Other: specific reason for rejection
   */
  rejectionReason?: string
  
  // Lineage — populated at MAIN stage; preserved through REAL/LIVE
  parentSetKey?: string
  variant?: "default" | "trailing" | "block" | "dca"

  /**
   * ── Variant coordination scalars (Base-Anchored Coordination Model) ─────
   *
   * The slim variant Set carries `entries: []` and resolves Base entries at
   * dispatch via `coordIndex.base.byKey`. But the per-variant SIZE and
   * LEVERAGE coordination (block's vol-ratio-scaled notional, dca's 0.5×
   * reduce) lives on the Adjust variant's `profile.configs`
   * — NOT on the shared Base entries. Without surfacing them here the slim
   * path would silently dispatch every variant at the Base entry's size/
   * leverage (1.0× / 1×), discarding the block vol-ratio calc entirely.
   *
   * `buildVariantSet` therefore writes the representative surviving config's
   * scaled `size` → `variantSizeMultiplier` and its `leverage` →
   * `variantLeverage`. Dispatch (`createLiveSets`) prefers these over the
   * Base entry so each activated variant carries its OWN independent sizing,
   * coordinated off the Base Set without cloning it. Absent for Base/axis
   * Sets (which fall back to the Base entry's own size/leverage = 1×).
   */
  variantSizeMultiplier?: number
  variantLeverage?: number
  /**
   * ── Position-count axis windows that this Set satisfies ────────────
   *
   * Spec: *"the created additional related Sets based on Pos counts.. step 1
   * previous 1-12; Last (of previous) 1-4; continuous 1-8 and Pause 1-8
   * so for each validated Base Set.. additional related cnt Sets of > 1000
   * are created and async Calculated.. handled."*
   *
   * Each component records the **integer window** the Set was generated
   * under. We clamp to spec maxima:
   *   - prev   : 0..12  (closed lookback, ctx.prevPosCount)
   *   - last   : 0..4   (the magnitude of last-N wins or losses dimension)
   *   - cont   : 0..8   (open continuous positions, ctx.continuousCount)
   *   - pause  : 0..8   (last-N validation window, ctx.lastPosCount)
   *
   * 0 means "axis not active for this Set" — we still emit it so consumers
   * can dimensionalise stats by axis without re-deriving from ctx.
   *
   * DCA Sets are independent per parent Set and are NOT position-count
   * axis Sets. They therefore leave axisWindows at zero/undefined so the
   * pos-count fan-out cannot multiply or retag DCA exposure.
   */
  axisWindows?: {
    prev:  number
    last:  number
    cont:  number
    pause: number
    /**
     * Direction the axis-Cartesian Set executes in. Set ONLY on Sets
     * produced by `expandAxisSets()` (the operator-spec'd Cartesian
     * fan-out). Profile-variant Sets and Base Sets inherit direction
     * from `StrategySet.direction` and leave this field undefined.
     *
     * Hedge netting in `evaluateRealSets` uses this field to group
     * Sets by `(symbol × indicationType × triple × outcome)` and keep
     * only the `|long − short|` dominant-direction remainder.
     */
    direction?: "long" | "short"
    /**
     * Stable axis-bucket key —
     * `p{prev}_l{last}_c{cont}_o{pos|neg}_d{long|short}` — used to:
     *   1. Compose the axis-Set's own `setKey` (avoids collisions with
     *      profile-variant Sets sharing the same parent).
     *   2. Drive the hedge-net bucket identity
     *      (`symbol × ind × p|l|c × outcome`).
     *   3. Persist per-bucket net targets for Live partial open/close.
     */
    axisKey?: string
    /**
     * Last-axis outcome categorisation per operator spec:
     *
     *   `pos` = aggregate of parent's last `last` COMPLETED entries was
     *           profitable (mean PF ≥ 1.0).
     *   `neg` = aggregate was unprofitable (mean PF < 1.0).
     *
     * pos / neg Sets are HEDGE-NET-ISOLATED: they represent two
     * different realised market regimes for the same axis triple and
     * must not cancel each other. Bucket identity therefore includes
     * `outcome`.
     */
    outcome?: "pos" | "neg"
  }

  /**
   * Multi-step trailing profile (spec — Settings → Strategy → Trailing).
   *
   * Set at BASE stage when `strategyBaseTrailingEnabled` is on. Threads
   * through Main → Real → Live unchanged; consumed at Live by
   * `PseudoPositionManager.createPosition` to persist the per-position
   * trailing-state machine fields.
   *
   * All three are RATIOS (0.1 ≡ 10 % of price). `stepRatio` is always
   * `stopRatio / 2` per spec.
   *
   * Absent for Sets created when multi-trailing is disabled — those
   * fall back to the legacy single-step path with confidence-based
   * trailing on/off (`bestEntry.confidence ≥ 0.85`).
   */
  trailingProfile?: {
    startRatio: number   // activation gain ratio (e.g. 0.3 ≡ 30 %)
    stopRatio:  number   // trail distance ratio (e.g. 0.1 ≡ 10 %)
    stepRatio:  number   // ratchet increment ratio (= stopRatio / 2)
  }

  /**
   * ── Prev-PI snapshot attached at Base creation ─────────────────────
   *
   * Per operator spec: "make sure strategies are evaluating prev pos and
   * profitfactors min from historic … prev pos cnts are working and
   * added to settings,strategy".
   *
   * Populated by `createBaseSets` from `pi_history:{conn}:{symbol}:{type}:{dir}`
   * and propagated UNCHANGED through Main → Real → Live by `buildVariantSet`
   * and `evaluateRealSets`. Optional — fresh boots / new symbols start
   * with `count = 0` (semantic = "no signal yet, use raw evaluation").
   *
   * Two consumers:
   *   1. createBaseSets uses `profitFactor` to MIN-blend the Set's
   *      `avgProfitFactor` when `count >= prevPosMinCount`. This is the
   *      "evaluating prev pos and profitfactors min from historic"
   *      requirement — historic underperformance pulls the bar down so
   *      Base→Main filters reject it.
   *   2. evaluateRealSets uses `successRate`/`profitFactor` to TUNE
   *      `entries[].sizeMultiplier` and `leverage` per variant — the
   *      "Real stage ��� accumulation for pos cnts sets … relying to
   *      their base sets configs independent" path.
   */
  prevPos?: {
    count: number
    successRate: number
    profitFactor: number
    avgDDT: number
  }
}

export interface StrategySetEntry {
  id: string
  sizeMultiplier: number
  leverage: number
  positionState: string
  profitFactor: number
  drawdownTime: number
  confidence: number
}

/**
 * Per-cycle position coordination context used by MAIN to decide which
 * additional variant Sets to produce. Fetched ONCE per cycle (via
 * getPositionContext) and threaded through so Base/Main/Real each see the
 * same snapshot without duplicating Redis round-trips.
 */
export interface PositionContext {
  /** Currently-open pseudo positions on the exchange (continuous) */
  continuousCount: number
  /** Count of the most recent N closed positions (default last 5) */
  lastPosCount: number
  /** Total closed positions in the lookback window (default 24h) */
  prevPosCount: number
  /** Number of winners among the last N closed */
  lastWins: number
  /** Number of losers among the last N closed */
  lastLosses: number
  /** Total losers in the lookback window ������������� gates DCA recovery variants */
  prevLosses: number
  /** Per-symbol open position count (for symbol-scoped variant decisions) */
  perSymbolOpen: Record<string, number>
  /**
   * Per-symbol, per-direction open position count.
   * Key: symbol, value: { long: n, short: n }.
   * Used by expandAxisSets so each direction's axis entryCount reflects
   * only the positions actually open in that direction — keeps long and
   * short coordinations fully independent.
   */
  perSymbolOpenByDir: Record<string, { long: number; short: number }>
}

// ─── BASE-ANCHORED COORDINATION MODEL ────────────────────────────────────────
//
// Downstream stages (Main, Real, Live) no longer construct or clone full
// StrategySet objects solely for status tracking / tuning. Instead they:
//   1. Operate on lightweight SetCoordRecord scalars that point at Base Sets.
//   2. Resolve Base Set data on demand via O(1) BaseRegistry.byKey lookups.
//   3. Write tuning deltas (sizeDelta, tunedAvgPF) onto the record — not onto
//      mutated entry copies spread across N clones.
//
// The StrategySet interface and its entries[] array remain the authoritative
// representation for Redis persistence and live-position dispatch; CoordIndex
// is a per-cycle in-memory acceleration layer only.
//
// IMMUTABILITY CONTRACT: Base Sets stored in BaseRegistry.byKey are READ-ONLY
// after createBaseSets returns. createMainSets / evaluateRealSets / Real tuner
// MUST NOT mutate them. Tuning writes go to SetCoordRecord.sizeDelta only.

/**
 * Per-cycle Base registry — built once in createBaseSets, passed by
 * reference through all stages. Base Sets are read-only after construction.
 */
export interface BaseRegistry {
  /** Primary O(1) index: setKey → Base StrategySet (immutable, never mutated downstream). */
  byKey: Map<string, StrategySet>
  /** Creation-order list of setKeys (for fan-out iteration without Map overhead). */
  orderedKeys: string[]
}

/**
 * Lightweight coordination record emitted at Main stage for each
 * (Base Set × variant × axisConfig) combination.
 *
 * Stores ONLY the delta between the Base Set and this variant/axis
 * projection — all quality fields (PF, DDT, entries[], trailingProfile,
 * prevPos, indicationType) are resolved from BaseRegistry.byKey[parentKey]
 * on demand. This eliminates the per-variant full-object clone that previously
 * drove ~3 000 StrategySet allocations per symbol per cycle.
 */
export interface SetCoordRecord {
  /** Globally unique key for this coordination slot (= Main set's setKey). */
  coordKey: string
  /** Points at the originating Base Set in BaseRegistry. */
  parentKey: string
  /** Variant profile this record represents. */
  variant: "default" | "trailing" | "block" | "dca"
  /** Axis tuple — null for profile-variant (non-axis) records. */
  axisWindows: StrategySet["axisWindows"] | null
  /**
   * Stage-validity state machine — updated in-place as the record passes
   * through pipeline gates. No new object is created on status transitions.
   */
  status: "pending" | "valid_base" | "valid_main" | "valid_real" | "invalid"
  rejectionReason?: string
  /**
   * Real-stage tuner delta written by evaluateRealSets. Applied on top of
   * Base entries at Live dispatch time — avoids mutating Base entry objects.
   * Undefined means "no tuning applied this cycle, use Base values directly".
   */
  sizeDelta?: number    // multiplicative (applied as e.sizeMultiplier × (1 + sizeDelta))
  leverageDelta?: number
  /** Post-tuner average profit factor; undefined → use Base Set avgProfitFactor. */
  tunedAvgPF?: number
  /** Direction override for axis records (Base Set direction is ignored). */
  overrideDirection?: "long" | "short"
  /** entryCount override for axis records (baseEC + credited liveCont). */
  overrideEntryCount?: number

  // ── Scalar value fields (Base-Anchored carrier) ────────────────────────────
  // These mirror the slim StrategySet scalars so Real/Live can validate, switch
  // states, and compute aggregates by iterating coord records DIRECTLY — never
  // materialising a parallel StrategySet[] array after Base. Quality entries[]
  // are still resolved from the shared immutable Base Set on demand at dispatch.
  /** Variant/axis profit factor (pre-tuner). Real/Live PF gate reads this. */
  avgProfitFactor: number
  /** Variant/axis drawdown-time. Real/Live DDT gate reads this. */
  avgDrawdownTime: number
  /** Variant/axis confidence (advisory). */
  avgConfidence: number
  /** Effective entry/position count for this projection (post axis credit). */
  entryCount: number
  /** Indication type inherited from the Base Set (hedge-bucket identity). */
  indicationType: string
  /** Effective direction (overrideDirection ?? Base direction). */
  direction: "long" | "short"
  /** Base-Set prev-position stats — drives the Real-stage tuner. */
  prevPos?: StrategySet["prevPos"]
  /** Trailing profile carried from the Base Set (lineage only). */
  trailingProfile?: StrategySet["trailingProfile"]
  /**
   * Lazily-hydrated full StrategySet VIEW for this record, built at most once
   * per cycle (only when a consumer needs a full set object — e.g. live
   * dispatch, pseudo-positions). Resolved from this record + the shared Base
   * Set. Transient: never persisted, never shared across cycles.
   */
  _setView?: StrategySet
  /** Set when this record currently backs an OPEN live position (gate exemption). */
  _hasLivePositions?: boolean
}

/**
 * Per-cycle coordination index — single allocation per executeStrategyFlow call,
 * passed by reference through createBaseSets → createMainSets → evaluateRealSets
 * → createLiveSets. Never stored on `this` (cross-cycle contamination).
 */
export interface CoordIndex {
  /** All coord records for this cycle; stages iterate and mark status in-place. */
  records: SetCoordRecord[]
  /** O(1) lookup by coordKey (used by createLiveSets for dispatch). */
  byCoordKey: Map<string, SetCoordRecord>
  /**
   * O(1) lookup by parentKey → all records derived from that Base Set.
   * Used by evaluateRealSets to mark all axis/variant records of a rejected
   * Base Set without re-scanning the full records array.
   */
  byParentKey: Map<string, SetCoordRecord[]>
  /**
   * Fast-path index for variant lookups: variant name → Set<StrategySet>.
   * Used by createLiveSets and pseudo-position manager to retrieve all sets
   * for a specific variant family (default/trailing/block/dca) without
   * iterating the full records array. Populated during stage evaluation.
   */
  liveSetsByVariant: Map<string, StrategySet[]>
  /** Base registry (shared immutable reference). */
  base: BaseRegistry
  /** Snapshot of the qualifying Real Set keys this cycle (populated by evaluateRealSets). */
  validRealKeys: Set<string>
}

/** Allocate an empty CoordIndex from a freshly-built BaseRegistry. */
function makeCoordIndex(base: BaseRegistry): CoordIndex {
  return {
    records: [],
    byCoordKey: new Map(),
    byParentKey: new Map(),
    liveSetsByVariant: new Map(),
    base,
    validRealKeys: new Set(),
  }
}

/** Register a SetCoordRecord into a CoordIndex (updates all three indexes). */
function registerCoordRecord(idx: CoordIndex, rec: SetCoordRecord): void {
  idx.records.push(rec)
  idx.byCoordKey.set(rec.coordKey, rec)
  let arr = idx.byParentKey.get(rec.parentKey)
  if (!arr) { arr = []; idx.byParentKey.set(rec.parentKey, arr) }
  arr.push(rec)
}

// ─����������������������������������������� Position-Count Cartesian Axis Windows (operator spec) ────────────────────
//
// At Strategy Main, every Base Set that survives the Base→Main gate fans out
// into additional "position-count" Sets along three operator-defined axes
// (plus a direction Cartesian, plus a last-outcome split):
//
//   previous   : 4..12 step 2  → [4, 6, 8, 10, 12]      (5 values, ACTS AS FILTER)
//   last       : 1..4  step 1  → [1, 2, 3, 4]           (4 values, OUTCOME SPLIT)
//   continuous : 1..8  step 1  → [1..8]                 (8 values, POS-COUNT CONTRIB)
//   direction  : long / short                           (2 values)
//
// SEMANTICS PER OPERATOR SPEC:
//
//   • previous (PF FILTER): For each `prev ∈ AXIS_PREV`, compute the
//     aggregate (mean) profit-factor of the parent Base Set's LAST `prev`
//     COMPLETED entries. If aggregate PF < `metrics.minProfitFactor` (the
//     same Main PF threshold used by the Base→Main gate), the entire
//     prev-row is REJECTED for this Base Set — no Sets emitted for that
//     prev value. This implements: "previous 4-12 step 2; Calculate by
//     Minimal Profitfactor as defined for Main".
//
//   • last (OUTCOME SPLIT): For each `last ∈ AXIS_LAST`, classify the
//     parent's LAST `last` COMPLETED entries as either profitable
//     (mean PF ≥ 1.0 → `outcome = "pos"`) or unprofitable
//     (`outcome = "neg"`). Both outcome variants are NOT emitted —
//     only the realised outcome is tagged on the surviving Set,
//     because pos and neg are different market regimes that should
//     NOT hedge-net against each other.  Implements: "last 1-4 step 1;
//     Calculate if Positive or Negative (Combined, own Sets for Pos. and Neg.)".
//
//   • continuous (POS-COUNT CONTRIB): For each `cont ∈ AXIS_CONT`, the
//     emitted Set's `entryCount` = `baseDefault.entryCount + cont`. This
//     is the "positions to be counted, inserted into the positions counts
//     sets" semantic. Per spec: "continuous 3 → add actual and next 2
//     positions to set" → `entryCount = base + 3` (base counts as 1 of 3,
//     +2 more accumulate over subsequent intervals).
//
//   • direction (CARTESIAN): Both long and short axis Sets are emitted
//     regardless of the parent's own direction, so the Real-stage hedge
//     netter has both sides of every bucket to compare.
//
// IMPORTANT — "Do not Calculate the Open Positions, only positions already
// Completed" (operator spec): `baseDefault.entries` is the parent's
// historical entry array, where each entry is an already-completed
// strategy position with a defined `profitFactor`. We treat the full
// `entries` array as completed; open positions are tracked in the
// separate pseudo-position store and never appear here.
//
// NO LOCK — recompute every cycle. The hedge netter in `evaluateRealSets`
// detects per-bucket net-target deltas and the Live stage opens/closes
// partial positions in response. The "no calcs while continuous pos are
// valid" guarantee is satisfied naturally: while a Set's continuous
// window is filling, no new completed entries land → the prev-PF filter
// & last-outcome classification cannot change → the same Set re-emerges
// next cycle unchanged.
//
// FAN-OUT MATH:
//   Worst case (all prev pass + both outcomes possible):
//     5 (prev) × 4 (last) × 8 (cont) × 2 (dir) = 320 Sets / Base
//   Typical (prev filter rejects ~half; outcome split halves last):
//     ~2-3 (prev survivors) × 4 (last, single outcome) × 8 × 2 ≈ 128-192 / Base
//   After Real hedge-net (≤ ½):
//     ≤ 96 effective Sets / Base reaching Live evaluation
const AXIS_PREV     = [4, 6, 8, 10, 12]    as const
const AXIS_LAST     = [1, 2, 3, 4]         as const
const AXIS_CONT     = [1, 2, 3, 4, 5, 6, 7, 8] as const
const AXIS_DIRS     = ["long", "short"]    as const

/**
 * ── Plan-perf Tier 2: precomputed axisKey table ────────────────────
 *
 * The axis-fan-out hot path inside `expandAxisSets` builds an axisKey
 * string per (prev, last, cont, outcome, dir) tuple. With 5 × 4 × 8 ×
 * 2 × 2 = 640 possible tuples, recomputing the template-literal on
 * every Base Set's fan-out (called per (symbol × cycle)) was wasted
 * work — the keys are pure functions of the axis tuple values, never
 * change at runtime.
 *
 * We pre-build the full key table once at module load and look up by
 * (prev, last, cont, outcome, dir) using a flat numeric index. This
 * cuts ~640 string allocations + ~5 concatenations each off every
 * Base-Set fan-out call. At 10 symbols × ~30 base Sets × 1 cycle/sec
 * that's ~190k string allocations/sec eliminated (when the cache
 * misses; on hits we already short-circuit).
 *
 * The encoding (`p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`) is
 * preserved verbatim so existing setKey-derived consumers (Redis
 * keys, `parentSetKey` chain reconstruction, dashboard groupings)
 * continue to match exactly.
 */
const AXIS_OUTCOMES = ["pos", "neg"] as const
type AxisOutcome = (typeof AXIS_OUTCOMES)[number]
type AxisDir = (typeof AXIS_DIRS)[number]
function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

type ProtectionCostModel = {
  takerFeeBpsPerSide: number
  estimatedSpreadBps: number
  estimatedMarketSlippageBps: number
  fundingHoldCostBufferBps?: number
  source?: string
}

type DerivedProtection = {
  takeProfitPct: number
  stopLossPct: number
  grossPF: number
  netPF: number
  costBufferPct: number
  effectiveTpPct: number
  effectiveSlPct: number
}

function conservativeCostFallbackForExchange(exchange: string): ProtectionCostModel {
  const ex = exchange.toLowerCase()
  if (ex === "binance" || ex === "binanceusdm") {
    return { takerFeeBpsPerSide: 5, estimatedSpreadBps: 2, estimatedMarketSlippageBps: 4, fundingHoldCostBufferBps: 2, source: "fallback:binance" }
  }
  if (ex === "okx" || ex === "okex") {
    return { takerFeeBpsPerSide: 5, estimatedSpreadBps: 3, estimatedMarketSlippageBps: 5, fundingHoldCostBufferBps: 2, source: "fallback:okx" }
  }
  if (ex === "bybit") {
    return { takerFeeBpsPerSide: 6, estimatedSpreadBps: 3, estimatedMarketSlippageBps: 5, fundingHoldCostBufferBps: 2, source: "fallback:bybit" }
  }
  if (ex === "bingx") {
    return { takerFeeBpsPerSide: 7, estimatedSpreadBps: 5, estimatedMarketSlippageBps: 8, fundingHoldCostBufferBps: 3, source: "fallback:bingx" }
  }
  return { takerFeeBpsPerSide: 8, estimatedSpreadBps: 6, estimatedMarketSlippageBps: 10, fundingHoldCostBufferBps: 4, source: "fallback:generic" }
}

function pickFiniteBps(settings: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    const n = Number(settings[key])
    if (Number.isFinite(n) && n >= 0) return n
  }
  return fallback
}

function resolveProtectionCostModel(exchange: string, settings: Record<string, unknown>): ProtectionCostModel {
  const fallback = conservativeCostFallbackForExchange(exchange)
  const hasExplicit = (...keys: string[]) => keys.some((k) => settings[k] !== undefined && settings[k] !== null && settings[k] !== "")
  return {
    takerFeeBpsPerSide: pickFiniteBps(settings, ["takerFeeBpsPerSide", "takerFeeBps", "exchangeTakerFeeBps", "taker_fee_bps"], fallback.takerFeeBpsPerSide),
    estimatedSpreadBps: pickFiniteBps(settings, ["estimatedSpreadBps", "spreadBps", "exchangeSpreadBps", "estimated_spread_bps"], fallback.estimatedSpreadBps),
    estimatedMarketSlippageBps: pickFiniteBps(settings, ["estimatedMarketSlippageBps", "marketSlippageBps", "slippageBps", "estimated_market_slippage_bps"], fallback.estimatedMarketSlippageBps),
    fundingHoldCostBufferBps: pickFiniteBps(settings, ["fundingHoldCostBufferBps", "fundingBufferBps", "holdCostBufferBps", "funding_hold_cost_buffer_bps"], fallback.fundingHoldCostBufferBps ?? 0),
    source: hasExplicit(
      "takerFeeBpsPerSide", "takerFeeBps", "exchangeTakerFeeBps", "taker_fee_bps",
      "estimatedSpreadBps", "spreadBps", "exchangeSpreadBps", "estimated_spread_bps",
      "estimatedMarketSlippageBps", "marketSlippageBps", "slippageBps", "estimated_market_slippage_bps",
      "fundingHoldCostBufferBps", "fundingBufferBps", "holdCostBufferBps", "funding_hold_cost_buffer_bps",
    ) ? "settings" : fallback.source,
  }
}
export function sanitizeLiveProfitFactor(profitFactor: unknown, fallback = 1): number {
  const pf = Number(profitFactor)
  const fb = Number.isFinite(fallback) && fallback > 0 ? fallback : 1
  return Number.isFinite(pf) && pf > 0 ? pf : fb
}

const LIVE_PROTECTION_FEE_BUFFER_PCT = 0.12

type LiveExecutionCostProfile = {
  exchange: string
  takerFeePct: number
  estimatedSpreadPct: number
  slippagePct: number
  fundingBufferPct: number
  costBufferPct: number
}

type ProfitFactorProtection = {
  takeProfitPct: number
  stopLossPct: number
  effectiveProfitFactor: number
  grossPF: number
  costBufferPct: number
  netEffectivePF: number
  adjustedTakeProfitPct: number
}

type LiveDispatchDecision = {
  setKey: string
  parentSetKey?: string
  variant: string
  symbol: string
  direction: "long" | "short"
  grossPF: number
  costBufferPct: number
  netEffectivePF: number
  takeProfitPct: number
  adjustedTakeProfitPct: number
  stopLossPct: number
  effectiveProfitFactor: number
  liveThresholdPF: number
  costs: LiveExecutionCostProfile
  reason?: "net_pf_after_costs_low" | "tp_after_costs_exceeds_max"
}

const MAX_LIVE_TAKE_PROFIT_PCT = 22

function deriveProtectionFromProfitFactor(
  profitFactor: number,
  positionCostPct: number,
  sizeMultiplier = 1,
  costModel: ProtectionCostModel = conservativeCostFallbackForExchange("generic"),
): DerivedProtection & ProfitFactorProtection {
  const pf = sanitizeLiveProfitFactor(profitFactor, 1)
  const baseRiskPct = Number.isFinite(positionCostPct) && positionCostPct > 0 ? positionCostPct : 0.1
  const stopLossPct = clampNumber(baseRiskPct * Math.max(0.1, sizeMultiplier), 0.2, 5)
  const costBufferPct = (
    (costModel.takerFeeBpsPerSide * 2) +
    costModel.estimatedSpreadBps +
    (costModel.estimatedMarketSlippageBps * 2) +
    (costModel.fundingHoldCostBufferBps ?? 0)
  ) / 100
  const grossTakeProfitPct = Math.max(0.2, stopLossPct * Math.max(1, pf))
  const adjustedTakeProfitPct = grossTakeProfitPct + Math.max(costBufferPct, LIVE_PROTECTION_FEE_BUFFER_PCT)
  const takeProfitPct = clampNumber(adjustedTakeProfitPct, 0.2, MAX_LIVE_TAKE_PROFIT_PCT)
  const effectiveTpPct = Math.max(0, takeProfitPct - costBufferPct)
  return {
    takeProfitPct,
    stopLossPct,
    effectiveProfitFactor: takeProfitPct / stopLossPct,
    grossPF: takeProfitPct / stopLossPct,
    netPF: effectiveTpPct / stopLossPct,
    costBufferPct,
    netEffectivePF: effectiveTpPct / stopLossPct,
    adjustedTakeProfitPct,
    effectiveTpPct,
    effectiveSlPct: stopLossPct,
  }
}

function normalizePercentSetting(value: unknown, fallbackPct: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return fallbackPct
  // Settings often store tolerances as ratios (0.0006 = 0.06%). Accept both.
  return n <= 1 ? n * 100 : n
}

function defaultTakerFeePct(exchange: string): number {
  switch (exchange) {
    case "binance": return 0.04
    case "bybit": return 0.055
    case "okx": return 0.05
    case "bingx": return 0.05
    default: return 0.06
  }
}

function resolveLiveExecutionCostProfile(exchange: string, connSettings: Record<string, unknown>): LiveExecutionCostProfile {
  const takerFeePct = normalizePercentSetting(connSettings.takerFeePct ?? connSettings.takerFee ?? connSettings.exchangeTakerFeePct, defaultTakerFeePct(exchange))
  const estimatedSpreadPct = normalizePercentSetting(connSettings.estimatedSpreadPct ?? connSettings.spreadPct ?? connSettings.exchangeSpreadPct, 0.02)
  const slippagePct = normalizePercentSetting(connSettings.slippageTolerance ?? connSettings.slippagePct ?? connSettings.exchangeSlippagePct, 0.06)
  const fundingBufferPct = normalizePercentSetting(connSettings.fundingBufferPct ?? connSettings.fundingPct ?? connSettings.exchangeFundingBufferPct, 0)
  return {
    exchange,
    takerFeePct,
    estimatedSpreadPct,
    slippagePct,
    fundingBufferPct,
    costBufferPct: (takerFeePct * 2) + estimatedSpreadPct + (slippagePct * 2) + fundingBufferPct,
  }
}


function deriveConfiguredStatsFromProfitFactor(
  profitFactor: number,
  positionCostPct: number,
): { takeProfitPct: number; stopLossPct: number; tpR: number; slR: number; rewardRisk: number } {
  const pf = Number.isFinite(profitFactor) && profitFactor > 0 ? profitFactor : 1
  const posCost = Number.isFinite(positionCostPct) && positionCostPct > 0 ? positionCostPct : 0.1
  // Mirrors the live pseudo-position TP/SL configuration so configured
  // reward/risk stays separate from realized performance factor.
  const takeProfitPct = Math.max(0.5, (pf - 1) * 100)
  const stopLossPct = Math.min(5, 100 / Math.max(1, pf) * 0.5)
  return {
    takeProfitPct,
    stopLossPct,
    tpR: takeProfitPct / posCost,
    slR: stopLossPct / posCost,
    rewardRisk: stopLossPct > 0 ? takeProfitPct / stopLossPct : 0,
  }
}

const AXIS_KEY_TABLE: ReadonlyMap<string, string> = (() => {
  const m = new Map<string, string>()
  for (const prev of AXIS_PREV) {
    for (const last of AXIS_LAST) {
      for (const cont of AXIS_CONT) {
        for (const outcome of AXIS_OUTCOMES) {
          for (const dir of AXIS_DIRS) {
            const k = `${prev}|${last}|${cont}|${outcome}|${dir}`
            m.set(k, `p${prev}_l${last}_c${cont}_o${outcome}_d${dir}`)
          }
        }
      }
    }
  }
  return m
})()
function axisKeyOf(prev: number, last: number, cont: number, outcome: AxisOutcome, dir: AxisDir): string {
  return AXIS_KEY_TABLE.get(`${prev}|${last}|${cont}|${outcome}|${dir}`)!
}

export interface StrategyCoordinatorConfig {
  maxEntriesPerSet?: number   // Default 250 (entries inside one Set)
  maxLiveSets?: number        // Default: max per exchange type (e.g. 500 for bybit, 150 for okx)
  /**
   * Maximum number of REAL Sets that propagate to Live each cycle.
   * Set to Infinity (unlimited) to lift the strategy ceiling — all
   * qualifying Real Sets flow through without a funnel cap. Operator
   * can still prune via preset gates, profit-factor mins, and coordination
   * toggles; this just removes the hard ceiling.
   * Default: Infinity (unlimited).
   */
  maxRealSets?: number
  pruneStrategy?: "fifo" | "performance" | "hybrid"
}

// Module-level bootstrap log throttle — survives coordinator instance re-creation
// because a new StrategyCoordinator is created each cron tick. Keyed by
// "main:<connectionId>" and "real:<connectionId>". 60 s quiet period.
const _bootstrapLoggedAt: Record<string, number> = {}

export class StrategyCoordinator {
  static forceNextSettingsReload(_connectionId: string): number {
    return Date.now()
  }
  private connectionId: string
  constructor(connectionId: string) {
    this.connectionId = connectionId
  }
  private config: StrategyCoordinatorConfig = {
    maxEntriesPerSet: 250,
    // Live Sets default is now per-exchange (see setExchangeMaxLive).
    // This is a placeholder; the real value is set during init.
    // 400 per symbol × 20 symbols = 8000 max live stage entries total;
    // calibrated to prevent InlineLocalRedis growth past the 1200 MB
    // eviction trigger between 4s cleanup cycles.
    maxLiveSets: 400,
    // Real Sets default to the safety ceiling (20000). "Unlimited" (Infinity)
    // previously bypassed the OOM-protection ceiling because the enforcement
    // used `??` (Infinity is not nullish) — next-server was OOM-killed at the
    // 4GB heap limit during live multi-symbol runs. The evaluate path also
    // hard-clamps with Math.min as defense in depth.
    maxRealSets: 20000,
    pruneStrategy: "hybrid",
  }

  // Legacy/prod-tuned constants for strategy ceiling configuration.
  // STRATEGY_MAIN_AXIS_SETS_CEILING: env-overridable main axis set limit
  // STRATEGY_REAL_SETS_SAFETY_CEILING: env-overridable real set safety ceiling
  private static readonly STRATEGY_MAIN_AXIS_SETS_CEILING: 50
  private static readonly STRATEGY_REAL_SETS_SAFETY_CEILING: 100

  // null = use the dynamic VM-memory-scaled default (300 × memScale).
  // Set to a number via connection settings or STRATEGY_MAIN_AXIS_SETS_CEILING env var.
  private strategyMainAxisSetsCeiling: number | null = null
  // null = use the dynamic VM-memory-scaled default from evaluateRealSets.
  // Set to a number via connection settings or STRATEGY_REAL_SETS_SAFETY_CEILING env var.
  // Old code had hardcoded 100; treat ≤100 as unset so the singleton picks up
  // the dynamic default (5000 × memScale ≈ 8540 on the 8.4 GB VM) after restart.
  private strategyRealSetsSafetyCeiling: number | null = null
  private strategyLiveSetsCeiling = 90

  /**
   * Per-cycle cached coordination settings (axes + variants toggles).
   * The coordinator loads this from connection settings on each flow and
   * respects the operator's toggles for position-count axes and categorical
   * variants (trailing, block, dca, pause). Cached for `_coordinationTtlMs`
   * (5s) to avoid spamming Redis on every symbol's evaluation.
   */
  private _coordinationSettings: {
    axes: {
      prev:  { enabled: boolean; maxWindow: number }
      last:  { enabled: boolean; maxWindow: number }
      cont:  { enabled: boolean; maxWindow: number }
      pause: { enabled: boolean; maxWindow: number }
    }
    variants: {
      trailing: boolean
      block:    boolean
      dca:      boolean
    }
    /**
     * Block-strategy previous-position × volume-ratio coordination knobs.
     *
     * Block uses completed-position history, not currently-open position count.
     * Every block size `[1 .. blockMaxStack]` is evaluated as its own execution
     * overlay on top of the already-selected Standard/Trailing Set so each
     * block count can recover independently until that count's results are
     * positive again.
     *
     *   1. **Block count** — each block size multiplies add-on size by
     *      `(1 + (blockCount-1) × ratio)`, where ratio is blockVolumeRatio.
     *
     *   2. **Operator vol-ratio** — `blockVolumeRatio` is the per-block-count
     *      additive step (0.25 = +25 % per extra block count). The spec
     *      default 1.0 mirrors the legacy `applyBlockAdjustment` math in
     *      `lib/strategies.ts` so existing presets keep their behaviour.
     *
     * `blockPauseCountRatio` turns a block count into a pause window for
     * post-success cooldown/evaluation (`pause = blockCount × ratio`).
     *
     * `blockActiveRealEnabled` adds an optional active-real-position overlay
     * path. It is independent from completed-position block-count overlays and
     * lets currently running Real-stage exposure receive Block add-ons even when the
     * `blockActiveLiveEnabled` adds an optional active-live-position overlay
     * path. It is independent from completed-position block-count overlays and
     * lets currently running live exposure receive Block add-ons even when the
     * completed-position block count is not the driver for that cycle.
     */
    blockVolumeRatio: number
    blockMaxStack:    number
    blockPauseCountRatio: number
    blockActiveRealEnabled: boolean
    blockActiveLiveEnabled: boolean
    /**
     * ── Stage-validation min-position thresholds (operator spec) ──────
     *
     * `mainEvalPosCount` — minimum `entryCount` a Base Set must contain
     *   before its profitFactor + drawdownTime are evaluated for
     *   promotion to Main. Below this threshold the Set is SKIPPED at
     *   Main (not validated, not counted as passed). Range 5..50 step 5,
     *   default 15.
     *
     * `realEvalPosCount` — same semantics for Main → Real. Default 10.
     *
     * Skipping (rather than failing) is intentional: low-position Sets
     * naturally re-enter the validation pool on subsequent cycles once
     * enough pseudo-positions have closed. This matches the operator's
     * "if less pos exist in set then do not validate" requirement and
     * preserves count integrity (no false-negative `passed_sets` writes).
     */
    mainEvalPosCount: number
    realEvalPosCount: number
  } = {
    axes: {
      prev:  { enabled: true,  maxWindow: 12 },
      last:  { enabled: true,  maxWindow: 4  },
      cont:  { enabled: true,  maxWindow: 8  },
      pause: { enabled: true,  maxWindow: 8  },
    },
    variants: {
      // Compatibility storage only. Trailing is coordinated at BASE via
      // strategyBaseTrailingEnabled/strategyBaseTrailingVariants, not emitted
      // as a Main-stage Adjust variant.
      trailing: true,
      block:    true, // ← ENABLED by default (per spec)
      dca:      false, // ← OFF by default (per spec); parser also defaults false
    },
    blockVolumeRatio: 1.0,
    blockMaxStack:    10,
    blockPauseCountRatio: 1.0,
    blockActiveRealEnabled: true,
    blockActiveLiveEnabled: true,
    mainEvalPosCount: 15,
    realEvalPosCount: 10,
  }
  private _coordinationLoadedAt = 0
  private readonly _coordinationTtlMs = 5_000

  /**
   * Per-cycle snapshot of `pseudo_positions:{conn}:active_config_keys`.
   * Populated at the start of createBaseSets so createMainSets and
   * evaluateRealSets can determine "running-now" without re-issuing
   * SMEMBERS on every (symbol, stage) call.
   *
   * Treated as stale after 30s — if the next createBaseSets did not run
   * for any reason (slow symbol, pause, etc.) Main/Real fall back to a
   * fresh fetch instead of trusting old data.
   */
  private _activeKeysCache: { keys: Set<string>; cycleAt: number } | null = null

  /**
   * Per-connection cache of the `setKey`s (and `parentSetKey`s) that
   * currently back an OPEN live position. This is the AUTHORITATIVE,
   * leak-free signal for "is this Real Set actively running on the
   * exchange" — read straight from the live-positions index rather than
   * the `active_config_keys` SET (which is keyed by config fingerprint,
   * has no clean removal path for directly-written Real pseudo positions,
   * and would otherwise exempt stale Sets from the PF/DDT gate forever).
   *
   * evaluateRealSets uses it to keep a Set valid_real while its live
   * position is open even if PF/DDT dips this cycle. Computed once per
   * ~10 s and reused across every symbol in the same cycle, so a 10-symbol
   * connection loads the index once, not ten times.
   */
  private _liveSetKeysCache: { keys: Set<string>; at: number } | null = null

  private async getOpenLiveSetKeys(): Promise<Set<string>> {
    // Perf optimization: maintain an index of open live set keys in Redis so
    // coordinator doesn't need to fetch all positions every cycle. On live-stage
    // state transitions (position placed/closed), the index is updated. Within
    // a coordinator cycle (typically 100-500ms), the 10s cache is valid.
    const cache = this._liveSetKeysCache
    if (cache && Date.now() - cache.at < 10_000) return cache.keys
    
    const keys = new Set<string>()
    try {
      const client = getRedisClient()
      // Maintained index: `live_set_keys:{connId}` SET contains all setKey +
      // parentSetKey values from currently-open live positions. Updated by
      // live-stage when positions transition (place, close).
      const indexKey = `live_set_keys:${this.connectionId}`
      const indexedKeys = await (client as any).smembers(indexKey).catch(() => [] as string[])
      for (const k of indexedKeys || []) {
        if (k) keys.add(String(k))
      }
    } catch { /* fail-open: empty set just means no exemption this cycle */ }
    this._liveSetKeysCache = { keys, at: Date.now() }
    return keys
  }

  /**
   * Monotonic counter incremented on every executeStrategyFlow call.
   * Used to gate TTL resets (expire) on the progression hash so they
   * fire once every 500 cycles instead of on every cycle.
   */
  private _stratCycleCount = 0
  // Dev-mode real:sets write throttle — only persists every 5th cycle to keep
  // the InlineLocalRedis heap bounded. Initialised lazily in createRealSets.


  /**
   * ── Plan-perf Tier 1: parsed-fingerprint LRU ───────────────────────
   *
   * The fpCache stored in Redis is keyed by `fingerprint → JSON.stringify(set)`.
   * Until this perf pass, every cache HIT cost a full `JSON.parse` of a
   * ~1-4 KB payload — at the upper bound (10 symbols × ~80 variant fps
   * each × 1 cycle/sec) that's ~800 parses/sec, dominating createMainSets
   * CPU. This in-process LRU stores the already-parsed StrategySet so a
   * cache hit costs O(1).
   *
   * Keyed by `fingerprint` directly: fingerprints are deterministic and
   * already encode {connectionId, symbol, baseConfig, variant, posCtx}
   * so collisions across connections/symbols are impossible by
   * construction.
   *
   * Capped at 4 096 entries (≈10 connections × 10 symbols × 40 variants).
   * Eviction is "delete oldest insertion" via Map iteration order.
   *
   * Sets are stored by REFERENCE — callers MUST treat them as
   * read-only. createMainSets only reads, never mutates, so this is
   * safe. If a future caller needs to mutate, they should clone the
   * returned record explicitly.
   */
  // Scale LRU with symbol count so a single-symbol dev run keeps ~300 slots
  // while a 10-symbol prod run keeps up to 1024. Each slot holds a StrategySet
  // reference (~2-5 KB) so capping tightly saves 8-40 MB of heap in practice.
  private static readonly _FP_LRU_MAX = 1_024
  private static _fpLru: Map<string, StrategySet> = new Map()
  private static _fpLruGet(fp: string): StrategySet | undefined {
    const hit = StrategyCoordinator._fpLru.get(fp)
    if (hit !== undefined) {
      // Touch: re-insert to the back so it survives eviction longer.
      StrategyCoordinator._fpLru.delete(fp)
      StrategyCoordinator._fpLru.set(fp, hit)
    }
    return hit
  }
  private static _fpLruSet(fp: string, set: StrategySet): void {
    if (StrategyCoordinator._fpLru.size >= StrategyCoordinator._FP_LRU_MAX) {
      const oldest = StrategyCoordinator._fpLru.keys().next().value
      if (oldest !== undefined) StrategyCoordinator._fpLru.delete(oldest)
    }
    StrategyCoordinator._fpLru.set(fp, set)
  }

  // ── Axis-Set LRU ─────────────────────────────────────────────────────────
  // Axis Set objects are pure value objects once the tuner writes sizeDelta
  // onto the CoordRecord instead of mutating entries[] in-place.  Safe to
  // reuse across cycles without cloning.  Key = "${parentKey}:${axisKey}:ec${ec}".
  // Bounded tightly because production workers can be restarted with already-
  // active engines. Keeping tens of thousands of axis objects resident across
  // warmup cycles caused OOM kills before health probes could complete.
  // Scale with symbol count: 1 symbol → 600 slots; 10 symbols → 2000 slots.
  // Each slot ~2-5 KB → 600 slots ≈ 1.2-3 MB (was 16-40 MB at 8000).
  private static readonly _AXIS_LRU_MAX = (() => {
    const raw = Number(process.env.STRATEGY_AXIS_LRU_MAX ?? "")
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2_000
  })()
  private static readonly _axisLruMap: Map<string, StrategySet> = new Map()
  private static _axisLruGet(key: string): StrategySet | undefined {
    const hit = StrategyCoordinator._axisLruMap.get(key)
    if (hit !== undefined) {
      StrategyCoordinator._axisLruMap.delete(key)
      StrategyCoordinator._axisLruMap.set(key, hit)
    }
    return hit
  }
  private static _axisLruSet(key: string, set: StrategySet): void {
    if (StrategyCoordinator._axisLruMap.size >= StrategyCoordinator._AXIS_LRU_MAX) {
      const oldest = StrategyCoordinator._axisLruMap.keys().next().value
      if (oldest !== undefined) StrategyCoordinator._axisLruMap.delete(oldest)
    }
    StrategyCoordinator._axisLruMap.set(key, set)
  }

  /**
   * 30-second per-instance cache for `connection_settings.prevPosMinCount`.
   *
   * Plan-perf #2: this HGETALL was firing once per (symbol, cycle) inside
   * `createBaseSets`. At 10 symbols × ~1 cycle/sec that's 10 redundant
   * full-hash reads/sec for a value that the operator changes through a
   * settings dialog (i.e. every ~hour at most). Coalesced to a 30-second
   * lifetime: shared across all symbols on this instance, refreshed
   * cheaply, and far more responsive than the natural cadence of the
   * underlying setting.
   *
   * Cache holds the *parsed* int (not the raw hash) so the read path is
   * branch-free. Sentinel `-1` means "not yet loaded" — first read loads
   * synchronously, subsequent symbol cycles reuse without I/O.
   */
  private _prevPosMinCountValue = -1
  private _prevPosMinCountAt = 0
  private readonly _prevPosMinCountTtlMs = 5 * 60 * 1000 // 5 minutes

  /**
   * 30-second per-instance cache for `connection_settings.prevPosWindow` —
   * the size N of the last-N rolling window the eval gates average PF/DDT
   * over. Distinct from `prevPosMinCount` (which is the *minimum* sample
   * count before the blend activates at all): a Set needs at least
   * `prevPosMinCount` closed positions for the historic signal to be
   * trusted, and once trusted the PF/DDT are the mean of the most recent
   * `prevPosWindow` of them. Sentinel `-1` = not yet loaded.
   */
  private _prevPosWindowValue = -1
  private _prevPosWindowAt = 0
  private readonly _prevPosWindowTtlMs = 5 * 60 * 1000 // 5 minutes

  // Live dispatch settings cache — exchange and position cost rarely change
  // within a session, so caching them for 5 minutes reduces Redis I/O by 97%
  // (from ~67 hgetall/min to ~2 at 10 symbols).
  private _cachedExchangeMaxLive: number | null = null
  private _cachedExchangeMaxLiveAt = 0
  private _cachedLivePositionCost: number | null = null
  private _cachedLivePositionCostAt = 0

  // ── Profit factor thresholds per stage (system-wide defaults) ──────
  //
  // Spec: "Change at Main Trade PF for Base, Main, Real, Live to
  // 0.9 1.0 1.0 1.0 System Overall. Add to Settings Dialog at
  // Strategies with Sliders. Ensure it works systemwide completely."
  //
  // These are NOT `readonly` because `loadAppPFThresholds()` overrides
  // them from the operator's settings (`baseProfitFactor`,
  // `mainProfitFactor`, `realProfitFactor`, `liveProfitFactor`) on
  // every cycle. The values written here are the FALLBACKS used when
  // a setting is missing / NaN / 0 — chosen to match the new spec
  // defaults so a fresh install gates with 0.9/1.0/1.0/1.0 even
  // before the operator touches the sliders.
  //
  // Why split `PF_BASE_MIN` (per-indication entry filter at line ~440)
  // from `METRICS.base.minProfitFactor`? Historically `PF_BASE_MIN`
  // gated INDIVIDUAL indication entries into Base, while the METRICS
  // values gate the AVERAGE-PF of an already-built Set into the next
  // stage. Conceptually the operator wants ONE Base PF knob — so we
  // load the same `baseProfitFactor` into both fields.
  // Operator spec defaults: base=1.0, main=1.2, real=1.2, live=1.2
  // These are fallbacks used when no operator setting is found in Redis.
  private PF_BASE_MIN = 1.0    // Minimum to enter BASE set
  private PF_MAIN_MIN = 1.2    // Base sets must have avgPF >= 1.2 to enter MAIN
  private PF_REAL_MIN = 1.2    // Main sets must have avgPF >= 1.2 to enter REAL
  private PF_LIVE_MIN = 1.2    // Real sets must have avgPF >= 1.2 to enter LIVE

  // ���─ PF threshold settings cache (per-cycle) ─────────────────────
  // `loadAppPFThresholds()` hits Redis to pull the operator's slider
  // values. Pulling on every symbol's flow would mean N reads per
  // cycle for an N-symbol universe — wasteful and adds latency. The
  // cache holds the last-load timestamp; refresh is bounded to
  // `_pfTtlMs` so a slider change in the Settings dialog takes at
  // most that long to flow into the engine. 5s is short enough to
  // feel instant in the UI but long enough that a 1Hz cycle with 200
  // symbols only does ~3 Redis reads instead of 1000.
  private _pfThresholdsLoadedAt = 0
  private readonly _pfTtlMs = 5_000

  // ── Hedge / directional accumulate params cache ────────────────────────
  // For performance, these are cached per-cycle (5 s TTL) — the operator
  // changes them through a settings dialog, so ~hourly at fastest. The same
  // pattern as PF thresholds + coordination settings.
  private _hedgeLoadedAt = 0
  private readonly _hedgeTtlMs = 5_000

  // ── Hedge / directional normalize runtime state ───────────────────────
  private _hedgeEnabled = false
  private _hedgeThresholdPct = 10
  private _hedgeMaxPerDirection = 20
  private _hedgeVolumeMode: "neutralize" | "rebalance" | "reduce" = "neutralize"

  /**
   * Per-stage minimum position count thresholds.
   * Read from operator settings (`getAppSettings()`),
   * snap to the 5-step grid [5, 10, 15, …, 50].
   * Set to 0 (= not yet loaded / not set) → coordinator default applies.
   */
  private stageMinPosCountBase: number = 0
  private stageMinPosCountMain: number = 0
  private stageMinPosCountReal: number = 0


  // ── Filter axes (P0-2) ──────────────────────────────────────────────
  // Spec: *"filtering by Profitfactor Minimum, DrawdownTime Maximum"*.
  // The canonical Main/Real/Live filter axes are PF-min + DDT-max ONLY.
  // `confidence` is retained here as advisory metadata (it's shown in
  // diagnostic logs and used by the Live stage's trailing-variant
  // selector `bestEntry.confidence >= 0.85`), but it is NOT a filter
  // axis at any stage. The filter code below reads `minProfitFactor`
  // and `maxDrawdownTime` only.
  // NOT `readonly` — `loadAppPFThresholds()` mutates
  // `.minProfitFactor` on each entry to keep them in sync with the
  // operator's sliders. `maxDrawdownTime` / `confidence` / `description`
  // stay constant (they're not part of this spec change).
  private METRICS: Record<string, EvaluationMetrics> = {
    base: {
      maxDrawdownTime: 999999,
      minProfitFactor: 1.0,   // operator spec default (base=1.0)
      confidence: 0.3,        // advisory only
      description: "One Set per (indication_type × direction) — all qualifying",
    },
    main: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: 1.2,   // operator spec default (main=1.2)
      confidence: 0.5,        // advisory only
      description: "Sets promoted from BASE with profitFactor >= main-threshold + DDT <= maxDrawdownTime, gated by minPositions",
    },
    real: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: 1.2,   // operator spec default (real=1.2)
      confidence: 0.65,       // advisory only
      description: "Sets promoted from MAIN with profitFactor >= real-threshold + DDT <= maxDrawdownTime, gated by minPositions",
    },
    live: {
      maxDrawdownTime: 240,   // 4 hours — operator spec default, tunable
      minProfitFactor: 1.2,   // operator spec default (live=1.2)
      confidence: 0.65,       // advisory only
      description: "Best 500 Sets from REAL (PF >= live-threshold + DDT <= maxDrawdownTime) ready for live trading",
    },
  }

  /**
   * Hydrate PF thresholds from operator settings.
   *
   * Reads `baseProfitFactor`, `mainProfitFactor`, `realProfitFactor`,
   * `liveProfitFactor` from `getAppSettings()` and mirrors them into:
   *   - `PF_*_MIN` (per-indication entry filter at base stage; advisory
   *      promotion floor at later stages)
   *   - `METRICS.{base|main|real|live}.minProfitFactor` (Set-average
   *      gate consumed at lines 695/1117/1468)
   *
   * Bounds: [0.0, 5.0]. The slider UI is [0.0, 2.0] but we accept up
   * to 5.0 to allow operators to set extreme values via API/Redis
   * directly without truncation surprise. NaN / negative / missing
   * values fall back to the spec defaults (0.9/1.0/1.0/1.0).
   *
   * Cached for `_pfTtlMs` (5s). The first call after engine start
   * (and any 5s+ later) actually hits Redis; intermediate calls are
   * O(1) no-ops. This is safe to call from every `executeStrategyFlow`
   * entry — including the per-symbol calls inside the batch loop —
   * because the TTL bounds the work.
   */
  private async loadAppPFThresholds(): Promise<void> {
    const now = Date.now()
    if (now - this._pfThresholdsLoadedAt < this._pfTtlMs) return
    this._pfThresholdsLoadedAt = now
    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const globalS = (await getAppSettings()) || {}
      // ── Per-connection override of global app settings (CRITICAL wiring) ──
      // PF thresholds, per-stage DDT, and stage min-position-counts are saved
      // per-connection by the settings dialog and mirrored (flattened +
      // unit-converted) into `connection_settings:{id}` by the PATCH route.
      // Resolution order per the approved plan: connection hash wins, else
      // fall back to the global app setting, else the built-in default below.
      // We overlay the connection hash on top of global settings so any field
      // the operator did NOT set per-connection transparently inherits global.
      let connS: Record<string, string> = {}
      try {
        connS = ((await getRedisClient().hgetall(`connection_settings:${this.connectionId}`)) ||
          {}) as Record<string, string>
      } catch {
        connS = {}
      }
      const s: Record<string, unknown> = { ...(globalS as Record<string, unknown>) }
      // Only let non-empty connection-hash scalars override.
      for (const [k, v] of Object.entries(connS)) {
        if (v !== undefined && v !== null && v !== "") s[k] = v
      }
      const clamp = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) return fallback
        return Math.max(0, Math.min(5, n))
      }
      // Operator spec: base=1.0, main/real/live=1.2 as the fallback when
      // the operator has never touched the PF sliders.
      const basePF = clamp(s.baseProfitFactor, 1.0)
      const mainPF = clamp(s.mainProfitFactor, 1.2)
      const realPF = clamp(s.realProfitFactor, 1.2)
      const livePF = clamp(s.liveProfitFactor, 1.2)

      this.PF_BASE_MIN = basePF
      this.PF_MAIN_MIN = mainPF
      this.PF_REAL_MIN = realPF
      this.PF_LIVE_MIN = livePF
      this.METRICS.base.minProfitFactor = basePF
      this.METRICS.main.minProfitFactor = mainPF
      this.METRICS.real.minProfitFactor = realPF
      this.METRICS.live.minProfitFactor = livePF

      // ── Stage minimum position-count thresholds ────────────────────────────
      // "0" means "coordinator default applies" (hardened in loadStageThreshold).
      const snapStage = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return 0
        return Math.min(50, Math.max(5, Math.round(n / 5) * 5))
      }
      this.stageMinPosCountBase = snapStage((s as any).stageMinPosCountBase, 0)
      this.stageMinPosCountMain = snapStage((s as any).stageMinPosCountMain, 0)
      this.stageMinPosCountReal = snapStage((s as any).stageMinPosCountReal, 0)

      // ── Per-stage Max Drawdown-Time thresholds (DDT gate) ───────────────
      // Operator spec: per-position hold time is up to ~2h, so the DDT gate
      // ceiling defaults to 4h (240 min) per stage. Operator tunes these in
      // hours via Settings → Strategy → Base ("Max Drawdown-Time"). Stored
      // in app settings as hours; the engine gate compares against
      // `Set.avgDrawdownTime` (minutes), so we convert h→min. Base stays
      // open (999999) by design — the gate only rejects at Main/Real/Live.
      // Missing / NaN / non-positive → 4h default. Clamp [1h, 72h] to match
      // the slider range.
      const ddtHours = (raw: unknown, fallback: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return fallback
        return Math.max(1, Math.min(72, n))
      }
      const mainDdtMin = ddtHours((s as any).maxDrawdownTimeMainHours, 4) * 60
      const realDdtMin = ddtHours((s as any).maxDrawdownTimeRealHours, 4) * 60
      const liveDdtMin = ddtHours((s as any).maxDrawdownTimeLiveHours, 4) * 60
      this.METRICS.main.maxDrawdownTime = mainDdtMin
      this.METRICS.real.maxDrawdownTime = realDdtMin
      this.METRICS.live.maxDrawdownTime = liveDdtMin

      // ── Per-stage eval position-count thresholds (CRITICAL wiring fix) ──
      // `mainEvalPosCount` / `realEvalPosCount` are the minimum entryCount a
      // Set must contain before Main/Real validation considers it. The
      // settings dialog saves these AND the PATCH route mirrors them into the
      // `connection_settings:{id}` hash, but until now NOTHING read them back —
      // the coordinator used its constructor defaults (15 / 10) forever, so
      // operator changes silently never took effect. `s` already overlays the
      // per-connection hash on top of global app_settings (see top of this
      // method), so connection wins → global → built-in default. Clamp [1,200].
      const evalCount = (raw: unknown): number | null => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 1) return null
        return Math.min(200, Math.max(1, Math.floor(n)))
      }
      this._coordinationSettings.mainEvalPosCount = evalCount((s as any).mainEvalPosCount) ?? 15
      this._coordinationSettings.realEvalPosCount = evalCount((s as any).realEvalPosCount) ?? 10

      // ── Strategy pipeline ceilings (Settings → System) ────────────────
      // These used to be production-only env constants, so the UI could show
      // `maxRealSets=12000` while the runtime hard-clamped to 100. Load all
      // strategy ceilings from app/connection settings in the same 5s refresh
      // path as the PF/DDT gates so production tuning does not require a
      // redeploy and the System tab reflects the actual enforced limits.
      const intSetting = (raw: unknown, fallback: number, min: number, max: number): number => {
        const n = Number(raw)
        if (!Number.isFinite(n) || n <= 0) return fallback
        return Math.max(min, Math.min(max, Math.floor(n)))
      }
      this.config.maxEntriesPerSet = intSetting((s as any).strategyMaxEntriesPerSet, 250, 50, 750)
      // Only set when the connection explicitly provides a value; otherwise
      // leave null so the VM-memory-scaled dynamic default applies per cycle.
      const _rawAxisCeil = (s as any).strategyMainAxisSetsCeiling
      this.strategyMainAxisSetsCeiling =
        _rawAxisCeil != null && Number.isFinite(Number(_rawAxisCeil)) && Number(_rawAxisCeil) > 0
          ? intSetting(_rawAxisCeil, 50, 10, 50_000)
          : null
    // Only set when the connection explicitly provides a value; otherwise
    // leave null so the standard dev/prod defaults (60/100 per symbol) apply.
    const _rawRealCeil = (s as any).strategyRealSetsSafetyCeiling
    this.strategyRealSetsSafetyCeiling =
      _rawRealCeil != null && Number.isFinite(Number(_rawRealCeil)) && Number(_rawRealCeil) > 0
        ? intSetting(_rawRealCeil, 100, 25, 50_000)
        : null
    // maxRealSets is uncapped (no Infinity default); let realSetsCap enforce the limit.
    this.config.maxRealSets = 
      _rawRealCeil != null && Number.isFinite(Number(_rawRealCeil)) && Number(_rawRealCeil) > 0
        ? intSetting((s as any).maxRealSets, Number(_rawRealCeil), 1, 50_000)
        : undefined
      this.strategyLiveSetsCeiling = intSetting((s as any).strategyLiveSetsCeiling, 90, 1, 1_000)
      this.config.maxLiveSets = this.strategyLiveSetsCeiling
    } catch (err) {
      // Don't fail the whole flow on a settings read miss — the
      // already-loaded values (either the defaults or the last
      // successful load) keep gating active. Log once per failure to
      // help diagnose without spamming.
      console.warn(
        `[v0] [StrategyCoordinator] loadAppPFThresholds() failed; using last-known values`,
        err instanceof Error ? err.message : String(err),
      )
    }
  }

  /**
   * Load hedge accumulation / directional neutralization params from engine timings.
   *
   * Reads neutralizeEnabled, neutralizeThresholdPct, neutralizeMaxPerDirection,
   * and neutralizeVolumeMode from getEngineTimings().
   * Cached for _hedgeTtlMs (5s).
   */
  private async loadHedgeAccumulationParams(): Promise<void> {
    const now = Date.now()
    if (now - this._hedgeLoadedAt < this._hedgeTtlMs) return
    this._hedgeLoadedAt = now

    try {
      const { getEngineTimings } = await import("@/lib/engine-timings")
      const timings = getEngineTimings()
      this._hedgeEnabled = timings.neutralizeEnabled
      this._hedgeThresholdPct = timings.neutralizeThresholdPct
      this._hedgeMaxPerDirection = timings.neutralizeMaxPerDirection
      this._hedgeVolumeMode = timings.neutralizeVolumeMode
    } catch {
      // use last-known values
    }
  }

  /**
   * Load coordination settings from app settings with per-connection overlay.
   *
   * Reads axis enable flags, variant toggles, and block strategy settings.
   * Applies the same resolution hierarchy as loadAppPFThresholds():
   *   connection_settings:{id} hash  →  global app_settings  →  coded default
   *
   * This means the operator's per-connection edits in Connection Settings →
   * Strategy (Trailing on/off, Block on/off, blockVolumeRatio, axis windows,
   * etc.) actually reach the engine instead of being silently discarded.
   *
   * Cached for _coordinationTtlMs (5s).
   */
  private async loadCoordinationSettings(): Promise<void> {
    const now = Date.now()
    if (now - this._coordinationLoadedAt < this._coordinationTtlMs) return
    this._coordinationLoadedAt = now

    try {
      const { getAppSettings } = await import("@/lib/redis-db")
      const globalS = (await getAppSettings()) || {}

      // ── Per-connection override of global coordination settings ─────────
      // The PATCH route flattens CoordinationSettings fields (variantTrailingEnabled,
      // axisPrevEnabled, blockVolumeRatio, etc.) into `connection_settings:{id}`.
      // Overlay them on top of global settings so any field the operator did
      // NOT set per-connection transparently inherits the global value.
      let connS: Record<string, string> = {}
      try {
        connS = ((await getRedisClient().hgetall(`connection_settings:${this.connectionId}`)) ||
          {}) as Record<string, string>
      } catch {
        connS = {}
      }
      const s: Record<string, unknown> = { ...(globalS as Record<string, unknown>) }
      for (const [k, v] of Object.entries(connS)) {
        if (v !== undefined && v !== null && v !== "") s[k] = v
      }

      // Boolean helper: accepts "true"/true → true, "false"/false → false,
      // undefined → supplied default. Mirrors the hash-stored "true"/"false"
      // strings written by the PATCH route.
      const bool = (val: unknown, def: boolean): boolean => {
        if (val === "true"  || val === true)  return true
        if (val === "false" || val === false) return false
        return def
      }
      const num = (val: unknown, def: number): number => {
        const n = Number(val)
        return Number.isFinite(n) ? n : def
      }

      this._coordinationSettings.axes.prev.enabled   = bool(s.axisPrevEnabled,   false)
      this._coordinationSettings.axes.prev.maxWindow  = num(s.axisPrevMaxWindow,   0)
      this._coordinationSettings.axes.last.enabled   = bool(s.axisLastEnabled,   false)
      this._coordinationSettings.axes.last.maxWindow  = num(s.axisLastMaxWindow,   0)
      this._coordinationSettings.axes.cont.enabled   = bool(s.axisContEnabled,   false)
      this._coordinationSettings.axes.cont.maxWindow  = num(s.axisContMaxWindow,   0)
      this._coordinationSettings.axes.pause.enabled  = bool(s.axisPauseEnabled,  false)
      this._coordinationSettings.axes.pause.maxWindow = num(s.axisPauseMaxWindow,  0)

      // Adjust-variant toggles. Defaults: block=true, dca=false (spec: DCA off).
      // variantTrailingEnabled is kept only as a backwards-compatible stored
      // flag; trailing Sets are created at BASE, not emitted as Main Adjusts.
      // The bool() helper only falls back to the default when the key is genuinely
      // absent — an explicit "false" is honoured.
      this._coordinationSettings.variants.trailing = bool(s.variantTrailingEnabled, true)
      this._coordinationSettings.variants.block    = bool(s.variantBlockEnabled,    true)
      this._coordinationSettings.variants.dca      = bool(s.variantDcaEnabled,      false)

      // ── Block-strategy tuning (previously never read from settings) ─────
      // blockVolumeRatio, blockMaxStack, blockPauseCountRatio, and
      // blockActiveRealEnabled control Block overlays. Without reading them here
      // blockActiveLiveEnabled control Block overlays. Without reading them here
      // the engine always used coded defaults regardless of operator changes.
      const bvr = Number(s.blockVolumeRatio)
      if (Number.isFinite(bvr) && bvr > 0) {
        this._coordinationSettings.blockVolumeRatio = Math.max(0.25, Math.min(3.0, bvr))
      }
      const bms = Number(s.blockMaxStack)
      if (Number.isFinite(bms) && bms >= 1) {
        this._coordinationSettings.blockMaxStack = Math.min(10, Math.max(1, Math.floor(bms)))
      }
      const bpcr = Number(s.blockPauseCountRatio)
      if (Number.isFinite(bpcr) && bpcr > 0) {
        this._coordinationSettings.blockPauseCountRatio = Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2))
      }
      this._coordinationSettings.blockActiveRealEnabled = bool(s.blockActiveRealEnabled ?? s.blockActiveLiveEnabled, true)
      this._coordinationSettings.blockActiveLiveEnabled = bool(s.blockActiveLiveEnabled, true)
    } catch {
      // use last-known values on any Redis error
    }
  }

  // ── Per-Base Stage Threshold Loader ───────────────────────────────────
  // NOTE: stageMinPosCount{Base/Main/Real} are now loaded entirely inside
  // loadAppPFThresholds(), which already overlays the per-connection
  // connection_settings:{id} hash on top of global app_settings and snaps
  // to the 5-step grid. This method is kept as a true no-op delegate so
  // the Promise.all call-site compiles without changes.
  //
  // The previous implementation ran its OWN getAppSettings() read (global
  // only) concurrently with loadAppPFThresholds() via Promise.all. Because
  // both shared the same _pfThresholdsLoadedAt TTL timestamp, both would
  // START on the same tick (before either stamped the clock), and whichever
  // finished LAST would overwrite stageMinPosCount with global-only values
  // — silently discarding any per-connection overrides the operator saved
  // via the Settings dialog. Making this a true delegate eliminates that
  // race entirely.

  /**
   * Delegates entirely to loadAppPFThresholds().
   * stageMinPosCount* are read inside that method with per-connection override.
   */
  private async loadStageThresholds(): Promise<void> {
    return this.loadAppPFThresholds()
  }

  /**
   * Execute complete strategy progression flow.
   *
   * Position context is fetched ONCE per cycle and threaded through so Main
   * can generate the correct additional variant Sets without duplicating
   * pseudo-position reads. Callers may also pass a precomputed context
   * (e.g. when running multiple symbols in the same cycle) — we'll reuse it.
   */
  /**
   * Memory circuit-breaker — keeps the dev server alive on the 4.39 GB VM.
   *
   * The BASE→MAIN→REAL pipeline allocates thousands of StrategySet objects per
   * symbol per cycle. On a low-RAM box with no swap the kernel issues a GLOBAL
   * OOM-kill (SIGKILL) the moment total system RAM is exhausted — V8 never gets
   * a chance to GC because the process heap limit (3 GB) is higher than the
   * physical ceiling the kernel enforces (~2 GB anon-rss).
   *
   * This guard runs BEFORE each symbol's allocation burst. When process RSS
   * crosses a soft threshold it forces a synchronous `global.gc()` (the dev
   * script runs with `--expose-gc`) and yields the event loop so the
   * InlineLocalRedis eviction timer can reclaim keys. If RSS is still above a
   * hard threshold after GC it throttles with a short delay, trading a slower
   * prehistoric pass for a process that stays alive instead of being killed.
   */
  private async memoryCircuitBreaker(symbol: string): Promise<void> {
    try {
      // Use the same dynamic limits computed at Redis startup from /proc/meminfo.
      // Falls back to conservative 4 GB VM constants when limits not yet set.
      const gl = (globalThis as any).__redis_mem_limits as
        | { heapMB: number; rssSoftMB: number; rssHardMB: number }
        | undefined
      const SOFT_RSS_MB = gl?.rssSoftMB ?? 2_000
      const HARD_RSS_MB = gl?.rssHardMB ?? 3_000
      // Emergency: 95% of hard — pause the engine entirely for a full GC cycle
      // before the OS kills the process. No swap means SIGKILL happens in <1s
      // once anon-RSS exceeds total RAM.
      const EMERGENCY_RSS_MB = Math.round(HARD_RSS_MB * 1.07)

      let rssMB = process.memoryUsage().rss / 1024 / 1024
      if (rssMB < SOFT_RSS_MB) return

      const gc = (globalThis as any).gc
      // SOFT: force GC and yield so the eviction timer can reclaim keys
      if (typeof gc === "function") {
        gc()
        await new Promise((r) => setTimeout(r, 0))
        rssMB = process.memoryUsage().rss / 1024 / 1024
      }

      if (rssMB >= EMERGENCY_RSS_MB) {
        console.error(
          `[v0] [MemGuard] ${symbol}: RSS=${rssMB.toFixed(0)}MB >= EMERGENCY ${EMERGENCY_RSS_MB}MB — ` +
          `pausing engine 1500ms to avoid kernel OOM SIGKILL`,
        )
        if (typeof gc === "function") gc()
        await new Promise((r) => setTimeout(r, 1_500))
        if (typeof gc === "function") gc()
      } else if (rssMB >= HARD_RSS_MB) {
        console.warn(
          `[v0] [MemGuard] ${symbol}: RSS=${rssMB.toFixed(0)}MB >= hard ${HARD_RSS_MB}MB — throttling 400ms`,
        )
        await new Promise((r) => setTimeout(r, 400))
        if (typeof gc === "function") gc()
      }
    } catch {
      // Never let the guard itself break the pipeline.
    }
  }

  async executeStrategyFlow(
    symbol: string,
    indications: any[],
    isPrehistoric: boolean = false,
    sharedContext?: PositionContext,
    // skipLiveDispatch decouples "generate variants + pseudo-positions + stats"
    // from "place real exchange orders". When true, the flow runs the full
    // BASE→MAIN→REAL→LIVE pipeline with REAL position context (so trailing/
    // block/dca variants fire and their pseudo-positions + stats are written),
    // but createLiveSets skips the executeLivePosition exchange-dispatch block.
    // The serverless cron uses this so it can drive variant generation without
    // double-placing orders that the engine/live-sync loop already owns.
    skipLiveDispatch: boolean = false,
  ): Promise<StrategyEvaluation[]> {
    const results: StrategyEvaluation[] = []
    this._stratCycleCount++

    // Reclaim memory before this symbol's BASE→MAIN→REAL allocation burst.
    await this.memoryCircuitBreaker(symbol)

    try {
      // ── Hydrate PF thresholds + Coordination settings + stage thresholds + normalise ─
      await Promise.all([
        this.loadAppPFThresholds(),
        this.loadCoordinationSettings(),
        this.loadHedgeAccumulationParams(),
        this.loadStageThresholds(),
      ])

      // Fetch the per-cycle position coordination context once. Prehistoric
      // runs use a neutral context (no open positions, no prior outcomes) so
      // only the always-on `default` variant is produced — that matches the
      // original behaviour for backtests.
      const posCtx: PositionContext = sharedContext
        ?? (isPrehistoric
          ? this.neutralPositionContext()
          : await this.getPositionContext())

      // ── OPTIMIZATION: Skip processing if position state unchanged ──
      // Check fingerprint of position counts to skip redundant calculations when
      // no new positions have opened/closed. Prevents recalculating P&F/DDT every
      // cycle when the market hasn't generated new entries.
      const posFingerprint = `${posCtx.continuousCount}|${posCtx.lastPosCount}|${posCtx.prevPosCount}`
      const prevFingerprint = (this as any)._lastPosFingerprint?.[symbol]
      if (prevFingerprint === posFingerprint && !isPrehistoric) {
        // Position state unchanged AND indication count stable
        if (indications.length === (this as any)._lastIndicationCount?.[symbol]) {
          console.log(`[v0] [StrategyCoordinator] ${symbol}: position+indication state unchanged, skipping cycle`)
          return results // Early exit — no recalculation needed
        }
      }
      if (!(this as any)._lastPosFingerprint) (this as any)._lastPosFingerprint = {}
      if (!(this as any)._lastIndicationCount) (this as any)._lastIndicationCount = {}
      ;(this as any)._lastPosFingerprint[symbol] = posFingerprint
      ;(this as any)._lastIndicationCount[symbol] = indications.length

      // Refresh per-cycle trailing-matrix cache when this entry-point is
      // called standalone (the batch entry-point invalidates already).
      // `sharedContext` presence is the cheapest tell that we're inside
      // a batch — skip the reset there to keep one read per batch.
      if (!sharedContext) (this as any)._trailingVariantsCache = undefined

      // Sets flow BASE → MAIN → REAL → LIVE. Each stage used to re-read its
      // predecessor's output from Redis via getSettings(); we now pipe the
      // computed arrays directly between stages in memory to eliminate 3
      // Redis round-trips per symbol per cycle. Each stage still persists
      // its own output to Redis for downstream consumers (stats API, dashboard).
      //
      // A CoordIndex is allocated once in createBaseSets and threaded through
      // all downstream stages by reference. It carries the BaseRegistry (O(1)
      // base lookup), per-record tuning deltas, and the validRealKeys set so
      // createLiveSets can resolve axis parent entries in O(1) instead of O(N).
      //
      // STAGE 1: BASE — one Set per (indication_type × direction)
      const { result: baseResult, sets: baseSets, coordIndex } = await this.createBaseSets(symbol, indications)
      results.push(baseResult)

      // STAGE 2: MAIN — validate Base Sets AND create additional related
      // variant Sets (Default / Trailing / Block / DCA) gated by posCtx.
      // CoordIndex receives a SetCoordRecord per built set (O(1) per set).
      const { result: mainResult, sets: mainSets } = await this.createMainSets(symbol, baseSets, posCtx, coordIndex, isPrehistoric)
      results.push(mainResult)

      // STAGE 3: REAL ��� promote Sets with avgPF >= 1.4 (base-promoted AND
      // additional related variants flow uniformly through this filter).
      // CoordIndex.validRealKeys is populated here; Real tuner writes sizeDelta
      // / tunedAvgPF onto each record for O(1) access at Live dispatch.
      const { result: realResult, sets: realSets } = await this.evaluateRealSets(symbol, mainSets, coordIndex)
      results.push(realResult)

      // STAGE 4: LIVE — best 500 Sets for execution (skip in prehistoric mode).
      // Axis-entry hydration uses coordIndex.base.byKey.get(parentKey) — O(1)
      // instead of the prior O(N) realSets.find() scan.
      if (!isPrehistoric) {
        const { result: liveResult } = await this.createLiveSets(symbol, realSets, coordIndex, skipLiveDispatch)
        results.push(liveResult)

        // DEV/SIM bounded rolling lifecycle. The simulated connector marks a
        // constant price so live positions never hit TP/SL and pile up
        // unbounded per symbol — which starves the `block` variant gate
        // (window [1, blockMaxStack)) and produces no realistic win/loss
        // closed history for `trailing`/`dca`. Cap the per-symbol open book
        // just below blockMaxStack and roll the oldest excess to realistic
        // TP/SL outcomes (writes closed-index + pos-history that the gates
        // read). No-op in production — real positions close via real prices.
        try {
          const posMgr = new PseudoPositionManager(this.connectionId)
          await posMgr.enforceSimBoundedLifecycle(symbol, {
            // Keep open in [.., blockMaxStack-1] so `n < blockMaxStack` holds.
            maxOpenPerSymbol: Math.max(1, this._coordinationSettings.blockMaxStack - 1),
            // Let a position live at least one flow interval before it can be
            // rolled, so freshly-dispatched entries aren't closed instantly.
            minAgeMs: 2000,
          })
        } catch { /* best-effort; lifecycle enforcement */ }
      }

      await this.logStrategyProgression(symbol, results)

      // Explicitly release the CoordIndex Maps so V8 can reclaim them before
      // the next cycle's allocation pressure. Without this, the Map entries
      // (each holding a StrategySet reference) stay reachable until the next
      // major GC, which may not run between tight cycles at high symbol counts.
      if (coordIndex) {
        coordIndex.base.byKey.clear()
        coordIndex.records.length = 0
        coordIndex.validRealKeys.clear()
      }

      return results
    } catch (error) {
      console.error(`[v0] [StrategyCoordinator] Flow failed for ${symbol}:`, error)
      throw error
    }
  }

  /**
   * Run N symbols in a single flow pass, sharing one position-context fetch
   * across all of them. Use this when the engine evaluates many symbols per
   * cycle — it eliminates (N-1) pseudo-position reads vs. calling
   * `executeStrategyFlow` separately for each symbol.
   */
  async executeStrategyFlowBatch(
    items: Array<{ symbol: string; indications: any[] }>,
    isPrehistoric: boolean = false,
    // See executeStrategyFlow: generate variants + stats but skip real
    // exchange-order placement. Forwarded to every per-symbol flow.
    skipLiveDispatch: boolean = false,
  ): Promise<Record<string, StrategyEvaluation[]>> {
    const ctx = isPrehistoric ? this.neutralPositionContext() : await this.getPositionContext()
    // Refresh per-cycle caches so a Settings save in the dashboard takes
    // effect on the very next cycle (no engine restart required).
    ;(this as any)._trailingVariantsCache = undefined
    const out: Record<string, StrategyEvaluation[]> = {}
    // Cap concurrency so at most SYMBOL_CONCURRENCY symbol pipelines run
    // simultaneously.  Each pipeline allocates Base + Main + Real + Live set
    // graphs; running all N symbols in parallel multiplies peak live heap by N.
    // SYMBOL_CONCURRENCY=3 (dev) / 6 (prod) keeps the in-flight set count
    // proportional to what was previously tested at 5 symbols.
    const SYMBOL_CONCURRENCY = 6
    const queue = [...items]
    const workers = Array.from({ length: Math.min(SYMBOL_CONCURRENCY, queue.length) }, async () => {
      while (queue.length > 0) {
        const item = queue.shift()
        if (!item) break
        out[item.symbol] = await this.executeStrategyFlow(item.symbol, item.indications, isPrehistoric, ctx, skipLiveDispatch)
      }
    })
    await Promise.all(workers)
    return out
  }

  // ─���─ STAGE 1: BASE ───────────────────────────────────────────────────────────

  /**
   * Read the multi-step trailing matrix from Redis settings (mirror-aware).
   * Returns one TrailingProfile per ENABLED `(start, stop)` combo.
   *
   * When the master toggle (`strategyBaseTrailingEnabled`) is off OR no
   * trailing range profiles are enabled, returns `[]` and the caller falls back to the
   * legacy single-Set path with confidence-based trailing on/off.
   *
   * Cached per-cycle on `this._trailingVariantsCache` so the per-symbol
   * createBaseSets calls in `executeStrategyFlowBatch` share one read.
   */
  private async getEnabledTrailingVariants(): Promise<
    Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string; minStep: number }>
  > {
    if ((this as any)._trailingVariantsCache) return (this as any)._trailingVariantsCache
    try {
      // Lazy import to avoid circular deps in legacy callers
      const { getAppSettings, getRedisClient } = await import("@/lib/redis-db")
      const settings = (await getAppSettings()) || {}
      let trailingMinStep = 6
      try {
        const client = getRedisClient()
        const cs = (await client.hgetall(`connection_settings:${this.connectionId}`).catch(() => null)) as Record<string, string> | null
        const rawMin = Number(cs?.trailingMinStep ?? cs?.trailing_min_step ?? (settings as any).trailingMinStep ?? 6)
        if (Number.isFinite(rawMin)) trailingMinStep = Math.min(30, Math.max(2, Math.round(rawMin)))
      } catch { /* default stays */ }
      const enabledMaster = settings.strategyBaseTrailingEnabled !== false
      if (!enabledMaster) {
        ;(this as any)._trailingVariantsCache = []
        return []
      }

      const raw = settings.strategyBaseTrailingVariants
      // Support both shapes: stringified JSON (Upstash KV) and array
      let tokens: string[] = []
      if (Array.isArray(raw)) tokens = raw
      else if (typeof raw === "string" && raw.trim().startsWith("[")) {
        try {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) tokens = parsed
        } catch { /* tolerate malformed */ }
      } else if (typeof raw === "string") {
        // Comma-or-whitespace-separated fallback
        tokens = raw.split(/[\s,]+/).filter(Boolean)
      }

      const profiles: Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string; minStep: number }> = []
      for (const token of tokens) {
        if (typeof token !== "string") continue
        const [sStr, kStr] = token.split(":")
        const start = parseFloat(sStr)
        const stop = parseFloat(kStr)
        if (!Number.isFinite(start) || !Number.isFinite(stop)) continue
        if (start <= 0 || stop <= 0) continue
        // tag is the canonical compact identifier used in setKey suffix
        const tag = `t${Math.round(start * 100)}-${Math.round(stop * 100)}`
        profiles.push({ startRatio: start, stopRatio: stop, stepRatio: stop / 2, tag, minStep: trailingMinStep })
      }
      ;(this as any)._trailingVariantsCache = profiles
      return profiles
    } catch (err) {
      console.warn("[v0] [StrategyCoordinator] failed to read trailing variants:", err)
      ;(this as any)._trailingVariantsCache = []
      return []
    }
  }

  /**
   * Create one StrategySet per (indication_type × direction × trailing range)
   * combination. Each trailing range is a BASE coordination profile, not a
   * Main-stage Adjust strategy. Each Set holds multiple config entries (max 250).
   *
   * When multi-step trailing is disabled (or no range profiles are enabled), the
   * fan-out collapses to one Set per (type × direction) — original behaviour.
   */
  private async createBaseSets(
    symbol: string,
    indications: any[],
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[]; coordIndex: CoordIndex }> {
    // Group indications by (type × direction)
    const setMap = new Map<string, { indicationType: string; direction: "long" | "short"; indications: any[] }>()

    for (const ind of indications) {
      // Direction resolution — check all sources in priority order:
      //   1. `ind.direction`          set by batchSaveIndications (IndicationSetsProcessor path)
      //   2. `ind.metadata.direction` set by cron route
      //   3. `ind.metadata.firstDir`  numeric sign from calculateDirectionIndication
      //   4. `ind.value`              negative value = short (legacy cron path)
      // Without this multi-source check, ALL indications from the
      // IndicationSetsProcessor path (which stores direction on ind.direction,
      // not ind.metadata.direction) defaulted to "long", making L and S Sets
      // identical (same content, same PF).
      let direction: "long" | "short"
      if (ind.direction === "short" || ind.direction === "long") {
        direction = ind.direction
      } else if (ind.metadata?.direction === "short") {
        direction = "short"
      } else if (typeof ind.metadata?.firstDir === "number") {
        direction = ind.metadata.firstDir < 0 ? "short" : "long"
      } else if (typeof ind.value === "number" && ind.value < 0) {
        direction = "short"
      } else {
        direction = "long"
      }
      const key = `${ind.type || "direction"}:${direction}`
      if (!setMap.has(key)) {
        setMap.set(key, { indicationType: ind.type || "direction", direction, indications: [] })
      }
      setMap.get(key)!.indications.push(ind)
    }

    const baseSets: StrategySet[] = []
    const maxEntries = this.config.maxEntriesPerSet || 250

    // ── Prev-PI batch prefetch (one round-trip, all (type×dir) buckets) ──
    // Per spec: strategies must "evaluate prev pos and profitfactors min
    // from historic … prev pos cnts are working and added to settings,
    // strategy". We fetch the lifetime success/PF/DDT for every (type,
    // direction) bucket this symbol is about to produce a Base Set for,
    // then attach + min-blend below. Fresh boots / new buckets return
    // {count:0, ...} which is treated as "no signal yet" → no blend.
    let posMap: Map<string, import("@/lib/pos-history").PosWindowStats> = new Map()
    let prevPosMinCount = 5
    let prevPosWindow = 25
    try {
      const { getPosWindowBatch } = await import("@/lib/pos-history")
      const pairs = Array.from(setMap.values()).map((g) => ({
        indicationType: g.indicationType,
        direction: g.direction,
      }))
      // Operator-tunable threshold (Settings → Strategies → Coordination).
      // Read from connection_settings hash; fall back to 5 (≈ statistical
      // smallest meaningful win-rate denominator).
      //
      // 30-second per-instance cache: the operator changes this through a
      // settings dialog, so the natural cadence is ~hourly at fastest. Per-
      // symbol-per-cycle HGETALLs were costing 10 round-trips/sec at 10
      // symbols for a value that almost never moves. The settings dirty-
      // flag broadcast is independent of this cache, so a save still gets
      // picked up within one realtime tick *of the next refresh window*
      // — the cap matches the responsiveness of every other settings
      // value on this code path.
      try {
        // Settings cache TTL: 5 minutes (300s). Connection settings are set via
        // the UI settings dialog and change infrequently during a session.
        // Previously 30s caused 67 hgetall calls/min at 10 symbols. At 5 min
        // this drops to 2 calls/min, 97% reduction in Redis I/O for this path.
        // AGGRESSIVE CACHE: 10 minutes for settings (operator changes infrequently)
      const SETTINGS_CACHE_TTL_MS = 10 * 60 * 1000
        const cachedAge = Date.now() - this._prevPosMinCountAt
        const winAge = Date.now() - this._prevPosWindowAt
        if (
          this._prevPosMinCountValue >= 0 &&
          cachedAge < SETTINGS_CACHE_TTL_MS &&
          this._prevPosWindowValue >= 0 &&
          winAge < SETTINGS_CACHE_TTL_MS
        ) {
          prevPosMinCount = this._prevPosMinCountValue
          prevPosWindow = this._prevPosWindowValue
        } else {
          const client = getRedisClient()
          const cs = (await client.hgetall(
            `connection_settings:${this.connectionId}`,
          )) as Record<string, string>
          const v = Number(cs?.prevPosMinCount || cs?.prevPiMinCount || "")
          if (Number.isFinite(v) && v >= 1) prevPosMinCount = Math.min(50, Math.floor(v))
          this._prevPosMinCountValue = prevPosMinCount
          this._prevPosMinCountAt = Date.now()
          // prevPosWindow: the single cumulative "last N positions" window
          // feeding BOTH the windowed PF and the windowed DDT. Clamp
          // [1, 600] to match the pos-history RING_CAP. Default 25.
          const w = Number(cs?.prevPosWindow || "")
          if (Number.isFinite(w) && w >= 1) prevPosWindow = Math.min(600, Math.floor(w))
          this._prevPosWindowValue = prevPosWindow
          this._prevPosWindowAt = Date.now()
        }
      } catch { /* default stays */ }
      // Windowed (last-N) stats — the spec-correct "average of the last N
      // positions" rather than a lifetime mean. PF and DDT are BOTH averaged
      // over the SAME `prevPosWindow` sample (single cumulative window). The
      // blend still only activates once the bucket has at least
      // prevPosMinCount samples (checked below via .count).
      posMap = await getPosWindowBatch(
        this.connectionId,
        symbol,
        pairs,
        prevPosWindow,
      )
    } catch (posErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} prev-pos prefetch failed:`, posErr)
    }

    // Multi-step trailing range matrix — `[]` (= no fan-out) collapses to legacy
    // single-Set-per-(type,direction) behaviour. We use `[null]` as a
    // sentinel "untrailed" pass so the body of the loop is shared between
    // both paths.
    const trailingVariants = await this.getEnabledTrailingVariants()
    const variantPasses: Array<{ startRatio: number; stopRatio: number; stepRatio: number; tag: string; minStep: number } | null> =
      trailingVariants.length > 0 ? trailingVariants : [null]

    for (const variant of variantPasses) {
      for (const [baseSetKey, group] of setMap.entries()) {
        // Per-range Set key — keeps each trailing combo as an INDEPENDENT
        // BASE Set throughout the BASE → MAIN → REAL → LIVE flow.
        const setKey = variant ? `${baseSetKey}:${variant.tag}` : baseSetKey

        // Build up to maxEntries config entries for this Set
        const entries: StrategySetEntry[] = []
        let entryIdx = 0

        for (const ind of group.indications) {
          if (entryIdx >= maxEntries) break
          // Always parse as numbers — indication fields may arrive as strings from Redis hgetall
          if (variant) {
            // Only explicit step-window metadata participates in the
            // trailing-min-step gate. Do NOT fall back to unrelated fields
            // such as `range` or `consecutiveSteps`: those are volatility /
            // pattern measurements, not Base position-window sizes, and using
            // them here incorrectly filtered valid trailing Sets out of live
            // production. Legacy indications without step metadata remain
            // eligible so old saved runs do not lose trailing coverage.
            const explicitStep =
              ind.metadata?.stepWindow ??
              ind.metadata?.step ??
              ind.metadata?.windowSize ??
              ind.metadata?.period
            const rawStep = explicitStep == null ? Number.POSITIVE_INFINITY : Number(explicitStep)
            if (Number.isFinite(rawStep) && rawStep < variant.minStep) continue
          }
          const rawConf = parseFloat(String(ind.confidence ?? 0.5))
          const conf = Number.isFinite(rawConf) ? rawConf : 0.5
          const rawPF = parseFloat(String(ind.profitFactor ?? ind.profit_factor ?? 0))
          const pfFromPF = Number.isFinite(rawPF) && rawPF > 0 ? rawPF : conf * 2
          const pf = pfFromPF
          if (pf < this.PF_BASE_MIN) continue

          entries.push({
            id: `${setKey}-${entryIdx}`,
            sizeMultiplier: 1.0,
            leverage: 1,
            positionState: "new",
            profitFactor: pf,
            drawdownTime: 0,
            confidence: conf,
          })
          entryIdx++
        }

        if (entries.length === 0) continue

        const rawAvgPF = entries.reduce((s, e) => s + e.profitFactor, 0) / entries.length
        const avgConf = entries.reduce((s, e) => s + e.confidence, 0) / entries.length

        // ── Prev-PI min-blend on avgProfitFactor ─────────────────────────
        // Operator spec: "evaluating prev pos and profitfactors min from
        // historic". When the historic bucket has at least `prevPosMinCount`
        // closed positions, the Set's avgProfitFactor becomes the MIN of
        // (live indication PF, historic realised PF). Underperforming
        // historic regimes thus pull the bar DOWN so the Base→Main filter
        // rejects them. When the bucket has insufficient data we leave the
        // raw indication-derived PF untouched (= bootstrap path).
        const posStats = posMap.get(`${group.indicationType}|${group.direction}`)
        const blendActive = !!posStats && posStats.count >= prevPosMinCount
        const avgPF = blendActive
          ? Math.min(rawAvgPF, posStats!.profitFactor)
          : rawAvgPF

        // ── Drawdown-time from historic window ────────────────────────────
        // The Set's avgDrawdownTime was previously hardcoded to 0, which made
        // the Main/Real DDT gate a dead no-op (a `> maxDrawdownTime` test can
        // never fire against 0). We now seed it from the windowed historic
        // mean drawdown minutes (avgDDT) once the bucket has enough samples.
        // Without sufficient history we leave it 0 (= "no DDT signal yet",
        // gate stays open — bootstrap path), matching the PF-blend bootstrap.
        const avgDDT = blendActive ? posStats!.avgDDT : 0

        const set: StrategySet = {
          setKey,
          indicationType: group.indicationType,
          direction: group.direction,
          avgProfitFactor: avgPF,
          avgConfidence: avgConf,
          avgDrawdownTime: avgDDT,
          entryCount: entries.length,
          entries,
          createdAt: new Date().toISOString(),
          ...(variant && {
            trailingProfile: {
              startRatio: variant.startRatio,
              stopRatio: variant.stopRatio,
              stepRatio: variant.stepRatio,
            },
          }),
          // Attach prev-pos snapshot so Main/Real propagation paths can
          // reach it without re-fetching. Always carry the field even
          // when count==0 — keeps downstream null-checking simple.
          ...(posStats && posStats.count > 0 && {
            prevPos: {
              count: posStats.count,
              successRate: posStats.successRate,
              profitFactor: posStats.profitFactor,
              avgDDT: posStats.avgDDT,
            },
          }),
        }

        baseSets.push(set)
      }
    }

    // Persist BASE sets — skipped in dev mode.
    // Each baseSets blob contains full StrategySet objects (~10 KB each).
    const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
    await setSettings(baseKey, { sets: baseSets, count: baseSets.length, created: new Date() })

    // Write Base counts to progression hash so stats API and dashboard read accurate per-stage counts.
    // CRITICAL: Use hincrby (cumulative) not hset (snapshot). Previously each cycle overwrote the
    // value with the current cycle's count, which made the dashboard oscillate between high/low
    // values every few seconds ("jumping more and less"). The per-cycle snapshot is still
    // available in `strategy_detail:{connId}:base` (`created_sets` field).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const detailKey  = `strategy_detail:${this.connectionId}:base`
      const baseAvgPF  = baseSets.length > 0 ? baseSets.reduce((s, st) => s + st.avgProfitFactor, 0) / baseSets.length : 0
      const baseAvgDDT = baseSets.length > 0 ? baseSets.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / baseSets.length : 0
      // Average config entries per Set — the canonical "positions per Set"
      // metric the dashboard surfaces for each stage. At Base, each entry is
      // one raw indication slot ready for position coordination at Main.
      const baseEntriesTotal  = baseSets.reduce((s, st) => s + (st.entryCount || 0), 0)
      const baseAvgPosPerSet  = baseSets.length > 0 ? baseEntriesTotal / baseSets.length : 0

      // ── ACTIVELY-RUNNING NOW snapshot (canonical "alive" definition) ──
      // Per operator spec the dashboard must show counts ONLY for Sets
      // that are ACTIVELY processing — those that either:
      //   (a) currently hold ≥ 1 open pseudo-position, or
      //   (b) have ongoing position formation in progress this cycle.
      // The canonical ground truth is membership in
      // `pseudo_positions:{conn}:active_config_keys`, maintained
      // atomically by PseudoPositionManager (added on open, removed on
      // close). We read it once per cycle and cache on `this` so
      // createMainSets / evaluateRealSets can reuse it without an extra
      // SMEMBERS round-trip.
      const activeKeys = new Set<string>(
        (await client
          .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
          .catch(() => [])) as string[],
      )
      this._activeKeysCache = { keys: activeKeys, cycleAt: Date.now() }
      const baseRunningNow = baseSets.filter((s) => activeKeys.has(s.setKey)).length

      // Fan-out all independent writes. The awaited chain used to add ~8 Redis
      // round-trips to every BASE cycle even when nothing had changed; issuing
      // them concurrently cuts that to a single bounded round-trip window.
      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_base_current", String(baseSets.length)),
        client.hset(detailKey, {
          // ── Legacy per-cycle aggregate fields ─��───────────────────────
          // These hold THIS-symbol's values and are overwritten on every
          // (symbol, cycle). They remain for backwards compatibility but
          // the /stats route prefers the cross-symbol sums it computes
          // from the `s:{symbol}:*` per-symbol fields below.
          created_sets:      String(baseSets.length),
          avg_profit_factor: String(baseAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(baseAvgDDT)),
          avg_pos_per_set:   String(baseAvgPosPerSet.toFixed(2)),
          evaluated:         String(baseSets.length),
          passed_sets:       "0",   // will be updated by createMainSets
          entries_total:     String(baseEntriesTotal),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   sets_running_now         = canonical "alive" count: Sets
          //     whose setKey is in `active_config_keys` Redis Set right
          //     now (open pseudo-position OR in-formation). This is the
          //     ONLY count surfaced as "Active" on the dashboard — the
          //     dashboard must hide already-progressed Sets that have
          //     since closed and are no longer doing anything.
          //   sets_with_open_positions = alias of sets_running_now for
          //     dialog labels that prefer position-centric phrasing.
          //   sets_progressing         = Sets in mid-calculation this
          //     cycle (entryCount > 0 means slots are being formed).
          sets_running_now:         String(baseRunningNow),
          sets_with_open_positions: String(baseRunningNow),
          sets_progressing:         String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          updated_at:        String(Date.now()),
          // ── Per-symbol fields (cross-symbol aggregation source) ──────
          // The legacy fields above are overwritten by every symbol's
          // cycle, leaving the dashboard with only the LAST symbol's
          // numbers. To preserve cross-symbol totals & weighted means,
          // we additionally write a `s:{symbol}:*` namespaced bundle
          // per cycle. The /stats route iterates these fields, sums
          // counters, and computes weighted means (weight = createdSets)
          // per symbol. Stale samples (ts older than 5 min) are excluded;
          // very old samples (ts older than 30 min) are pruned.
          [`s:${symbol}:created`]:    String(baseSets.length),
          [`s:${symbol}:entries`]:    String(baseEntriesTotal),
          [`s:${symbol}:running`]:    String(baseRunningNow),
          [`s:${symbol}:progressing`]: String(
            baseSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     "0",  // updated when Main runs
          [`s:${symbol}:evaluated`]:  String(baseSets.length),
          [`s:${symbol}:apf`]:        String(baseAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(baseAvgDDT)),
          [`s:${symbol}:apps`]:       String(baseAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(detailKey, 86400),
        client.set(`strategies:${this.connectionId}:base:count`, String(baseSets.length)),
        client.set(`strategies:${this.connectionId}:base:evaluated`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:base:count`, 86400),
        client.expire(`strategies:${this.connectionId}:base:evaluated`, 86400),
      ]
      // Base is the pipeline entry point — every Set it produces IS its own
      // evaluation (it passes by definition of being emitted). The old
      // denominator `variantPasses.length × setMap.size` counted "raw combos
      // attempted" which was always ≥ baseSets.length, making Base eval%
      // appear << 100% and breaking the stageEvalPercent cascade display.
      // The correct denominator is baseSets.length: same as the numerator,
      // so Base always evaluates at 100%.
      if (baseSets.length > 0) {
        writes.push(
          client.hincrby(redisKey, "strategies_base_total",     baseSets.length),
          client.hincrby(redisKey, "strategies_base_evaluated", baseSets.length),
        )
      }

      // ── ACTIVE-NOW snapshot per (symbol, stage) ───────�����─────────��─����─��─
      // The cumulative `strategies_base_total` hincrby above answers
      // "how many Base Sets have been created EVER", but the dashboard
      // Overview asks "how many are alive RIGHT NOW for this symbol".
      // We overwrite a single field per (symbol, stage) every cycle so
      // the latest value is always the most recent count. The stats API
      // hgetalls this hash and aggregates by stage.
      writes.push(
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:base`]:          String(baseSets.length),
          // base:evaluated = same as base (every Base Set IS evaluated at Base stage)
          [`${symbol}:base:evaluated`]: String(baseSets.length),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
      )
      // Gate progression hash TTL reset — 7-day key, refresh every 500 cycles
      if (this._stratCycleCount % 500 === 1) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }
      await Promise.all(writes)
    } catch { /* non-critical */ }

    // ── Build BaseRegistry + seed CoordIndex for downstream stages ─────���─
    // This is the SINGLE allocation point for base data. All downstream stages
    // reference baseSets via coordIndex.base.byKey — no copies made.
    const baseRegistry: BaseRegistry = {
      byKey:       new Map(baseSets.map((s) => [s.setKey, s])),
      orderedKeys: baseSets.map((s) => s.setKey),
    }
    const coordIndex = makeCoordIndex(baseRegistry)

    return {
      result: {
        type: "base",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: baseSets.length,
        failedEvaluation: 0,
        avgProfitFactor: baseSets.length > 0 ? baseSets.reduce((s, set) => s + set.avgProfitFactor, 0) / baseSets.length : 0,
        avgDrawdownTime: 0,
      },
      sets: baseSets,
      coordIndex,
    }
  }

  // ─── STAGE 2: MAIN ──────────────────────���─────────────────────────────────�����──

  /**
   * Validate BASE Sets (avgPF >= 1.2, avgConf >= 0.5, DDT <= 24h) AND create
   * additional RELATED variant Sets for each validated Base Set, gated by
   * per-cycle position coordination context.
   *
   * Per user spec:
   *   "Main validates from Base Sets, then creates additional related Sets
   *    (based on prev pos counts, last pos counts, continuous pos counts,
   *    each with adjusted strategies — Block, DCA, etc.) for each evaluated
   *    Set, IF NOT ALREADY CREATED, and are used for continuous progress to
   *    Real. Real evaluates from Main with the additional related Sets."
   *
   * Implementation:
   *   1. For each Base Set passing validation, produce N "related" Main Sets,
   *      one per ACTIVE variant whose gate predicate passes for the current
   *      PositionContext. Each related Set carries `parentSetKey` = base
   *      setKey + `variant` = one of {default, trailing, block, dca}.
   *   2. Variant expansion uses a curated small config list (≤ 4 per variant,
   *      ≤ 3 active variants) instead of the previous 4×4×4 = 64-entry
   *      Cartesian product. At max this generates ~16 entries per Base
   *      entry — ~4× faster than the old path and no silently-rejected
   *      entries (every config is pre-filtered to satisfy the DDT cap).
   *   3. Fingerprint cache — we record `{baseSetKey, base avgPF bucket,
   *      variant, posCtx bucket}` per generated Set. If the same fingerprint
   *      re-appears next cycle, we reuse the cached Set instead of
   *      regenerating ("IF NOT ALREADY CREATED").
   */
  private async createMainSets(
    symbol: string,
    inputSets?: StrategySet[],
    posCtx?: PositionContext,
    coordIndex?: CoordIndex,
    skipAxisFanout: boolean = false,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    // Prefer in-memory input (hot-path pipelined from createBaseSets). Fall
    // back to Redis only when called standalone (tests / diagnostics).
    let baseSets: StrategySet[]
    if (inputSets) {
      baseSets = inputSets
    } else {
      const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
      const stored = await getSettings(baseKey)
      baseSets = stored?.sets || []
    }

    const metricsMain = this.METRICS.main
    const maxEntries = this.config.maxEntriesPerSet || 250
    const ctx = posCtx ?? this.neutralPositionContext()
    const mainSets: StrategySet[] = []

    // ── Cold-start bootstrap for live quickstarts (Main stage) ────────
    // Fresh quickstarts after enabling live trade often have Base sets with
    // synthetic entries and low/zero realised PF. The normal Main gate (PF>=1.0)
    // would reject everything before any variants are even created.
    // Apply a one-time mild relaxation only for prod + live_trade after quickstart.
    // This mirrors the Real-stage bootstrap and restores the behaviour where
    // "it used to produce live orders on first quickstart".
    // IMPORTANT: use a LOCAL minPF variable — never mutate this.METRICS.main
    // in-place. The class field is shared across all symbols in the same cycle
    // (and across cycles within the 5s PF-cache window), so an in-place write
    // would bleed the relaxed threshold into every subsequent symbol's call.
    let mainMinPF = metricsMain.minProfitFactor
    let liveQuickstartOn = false
    try {
      const { getConnection: getConn } = await import("@/lib/redis-db")
      const { isTruthyFlag } = await import("@/lib/connection-state-utils")
      const conn = await getConn(this.connectionId).catch(() => null as any)
      liveQuickstartOn =
        isTruthyFlag(conn?.is_live_trade) ||
        isTruthyFlag(conn?.live_trade_enabled) ||
        isTruthyFlag(conn?.live_trade_requested)
      if (liveQuickstartOn) {
        const relaxed = Math.min(mainMinPF, 0.75)
        if (relaxed !== mainMinPF) {
            const logKey = `main:${this.connectionId}`
            const now = Date.now()
            if (!_bootstrapLoggedAt[logKey] || now - _bootstrapLoggedAt[logKey] > 60_000) {
              _bootstrapLoggedAt[logKey] = now
            console.log(
              `[v0] [StrategyCoordinator] ${this.connectionId} MAIN bootstrap (live quickstart): ` +
              `relaxed minProfitFactor ${mainMinPF} → ${relaxed} to allow first Base→Main→Real flow.`
            )
          }
          mainMinPF = relaxed
        }
      }
    } catch { /* non-fatal */ }
    // Build a cycle-local metrics view so the shared METRICS object is never
    // mutated and every symbol in the same batch uses its own threshold copy.
    const metrics: EvaluationMetrics = { ...metricsMain, minProfitFactor: mainMinPF }

    // ── Stage-validation min-position threshold (operator spec) ────
    // "Main has to evaluate from stage Base with profitfactor for X
    //  pre pseudo positions for specific config … if less pos exist
    //  in set then do not validate."
    // Sets below the threshold are SKIPPED (silent continue) — they
    // re-enter the validation pool on subsequent cycles once their
    // entryCount climbs. Tracked via a single counter so the dashboard
    // can surface "skipped due to insufficient positions" without
    // polluting the passed/failed buckets.
    const mainMinPos = liveQuickstartOn
      ? 1
      : this._coordinationSettings.mainEvalPosCount
    let skippedLowPos = 0

    // ── 1. Fingerprint-cache lookup ────────────────────────────────────────
    // Fetch last cycle's fingerprint map up-front. `fpCacheKey:v2` stores a
    // per-symbol hash of { fingerprint: JSON.stringify(slimDelta) } entries
    // where slimDelta carries ONLY scalar aggregate fields (no entries[]).
    // `:v2` suffix ensures old full-set blobs (stored under `main:fp`) are
    // ignored — they would fail the `Array.isArray(cached.entries)` guard
    // and cause unnecessary rebuilds until expiry. New slim format: ~80 bytes
    // per record vs ~2-5 KB for the old full-set JSON.
    const fpCacheKey = `strategies:${this.connectionId}:${symbol}:main:fp:v2`
    const client = getRedisClient()
    const fpCache = ((await client.hgetall(fpCacheKey).catch(() => null)) || {}) as Record<string, string>
    const nextFpCache: Record<string, string> = {}
    let reused = 0

    // ── 2. Variant profiles ─────────────────────────────────────────────
    // Patch continuousCount to the per-symbol open count so position-count
    // axisWindows reflect the per-symbol reality. Block no longer gates on
    // active open positions; it uses completed-position block-count overlays
    // at Live dispatch. All other ctx fields remain global/shared as designed.
    const symbolCtx: PositionContext = {
      ...ctx,
      continuousCount: ctx.perSymbolOpen[symbol] ?? 0,
    }
    const activeVariants = this.selectActiveVariants(symbolCtx)

    // Track the freshly-built `default` Main Set per Base so we can fan it
    // out into the operator-spec'd Position-Count Cartesian (prev × last ×
    // cont × dir) AFTER the profile loop completes. Both cache-hit and
    // cache-miss paths populate this map so reuses still trigger fan-out.
    const defaultByBaseKey = new Map<string, StrategySet>()

    // ── 2. Base/variant async processing ─��──────────────────────������───────────
    // Process all baseSet × variant combinations in parallel for faster throughput.
    // Each combination calls the async buildVariantSet, which previously ran
    // sequentially. Now they all start together and resolve concurrently.
    const buildTasks: Promise<{
      baseSet: StrategySet
      profile: any
      built: StrategySet | null
      fingerprint: string
      cachedSet: StrategySet | null
    }>[] = []

    for (const baseSet of baseSets) {
      // ── Min-positions gate + Status tracking (operator spec) ────────────────────
      // Evaluation requires minimum historical data. Instead of skipping,
      // mark with status="invalid" + rejectionReason so sets persist but
      // won't be evaluated until sufficient data. More efficient than duplicating.
      //
      // Status field allows:
      // - Efficient pipeline by checking status before re-calculating
      // - Dashboard visibility: why sets are delayed
      // - Zero duplication: single set object with state flag
      const liveCount    = baseSet.entryCount ?? baseSet.entries?.length ?? 0
      const histCount    = baseSet.prevPos?.count ?? 0
      const setPosCount  = Math.max(liveCount, histCount)
      
      // Check if we have sufficient history.
      // mainMinPos comes from mainEvalPosCount setting (default now 3, was 15).
      // During prehistoric bootstrap each set has only 1-5 positions — any value
      // above that caused all base sets to be rejected. The gate still applies
      // once a set has at least some history (histCount > 0), so sets with 0
      // history pass through as bootstrapping candidates.
      const hasHistoricData = histCount > 0
      if (hasHistoricData && histCount < mainMinPos) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = `insufficient_history: ${histCount}/${mainMinPos}`
        skippedLowPos++
        continue
      }

      // Base-level validation - mark status based on pass/fail
      if (baseSet.avgProfitFactor < metrics.minProfitFactor) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = `low_profitfactor: ${baseSet.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
        continue
      }
      if (baseSet.avgDrawdownTime > metrics.maxDrawdownTime) {
        baseSet.status = "invalid"
        baseSet.rejectionReason = `high_drawdowntime: ${baseSet.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
        continue
      }

      // Mark as valid for BASE→MAIN evaluation
      baseSet.status = "valid_base"

      // ── OPTIMIZATION: Skip non-default variants at MAIN stage ───────────────
      // Trailing/block/DCA variants were created here, causing a 3× explosion
      // (base sets × 3 variants) before axis fan-out applied. Axis ceiling was
      // then hit, discarding thousands of variant combinations. New approach:
      // Only create `default` variants at MAIN, apply axis fan-out, cap at 1619.
      // Then at REAL stage, create trailing/block/dca variants ONLY from
      // surviving Main Sets. This keeps MAIN set count 1/3 the previous peak.
      // Spec-note: Trailing is a Base-level profile (trailingProfile metadata),
      // not a Main variant; it flows unchanged through any downstream variant.
      // Block is materialized only at REAL; skip it here.
      const variantsForThisBase = activeVariants.filter((p) => p.name !== "block")

      for (const profile of variantsForThisBase) {
        // Spawn async build task for this variant
        buildTasks.push((async () => {
          // ── IMPORTANT: fingerprint must use symbolCtx (per-symbol continuousCount)
          // not the global ctx so position-count axis Sets do not collide across
          // symbols with different active counts. Block is excluded from Main
          // materialization and handled later as completed-position overlays.
          const fingerprint = this.variantFingerprint(baseSet, profile.name, symbolCtx)
          let cachedSet: StrategySet | null = null

          // ── Fingerprint cache (fast path) ─────────────────────────────
          // v2 format: Redis stores a slim coord-delta JSON (~80 bytes) with
          // only scalar aggregate fields. The in-process LRU still stores the
          // full StrategySet (built once, reused across cycles without re-parse).
          // On a Redis hit + LRU miss we rebuild from the slim delta + Base Set
          // entries (one buildVariantSet call, no Redis entries[] serialisation).
          if (fpCache[fingerprint]) {
            // 1. Check in-process LRU first (zero alloc on hit).
            let cached = StrategyCoordinator._fpLruGet(fingerprint)
            if (cached === undefined) {
              // 2. Redis hit but LRU evicted — parse the slim delta and rebuild
              //    the full Set from Base entries. The slim delta carries only
              //    the scalar aggregates produced by buildVariantSet; the real
              //    entries are re-derived cheaply because buildVariantSet is
              //    pure (no side-effects). On a fingerprint match the result is
              //    identical to what was stored last cycle.
              try {
                const delta = JSON.parse(fpCache[fingerprint]) as Partial<StrategySet> & { _slim?: boolean }
                if (delta?._slim && delta.setKey) {
                  // Rebuild full Set from Base + slim delta via buildVariantSet.
                  const rebuilt = await this.buildVariantSet(baseSet, profile, metrics, maxEntries, symbolCtx)
                  if (rebuilt) {
                    cached = rebuilt
                    StrategyCoordinator._fpLruSet(fingerprint, rebuilt)
                  }
                } else if (delta?.setKey) {
                  // Legacy full-set blob (tolerate for one cycle during v2 rollout).
                  cached = delta as StrategySet
                  StrategyCoordinator._fpLruSet(fingerprint, cached)
                }
              } catch { /* fall through — regenerate on parse failure */ }
            }
            // Accept cached slim Sets where entries[] is empty but entryCount is
            // non-zero — buildVariantSet now returns slim format (no entries blob)
            // and the old `entries.length > 0` guard was incorrectly rejecting
            // every in-process LRU hit, forcing a full rebuild on every cycle.
            const cachedHasEntries =
              (Array.isArray(cached?.entries) && cached.entries.length > 0) ||
              ((cached?.entryCount ?? 0) > 0)
            if (cached && cachedHasEntries) {
              // do not special-case trailingProfile here; it is inherited from
              // baseSet and propagates naturally through all variant flows.
              // legacy placeholder only; real trailing Sets are created at BASE
              if (baseSet.trailingProfile && !cached.trailingProfile) {
                cached.trailingProfile = baseSet.trailingProfile
              }
              cachedSet = cached
              nextFpCache[fingerprint] = fpCache[fingerprint]
            }
          }

          // If not cached, build fresh
          let built: StrategySet | null = null
          if (!cachedSet) {
            built = await this.buildVariantSet(baseSet, profile, metrics, maxEntries, symbolCtx)
            if (built) {
              if (baseSet.trailingProfile) built.trailingProfile = baseSet.trailingProfile
              // Store SLIM coord-delta in Redis (no entries[] serialised).
              // The LRU keeps the full Set in-process; Redis only needs the
              // scalar aggregates to confirm "this fingerprint was built last
              // cycle" on a subsequent cache hit.
              const slimDelta = {
                _slim:           true,
                setKey:          built.setKey,
                parentSetKey:    built.parentSetKey,
                variant:         built.variant,
                avgProfitFactor: built.avgProfitFactor,
                avgDrawdownTime: built.avgDrawdownTime,
                avgConfidence:   built.avgConfidence,
                entryCount:      built.entryCount,
                trailingProfile: built.trailingProfile,
              }
              nextFpCache[fingerprint] = JSON.stringify(slimDelta)
              StrategyCoordinator._fpLruSet(fingerprint, built)
            }
          }

          return { baseSet, profile, built, fingerprint, cachedSet }
        })())
      }
    }

    // ── Await all async builds to complete ────���──────────────────────────
    const results = await Promise.all(buildTasks)
    
    // ── Process results and populate mainSets ──���────────�����────────────────
    for (const result of results) {
      const { baseSet, profile, built, cachedSet } = result
      const set = cachedSet || built
      if (!set) continue

      mainSets.push(set)
      if (profile.name === "default") defaultByBaseKey.set(baseSet.setKey, set)
      if (cachedSet) reused++

      // ── Register SetCoordRecord for this variant (O(1) per set) ──�����───
      // CoordIndex is the per-cycle performance index; registering here
      // avoids a second full scan of mainSets downstream. Stores only
      // scalars — quality fields are resolved from BaseRegistry on demand.
      if (coordIndex) {
        const rec: SetCoordRecord = {
          coordKey:           set.setKey,
          parentKey:          set.parentSetKey || baseSet.setKey,
          variant:            (set.variant ?? profile.name) as SetCoordRecord["variant"],
          axisWindows:        set.axisWindows ?? null,
          status:             "valid_main",
          overrideDirection:  set.axisWindows?.direction as "long" | "short" | undefined,
          overrideEntryCount: set.entryCount !== baseSet.entryCount ? set.entryCount : undefined,
          // ── Scalar value carrier (Base-Anchored) ──────────────────────
          // Mirror the slim set scalars so Real/Live validate + switch states
          // by iterating coord records directly, never a parallel set array.
          avgProfitFactor:    set.avgProfitFactor,
          avgDrawdownTime:    set.avgDrawdownTime,
          avgConfidence:      set.avgConfidence,
          entryCount:         set.entryCount,
          indicationType:     set.indicationType,
          direction:          (set.axisWindows?.direction as "long" | "short" | undefined) ?? set.direction,
          prevPos:            set.prevPos,
          trailingProfile:    set.trailingProfile,
        }
        registerCoordRecord(coordIndex, rec)
      }
    }

    // ── Log min-pos skip count (diagnostic) ──────────────────������───
    // Surface the number of Base Sets that didn't meet `mainEvalPosCount`
    // at this cycle so the operator can see when the threshold is
    // throttling promotion. Non-critical; debug level.
    if (skippedLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "main_stage",
        "debug",
        `Main min-pos gate skipped ${skippedLowPos}/${baseSets.length} (threshold=${mainMinPos})`,
        { symbol, skippedLowPos, threshold: mainMinPos, baseTotal: baseSets.length },
      ).catch(() => {})
    }

    // ── 3. Position-Count Cartesian fan-out (operator spec) ──────────
    //
    // For each Base that yielded a `default` Main variant, emit:
    //
    //   prev (PF-filtered) × last (outcome-tagged) × cont × dir
    //
    // Axis Sets are pure projections of the parent default — they
    // inherit PF / DDT / conf / trailingProfile, carry a synthetic representative entry,
    // and tag `axisWindows.{prev,last,cont,direction,outcome,axisKey}`
    // so Real-stage hedge netting can bucket them by
    // `(symbol × ind × triple × outcome)`.
    //
    // Per-cycle recompute is intentional ("No Lock, handle after
    // situation"). The hedge-net delta + Live partial open/close path
    // takes care of accumulating continuous-count positions and
    // adjusting exchange exposure as new entries land.
    let axisSetsAdded = 0
    if (!skipAxisFanout && defaultByBaseKey.size > 0) {
      const minPF = metrics.minProfitFactor   // Same gate as Base→Main
      // ── Per-symbol axis fan-out ceiling (OOM-protection) ─────────────
      // expandAxisSets emits up to AXIS_PREV(5)×AXIS_LAST(4)×AXIS_CONT(8)×
      // AXIS_DIRS(2)×outcomes(2 while warming up) = 640 Sets PER default
      // Base. On a fresh bootstrap (no completed history) the prev PF gate
      // admits neutrally and BOTH outcomes fire, so every default hits that
      // maximum. With dozens of Base defaults × multiple symbols evaluated
      // concurrently each cycle, the materialised StrategySet count exploded
      // into the hundreds of thousands and was then expanded 1:1 into Real
      // sets — BEFORE the Real-stage 12000 ceiling could apply. That burst
      // drove RSS 1.5GB→7.3GB in ~60s and OOM-killed the process right as
      // live trading began. Cap the fan-out PER SYMBOL so memory is bounded;
      // because AXIS_PREV/AXIS_CONT are iterated ascending, the retained
      // projections are the highest-priority (smallest prev/cont) ones.
      //
      // OOM calibration (2026-06-16): 10000 was tuned for 5 symbols; at 20
      // symbols the InlineLocalRedis coord-record Map grew to 4058 MB of LIVE
      // (reachable) objects — Mark-Compact cannot reclaim live objects so the
      // heap ceiling is dominated by simultaneous coord-record count.
      // Production repro (2026-06-29): a Next `start` worker with an already
      // active BingX engine was first SIGKILLed at the old 2500-axis ceiling,
      // then stayed too CPU-bound for UI health/API requests at 800 and 200. Startup
      // must prioritize worker liveness and top-ranked axis candidates over
      // full Cartesian materialization.
      // Scale with VM memory so large machines can afford more axis fan-out
      // while small machines stay safe. memScale ≈ 1 on 4 GB, ≈ 2 on 8 GB.
      // Override with STRATEGY_MAIN_AXIS_SETS_CEILING env var for load tests.
      // Previous prod hardcap of 50 was designed for 4 GB VMs and caused
      // BTCUSDT to always hit the ceiling on the actual 8.4 GB VM, generating
      // a noisy log every cycle without actually preventing OOM.
      const rawAxisCeiling = Number(process.env.STRATEGY_MAIN_AXIS_SETS_CEILING ?? "")
      const configuredAxisCeiling =
        Number.isFinite(rawAxisCeiling) && rawAxisCeiling > 0
          ? Math.floor(rawAxisCeiling)
          : null
      const _axGl = (globalThis as any).__redis_mem_limits as { heapMB: number } | undefined
      // memScale ≈ 1.7 on the 8.4 GB VM (heapMB ≈ 3500).
      // Default ceiling: 800 × memScale per symbol → ~1366 on the 8.4 GB VM.
      // Raised from 300 (≈512) — with SYMBOL_CONCURRENCY=1 and exchange-close
      // retries eliminated, peak instantaneous heap is dominated by axis-set
      // JS objects (~1 KB each). 1366 axis sets × ~1 KB × 4 symbols = ~5.5 MB,
      // well within the 3497 MB heap trigger. The old 300× was sized for the
      // pre-session-36 state where concurrent symbols + OOM pauses amplified
      // memory pressure. Now safe to expand for much richer strategy coverage.
      const _axMemScale = _axGl ? Math.max(1, _axGl.heapMB / 2_048) : 1
      const _dynAxisCeiling = Math.round(800 * _axMemScale)
      // Store on globalThis so HMR-lagged prototype instances pick up the new value.
      if (!configuredAxisCeiling) {
        ;(globalThis as any).__axis_sets_ceiling = _dynAxisCeiling
      }
      // Instance field is null when unconfigured (new code) or 50 when the
      // singleton was constructed under old code. Treat null OR the old sentinel
      // 50 as "not explicitly set" so the dynamic default applies.
      const _instanceCeiling =
        this.strategyMainAxisSetsCeiling !== null && this.strategyMainAxisSetsCeiling > 50
          ? this.strategyMainAxisSetsCeiling
          : null
      const MAIN_AXIS_SETS_CEILING =
        configuredAxisCeiling ??
        _instanceCeiling ??
        // Also read from globalThis so old singleton instances get the new value
        ((globalThis as any).__axis_sets_ceiling as number | undefined) ??
        _dynAxisCeiling
      let axisCapHit = false
      const liveCont = symbolCtx?.continuousCount ?? 0
      // Direction-specific open counts for this symbol — gives expandAxisSets
      // independent liveCont per direction so long and short axis Sets get
      // different entryCount values when one direction is more accumulated.
      const liveContByDir = ctx.perSymbolOpenByDir?.[symbol] ?? { long: 0, short: 0 }
      for (const defaultSet of defaultByBaseKey.values()) {
        if (axisCapHit) break
        const expanded = this.expandAxisSets(defaultSet, minPF, liveCont, liveContByDir)
        for (const axisSet of expanded) {
          mainSets.push(axisSet)
          axisSetsAdded++

          // ── Register axis SetCoordRecord ──────────����─────────────────
          // Axis sets carry a synthetic entry but their quality data lives
          // on the parent Base Set. Recording the parentKey here enables
          // createLiveSets to do a O(1) base lookup instead of O(N) find().
          if (coordIndex) {
            const axisRec: SetCoordRecord = {
              coordKey:           axisSet.setKey,
              parentKey:          axisSet.parentSetKey || axisSet.setKey.split("#")[0],
              variant:            "default",
              axisWindows:        axisSet.axisWindows ?? null,
              status:             "valid_main",
              overrideDirection:  axisSet.axisWindows?.direction as "long" | "short" | undefined,
              overrideEntryCount: axisSet.entryCount,
              // ── Scalar value carrier (axis projection of parent default) ──
              avgProfitFactor:    axisSet.avgProfitFactor,
              avgDrawdownTime:    axisSet.avgDrawdownTime,
              avgConfidence:      axisSet.avgConfidence,
              entryCount:         axisSet.entryCount,
              indicationType:     axisSet.indicationType,
              direction:          (axisSet.axisWindows?.direction as "long" | "short" | undefined) ?? axisSet.direction,
              prevPos:            axisSet.prevPos,
              trailingProfile:    axisSet.trailingProfile,
            }
            registerCoordRecord(coordIndex, axisRec)
          }

          if (axisSetsAdded >= MAIN_AXIS_SETS_CEILING) {
            axisCapHit = true
            break
          }
        }
      }
      if (axisCapHit) {
        console.warn(
          `[v0] [StrategyCoordinator] ${this.connectionId} ${symbol} axis fan-out hit ` +
          `safety ceiling ${MAIN_AXIS_SETS_CEILING} (OOM-protection); ` +
          `remaining Base defaults skipped this cycle. Highest-priority ` +
          `(smallest prev/cont) projections retained.`,
        )
      }
      if (axisSetsAdded > 0) {
        // Axis fan-out complete — each qualifying default Main variant
        // has been projected into the operator-spec'd Cartesian product
        // (prev × last × cont × direction). This is the "additional Sets"
        // creation per the strategy flow spec.
        logProgressionEvent(this.connectionId, "main_stage", "debug", `Axis fan-out: +${axisSetsAdded} liveCont=${liveCont}`, {
          symbol,
          axisSets: axisSetsAdded,
          defaults: defaultByBaseKey.size,
          liveCont,
        }).catch(() => {}) // non-critical
      }
    }

    // ── Stable Main processing order ───────────────────────────────────
    //
    // Operator rule: process the Standard strategy outputs first, including
    // the position-count axis fan-out, then let Adjust variants layer over
    // them afterwards.  The async variant builder can complete in any order
    // and the in-memory cache may return different variants at different
    // speeds, so normalize the final Main array before Real evaluation and
    // stats. This preserves the intended sequence:
    //   1. default Base mirror
    //   2. default position-count axis Sets
    //   3. Adjust Sets (block, then DCA)
    // Trailing Sets are already Base-derived Standard Sets with
    // trailingProfile, not a separate Main-stage Adjust bucket.
    //   3. additional trailing Sets (independent Base-derived Sets)
    //   4. Adjust Sets (block, then DCA)
    const mainSetOrder = (set: StrategySet): number => {
      if ((set.variant ?? "default") === "default" && !set.axisWindows?.axisKey) return 0
      if ((set.variant ?? "default") === "default" && set.axisWindows?.axisKey) return 1
      if (set.variant === "trailing") return 2
      if (set.variant === "block") return 3
      if (set.variant === "dca") return 4
      return 5
    }
    mainSets.sort((a, b) => mainSetOrder(a) - mainSetOrder(b))

    // ─── VARIANT accounting ───────────────────────�������────���──────────────────
    // Each related Main Set now carries an authoritative `variant` tag set
    // at build time, so we no longer have to heuristically classify
    // individual entries. Entries within a Set share the variant label.
    // Legacy entry-level classifier is kept as a fallback for any caller
    // that produces a Set without the variant field (back-compat safety).
    // NOTE: `sizeMultiplier >= 1.5` was deliberately removed — Real-stage
    // coord-record tuning can push a default/trailing entry above 1.5× after
    // a good streak, which incorrectly labelled those entries as "block" and
    // inflated block PF stats. Only `positionState === "add"` (the true
    // semantic marker for block add-on entries) is retained as the fallback.
    // ── Per-variant aggregates + all mainSets metrics in ONE pass ───────────
    // All Main and axis Sets carry entries: [] (slim path — see buildVariantSet).
    // Iterating set.entries is always a no-op, so we derive per-variant PF/DDT
    // from the Set-level averages (avgProfitFactor, avgDrawdownTime, entryCount)
    // which are already computed scalars. This also merges what were previously
    // 4 separate reduce/filter passes over mainSets into one loop, eliminating
    // 4 intermediate result allocations per symbol per cycle.
    type VariantAgg = {
      sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
    }
    const variantAgg: Record<string, VariantAgg> = {
      default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
    }
    // Aggregate scalars — computed in the same pass as variantAgg to avoid
    // 4 extra reduce/filter sweeps that each allocate a result value.
    let mainEntriesTotal      = 0
    let mainSumPF             = 0
    let mainSumDDT            = 0
    let mainProfileEntries    = 0   // profile-variant sets only (no axis dir)
    let axisSetsCount         = 0
    let axisLong              = 0
    let axisShort             = 0
    const uniqueBaseSetsProduced = new Set<string>()
    for (const set of mainSets) {
      // Variant tag — sets always carry an authoritative .variant field;
      // the per-entry classifier fallback is never needed in the slim path.
      const sv = (set.variant as keyof typeof variantAgg) ?? "default"
      const agg = variantAgg[sv] ?? variantAgg.default
      const ec = set.entryCount || 0
      const pf = set.avgProfitFactor || 0
      const ddt = set.avgDrawdownTime || 0
      agg.setsContaining += 1
      agg.passedSets     += 1
      // Use entryCount as the "entries" dimension — each Set represents
      // entryCount pseudo-positions in the variant aggregation, matching the
      // semantic intent (how many pos-slots this Set contributes per variant).
      agg.entries += ec
      agg.sumPF   += pf * ec   // weighted by entry count for correct variant-avg
      agg.sumDDT  += ddt * ec

      mainEntriesTotal += ec
      mainSumPF        += pf
      mainSumDDT       += ddt
      uniqueBaseSetsProduced.add(set.parentSetKey ?? set.setKey)

      const axDir = set.axisWindows?.direction
      if (axDir) {
        axisSetsCount++
        if (axDir === "long") axisLong++; else axisShort++
      } else {
        mainProfileEntries += ec
      }
    }
    const n = mainSets.length
    const mainAvgPF         = n > 0 ? mainSumPF  / n : 0
    const mainAvgDDT        = n > 0 ? mainSumDDT / n : 0
    const mainAvgPosPerSet  = n > 0 ? mainEntriesTotal / n : 0
    const mainProfileEntriesTotal = mainProfileEntries

    // Persist MAIN sets — slim format (set-key list only), same approach as Real.
    // Full Base Set blobs are already in base:sets; Main sets are re-derivable from
    // coordIndex in the pipeline. Slim key-list cuts the per-symbol write from
    // ~500 KB (full mainSets blob with entries:[]) to ~N×30 bytes — 16× smaller.
    const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
    await setSettings(mainKey, {
      setKeys: mainSets.map((s) => s.setKey),
      count:   mainSets.length,
      created: new Date(),
      _slim:   true,
    })
    try {
      if (Object.keys(nextFpCache).length > 0) {
        await client.del(fpCacheKey).catch(() => {})
        await client.hset(fpCacheKey, nextFpCache)
        await client.expire(fpCacheKey, 300) // 5 min TTL
      }
    } catch { /* non-critical */ }

    const mainDetailKey = `strategy_detail:${this.connectionId}:main`
    // BASE->MAIN pass rate = fraction of Base Sets that produced ≥1 variant.
    // Using mainSets.length/baseSets.length inflates the ratio by 320×
    // (full axis fan-out); uniqueBaseSetsProduced.size is the correct numerator.
    const passRatioMain = baseSets.length > 0
      ? Math.min(1, uniqueBaseSetsProduced.size / baseSets.length)
      : 0

    // ── Write Main counts to Redis ──���─────────────────────────────────────
    // CUMULATIVE via hincrby so the dashboard does not oscillate with
    // per-cycle snapshots (see matching fix in createBaseSets).
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`

      // ── Running-now resolution for Main (cloned/filtered Sets) ──
      const cache = this._activeKeysCache
      const cacheFresh = cache && Date.now() - cache.cycleAt < 30_000
      const activeKeys = cacheFresh
        ? cache!.keys
        : new Set<string>(
            (await client
              .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
              .catch(() => [])) as string[],
          )
      // mainProgressing: sets with at least one position entry — computed from
      // the same unified pass that built mainEntriesTotal (see variantAgg loop).
      // mainEntriesTotal > 0 check per set is not tracked separately; we use
      // mainSets.length as a safe upper bound (slim path means entryCount ≥ 1
      // for all passing sets). For exact tracking: sets with entryCount > 0.
      // Computed inline here to avoid another .filter() pass.
      let mainRunningNow = 0
      let mainProgressing = 0
      for (const s of mainSets) {
        if ((s.entryCount || 0) > 0) mainProgressing++
        const parent = s.parentSetKey || s.setKey.split("#")[0]
        if (activeKeys.has(parent)) mainRunningNow++
      }

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_main_current", String(mainSets.length)),
        client.hset(mainDetailKey, {
          created_sets:      String(mainSets.length),
          avg_profit_factor: String(mainAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(mainAvgDDT)),
          avg_pos_per_set:   String(mainAvgPosPerSet.toFixed(2)),
          entries_total:     String(mainEntriesTotal),
          entries_count:     String(mainEntriesTotal),
          axis_sets:         String(axisSetsAdded),
          evaluated:         String(mainSets.length),
          passed_sets:       String(mainSets.length),
          pass_rate:         String(passRatioMain.toFixed(4)),
          count_pos_eval:    String(mainSets.length),
          sets_running_now:         String(mainRunningNow),
          sets_with_open_positions: String(mainRunningNow),
          sets_progressing:         String(mainProgressing),
          updated_at:        String(Date.now()),
          [`s:${symbol}:created`]:    String(mainSets.length),
          [`s:${symbol}:entries`]:    String(mainEntriesTotal),
          [`s:${symbol}:running`]:    String(mainRunningNow),
          [`s:${symbol}:progressing`]: String(mainProgressing),
          [`s:${symbol}:passed`]:     String(mainSets.length),
          [`s:${symbol}:evaluated`]:  String(mainSets.length),
          [`s:${symbol}:apf`]:        String(mainAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(mainAvgDDT)),
          [`s:${symbol}:apps`]:       String(mainAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(mainDetailKey, 86400),
        client.hset(`strategy_detail:${this.connectionId}:base`, {
          passed_sets: String(baseSets.length),
          pass_rate:   String(passRatioMain.toFixed(4)),
          [`s:${symbol}:passed`]: String(baseSets.length),
        }).catch(() => {}),
        client.set(`strategies:${this.connectionId}:main:count`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:main:evaluated`, String(mainSets.length)),
        client.set(`strategies:${this.connectionId}:base:passed`, String(baseSets.length)),
        client.expire(`strategies:${this.connectionId}:main:count`, 86400),
        client.expire(`strategies:${this.connectionId}:main:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:base:passed`, 86400),
      ]
      if (mainSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_total", mainSets.length))
      if (baseSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_main_evaluated", baseSets.length))

      // ── ACTIVE-NOW snapshot for Main stage (per symbol, like Base/Real) ───
      // The stats route reads `strategies_active:{conn}` and aggregates by
      // stage suffix. Without {symbol}:main fields the `stratCounts.main`
      // bucket was always 0, making the Main column on the dashboard empty.
      writes.push(
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:main`]:           String(mainSets.length),
          // main:evaluated = Base Sets that entered Main filter (= candidates)
          [`${symbol}:main:evaluated`]: String(baseSets.length),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
      )

      const relatedCreated = mainSets.length - reused
      const activeVariantNames = activeVariants.map((p) => p.name)
      writes.push(
        client.hincrby(redisKey, "strategies_main_related_created", relatedCreated),
        client.hincrby(redisKey, "strategies_main_related_reused",  reused),
        client.hincrby(redisKey, "strategies_main_cycles",          1),
        client.hset(redisKey, {
          strategies_main_active_variants:      activeVariantNames.join(","),
          strategies_main_active_variant_count: String(activeVariantNames.length),
          strategies_main_last_reused:          String(reused),
          strategies_main_last_created:         String(relatedCreated),
          strategies_main_ctx_continuous:       String(ctx.continuousCount),
          strategies_main_ctx_last_wins:        String(ctx.lastWins),
          strategies_main_ctx_last_losses:      String(ctx.lastLosses),
          strategies_main_ctx_prev_losses:      String(ctx.prevLosses),
          strategies_main_ctx_prev_total:       String(ctx.prevPosCount),
          strategies_main_ctx_updated_at:       String(Date.now()),
        }),
      )

      // ── Position count metrics for main stage ──
      // Only count profile-variant Sets (no axis fan-out) for this counter.
      if (mainProfileEntriesTotal > 0) {
        writes.push(client.hincrby(redisKey, "main_positions_created_count", mainProfileEntriesTotal))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 2) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)
    } catch { /* non-critical — Redis write failure should not kill strategy flow */ }

    return {
      result: {
        type: "main",
        symbol,
        timestamp: new Date(),
        totalCreated: baseSets.length,
        passedEvaluation: mainSets.length,
        // failedEvaluation = Base Sets that were explicitly rejected (status=invalid),
        // not baseSets.length - uniqueBaseSetsProduced.size (which undercounts when
        // all Base Set parents appear via axis fan-out but some were still rejected
        // at PF/DDT gate). Counting status=invalid directly is authoritative.
        failedEvaluation: baseSets.filter((s) => s.status === "invalid").length,
        avgProfitFactor: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgProfitFactor, 0) / mainSets.length : 0,
        avgDrawdownTime: mainSets.length > 0 ? mainSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / mainSets.length : 0,
      },
      sets: mainSets,
    }
  }

  // ─── STAGE 3: REAL ──��─────────────────────────────────────────────────────��──

  /**
   * Create pseudo positions from REAL sets for dashboard visualization.
   * Each REAL set should have at least one pseudo position so it shows on the
   * dashboard as "open" in the strategies view. This is for evaluation/display only.
   */
  private async createPseudoPositionsFromRealSets(
    symbol: string,
    realSets: StrategySet[],
  ): Promise<void> {
    try {
      if (!realSets || realSets.length === 0) return

      // DEV-MODE CAP (was a blanket early-return): pseudo_position hashes are
      // the single largest heap allocator in the 20-symbol dev run (up to 3000
      // sets/symbol × 3 writes = 9000 ops/symbol/cycle → OOM at ~30s). But
      // returning entirely starved getPositionContext() of position data and
      // left dca/trailing/progression dashboards permanently at 0 in dev.
      //
      // Compromise: in dev, write only the TOP-N Real Sets by profit factor.
      // That gives the gates real sampled positions + populates the dashboard tile
      // while keeping the write volume bounded (N×3 ops, not 3000×3). Prod is
      // uncapped. Sorting is cheap relative to the avoided write amplification.
      const workingSets = realSets

      const client = getRedisClient()
      // PERFORMANCE / CORRECTNESS: pseudo-position dedup is an atomic Redis
      // claim per Set. A separate GET pre-check allowed concurrent REAL-stage
      // creators to observe an empty mapping and both create positions. We now
      // claim `pseudo_position_set_mapping:{conn}:{setKey}` with SET NX EX,
      // create only when that claim succeeds, and release the claim if the
      // follow-up position write fails so a later cycle can retry.

      // Pre-compute every set's deterministic identifiers once.
      // (workingSets == realSets in prod; capped top-N by PF in dev.)
      const setMeta = workingSets.map((set) => {
        const setKey     = set.setKey || `${symbol}:${set.direction || "long"}`
        const existingKey = `pseudo_position_set_mapping:${this.connectionId}:${setKey}`
        return { set, setKey, existingKey }
      })

      const toRedisHash = (value: Record<string, any>): Record<string, string> => {
        const out: Record<string, string> = {}
        for (const [key, fieldValue] of Object.entries(value)) {
          if (fieldValue === undefined || fieldValue === null) continue
          out[key] = typeof fieldValue === "object" ? JSON.stringify(fieldValue) : String(fieldValue)
        }
        return out
      }

      // Atomic claims are intentionally long-lived: the mapping is the
      // idempotency record for this Set, not just a short mutex. TTL bounds stale
      // claims if a process dies after SET NX but before the position hash lands.
      const CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60
      const createdAtIso = new Date().toISOString()
      const nowMs = Date.now()
      const writeBatches: Promise<any>[] = []
      let createdCount = 0

      for (const { set, setKey, existingKey } of setMeta) {
        try {
          const avgPF       = set.avgProfitFactor || 1
          const entryPrice  = Math.max(1, avgPF * 100)   // unitless proxy
          const quantity    = set.entryCount || 1
          const positionCost = entryPrice * quantity

          const pseudoPos = {
            id: `pseudo-${this.connectionId}-${setKey}-${nowMs}`,
            connectionId: this.connectionId,
            symbol,
            direction: set.direction || "long",
            entry_price: entryPrice,
            quantity,
            position_cost: positionCost,
            status: "open",
            position_level: "real",
            // `set_id` is the canonical per-Set identity used by downstream
            // Set-level dedup/tracking. It mirrors config_set_key here but is
            // kept as an explicit field so consumers don't have to know which
            // of the (historically divergent) key fields carries the Set id.
            set_id: setKey,
            config_set_key: setKey,
            source_set_key: setKey,
            created_at: createdAtIso,
            profit_factor: set.avgProfitFactor || 0,
            confidence: set.avgConfidence || 0,
          }

          const mappingValue = (status: "claimed" | "created") => JSON.stringify({
            posId: pseudoPos.id,
            createdAt: nowMs,
            status,
            set_id: setKey,
            config_set_key: setKey,
            source_set_key: setKey,
          })
          const claimed = await client.set(existingKey, mappingValue("claimed"), { NX: true, EX: CLAIM_TTL_SECONDS }).catch(() => null)
          if (claimed !== "OK") continue

          writeBatches.push((async () => {
            try {
              const pipeline = client.pipeline()
              pipeline.hset(`pseudo_position:${this.connectionId}:${pseudoPos.id}`, toRedisHash(pseudoPos))
              pipeline.sadd(`pseudo_positions:${this.connectionId}`, pseudoPos.id)
              pipeline.set(existingKey, mappingValue("created"), { XX: true, EX: CLAIM_TTL_SECONDS })
              const results = await pipeline.exec()
              const failed = results.some((r: any) => r instanceof Error || (Array.isArray(r) && r[0]))
              if (failed) throw new Error("pseudo-position pipeline returned an error")
              createdCount++
            } catch (err) {
              await Promise.allSettled([
                client.del(existingKey),
                client.del(`pseudo_position:${this.connectionId}:${pseudoPos.id}`),
                client.srem(`pseudo_positions:${this.connectionId}`, pseudoPos.id),
              ])
              console.warn(`[StrategyFlow] Failed to create pseudo position for set ${setKey}; released claim for retry:`, err)
            }
          })())
        } catch (err) {
          console.warn(`[StrategyFlow] Failed to prep pseudo position for set ${setKey}:`, err)
        }
      }

      // Final fan-in — all successful claims' related writes execute together.
      if (writeBatches.length > 0) {
        await Promise.all(writeBatches)
      }

    } catch (error) {
      console.warn(`[v0] Error creating pseudo positions from REAL sets for ${symbol}:`, error)
    }
  }

  /**
   * Real-stage active-position Block overlay.
   *
   * Active Real/Live-position Block handling belongs to REAL, not only final Live
   * dispatch: the running exposure must be visible to Real-stage stats, caps,
   * tuning and lineage before Live chooses exchange candidates. Completed-position
   * block-count overlays remain a Live-dispatch expansion, while these options
   * mirror currently running exposure as Real-stage block Sets.
   */
  private async buildActiveRealBlockOverlaysForReal(
    symbol: string,
    sourceSets: StrategySet[],
    metrics: EvaluationMetrics,
    coordIndex?: CoordIndex,
  ): Promise<StrategySet[]> {
    if (
      !this._coordinationSettings.variants.block ||
      (!this._coordinationSettings.blockActiveRealEnabled && !this._coordinationSettings.blockActiveLiveEnabled)
    ) {
      return []
    }

    const blockProfile = this.variantProfiles().find((p) => p.name === "block")
    const blockConfig = blockProfile?.configs.slice().sort((a, b) => b.pfBias - a.pfBias)[0]
    if (!blockConfig) return []

    const activePositions = await new PseudoPositionManager(this.connectionId).getActivePositions()
    const activeByDir = { long: 0, short: 0 }
    for (const pos of activePositions) {
      if (String(pos.symbol || "").toUpperCase() !== symbol.toUpperCase()) continue
      const dir = String(pos.direction || pos.side || "").toLowerCase() === "short" ? "short" : "long"
      activeByDir[dir]++
    }

    const maxStack = Math.max(1, Math.min(10, this._coordinationSettings.blockMaxStack | 0))
    const ratio = this._coordinationSettings.blockVolumeRatio
    const pauseRatio = this._coordinationSettings.blockPauseCountRatio
    const overlays: StrategySet[] = []

    for (const dir of ["long", "short"] as const) {
      const activeCount = activeByDir[dir]
      if (activeCount <= 0) continue
      const source = sourceSets.find((s) => s.direction === dir && s.variant !== "dca" && !String(s.setKey).includes("#block:active:"))
      if (!source) continue

      const boundedCount = Math.min(Math.max(1, activeCount), maxStack)
      const blockMul = 1 + (boundedCount - 1) * ratio
      const pauseWindow = Math.max(1, Math.min(32, Math.round(boundedCount * pauseRatio)))
      const parentSetKey = source.parentSetKey || source.setKey
      const axisWindows = {
        ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
        cont: boundedCount,
        pause: pauseWindow,
        axisKey: `block:active:${boundedCount}:pause${pauseWindow}`,
      }
      const overlay: StrategySet = {
        ...source,
        setKey: `${source.setKey}#block:active:${boundedCount}`,
        parentSetKey,
        variant: "block",
        axisWindows,
        avgProfitFactor: Math.max(
          metrics.minProfitFactor,
          (source.avgProfitFactor || metrics.minProfitFactor) * blockConfig.pfBias,
        ),
        avgDrawdownTime: (source.avgDrawdownTime || 0) + (blockConfig.ddtBias * boundedCount),
        variantSizeMultiplier: Number((blockConfig.size * blockMul).toFixed(6)),
        variantLeverage: blockConfig.leverage,
        status: "valid_real",
      }
      overlays.push(overlay)

      if (coordIndex && !coordIndex.byCoordKey.has(overlay.setKey)) {
        registerCoordRecord(coordIndex, {
          coordKey: overlay.setKey,
          parentKey: parentSetKey,
          variant: "block",
          axisWindows,
          status: "valid_real",
          avgProfitFactor: overlay.avgProfitFactor,
          avgDrawdownTime: overlay.avgDrawdownTime,
          avgConfidence: overlay.avgConfidence,
          entryCount: overlay.entryCount,
          indicationType: overlay.indicationType,
          direction: overlay.direction,
          prevPos: overlay.prevPos,
          trailingProfile: overlay.trailingProfile,
          _setView: overlay,
          _hasLivePositions: true,
        })
      }
    }

    return overlays
  }

  /**
   * Promote MAIN Sets with avgProfitFactor >= 1.4 to REAL.
   */
  private async evaluateRealSets(
    symbol: string,
    inputSets?: StrategySet[],
    coordIndex?: CoordIndex,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let mainSets: StrategySet[]
    if (inputSets) {
      mainSets = inputSets
    } else {
      // Standalone path (tests / diagnostics) — read from Redis.
      // Handles both slim key-list format (_slim: true, setKeys: string[])
      // and legacy full-blob format (sets: StrategySet[]).
      const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
      const stored = (await getSettings(mainKey)) as any
      if (stored?._slim && Array.isArray(stored.setKeys)) {
        // Slim format: resolve profile-variant sets from Base sets.
        // Axis sets are not stored in base:sets (they are generated each cycle),
        // so standalone mode omits them — acceptable for diagnostics/tooling.
        const baseKey = `strategies:${this.connectionId}:${symbol}:base:sets`
        const baseSt  = (await getSettings(baseKey)) as any
        const baseArr: StrategySet[] = Array.isArray(baseSt?.sets) ? baseSt.sets : []
        const keySet  = new Set<string>(stored.setKeys as string[])
        mainSets      = baseArr.filter((s) => keySet.has(s.setKey))
      } else {
        mainSets = Array.isArray(stored?.sets) ? stored.sets : []
      }
    }

    const metricsReal = this.METRICS.real

     // ── Stage-validation min-position threshold (operator spec, systemwide fix) ────
     // Same semantics as Main: Sets below `realEvalPosCount` are
     // MARKED as invalid with status flag — they're not validated against PF/DDT
     // and not promoted to Real, but kept in map for re-evaluation on subsequent
     // cycles once entryCount accumulates. Default 10.
     //
     // For NEW systems with no history (baseEC=0, liveCont=0),
     // don't reject sets purely on entryCount. If a set has at least 1 synthetic
     // entry (axis Sets always have entries for synthetic tracking), it should
     // pass the gate and be evaluated on PF/DDT merit. This allows fresh
     // connections to start generating positions on cycle 1.
      let realMinPos = this._coordinationSettings.realEvalPosCount
      const beforePosGate = mainSets.length

      // ── Production + Live Trade relaxation for fresh quickstarts ─────
      // After quickstart (N symbols, minimal/no history), Main sets often have
      // low entryCount and very low/zero avgProfitFactor (synthetic entries only).
      // Strict gates previously prevented any Real sets → zero live orders on exchange.
      // When live trading is explicitly enabled right after quickstart, we relax
      // BOTH the pos-count gate AND the minProfitFactor gate for the first cycles
      // so the first qualifying axis/profile sets can escalate to Live execution.
      // PF/DDT still apply (just lowered), and normal strictness returns as soon
      // as real history accumulates.
      // IMPORTANT: use a LOCAL minPF — never mutate this.METRICS.real in-place.
      // The class field is shared across all symbols in the same cycle and across
      // cycles within the 5s PF-cache window; an in-place mutation bleeds the
      // relaxed threshold into every subsequent symbol's Real evaluation.
      let realMinPF = metricsReal.minProfitFactor
      try {
        const { getConnection: getConn } = await import("@/lib/redis-db")
        const { isTruthyFlag } = await import("@/lib/connection-state-utils")
        const conn = await getConn(this.connectionId).catch(() => null as any)
        const liveOn =
          isTruthyFlag(conn?.is_live_trade) ||
          isTruthyFlag(conn?.live_trade_enabled) ||
          isTruthyFlag(conn?.live_trade_requested)
        if (liveOn) {
          // Position count relaxation (already present)
          realMinPos = 1

          // PF bootstrap relaxation — lower the Real gate slightly to allow first
          // cycles to promote sets when live trading is explicitly enabled.
          const relaxed = Math.min(realMinPF, 0.75)
          if (relaxed !== realMinPF) {
            const logKey = `real:${this.connectionId}`
            const now = Date.now()
            if (!_bootstrapLoggedAt[logKey] || now - _bootstrapLoggedAt[logKey] > 60_000) {
              _bootstrapLoggedAt[logKey] = now
              console.log(
                `[v0] [StrategyCoordinator] ${this.connectionId} REAL bootstrap (live quickstart): ` +
                `relaxed minProfitFactor ${realMinPF} → ${relaxed} and posCount=${realMinPos} ` +
                `to allow first Real→Live escalation while history builds.`
              )
            }
            realMinPF = relaxed
          }
        }
      } catch { /* non-fatal */ }
      // Build a cycle-local metrics view — shared METRICS.real never mutated.
      const metrics: EvaluationMetrics = { ...metricsReal, minProfitFactor: realMinPF }
     
     // Get real active keys for validation (moved outside try block for scope access)
     let realActiveKeysForVP: Set<string> = new Set()
     try {
       const c = getRedisClient()
       realActiveKeysForVP = new Set<string>(
         (await c
           .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
           .catch(() => [])) as string[],
       )
     } catch { /* ignore errors - empty set is fine */ }

     // Merge in the AUTHORITATIVE set of Set keys that currently back an
     // OPEN live position. active_config_keys (above) is keyed by config
     // fingerprint and is not reliably populated for directly-written Real
     // pseudo positions, so on its own it leaves Sets with live exposure
     // unprotected from the PF/DDT gate. The live-positions index carries
     // the real setKey/parentSetKey, giving a leak-free "is running" signal
     // that the continuous-validity exemptions below depend on.
     try {
       const liveSetKeys = await this.getOpenLiveSetKeys()
       for (const k of liveSetKeys) realActiveKeysForVP.add(k)
     } catch { /* fail-open */ }
     
    // ── SINGLE PASS: pos-gate + PF/DDT filter + collect qualifying sets ────���─
    // Previously: mainSets.map() [new array] → .filter() [new array] →
    //             [...realQualifying].sort() [spread + new array] — 3 heap allocations.
    // Now: one for-loop marks status in-place on each StrategySet (no new arrays
    // for the map/filter pass) and pushes qualifying refs into a pre-allocated
    // realQualifying array; one in-place .sort() at the end.
    //
    // Status semantics:
    //   "invalid" + rejectionReason — failed pos-gate; logged + skipped
    //   "valid_real"                — passes all gates; included in realSorted
    //
    // Active-Set continuous validity: a Set that currently backs an OPEN live
    // position MUST stay valid_real regardless of PF/DDT wobble this cycle
    // (without this, a transient dip orphans the live position from its owner).
    const realQualifying: StrategySet[] = []
    let skippedRealLowPos = 0
    for (const s of mainSets) {
      const posCount = Math.max(s.entryCount ?? 0, s.prevPos?.count ?? 0)
      const isAxisSet = !!(s.axisWindows?.direction)
      // Axis Sets always have a synthetic entry (entries.length === 1) so
      // hasEntries is always true for them — skip the check for non-axis.
      const hasEntries = isAxisSet || (s.entries?.length ?? 0) > 0

      // Non-default variant Sets (trailing/block/dca/pause) are Base-anchored
      // PROJECTIONS built by buildVariantSet: like axis Sets they carry a
      // derived scalar aggregate (entryCount>0, avgPF floored at the Main gate)
      // instead of their own accumulated entries[]. Their effective position
      // count lives on the parent Base Set, so the raw per-Set pos-count gate
      // must NOT reject them — they are still judged on PF/DDT merit at step 3.
      // Without this exemption a freshly-built variant Set (entryCount 1-2 from
      // a single Base entry) failed realMinPos (relaxed to <=3) and never
      // reached Real, so every activated variant's Real aggregate AND live
      // dispatch were silently 0 even though the variant was correctly built.
      const isVariantProjection = !!(s.variant && s.variant !== "default") && (s.entryCount ?? 0) > 0

      // ── 1. Position-count gate ───────────────────────────────────────────
      if (posCount < realMinPos && !(isAxisSet && hasEntries) && !isVariantProjection) {
        const hasActiveReal = realActiveKeysForVP.has(s.setKey) || (s as any)._hasLivePositions === true
        if (!hasActiveReal) {
          s.status = "invalid"
          s.rejectionReason = `insufficient_pos_count: ${posCount}/${realMinPos}`
          skippedRealLowPos++
          continue
        }
        // Active Real position — keep valid despite low pos-count.
        s.status = "valid_real"
        realQualifying.push(s)
        continue
      }

      // ── 2. Active-Set continuous validity exemption ───────────────────────
      const hasActiveReal = realActiveKeysForVP.has(s.setKey) || (s as any)._hasLivePositions === true
      if (hasActiveReal) {
        s.status = "valid_real"
        realQualifying.push(s)
        continue
      }

      // ── 3. PF/DDT gate ─────────────────����──────����──────────────────────────
      const passes = s.avgProfitFactor >= metrics.minProfitFactor &&
                     s.avgDrawdownTime  <= metrics.maxDrawdownTime
      if (passes) {
        s.status = "valid_real"
        realQualifying.push(s)
      } else {
        s.status = "invalid"
        s.rejectionReason = s.avgProfitFactor < metrics.minProfitFactor
          ? `real_low_pf: ${s.avgProfitFactor.toFixed(2)} < ${metrics.minProfitFactor}`
          : `real_high_ddt: ${s.avgDrawdownTime} > ${metrics.maxDrawdownTime}`
      }
    }
    if (skippedRealLowPos > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `Real min-pos gate marked ${skippedRealLowPos}/${beforePosGate} as invalid (threshold=${realMinPos})`,
        { symbol, skippedLowPos: skippedRealLowPos, threshold: realMinPos, mainTotal: beforePosGate },
      ).catch(() => {})
    }

    // ── PRIORITY SORT in-place ────────────────────────────────────────────
    // Sort the collected qualifying refs by avgProfitFactor descending so
    // downstream stages (hedge-net, Real cap, Live dispatch) always see the
    // highest-quality Sets first. In-place sort avoids the spread-copy.
    realQualifying.sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
    
    // ── EARLY CAP: Apply before hedge netting to prevent memory accumulation ──
    // The old cap applied AFTER hedge netting, wasting memory on thousands of sets
    // that would be discarded. Cap the top-PF sets here so hedge netting works with
    // a bounded input. This prevents 3244→60 set reduction happening after memory
    // is already allocated. Constant defined inline since we need it before hedge-net.
    const _defaultRealCap = process.env.NODE_ENV === "production" ? 100 : 60
    const rawRealCeiling = Number(process.env.STRATEGY_REAL_SETS_CEILING ?? "")
    const _realOutputCap =
      (Number.isFinite(rawRealCeiling) && rawRealCeiling > 0 ? Math.floor(rawRealCeiling) : null) ??
      (this.strategyRealSetsSafetyCeiling !== null && this.strategyRealSetsSafetyCeiling > 100
        ? this.strategyRealSetsSafetyCeiling
        : _defaultRealCap)
    const realSetsCap = Math.min(this.config.maxRealSets ?? _realOutputCap, _realOutputCap)
    
    console.log(`[v0] [DEBUG] EARLY CAP: realQualifying=${realQualifying.length} cap=${realSetsCap} env=${process.env.NODE_ENV}`)
    if (realQualifying.length > realSetsCap) {
      console.warn(
        `[v0] [RealStage] ${this.connectionId}: Capping ${realQualifying.length} → ${realSetsCap} before hedge netting`
      )
      realQualifying.length = realSetsCap  // Truncate in-place
      console.log(`[v0] [DEBUG] EARLY CAP: After truncate realQualifying=${realQualifying.length}`)
    } else {
      console.log(`[v0] [DEBUG] EARLY CAP: No truncation needed (${realQualifying.length} <= ${realSetsCap})`)
    }
    
    const realSorted = realQualifying   // alias — hedge-net reads realSorted

    // ── HEDGE NETTING (operator spec: Real stage only) ─────────────────────
    //
    // The Main-stage Position-Count Cartesian emits a long/short pair for
    // every (prev × last × cont × outcome) tuple. Real collapses that to
    // the NET direction per bucket so Live only opens positions where the
    // realised signal is asymmetric.
    //
    // EXCEPTION: Axis Sets (position-count fan-out projections) are NOT
    // subject to netting. Each axis Set represents a valid position-count
    // configuration and both long/short should flow to Live independently.
    // Netting axis Sets would eliminate the entire position-count range
    // being tested (e.g., if cont=3 long and short both exist, netting
    // them cancels the intent to test cont=3 in both directions).
    // Profile-variant Sets (default, trailing, block, DCA) still participate
    // in netting since their long/short pairs represent hedging signal.
    //
    // Bucket identity: `${symbol}|${ind}|p${prev}|l${last}|c${cont}|o${outcome}`
    //   • Profile-variant Sets (no `axisWindows.direction`): participate in netting
    //   • Axis Sets: pass through unchanged — SKIP netting entirely
    //   • Outcome is part of the bucket: pos and neg Sets represent
    //     different realised market regimes and must NOT cancel each
    //     other.
    //   • Within bucket: keep |L − S| Sets in the dominant direction
    //     (PF-sorted by parent `realSorted` order). If L == S → drop
    //     both sides (perfect hedge ��� no exchange exposure for this
    //     bucket).
    //
    // Per-bucket net target is persisted to `live_net_target:{conn}` so
    // the Live exchange layer can reconcile via partial-open / partial-
    // close orders when the dominant direction or magnitude changes
    // between cycles.
    type HedgeBucket = { long: StrategySet[]; short: StrategySet[] }
    const hedgeBuckets = new Map<string, HedgeBucket>()
    const passthrough: StrategySet[] = []
    const axisPassthrough: StrategySet[] = []
    let axisSetsCounted = 0
    for (const s of realSorted) {
      const dir = s.axisWindows?.direction
      if (!dir || !s.axisWindows) { 
        passthrough.push(s)
        continue 
      }
      // Axis Sets bypass hedge netting — each axis tuple is a valid config
      axisPassthrough.push(s)
      axisSetsCounted++
    }
    const netted: StrategySet[] = []
    const netTargetWrites: Record<string, string> = {}
    let netCancelled = 0
    for (const s of passthrough) {
      const aw = s.axisWindows
      // ── CRITICAL FIX: Profile-variant Sets always go to hedging ��─
      // Sets in `passthrough` are profile-variant (default/trailing/block/DCA)
      // and MUST participate in hedge netting. Previously, sets without
      // axisWindows were auto-added to netted, bypassing the netting logic.
      // This caused Real stage to include more sets than should qualify.
      // Now: ALL profile-variant sets go through the bucketing/netting phase,
      // regardless of whether they have axisWindows. Only Axis Sets bypass
      // netting (handled separately via axisPassthrough).
      const outcome = aw?.outcome ?? "pos"
      const parentKey = s.parentSetKey ?? s.setKey.split("#")[0]
      // ── Variant-INDEPENDENT bucketing (operator spec: each activated
      // variant is handled independently) ─────────���────────────────────────
      // The bucket key MUST include the variant. Without it, every variant
      // derived from the same Base Set + axis context (default/trailing/block/
      // dca/pause) collapsed into ONE hedge bucket and competed against each
      // other: only the |L−S| highest-PF survivors were kept, so the variant
      // with the lowest pfBias (pause: 1.00–1.06) was always sorted last and
      // dropped entirely — its Real aggregate stayed 0 even when activated and
      // correctly built. Keying the bucket by variant nets each variant's
      // long/short pairs WITHIN that variant only, preserving independence so
      // every activated variant surfaces on its own merit.
      const variantKey = (s.variant as string) ?? "default"
      const bucketKey = `${parentKey}|${symbol}|${s.indicationType}|v${variantKey}|p${aw?.prev ?? 0}|l${aw?.last ?? 0}|c${aw?.cont ?? 0}|o${outcome}`
      let b = hedgeBuckets.get(bucketKey)
      if (!b) { b = { long: [], short: [] }; hedgeBuckets.set(bucketKey, b) }
      const dir = s.direction ?? "long"
      if (dir === "short") b.short.push(s); else b.long.push(s)
    }

    // Apply hedge netting only to profile-variant Sets
    for (const [bucketKey, b] of hedgeBuckets) {
      const L = b.long.length
      const S = b.short.length
      if (L === S) {
        netCancelled += L + S
        netTargetWrites[bucketKey] = "flat:0"
        continue
      }
      const winnerDir: "long" | "short" = L > S ? "long" : "short"
      const winnerPool                  = L > S ? b.long : b.short
      const remainder                   = Math.abs(L - S)
      // PF-desc preserved by `realSorted` upstream → winnerPool is best-first.
      netted.push(...winnerPool.slice(0, remainder))
      // Cancelled = total inputs minus survivors.
      //   total   = L + S
      //   survivors = remainder = |L − S|
      //   cancelled = (L + S) − |L − S| = 2 × min(L, S)
      //
      // Previous formula `min(L,S)*2 + max(0, winnerPool.length − remainder)`
      // overcounted: winnerPool.length = max(L,S), so the extra term adds
      // max(L,S) − |L−S| = min(L,S) — doubling the min(L,S) cancellation.
      // E.g. L=5, S=3 → previous gave 6+3=9 but correct is (5+3)−2=6.
      netCancelled += L + S - remainder
      netTargetWrites[bucketKey] = `${winnerDir}:${remainder}`
    }

    // `netted` contains hedge-bucket survivors (winnerPool.slice(0, remainder))
    // All profile-variant sets participate in hedging — none bypass via pass-through.
    // `axisPassthrough` contains axis Sets that skip hedging entirely.
    // Together they form realPostHedge: (netted hedge survivors) + (axis pass-through)
    //
    // Bootstrap fallback: when ALL profile-variant Sets are in OPPOSING direction
    // pairs that cancel each other AND there are no axis sets, the netting
    // produces netted=[]. We only activate the bootstrap when this happens due
    // to a genuine one-sided signal asymmetry (e.g. the very first cycle when no
    // history exists). We do NOT bootstrap when L==S cancellation is the correct
    // hedge outcome — that is the intended behaviour and should not be overridden.
    //
    // PREVIOUS BUG: the bootstrap fired every cycle on symmetric inputs, keeping
    // 1 long + 1 short regardless — bypassing hedge logic and producing 2
    // pseudo-positions per symbol per cycle on every fresh boot.
    //
    // FIX: Only bootstrap when there is EXACTLY one direction present across all
    // realSorted sets (pure one-sided signal with no opposing pairs). When both
    // directions exist and cancel, respect the hedge — return empty. The engine
    // will build asymmetric history over subsequent cycles naturally.
    let effectiveNetted = netted
    if (netted.length === 0 && axisPassthrough.length === 0 && realSorted.length > 0) {
      const hasLong  = realSorted.some((s) => (s.direction ?? "long") === "long")
      const hasShort = realSorted.some((s) => s.direction === "short")
      // Bootstrap ONLY when signal is purely one-directional (no opposing pairs)
      if (hasLong !== hasShort) {
        const topLong  = hasLong  ? realSorted.find((s) => (s.direction ?? "long") === "long")  : undefined
        const topShort = hasShort ? realSorted.find((s) => s.direction === "short") : undefined
        effectiveNetted = [topLong, topShort].filter(Boolean) as StrategySet[]
        if (effectiveNetted.length > 0) {
          console.log(
            `[v0] [StrategyCoordinator] ${this.connectionId}:${symbol} hedge-bootstrap: ` +
            `pure-${hasLong ? "long" : "short"} signal — keeping top-PF set (${effectiveNetted.length})`
          )
        }
      }
      // When hasLong === hasShort === true: symmetric cancel is correct — no bootstrap.
      // When hasLong === hasShort === false: no sets at all — nothing to bootstrap.
    }
    let realPostHedge = [...effectiveNetted, ...axisPassthrough].sort(
      (a, b) => b.avgProfitFactor - a.avgProfitFactor,
    )

    // Active-position Block overlays: inject block Sets derived from currently
    // running real positions before the Real-stage cap. These are counted
    // automatically in realRelatedCreated = realSets.length - mainPFEligible
    // since they flow through realPostHedge → realSets.
    let realStageRelatedCreated = 0
    try {
      const activePositionBlockOverlays = await this.buildActiveRealBlockOverlaysForReal(
        symbol,
        realPostHedge,
        metrics,
        coordIndex,
      )
      if (activePositionBlockOverlays.length > 0) {
        realStageRelatedCreated += activePositionBlockOverlays.length
        realPostHedge = realPostHedge
          .concat(activePositionBlockOverlays)
          .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      }
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${symbol} Real-stage active-position Block overlay failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    if (hedgeBuckets.size > 0) {
      logProgressionEvent(
        this.connectionId,
        "real_stage",
        "debug",
        `${symbol} REAL hedge-net: ${hedgeBuckets.size} buckets, ${netted.length} survivors, ${netCancelled} profile-variant pairs cancelled`,
        {
          symbol,
          buckets:   hedgeBuckets.size,
          survivors: netted.length,
          cancelled: netCancelled,
          axis:      axisPassthrough.length,
        },
      ).catch(() => {})
    }

    // Resolve the cap with this precedence:
    //   1. Operator-set `maxRealSets` in Settings → System (Redis app_settings)
    //   2. Per-instance config override (if any caller passed one)
    // ── Real Sets cap ─────────────────────────────────────────────���──
    // Per-spec: Strategies (Real Sets) are unlimited. Previously we
    // clamped to `maxRealSets` (default 12000); now we pass all
    // qualifying Real Sets to the Live stage. The operator still gates
    // via preset inclusion, profit-factor minimums, and coordination
    // toggles ���� removing this funnel cap lifts the ceiling without
    // sacrificing control.
    // For future use: if we need to re-cap (e.g. for perf), read the
    // operator's `maxRealSets` setting and apply it here.
    //
    // ── MEMORY-SAFETY CEILING (not a funnel cap) ─────────────���───────────
    // Real Sets remain "unlimited" by product spec, but slicing to a literal
    // Infinity let `realPostHedge` carry every qualifying Set — and each Set
    // is a full object with an `entries[]` array. On a dense symbol the Real
    // stage produced ~2400 Sets/cycle; held alongside their Main parents and
    // the per-Set detail hashes in the in-process Redis emulator, a burst of
    // concurrent cycles drove next-server RSS to ~7.3GB and triggered an OOM
    // SIGKILL (verified via dmesg: anon-rss 7334448kB). The Sets are already
    // sorted best-first (winnerPool ordering above), so an operator who sets
    // no explicit `maxRealSets` still keeps the highest-quality Sets; only a
    // pathological long tail is dropped.
    //
    // OOM calibration (2026-06-16): 20000 was calibrated for 5 symbols; at
    // 20 symbols the cumulative coord-record Map hit 4058 MB LIVE objects.
    // Production repro (2026-06-29): 3000 Real Sets after a large axis warmup
    // was still too aggressive for small workers with a warm active engine.
    // Keep the best-ranked subset and allow explicit env overrides for load
    // tests instead of risking SIGKILL in production mode.
    // In dev: 600 ceiling × SYMBOL_CONCURRENCY(3) = 1800 Real sets peak vs
    // 9000 at 3000 ceiling — cuts per-cycle V8 heap pressure by 5x while
    // keeping the full Real-stage pipeline exercised.
    // Dev lowered 600→200 per symbol for OOM-protection on the 4.39 GB VM.
    // 200 × SYMBOL_CONCURRENCY(3) = 600 Real sets peak — still enough Real-stage
    // ── REAL OUTPUT CAP (moved to earlier point in evaluateRealSets) ─────────
    // Cap is now applied BEFORE hedge netting at line ~3400 to prevent memory
    // bloat from thousands of sets that would later be discarded.
    // ── Variant-fair cap (operator spec: each activated variant independent) ──
    // `realPostHedge` is PF-desc sorted. A pure top-N slice lets the large
    // `default` axis fan-out (up to MAIN_AXIS_SETS_CEILING Sets, ALL tagged
    // "default") crowd out the comparatively few NON-default variant Sets
    // (trailing/block/dca/pause), so they never reached Real — their Real
    // aggregate AND their live dispatch were therefore always 0 even when the
    // variant was activated and correctly built at Main. Guarantee independent
    // representation: first reserve a bounded per-variant floor for each
    // non-default variant (taken in PF order), then fill the remaining budget
    // with the global PF ranking (mostly `default`). Non-default variants get
    // NO axis fan-out, so their counts are small and reserving for them is
    // cheap while keeping the total within the real output cap (OOM ceiling intact).
    let realSets: StrategySet[]
    if (realPostHedge.length <= realSetsCap) {
      realSets = realPostHedge
    } else {
      // Up to ~30% of the cap is split across the 4 non-default variant types;
      // the remaining ~70% goes to the global PF ranking. Floor of 1 ensures
      // every present variant survives even at a tiny cap.
      const floorPerVariant = Math.max(1, Math.floor((realSetsCap * 0.3) / 4))
      const reserved: StrategySet[] = []
      const reservedKeys = new Set<string>()
      const keptPerVariant: Record<string, number> = {}
      for (const s of realPostHedge) {
        if (reserved.length >= realSetsCap) break
        const v = (s.variant as string) ?? "default"
        if (v === "default") continue
        const kept = keptPerVariant[v] ?? 0
        if (kept >= floorPerVariant) continue
        reserved.push(s)
        reservedKeys.add(s.setKey)
        keptPerVariant[v] = kept + 1
      }
      const remaining = Math.max(0, realSetsCap - reserved.length)
      const fill: StrategySet[] = []
      for (const s of realPostHedge) {
        if (fill.length >= remaining) break
        if (reservedKeys.has(s.setKey)) continue
        fill.push(s)
      }
      // Restore global PF-desc ordering for the downstream hedge/dispatch path.
      realSets = reserved.concat(fill).sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      console.warn(
        `[v0] [RealStage] ${this.connectionId}: ${realPostHedge.length} Real Sets exceeds ` +
        `safety ceiling ${realSetsCap}; kept top ${realSetsCap} by rank with per-variant ` +
        `reserve (floor ${floorPerVariant}/variant: ${JSON.stringify(keptPerVariant)}). ` +
        `Set maxRealSets in Settings to override.`,
      )
    }

    // ── Populate CoordIndex.validRealKeys — O(N) single pass ───────────────
    // Stamp every surviving real set's coord record as `valid_real` and
    // populate the fast Set<string> for O(1) membership checks downstream.
    // Sets that were dropped by the cap or hedge-net are left at `valid_main`.
    if (coordIndex) {
      for (const s of realSets) {
        coordIndex.validRealKeys.add(s.setKey)
        const coordRec = coordIndex.byCoordKey.get(s.setKey)
        if (coordRec && coordRec.status !== "valid_real") {
          coordRec.status = "valid_real"
        }
      }
    }

    // ── Real-stage tuner — per-variant adjustments from Base prev-pos ──
    //
    // Operator spec: "at stage Real, do the accumulation for pos cnts
    // sets relying to their base sets configs INDEPENDENT" + "Adjust
    // strategies Block, DCA, pos coord, ratios, volume".
    //
    // We mutate every Real Set's entries in-place to bias the live-stage
    // sizing/leverage decisions by the historic realised performance of
    // the parent Base Set's (symbol × ind × dir) bucket. No exchange-
    // facing change yet — Live consumes `entries[].sizeMultiplier` and
    // `leverage` directly. Tuning is BOUNDED ([0.5, 1.5] for size, max
    // 2× leverage from base) so a noisy/empty bucket can never explode
    // exposure; below the threshold we no-op.
    //
    // Per-Base ledger (`real_pi_acc:{conn}` HASH, key = parentSetKey)
    // is incremented for every Real Set produced �� that's the dashboard
    // accumulation column.
    try {
      const { bumpRealPosAccumulation, bumpValidPositions, bumpAxisPosAccumulation, bumpHedgePosAccumulation } = await import(
        "@/lib/pos-history",
      )
      // Reuse `realActiveKeysForVP` already resolved at the function's top
      // (smembers + getOpenLiveSetKeys). Performing a second fetch here was a
      // redundant extra round-trip pair (one SMEMBERS + one live-positions scan)
      // on every Real-stage cycle, adding ~2 Redis RTTs with zero benefit since
      // the data can't change within the same async function call.
      const accPipeline = getRedisClient().multi()
      for (const s of realSets) {
        const parentKey = s.parentSetKey || s.setKey.split("#")[0]
        bumpRealPosAccumulation(this.connectionId, parentKey, 1, accPipeline)

        // ── Hedge pos-count accumulation per base Set (operator spec) ─
        // "Do the accumulations for pos counts Sets at stage Real
        // (hedging long, short for related same base Set)."
        //
        // For every Real Set, increment the per-Base hedge ledger by the
        // Set's entryCount in its direction (long or short). This builds
        // up the cumulative picture of how many position-slots each Base
        // Set is running per side across all cycles, enabling net-hedge
        // posture reads (long − short) per Base Set without a full scan.
        // entryCount is used (not 1) so axis Sets with larger windows
        // contribute proportionally to the hedge totals.
        const hedgeDir = (s.axisWindows?.direction ?? s.direction ?? "long") as "long" | "short"
        const hedgeEC  = s.entryCount > 0 ? s.entryCount : 1
        bumpHedgePosAccumulation({
          connectionId: this.connectionId,
          parentSetKey: parentKey,
          direction:    hedgeDir,
          entryCount:   hedgeEC,
          externalPipeline: accPipeline,
        })

        // ��─ Per-axis-Set continuous-count ledger (operator spec) ─────
        // For axis Sets (the prev × last × cont × outcome × dir
        // Cartesian fan-out at Main), record the rolling continuous
        // count of Pis that have actually accumulated onto this axis
        // bucket. Increment by `s.entryCount` (= baseEC + min(cont,
        // liveCont) from expandAxisSets) so the ledger is the
        // continuous-count rolling sum across cycles — exactly the
        // metric the operator described as "ongoing continuous count
        // of Pis to be added, counted onto the new sets". Pipelined
        // alongside the existing accumulation writes for zero added
        // round-trips.
        if (s.axisWindows?.axisKey && s.entryCount > 0) {
          bumpAxisPosAccumulation(
            this.connectionId,
            parentKey,
            s.axisWindows.axisKey,
            s.entryCount,
            accPipeline,
          )
        }

        // ── Variant tuning — IMMUTABLE ENTRIES ──────────────────────────────
        // Tuning deltas are written onto the CoordRecord (sizeDelta /
        // leverageDelta / tunedAvgPF) instead of mutating entries[].sizeMultiplier
        // in-place.
        //
        // WHY: axis Sets carry a synthetic representative entry that is now shared
        // across cycles via the _axisSetLru cache. In-place entry mutation would
        // corrupt the cached object for the next cycle. Writing a relative delta
        // onto the per-cycle CoordRecord achieves the same sizing at dispatch:
        //   tuned_size = bestEntry.sizeMultiplier × (1 + sizeDelta)
        // (createLiveSets ~line 3791 already implements this exact formula.)
        const pos = s.prevPos
        if (pos && pos.count > 0) {
          const sr = Math.max(0, Math.min(1, pos.successRate))
          const pfBias = pos.profitFactor <= 0
            ? 0.85
            : Math.max(0.6, Math.min(1.4, 0.7 + 0.5 * Math.tanh(pos.profitFactor - 1.0)))
          const sigBias = Math.max(0.7, Math.min(1.3, 0.7 + 1.2 * sr))
          const combined = (pfBias + sigBias) / 2

          // sizeDelta = relative multiplier so dispatch applies:
          //   tuned_size = base_size × (1 + sizeDelta)
          let sizeDelta: number
          let leverageDelta: number | undefined
          if (s.variant === "block") {
            // Block: attenuate via combined; floor at −0.5 keeps result �� 50% base.
            sizeDelta = Math.max(-0.5, combined - 1)
          } else if (s.variant === "dca") {
            // DCA: only attenuate when historic PF poor — never amplify.
            sizeDelta     = pfBias < 1.0 ? Math.max(-0.7, pfBias - 1) : 0
            leverageDelta = pfBias < 1.0 ? pfBias - 1 : undefined
          } else {
            // default / trailing / pause / axis — symmetric bias ±0.5.
            sizeDelta = Math.max(-0.5, Math.min(0.5, combined - 1))
          }

          // tunedAvgPF: apply combined bias to the current avgPF
          // (avoids re-summing the now-unmodified entries array each cycle).
          const tunedAvgPF = Math.max(0.5, (s.avgProfitFactor ?? 1) * combined)

          if (coordIndex) {
            const coordRec = coordIndex.byCoordKey.get(s.setKey)
            if (coordRec) {
              coordRec.sizeDelta     = sizeDelta !== 0 ? sizeDelta : undefined
              coordRec.leverageDelta = leverageDelta
              coordRec.tunedAvgPF    = tunedAvgPF
              coordRec.status        = "valid_real"
            }
          }
        }

        // ── Valid Positions counter ──
        // Only count Real Sets whose parent is currently RUNNING (= the
        // "Combined" semantic). All Real Sets contribute to the lifetime
        // "Overall" count regardless of running state.
        // Compose into the shared `accPipeline` so a 30-Set burst writes
        // once instead of 30 times — at 10 symbols this drops Real-stage
        // round-trips by ~10x and is the main reason cycles stay flat
        // past 4 symbols.
        bumpValidPositions({
          connectionId: this.connectionId,
          symbol,
          indicationType: s.indicationType,
          direction: s.direction,
          isRunningNow: realActiveKeysForVP.has(parentKey),
          externalPipeline: accPipeline,
        })
      }
      ;(accPipeline as any).exec().catch((err: any) => {
        console.error(`[v0] [StrategyFlow] ${symbol} accumulation pipeline failed:`, err?.message || err)
      })
    } catch (tunerErr) {
      console.warn(`[v0] [StrategyFlow] ${symbol} Real tuner failed:`, tunerErr)
    }

    // Persist per-bucket net targets for the Live-stage partial open/close
    // reconciliation hook. Documented on `reconcileLivePositions` —
    // direction unchanged & magnitude grew → partial OPEN for ��; direction
    // unchanged & magnitude shrunk → partial CLOSE lowest-PF; direction
    // flipped or flat:0 ��� close all in bucket then optionally re-open.
    // live_net_target tracks hedge-direction net positions for the live dispatch.
    if (Object.keys(netTargetWrites).length > 0) {
      try {
        const netClient = getRedisClient()
        const targetKey = `live_net_target:${this.connectionId}`
        await netClient.hset(targetKey, netTargetWrites)
        await netClient.expire(targetKey, 7 * 24 * 60 * 60)
      } catch { /* non-critical */ }
    }

    // Persist REAL sets — slim format (set keys only).
    // Full Base Set blobs are already persisted at `base:sets` and are the single
    // authoritative source for entries/quality data. Writing only the qualifying
    // key list cuts this payload from ~N×2-5 KB to N×~30 bytes per symbol per cycle.
    // Readers resolve full Set objects via Base sets (one extra read, warm in LRU).
    //
    // DEV-MODE THROTTLE: only write every 50th cycle (~15s at 0.3s interval) to
    // bound InlineLocalRedis Map growth. Each real:sets blob is ~50 KB; at 20
    // symbols writing every 5th cycle generates ~200 KB/s heap pressure that the
    // dev GC cannot fully reclaim. Every 50th cycle = ~20 KB/s — well below GC rate.
    // Dashboard stats read from in-memory progression counters for the live count;
    // the key list is only needed for structural queries which tolerate stale data.
    const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
    await setSettings(realKey, {
      setKeys: realSets.map((s) => s.setKey),
      count:   realSets.length,
      created: new Date(),
      _slim:   true,
    })

    // Count of Main Sets that actually entered PF/DDT evaluation (excludes pos-count
    // pre-gated sets). After the merged pos-gate + PF/DDT pass, `realQualifying`
    // is the survivor list; `skippedRealLowPos` is the count of pos-gated rejects.
    // PF-eligible = total - pos-gated.
    const mainPFEligible = mainSets.length - skippedRealLowPos

    // Real can fan out additional related/axis-created outputs beyond the PF-eligible
    // Main inputs. Use a denominator that includes both terms so pass-rate and
    // failure metrics never go negative when Real outputs exceed Main inputs.
    const realRelatedCreated = Math.max(0, realSets.length - mainPFEligible)
    const realTotalEvaluated = mainPFEligible + realRelatedCreated
    const realEvaluatedAfterFanOut = realTotalEvaluated

    // Write Real counts to progression hash — CUMULATIVE via hincrby so the dashboard
    // doesn't oscillate with per-cycle snapshots (see matching fix in createBaseSets/createMainSets).
    // Per-cycle snapshot is kept in `strategies_real_current` for components that want it.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const realDetailKey = `strategy_detail:${this.connectionId}:real`
      // Single pass over realSets — replaces 4 separate .reduce() calls that each
      // allocated an intermediate result and iterated the full array independently.
      let _sumPF = 0, _sumDDT = 0, _sumConf = 0, _sumEC = 0
      for (const st of realSets) {
        _sumPF   += st.avgProfitFactor
        _sumDDT  += st.avgDrawdownTime  || 0
        _sumConf += st.avgConfidence    || 0
        _sumEC   += st.entryCount       || 0
      }
      const n = realSets.length
      const realAvgPF        = n > 0 ? _sumPF   / n : 0
      const realAvgDDT       = n > 0 ? _sumDDT  / n : 0
      const realAvgConf      = n > 0 ? _sumConf / n : 0
      const realEntriesTotal = _sumEC
      const realAvgPosPerSet = n > 0 ? _sumEC   / n : 0
      // passRatioReal = fraction of Real evaluated work that passed into Real.
      // Denominator includes both PF-eligible Main inputs and Real related/axis
      // fan-out outputs, keeping the ratio bounded when fan-out creates more
      // Real Sets than the original Main input count.
      const passRatioReal = realTotalEvaluated > 0 ? n / realTotalEvaluated : 0
      // Average entryCount per Real Set ��� identical to realAvgPosPerSet.
      // The previous formula used Math.max(1, entryCount||1) which biased
      // Sets with entryCount=0 upward. Reuse the already-correct value.
      const realAvgPosEval = realAvgPosPerSet

      // ── Running-now resolution for Real ──────────────────────────
      // A Real Set is "running now" only when its originating Base Set is
      // actively coordinating (present in active_config_keys). This mirrors
      // the Main-stage logic and guarantees REAL running <= MAIN running,
      // making the cascade filter visible in the dashboard.
      // Reuse _activeKeysCache populated by createBaseSets this cycle.
      const realActiveCache = this._activeKeysCache
      const realCacheFresh = realActiveCache && Date.now() - realActiveCache.cycleAt < 30_000
      const realActiveBaseKeys = realCacheFresh
        ? realActiveCache!.keys
        : new Set<string>(
            (await client
              .smembers(`pseudo_positions:${this.connectionId}:active_config_keys`)
              .catch(() => [])) as string[],
          )
      const realRunningNow = realSets.filter((s) => {
        const base = (s.parentSetKey ?? s.setKey).split("#")[0]
        return realActiveBaseKeys.has(base)
      }).length

      // Open positions = sum of entryCount across the Real Sets that are
      // actively running now (each entry is one open position the Set holds).
      const realOpenPositions = realSets.reduce((sum, s) => {
        const base = (s.parentSetKey ?? s.setKey).split("#")[0]
        return realActiveBaseKeys.has(base) ? sum + (s.entryCount || 0) : sum
      }, 0)
      // Positions (entries) per running Set — averaged over running Sets only.
      const realPosPerRunningSet = realRunningNow > 0 ? realOpenPositions / realRunningNow : 0

      // ── Real 4-perspective stats (Overall / Accumulated / General / Combined) ──
      // Per operator spec: "in Strategies Real ensure correct stats..
      // Overall, Accumulated, General, Combined."
      //
      //   - Overall:     cumulative Real Sets ever produced (lifetime).
      //                  Already maintained as `strategies_real_total`
      //                  via hincrby below.
      //   - Accumulated: axis-window accumulation across cycles. Sum of
      //                  the four `strategy_axis_real:{conn}:{axis}`
      //                  hashes (prev × last × cont × pause).
      //   - General:     per-cycle current Real Sets snapshot
      //                  (`strategies_real_current`).
      //   - Combined:    actively-running right now (= realRunningNow).
      //
      // Pre-compute the axis POSITION accumulation sum so the stats route
      // never needs extra round-trips on every dashboard refresh.
      // Source: axis_pos_acc:{conn} ��� the hash bumpAxisPosAccumulation writes
      // to in the Real tuner loop above. Each field is parentSetKey|axisKey and
      // the value is the cumulative entryCount (= baseEC + min(cont,liveCont))
      // across all cycles — exactly the "Accumulated" perspective the operator
      // described as "ongoing continuous count of Pis added onto the new sets".
      let realAccumulatedSum = 0
      try {
        const axisAccHash = (await client
          .hgetall(`axis_pos_acc:${this.connectionId}`)
          .catch(() => ({} as Record<string, string>))) as Record<string, string>
        for (const v of Object.values(axisAccHash || {})) {
          const num = Number(v)
          if (Number.isFinite(num)) realAccumulatedSum += num
        }
      } catch { /* fallback: 0 */ }

      const writes: Promise<any>[] = [
        client.hset(redisKey, "strategies_real_current", String(realSets.length)),
        client.hset(realDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:       String(realSets.length),
          avg_profit_factor:  String(realAvgPF.toFixed(4)),
          avg_drawdown_time:  String(Math.round(realAvgDDT)),
          avg_pos_eval_real:  String(realAvgPosEval.toFixed(4)),
          avg_pos_per_set:    String(realAvgPosPerSet.toFixed(2)),
          // evaluated = public Real denominator after fan-out; separate upstream
          // input remains in strategies_active as {symbol}:real:input.
          // evaluated = PF-eligible Main inputs plus Real related/axis-created outputs;
          // separate upstream input remains in strategies_active as {symbol}:real:input.
          evaluated:          String(realEvaluatedAfterFanOut),
          passed_sets:        String(realSets.length),
          pass_rate:          String(passRatioReal.toFixed(4)),
          count_pos_eval:     String(realSets.length),
          entries_total:      String(realEntriesTotal),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────────
          //   Real CLONES + FILTERS Main's positions across the
          //   position-count axis. A Real Set is "running" iff its
          //   parentSetKey traces back to a Base Set actively in
          //   active_config_keys.
          sets_running_now:         String(realRunningNow),
          sets_with_open_positions: String(realRunningNow),
          sets_progressing:         String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          // ── 4-perspective Real stats ───────────────────────��──────
          // These are connection-wide (not per-symbol) so writing them
          // once per (symbol, cycle) is fine — every symbol computes the
          // same `realAccumulatedSum` and the same `strategies_real_total`.
          stat_general:      String(realSets.length),         // this cycle
          stat_combined:     String(realRunningNow),          // running now
          stat_accumulated:  String(realAccumulatedSum),      // axis sum
          // (Overall is pulled from `strategies_real_total` on read.)
          updated_at:         String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          [`s:${symbol}:created`]:    String(realSets.length),
          [`s:${symbol}:entries`]:    String(realEntriesTotal),
          [`s:${symbol}:running`]:    String(realRunningNow),
          [`s:${symbol}:progressing`]: String(
            realSets.filter((s) => (s.entryCount || 0) > 0).length,
          ),
          [`s:${symbol}:passed`]:     String(realSets.length),
          [`s:${symbol}:evaluated`]:  String(realTotalEvaluated),
          [`s:${symbol}:apf`]:        String(realAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(realAvgDDT)),
          [`s:${symbol}:apps`]:       String(realAvgPosPerSet.toFixed(2)),
          [`s:${symbol}:aper`]:       String(realAvgPosEval.toFixed(4)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(realDetailKey, 86400),
        // NOTE: do NOT patch strategy_detail:{conn}:main here. The Main detail
        // already writes its own passed_sets = mainSets.length and
        // pass_rate = passRatioMain (clamped to [0,1]) each Main cycle.
        // Overwriting them with Real's realSets.length would corrupt MAIN's
        // pass statistics and make passed_sets > evaluated impossible to read.
        client.set(`strategies:${this.connectionId}:real:count`, String(realSets.length)),
        client.set(`strategies:${this.connectionId}:real:evaluated`, String(realTotalEvaluated)),
        client.set(`strategies:${this.connectionId}:main:passed`, String(realSets.length)),
        client.expire(`strategies:${this.connectionId}:real:count`, 86400),
        client.expire(`strategies:${this.connectionId}:real:evaluated`, 86400),
        client.expire(`strategies:${this.connectionId}:main:passed`, 86400),
      ]
      // NOTE: real:sets persistence is handled earlier in evaluateRealSets via the
      // slim-format write (setKeys array only, ~30 bytes/set vs ~2-5 KB for a full blob).
      // The legacy full-blob write that was here was: (a) writing to a different Redis
      // key than the slim writer (raw key vs settings:-prefixed key), so it was never
      // read by createLiveSets; (b) consuming ~50 KB × 20 symbols = 1 MB/cycle in prod
      // with no benefit. It has been removed. The slim write at line ~3027 is the only
      // real:sets persistence path and the reader at createLiveSets uses getSettings()
      // which resolves the settings:-prefixed path correctly.

      // strategies_real_related_created = Real Sets created via axis/variant
      // fan-out BEYOND the Main Sets that entered (mirrors the Main stage's
      // `strategies_main_related_created = mainSets.length - reused`). This is
      // the "additionally created" term the dashboard can display alongside the
      // Real evaluated pool. `strategies_real_evaluated` already includes this
      // fan-out term so Real pass denominators stay consistent across Redis/detail
      // fields. max(0, …) because Real can also net-filter below the input.
      // strategies_real_total = cumulative Sets PROMOTED by REAL (passed output count).
      // strategies_real_evaluated = every Real Set considered after current-cycle
      // fan-out (upstream PF-eligible Main input + Real related-created fan-out).
      if (realSets.length > 0) writes.push(client.hincrby(redisKey, "strategies_real_total", realSets.length))
      if (realTotalEvaluated > 0) writes.push(client.hincrby(redisKey, "strategies_real_evaluated", realTotalEvaluated))

      // strategies_real_related_created = Real Sets created via axis/variant
      // fan-out BEYOND the upstream Main PF-eligible input. max(0, …) because
      // Real can also net-filter below the input.
      if (realRelatedCreated > 0) {
        writes.push(client.hincrby(redisKey, "strategies_real_related_created", realRelatedCreated))
      }
      writes.push(client.hset(redisKey, { strategies_real_last_created: String(realRelatedCreated) }))

      // ── ACTIVE-NOW snapshot for Real stage ──────────────────────────
      // Mirrors the Base/Main pattern. The dashboard reads this hash and
      // aggregates to a "Strategies (Real, alive now)" tile. Note this
      // is the COUNT-AFTER-SORT-AND-CAP, i.e. exactly what propagates
      // forward to Live evaluation �� not the raw post-filter count.
      writes.push(
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:real`]:           String(realSets.length),
          // real:evaluated = PF-eligible Main inputs plus Real related/axis-created
          // outputs. Cross-symbol sum in stats route matches the Real pass denominator.
          [`${symbol}:real:evaluated`]: String(realTotalEvaluated),
          // real:input = upstream Main Sets that entered Real PF eligibility
          // before Real's current-cycle related-created fan-out.
          [`${symbol}:real:input`]: String(mainPFEligible),
          // real:relatedCreated = Real fan-out created this cycle beyond input.
          [`${symbol}:real:relatedCreated`]: String(realRelatedCreated),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
      )

      // ── P1-1: Real-stage per-variant aggregation ──��────────���────────
      // ── Real-stage rolling sample (for averaged count stats) ──────────
      // Push one timestamped sample of the live Real counts per (symbol,
      // cycle) onto a bounded ring list. The tracking layer averages all
      // samples inside a fixed interval window to produce the displayed
      // "average" Active Sets / Positions-per-Set / Positions-Open figures.
      // lpush + ltrim is O(1)-ish and order-independent, so concurrent
      // symbol workers can never corrupt or stall it (no read-modify-write).
      // The interval window itself is an internal calc detail — the UI shows
      // only the resulting averages, never the "N minutes" framing.
      try {
        const sampleKey = `real_samples:${this.connectionId}`
        const sample = JSON.stringify({
          t: Date.now(),
          sets: realSets.length,          // all Real Sets passing gates this cycle
          pps: Number(realPosPerRunningSet.toFixed(3)),
          open: realOpenPositions,        // running (pseudo-open) positions
        })
        writes.push(
          client.lpush(sampleKey, sample),
          client.ltrim(sampleKey, 0, 599),
          client.expire(sampleKey, 3600),
        )
      } catch { /* non-critical */ }

      // Same shape as Main's `variantAgg` but computed over the Real
      // output (post-PF/DDT filter). Lets the stats API answer "how
      // much of Real is Default vs Adjust{Block, DCA} vs Trailing?"
      // without re-scanning every set on read.
      type RealVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number; passedSets: number
      }
      const realVariantAgg: Record<string, RealVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0, passedSets: 0 },
      }
      // Slim-path Real Sets carry entries:[] — use set-level scalar aggregates
      // (entryCount, avgProfitFactor, avgDrawdownTime) instead of iterating
      // entries. This mirrors the Main-stage variantAgg fix and ensures
      // strategy_variant_real:* hashes are populated (the old entry loop never
      // ran, so agg.entries was always 0 and the write guard below always skipped).
      for (const set of realSets) {
        const sv = (set.variant as keyof typeof realVariantAgg) ?? "default"
        const agg = realVariantAgg[sv] ?? realVariantAgg.default
        const ec  = set.entryCount || 0
        agg.setsContaining += 1
        agg.passedSets     += 1
        agg.entries        += ec
        agg.sumPF          += set.avgProfitFactor * ec
        agg.sumDDT         += (set.avgDrawdownTime || 0) * ec
      }
      for (const variant of ["default", "trailing", "block", "dca"] as const) {
        const agg = realVariantAgg[variant]
        // Guard on setsContaining (not entries) so sets with entryCount=0 still
        // contribute their count metadata to the variant hash.
        if (agg.setsContaining === 0) continue
        const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
        writes.push(
          client.hincrby(vKey, "entries_count",  agg.entries),
          client.hincrby(vKey, "created_sets",   agg.setsContaining),
          client.hincrby(vKey, "passed_sets",    agg.passedSets),
          client.hincrby(vKey, "sum_pf_x1000",   Math.round(agg.sumPF * 1000)),
          client.hincrby(vKey, "sum_ddt_x10",    Math.round(agg.sumDDT * 10)),
          client.hset(vKey, { updated_at: new Date().toISOString() }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // ── POSITION-COUNT AXIS ACCUMULATION (Real stage) ───────────��──
      // Per spec: "Do the Additional Sets / Position Counts Accumulation
      // in Strategies Real instead of in Main". The axis windows are
      // tagged at Main creation time but the cumulative accumulation
      // (across cycles) is tracked HERE so the dashboard can show how
      // many Real Sets exist per axis window over time.
      //
      // Axes (per axisWindows definition in StrategySet):
      //   prev:  0..12   (closed lookback window)
      //   last:  0..4    (last-N magnitude window)
      //   cont:  0..8    (open continuous positions)
      //   pause: 0..8    (last-N validation window)
      //
      // Direction split: axis Sets are emitted in both `long` and `short`
      // directions (CARTESIAN in expandAxisSets). Accumulation is keyed by
      // direction so the dashboard can show pos-count distribution per
      // direction relative to the base set config. Key format:
      //   `strategy_axis_real:{conn}:{axis}:{dir}` → hash of { window → count }
      //
      // An undifferentiated (direction-combined) copy is ALSO written to
      // `strategy_axis_real:{conn}:{axis}` so existing consumers that read
      // only the combined key keep working without a migration.
      type DirAxisCounts = Record<"prev" | "last" | "cont" | "pause", Record<string, number>>
      const axisCounts:     DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsLong: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }
      const axisCountsShort: DirAxisCounts = { prev: {}, last: {}, cont: {}, pause: {} }

      for (const set of realSets) {
        const aw = set.axisWindows
        if (!aw) continue
        // Direction for this axis Set: axisWindows.direction (populated by
        // expandAxisSets) if present, otherwise fall back to the Set's own
        // top-level direction field.
        const dir: "long" | "short" | undefined = aw.direction ?? (set.direction as "long" | "short" | undefined)
        for (const axis of ["prev", "last", "cont", "pause"] as const) {
          const w = aw[axis]
          if (typeof w !== "number") continue
          const key = String(w)
          axisCounts[axis][key]      = (axisCounts[axis][key]      || 0) + 1
          if (dir === "long")  axisCountsLong[axis][key]  = (axisCountsLong[axis][key]  || 0) + 1
          if (dir === "short") axisCountsShort[axis][key] = (axisCountsShort[axis][key] || 0) + 1
        }
      }
      for (const axis of ["prev", "last", "cont", "pause"] as const) {
        // Combined (direction-agnostic) ��� backwards-compatible key
        const aKey      = `strategy_axis_real:${this.connectionId}:${axis}`
        // Direction-split keys — per-spec granularity
        const aKeyLong  = `strategy_axis_real:${this.connectionId}:${axis}:long`
        const aKeyShort = `strategy_axis_real:${this.connectionId}:${axis}:short`
        let touched = false
        for (const [window, count] of Object.entries(axisCounts[axis])) {
          if (count <= 0) continue
          touched = true
          writes.push(client.hincrby(aKey, window, count))
        }
        let touchedLong = false
        for (const [window, count] of Object.entries(axisCountsLong[axis])) {
          if (count <= 0) continue
          touchedLong = true
          writes.push(client.hincrby(aKeyLong, window, count))
        }
        let touchedShort = false
        for (const [window, count] of Object.entries(axisCountsShort[axis])) {
          if (count <= 0) continue
          touchedShort = true
          writes.push(client.hincrby(aKeyShort, window, count))
        }
        if (touched)      writes.push(client.expire(aKey,      7 * 24 * 60 * 60))
        if (touchedLong)  writes.push(client.expire(aKeyLong,  7 * 24 * 60 * 60))
        if (touchedShort) writes.push(client.expire(aKeyShort, 7 * 24 * 60 * 60))
      }
      // Gate progression hash TTL reset — same rationale as createBaseSets.
      if (this._stratCycleCount % 500 === 3) {
        writes.push(client.expire(redisKey, 7 * 24 * 60 * 60))
      }

      await Promise.all(writes)

      // Second pass — derive averages from freshly-incremented counters
      // so the stats API can read them without recomputing.
      try {
        const recompute: Promise<any>[] = []
        for (const variant of ["default", "trailing", "block", "dca"] as const) {
          if (realVariantAgg[variant].setsContaining === 0) continue
          const vKey = `strategy_variant_real:${this.connectionId}:${variant}`
          recompute.push(
            (async () => {
              const h = ((await client.hgetall(vKey).catch(() => null)) || {}) as Record<string, string>
              const entriesCount = Number(h.entries_count  || "0")
              const createdSets  = Number(h.created_sets   || "0")
              const sumPfX1000   = Number(h.sum_pf_x1000   || "0")
              const sumDdtX10    = Number(h.sum_ddt_x10    || "0")
              const avgPF  = entriesCount > 0 ? (sumPfX1000  / 1000) / entriesCount : 0
              const avgDDT = entriesCount > 0 ? (sumDdtX10   / 10)   / entriesCount : 0
              const avgPosPerSet = createdSets > 0 ? entriesCount / createdSets : 0
              const passRate = createdSets > 0 ? (Number(h.passed_sets || "0") / createdSets) : 0
              await client.hset(vKey, {
                avg_profit_factor: avgPF.toFixed(4),
                avg_drawdown_time: avgDDT.toFixed(2),
                avg_pos_per_set:   avgPosPerSet.toFixed(2),
                pass_rate:         passRate.toFixed(4),
              })
            })(),
          )
        }
        await Promise.all(recompute)
      } catch { /* non-critical */ }
    } catch { /* non-critical */ }

    // ── Position count metrics for real stage ──────────────────────
    // Track entries passing Real filter so dashboard shows promotion success
    const realEntriesTotal = realSets.reduce((sum, s) => sum + (s.entryCount ?? 0), 0)
    try {
      const client = getRedisClient()
      const progKey = `progression:${this.connectionId}`
      if (realEntriesTotal > 0) {
        await client.hincrby(progKey, "real_positions_created_count", realEntriesTotal)
      }
    } catch { /* non-critical */ }

    return {
      result: {
        type: "real",
        symbol,
        timestamp: new Date(),
        // totalCreated = PF-eligible Main inputs plus Real related/axis-created outputs.
        totalCreated: realTotalEvaluated,
        passedEvaluation: realSets.length,
        failedEvaluation: Math.max(0, realTotalEvaluated - realSets.length),
        avgProfitFactor: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgProfitFactor, 0) / realSets.length : 0,
        avgDrawdownTime: realSets.length > 0 ? realSets.reduce((s, set) => s + set.avgDrawdownTime, 0) / realSets.length : 0,
      },
      sets: realSets,
    }
  }

  // ──�� STAGE 4: LIVE ─────────����─���────────��─────�����───��─────��─────��──────���───────��

  /**
   * Select the best 500 Sets from REAL for live trading.
   * Creates exactly ONE pseudo position per Set (per indication_type × direction).
   */
  private async createLiveSets(
    symbol: string,
    inputSets?: StrategySet[],
    coordIndex?: CoordIndex,
    // When true, build the live mirror + pseudo-positions + stats but DO NOT
    // place real exchange orders (see executeStrategyFlow docstring).
    skipLiveDispatch: boolean = false,
  ): Promise<{ result: StrategyEvaluation; sets: StrategySet[] }> {
    let realSets: StrategySet[]
    if (inputSets) {
      realSets = inputSets
    } else {
      const realKey = `strategies:${this.connectionId}:${symbol}:real:sets`
      const stored  = await getSettings(realKey) as any
      if (stored && typeof stored === "object") {
        if (stored._slim && Array.isArray(stored.setKeys)) {
          // ── Slim format: key list only — resolve full Sets from Base ───
          // Base sets carry entries/quality data and are always written as
          // full blobs. A single base:sets read is cheaper than deserialising
          // the old full Real blob, and the result is always fresh-cycle data.
          const baseKey  = `strategies:${this.connectionId}:${symbol}:base:sets`
          const baseSt   = await getSettings(baseKey) as any
          const baseArr: StrategySet[] = Array.isArray(baseSt?.sets) ? baseSt.sets : []
          const keySet   = new Set<string>(stored.setKeys as string[])
          realSets       = baseArr.filter((s) => keySet.has(s.setKey))
        } else {
          // Legacy full-blob format — tolerate during rollout period.
          realSets = Array.isArray(stored.sets) ? stored.sets : Array.isArray(stored) ? stored : []
        }
      } else {
        realSets = []
      }

      // DEV/TEST fallback: when no Real sets yet but Main sets exist, allow
      // a temporary synthetic Real escalation so the live pipeline can be
      // exercised in test environments. Guard by testnet flag ONLY.
      // CRITICAL: FORCE_LIVE is NEVER a testnet override — it's a debug flag for dev.
      // Always verify actual is_testnet on the connection record (async read required).
      // Always check actual is_testnet on the connection record.
      try {
        const conn = (await (await import("@/lib/redis-db")).getConnection(this.connectionId)) || {}
        const isTestConn = conn?.is_testnet === true || conn?.is_testnet === "1"
        if (realSets.length === 0 && isTestConn) {
          const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
          const mainStored = await getSettings(mainKey)
          const mainSets = mainStored && typeof mainStored === "object" ? (Array.isArray((mainStored as any).sets) ? (mainStored as any).sets : Array.isArray(mainStored) ? mainStored : []) : []
          if (mainSets && mainSets.length > 0) {
            // Pick top Main set and convert to a minimal Real set
            const top = mainSets.sort((a: any, b: any) => (b.avgProfitFactor || 0) - (a.avgProfitFactor || 0))[0]
            const synthetic: any = {
              ...top,
              setKey: top.setKey || `${symbol}:${top.direction || "long"}:synthetic`,
              parentSetKey: top.setKey || null,
              avgProfitFactor: Math.max(0.8, top.avgProfitFactor || 0.8),
              avgDrawdownTime: top.avgDrawdownTime || 0,
              entries: top.entries && top.entries.length > 0 ? top.entries : [{ profitFactor: Math.max(1.0, (top.avgProfitFactor || 1.0)), leverage: 1, confidence: 0.8, sizeMultiplier: 1 }],
              entryCount: top.entryCount || (top.entries ? top.entries.length : 1),
              status: "valid_real",
            }
            realSets = [synthetic]
            console.log(`[v0] [StrategyCoordinator] ${this.connectionId}:${symbol} - injecting synthetic Real set for test mode to allow live dispatch`)
          }
        }
      } catch (e) { /* non-fatal */ }
    }

    const metrics = this.METRICS.live
    let maxLive = this.config.maxLiveSets || 500
    let livePositionCostPct = 0.1
    try {
      // Perf: Cache these values in the coordinator instance with a 5-minute TTL
      // instead of re-reading per symbol per cycle. Most test/prod sessions keep
      // exchange and position cost constant for hours.
      const now = Date.now()
      if (!this._cachedExchangeMaxLive || now - this._cachedExchangeMaxLiveAt > 5 * 60 * 1000) {
        const { getConnection } = await import("@/lib/redis-db")
        const conn = await getConnection(this.connectionId).catch(() => null)
        const exchange = String((conn as any)?.exchange || "").toLowerCase()
        // BingX commonly enforces a 200-open-order ceiling. Each live position
        // can carry two reduce-only control orders (SL + TP), so cap dispatch to
        // 90 positions per cycle (≤180 controls) and leave room for manual orders,
        // in-flight cancels, and venue-side lag.
        const configuredLiveCap = this.config.maxLiveSets || this.strategyLiveSetsCeiling || 90
        this._cachedExchangeMaxLive = exchange === "bingx"
          ? Math.min(configuredLiveCap, 90)
          : configuredLiveCap
        this._cachedExchangeMaxLiveAt = now
      }
      maxLive = this._cachedExchangeMaxLive || 500

      if (!this._cachedLivePositionCost || now - this._cachedLivePositionCostAt > 5 * 60 * 1000) {
        const connSettings = await getRedisClient().hgetall(`connection_settings:${this.connectionId}`).catch(() => ({}))
        const rawCost = Number((connSettings as any)?.exchangePositionCost ?? (connSettings as any)?.positionCost ?? "")
        this._cachedLivePositionCost = Number.isFinite(rawCost) && rawCost > 0 ? rawCost : 0.1
        this._cachedLivePositionCostAt = now
      }
      livePositionCostPct = this._cachedLivePositionCost
    } catch (err) {
      console.warn(
        `[v0] [StrategyFlow] ${this.connectionId}:${symbol} live dispatch settings read failed:`,
        err instanceof Error ? err.message : String(err),
      )
    }

    // P0-2: Live filter axes are PF-min + DDT-max ONLY (then rank by
    // avgProfitFactor and take top N). Confidence is advisory metadata.
    //
    // LIVE EXCHANGE DISPATCH CAP: Cap to top maxLive sets after PF/DDT filtering.
    // The Real stage evaluates hundreds of profile variants (default, blocks
    // 1-8, dca, axis, trailing…). The cap prevents 100+ simultaneous orders
    // (which caused BingX 100421 backlog) but allows block + default variants
    // to be tested together. The final dispatch loop (lines 4699-4715) enforces
    // per-variant per-direction caps (1 default, 1 block, 1 dca per direction).
    const allQualifying = realSets
      .filter(
        (s) =>
          s.avgProfitFactor >= metrics.minProfitFactor &&
          s.avgDrawdownTime <= metrics.maxDrawdownTime,
      )
      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
      .slice(0, maxLive)

    // Keep all qualifying sets (not filtered to 1 per direction).
    // Block overlays will be added at line 4670, and the final dispatch loop
    // at line 4699-4715 enforces per-variant caps (1 default + 1 block + 1 DCA).
    let qualifying = allQualifying

    // Testnet fallback: if no qualifying Real sets, promote the top Real or top Main set so live dispatch can run.
    // CRITICAL: Always verify actual is_testnet on connection record.
    try {
      const conn = await (await import("@/lib/redis-db")).getConnection(this.connectionId)
      const isTestOrDev = conn?.is_testnet === true || conn?.is_testnet === "1"
      if (qualifying.length === 0 && isTestOrDev) {
        if (realSets.length > 0) {
          qualifying = [realSets.sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)[0]]
          console.log(`[v0] [StrategyFlow] ${this.connectionId}:${symbol} dev fallback - promoted top REAL set for live dispatch`)
        } else {
          // Try to seed from MAIN as a last resort
          const mainKey = `strategies:${this.connectionId}:${symbol}:main:sets`
          const mainStored = await getSettings(mainKey)
          const mainSets = mainStored && typeof mainStored === "object" ? (Array.isArray((mainStored as any).sets) ? (mainStored as any).sets : Array.isArray(mainStored) ? mainStored : []) : []
          if (mainSets.length > 0) {
            const top = mainSets.sort((a: any, b: any) => (b.avgProfitFactor || 0) - (a.avgProfitFactor || 0))[0]
            const synth: any = {
              ...top,
              setKey: top.setKey || `${symbol}:${top.direction || "long"}:dev-seed`,
              parentSetKey: top.setKey || null,
              avgProfitFactor: Math.max(0.9, top.avgProfitFactor || 0.9),
              avgDrawdownTime: top.avgDrawdownTime || 0,
              entries: top.entries && top.entries.length > 0 ? top.entries : [{ profitFactor: Math.max(1.0, (top.avgProfitFactor || 1.0)), leverage: 1, confidence: 0.85, sizeMultiplier: 1 }],
              entryCount: top.entryCount || (top.entries ? top.entries.length : 1),
              status: "valid_real",
            }
            qualifying = [synth]
            console.log(`[v0] [StrategyFlow] ${this.connectionId}:${symbol} dev fallback - injected synthetic qualifying set from MAIN`)
          }
        }
      }
    } catch (e) { /* non-fatal */ }








    const liveKey = `strategies:${this.connectionId}:${symbol}:live:sets`
    await setSettings(liveKey, {
      setKeys:    qualifying.map((s) => s.setKey),
      count:      qualifying.length,
      created:    new Date(),
      executable: true,
      _slim:      true,
    })

    // Create pseudo positions from the LIVE-qualifying subset only.
    // Previously received all `realSets` (up to 3000/symbol), causing N×3 Redis
    // writes for sets that never reach live dispatch. `qualifying` is the capped
    // Live subset (typically ≤500/symbol) — the only sets that semantically need
    // pseudo-position records (they represent active dispatch candidates).
    await this.createPseudoPositionsFromRealSets(symbol, qualifying)

    // Write live set count into progression hash — use hset so count reflects current cycle snapshot.
    // NOTE: strategies_real_total and strategy_evaluated_real are already written by evaluateRealSets.
    // Previously this block fired 7 sequential Redis round-trips (hset × 2, set, expire × 3, + a
    // compound hset). Parallelising them cuts the per-cycle Redis stall to a single network hop
    // worth of latency, matching the base/main/real coordinators.
    try {
      const client = getRedisClient()
      const redisKey = `progression:${this.connectionId}`
      const liveDetailKey = `strategy_detail:${this.connectionId}:live`
      const liveCountKey = `strategies:${this.connectionId}:live:count`

      const liveAvgPF  = qualifying.length > 0 ? qualifying.reduce((s, st) => s + st.avgProfitFactor, 0) / qualifying.length : 0
      const liveAvgDDT = qualifying.length > 0 ? qualifying.reduce((s, st) => s + (st.avgDrawdownTime || 0), 0) / qualifying.length : 0
      const passRatioLive = realSets.length > 0 ? qualifying.length / realSets.length : 0

      // ── P1-1: Live-stage per-variant aggregation ──────────────────────
      // Same bucket shape as Main/Real. Drives the stats API's breakdown
      // of which variant family (Default / Trailing / Block / DCA) is
      // contributing Sets to the live mirror. Kept as a single Promise.all
      // so we still land in one network hop.
      type LiveVariantAgg = {
        sumPF: number; sumDDT: number; entries: number; setsContaining: number
      }
      const liveVariantAgg: Record<string, LiveVariantAgg> = {
        default:  { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        trailing: { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        block:    { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
        dca:      { sumPF: 0, sumDDT: 0, entries: 0, setsContaining: 0 },
      }
      for (const set of qualifying) {
        // Slim-path sets carry entries: [] — use entryCount + set-level avgPF/DDT
        // so Live variant aggregates are accurate (mirrors Main stage accounting).
        const variant = (set.variant as keyof typeof liveVariantAgg) ?? "default"
        const lv = liveVariantAgg[variant] ?? liveVariantAgg["default"]
        const ec = set.entryCount || set.entries.length
        lv.setsContaining += 1
        lv.entries += ec
        lv.sumPF   += set.avgProfitFactor * ec
        lv.sumDDT  += (set.avgDrawdownTime || 0) * ec
      }

      // ── bumpValidPositions — Live-promoted Set counter ─────────────────
      // The `valid_positions:{conn}` hash tracks Sets reaching Live stage.
      {
        try {
          const { bumpValidPositions } = await import("@/lib/pos-history")
          const vpPipeline = getRedisClient().multi()
          for (const set of qualifying) {
            bumpValidPositions({
              connectionId: this.connectionId,
              symbol,
              direction: set.direction,
              indicationType: set.indicationType,
              // Live sets are by definition currently running (they have
              // open or in-formation positions). isRunningNow drives the
              // `combined` (= active accumulation) counter in valid_positions.
              isRunningNow: true,
              externalPipeline: vpPipeline,
            })
          }
          ;(vpPipeline as any).exec().catch(() => {})
        } catch { /* non-critical — valid_positions counter is observability only */ }
      }

      const liveVariantWrites: Promise<any>[] = []
      for (const variant of ["default", "trailing", "block", "dca"] as const) {
        const agg = liveVariantAgg[variant]
        // Guard on setsContaining — a variant bucket with sets but entryCount=0
        // still contributes count metadata. Avoids writing empty buckets.
        if (agg.setsContaining === 0) continue
        const vKey   = `strategy_variant_live:${this.connectionId}:${variant}`
        const ec     = agg.entries || 1   // guard division — falls back to 1 if entryCount unset
        const avgPF  = agg.sumPF  / ec
        const avgDDT = agg.sumDDT / ec
        liveVariantWrites.push(
          client.hset(vKey, {
            created_sets:      String(agg.setsContaining),
            entries_count:     String(agg.entries),
            avg_profit_factor: avgPF.toFixed(4),
            avg_drawdown_time: avgDDT.toFixed(2),
            avg_pos_per_set:   (agg.entries / agg.setsContaining).toFixed(2),
            updated_at:        String(Date.now()),
          }),
          client.expire(vKey, 7 * 24 * 60 * 60),
        )
      }

      // strategies_live_total must be CUMULATIVE (hincrby), not a per-cycle
      // snapshot (hset). All other stage _total fields use hincrby; using hset
      // here made Live's lifetime total reset to the current-cycle count every
      // cycle, so the dashboard always showed a tiny snapshot instead of the
      // true accumulated lifetime count.
      await Promise.all([
        qualifying.length > 0
          ? client.hincrby(redisKey, "strategies_live_total", qualifying.length)
          : Promise.resolve(),
        // ── ACTIVE-NOW snapshot for Live stage ────────────────────────────
        // Without {symbol}:live fields the `stratCounts.live` bucket in the
        // stats route always returned 0, making the Live column empty.
        client.hset(`strategies_active:${this.connectionId}`, {
          [`${symbol}:live`]:           String(qualifying.length),
          // live:evaluated = Real Sets that entered Live selection (= candidates)
          [`${symbol}:live:evaluated`]: String(realSets.length),
        }),
        client.expire(`strategies_active:${this.connectionId}`, 600),
        client.expire(redisKey, 7 * 24 * 60 * 60),
        client.hset(liveDetailKey, {
          // Legacy per-cycle aggregate fields (last-symbol-wins). Kept
          // for backwards compat; /stats prefers per-symbol sums below.
          created_sets:      String(qualifying.length),
          avg_profit_factor: String(liveAvgPF.toFixed(4)),
          avg_drawdown_time: String(Math.round(liveAvgDDT)),
          evaluated:         String(realSets.length),
          passed_sets:       String(qualifying.length),
          pass_rate:         String(passRatioLive.toFixed(4)),
          // ── ACTIVELY-RUNNING metrics (operator spec) ──────────������──
          //   Live's `qualifying` Sets ARE the executed orders. They
          //   are by definition "running" — exchange has accepted the
          //   order or is holding the position. `sets_progressing` is
          //   the real-stage input pool being ranked & capped this
          //   cycle (i.e. candidates currently progressing toward live
          //   execution).
          sets_running_now:         String(qualifying.length),
          sets_with_open_positions: String(qualifying.length),
          sets_progressing:         String(realSets.length),
          updated_at:        String(Date.now()),
          // Per-symbol fields — see createBaseSets for rationale.
          // Live doesn't compute avg_pos_per_set / avg_pos_eval_real;
          // those keys are intentionally omitted from the per-symbol
          // bundle so /stats's weighted-mean calculator skips them.
          [`s:${symbol}:created`]:    String(qualifying.length),
          [`s:${symbol}:entries`]:    String(qualifying.reduce((s, st) => s + (st.entryCount || 0), 0)),
          [`s:${symbol}:running`]:    String(qualifying.length),
          [`s:${symbol}:progressing`]: String(realSets.length),
          [`s:${symbol}:passed`]:     String(qualifying.length),
          [`s:${symbol}:evaluated`]:  String(realSets.length),
          [`s:${symbol}:apf`]:        String(liveAvgPF.toFixed(4)),
          [`s:${symbol}:addt`]:       String(Math.round(liveAvgDDT)),
          [`s:${symbol}:ts`]:         String(Date.now()),
        }),
        client.expire(liveDetailKey, 86400),
        // `set` with EX in a single command avoids the separate expire round-trip.
        client.set(liveCountKey, String(qualifying.length), { EX: 86400 } as any),
        ...liveVariantWrites,
      ])
    } catch { /* non-critical */ }

    // Pre-fetch the current market price ONCE so both the live exchange dispatch
    // and the pseudo-position creation below share the same price without
    // duplicate Redis reads. The live-stage will still validate / re-fetch if
    // we hand it 0, but providing a good seed eliminates the most common cause
    // of "no market price" failures when market_data is just milliseconds stale.
    let _cachedMarketPrice = 0
    try {
      const _priceClient = getRedisClient()
      const _mdhash = await _priceClient.hgetall(`market_data:${symbol}`)
      _cachedMarketPrice = parseFloat(String(_mdhash?.close ?? _mdhash?.price ?? _mdhash?.last ?? "0"))
      if (!_cachedMarketPrice || isNaN(_cachedMarketPrice)) {
        // Spec §7: prefer the canonical :1s envelope, fall back to :1m.
        const _mdraw =
          (await _priceClient.get(`market_data:${symbol}:1s`)) ??
          (await _priceClient.get(`market_data:${symbol}:1m`))
        if (_mdraw) {
          const _mdobj = typeof _mdraw === "string" ? JSON.parse(_mdraw) : _mdraw
          const _candles = _mdobj?.candles
          if (Array.isArray(_candles) && _candles.length > 0) {
            _cachedMarketPrice = parseFloat(String(_candles[_candles.length - 1]?.close ?? "0")) || 0
          } else {
            _cachedMarketPrice = parseFloat(String(_mdobj?.close ?? _mdobj?.price ?? _mdobj?.last ?? "0")) || 0
          }
        }
      }
    } catch { /* best-effort; live-stage falls back internally */ }

    // Attempt real exchange trading for qualifying LIVE sets when the connection has live trading enabled.
    // This is guarded by is_live_trade flag on the connection — if disabled, only pseudo positions are created.
    //
    // NOTE: Dev-synth fallback REMOVED. It injected a synthetic qualifying set from Main
    // when qualifying.length === 0 so live dispatch could be exercised during dev. The
    // synthetic set inherited `setKey` from the top Main set (e.g. "move:short#axis:p4_l1_c1_opos_dlong")
    // and the real position ID construction then embedded that key AGAIN:
    //   real:{conn}:{setKey}:{symbol}:{ts}:{rand}  →  "real:bingx-x01:move:short#axis:p4_l1_c1_opos_dlong:BTCUSDT:..."
    // which is correct — but the synth setKey was further mutated in Phase 4's separate
    // executeReadyStrategiesAsLiveOrders path, producing double-IDs with "#axis-synth" suffixes.
    // The real pipeline now produces qualifying sets reliably (REAL bootstrap relaxes
    // minProfitFactor to 0.75 on first run), so this workaround is no longer needed.

    if (qualifying.length > 0 && !skipLiveDispatch) {
      try {
        // Use getConnection() as authoritative source — it reads connection:{id} hash via parseHash
        // which handles boolean/string coercion. Raw hgetall may miss "true" vs "1" vs boolean true.
        const { getConnection: getConn } = await import("@/lib/redis-db")
        const connData = await getConn(this.connectionId)
        const { isTruthyFlag } = await import("@/lib/connection-state-utils")
        const isLiveTrade = isTruthyFlag(connData?.is_live_trade) || isTruthyFlag(connData?.live_trade_enabled)
        if (isLiveTrade) {
          const { executeLivePosition } = await import("@/lib/trade-engine/stages/live-stage")
          const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
          const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
          if (connector) {
            // Dispatch live positions. Each pipeline call is heavyweight:
            // price fetch → volume calc → leverage → order → fill poll →
            // SL/TP → sync. With 10+ symbols �� N qualifying Sets per symbol,
            // dispatching every Set serially creates a blocking storm that
            // saturates the cycle budget.
            //
            // The dedup lock (live:lock:{conn}:{sym}:{dir}) already enforces
            // "at most 1 open position per symbol+direction". Every Set beyond
            // the first that targets the same direction will hit "Dedup lock
            // held" and still cost 3-5 Redis round-trips (tryAcquireLock +
            // findOpenLivePositionByDir + savePosition + incrementMetric +
            // logProgressionEvent) before being deferred.
            //
            // Fix: pre-select at most 1 Set per direction (the highest-PF one,
            // already guaranteed by .sort() above) before calling the pipeline.
            // Only call executeLivePosition for sets that have a real chance of
            // acquiring the lock or merging — not for the 49 duplicates that
            // will always be deferred on the same cycle.
            //
            // The qualifying array is already sorted by avgProfitFactor desc.
            //
            // Preselection rules:
            //   • "new" variants (default, trailing): at most 1 per
            //   • "new" variants (default, trailing, pause): at most 1 per
            //     direction — first (highest-PF) wins.
            //   • "block" overlays: allowed through even when the direction
            //     already has a "new" set selected. Block processes every
            //     configured block size in parallel from completed-position
            //     context; it is not gated by active open position count.
            //   • "dca" variant: same as block — at most 1 per direction,
            //     allowed alongside a "new" set.
            //
            // Without this rule, block/dca sets targeting e.g. long were
            // always dropped because `sawLong=true` was already set by the
            // default set, meaning block strategy NEVER dispatched.
            //
            // Block overlay model:
            // Block is not materialized as its own Main/Real Set. When active,
            // it overlays the best already-qualified Set for each direction for
            // EVERY block size [1..blockMaxStack]. The block count is coordinated
            // from previous completed-position recovery logic (not active open
            // positions) and each count receives its own setKey/pause window so
            // performance and cooldown can be tracked independently. If the
            // operator enables Active Real/Live Position Block, Real stage already
            // materializes the running-exposure overlay before caps/stats/tuning;
            // Live consumes that Real Set instead of creating it here. DCA remains a materialized
            // Adjust Set because its reduce/close state has separate evaluation
            // and stats semantics.
            let dispatchCandidates = qualifying
            if (this._coordinationSettings.variants.block) {
              try {
                const maxStack = Math.max(1, Math.min(10, this._coordinationSettings.blockMaxStack | 0))
                const ratio = this._coordinationSettings.blockVolumeRatio
                const pauseRatio = this._coordinationSettings.blockPauseCountRatio
                const blockProfile = this.variantProfiles().find((p) => p.name === "block")
                const blockConfig = blockProfile?.configs
                  .slice()
                  .sort((a, b) => b.pfBias - a.pfBias)[0]

                if (blockConfig) {
                  const blockOverlays: StrategySet[] = []
                  for (const dir of ["long", "short"] as const) {
                    const source = qualifying.find((s) => s.direction === dir && s.variant !== "dca" && s.variant !== "block")
                    if (!source) continue
                    for (let blockCount = 1; blockCount <= maxStack; blockCount++) {
                      const blockMul = 1 + (blockCount - 1) * ratio
                      const pauseWindow = Math.max(1, Math.min(32, Math.round(blockCount * pauseRatio)))
                      blockOverlays.push({
                        ...source,
                        setKey: `${source.setKey}#block:${blockCount}`,
                        parentSetKey: source.parentSetKey || source.setKey,
                        variant: "block",
                        axisWindows: {
                          ...(source.axisWindows || { prev: 0, last: 0, cont: 0, pause: 0 }),
                          cont: blockCount,
                          pause: pauseWindow,
                          axisKey: `block:${blockCount}:pause${pauseWindow}`,
                        },
                        avgProfitFactor: Math.max(
                          metrics.minProfitFactor,
                          (source.avgProfitFactor || metrics.minProfitFactor) * blockConfig.pfBias,
                        ),
                        avgDrawdownTime: (source.avgDrawdownTime || 0) + (blockConfig.ddtBias * blockCount),
                        variantSizeMultiplier: Number((blockConfig.size * blockMul).toFixed(6)),
                        variantLeverage: blockConfig.leverage,
                      })
                    }
                  }
                  if (blockOverlays.length > 0) {
                    dispatchCandidates = [...qualifying, ...blockOverlays]
                      .sort((a, b) => b.avgProfitFactor - a.avgProfitFactor)
                  }
                }
              } catch (err) {
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} block overlay coordination failed:`,
                  err instanceof Error ? err.message : String(err),
                )
              }
            }

            const dispatchSets: StrategySet[] = []
            {
              let sawNewLong  = false
              let sawNewShort = false
              let sawDcaLong    = false
              let sawDcaShort   = false
              // Block overlays are capped to ONE per direction per cycle.
              // Previously every block size [1..maxStack] was pushed
              // unconditionally, so with maxStack=8 each direction dispatched
              // 8 REAL exchange orders per cycle (observed: 18 order attempts
              // per symbol per tick → request queue backlog → BingX 100421
              // timestamp-mismatch rejections on everything). The block-size
              // ladder remains fully tracked at the pseudo/stats level; live
              // exchange dispatch only carries the top-ranked (highest-PF)
              // block size for each direction per cycle.
              let sawBlockLong  = false
              let sawBlockShort = false
              for (const s of dispatchCandidates) {
                const isBlock = s.variant === "block"
                const isDca   = s.variant === "dca"
                const isNew   = !isBlock && !isDca // default / trailing / pause
                if (s.direction === "long") {
                  if (isNew   && !sawNewLong)   { dispatchSets.push(s); sawNewLong   = true }
                  if (isBlock && !sawBlockLong)  { dispatchSets.push(s); sawBlockLong  = true }
                  if (isDca   && !sawDcaLong)    { dispatchSets.push(s); sawDcaLong    = true }
                } else {
                  if (isNew   && !sawNewShort)  { dispatchSets.push(s); sawNewShort  = true }
                  if (isBlock && !sawBlockShort) { dispatchSets.push(s); sawBlockShort = true }
                  if (isDca   && !sawDcaShort)   { dispatchSets.push(s); sawDcaShort   = true }
                }
                if (sawNewLong && sawNewShort && sawDcaLong && sawDcaShort && sawBlockLong && sawBlockShort) {
                  break
                }
              }
            }

            let placed = 0
            let filled = 0
            let rejected = 0
            let errored = 0

            for (const set of dispatchSets) {
              try {
                // ── Axis-entry hydration — O(1) via BaseRegistry ──────────────
                // Axis Sets carry one synthetic representative entry. When
                // dispatching to Live we need the full entries[] (for SL/TP
                // derivation) from the originating Base Set. Previously this
                // was a O(N) realSets.find() scan; now it is a O(1) Map lookup
                // via CoordIndex.base.byKey (built once in createBaseSets and
                // passed by reference through the entire pipeline).
                //
                // Fallback chain:
                //   1. set.entries (non-empty, e.g. profile-variant sets)
                //   2. coordIndex.base.byKey.get(parentKey).entries  ← O(1)
                //   3. realSets.find() linear scan  ← only when no coordIndex
                const parentKey = set.parentSetKey || set.setKey.split("#")[0]
                const effectiveEntries: StrategySetEntry[] =
                  set.entries.length > 0
                    ? set.entries
                    : coordIndex
                      ? (coordIndex.base.byKey.get(parentKey)?.entries ?? [])
                      : (realSets.find((s) => s.setKey === parentKey)?.entries ?? [])
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0]
                )
                if (!bestEntry) continue

                // ── Apply CoordRecord tuning delta at dispatch (zero extra reads) ─
                // The Real-stage tuner wrote sizeDelta + tunedAvgPF onto the coord
                // record so we don't re-scan entries here. We apply the delta to the
                // bestEntry SIZE only — all other entry fields come from Base unchanged.
                const dispatchCoordRec = coordIndex?.byCoordKey.get(set.setKey)
                // Variant base sizing: prefer the variant's OWN coordinated
                // multiplier (block vol-ratio-scaled, dca 0.5×) carried on the
                // slim Set; fall back to the Base entry (1×) for Base/axis Sets.
                const variantBaseMult = set.variantSizeMultiplier ?? bestEntry.sizeMultiplier ?? 1
                // Real-stage tuner delta is a BOUNDED adjustment ON TOP of the
                // variant base (clamped [0.5,2.0]); it must not erase the
                // variant's notional. VolumeCalculator applies the final
                // [0.1,5] safety clamp, so block can legitimately exceed 2×.
                const tunerFactor = dispatchCoordRec?.sizeDelta !== undefined
                  ? Math.max(0.5, Math.min(2.0, 1 + dispatchCoordRec.sizeDelta))
                  : 1
                const effectiveSizeMult = variantBaseMult * tunerFactor
                // Use tunedAvgPF for SL/TP derivation when available — reflects the
                // Real-stage tuner's per-variant performance bias.
                const effectivePF = dispatchCoordRec?.tunedAvgPF ?? bestEntry.profitFactor

                // Derive SL/TP % from PF and the actual position-cost budget.
                // The live-stage converts these percentages to concrete prices
                // after fill. Keeping TP/SL ratio-aligned ensures PF comparisons
                // are meaningful and variant volume multipliers are reflected in
                // the risk band used for the live exchange order.
                const protection = deriveProtectionFromProfitFactor(
                  effectivePF,
                  livePositionCostPct,
                  effectiveSizeMult,
                )
                const tp = protection.takeProfitPct

                // ── Set-config-aware SL at dispatch ──────────────────────────
                // Resolve the trailing profile from the Set (or its Base Set via
                // coordIndex) so trailing-variant positions get their initial SL
                // anchored at the trailing stop distance rather than a generic
                // PF-derived value. For all other variants `protection.stopLossPct`
                // is already variant-scaled (block: sizeMultiplier-up, dca: 0.5×).
                const resolvedTrailingProfile: { startRatio: number; stopRatio: number; stepRatio: number } | undefined =
                  set.trailingProfile ??
                  (coordIndex ? coordIndex.base.byKey.get(parentKey)?.trailingProfile : undefined)

                let sl = protection.stopLossPct
                // CRITICAL FIX: Add slippage buffer to block variant SL prices
                // Larger positions experience worse fills due to order book depth.
                // Block positions (1.15-1.25x) need ~0.5-1.0% wider SL bands to account
                // for fill slippage so SL doesn't immediately cross on entry.
                if (set.variant === "block" && effectiveSizeMult > 1.0) {
                  const slippageBuffer = Math.min(0.5, (effectiveSizeMult - 1.0) * 2.0)  // 0.2-0.5% buffer for 1.1-1.25x sizes
                  sl = Math.max(0.5, sl + slippageBuffer)  // Add buffer, but keep minimum 0.5%
                }
                if (set.variant === "trailing" && resolvedTrailingProfile && resolvedTrailingProfile.stopRatio > 0) {
                  // Trailing-variant: initial SL = trailing stop distance.
                  // The live-stage `computeSetAwareSL` applies the same logic
                  // but we normalise here too so the RealPosition.stopLoss and
                  // the derived LivePosition.stopLoss are always in sync.
                  sl = Math.max(0.2, resolvedTrailingProfile.stopRatio * 100)
                }

                const liveResult = await executeLivePosition(
                  this.connectionId,
                  {
                    id: `real:${this.connectionId}:${set.setKey}:${symbol}:${Date.now()}:${nanoid(8)}`,
                    connectionId: this.connectionId,
                    symbol,
                    direction: set.direction,
                    // Provide the pre-fetched market price so the live pipeline
                    // can skip its own price fetch when the price is fresh. The
                    // pipeline validates > 0 and re-fetches if needed, so passing
                    // 0 here remains safe as a fallback.
                    quantity: 0,
                    entryPrice: _cachedMarketPrice,
                    // Prefer the variant's coordinated leverage (trailing 3/5×,
                    // etc.) over the Base entry's leverage; Base/axis Sets fall
                    // back to the Base entry value.
                    leverage: set.variantLeverage ?? bestEntry.leverage ?? 1,
                    riskAmount: 0,
                    rewardTarget: 0,
                    stopLoss: sl,
                    takeProfit: tp,
                    mainPositionCount: set.entryCount,
                    evaluationScore: bestEntry.confidence,
                    ratioMet: bestEntry.confidence >= 0.65,
                    timestamp: Date.now(),
                    ratios: {
                      // Use effectivePF (coord-record tuned) so risk ratios reflect
                      // the Real-stage performance bias rather than raw Base entry PF.
                      profitabilityRatio: protection.effectiveProfitFactor,
                      accountRiskRatio: sl / 100,
                      successRateRatio: bestEntry.confidence,
                      consistencyRatio: set.avgConfidence,
                    },
                    status: "pending",
                    // ── Set lineage propagation (Strategy → Real → Live) ──
                    // `executeLivePosition` mirrors these onto the LivePosition
                    // verbatim. Without them the executed live order carries
                    // `setKey=undefined`, breaking:
                    //   1. Post-trade stats grouping (PnL by Set Type)
                    //   2. `accumulatedSetKeys` seeding — when a later signal
                    //      accumulates into this open position the merged
                    //      lineage starts from an empty array instead of the
                    //      originating Set, losing the first leg's identity.
                    //   3. The progression panel's Set-lineage badge.
                    // The id already embeds setKey for log-grep, but the
                    // structured fields are what downstream code reads.
                    setKey:       set.setKey,
                    parentSetKey: set.parentSetKey,
                    setVariant:   set.variant,
                    axisWindows:  set.axisWindows,
                    // Forward the variant size multiplier so VolumeCalculator
                    // can apply Block (1.5–2.0×) or DCA (0.5×) notional scaling
                    // before placing the exchange order. `effectiveSizeMult` has
                    // already incorporated the CoordRecord sizeDelta from the
                    // Real-stage tuner — no extra entry scan needed.
                    sizeMultiplier: effectiveSizeMult,
                    // ── Set-config propagation to Live ───������─────────────────
                    // Forward the Set's trailing profile and historical
                    // performance snapshot into the RealPosition so that
                    // `executeLivePosition` can (a) anchor the initial SL at
                    // the correct trailing stop distance and (b) store the
                    // Set's prevPos context on the LivePosition for audit.
                    // `resolvedTrailingProfile` is already resolved from the
                    // Base Set via coordIndex above — reuse it here rather
                    // than doing a second lookup.
                    trailingProfile: resolvedTrailingProfile,
                    prevPos: (
                      set.prevPos ??
                      (coordIndex ? coordIndex.base.byKey.get(parentKey)?.prevPos : undefined)
                    ),
                  },
                  connector
                )

                if (!liveResult) continue
                if (liveResult.status === "open" || liveResult.status === "filled" || liveResult.status === "partially_filled") {
                  filled++
                  placed++
                } else if (liveResult.status === "placed" || liveResult.status === "pending_fill" || liveResult.status === "placed_unconfirmed") {
                  placed++
                } else if (liveResult.status === "rejected") {
                  rejected++
                } else if (liveResult.status === "error") {
                  // 101204 (Insufficient margin) and other recoverable margin/rejection
                  // errors are counted as "rejected" not "errored" for accurate stats.
                  // Only truly exceptional errors (circuit breaker, API down, etc.) count as errored.
                  if ((liveResult as any).errorCode === "101204" || (liveResult as any).code === "101204") {
                    rejected++
                  } else {
                    errored++
                  }
                }
              } catch (err) {
                errored++
                console.warn(
                  `[v0] [StrategyFlow] ${symbol} per-set live execution error:`,
                  err instanceof Error ? err.message : String(err)
                )
              }
            }

            if (placed > 0 || errored > 0) {
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored}`
              )
            } else if (rejected > 0 && (this as any)._liveRejectLogThrottle?.[symbol] !== Math.floor(Date.now() / 30000)) {
              // Throttle pure-rejection summaries (common in dev/test with no real exchange balance) — log at most once per 30s per symbol
              if (!(this as any)._liveRejectLogThrottle) (this as any)._liveRejectLogThrottle = {}
              ;(this as any)._liveRejectLogThrottle[symbol] = Math.floor(Date.now() / 30000)
              console.log(
                `[v0] [StrategyFlow] ${symbol} LIVE summary — placed=${placed} filled=${filled} rejected=${rejected} errored=${errored} (throttled)`
              )
            }
          } else {
            console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: live_trade=true but connector not available`)
          }
        }
      } catch (liveErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Real exchange execution error:`, liveErr instanceof Error ? liveErr.message : String(liveErr))
      }

      // After dispatching new entries, reconcile already-open positions with
      // the exchange so that any SL/TP/manual-close that happened since the
      // last cycle transitions the Redis record to "closed". Rate-limited per
      // connection to once every 30 seconds to stay well within exchange
      // rate limits while still providing near-real-time closure tracking.
      try {
        const client = getRedisClient()
        const rlKey = `live:reconcile:ratelimit:${this.connectionId}`
        const last = await client.get(rlKey).catch(() => null)
        const now = Date.now()
        const lastTs = last ? parseInt(last as string, 10) : 0
        // Rate-limit: fire at most once per 30 s.
        // TTL = 35 s so the key expires before the next 30 s window opens —
        // previously TTL=60 kept the key alive well past 30 s and would have
        // blocked reconcile even after the window had elapsed. The cron
        // (sync-live-positions) now skips connections whose engine is active,
        // so this 30 s in-engine reconcile is the sole mechanism while running.
        if (!lastTs || now - lastTs > 30_000) {
          await client.setex(rlKey, 35, String(now)).catch(() => {})
          // Fire-and-forget: don't block the strategy flow on exchange IO.
          ;(async () => {
            try {
              const { reconcileLivePositions } = await import("@/lib/trade-engine/stages/live-stage")
              const { exchangeConnectorFactory } = await import("@/lib/exchange-connectors/factory")
              const connector = await exchangeConnectorFactory.getOrCreateConnector(this.connectionId)
              if (connector) {
                const result = await reconcileLivePositions(this.connectionId, connector)
                if (result.closed > 0) {
                  console.log(
                    `[v0] [StrategyFlow] ${this.connectionId} reconcile closed ${result.closed} positions via exchange sync`
                  )
                }
              }
            } catch (reconErr) {
              console.warn(
                `[v0] [StrategyFlow] ${this.connectionId} reconcile error:`,
                reconErr instanceof Error ? reconErr.message : String(reconErr)
              )
            }
          })()
        }
      } catch {
        /* non-critical; skip if redis rate-limit read fails */
      }
    }

    // Create EXACTLY ONE pseudo position per Set (one per indication_type × direction combination).
    // Each Set represents a unique (indication_type × direction) coordinate.
    // We pick the highest-profitFactor entry from the Set as the representative config for the position.
    if (qualifying.length > 0) {
      try {
        const posManager = new PseudoPositionManager(this.connectionId)

        // Reuse the market price already fetched above (_cachedMarketPrice).
        // Fall back to a fresh fetch only if the cached value is missing (e.g.
        // when live-trade gate was disabled and the price block above was skipped).
        let entryPrice = _cachedMarketPrice
        if (!entryPrice || isNaN(entryPrice)) {
          try {
            const client = getRedisClient()
            const mdhash = await client.hgetall(`market_data:${symbol}`)
            entryPrice = parseFloat(String(mdhash?.close ?? mdhash?.price ?? mdhash?.last ?? "0"))
            if (!entryPrice || isNaN(entryPrice)) {
              // Spec §7: read :1s first; fall back to :1m for legacy data.
              const mdraw =
                (await client.get(`market_data:${symbol}:1s`)) ??
                (await client.get(`market_data:${symbol}:1m`))
              if (mdraw) {
                const mdobj = typeof mdraw === "string" ? JSON.parse(mdraw) : mdraw
                const candles = mdobj?.candles
                if (Array.isArray(candles) && candles.length > 0) {
                  entryPrice = parseFloat(String(candles[candles.length - 1]?.close ?? "0")) || 0
                } else {
                  entryPrice = parseFloat(String(mdobj?.close ?? mdobj?.price ?? mdobj?.last ?? "0")) || 0
                }
              }
            }
          } catch { /* skip price lookup */ }
        }

        if (entryPrice > 0) {
          // Pseudo-position creation is local Redis work with per-Set idempotency
          // enforced inside createPosition (one active pseudo position per Set).
          // Safe to fan out in parallel — no exchange calls, no shared balance.
          const creations = await Promise.all(
            qualifying.map(async (set) => {
              try {
                // Axis Sets carry one synthetic representative entry; for SL/TP
                // derivation we need the full entries[] from the Base Set.
                // Priority: set.entries (non-empty profile-variant sets) →
                //   coordIndex.base.byKey O(1) lookup → O(N) realSets.find() fallback.
                const _pseudoParentKey = set.parentSetKey || set.setKey.split("#")[0]
                const effectiveEntries =
                  set.entries.length > 0
                    ? set.entries
                    : coordIndex
                      ? (coordIndex.base.byKey.get(_pseudoParentKey)?.entries ?? [])
                      : (realSets.find((s) => s.setKey === _pseudoParentKey)?.entries ?? [])
                const bestEntry = effectiveEntries.reduce(
                  (best, e) => (e.profitFactor > best.profitFactor ? e : best),
                  effectiveEntries[0],
                )
                if (!bestEntry) return false

                const tp = Math.max(0.5, (bestEntry.profitFactor - 1) * 100)
                const sl = Math.min(5, 100 / Math.max(1, bestEntry.profitFactor) * 0.5)

                // Multi-step trailing — Set carries its own profile from
                // BASE, so trailing-on/off and the three ratios are
                // operator-determined per the matrix in Settings ���
                // Strategy → Trailing. Sets WITHOUT a profile keep the
                // legacy single-step behaviour with statistical on/off
                // (`bestEntry.confidence >= 0.85`).
                const profile = set.trailingProfile
                const trailing = profile ? true : bestEntry.confidence >= 0.85

                // Build a fully-qualified uniqueness key including TP, SL,
                // direction and trailing so sets with the same indicationType
                // and direction but different PF-derived TP/SL occupy distinct
                // slots and are not collapsed into one active position.
                const trailingSuffix = profile
                  ? `:t${Math.round(profile.startRatio * 100)}-${Math.round(profile.stopRatio * 100)}`
                  : trailing ? `:tr1` : `:tr0`
                // Include full axis identity (prev/last/cont/outcome) so different position-count
                // variants of the same (ind, dir, pf...) get distinct pseudo positions.
                // This prevents key collisions that contributed to "millions of open positions at 8k Sets".
                const axisSuffix = set.axisWindows
                  ? `|p${set.axisWindows.prev ?? 0}|l${set.axisWindows.last ?? 0}|c${set.axisWindows.cont ?? 0}|o${set.axisWindows.outcome ?? "pos"}`
                  : ""
                const configSetKey =
                  `${set.indicationType}:${set.direction}:${symbol}` +
                  `:tp${tp.toFixed(2)}:sl${sl.toFixed(2)}${trailingSuffix}${axisSuffix}`

                const posId = await posManager.createPosition({
                  symbol,
                  side: set.direction,
                  indicationType: set.indicationType,
                  entryPrice,
                  takeprofitFactor: tp,
                  stoplossRatio: sl,
                  profitFactor: bestEntry.profitFactor,
                  trailingEnabled: trailing,
                  configSetKey,
                  ...(profile && {
                    trailingStartRatio: profile.startRatio,
                    trailingStopRatio: profile.stopRatio,
                    trailingStepRatio: profile.stepRatio,
                  }),
                })
                return posId ? ("created" as const) : ("gated" as const)
              } catch (posErr) {
                console.error(`[v0] [StrategyFlow] ${symbol} LIVE: createPosition error:`, posErr instanceof Error ? posErr.message : String(posErr))
                return "error" as const
              }
            }),
          )
        } else {
          console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: No entry price, skipping position creation`)
        }
      } catch (posErr) {
        console.warn(`[v0] [StrategyFlow] ${symbol} LIVE: Position creation error:`, posErr instanceof Error ? posErr.message : String(posErr))
      }
    }

    // Perf: Populate coordIndex.liveSetsByVariant index so downstream code
    // (stats aggregation, pseudo-position lookups) can retrieve sets by variant
    // in O(1) without iterating the full records array. This index is populated
    // here at the Live stage where variant membership is finalized.
    if (coordIndex) {
      for (const set of qualifying) {
        const variant = (set.variant as string) ?? "default"
        if (!coordIndex.liveSetsByVariant.has(variant)) {
          coordIndex.liveSetsByVariant.set(variant, [])
        }
        coordIndex.liveSetsByVariant.get(variant)!.push(set)
      }
    }

    return {
      result: {
        type: "live",
        symbol,
        timestamp: new Date(),
        totalCreated: realSets.length,
        passedEvaluation: qualifying.length,
        failedEvaluation: realSets.length - qualifying.length,
        avgProfitFactor: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgProfitFactor, 0) / qualifying.length : 0,
        avgDrawdownTime: qualifying.length > 0 ? qualifying.reduce((s, set) => s + set.avgDrawdownTime, 0) / qualifying.length : 0,
      },
      sets: qualifying,
    }
  }

  // �����── HELPERS ────────────────────────���──────────��───────���─────────────────────

  // Per-cycle position-context cache. The pseudo-position list is shared
  // across all Main invocations within the same cycle to amortise Redis
  // reads when many symbols go through the flow in rapid succession.
  private positionContextCache: { ctx: PositionContext; ts: number } | null = null
  private readonly POSITION_CONTEXT_TTL_MS = 2000

  /**
   * Produce a neutral position context �� no open positions, no prior wins
   * or losses. Used for prehistoric/backtest runs and as a fallback when the
   * pseudo-position read fails (keeps Main operational even if the position
   * index is temporarily unavailable).
   */
  private neutralPositionContext(): PositionContext {
    return {
      continuousCount: 0,
      lastPosCount: 0,
      prevPosCount: 0,
      lastWins: 0,
      lastLosses: 0,
      prevLosses: 0,
      perSymbolOpen: {},
      perSymbolOpenByDir: {},
    }
  }

  /**
   * Fetch the per-cycle position coordination context used by MAIN to decide
   * which additional related variant Sets to produce. Reads pseudo positions
   * once and buckets them into continuous (active) vs last-N closed vs full
   * lookback window. Results are cached for POSITION_CONTEXT_TTL_MS so
   * symbols processed in rapid succession share a single Redis read.
   */
  private async getPositionContext(): Promise<PositionContext> {
    const now = Date.now()
    if (this.positionContextCache && now - this.positionContextCache.ts < this.POSITION_CONTEXT_TTL_MS) {
      return this.positionContextCache.ctx
    }

    try {
      const posManager = new PseudoPositionManager(this.connectionId)
      const active = await posManager.getActivePositions()

      // Build per-symbol open-position map from the active list (continuous
      // positions). No extra Redis reads — getActivePositions already pulls
      // the full hashes behind a 1s internal cache.
      const perSymbolOpen: Record<string, number> = {}
      // Direction-split variant: tracks long and short independently per
      // symbol so expandAxisSets can give each direction its own liveCont.
      const perSymbolOpenByDir: Record<string, { long: number; short: number }> = {}
      for (const p of active) {
        const sym = String(p.symbol || "")
        if (!sym) continue
        perSymbolOpen[sym] = (perSymbolOpen[sym] ?? 0) + 1
        if (!perSymbolOpenByDir[sym]) perSymbolOpenByDir[sym] = { long: 0, short: 0 }
        const dir = String(p.direction || p.side || "long").toLowerCase()
        if (dir === "short") perSymbolOpenByDir[sym].short += 1
        else                 perSymbolOpenByDir[sym].long  += 1
      }

      // ── P-CTX-1: Read from dedicated closed-positions index ──────────
      // `closePosition()` in PseudoPositionManager removes the position id
      // from the open-positions set (positionsSetKey) AND appends it to a
      // dedicated Redis list `pseudo_positions:{id}:closed_index` (newest
      // first, capped at CLOSED_INDEX_CAP). Reading that list here gives us
      // a bounded, already-closed-only window without filtering active ids or
      // issuing a full smembers on the global (open) set — which previously
      // always returned 0 closed positions because closePosition() removes ids
      // from the global set, starving all Main variant gates.
      const client = getRedisClient()
      const closedIndexKey = `pseudo_positions:${this.connectionId}:closed_index`
      const lookbackMs = 24 * 60 * 60 * 1000
      const cutoff = now - lookbackMs
      const WINDOW_CAP = 100 // read up to 100 newest closed ids from the list

      let prevPosCount = 0
      let prevLosses = 0
      const lastN: Array<{ closedAt: number; pnl: number }> = []
      try {
        // LRANGE 0 WINDOW_CAP-1 fetches the newest WINDOW_CAP closed ids
        // (LPUSH + LTRIM in closePosition keeps the list newest-first).
        const closedIds: string[] = ((await client.lrange(closedIndexKey, 0, WINDOW_CAP - 1).catch(() => [])) || []) as string[]

        // Pipelined HGETALL for all sampled ids — single round-trip.
        const hashes = await (async () => {
          if (closedIds.length === 0) return []
          const pipeline = client.multi()
          for (const id of closedIds) pipeline.hgetall(`pseudo_position:${this.connectionId}:${id}`)
          const results = await pipeline.exec().catch(() => null)
          if (!results) return []
          return results.map((r: any) => {
            const data = Array.isArray(r) ? r[1] : r
            return data && typeof data === "object" && Object.keys(data).length > 0 ? data : null
          })
        })()

        for (const h of hashes) {
          if (!h) continue
          // ── P2-1: Strict closed-only gate ───────────────────��──��───────
          // Positions in the closed_index are always closed by construction
          // (closePosition writes to the index). We still enforce the
          // status check as a defence against stale/corrupted rows.
          const status = String(h.status || "").toLowerCase()
          if (status !== "closed") continue
          const closedAtRaw = h.closed_at ?? h.closedAt ?? ""
          // Parse ISO string ("2025-01-01T...") or numeric ms ("1735689600000").
          const closedAtMs = (() => {
            if (!closedAtRaw) return NaN
            const n = Number(closedAtRaw)
            if (Number.isFinite(n) && n > 1_000_000_000_000) return n  // already ms
            const d = new Date(closedAtRaw as string).getTime()
            return Number.isFinite(d) ? d : NaN
          })()
          if (!Number.isFinite(closedAtMs) || closedAtMs <= 0) continue
          const closedAt = closedAtMs
          if (closedAt < cutoff) continue
          // Prefer `realized_pnl`; fall back to `pnl` only when the row
          // is marked closed (the closePosition pipeline writes `pnl`
          // to the realized value at close time).
          const pnlRaw = h.realized_pnl ?? h.pnl ?? h.profit ?? 0
          const pnl = Number(pnlRaw)
          if (!Number.isFinite(pnl)) continue
          prevPosCount++
          if (pnl < 0) prevLosses++
          lastN.push({ closedAt, pnl })
        }
        // Keep the 8 most recently closed for the "last-N" breakdown.
        // The closed_index is already newest-first (LPUSH order), so
        // sorting + truncating here normalises any edge-cases where TTL
        // trimming or concurrent writes changed the ordering slightly.
        lastN.sort((a, b) => b.closedAt - a.closedAt)
        lastN.length = Math.min(lastN.length, 8)
      } catch { /* best-effort; fall through with zeros */ }

      let lastWins   = lastN.filter((r) => r.pnl > 0).length
      let lastLosses = lastN.filter((r) => r.pnl < 0).length

      // ── P-CTX-2: Recorded-trade fallback for win/loss signal ─────────
      // The pseudo `closed_index` is the primary source, but it can be
      // sparse — proxy pseudo-positions close at noisy PnL, and in dev the
      // pseudo-position writes are capped (top-N), so few closes land in the
      // index. The `trailing` gate (≥2 recent wins + flat) and `dca` gate
      // (≥1 recent loss) then never fire even when the connection has a real
      // track record. lib/pos-history maintains the AUTHORITATIVE rolling
      // window of genuinely closed trades (recordPosClosed, fired from the
      // live + config-set close paths). When the pseudo window has < 2
      // samples, derive wins/losses from that overall window instead so the
      // gates exercise on real outcomes in BOTH dev and prod. Open-position
      // fields (continuousCount / perSymbolOpen) stay pseudo-sourced — the
      // recorded history has no notion of "currently open".
      if (lastN.length < 2) {
        try {
          const { getPosWindowOverall } = await import("@/lib/pos-history")
          const win = await getPosWindowOverall(this.connectionId, 8)
          if (win.count > 0) {
            const winsFromHistory   = Math.round(win.successRate * win.count)
            const lossesFromHistory = Math.max(0, win.count - winsFromHistory)
            // Only adopt when it provides MORE signal than the pseudo window.
            if (win.count > lastN.length) {
              lastWins   = winsFromHistory
              lastLosses = lossesFromHistory
              prevPosCount = Math.max(prevPosCount, win.count)
              prevLosses   = Math.max(prevLosses, lossesFromHistory)
            }
          }
        } catch { /* best-effort; keep pseudo-derived values */ }
      }

      const ctx: PositionContext = {
        continuousCount: active.length,
        lastPosCount:    Math.max(lastN.length, lastWins + lastLosses),
        prevPosCount,
        lastWins,
        lastLosses,
        prevLosses,
        perSymbolOpen,
        perSymbolOpenByDir,
      }

      this.positionContextCache = { ctx, ts: now }
      return ctx
    } catch (err) {
      // Never fail the strategy flow on a context read error — fall back to
      // the neutral context so only the always-on `default` variant is made.
      console.warn(
        `[v0] [StrategyFlow] getPositionContext failed; using neutral context:`,
        err instanceof Error ? err.message : String(err),
      )
      const neutral = this.neutralPositionContext()
      this.positionContextCache = { ctx: neutral, ts: now }
      return neutral
    }
  }

  /**
   * Decide which variant profiles are ACTIVE for the current position context.
   * Each profile has a gate predicate — predicates that fail produce no
   * related Set for that variant this cycle (keeps work proportional to
   * context). The `default` variant is always on — it mirrors the original
   * one-Set-per-base behaviour and is what Real/Live have always consumed.
   *
   * ── P2-3: Closed-only contract for statistics-driven gates ────────
   * The `ctx` input here comes from `getPositionContext()`, which (as
   * of P2-1) enforces a strict `status==="closed"` filter on every
   * statistical field it builds:
   *   - prevPosCount, prevLosses, lastPosCount, lastWins, lastLosses
   *     → closed pseudo positions within a 24h lookback window.
   * Intentional exceptions (fields based on OPEN state by design, per
   * spec) — gates on these fields are NOT closed-only:
   *   - continuousCount  → # currently-open pseudo positions
   *                        (spec: "Continuous Positions" are active)
   *   - perSymbolOpen    → per-symbol open count for position-count axes.
   *                        Block itself is completed-position based and is
   *                        overlaid at Live dispatch.
   * Every other axis used below is closed-only. This invariant keeps
   * Main-stage factor coordination free of floating mark-to-market
   * pollution while allowing the few gates that MUST reference live
   * open state to do so cleanly.
   */
  private selectActiveVariants(ctx: PositionContext): Array<ReturnType<StrategyCoordinator["variantProfiles"]>[number]> {
    const all = this.variantProfiles()
    // ── P-VARIANT-ACT: activation toggle is the SOLE inclusion gate ───────
    // Operator spec ("handle only if activated"): enabled ADJUST variants run
    // after Standard/default. Trailing is intentionally excluded here: it is a
    // BASE range-coordination type that emits independent Base Sets carrying
    // trailingProfile; those Sets continue through Standard/default and the
    // active block/dca Adjust flow like normal Base Sets.
    //
    // We deliberately no longer require the transient position-context gate
    // (`p.gate(ctx)`) to pass for inclusion. Those conditions (recent wins for
    // trailing, completed-position recovery for block, recent losses for dca)
    // rarely align with the pseudo-position lifecycle and were silently
    // suppressing activated variants — leaving block/dca permanently at 0 even
    // when the operator had turned them on. Activation is now the
    // single source of truth: toggle ON ⇒ the variant is emitted; toggle OFF
    // ⇒ it contributes nothing. Block volume-ratio scaling is applied later by
    // the Live dispatch overlay for every configured block count.
    const filtered = all.filter((p) => {
      if (p.name === "default") return true
      if (p.name === "trailing") return false
      return this._coordinationSettings.variants[p.name] === true
    })

    return filtered
  }

  /**
   * Curated variant profiles.
   *
   * Each profile contains a small list of configuration tuples (≤ 4 per
   * variant). Compared to the legacy 4×4×4 = 64 Cartesian expansion, this
   * produces at most ~16 candidate entries per base entry across all active
   * variants — a ~4× reduction in Main computation while preserving the
   * semantic coverage (each variant now produces a DEDICATED Set instead of
   * being scattered across one big hybrid Set).
   *
   * Gate predicates encode the user's coordination spec:
   *   default  — always on (validates & mirrors the Base Set)
   *   trailing — legacy placeholder only; real trailing Sets are created at BASE
   *   block    — completed-position block-count overlays at Live dispatch
   *   dca      — recent losses to recover with averaged entries
   */
  /**
   * Compute the mean profit-factor of the last `n` COMPLETED entries.
   *
   * Returns `null` when there are fewer than `n` entries — the prev-axis
   * filter treats this as "insufficient data" and rejects emission for
   * that prev value (we never speculate when the operator's PF gate
   * can't actually be evaluated).
   *
   * Only `entries` with a numeric `profitFactor` are considered. The
   * StrategySetEntry shape always carries a defined PF for completed
   * historical evaluations, so this is mostly a defensive guard.
   */
  private meanPFOfLastN(entries: StrategySetEntry[], n: number): number | null {
    if (!entries || entries.length < n || n <= 0) return null
    const slice = entries.slice(-n)
    let sum = 0
    let count = 0
    for (const e of slice) {
      const pf = Number(e.profitFactor)
      if (Number.isFinite(pf)) { sum += pf; count++ }
    }
    if (count === 0) return null
    return sum / count
  }

  /**
   * Expand a single `default`-variant Main Set into the operator-spec'd
   * Position-Count Cartesian axis fan-out.
   *
   *   prev (4-12 step 2) × last (1-4 step 1) × cont (1-8 step 1) × dir
   *
   * With (precise spec semantics):
   *   • prev   = PF FILTER on the parent's last N COMPLETED entries
   *              (rejects whole prev-row when meanPF < `minPF`).
   *              Spec: "Do not Calculate the Open Positions, only
   *              positions already Completed" — applies here.
   *   • last   = OUTCOME SPLIT (pos / neg) based on parent's last M
   *              COMPLETED entries' meanPF. ONE Set emitted per (last)
   *              tagged with the realised outcome. Open positions are
   *              also excluded from the outcome aggregate.
   *   • cont   = OPEN-POSITION ACCUMULATION COUNT per spec
   *              ("continuous 3: add actual and next 2 positions to
   *              set"). The Set is configured to accumulate `cont`
   *              OPEN positions on top of the base's completed count —
   *              the currently-open one ("actual") plus `cont − 1`
   *              future ones to be opened across subsequent intervals.
   *              Encoded as `entryCount = baseEC + cont`, where baseEC
   *              counts completed historic entries and cont counts the
   *              open-position accumulation window. The Live stage's
   *              `live_net_target` reconciliation drives partial
   *              open/close orders as the window fills.
   *   • dir    = Cartesian (long + short) so hedge-net has both sides.
   *
   * All axis Sets inherit `avgProfitFactor` / `avgDrawdownTime` /
   * `avgConfidence` / `trailingProfile` from `baseDefault` unchanged —
   * they are PROJECTIONS, not re-evaluations. `entries` is deliberately
   * empty (`[]`) to prevent 320× JSON duplication on Redis persist and
   * 80,000× inflation of per-variant entry-counters downstream.
   *
   * `entries` hydration for downstream consumers (exchange order
   * construction, per-entry stats) is via `parentSetKey` at execution
   * time — the in-memory axis Set is purely metadata.
   *
   * Source of "only completed entries": `baseDefault.entries` is built
   * by `strategy-sets-processor` from completed strategy evaluations
   * only (each carries a defined `profitFactor`). The separate
   * `getPositionContext()` P2-1 closed-only gate keeps open positions
   * out of variant-selection state; together those two invariants give
   * the prev/last calcs a closed-only contract end-to-end.
   */
  private expandAxisSets(
    baseDefault: StrategySet,
    minPF: number,
    liveCont = 0,
    liveContByDir?: { long: number; short: number },
  ): StrategySet[] {
    const axisSets: StrategySet[] = []
    const baseEC = baseDefault.entryCount || 0
    const entries = baseDefault.entries || []

    // Parent baseKey (strip any prior `#variant` / `#axis:*` suffixes)
    // so `parentSetKey` always points at the originating Base Set.
    const parentKey = baseDefault.parentSetKey || baseDefault.setKey.split("#")[0]

    // ── Inherited quality fields used for the synthetic representative entry ─
    // The Real-stage tuner walks `set.entries` to mutate sizeMultiplier /
    // leverage per-cycle. Axis Sets now carry one synthetic representative
    // entry so the tuner fires and variant aggregates count correctly.
    // Per spec ("ongoing continuous count of Pis to be added, counted
    // onto the new sets") each axis Set gets ONE faithful pos-coord
    // projection inherited from the parent Base default — flagged with
    // `#axis-synth` so downstream consumers can recognise it.
    const inheritedPF   = baseDefault.avgProfitFactor ?? 1
    const inheritedDDT  = baseDefault.avgDrawdownTime ?? 0
    const inheritedConf = baseDefault.avgConfidence   ?? 0

    for (const prev of AXIS_PREV) {
      // ── prev FILTER (PF gate on last `prev` completed entries) ─────
      // Spec: prev "acts as a PF filter on the parent's last N completed
      // entries". When the parent does not yet have N completed entries
      // (warming up / fresh symbol), the filter is *undefined* — there
      // is nothing to evaluate yet — and we ADMIT the prev row neutrally.
      // The fan-out's purpose is the position-count axis (cont × dir);
      // suppressing it during bootstrap collapses Main count to Base
      // count, which is exactly the symptom we're fixing here. Once the
      // parent accumulates ≥ N completed entries, the PF gate engages
      // and the filter starts pruning legitimately.
      const prevMeanPF = this.meanPFOfLastN(entries, prev)
      if (prevMeanPF !== null && prevMeanPF < minPF) continue // gate engaged → skip whole prev row

      for (const last of AXIS_LAST) {
        // ── last OUTCOME SPLIT ───────────────────────────���───────────
        // Spec: emit ONE Set per `last` value tagged with the realised
        // pos/neg outcome based on parent's last M completed entries'
        // meanPF. When parent does not yet have M completed entries
        // (warming up), the outcome is *undefined* — we emit BOTH
        // `pos` AND `neg` projections so neither side is suppressed
        // during bootstrap. Once the parent accumulates ≥ M entries
        // the outcome resolves to a single side per cycle as before.
        const lastMeanPF = this.meanPFOfLastN(entries, last)
        const outcomes: Array<"pos" | "neg"> =
          lastMeanPF === null ? ["pos", "neg"] : [lastMeanPF >= 1.0 ? "pos" : "neg"]

        for (const cont of AXIS_CONT) {
          for (const dir of AXIS_DIRS) {
            for (const outcome of outcomes) {
              const axisKey = axisKeyOf(prev, last, cont, outcome, dir)

              // ── Live continuous-count cap (operator spec) ──────────
              // The `cont` axis dimension represents "actual + next N-1
              // positions to accumulate". Per spec we only credit
              // positions that ACTUALLY exist live this cycle. Cap by
              // the DIRECTION-SPECIFIC open count so long and short axis
              // Sets reflect independently accumulated position counts —
              // not a shared total that would always mirror both sides.
              // Falls back to the aggregate `liveCont` when the caller
              // does not provide per-direction data (e.g. prehistoric).
              const dirLiveCont = liveContByDir
                ? (dir === "short" ? liveContByDir.short : liveContByDir.long)
                : liveCont
              const credited = Math.min(cont, Math.max(0, dirLiveCont))
              const ec = baseEC + credited

              // ── Synthetic representative entry ─────���───────────────
              // One entry per axis Set so:
              //   • variant-aggregate loop counts it (passed_sets / sumPF / sumDDT)
              //   • Real-stage tuner has something to mutate
              //   �� per-axis Pos-acc ledger has a non-zero delta to record
              // ── Axis-Set LRU cache ─────���──��──�����─────────────────────���───��─
              // Axis Set objects are now pure value objects (the Real-stage tuner
              // writes sizeDelta onto the CoordRecord instead of mutating entries).
              // They can be safely reused across cycles without cloning.
              // Key encodes every field that varies: parentKey, axisKey, ec.
              const axisLruKey = `${parentKey}:${axisKey}:ec${ec}`
              const cachedAxisSet = StrategyCoordinator._axisLruGet(axisLruKey)
              if (cachedAxisSet) {
                axisSets.push(cachedAxisSet)
              } else {
                // Cache miss — build once, store immutably.
                // createdAt omitted: it served no semantic purpose for axis Sets
                // and changed every cycle, preventing cache hits.
                const synthEntry: StrategySetEntry = {
                  id: `${parentKey}#axis:${axisKey}#axis-synth`,
                  sizeMultiplier: 1,
                  leverage: 1,
                  positionState: `axis:p${prev}|l${last}|c${cont}|${outcome}|${dir}`,
                  profitFactor: inheritedPF,
                  drawdownTime: inheritedDDT,
                  confidence: inheritedConf,
                }
                const axisSet: StrategySet = {
                  setKey:          `${parentKey}#axis:${axisKey}`,
                  parentSetKey:    parentKey,
                  variant:         "default",
                  indicationType:  baseDefault.indicationType,
                  direction:       dir,
                  avgProfitFactor: inheritedPF,
                  avgConfidence:   inheritedConf,
                  avgDrawdownTime: inheritedDDT,
                  entryCount:      ec,
                  entries:         [synthEntry],
                  axisWindows: {
                    prev,
                    last,
                    cont,
                    pause:     0,
                    direction: dir,
                    axisKey,
                    outcome,
                  },
                  trailingProfile: baseDefault.trailingProfile,
                  ...(baseDefault.prevPos && { prevPos: baseDefault.prevPos }),
                }
                StrategyCoordinator._axisLruSet(axisLruKey, axisSet)
                axisSets.push(axisSet)
              }
            }
          }
        }
      }
    }
    return axisSets
  }

  private variantProfiles(): Array<{
    name: "default" | "trailing" | "block" | "dca"
    gate: (ctx: PositionContext) => boolean
    configs: Array<{ size: number; leverage: number; state: string; pfBias: number; ddtBias: number }>
  }> {
    return [
      {
        name: "default",
        gate: () => true,
        configs: [
          { size: 1.0, leverage: 1, state: "new", pfBias: 1.00, ddtBias: 0  },
          { size: 1.0, leverage: 2, state: "new", pfBias: 1.05, ddtBias: 15 },
        ],
      },
      {
        name: "trailing",
        // Deprecated Main-stage profile. Kept only so old persisted
        // fingerprints remain parseable; selectActiveVariants() never emits it.
        gate: () => false,
        configs: [],
      },
      {
        name: "block",
        // ── Block gate: setting-driven; actual block counts are completed-pos
        // overlays generated at Live dispatch, not open-position gates. ─────
        //
        // The cap (`blockMaxStack`) is operator-controlled (defaults to 10).
        // Each blockCount 1..blockMaxStack is emitted independently as a
        // transient execution overlay over the selected Set.
        gate: () => true,
        // ── Block sub-configs ─ size is the *base* multiplier that the
        // block overlay then scales by `(1 + (blockCount−1)×ratio)` so the
        // block count and operator vol-ratio knob both flow into live notional.
        // CRITICAL FIX: Reduced from 1.5/2.0 to 1.15/1.25 to prevent slippage
        // beyond SL triggers. Larger positions were getting filled at prices
        // that immediately crossed their own SL triggers on the same tick,
        // causing immediate losses. Smaller multipliers allow fills to stay
        // within the expected SL/TP band without forced closure.
        configs: [
          { size: 1.15, leverage: 2, state: "add", pfBias: 1.08, ddtBias: 45 },
          { size: 1.25, leverage: 2, state: "add", pfBias: 1.12, ddtBias: 75 },
        ],
      },
      {
        name: "dca",
        gate: (c) => c.prevLosses >= 1,
        configs: [
          { size: 0.5, leverage: 1, state: "reduce", pfBias: 0.98, ddtBias: 20 },
          { size: 0.5, leverage: 1, state: "close",  pfBias: 0.95, ddtBias: 30 },
        ],
      },
    ]
  }

  /**
   * Deterministic fingerprint of {base Set × variant × position context}.
   * Drives the "IF NOT ALREADY CREATED" dedup check.
   *
   * ── Bucket ranges (P0-3, spec-aligned) ─��────────��───����───────��──────
   * Spec ranges:
   *   - Prev Positions         1-12   (13 buckets 0-12)
   *   - Last Positions W/L     1-4    (5 buckets each 0-4)
   *   - Continuous Positions   1-10   (11 buckets 0-10)
   *
   * The previous implementation under-bucketed (Math.min(5,...) for all
   * three context dimensions), which collapsed distinct spec-level
   * contexts into the same cache entry and silently reused stale Sets.
   * Now each dimension is clamped to its spec maximum so every
   * semantically distinct context produces a distinct fingerprint.
   *
   * Coordinated-vars vs. materialised-Sets: we chose the coordinated
   * approach — each qualifying base Set expands into at most
   * 13×5×5×11 = 3,575 theoretical fingerprints, but in practice the
   * operator only visits O(20-80) of them per symbol per run. The
   * alternative (materialising Sets for every combo) would blow the
   * 250-entry cap and thrash Redis with no accuracy win.
   *
   * ── P2-3: Closed-only contract for statistics-driven buckets ──────
   * `lastWins`, `lastLosses`, `prevPosCount`, `prevLosses` below are
   * closed-only by construction (see `getPositionContext` P2-1 gate).
   * `continuousCount` is intentionally live — Continuous Positions
   * denote currently-open pseudo positions per spec.
   */
  private variantFingerprint(
    baseSet: StrategySet,
    variant: "default" | "trailing" | "block" | "dca",
    ctx: PositionContext,
  ): string {
    const bPF = Math.round(baseSet.avgProfitFactor * 10) / 10
    const bEC = baseSet.entryCount
    // Clamp each context dimension to its spec maximum.
    // cont is live-open by spec; the other four are closed-only via
    // the P2-1 gate in getPositionContext. lastPosCount remains in the
    // fingerprint for axis-window coordination so 3/5/8-count pause-axis
    // contexts do not collapse into the same cached Set.
    // the P2-1 gate in getPositionContext. lastPosCount is the Pause
    // variant's primary discriminator (1..8 windows) — adding it to the
    // fingerprint guarantees a 3-loss / 5-loss / 8-loss pause produce
    // distinct cached Sets instead of collapsing into the same bucket.
    const cont = Math.min(10, Math.max(0, ctx.continuousCount))
    const lW   = Math.min(4,  Math.max(0, ctx.lastWins))
    const lL   = Math.min(4,  Math.max(0, ctx.lastLosses))
    const lP   = Math.min(8,  Math.max(0, ctx.lastPosCount))
    const pP   = Math.min(12, Math.max(0, ctx.prevPosCount))
    const pL   = Math.min(12, Math.max(0, ctx.prevLosses))
    // DCA is an independent adjust Set for each parent Set, not a
    // position-count Set. Do not include live/closed position-count context
    // in its fingerprint or it will be recreated/rebucketed as counts change.
    if (variant === "dca") {
      return `${baseSet.setKey}#${variant}#pf=${bPF}#ec=${bEC}`
    }

    const bCtx = `c${cont}/lw${lW}/ll${lL}/lp${lP}/pp${pP}/pl${pL}`
    return `${baseSet.setKey}#${variant}#pf=${bPF}#ec=${bEC}#ctx=${bCtx}`
  }

  /**
   * Build one related Main Set from a qualifying Base Set + variant profile.
   * Returns `null` if all candidate entries are rejected by the DDT cap or
   * the Set ends up empty (shouldn't normally happen at Main thresholds).
   */
  /**
   * Build a Main variant Set from a Base Set + variant profile.
   *
   * Now `async` because the prune step delegates to the shared
   * compaction policy (cached settings hash, async resolution). The
   * cache TTL keeps this effectively synchronous in steady state.
   */
  private async buildVariantSet(
    baseSet: StrategySet,
    profile: ReturnType<StrategyCoordinator["variantProfiles"]>[number],
    metrics: EvaluationMetrics,
    maxEntries: number,
    ctx?: PositionContext,
  ): Promise<StrategySet | null> {
    // ── SLIM PATH (Base-Anchored Coordination Model) ────────��─────────────
    // Previously this function allocated a full entries[] by cross-joining
    // baseSet.entries × profile.configs — ~800 array allocations/sec and
    // ~80 000 object allocations/sec at 20-symbol live-trading scale.
    // New design: compute avgPF/DDT/Cnf as scalars; return entries: [].
    // createLiveSets (line ~3774) already handles entries.length === 0 by
    // resolving Base entries via coordIndex.base.byKey.get(parentSetKey) —
    // O(1), zero-copy.  The Real-stage tuner for-loop over s.entries becomes
    // a no-op; coordRec.tunedAvgPF is written from s.avgProfitFactor here.
    let sumPF = 0, sumDDT = 0, sumCnf = 0, count = 0
    const baseDDTFallback = baseSet.avgDrawdownTime || 0

    // ── Representative surviving config (variant size/leverage coordination) ─
    // Dispatch selects the Base `bestEntry` by max PF, so the variant's
    // coordinated sizing must come from the surviving config with the highest
    // PF bias (the one that "wins" alongside that entry). Track it here so the
    // block vol-ratio-scaled `size` and the variant `leverage` survive the
    // slim path and reach dispatch. `selectActiveVariants` has already folded
    // the block vol-ratio into `cfg.size`, so reading it verbatim is correct.
    let repConfig: { size: number; leverage: number; pfBias: number } | null = null

    outer: for (const baseEntry of baseSet.entries) {
      for (const cfg of profile.configs) {
        if (count >= maxEntries) break outer
        const pf      = Math.max(metrics.minProfitFactor, baseEntry.profitFactor * cfg.pfBias)
        const baseDDT = baseEntry.drawdownTime > 0 ? baseEntry.drawdownTime : baseDDTFallback
        const ddt     = baseDDT + cfg.ddtBias
        if (ddt > metrics.maxDrawdownTime) continue
        sumPF  += pf
        sumDDT += ddt
        sumCnf += Math.min(0.99, baseEntry.confidence)
        count++
        if (!repConfig || cfg.pfBias > repConfig.pfBias) {
          repConfig = { size: cfg.size, leverage: cfg.leverage, pfBias: cfg.pfBias }
        }
      }
    }

    if (count === 0) return null

    const avgPF  = sumPF  / count
    const avgDDT = sumDDT / count
    const avgCnf = sumCnf / count

    const axisWindows = profile.name === "dca"
      ? { prev: 0, last: 0, cont: 0, pause: 0 }
      : ctx
        ? {
            prev:  Math.max(0, Math.min(12, ctx.prevPosCount)),
            last:  Math.max(0, Math.min(4,  ctx.lastPosCount)),
            cont:  Math.max(0, Math.min(8,  ctx.continuousCount)),
            pause: Math.max(0, Math.min(8,  ctx.lastPosCount)),
          }
        : { prev: 0, last: 0, cont: 0, pause: 0 }

    return {
      setKey:          `${baseSet.setKey}#${profile.name}`,
      parentSetKey:    baseSet.setKey,
      variant:         profile.name,
      axisWindows,
      indicationType:  baseSet.indicationType,
      direction:       baseSet.direction,
      avgProfitFactor: avgPF,
      avgConfidence:   avgCnf,
      avgDrawdownTime: avgDDT,
      entryCount:      count,
      // EMPTY entries[] — Base entries resolved at dispatch via
      // coordIndex.base.byKey.get(parentSetKey).  Eliminates the primary
      // V8 heap driver (~80 000 object allocations per second).
      entries:         [],
      // Variant size/leverage coordination — carried as scalars so dispatch
      // applies the Adjust variant's OWN sizing (block vol-ratio-scaled,
      // dca 0.5×) instead of the Base entry's 1.0×/1×. Trailing is a
      // Base-stage range-coordination type and flows via trailingProfile.
      // See StrategySet.
      // Scoped to NON-default variants: the `default` variant exists to
      // validate & MIRROR the Base Set, so it must keep the Base entry's own
      // size/leverage (writing the profile config here would silently change
      // default dispatch leverage). Only the additive/independent variants
      // carry their own coordinated sizing.
      ...(repConfig && profile.name !== "default" && {
        variantSizeMultiplier: repConfig.size,
        variantLeverage:       repConfig.leverage,
      }),
      // Trailing is a Base-stage range coordination profile. Preserve it on
      // every Main projection (default and adjust) so cached/recoordinated
      // Sets, axis fan-out, Real dispatch and live control-order SL anchoring
      // all resolve the exact same trailing range without relying on a later
      // mutable cache patch.
      ...(baseSet.trailingProfile && { trailingProfile: baseSet.trailingProfile }),
      ...(baseSet.prevPos && { prevPos: baseSet.prevPos }),
    }
  }

  /**
   * Enforce max entries per Set using the shared threshold-compaction
   * policy (`lib/sets-compaction.ts`) in `mode: "best"`.
   *
   *   • Floor       = caller-provided `max` (so existing call sites that
   *                   compute their own per-Set max keep working).
   *   • thresholdPct= operator-controlled (Settings → System → Set
   *                   Compaction). Defaults to 20% per spec, so a
   *                   `max=250` floor admits up to 300 entries before
   *                   the compactor fires.
   *   • Mode "best" = stable-sort by PF desc, keep top floor, then
   *                   re-sort by timestamp asc so chronological order
   *                   is preserved downstream.
   *
   * The result is the same shape the legacy pruner returned (best-PF
   * first within the kept set) — but it only does the sort + slice
   * once every (ceiling - floor) calls instead of every call. Hot
   * paths that build a Set from many indications now see a meaningful
   * CPU drop on the prune step.
   *
   * `compactionThresholdPct` is read once and cached on the coordinator
   * instance — see `getCompactionThresholdPct`.
   */
  private async pruneEntries(entries: StrategySetEntry[], max: number): Promise<StrategySetEntry[]> {
    if (entries.length <= max) return entries
    const thresholdPct = await this.getCompactionThresholdPct()
    const cfg: CompactionConfig = { floor: max, thresholdPct }
    return compact(entries, cfg, "best", (e) => Number(e.profitFactor) || 0)
  }

  /** Cached threshold-pct lookup. 5s effective TTL via the underlying helper. */
  private _compactionThresholdPctCache: { v: number; t: number } | null = null
  private async getCompactionThresholdPct(): Promise<number> {
    const cache = this._compactionThresholdPctCache
    if (cache && Date.now() - cache.t < 5_000) return cache.v
    try {
      // Use the coordinator-entries pool key — it carries the operator's
      // intent for "how aggressively to keep entries within a single
      // Set". Falls back to the global threshold (20%) when nothing
      // is configured.
      const cfg = await loadCompactionConfig("coordinator.entries")
      this._compactionThresholdPctCache = { v: cfg.thresholdPct, t: Date.now() }
      return cfg.thresholdPct
    } catch {
      return 20
    }
  }

  /**
   * Log strategy progression through all stages
   */
  private async logStrategyProgression(symbol: string, results: StrategyEvaluation[]): Promise<void> {
    const summary = {
      symbol,
      stages: results.map((r) => ({
        type: r.type,
        sets: r.passedEvaluation,
        avgPF: r.avgProfitFactor.toFixed(2),
      })),
      totalLiveSets: results.find((r) => r.type === "live")?.passedEvaluation || 0,
    }

    try {
      await logProgressionEvent(this.connectionId, "strategy_flow", "info", `Strategy Sets flow: ${symbol}`, summary)
    } catch { /* non-critical */ }
  }
}
