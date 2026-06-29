/**
 * Production Cron Scheduler for Indication Generation
 * 
 * This endpoint can be called every 1-3 seconds by an external scheduler
 * (Vercel Crons, AWS EventBridge, etc.) to keep the trade engine constantly
 * fed with new indications.
 * 
 * Without this, indications only generate when a browser is open.
 */

import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export const revalidate = 0
export const fetchCache = "force-no-store"

export async function GET(request: Request) {
  try {
    const baseUrl = process.env.NEXTAUTH_URL || 
                   process.env.NEXT_PUBLIC_APP_URL || 
                   `http://localhost:${process.env.PORT || "3000"}`

    // Call the internal cron endpoint
    const response = await fetch(
      `${baseUrl}/api/cron/generate-indications`,
      {
        method: "GET",
        cache: "no-store",
        headers: {
          "x-cron-source": "schedule-indications",
          "x-timestamp": Date.now().toString(),
        },
      }
    )

    const data = await response.json()

    return NextResponse.json(
      {
        success: response.ok,
        message: "Cron executed",
        data,
      },
      { status: response.ok ? 200 : 500 }
    )
  } catch (error) {
    console.error("[Cron] schedule-indications error:", error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  // Support POST for task scheduler compatibility
  return GET(request)
}
