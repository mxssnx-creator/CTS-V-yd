export interface DetailedIndicationCount {
  type: string
  parameter: string
  from: number
  to: number
  step: number
  count: number
}

export interface MarketActivitySettings {
  enabled: boolean
  minPriceChange: number
  minVolatility: number
  checkInterval: number
  activationThreshold: number
  deactivationThreshold: number
  calculationRange: number // Added calculation range
  calculationFrame: number // Added calculation frame
  positionCostRatioIndex: number // Added position cost ratio index
}

export interface IndicationCalculationResult {
  direction: DetailedIndicationCount[]
  move: DetailedIndicationCount[]
  active: DetailedIndicationCount[]
  total_direction: number
  total_move: number
  total_active: number
  total_all_indications: number

  tp_factors: number
  sl_ratios: number
  trailing_options: number

  configs_per_direction: number
  positions_per_direction: number

  total_both_directions: number

  detailed_breakdown: string
}

export class IndicationCalculator {
  async calculate(): Promise<IndicationCalculationResult> {
    // Direction Indications
    const directionRange: DetailedIndicationCount = {
      type: "Direction",
      parameter: "Range",
      from: 3,
      to: 30,
      step: 1,
      count: Math.floor((30 - 3) / 1) + 1, // 28
    }

    const directionDrawdown: DetailedIndicationCount = {
      type: "Direction",
      parameter: "Drawdown Ratio",
      from: 0.1,
      to: 0.5,
      step: 0.1,
      count: Math.floor((0.5 - 0.1) / 0.1) + 1, // 5
    }

    const directionMarketChangeRange = Math.floor((10 - 1) / 2) + 1 // 5 variations: 1, 3, 5, 7, 9
    const directionMarketChangeRatios = Math.floor((2.5 - 1.0) / 0.5) + 1 // 4 variations: 1.0, 1.5, 2.0, 2.5

    const total_direction =
      directionRange.count * directionDrawdown.count * directionMarketChangeRange * directionMarketChangeRatios
    // 28 × 5 × 5 × 4 = 2,800

    // Move Indications
    const moveRange: DetailedIndicationCount = {
      type: "Move",
      parameter: "Range",
      from: 3,
      to: 30,
      step: 1,
      count: Math.floor((30 - 3) / 1) + 1, // 28
    }

    const moveDrawdown: DetailedIndicationCount = {
      type: "Move",
      parameter: "Drawdown Ratio",
      from: 0.1,
      to: 0.5,
      step: 0.1,
      count: Math.floor((0.5 - 0.1) / 0.1) + 1, // 5
    }

    const moveMarketChangeRange = Math.floor((10 - 1) / 2) + 1 // 5 variations: 1, 3, 5, 7, 9
    const moveMarketChangeRatios = Math.floor((2.5 - 1.0) / 0.5) + 1 // 4 variations: 1.0, 1.5, 2.0, 2.5

    const total_move = moveRange.count * moveDrawdown.count * moveMarketChangeRange * moveMarketChangeRatios
    // 28 × 5 × 5 × 4 = 2,800

    // Active Indications
    const activeRange: DetailedIndicationCount = {
      type: "Active",
      parameter: "Active Range (1-10)",
      from: 1,
      to: 10,
      step: 1,
      count: Math.floor((10 - 1) / 1) + 1, // 10
    }

    const activeCalculated: DetailedIndicationCount = {
      type: "Active",
      parameter: "Activity for Calculated %",
      from: 10,
      to: 90,
      step: 10,
      count: Math.floor((90 - 10) / 10) + 1, // 9
    }

    const activeLastPart: DetailedIndicationCount = {
      type: "Active",
      parameter: "Activity Last Part %",
      from: 10,
      to: 90,
      step: 10,
      count: Math.floor((90 - 10) / 10) + 1, // 9
    }

    const activeMarketChangeRange = Math.floor((10 - 1) / 1) + 1 // 10 variations: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
    const activeMarketChangeRatios = Math.floor((2.5 - 1.0) / 0.5) + 1 // 4 variations: 1.0, 1.5, 2.0, 2.5

    const total_active =
      activeRange.count *
      activeCalculated.count *
      activeLastPart.count *
      activeMarketChangeRange *
      activeMarketChangeRatios
    // 10 × 9 × 9 × 10 × 4 = 32,400

    const total_all_indications = total_direction + total_move + total_active // 2,800 + 2,800 + 32,400 = 38,000

    // Strategy Configuration
    const tp_factors = 11 // 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22
    const sl_ratios = Math.floor((2.2 - 0.2) / 0.1) + 1 // 21
    const trailing_options = 4 // None + 3 variations

    const configs_per_direction = total_all_indications * tp_factors * sl_ratios * trailing_options
    // 38,000 × 11 × 21 × 4 = 35,112,000

    const maxPositionsPerConfigSet = 1 // Default
    const positions_per_direction = configs_per_direction * maxPositionsPerConfigSet

    // Both directions (Long AND Short - completely independent)
    const total_both_directions = positions_per_direction * 2 // 70,224,000

    const detailed_breakdown = `
═══════════════════════════════════════════════════════════════════
  MAIN TRADE ENGINE - COMPLETE POSITION CALCULATION (UPDATED)
═══════════════════════════════════════════════════════════════════

📊 INDICATION TYPES BREAKDOWN:

┌─ DIRECTION INDICATIONS ─────────────────────────────────────────┐
│ BASE PARAMETERS:                                                 │
│ • Range: 2 to 30 (step 1) = 28 variations                       │
│ • Drawdown Ratio: 0.1 to 0.5 (step 0.1) = 5 variations          │
│   Values: 0.1 (10%), 0.2 (20%), 0.3 (30%), 0.4 (40%), 0.5 (50%) │
│                                                                  │
│ ADDITIONAL MARKET CHANGE CALCULATION (Per Second):              │
│ • Market Change Range: 1-10 (STEP 2) = 5 variations             │
│   Values: 1, 3, 5, 7, 9                                          │
│   Maps to position cost ratios: 0.1, 0.411, 0.722, 1.033, 1.344 │
│   Formula: ratio = 0.1 + (range - 1) × 0.1556                   │
│ • Last Part Base: 20% (0.2 ratio)                               │
│ • Last Part Ratios: 1.0-2.5 (step 0.5) = 4 variations          │
│   Values: 1.0, 1.5, 2.0, 2.5                                     │
│ • Minimum Calculation Time: 3 seconds (default)                 │
│                                                                  │
│ Total Direction: 28 × 5 × 5 × 4 = 2,800 configurations          │
└──────────────────────────────────────────────────────────────────┘

┌─ MOVE INDICATIONS ──────────────────────────────────────────────┐
│ BASE PARAMETERS:                                                 │
│ • Range: 2 to 30 (step 1) = 28 variations                       │
│ • Drawdown Ratio: 0.1 to 0.5 (step 0.1) = 5 variations          │
│   Values: 0.1 (10%), 0.2 (20%), 0.3 (30%), 0.4 (40%), 0.5 (50%) │
│                                                                  │
│ ADDITIONAL MARKET CHANGE CALCULATION (Per Second):              │
│ • Market Change Range: 1-10 (STEP 2) = 5 variations             │
│   Values: 1, 3, 5, 7, 9                                          │
│   Maps to position cost ratios: 0.1, 0.411, 0.722, 1.033, 1.344 │
│   Formula: ratio = 0.1 + (range - 1) × 0.1556                   │
│ • Last Part Base: 20% (0.2 ratio)                               │
│ • Last Part Ratios: 1.0-2.5 (step 0.5) = 4 variations          │
│   Values: 1.0, 1.5, 2.0, 2.5                                     │
│ • Minimum Calculation Time: 3 seconds (default)                 │
│                                                                  │
│ Total Move: 28 × 5 × 5 × 4 = 2,800 configurations               │
└──────────────────────────────────────────────────────────────────┘

┌─ ACTIVE INDICATIONS ────────────────────────────────────────────┐
│ BASE PARAMETERS:                                                 │
│ • Active Range: 1 to 10 (step 1) = 10 variations               │
│   - Range 1 = 0.1 ratio from position cost                      │
│   - Range 10 = 1.5 ratio from position cost                     │
│   - Formula: ratio = 0.1 + (range - 1) × 0.1556                 │
│ • Activity Calculated: 10% to 90% (step 10%) = 9 variations    │
│ • Activity Last Part: 10% to 90% (step 10%) = 9 variations     │
│                                                                  │
│ ADDITIONAL MARKET CHANGE CALCULATION (Per Second):              │
│ • Market Change Range: 1-10 (STEP 1) = 10 variations            │
│   Values: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10                          │
│   Maps to position cost ratios: 0.1 to 1.5                      │
│ • Last Part Base: 20% (0.2 ratio)                               │
│ • Last Part Ratios: 1.0-2.5 (step 0.5) = 4 variations          │
│   Values: 1.0, 1.5, 2.0, 2.5                                     │
│ • Minimum Calculation Time: 3 seconds (default)                 │
│                                                                  │
│ Total Active: 10 × 9 × 9 × 10 × 4 = 32,400 configurations       │
└──────────────────────────────────────────────────────────────────┘

📈 TOTAL INDICATION VARIATIONS: 2,800 + 2,800 + 32,400 = 38,000

═══════════════════════════════════════════════════════════════════

⚙️  STRATEGY CONFIGURATION:

• TP Factors: 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22 = 11 options
• SL Ratios: 0.2 to 2.2 (step 0.1) = 21 options
• Trailing Options: 4 (None + 3 variations)

═══════════════════════════════════════════════════════════════════

🎯 POSITION CALCULATIONS (Per Symbol):

┌─ PER DIRECTION (Long OR Short) ─────────────────────────────────┐
│                                                                  │
│ Configurations = Indications × TP × SL × Trailing               │
│                = 38,000 × 11 × 21 × 4                            │
│                = 35,112,000 unique configurations                │
│                                                                  │
│ With maxPositionsPerConfigSet = 1:                               │
│ Positions = 35,112,000 × 1 = 35,112,000 positions               │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

┌─ BOTH DIRECTIONS (Long AND Short - INDEPENDENT) ────────────────┐
│                                                                  │
│ Total Positions = 35,112,000 × 2 directions                     │
│                 = 70,224,000 positions per symbol                │
│                                                                  │
│ ✓ Long and Short are COMPLETELY INDEPENDENT                     │
│ ✓ Each direction has separate position limits                   │
│ ✓ Each configuration can run Long + Short simultaneously        │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘

═══════════════════════════════════════════════════════════════════

📊 SCALING WITH maxPositionsPerConfigSet:

• maxPositionsPerConfigSet = 1:  70,224,000 positions/symbol
• maxPositionsPerConfigSet = 5:  351,120,000 positions/symbol
• maxPositionsPerConfigSet = 10: 702,240,000 positions/symbol

═══════════════════════════════════════════════════════════════════

📋 DRAWDOWN RATIO - DETAILED EXPLANATION:

What is Drawdown Ratio?
• Percentage of position drawdown tolerated in effective direction
• Filters positions based on recent performance decline
• Values: 0.1 (10%), 0.2 (20%), 0.3 (30%), 0.4 (40%), 0.5 (50%)

How it works:
1. Calculate maximum peak value for position in effective direction
2. Measure current decline from that peak
3. If decline > drawdown_ratio threshold → position filtered out
4. Only positions within tolerance are used for validation

Example with Drawdown Ratio 0.3 (30%):
• Position peak profit: $1,000
• Current profit: $750
• Drawdown: ($1,000 - $750) / $1,000 = 25%
• Result: 25% < 30% → Position KEPT for validation ✓

• Position peak profit: $1,000
• Current profit: $600
• Drawdown: ($1,000 - $600) / $1,000 = 40%
• Result: 40% > 30% → Position FILTERED OUT ✗

Benefits:
• Lower values (0.1-0.2): Strict filtering, only stable positions
• Higher values (0.4-0.5): Lenient filtering, includes volatile positions
• Creates 5 different risk tolerance profiles per indication

═══════════════════════════════════════════════════════════════════

📋 HOW MARKET CHANGE CALCULATIONS WORK:

Direction & Move Indications:
• KEEP existing detection logic (range-based)
• ADD market change calculations per second (price activity)
• Market Change Range: 1-10 STEP 2 → Values: 1, 3, 5, 7, 9 (5 variations)
• Calculate in effective direction (direction of movement)
• Last 20% Activity Base (0.2 ratio) with higher changes
• Compare last 20% average to overall average
• Apply ratios 1.0, 1.5, 2.0, 2.5 (last 20% must be ratio × overall)
• Minimum 3 seconds for market averaging before validation

Active Indications:
• KEEP existing Active range logic (1-10 step 1)
• ADD market change calculations per second (price activity)
• Market Change Range: 1-10 STEP 1 → Values: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (10 variations)
• Calculate in effective direction (direction of movement)
• Last 20% Activity Base (0.2 ratio) with higher changes
• Compare last 20% average to overall average
• Apply ratios 1.0, 1.5, 2.0, 2.5 (last 20% must be ratio × overall)
• Minimum 3 seconds for market averaging before validation

Position Cost Ratio Mapping:
• Range value → Position cost ratio
• Formula: ratio = 0.1 + (range - 1) × 0.1556
• Range 1 = 0.1 ratio (10% of position cost)
• Range 2 = 0.256 ratio (25.6% of position cost)
• Range 3 = 0.411 ratio (41.1% of position cost)
• Range 4 = 0.567 ratio (56.7% of position cost)
• Range 5 = 0.722 ratio (72.2% of position cost)
• Range 6 = 0.878 ratio (87.8% of position cost)
• Range 7 = 1.033 ratio (103.3% of position cost)
• Range 8 = 1.189 ratio (118.9% of position cost)
• Range 9 = 1.344 ratio (134.4% of position cost)
• Range 10 = 1.5 ratio (150% of position cost)

Last Part Acceleration Logic:
1. Collect price changes per second for minimum 3 seconds
2. Calculate overall average: sum(all_changes) / total_samples
3. Calculate last 20% average: sum(last_20%_changes) / last_20%_samples
4. Validate: last_20%_average >= overall_average × ratio_factor

Example with ratio 1.5:
- Overall average: 0.5% per second
- Last 20% average: 0.8% per second
- Required: 0.5% × 1.5 = 0.75%
- Result: 0.8% >= 0.75% → VALIDATED (market accelerating) ✓

═══════════════════════════════════════════════════════════════════
`

    return {
      direction: [directionRange, directionDrawdown],
      move: [moveRange, moveDrawdown],
      active: [activeRange, activeCalculated, activeLastPart],
      total_direction,
      total_move,
      total_active,
      total_all_indications,
      tp_factors,
      sl_ratios,
      trailing_options,
      configs_per_direction,
      positions_per_direction,
      total_both_directions,
      detailed_breakdown,
    }
  }

