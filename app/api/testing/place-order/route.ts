import { NextRequest, NextResponse } from "next/server"
import { getRedisClient, initRedis } from "@/lib/redis-db"
import { createExchangeConnector } from "@/lib/exchange-connectors/factory"
import { getLiveOrderSafetyFailure } from "@/lib/live-order-safety"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import type { ExchangeConnection } from "@/lib/types"

export const dynamic = "force-dynamic"
export async function POST(req: NextRequest) {
  try {
    await initRedis()
    const body = await req.json()
    const { connectionId, symbol, side, quantity, leverage } = body

    if (!connectionId || !symbol || !side || !quantity || leverage === undefined) {
      return NextResponse.json(
        { error: "Missing required fields: connectionId, symbol, side, quantity, leverage" },
        { status: 400 }
      )
    }

    const client = getRedisClient()
    
    // Get connection details
    const connData = await client.hgetall(`connection:${connectionId}`)
    if (!connData || Object.keys(connData).length === 0) {
      return NextResponse.json(
        { error: `Connection ${connectionId} not found` },
        { status: 404 }
      )
    }

    const connection = {
      id: connectionId,
      name: connData.name || connectionId,
      exchange: connData.exchange || "unknown",
      api_key: connData.api_key || "",
      api_secret: connData.api_secret || "",
      api_passphrase: connData.api_passphrase || "",
      api_type: connData.api_type || "",
      contract_type: connData.contract_type || "",
      is_testnet: connData.is_testnet || "0",
      margin_type: connData.margin_type || "",
      position_mode: connData.position_mode || "",
      connection_method: connData.connection_method || "",
      connection_library: connData.connection_library || "",
    } as any as ExchangeConnection

    const sideKey = String(side).trim().toLowerCase()
    const direction: "long" | "short" = sideKey === "short" || sideKey === "sell" ? "short" : "long"
    const exchangeSide: "buy" | "sell" = direction === "long" ? "buy" : "sell"
    const symbolKey = String(symbol).trim().toUpperCase()

    console.log(`[PlaceOrder] Placing ${direction} (${exchangeSide}) order for ${symbolKey} x${leverage} with ${quantity} coins`)

    // Choose connector: prefer simulated when FORCE_SIMULATED=1 or missing API keys.
    // Real exchange order placement is intentionally blocked unless both a
    // server-side enable flag and an explicit per-request confirmation are present.
    let connector: any = null
    const forceSim = process.env.FORCE_SIMULATED === "1"
    const willUseRealExchange = !forceSim && !!connection.api_key && !!connection.api_secret
    const orderMode = willUseRealExchange ? "live" : "simulated"
    if (willUseRealExchange) {
      const safetyFailure = getLiveOrderSafetyFailure(body)
      if (safetyFailure) {
        return NextResponse.json(
          {
            success: false,
            error: safetyFailure,
            mode: "blocked_live_order_safety",
          },
          { status: 403 },
        )
      }
    }

    if (forceSim || !connection.api_key || !connection.api_secret) {
      try {
        const { SimulatedConnector } = await import("@/lib/exchange-connectors/simulated-connector")
        connector = new SimulatedConnector({ apiKey: connection.api_key, apiSecret: connection.api_secret, isTestnet: isTruthyFlag(connection.is_testnet) }, "simulated")
        console.log(`[PlaceOrder] Using SimulatedConnector for ${connectionId} (forceSim=${forceSim})`)
      } catch (simErr) {
        console.warn(`[PlaceOrder] Failed to create SimulatedConnector fallback:`, simErr)
      }
    }

    if (!connector) {
      connector = await createExchangeConnector(connection.exchange, {
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        apiPassphrase: connection.api_passphrase || "",
        isTestnet: isTruthyFlag(connection.is_testnet),
        apiType: connection.api_type,
        contractType: connection.contract_type,
      })
    }

    // Set leverage if applicable (for swap/perpetual markets)
    if (leverage && leverage > 1 && typeof connector?.setLeverage === "function") {
      console.log(`[PlaceOrder] Setting leverage to ${leverage}x`)
      try {
        const leverageResult = await connector.setLeverage(symbolKey, leverage)
        console.log(`[PlaceOrder] Leverage set: ${JSON.stringify(leverageResult)}`)
      } catch (err) {
        console.log(`[PlaceOrder] Could not set leverage (may not be a perpetual market):`, err instanceof Error ? err.message : String(err))
      }
    }

    // Place market order with minimal volume
    console.log(`[PlaceOrder] Placing market order: ${exchangeSide} ${quantity} ${symbolKey} with leverage ${leverage}x`)
    const positionMode = String(connection.position_mode || "").toLowerCase()
    const hedgeMode = positionMode.includes("hedge") || positionMode.includes("dual")
    const orderOptions = hedgeMode
      ? { hedgeMode: true, positionSide: (direction === "long" ? "LONG" : "SHORT") as "LONG" | "SHORT" }
      : { hedgeMode: false }
    const result = await connector.placeOrder(symbolKey, exchangeSide, quantity, 0, "market", orderOptions)

    console.log(`[PlaceOrder] Order result:`, result)

    if (!result || !result.success) {
      return NextResponse.json(
        {
          success: false,
          error: result?.error || "Failed to place order",
        },
        { status: 400 }
      )
    }

    // Persist real exchange results to the live counters. Simulated fallback
    // orders must not inflate live order/position counts because that makes
    // dashboard relations and percentages look like real exchange execution.
    try {
      const { getRedisClient, savePosition, getMarketData } = await import("@/lib/redis-db")
      if (!willUseRealExchange) {
        await (getRedisClient() as any).hincrby(`progression:${connectionId}`, "live_orders_simulated_count", 1)
        return NextResponse.json({
          success: true,
          mode: orderMode,
          orderId: (result as any)?.orderId || (result as any)?.order_id || "N/A",
          symbol: symbolKey,
          side: exchangeSide,
          direction,
          quantity,
          leverage,
          timestamp: Date.now(),
          details: (result as any)?.details || result,
        })
      }
      const client = getRedisClient()
      // Determine fill price: prefer exchange-provided, else market data
      let fillPrice = (result as any)?.filledPrice || (result as any)?.avgPrice || 0
      if (!fillPrice || fillPrice <= 0) {
        const md = await getMarketData(symbolKey, "1m").catch(() => null)
        const latest = md && (md.latest || (Array.isArray(md) ? md[md.length - 1] : null))
        fillPrice = latest ? parseFloat(String(((latest.close ?? latest[4] ?? latest.price) || 0))) || 0 : fillPrice
      }

      const execQty = Number(quantity) || Number((result as any)?.filledQty) || 0
      const liveId = `live:${connectionId}:${symbolKey}:${direction}:${Date.now()}:${Math.random().toString(36).slice(2,8)}`
      const livePos: any = {
        id: liveId,
        connectionId,
        symbol: symbolKey,
        side: direction,
        direction,
        entryPrice: fillPrice || 0,
        executedQuantity: execQty,
        remainingQuantity: 0,
        averageExecutionPrice: fillPrice || 0,
        quantity: execQty,
        volumeUsd: (execQty || 0) * (fillPrice || 0),
        leverage: leverage || 1,
        marginType: "cross",
        stopLoss: 0,
        takeProfit: 0,
        assignedStopLoss: 0,
        assignedTakeProfit: 0,
        status: execQty > 0 ? "open" : "placed",
        fills: execQty > 0 ? [{ timestamp: Date.now(), quantity: execQty, price: fillPrice || 0, fee: 0, feeAsset: "" }] : [],
        progression: [],
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }

      await savePosition(livePos as any)

      // Update progression counters atomically
      try {
        await (client as any).hincrby(`progression:${connectionId}`, "live_orders_placed_count", 1)
        if (execQty > 0) {
          await (client as any).hincrby(`progression:${connectionId}`, "live_orders_filled_count", 1)
          await (client as any).hincrby(`progression:${connectionId}`, "live_positions_created_count", 1)
          // volume USD total as float (use hincrbyfloat when available)
          if (typeof (client as any).hincrbyfloat === "function") {
            await (client as any).hincrbyfloat(`progression:${connectionId}`, "live_volume_usd_total", (livePos.volumeUsd || 0))
          } else {
            await (client as any).hincrby(`progression:${connectionId}`, "live_volume_usd_total", Math.round(livePos.volumeUsd || 0))
          }
        }
        // Update per-symbol orders map
        const ordersBySymbolKey = `live_orders_by_symbol:${connectionId}`
        await (client as any).hincrby(ordersBySymbolKey, `${symbolKey}:${direction}:placed`, 1)
        if (execQty > 0) {
          await (client as any).hincrby(ordersBySymbolKey, `${symbolKey}:${direction}:filled`, 1)
        }
      } catch (cErr) {
        console.warn("[PlaceOrder] Failed to update progression counters:", cErr)
      }
    } catch (persistErr) {
      console.warn("[PlaceOrder] Failed to persist live position:", persistErr)
    }

    return NextResponse.json({
      success: true,
      mode: orderMode,
      orderId: (result as any)?.orderId || (result as any)?.order_id || "N/A",
      symbol: symbolKey,
      side: exchangeSide,
      direction,
      quantity,
      leverage,
      timestamp: Date.now(),
      details: (result as any)?.details || result,
    })
  } catch (error) {
    console.error("[PlaceOrder] Error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
