# Development Guide — CTS-V-yd (HEAD=86ce8d7)

## Quick Start

### Dev Environment
```bash
# Install dependencies
pnpm install

# Run dev server
pnpm dev

# Verify
curl http://localhost:3002/api/trade-engine/status
```

### Running Tests
```bash
# Regression tests (43 tests)
pnpm exec jest --testPathPatterns="requested-regressions"

# Type check
pnpm exec tsc --noEmit --skipLibCheck

# Build
pnpm build
```

## Architecture Overview

### Request → Response Path (Synchronous)

```
User Request
  ↓
app/api/[route]/route.ts (API handler)
  ↓
lib/redis-db.ts (Redis operations)
  ↓
lib/trade-engine.ts (Engine state)
  ↓
Response (JSON)
```

### Background Processing (Asynchronous)

```
instrumentation.ts register() [On every process start]
  ↓
lib/startup-coordinator.ts completeStartup()
  ├─ initRedis() + runMigrations()
  ├─ cleanupVolatileRuntimeState()
  ├─ validateDatabase()
  ├─ getAllConnections()
  ├─ consolidateDatabase()
  ├─ getGlobalTradeEngineCoordinator()
  ├─ cleanupOrphanedProgress()
  └─ reconcileStrandedPositions()
  ↓
[Optional] lib/trade-engine-auto-start.ts
  → Syncs enabled connections once operator starts engine
  ↓
[Optional] lib/server-continuity-runner.ts
  → Runs background continuity checks
```

### Strategy Progression Cycle (Per Symbol, Per Connection)

```
lib/strategy-coordinator.ts executeStrategyFlow()
  ↓
Stage 1: BASE
  └─ Base Sets: 1-2 per symbol (system baseline)
  ↓
Stage 2: MAIN
  └─ Main Sets: 50-500 (variant fan-out: default/trailing/block/dca)
  ↓
Stage 3: REAL
  └─ Real Sets: 5-50 (cost-filtered, profit-factor validated)
  ↓
Stage 4: LIVE
  └─ Live Sets: 0-10 (cost/capacity gated, exchange order sent)
  ↓
Progression Log Recorded
  → API /stats returns: counts, profit factors, success rate
```

## Key Files and Responsibilities

| File | Lines | Purpose |
|------|-------|---------|
| `instrumentation.ts` | 90 | Server boot entry point; runs once per process start |
| `lib/startup-coordinator.ts` | 300 | Deterministic boot: migrations, cleanup, validation |
| `lib/strategy-coordinator.ts` | 6000+ | Core progression pipeline; Base→Main→Real→Live stages |
| `lib/trade-engine/stages/live-stage.ts` | 4000+ | Live order execution; index maintenance; order lifecycle |
| `lib/trade-engine.ts` | 300+ | Main orchestrator; coordinator loop; watchdog |
| `lib/redis-db.ts` | 3000+ | Redis I/O; all data persistence |
| `app/api/connections/progression/[id]/stats/route.ts` | 500+ | Progression statistics; aggregations |
| `lib/redis-migrations.ts` | 4000+ | Schema evolution; boot-time data initialization |
| `next.config.mjs` | 150 | Next.js config; Turbopack setup; experimental features |

## Environment-Specific Behavior

### Development (`NODE_ENV=development`)
- Single long-lived process
- Browser-based initialization possible
- Dev symbol cap: `V0_DEV_SYMBOL_COUNT` (default 1, max ~10)
- Stale state flush on engine init
- Heap: 4GB (Turbopack)

### Production (`NODE_ENV=production`)
- Serverless workers / multiple processes
- **NO persistent browser**; instrumentation hook is only boot path
- Deterministic headless initialization on every process start
- Full migrations run on cold boot
- Orphan cleanup and stranded position reconciliation run on every restart
- Heap: Deployment-specific (Vercel default ~3GB)

## Testing Strategy

### Unit Tests (43 total)
```bash
# Run all
pnpm exec jest __tests__/unit/

# Run specific test file
pnpm exec jest __tests__/unit/requested-regressions.test.ts
```

### Test Categories
- Regression tests: Verify critical architecture patterns
- State isolation tests: Ensure no cross-connection pollution
- Type safety: Full TypeScript compilation checked

### Manual Testing
```bash
# Start dev server
pnpm dev

# In another terminal
# Test connection initialization
curl http://localhost:3002/api/connections

# Test progression stats
curl http://localhost:3002/api/connections/bingx-x01/progression/stats

# Test engine state
curl http://localhost:3002/api/trade-engine/status

# Trigger progression cycle (test)
curl -X POST http://localhost:3002/api/connections/bingx-x01/progression/test-cycle
```

