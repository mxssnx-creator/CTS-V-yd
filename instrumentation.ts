/**
 * Next.js instrumentation hook — the deterministic, once-per-process server
 * boot entry point. `register()` runs a single time when each server process
 * starts, BEFORE any request is handled.
 *
 * ── WHY THIS FILE IS CRITICAL (production stability) ─────────────────────────
 * This file had gone missing even though `next.config.mjs` and
 * `scripts/vercel-build-setup.sh` both reference it. Without it, production had
 * NO server-side boot path: the engine only initialized when a browser happened
 * to mount `EngineAutoInitializer` and POST `/api/system/initialize`. That route
 * seeds + auto-starts but does NOT run `completeStartup()`, so the orphaned-flag
 * cleanup (`cleanupOrphanedProgress`) and stranded-position reconcile
 * (`reconcileStrandedPositions`) NEVER ran on a production restart/deploy.
 * Result: zombie `engine_is_running` flags, stalled progress, stranded live
 * positions, and inconsistent counts carried over in the snapshot from the
 * previous process — exactly the "race conditions, stallings, restarts,
 * failures of progress and counts" reported in production. Dev was stable
 * because it is a single long-lived process with the browser always open and a
 * dev-only stale-state flush on every init.
 *
 * Restoring this hook gives production a deterministic, headless boot that does
 * not depend on a browser, and guarantees orphan cleanup + migrations run on
 * every process start. The documented boot path is:
 *   register() → completeStartup() [initRedis→runMigrations, validate,
 *   cleanupOrphanedProgress, reconcileStrandedPositions] →
 *   initializeTradeEngineAutoStart() → startServerContinuityRunner()
 */

// Guard against double-execution across HMR / module re-evaluation. The flag
// lives on globalThis so it survives Next.js dev module reloads within one
// process (register() is only meant to run once per real process start).
const bootGuard = globalThis as unknown as { __v0_instrumentation_booted?: boolean }

export async function register(): Promise<void> {
  // Only skip the Edge runtime. In `next start` / OpenNext production workers
  // `NEXT_RUNTIME` can be undefined during instrumentation registration, while
  // the runtime is still a normal Node-compatible server process. Requiring the
  // value to be exactly "nodejs" skipped deterministic boot in production and
  // reproduced the dev/prod divergence: migrations, orphan cleanup, and
  // stranded-position reconciliation did not run until a later request path.
  if (process.env.NEXT_RUNTIME === "edge") return

  if (bootGuard.__v0_instrumentation_booted) return
  bootGuard.__v0_instrumentation_booted = true

  console.log("[v0] [Instrumentation] register() — beginning deterministic server boot...")

  // Each step is wrapped so a single failure cannot abort the rest of the boot
  // (or crash the server). The pre-startup sequence is the most important part
  // — it runs migrations and cleans orphaned state from the previous process.
  try {
    const { completeStartup } = await import("@/lib/startup-coordinator")
    await completeStartup()
  } catch (err) {
    console.error("[v0] [Instrumentation] completeStartup failed (continuing):", err instanceof Error ? err.message : err)
  }

  // Production Node processes should be self-contained: initialize the
  // auto-start/healing sweep and continuity runner by default so explicit UI
  // actions and persisted running intent work without a separate worker env flag.
  // Serverless/edge safety is handled inside the imported runners.
  if (process.env.DISABLE_TRADE_ENGINE_AUTOSTART !== "1") {
    try {
      const { initializeTradeEngineAutoStart } = await import("@/lib/trade-engine-auto-start")
      await initializeTradeEngineAutoStart()
    } catch (err) {
      console.error("[v0] [Instrumentation] auto-start init failed (continuing):", err instanceof Error ? err.message : err)
    }
  } else {
    console.warn("[v0] [Instrumentation] trade-engine auto-start disabled by DISABLE_TRADE_ENGINE_AUTOSTART=1")
    console.warn("[v0] [Instrumentation] background trade-engine auto-start skipped; explicit UI actions and continuity sweeps can start/reconcile engines")
  }

  if (process.env.DISABLE_IN_PROCESS_CONTINUITY !== "1") {
    try {
      const { startServerContinuityRunner } = await import("@/lib/server-continuity-runner")
      startServerContinuityRunner()
    } catch (err) {
      console.error("[v0] [Instrumentation] continuity runner failed (continuing):", err instanceof Error ? err.message : err)
    }
  } else {
    console.warn("[v0] [Instrumentation] in-process continuity disabled by DISABLE_IN_PROCESS_CONTINUITY=1")
    console.warn("[v0] [Instrumentation] background in-process continuity skipped; deployment cron or UI-triggered reconciliation remains available")
  }

  console.log("[v0] [Instrumentation] ✓ Server boot complete")
}
