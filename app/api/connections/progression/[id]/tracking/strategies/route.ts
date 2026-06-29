import { NextResponse } from "next/server"
import { getStrategyTracking } from "@/lib/detailed-tracking"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const tracking = await getStrategyTracking(id)
    return NextResponse.json(tracking)
  } catch (error) {
    console.error("[v0] [tracking/strategies] error:", error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to load strategies tracking" },
      { status: 500 },
    )
  }
}
