import { type NextRequest, NextResponse } from "next/server"
import { getConnectionCounts } from "@/lib/connection-count-service"

/**
 * GET /api/connections/counts
 * Returns accurate connection counts for base and main panels
 * PHASE 2 FIX: Single source of truth for connection counts
 */
export const dynamic = "force-dynamic"
export const maxDuration = 30
export async function GET(request: NextRequest) {
  try {
    const counts = await getConnectionCounts()
    return NextResponse.json(counts)
  } catch (error) {
    console.error("[v0] [API] Error in /api/connections/counts:", error)
    return NextResponse.json(
      {
        error: "Failed to get connection counts",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}
