import { NextResponse } from "next/server"
import { GET as getSystemStatsV3 } from "../system-stats-v3/route"

export const dynamic = "force-dynamic"
export const revalidate = 0
export const fetchCache = "force-no-store"
export const maxDuration = 30

/**
 * v2 compatibility route.
 *
 * Keep a single source of truth for system stats processing by
 * delegating to the v3 implementation. This avoids divergent logic
 * across versions and preserves workflow/logistics integrity.
 */
export async function GET() {
  try {
    return await getSystemStatsV3()
  } catch (error) {
    console.error("[v0] [system-stats-v2] error:", error)
    return NextResponse.json(
      { error: "Failed to fetch system stats", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
