import { NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { runTradeEngineHealingSweep } from "@/lib/trade-engine-auto-start"
import { startServerContinuityRunner } from "@/lib/server-continuity-runner"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"
export const maxDuration = 60

const LOCK_KEY = "cron:server-continuity:lock"
const LOCK_TTL_SECONDS = 55

async function runCronTask(
  name: string,
  task: () => Promise<unknown>,
  timeoutMs = 20_000,
): Promise<{ name: string; ok: boolean; error?: string; timedOut?: boolean }> {
  try {
    let timeout: NodeJS.Timeout | undefined
    await Promise.race([
      task(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs)
        timeout.unref?.()
      }),
    ]).finally(() => {
      if (timeout) clearTimeout(timeout)
    })
    return { name, ok: true }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(`[v0] [ContinuityCron] ${name} failed:`, message)
    return { name, ok: false, error: message, timedOut: message.includes("timed out") }
  }
}

/**
 * Durable server-side continuity tick.
 *
 * Browser tabs and in-process timers are not reliable in all production modes:
 * users can close the dashboard, PM2/Docker processes can restart, and Vercel
 * serverless functions cannot keep intervals alive after a request returns.
 * This cron endpoint is the deployment-level heartbeat that re-arms Redis,
 * migrations, and the trade-engine auto-start monitor once per minute.
 */
export async function GET() {
  const startedAt = Date.now()
  const token = `continuity_${startedAt}_${Math.random().toString(36).slice(2, 10)}`

  try {
    await initRedis()
    const client = getRedisClient()
    const acquired = await client.set(LOCK_KEY, token, { NX: true, EX: LOCK_TTL_SECONDS }).catch(() => null)
    if (acquired !== "OK") {
      return NextResponse.json({ success: true, skipped: true, reason: "continuity tick already running" })
    }

    try {
      // On long-lived Node deployments this ensures the in-process runner is
      // active. On Vercel/serverless the runner intentionally no-ops, so this
      // single cron invocation runs the durable heartbeat tasks directly.
      //
      // NOTE: live-position sync is intentionally NOT run here. It has its OWN
      // dedicated Vercel cron (`/api/cron/sync-live-positions`, see vercel.json)
      // because that route self-loops 4 sweeps over a ~55 s wall budget for a
      // ~15 s effective reconcile cadence — the operator's "keep actively
      // processing until positions close" requirement. Running it here as a
      // sub-task forced it under runCronTask's 20 s timeout, truncating it to a
      // single sweep AND contending on the same `cron:sync-live-positions:lock`
      // (non-deterministic with the dedicated cron). The dedicated cron lets it
      // use its full per-invocation budget natively. This route stays the
      // engine heartbeat: keep the engine auto-started and ticking (the engine's
      // own realtime processor reconciles open positions every ~5 s while it
      // runs; the dedicated sync cron is the engine-down safety net).
      startServerContinuityRunner()
      const tasks = await Promise.all([
        runCronTask("auto-start-healing-sweep", () => runTradeEngineHealingSweep({ isStartup: true })),
        runCronTask("generate-indications", async () => {
          const mod = await import("@/app/api/cron/generate-indications/route")
          return mod.GET()
        }),
      ])
      const failedTasks = tasks.filter((task) => !task.ok)

      return NextResponse.json({
        success: true,
        degraded: failedTasks.length > 0,
        tasks,
        warnings: failedTasks.map((task) => `${task.name}: ${task.error || "failed"}`),
        durationMs: Date.now() - startedAt,
      })
    } finally {
      const current = await client.get(LOCK_KEY).catch(() => null)
      if (current === token) {
        await client.del(LOCK_KEY).catch(() => {})
      }
    }
  } catch (error) {
    console.error("[v0] [ContinuityCron] failed:", error)
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    )
  }
}

export async function POST() {
  return GET()
}