  /**
   * Synchronous version — the formula is pure arithmetic, no I/O.
   * The async wrapper is kept for backward-compat but delegates here.
   */
  calculatePositionCostRatioSync(rangeValue: number): number {
    return 0.1 + (rangeValue - 1) * 0.1556
  }

  async calculatePositionCostRatio(rangeValue: number): Promise<number> {
    return this.calculatePositionCostRatioSync(rangeValue)
  }

  /**
   * Synchronous validation — pure arithmetic, no I/O.
   */
  validateMarketChangeSync(priceChanges: number[], ratioFactor: number): boolean {
    if (priceChanges.length < 3) return false
    const total = priceChanges.length
    if (total <= 0) return false // Guard against empty array (already checked above, but belt-and-suspenders)
    
    const sum = priceChanges.reduce((s, c) => s + c, 0)
    // Guard against NaN from summing invalid prices
    if (!Number.isFinite(sum)) return false
    
    const overallAvg = sum / total
    if (!Number.isFinite(overallAvg)) return false // Handle NaN/Infinity
    
    const last20Count = Math.max(1, Math.floor(total * 0.2))
    const last20Sum = priceChanges.slice(-last20Count).reduce((s, c) => s + c, 0)
    if (!Number.isFinite(last20Sum)) return false
    
    // Guard against division: last20Count is always >= 1 from Math.max, but be explicit
    const last20Avg = last20Count > 0 ? last20Sum / last20Count : 0
    if (!Number.isFinite(last20Avg)) return false
    
    // Guard ratioFactor and final comparison against NaN
    const expectedThreshold = Number.isFinite(ratioFactor) && ratioFactor > 0 ? overallAvg * ratioFactor : 0
    return Number.isFinite(expectedThreshold) && Number.isFinite(last20Avg) && last20Avg >= expectedThreshold
  }

