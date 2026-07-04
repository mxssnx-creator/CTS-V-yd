import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { initRedis, getConnection, updateConnection, getRedisClient } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { notifySettingsChanged } from "@/lib/settings-coordinator"
import { nextStateSwitchVersion, queueEngineRefreshRequest } from "@/lib/engine-refresh-queue"

/**
 * POST /api/settings/connections/[id]/enable
 * Enable a connection with test validation
 * 
 * Base connections (is_predefined=1): Enable directly if test passes
 * Active connections: Disable by default when added, require explicit enable
 */
export const dynamic = "force-dynamic"
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const { shouldEnable, skipTest = false } = await request.json()

    console.log(`[v0] [Enable Connection] ${id}: shouldEnable=${shouldEnable}, skipTest=${skipTest}`)
    await initRedis()

    const connection = await getConnection(id)
    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // If enabling, ALWAYS test connection first (unless skipTest=true for predefined)
    if (shouldEnable) {
      const isPredefined = connection.is_predefined === "1" || connection.is_predefined === true
      
      // Skip test only for predefined connections with skipTest flag
      if (!isPredefined || !skipTest) {
        console.log(`[v0] [Enable Connection] Testing connection ${id} before enabling...`)
        
        try {
          const credentials = {
            apiKey: connection.api_key || "",
            apiSecret: connection.api_secret || "",
            apiPassphrase: connection.api_passphrase || undefined,
            isTestnet: connection.is_testnet === "1" || connection.is_testnet === true,
            apiType: connection.api_type,
            marginType: connection.margin_type,
            positionMode: connection.position_mode,
          }
          const connector = await createExchangeConnector(connection.exchange, credentials)
          const testResult = await connector.testConnection()

          if (!testResult.success) {
            console.log(`[v0] [Enable Connection] Test failed for ${id}: ${testResult.error}`)
            return NextResponse.json(
              {
                success: false,
                error: "Connection test failed",
                testError: testResult.error,
                details: testResult.logs?.join("\n"),
              },
              { status: 400 },
            )
          }

          console.log(`[v0] [Enable Connection] Test passed for ${id}`)
          await SystemLogger.logConnection(`Connection test passed, enabling`, id, "info", {
            balance: testResult.balance,
            capabilities: testResult.capabilities,
          })
        } catch (error) {
          console.error(`[v0] [Enable Connection] Test error for ${id}:`, error)
          return NextResponse.json(
            {
              success: false,
              error: "Connection test failed",
              details: error instanceof Error ? error.message : "Unknown error",
            },
            { status: 400 },
          )
        }
      }
    }

    // Update connection enabled state
    const stateSwitchVersion = nextStateSwitchVersion(connection)
    const updatedConnection = {
      ...connection,
      is_enabled: shouldEnable ? "1" : "0",
      state_switch_version: stateSwitchVersion,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updatedConnection)
    console.log(`[v0] [Enable Connection] ${id} is now ${shouldEnable ? "enabled" : "disabled"}`)

    await SystemLogger.logConnection(
      `Connection ${shouldEnable ? "enabled" : "disabled"}`,
      id,
      "info",
      { is_enabled: shouldEnable },
    )

    // Notify engine of enable/disable change and apply immediately
    try {
      await notifySettingsChanged(id, ["is_enabled", "state_switch_version"], { is_enabled: connection.is_enabled, state_switch_version: (connection as any).state_switch_version }, { is_enabled: updatedConnection.is_enabled, state_switch_version: stateSwitchVersion })
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      
      if (shouldEnable) {
        // Engine should start if conditions are met
        const { isConnectionMainProcessing, hasConnectionCredentials, isTruthyFlag } = await import(
          "@/lib/connection-state-utils"
        )
        const canRun =
          isConnectionMainProcessing(updatedConnection) &&
          (hasConnectionCredentials(updatedConnection, 5, true) ||
            isTruthyFlag((updatedConnection as any).is_predefined) ||
            isTruthyFlag((updatedConnection as any).is_testnet) ||
            isTruthyFlag((updatedConnection as any).demo_mode))
        if (canRun) {
          const client = getRedisClient()
          const globalState: Record<string, string> = await client
            .hgetall("trade_engine:global")
            .catch(() => ({} as Record<string, string>)) || {}

          await client.hset("trade_engine:global", {
            ...globalState,
            status: "running",
            desired_status: "running",
            operator_intent: "running",
            coordinator_ready: "true",
            operator_stopped: "0",
            operator_stopped_at: "",
            stopped_at: "",
            started_at: globalState.started_at || new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })

          await queueEngineRefreshRequest({
            timestamp: new Date().toISOString(),
            connectionId: id,
            action: "start",
            state_switch_version: stateSwitchVersion,
            reason: "connection_enable",
          })
          const localStartAllowed =
            process.env.DISABLE_TRADE_ENGINE_IN_PROCESS !== "1" &&
            process.env.NEXT_RUNTIME !== "edge" &&
            (process.env.NODE_ENV !== "production" ||
              (process.env.ALLOW_API_TRADE_ENGINE_FOREGROUND === "1" &&
                process.env.ENABLE_TRADE_ENGINE_IN_PROCESS === "1"))
          if (localStartAllowed && !coordinator.isEngineRunning(id)) {
            await coordinator.startMissingEngines([updatedConnection])
          }
        }
      } else {
        // Engine should stop if it was running. Queue + trigger the event-state
        // refresh so production workers do not wait for the periodic sweep.
        await queueEngineRefreshRequest({
          timestamp: new Date().toISOString(),
          connectionId: id,
          action: "stop",
          state_switch_version: stateSwitchVersion,
          reason: "connection_disable",
        })
        await coordinator.applyPendingChangesNow(id)
        if (coordinator.isEngineRunning(id)) {
          await coordinator.stopEngine(id, { operatorRequested: true })
        }
      }
    } catch (applyErr) {
      console.warn(
        `[v0] [Enable] coordinator recoordination failed for ${id}:`,
        applyErr instanceof Error ? applyErr.message : String(applyErr),
      )
    }

    return NextResponse.json({
      success: true,
      message: `Connection ${shouldEnable ? "enabled" : "disabled"}`,
      connection: updatedConnection,
    })
  } catch (error) {
    console.error(`[v0] [Enable Connection] Exception:`, error)
    await SystemLogger.logError(error, "api", `POST /api/settings/connections/[id]/enable`)
    return NextResponse.json(
      {
        success: false,
        error: "Failed to enable connection",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 },
    )
  }
}
