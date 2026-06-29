import { NextRequest, NextResponse } from "next/server"
import { getProgressManager } from "@/lib/engine-progress-manager"
import { IndicationEvaluator } from "@/lib/indication-evaluator"
import { StrategyEvaluator } from "@/lib/strategy-evaluator"
import { MetricsAggregator } from "@/lib/metrics-aggregator"
import { getEngineLogger } from "@/lib/engine-logger"

export const dynamic = "force-dynamic"
export const maxDuration = 60
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url)
    const connectionId = searchParams.get("connectionId")

    if (!connectionId) {
      return NextResponse.json(
        { error: "connectionId is required" },
        { status: 400 }
      )
    }

    const progressManager = getProgressManager(connectionId)
    const logger = getEngineLogger(connectionId)
    
    // Create evaluators (in real implementation, these would be shared instances)
    const indicationEvaluator = new IndicationEvaluator(connectionId)
    const strategyEvaluator = new StrategyEvaluator(connectionId)
    const metricsAggregator = new MetricsAggregator(connectionId, indicationEvaluator, strategyEvaluator, logger)

    const uiMetrics = await metricsAggregator.getUIMetrics()

    return NextResponse.json({ metrics: uiMetrics })
  } catch (error) {
    console.error("[EngineMetrics] Error:", error)
    return NextResponse.json(
      { error: "Failed to get engine metrics" },
      { status: 500 }
    )
  }
}
