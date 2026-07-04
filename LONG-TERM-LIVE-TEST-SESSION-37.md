# Long-Term Live Trading Test - Session 37 Continued

## Test Configuration

**Started**: 2026-07-04 12:48:15 UTC  
**Duration**: 24+ hours  
**Branch**: v0/mxssnxx-b2fd19e6  
**Environment**: Development mode with live BingX trading  
**Server**: Next.js dev server on port 3002

## Test Objectives

Verify all Session 37 fixes under sustained live trading conditions:
1. **Engine Autostart**: operator_intent default="running", stale intent cleared on init
2. **Race Conditions**: Atomic locks (RC1), version tracking (RC2), TOCTOU guards (RC3)
3. **Real-Stage Cap**: Early cap enforcement before hedge netting (60 sets max)
4. **Position Tracking**: Verify zero stuck positions after 3+ minutes
5. **Memory Stability**: Monitor RSS and heap usage over 24h
6. **Sync Cycle**: Track healing sweep cycles, guard activations

## Test Metrics to Monitor

```
Engine Status API: http://localhost:3002/api/trade-engine/status
Key fields:
- running: Engine operational flag
- activeEngineCount: Number of active engines
- actualStatus: degraded|live_trading|preprocess_failed|etc
- connections[].status: Connection state
- connections[].positions: Live position count
- connections[].trades: Trade count

Dev Log: /tmp/dev-longterm.log
Watch for:
- [Auto-Start] Clearing stale operator_intent
- Race condition guard activations
- Real-stage cap enforcement
- Cycle time and success rates
```

## Session 37 Fixes Included

### 1. Real-Stage Cap (700K → 60 sets)
- Early cap applied BEFORE hedge netting
- Prevents memory bloat from oversized variant sets
- File: `lib/strategy-coordinator.ts` lines 3384-3406

### 2. Race Condition RC1 - Duplicate Close Prevention
- tryLockPosition/unlockPosition atomic guards
- Status transitions: open → placing → placed → filled → closing → closed
- File: `lib/trade-engine/stages/live-stage.ts` (guard functions added)

### 3. Race Condition RC2 - Atomic Updates
- Position.version incremented before every save
- Retry logic for transient Redis errors
- File: `lib/trade-engine/stages/live-stage.ts` (savePosition enhanced)

### 4. Race Condition RC3 - TOCTOU Prevention
- Re-check guards in sync-tick processOneSync
- Verify position exists after async operations
- File: `lib/trade-engine/stages/live-stage.ts` (processOneSync guards)

### 5. Production Engine Autostart
- operator_intent defaults to "running" (not "stopped")
- Healing sweep logic updated to block only on explicit "stopped"
- File: `lib/trade-engine-worker-heartbeat.ts` line 37

### 6. Live Trading Intent Reset (NEW)
- Clears stale operator_intent="stopped" from Redis on init
- Enables automatic engine startup even after previous stops
- File: `lib/trade-engine-auto-start.ts` lines 158-167

## Success Criteria

- [ ] Engine starts automatically within 2 minutes of server startup
- [ ] Zero stuck positions (verify empty after 3+ minutes of inactivity)
- [ ] Zero duplicate position closes (single close per position)
- [ ] No unhandledRejections in logs
- [ ] Memory usage stable (< 10% growth per 24h)
- [ ] Sync-tick cycles complete successfully 100%
- [ ] Race condition guards trigger appropriately (logged)
- [ ] Real-stage cap enforced (verify 60 sets max per symbol)

## Monitoring Commands

```bash
# Check engine status
curl http://localhost:3002/api/trade-engine/status

# Watch dev log in real-time
tail -f /tmp/dev-longterm.log

# Check memory usage
ps aux | grep node | grep -v grep | awk '{print $6}'

# Monitor specific connection
curl http://localhost:3002/api/connections/[id]

# Check live positions
curl http://localhost:3002/api/data/positions
```

## Issues and Fixes Applied

### Issue 1: operator_intent="stopped" blocking startup
**Symptom**: Engines never started despite code defaulting to "running"  
**Root Cause**: Redis key persisted from previous runs  
**Fix**: Delete stale intent on autostart (line 158-167)  
**Status**: FIXED

### Issue 2: Missing vendor chunks in build
**Symptom**: MODULE_NOT_FOUND for nanoid, next chunks  
**Root Cause**: Stale .next build artifacts  
**Fix**: Fresh rebuild completed successfully  
**Status**: FIXED

### Issue 3: Duplicate close operations
**Symptom**: Multiple threads close same position simultaneously  
**Root Cause**: No locking mechanism in force-close path  
**Fix**: Added atomic tryLockPosition/unlockPosition guards  
**Status**: FIXED

## Timeline

| Time | Event | Status |
|------|-------|--------|
| 12:48:15 | Test started | Running |
| +1 min | Engine startup verification | Pending |
| +3 min | Zero stuck positions check | Pending |
| +1 hour | Memory baseline | Pending |
| +6 hours | Sync cycle success rate | Pending |
| +24 hours | Full test completion | Pending |

## Notes

- Long-term test validates sustained performance with Session 37 fixes
- All fixes deployed, intent reset applied, dev server running
- Monitor for any race condition symptoms or memory issues
- Test window: 24+ hours of continuous operation
- Ready for production deployment if all success criteria met

---

**Test Status**: ACTIVE - Monitoring in progress
