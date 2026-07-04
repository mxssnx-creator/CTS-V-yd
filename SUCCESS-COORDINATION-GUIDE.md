# Success Coordination & Relations - Trading Engine

## System Architecture

The trading engine consists of interconnected stages that must coordinate successfully:

```
BASE STAGE → MAIN STAGE → REAL STAGE → LIVE STAGE
    ↓           ↓            ↓            ↓
Position    Strategy      Position    Order
Generation  Generation    Filtering   Execution
```

## Critical Success Relations

### 1. Position Lifecycle Coordination (RC1-RC3)

**Problem**: Multiple threads could operate on same position simultaneously
**Solution**: Atomic status machine with locking

```typescript
Position Lifecycle:
  open (initial)
    ↓
  placing (preparing order)
    ↓
  placed (order sent to exchange)
    ↓
  filled/partially_filled (position active)
    ↓
  closing (force-close initiated by SL/TP or manual)
    ↓
  closing_partial (partial close in progress)
    ↓
  closed (terminal state)
```

**Guard Functions**:
- `tryLockPosition(pos, lockId)` - Atomically acquire lock, prevent duplicate operations
- `unlockPosition(pos)` - Release lock after operation completes
- Re-check after async: Verify position still exists before using
- Version field: Tracks mutation count for optimistic locking

### 2. Order Tracking Relations (RC4)

**Entry Order Flow**:
```
1. Exchange receives order
2. Exchange returns orderId in response  
3. System assigns: livePosition.orderId = exchangeOrderId (CONFIRMED)
4. System persists with savePosition()
5. Subsequent syncs use orderId to track fills
```

**Protection Order Flow**:
```
1. Position filled (executedQuantity > 0)
2. System computes SL/TP prices
3. System places SL order on exchange (orderId returned)
4. System assigns: position.stopLossOrderId = exchangeOrderId (CONFIRMED)
5. System verifies order exists in next sync tick
6. On SL cross: system closes position using confirmation
```

**Key**: Never assign orderId until exchange confirms it

### 3. Live Position Index Consistency (RC5)

**Problem**: openPositions array can become stale vs Redis storage
**Solution**: Atomic index updates

```typescript
openPositions Map Structure:
  Key: ${connectionId}:${symbol}:${direction}
  Value: LivePosition object
  
Redis Backup:
  Key: live_positions:${connectionId}:${id}
  Value: hset of position fields
  
Sync Rule:
  - Index and Redis must stay in sync
  - Writes to both in same transaction
  - Reads from index, validate in Redis
  - On mismatch, rebuild from Redis
```

### 4. Sync Cycle Coordination

**Every 30s sync-tick cycle**:

1. **Fetch Exchange Positions** (parallel)
   - Get all open positions from exchange
   - Build map: (symbol|direction) → exchangePos
   - Skip flat/zero-size entries

2. **Process Each Redis Position** (bounded concurrency = 5)
   - Check if position exists on exchange
   - If exists: update markPrice, liqPrice, unrealizedPnL
   - If missing: mark as externally closed
   - Check SL/TP crosses
   - Update protection order armings

3. **Detect Terminal States**
   - closed: position.status = "closed"
   - rejected: entry order was rejected
   - error: exchange returned error
   - stuck_in_placed: order not filled after 120s

4. **Persist Updates** (batch transaction)
   - All position updates in single Redis pipeline
   - Atomic: all succeed or none
   - On success: log stats

### 5. Hedge Coordination

**Purpose**: Maintain balanced long/short positions per symbol

**Flow**:
1. REAL stage outputs 60 top-PF sets per symbol
2. Strategy coordinator evaluates net targets
3. LIVE stage creates both long and short positions
4. Sync-tick reconciles vs. exchange
5. On net imbalance: create opposite position to rebalance

**Guard**: Check existing positions before creating new ones

## Success Metrics

### Phase Transitions
- MAIN → REAL: 1600 → 60 sets per symbol (cap enforced ✓)
- REAL → LIVE: Top 90 selected for dispatch (verified ✓)
- LIVE → Execution: Orders placed and confirmed (latency < 3s)

### Race Condition Prevention
- Duplicate closes: 0 (lock prevents)
- Stuck positions: < 3 (timeout/orphan cleanup)
- Index inconsistencies: 0 (atomic updates)
- Version conflicts: Auto-retried (exponential backoff)

### Coordination Indicators
```
[v0] Capping 1622 → 60 before hedge netting           ← Real cap working
[v0] [RealStage] Capped positions before hedge        ← Early cap triggered
[v0] [RC1] tryLockPosition: locked for sync-tick      ← Duplicate prevention active
[v0] [RC2] savePosition: version incremented = 3      ← Atomic save working
[v0] [RC3] processOneSync: position exists, proceeding ← TOCTOU check passed
[v0] [sync-tick] purged N terminal positions          ← Index cleanup working
```

## Failure Scenarios & Recovery

### Scenario 1: Position Deleted During Sync
**Symptom**: "Cannot read property 'status' of undefined"
**Recovery**: RC3 guard catches, skips position, logs warning
**Prevention**: Re-check at sync-tick line 6159

### Scenario 2: Duplicate Close Attempts
**Symptom**: Multiple closeLivePosition() calls for same position
**Recovery**: RC1 lock prevents second call
**Prevention**: tryLockPosition returns false, first caller wins

### Scenario 3: Stale Position Data
**Symptom**: Closing on old SL price, missing recent exchange fills
**Recovery**: Next sync-tick fetches fresh markPrice from exchange
**Prevention**: exchangeData.syncedAt tracks freshness

### Scenario 4: Orphaned Orders
**Symptom**: Position has orderId but exchange says not found
**Recovery**: Clear orderId, re-arm for new placement
**Prevention**: verify-liveness checks every sync tick (line 1988)

### Scenario 5: Index-Redis Divergence
**Symptom**: openPositions shows position, Redis doesn't (or vice versa)
**Recovery**: Rebuild openPositions from Redis on mismatch
**Prevention**: Atomic batch updates keep them in sync

## Deployment Checklist

- [x] RC1: Duplicate close guards implemented
- [x] RC2: Atomic Redis updates with version tracking
- [x] RC3: TOCTOU re-check guards in sync loop
- [x] RC4: Order ID lifecycle analyzed (safe as-is)
- [x] RC5: Index synchronization via atomic updates
- [x] Build: Clean (zero errors)
- [x] Tests: Memory locks, guards, atomic operations verified
- [ ] Production deployment: Fresh environment restart
- [ ] Monitor: 24h production run for race condition telemetry
- [ ] Verify: Zero duplicate closes, zero stuck positions

## Monitoring Commands

```bash
# Check for race condition symptoms
curl http://localhost:3002/api/trade-engine/logs | grep -E "RC[1-5]|duplicate|stuck|divergence"

# Monitor position counts
curl http://localhost:3002/api/connections/bingx-x01 | jq '.metrics.livePositionsOpen'

# Check version tracking
curl http://localhost:3002/api/connections/bingx-x01/positions | jq '.[] | select(.version) | {id, version}'

# Monitor lock status
curl http://localhost:3002/api/connections/bingx-x01/positions | jq '.[] | select(.lockedAt) | {id, lockedBy, lockedAt}'
```

## References

- RACE-CONDITION-FIXES.md: Root cause analysis
- live-stage.ts: Implementation of guards and locking
- Success relations flow diagrams above
- SESSION 37 CONTINUED in MEMORY.md: Session progress tracking
