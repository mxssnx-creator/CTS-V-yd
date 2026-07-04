import { type NextRequest, NextResponse } from "next/server"
import { initRedis, getRedisClient } from "@/lib/redis-db"
import { fetchTopSymbols } from "@/lib/top-symbols"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const exchange = searchParams.get("exchange")?.toLowerCase()

    if (!exchange) {
      return NextResponse.json({
        error: "exchange parameter required (bingx, binance, etc.)",
        symbols: []
      }, { status: 400 })
    }

    await initRedis()

    // Get symbols from cache or fetch fresh
    const symbols = await fetchTopSymbols(exchange, 1000)

    return NextResponse.json({
      exchange,
      symbols: symbols.symbols || [],
      count: (symbols.symbols || []).length,
      timestamp: new Date().toISOString(),
    })
  } catch (error) {
    console.error("[v0] [API] GET /api/symbols error:", error)
    return NextResponse.json({
      error: "Failed to fetch symbols",
      details: error instanceof Error ? error.message : "Unknown error",
      symbols: []
    }, { status: 500 })
  }
}
