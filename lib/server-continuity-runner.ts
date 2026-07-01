/**
 * Server-side continuity runner.
 *
 * Keeps instance progress moving from the Node runtime itself instead of relying
 * on a browser tab being open. Browser polling may disappear on page refresh,
 * navigation, laptop sleep, or when the user closes the dashboard; this runner
 * is process-scoped and idempotent so the trade-engine/cron path remains active
 * for long-lived production (`next start`, Docker, PM2, VPS) and dev servers.
 *
 * Vercel/serverless note: serverless functions cannot guarantee durable
 * in-process timers after the request returns. On Vercel the repo's
 * `vercel.json` crons are the durable production fallback. Set
 * DISABLE_IN_PROCESS_CONTINUITY=1 to opt out in long-lived Node deployments.
 */

type ContinuityGlobal = typeof globalThis & {
  __cts_continuity_runner?: {
    started: boolean
    indicationTimer?: NodeJS.Timeout
    autoStartTimer?: NodeJS.Timeout
    indicationInFlight: boolean
    autoStartInFlight: boolean
  }
}

const g = globalThis as ContinuityGlobal

const DEFAULT_INDICATION_INTERVAL_MS = 3_000
const DEFAULT_AUTOSTART_INTERVAL_MS = 30_000

function parseInterval(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name]
  const n = raw ? Number(raw) : fallback
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.round(n)))
}

function shouldSkipInProcessTimers(): boolean {
  // Long-lived Node production/dev processes should keep continuity alive by
  // default. Serverless/edge deployments still use deployment cron because
  // in-process timers are not durable after responses return.
  if (process.env.DISABLE_IN_PROCESS_CONTINUITY === "1") return true
  return process.env.VERCEL === "1" || process.env.NEXT_RUNTIME === "edge"
}

async function runIndicationTick(): Promise<void> {
  const state = g.__cts_continuity_runner
  if (!state || state.indicationInFlight) return
  state.indicationInFlight = true
  try {
    const mod = await import("@/app/api/cron/generate-indications/route")
    await mod.GET()
  } catch (err) {
    console.warn(
      "[v0] [Continuity] indication tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.indicationInFlight = false
  }
}

async function runAutoStartTick(): Promise<void> {
  const state = g.__cts_continuity_runner
  if (!state || state.autoStartInFlight) return
  state.autoStartInFlight = true
  try {
    const { initializeTradeEngineAutoStart } = await import("@/lib/trade-engine-auto-start")
    await initializeTradeEngineAutoStart()
  } catch (err) {
    console.warn(
      "[v0] [Continuity] auto-start monitor tick failed:",
      err instanceof Error ? err.message : String(err),
    )
  } finally {
    state.autoStartInFlight = false
  }
}

export function isServerContinuityRunnerStarted(): boolean {
  return !!g.__cts_continuity_runner?.started
}

export function startServerContinuityRunner(): void {
  if (!g.__cts_continuity_runner) {
    g.__cts_continuity_runner = {
      started: false,
      indicationInFlight: false,
      autoStartInFlight: false,
    }
  }

  const state = g.__cts_continuity_runner
  if (state.started) return
  state.started = true

  if (shouldSkipInProcessTimers()) {
    console.log("[v0] [Continuity] In-process timers skipped; relying on production cron/scheduler")
    return
  }

  const indicationIntervalMs = parseInterval(
    "SERVER_CONTINUITY_INDICATION_MS",
    DEFAULT_INDICATION_INTERVAL_MS,
    1_000,
    60_000,
  )
  const autoStartIntervalMs = parseInterval(
    "SERVER_CONTINUITY_AUTOSTART_MS",
    DEFAULT_AUTOSTART_INTERVAL_MS,
    5_000,
    120_000,
  )

  // Kick once immediately after startup, then continue on intervals. These
  // calls are guarded by Redis locks inside the cron/auto-start paths, so they
  // are safe alongside browser tabs, external crons, and multiple workers.
  void runAutoStartTick()
  void runIndicationTick()

  state.autoStartTimer = setInterval(() => void runAutoStartTick(), autoStartIntervalMs)
  state.indicationTimer = setInterval(() => void runIndicationTick(), indicationIntervalMs)
  state.autoStartTimer.unref?.()
  state.indicationTimer.unref?.()

  console.log(
    `[v0] [Continuity] Server runner active: indications=${indicationIntervalMs}ms, autoStart=${autoStartIntervalMs}ms`,
  )
}

export function stopServerContinuityRunner(): void {
  const state = g.__cts_continuity_runner
  if (!state) return
  if (state.indicationTimer) clearInterval(state.indicationTimer)
  if (state.autoStartTimer) clearInterval(state.autoStartTimer)
  state.indicationTimer = undefined
  state.autoStartTimer = undefined
  state.started = false
  state.indicationInFlight = false
  state.autoStartInFlight = false
}
