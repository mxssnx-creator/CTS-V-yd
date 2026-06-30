import { NextResponse } from "next/server"
import { initializeTradeEngineAutoStart, isAutoStartInitialized, runTradeEngineHealingSweep } from "@/lib/trade-engine-auto-start"
import { SystemLogger } from "@/lib/system-logger"

export const dynamic = "force-dynamic"
export async function POST() {
  try {
    console.log("[v0] Manual trade engine auto-start triggered")

    if (isAutoStartInitialized()) {
      const healing = await runTradeEngineHealingSweep({ isStartup: true })
      return NextResponse.json({
        success: true,
        message: "Trade engine auto-start is already initialized and running",
        alreadyRunning: true,
        healing,
      })
    }

    await initializeTradeEngineAutoStart()
    const healing = await runTradeEngineHealingSweep({ isStartup: true })

    await SystemLogger.logTradeEngine("Trade engine auto-start manually triggered", "info")

    return NextResponse.json({
      success: true,
      message: "Trade engine auto-start initialized successfully",
      healing,
      startupSweepCompleted: true,
    })
  } catch (error) {
    console.error("[v0] Failed to manually start trade engine auto-start:", error)
    await SystemLogger.logError(error, "trade-engine", "POST /api/trade-engine/auto-start")

    return NextResponse.json(
      {
        success: false,
        error: "Failed to initialize trade engine auto-start",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    )
  }
}

export async function GET() {
  return NextResponse.json({
    initialized: isAutoStartInitialized(),
    message: isAutoStartInitialized()
      ? "Trade engine auto-start is active"
      : "Trade engine auto-start is not initialized",
  })
}
