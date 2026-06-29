import { NextRequest, NextResponse } from "next/server"
import { getEngineLogger } from "@/lib/engine-logger"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")
    const level = searchParams.get("level")
    const category = searchParams.get("category")
    const symbol = searchParams.get("symbol")
    const limit = parseInt(searchParams.get("limit") || "100", 10)

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId is required" },
        { status: 400 }
      )
    }

    const logger = getEngineLogger(connectionId)
    const logs = logger.getLogs({
      connectionId,
      level: level || undefined,
      category: category || undefined,
      symbol: symbol || undefined,
      limit,
    })

    const summary = logger.getSummary()

    return NextResponse.json({
      logs,
      summary,
      total: logs.length,
    })
  } catch (error) {
    console.error("[EngineLogs] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine logs" },
      { status: 500 }
    )
  }
}
