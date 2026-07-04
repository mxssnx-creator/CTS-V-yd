# Race Condition Fixes - Session 37 Continued

## Critical Race Conditions Found

### RC1: Duplicate Close Race Condition
**Location**: live-stage.ts, checkAndForceCloseOnSltpCross
**Problem**: Multiple concurrent sync-tick cycles detect the same SL/TP cross and all call closeLivePosition()
**Impact**: Duplicate close attempts, API spam, memory bloat from redundant operations
**Severity**: CRITICAL - causes order duplication and failed reconciliation

**Current Code**:
```typescript
if (pos.status === "closed" || pos.status === "rejected" || pos.status === "error") return null
if (pos.closeReason || pos.closedAt) return null  // Already being closed elsewhere
```

**Fix**: Add position.status check BEFORE any operations in sync loops
- Guard every position operation with atomic status check
- Use compareAndSet pattern for status transitions
- Mark position as "closing" before async operations

---

### RC2: Non-Atomic Redis Updates
**Location**: savePosition(), batchSavePositions(), redis-db.ts line 3297
**Problem**: Position updates use hset() without pipeline transactions
**Impact**: Partial updates if process crashes mid-save; inconsistent state
**Severity**: HIGH - data corruption risk

**Current Code**:
```typescript
await client.hset(`position:${id}`, data)
```

**Fix**: Use Redis pipelines for atomic multi-field updates
- All position status + fields in single pipeline
- Or use WATCH/MULTI/EXEC for consistency

---

### RC3: TOCTOU (Time-of-Check-Time-of-Use) in Sync Loop
**Location**: live-stage.ts lines 6063-6250
**Problem**: Check position exists, then operate on it; another thread deletes in between
**Impact**: Null pointer exceptions, failed position sync
**Severity**: MEDIUM - causes error spam and stuck positions

**Current Code**:
```typescript
const position = openPositions[i]  // Check
// ... async operation ...
position.status = "filled"  // Use - position might be deleted by another thread
```

**Fix**: Re-check position exists after async operations
- Validate position still exists after each await
- Use position ID as immutable key

---

### RC4: Order ID Race During Placement
**Location**: live-stage.ts, setLeverage/placeOrder sections
**Problem**: orderId assigned locally before confirmed by exchange
**Impact**: Phantom orders, mixed up IDs between positions
**Severity**: HIGH - position tracking corruption

**Current Code**:
```typescript
order.id = generatedId  // Local assignment
// ... async exchange call ...
// If crash here: order.id is orphaned, exchange doesn't know it
```

**Fix**: Only assign orderId AFTER exchange confirms it
- Use placedOrderId field for pending orders
- Only promote to orderId after confirmed fill

---

### RC5: Position Index Inconsistency
**Location**: live-stage.ts, sync-tick line 5658
**Problem**: openPositions index and Redis data structure can diverge
**Impact**: Stuck positions, sync failures, duplicate operations
**Severity**: HIGH - breaks position tracking entirely

**Fix**: Atomic sync between memory index and Redis
- Single Redis transaction for index updates
- Version field to detect concurrent modifications

---

## Implementation Plan

### Phase 1: Add Atomic Status Guards
1. Define state machine: open → (filled | placing | placed) → (closing | closing_partial) → closed
2. Add locked field: position.locked = true during operations
3. Guard all operations with locked check
4. Use optimistic locking: version field incremented on mutations

### Phase 2: Atomic Redis Operations
1. Convert savePosition() to use pipelines
2. Wrap multi-field updates in WATCH/MULTI/EXEC
3. Implement retry on concurrent modification (version mismatch)

### Phase 3: Re-Check After Async Operations
1. After every await, validate position still exists
2. Re-fetch position if critical operation
3. Abort if status changed unexpectedly

### Phase 4: Order ID Lifecycle
1. Rename: orderId → confirmedOrderId
2. Use pendingOrderId for pre-confirmation
3. Promote only after exchange confirmation
4. Add ordering: pendingOrderId → confirmedOrderId → terminal

### Phase 5: Index Synchronization
1. Add version field to position
2. Atomic index + Redis writes together
3. Detect index corruption and rebuild on mismatch

---

## Files to Modify

1. **lib/positions/position-tracker.ts** - Add version & locked fields
2. **lib/trade-engine/stages/live-stage.ts** - Add guards & re-checks
3. **lib/redis-db.ts** - Implement atomic updates with pipelines
4. **lib/redis-operations.ts** - Add version checking on updates
5. **lib/data-sync-manager.ts** - Atomic index synchronization

---

## Success Criteria

- No duplicate order IDs in API logs
- No "stuck_in_placed" positions after 3 minutes
- All SL/TP crosses result in exactly 1 close operation
- Position index always matches Redis state
- Zero TOCTOU exceptions in production logs
