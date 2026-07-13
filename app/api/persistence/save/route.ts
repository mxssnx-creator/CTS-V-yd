/**
 * Force-save API — triggers an immediate Redis snapshot to disk.
 * Called by the client SessionSynchronizer on beforeunload, visibilitychange,
 * and periodically to ensure no more than 3 minutes of progress can be lost.
 */

import { NextResponse } from "next/server"
import { persistNow } from "@/lib/redis-db"

export const dynamic = "force-dynamic"
export const revalidate = 0

export async function POST() {
  try {
    const ok = await persistNow()
    return NextResponse.json({ ok, timestamp: Date.now() })
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "unknown" },
      { status: 500 }
    )
  }
}
