# Redis `client.keys(` audit

`client.keys(pattern)` is a full-keyspace operation and is not safe for frequent production polling or runtime hot paths. Runtime readers should use explicit indexes (`sadd`/`smembers`, bounded lists, or bounded `SCAN` helpers) that are maintained when records are written.

## Runtime hot-path usages remediated

These previously used `client.keys(` in engine/dashboard runtime paths and now read explicit indexes or bounded `SCAN` helpers:

- `lib/trade-engine/stages/base-stage.ts`
  - `getBasePositions()` now reads `base:positions:index:{connectionId}` with `smembers`.
  - `storeBasePosition()` and status updates maintain that set.
  - `cleanupOldBasePositions()` reads/removes from the same set.
- `lib/trade-engine/stages/main-stage.ts`
  - `getMainPositions()` now reads `main:positions:index:{connectionId}` with `smembers`.
  - main-position writes maintain that set.
- `lib/trade-engine/stages/real-stage.ts`
  - `getRealPositions()` now reads `real:positions:index:{connectionId}` with `smembers`.
  - real-position writes/status updates maintain that set.
- `lib/trade-engine/stages/live-stage.ts`
  - `getLivePositions()` now relies on the bounded `live:positions:{connectionId}` list and no longer falls back to `KEYS`.
  - live-position updates refresh the bounded list index.
- `lib/trade-engine/stages/indication-stage.ts`
  - `getCurrentIndications()` now reads `indication:index:{connectionId}` with `smembers`.
  - indication writes add each full `indication:{connectionId}:*` key to that index.
  - stale index members are removed when their indication payload has expired.
- `lib/engine-performance-monitor.ts`
  - detailed-size/timer inspection now uses a bounded `SCAN` helper instead of `KEYS`.
- `lib/dashboard-workflow.ts`
  - strategy-set and prehistoric-key counts now use a bounded `SCAN` helper instead of `KEYS`.

## Diagnostics-only / maintenance usages still present

The remaining `client.keys(` calls in `lib/` are diagnostics, validation, local seeding, migrations, maintenance cleanup, archive tooling, startup reconciliation, or broad Redis-admin helpers. They must not be exposed to high-frequency production polling. Keep them behind admin/debug/maintenance routes, startup-only paths, or one-shot operator jobs, and prefer replacing them with explicit indexes or bounded `SCAN` before promoting any caller into normal runtime traffic.

Current remaining files with raw `client.keys(` calls:

- `lib/connection-data-archive.ts` — archive/export maintenance.
- `lib/data-cleanup-manager.ts` — cleanup maintenance.
- `lib/database-validator.ts` — validation diagnostics.
- `lib/db.ts` — compatibility/diagnostic read helper.
- `lib/engine-refresh-queue.ts` — refresh-queue housekeeping.
- `lib/engine-system-verification.ts` — system verification diagnostics.
- `lib/indication-config-manager.ts` — configuration enumeration.
- `lib/indication-sets-processor.ts` — guarded/backfill-style index repair and cleanup.
- `lib/redis-db.ts` — broad Redis repository/admin helper surface; do not poll these endpoints frequently unless migrated to indexes or bounded scans.
- `lib/redis-migrations.ts` — one-shot migration execution.
- `lib/redis-operations.ts` — Redis admin/cache/settings operations.
- `lib/redis-procedures.ts` — Redis diagnostics/maintenance procedures.
- `lib/production-seeder.ts` — seeding/reset maintenance.
- `lib/startup-coordinator.ts` — startup reconciliation only.
- `lib/strategy-config-manager.ts` — configuration enumeration.
