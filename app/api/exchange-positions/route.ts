import { type NextRequest, NextResponse } from "next/server"
import { ExchangePositionManager } from "@/lib/exchange-position-manager"

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connection_id") || searchParams.get("connectionId")
    const symbol = searchParams.get("symbol")
    const status = searchParams.get("status") || "open"

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connection_id or connectionId is required" }, { status: 400 })
    }

    const manager = new ExchangePositionManager(connectionId)

    // Get active positions with filters
    const filters: any = {}
    if (symbol) filters.symbol = symbol

    const positions = await manager.getActivePositions(filters)
    const filtered = status && status !== "all"
      ? positions.filter((pos: any) => String(pos.status || "") === status)
      : positions

    return NextResponse.json({
      success: true,
      connectionId,
      source: "exchange_position_manager",
      data: filtered,
      count: filtered.length,
      filters: { symbol, status },
    })
  } catch (error) {
    console.error("[v0] Get exchange positions error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { connectionId, action, ...params } = body

    if (!connectionId) {
      return NextResponse.json({ success: false, error: "connectionId is required" }, { status: 400 })
    }

    const manager = new ExchangePositionManager(connectionId)

    switch (action) {
      case "mirror": {
        // Mirror Real Pseudo Position to Active Exchange Position
        const positionId = await manager.mirrorToExchange(params)
        return NextResponse.json({
          success: true,
          data: { positionId },
          message: "Position mirrored to exchange successfully",
        })
      }

      case "update": {
        // Update position with current market data
        await manager.updatePosition(params.exchangeId, params.updates)
        return NextResponse.json({
          success: true,
          message: "Position updated successfully",
        })
      }

      case "close": {
        // Close position
        await manager.closePosition(params.exchangeId, params.closeParams)
        return NextResponse.json({
          success: true,
          message: "Position closed successfully",
        })
      }

      default:
        return NextResponse.json({ success: false, error: "Invalid action" }, { status: 400 })
    }
  } catch (error) {
    console.error("[v0] Exchange position action error:", error)
    return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 })
  }
}
