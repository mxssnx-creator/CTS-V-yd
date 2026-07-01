import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection } from "@/lib/redis-db"
import { getGlobalTradeEngineCoordinator } from "@/lib/trade-engine"
import { loadSettingsAsync } from "@/lib/settings-storage"
import { parseBooleanInput, toRedisFlag } from "@/lib/boolean-utils"

/**
 * POST /api/settings/connections/[id]/preset-toggle
 *
 * Toggles the `is_preset_trade` flag on a connection. Like `live-trade`, this
 * is a MODE FLAG on the already-running engine — not a separate engine. The
 * running engine checks this flag each cycle to decide whether to evaluate
 * preset strategies vs the default flow.
 *
 * STABILITY RULE (important):
 *   Preset-toggle must NOT stop the engine when the user turns Preset Mode off
 *   — doing so would also kill the Main trading pipeline. It must also NOT
 *   restart the engine when turning Preset on if the engine is already running
 *   (the underlying TradeEngineManager.start() no-ops via `isRunning` guard).
 *
 *   The only case where this endpoint starts the engine is when Preset is
 *   turned ON while the engine is not yet running — in that case the engine is
 *   started so the flag actually has an effect.
 */
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id: connectionId } = await params
  try {
    const body = await request.json()
    const isPresetTrade = parseBooleanInput(body?.is_preset_trade)

    console.log(`[v0] [Preset Trade] POST for ${connectionId}, is_preset_trade=${isPresetTrade}`)

    await initRedis()
    const connection = await getConnection(connectionId)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }
    const connName = connection.name

    // Require credentials for preset trading (same as live).
    if (isPresetTrade) {
      const apiKey = (connection.api_key || connection.apiKey || "") as string
      const apiSecret = (connection.api_secret || connection.apiSecret || "") as string
      const hasCredentials = apiKey.length > 10 && apiSecret.length > 10
      if (!hasCredentials) {
        return NextResponse.json(
          {
            success: false,
            error: "API credentials required for preset trading",
            hint: "Add API key and secret in Settings to enable preset trading",
          },
          { status: 400 },
        )
      }
    }

    // Persist the flag — the running engine reads this each cycle.
    const updatedConnection = {
      ...connection,
      is_preset_trade: toRedisFlag(isPresetTrade),
      updated_at: new Date().toISOString(),
    }
    await updateConnection(connectionId, updatedConnection)
    console.log(`[v0] [Preset Trade] Flag updated for ${connName}: ${isPresetTrade}`)

    const coordinator = getGlobalTradeEngineCoordinator()
    let engineStatus: "running" | "starting" | "stopped" | "error" = "stopped"
    let engineStartedNow = false

    if (isPresetTrade) {
      if (coordinator.isEngineRunning(connectionId)) {
        engineStatus = "running"
        console.log(`[v0] [Preset Trade] Engine already running for ${connName} — flag updated, no restart`)
      } else {
        try {
          const settings = await loadSettingsAsync()
          await coordinator.startEngine(connectionId, {
            connectionId,
            connection_name: connName,
            exchange: connection.exchange,
            engine_type: "preset",
            indicationInterval: settings?.mainEngineIntervalMs ? settings.mainEngineIntervalMs / 1000 : 5,
            strategyInterval: settings?.strategyUpdateIntervalMs ? settings.strategyUpdateIntervalMs / 1000 : 10,
            realtimeInterval: settings?.realtimeIntervalMs ? settings.realtimeIntervalMs / 1000 : 0.3,
          }, { markAssigned: true })
          engineStatus = "starting"
          engineStartedNow = true
          console.log(`[v0] [Preset Trade] Engine started for ${connName} to service preset flag`)
        } catch (err) {
          console.error(`[v0] [Preset Trade] Failed to start engine:`, err)
          await SystemLogger.logError(err, "api", `Start preset engine for ${connName}`)
          return NextResponse.json(
            {
              success: false,
              error: "Failed to start preset engine",
              details: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      }
    } else {
      // Turning Preset OFF must NOT stop the engine — the Main pipeline might
      // still be running. Next cycle the strategy flow will ignore the preset
      // branch because the flag is "0".
      engineStatus = coordinator.isEngineRunning(connectionId) ? "running" : "stopped"
      console.log(`[v0] [Preset Trade] Flag cleared for ${connName} — engine left untouched (status=${engineStatus})`)
    }

    await SystemLogger.logConnection(
      `Preset Mode ${isPresetTrade ? "enabled" : "disabled"} via UI toggle`,
      connectionId,
      "info",
      { is_preset_trade: isPresetTrade, engineStartedNow, engineStatus },
    )

    return NextResponse.json({
      success: true,
      is_preset_trade: isPresetTrade,
      engineStatus,
      engineStartedNow,
      connection: updatedConnection,
      message: `Preset Mode ${isPresetTrade ? "enabled" : "disabled"}`,
    })
  } catch (error) {
    console.error("[v0] [Preset Trade] Exception:", error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/${connectionId}/preset-toggle`)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to toggle preset trade",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