  async validateMarketChange(priceChanges: number[], ratioFactor: number): Promise<boolean> {
    return this.validateMarketChangeSync(priceChanges, ratioFactor)
  }

  /**
   * Pure-sync batch — all calculations are arithmetic, Promise.all
   * over async wrappers was adding unnecessary microtask overhead.
   */
  async calculateBatch(ranges: number[]): Promise<Map<number, number>> {
    const results = new Map<number, number>()
    for (const range of ranges) {
      results.set(range, this.calculatePositionCostRatioSync(range))
    }
    return results
  }

  async validateMarketChangeBatch(
    validations: Array<{ priceChanges: number[]; ratioFactor: number; id: string }>,
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>()
    for (const v of validations) {
      results.set(v.id, this.validateMarketChangeSync(v.priceChanges, v.ratioFactor))
    }
    return results
  }

  async validateMarketActivity(
    priceData: number[],
    settings: MarketActivitySettings
  ): Promise<{ isActive: boolean; details: string }> {
    // ── Validation always runs unless explicitly disabled ──────────────────
    // The previous code returned early with `isActive: true` when
    // `settings.enabled = false`, which bypassed validation entirely.
    // This is incorrect semantics — "disabled" should mean the check is
    // not enforced (always returns true), not that we skip validation. The
    // new logic only skips when explicitly disabled; otherwise always
    // validates market conditions (volatility, price change).
    if (!settings.enabled) {
      return { isActive: true, details: "Market activity check disabled" }
    }

    if (!priceData || priceData.length === 0) {
      return { isActive: false, details: "No price data available" }
    }

    const calculationRange = settings.calculationRange // 5-20 seconds
    const calculationFrame = settings.calculationFrame // 1 second
    const positionCostRatio = 0.05 * settings.positionCostRatioIndex // 0.05-1.00

    // Calculate frames
    const frames = Math.floor(priceData.length / calculationFrame)
    if (frames < calculationRange) {
      return { isActive: false, details: "Insufficient data for calculation range" }
    }

    // Calculate average price change per frame
    const frameChanges: number[] = []
    for (let i = 0; i < frames; i++) {
      const frameStart = i * calculationFrame
      const frameEnd = (i + 1) * calculationFrame
      const frameData = priceData.slice(frameStart, frameEnd)
      if (frameData.length < 2) continue
      const frameChange = Math.abs(frameData[frameData.length - 1] - frameData[0]) / frameData[0]
      frameChanges.push(frameChange)
    }

    if (frameChanges.length === 0) {
      return { isActive: false, details: "No frame changes to evaluate" }
    }

    // Get last calculationRange frames
    const relevantFrames = frameChanges.slice(-calculationRange)
    const avgChange = relevantFrames.reduce((sum, change) => sum + change, 0) / relevantFrames.length

    // Check if average change meets position cost ratio
    if (avgChange < positionCostRatio) {
      return {
        isActive: false,
        details: `Average change ${(avgChange * 100).toFixed(2)}% < required ${(positionCostRatio * 100).toFixed(2)}%`,
      }
    }

    // Calculate volatility
    const mean = relevantFrames.reduce((sum, val) => sum + val, 0) / relevantFrames.length
    const variance = relevantFrames.reduce(
      (sum, val) => sum + Math.pow(val - mean, 2),
      0
    ) / relevantFrames.length
    const volatility = Math.sqrt(variance)

    if (volatility < settings.minVolatility) {
      return {
        isActive: false,
        details: `Volatility ${(volatility * 100).toFixed(2)}% < required ${(settings.minVolatility * 100).toFixed(2)}%`,
      }
    }

    return {
      isActive: true,
      details: `Market active: avg change ${(avgChange * 100).toFixed(2)}%, volatility ${(volatility * 100).toFixed(2)}%`,
    }
  }
}
