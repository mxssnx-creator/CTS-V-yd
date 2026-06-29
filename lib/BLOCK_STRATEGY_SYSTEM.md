# Block Strategy System - Complete Architecture

## Overview
Block and DCA strategies are classified as "Adjust" type strategies that work independently over and alongside "Standard" position-count strategies.

## Strategy Types

### Standard Strategies
- **Types:** Default, Trailing, Pause, and Axis-based position-count strategies
- **Qty Calculation:** baseQty × continuousCount
- **Position Scaling:** Applied in Live stage based on current open positions
- **Independence:** Not affected by Block/DCA adjustments
- **Coordination:** Axis-based with prev/last/cont windows

### Adjust Strategies (Block & DCA)
- **Block:**
  - Gate: continuousCount < blockMaxStack
  - Volume Scaling: m(n) = 1 + (n-1) × blockVolumeRatio
  - Base Multiplier: 1.5 or 2.0
  - Effect: Add-on sizes increase with position count AND volume ratio
  - Independence: Works without requiring an existing open position (if continuousCount=0)

- **DCA (Dollar Cost Averaging):**
  - Gate: prevLosses >= 1
  - Size Multiplier: 0.5 (reduced from config)
  - Effect: Average down on losing trades
  - Independence: Activates independently on loss triggers

## Data Flow Architecture

```
PHASE 1: BASE CREATION
  createBaseSets() → StrategySet {
    strategyType: "standard",
    (no baseMultiplier)
  }

PHASE 2: MAIN/VARIANT COORDINATION
  selectActiveVariants() → Apply Block scaling m(n) = 1 + (n-1) × ratio
  
  buildVariantSet() → StrategySet {
    strategyType: "adjust" (for block/dca) | "standard" (for others)
    baseMultiplier: scaled_size (for adjust only)
  }
  
  expandAxisSets() → StrategySet {
    strategyType: "standard",
    axisWindows: { prev, last, cont, pause }
  }

PHASE 3: REAL STAGE EVALUATION
  createRealPosition(strategySet) → RealPosition {
    sizeMultiplier: 
      - If strategyType="adjust": baseMultiplier (volume-ratio scaled)
      - If strategyType="standard": 1.0 (continuousCount applied later)
  }

PHASE 4: LIVE STAGE EXECUTION
  VolumeCalculator.calculateVolumeForConnection(sizeMultiplier) →
    qty = baseQty × sizeMultiplier
    
  For Adjust strategies: qty directly reflects Block/DCA scaling
  For Standard strategies: qty reflects baseQty only (continuousCount scaling in next phase)
```

## Volume Ratio Scaling (Block Strategy)

**Formula:** m(n) = 1 + (n - 1) × volumeRatio

Where:
- n = number of existing open positions (continuousCount)
- volumeRatio = operator slider (default 0.5, range 0.25-3.0)

**Examples:**
- n=1 (first position): m = 1.0 (no add-on scaling)
- n=2 (second position): m = 1 + 0.5 = 1.5
- n=3 (third position): m = 1 + 2×0.5 = 2.0
- n=4 (fourth position): m = 1 + 3×0.5 = 2.5
- At max stack (blockMaxStack=10): stacks continue per formula

## Field Propagation

### StrategySet Interface (strategy-coordinator.ts:52)
```typescript
strategyType?: "standard" | "adjust"
baseMultiplier?: number
```

### RealPosition Interface (real-stage.ts:13)
```typescript
sizeMultiplier?: number  // Applied directly in Live stage
setVariant: "default" | "trailing" | "block" | "dca"
```

### LivePosition (live-stage.ts)
- Inherits sizeMultiplier from RealPosition
- Used in VolumeCalculator for final qty calculation

## Independence & Coordination

### Block Strategy Independence
- Works without existing open positions (when continuousCount=0)
- Can initialize new entries independently
- When ≥1 open position, becomes an add-on with scaling
- NOT mixed with position-count axis logic (cont dimension = 0 for Block)

### DCA Strategy Independence
- Triggers only on loss conditions (prevLosses >= 1)
- Fixed 0.5 multiplier regardless of position count
- Acts as recovery strategy, not tied to position axis
- Purely event-driven (loss condition based)

### Standard Strategy Operation
- Always position-count coordinated
- Qty = baseQty × continuousCount (in Live stage)
- Can accumulate alongside Block/DCA
- respects axis windows (prev, last, cont, pause)

### System-Level Integration
- Block/DCA and Standard strategies can operate simultaneously
- Each applies scaling independently
- Live executor receives sizeMultiplier already reflecting strategy type
- No conflicts or double-scaling

## Validation Guards

### In buildVariantSet (line ~5090)
```typescript
const isAdjustVariant = profile.name === "block" || profile.name === "dca"
const strategyType: "standard" | "adjust" = isAdjustVariant ? "adjust" : "standard"
const baseMultiplier = isAdjustVariant && profile.configs.length > 0
  ? profile.configs[0]!.size  // Already scaled by selectActiveVariants
  : undefined
```

### In createRealPosition (line ~295)
```typescript
const strategyType = variantSource?.strategyType ?? "standard"
const sizeMultiplier = 
  strategyType === "adjust" && variantSource?.baseMultiplier
    ? variantSource.baseMultiplier
    : 1.0
```

## Logging & Diagnostics

Add comprehensive logging at each stage:

```typescript
// Main stage (selectActiveVariants)
console.log(`[v0] Block strategy scaling: n=${continuousCount} ratio=${blockVolumeRatio} m(n)=${blockMul}`)

// Real stage (createRealPosition)
console.log(`[v0] RealPosition sizeMultiplier: type=${strategyType} mult=${sizeMultiplier}`)

// Live stage (placeOrder)
console.log(`[v0] LivePosition qty: base=${baseQty} mult=${sizeMultiplier} final=${finalQty}`)
```

## Testing Checklist

- [ ] Block strategy scaling formula verified (m(n) = 1 + (n-1) × ratio)
- [ ] Block qty correctly scales with continuousCount
- [ ] Block qty respects blockMaxStack cap
- [ ] DCA qty fixed at 0.5 multiplier
- [ ] Standard strategies unaffected by Block/DCA
- [ ] Volume ratio slider affects Block only, not Standard
- [ ] Adjust strategies marked as independent in database
- [ ] Zero cross-strategy interference
- [ ] Live stage receives correct sizeMultiplier per strategy type
- [ ] P&L correctly attributed to Block/DCA vs Standard

## Known Characteristics

- Block gate clamped at blockMaxStack operator setting (default 8)
- DCA only activates on prevLosses >= 1 (not random, loss-driven)
- Axis sets never have baseMultiplier (they are always Standard)
- sizeMultiplier defaults to 1.0 when strategyType missing (backward compatible)
- Volume ratio scaling applied once in Main stage (selectActiveVariants), not re-applied