## Performance Tuning

### Coordinator Cycle Time
- Target: 100-500ms per symbol
- Bottleneck: Redis I/O (getOpenLiveSetKeys, settings lookups)
- Optimization: Maintained indexes (live_set_keys, liveSetsByVariant)
- Cache TTLs: 5min for settings, 10s for live sets

### Memory Usage
- Dev (1 symbol): ~1.8GB baseline
- Dev (10 symbols): ~2.5-3.5GB with engine running
- Prod: Varies by multi-symbol load
- Constraint: Max-heap must leave buffer for V8 GC

### Live Order Dispatch
- Batch size: 50-90 per cycle (BingX limit ~200 open orders)
- Fill detection: Polling (15s default) or fast-path (inline fills)
- Order placement: ~50-200ms per order with connectors

## Debugging

### Enable Debug Logging
```typescript
// In relevant file
console.log("[v0] [ComponentName] message:", variable)

// Search logs
grep "\[v0\]" /tmp/nextdev.log
```

### Check Boot Sequence
```bash
# Dev
grep "\[v0\] \[Startup\]" /tmp/nextdev.log

# Prod
# Check Vercel deployment logs
```

### Trace Progression
```bash
# Check current engine state
curl http://localhost:3002/api/trade-engine/status

# Check connection progression
curl http://localhost:3002/api/connections/bingx-x01/progression/[id]/logs

# Check live positions
redis-cli KEYS "live:position:*" | wc -l
```

## Common Tasks

### Add New Environment Variable
1. Add to `.env.example`
2. Add to `.env.local` for dev
3. Add to Vercel project vars for prod
4. Use in code: `process.env.VAR_NAME`

### Add New API Route
1. Create `app/api/[path]/route.ts`
2. Export async function (GET, POST, etc)
3. Use `getRedisClient()` for data
4. Return `NextResponse.json(data)` or error
5. Add `maxDuration` if needed

### Add New Database Field
1. Create migration in `lib/redis-migrations.ts`
2. Increment version number
3. Add migration function with try/catch
4. Update `redis-db.ts` read/write operations
5. Test with `pnpm exec jest`

### Deploy to Production
```bash
# Test locally first
pnpm build
NODE_ENV=production pnpm start

# Push to main (automated via GitHub)
git push origin feature-branch
# → Create PR
# → Merge to main
# → Vercel auto-deploys
```

## Monitoring Checklist

- [ ] Boot logs show "✓ Pre-startup sequence complete"
- [ ] Regression tests pass (43 total)
- [ ] tsc=0 (no type errors)
- [ ] Coordinator cycles complete without errors
- [ ] Live orders dispatch when engine starts
- [ ] Positions close on SL/TP/expiry
- [ ] Dashboard updates stats in real-time
- [ ] Memory stays within heap limits

## Known Issues and Workarounds

### Multi-Symbol OOM (Dev)
- **Issue**: 10+ symbols causes OOM
- **Cause**: Index maintenance adds 100-500KB per position
- **Workaround**: Set `V0_DEV_SYMBOL_COUNT=1` or restart frequently

### Settings Cache Misses
- **Issue**: Setting changed mid-session not immediately reflected
- **Cause**: 5-minute cache TTL (optimization)
- **Workaround**: Wait 5min or restart server

### Stale Snapshot on Boot
- **Issue**: Old state carries over from previous run
- **Cause**: Redis snapshot persists
- **Workaround**: Delete `.v0-data/redis-snapshot.json` and restart

## Contributing Guidelines

### Code Style
- Use TypeScript (strict mode)
- Use console.log with `[v0] [Component]` prefix for debugging
- Use `try/catch` for all async operations
- Test changes with `pnpm exec jest`

### Commit Messages
```
<type>: <subject>

<optional body explaining rationale>

Co-authored-by: v0agent <it+v0agent@vercel.com>
```

### Testing Before Push
```bash
# Type check
pnpm exec tsc --noEmit --skipLibCheck

# Tests
pnpm exec jest

# Build
pnpm build

# Git push
git push origin feature-branch
```

## Support Resources

- **GitHub Issues**: mxssnx-creator/CTS-V-yd
- **Vercel Dashboard**: https://vercel.com/mxssnx-creator/CTS-V-yd
- **System Summary**: See SYSTEM_SUMMARY.md
