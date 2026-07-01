/**
 * GET /api/connections/[id]/engine-states
 *
 * Returns per-connection engine running state for all three engines (main,
 * live, preset) together with the persisted DB toggle flags. The UI uses this
 * to keep the Enable / Live Trade / Preset Mode switches bidirectionally synced
 * with the actual engine state and to surface drift (e.g. flag is ON but the
 * engine is not actually running).
 *
 * Response shape:
 * {
 *   success: true,
 *   connectionId: string,
 *   enabled:  { flag: boolean, running: boolean, inSync: boolean },
 *   live:     { flag: boolean, running: boolean, inSync: boolean },
 *   preset:   { flag: boolean, running: boolean, inSync: boolean },
 * }
 */
import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getConnection, getRedisClient, getSettings } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { SystemLogger } from "@/lib/system-logger"

export const runtime = "nodejs"
export const maxDuration = 15
export const dynamic = "force-dynamic"
export const fetchCache = "force-no-store"

const toBoolean = (v: unknown) =>
  v === true || v === 1 || v === "1" || v === "true"

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: connectionId } = await params

  const headers = {
    "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
    Pragma: "no-cache",
  }

  try {
    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json(
        { success: false, error: "Connection not found" },
        { status: 404, headers }
      )
    }

    const coordinator = getGlobalTradeEngineCoordinator()
    const engineRunning =
      !!coordinator && coordinator.isEngineRunning(connectionId)

    // Redis hint key for stale-flag detection — written as string "0"/"1" by setRunningFlag and DELETE route
    // (and future reconciliation code) as a string value (setRunningFlag uses client.set).
    // Used as a tiebreaker when the in-memory manager is missing.
    let runningHint = false
    try {
      const client = getRedisClient()
      const hint = await client.get(`engine_is_running:${connectionId}`)
      const raw = typeof hint === "string" ? hint : ""
      runningHint = raw === "true" || raw === "1"
    } catch {
      /* non-critical */
    }

    // DB flags — the canonical source of truth for the slider `checked` state.
    // is_active_inserted / is_assigned are panel assignment only;
    // is_enabled_dashboard is the explicit processing switch.
    const flagEnabled = toBoolean((connection as any).is_enabled_dashboard)
    // UI sliders represent the operator's requested state, not only the
    // immediately executable/effective flag. When credentials are missing the
    // live-trade endpoint preserves `live_trade_requested=1` while keeping
    // `is_live_trade=0`; if this endpoint reports only the effective flag, the
    // slider flips itself back off on the next poll and looks unstable.
    const liveEffective = toBoolean((connection as any).is_live_trade)
    const liveRequested = toBoolean((connection as any).live_trade_requested)
    const flagLive    = liveRequested || liveEffective
    const flagPreset  = toBoolean((connection as any).is_preset_trade)

    // Correct semantics now that Live/Preset are mode flags on a single engine
    // (not separate engines). One TradeEngineManager per connection services all
    // three modes — it checks the flag each cycle.
    //
    //   Enable slider:  inSync = flagEnabled === engineRunning
    //                   (toggling Enable start/stops the engine directly)
    //
    //   Live / Preset:  inSync requires the engine to be running when the flag
    //                   is ON (otherwise the flag has no effect). When the flag
    //                   is OFF, inSync is always true — no engine is required.
    const buildEnableState = (flag: boolean) => ({
      flag,
      running: engineRunning,
      inSync: flag === engineRunning,
    })
    const buildModeState = (flag: boolean, effective = flag) => ({
      flag,
      effective,
      // "running" for mode flags = "engine is up and will pick up this flag"
      running: engineRunning,
      // Requested-but-blocked live trade is still a stable requested UI state;
      // surface effective=false so the UI can explain it without reverting the
      // switch. Only require a running engine once the mode is actually active.
      inSync: !flag || !effective || engineRunning,
    })

    return NextResponse.json(
      {
        success: true,
        connectionId,
        engineRunning,
        runningHint,
        enabled: buildEnableState(flagEnabled),
        live: buildModeState(flagLive, liveEffective),
        preset: buildModeState(flagPreset),
        timestamp: new Date().toISOString(),
      },
      { headers }
    )
  } catch (error) {
    await SystemLogger.logError(
      error,
      "api",
      `GET /api/connections/${connectionId}/engine-states`
    )
    return NextResponse.json(
      {
        success: false,
        error: "Failed to resolve engine states",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500, headers }
    )
  }
}
