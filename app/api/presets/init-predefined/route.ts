import { type NextRequest, NextResponse } from "next/server"
import { sql } from "@/lib/db"

const PREDEFINED_PRESETS = [
  {
    id: "preset-conservative",
    name: "Conservative Trading",
    description: "Low-risk preset with tight stop losses and moderate profit targets. Ideal for stable markets.",
    indication_types: ["direction", "move"],
    indication_ranges: [5, 8, 12, 15],
    takeprofit_steps: [2, 3, 4],
    stoploss_ratios: [0.4, 0.6, 0.8],
    trailing_enabled: true,
    trail_starts: [0.6, 1.0],
    trail_stops: [0.2, 0.3],
    strategy_types: ["base", "main"],
    last_positions_counts: [5, 6, 8],
    main_positions_count: [2, 3],
    block_adjustment_enabled: false,
    block_sizes: [2, 4],
    block_adjustment_ratios: [0.5, 1.0],
    dca_adjustment_enabled: false,
    dca_levels: [3],
    volume_factors: [0.1, 0.2, 0.5],
    min_profit_factor: 0.6,
    min_win_rate: 0.0,
    max_drawdown: 30.0,
    backtest_period_days: 14,
    backtest_enabled: true,
    is_active: true,
  },
  {
    id: "preset-balanced",
    name: "Balanced Strategy",
    description: "Balanced risk-reward preset with moderate parameters. Suitable for most market conditions.",
    indication_types: ["direction", "move", "active"],
    indication_ranges: [3, 5, 8, 12, 15, 20],
    takeprofit_steps: [2, 3, 4, 6],
    stoploss_ratios: [0.4, 0.6, 0.8, 1.0],
    trailing_enabled: true,
    trail_starts: [0.3, 0.6, 1.0],
    trail_stops: [0.1, 0.2, 0.3],
    strategy_types: ["base", "main", "real"],
    last_positions_counts: [3, 4, 5, 6, 8, 12],
    main_positions_count: [1, 2, 3, 4],
    block_adjustment_enabled: true,
    block_sizes: [2, 4, 6],
    block_adjustment_ratios: [0.5, 1.0, 1.5],
    dca_adjustment_enabled: false,
    dca_levels: [3, 5],
    volume_factors: [0.1, 0.2, 0.5],
    min_profit_factor: 0.5,
    min_win_rate: 0.0,
    max_drawdown: 40.0,
    backtest_period_days: 21,
    backtest_enabled: true,
    is_active: true,
  },
  {
    id: "preset-aggressive",
    name: "Aggressive Growth",
    description: "High-risk, high-reward preset with wider ranges and larger profit targets. For volatile markets.",
    indication_types: ["direction", "move", "active"],
    indication_ranges: [3, 5, 8, 12, 15, 20, 25, 30],
    takeprofit_steps: [3, 4, 6, 8, 12],
    stoploss_ratios: [0.6, 0.8, 1.0, 1.2, 1.5],
    trailing_enabled: true,
    trail_starts: [0.3, 0.6, 1.0],
    trail_stops: [0.1, 0.2, 0.3],
    strategy_types: ["base", "main", "real"],
    last_positions_counts: [3, 4, 5, 6, 8, 12, 25],
    main_positions_count: [1, 2, 3, 4, 5],
    block_adjustment_enabled: true,
    block_sizes: [2, 4, 6, 8],
    block_adjustment_ratios: [1.0, 1.5, 2.0],
    dca_adjustment_enabled: false,
    dca_levels: [3, 5, 7],
    volume_factors: [0.1, 0.2, 0.5],
    min_profit_factor: 0.4,
    min_win_rate: 0.0,
    max_drawdown: 50.0,
    backtest_period_days: 30,
    backtest_enabled: true,
    is_active: true,
  },
  {
    id: "preset-scalping",
    name: "Scalping Quick Wins",
    description: "Fast-paced preset for quick entries and exits. Optimized for high-frequency trading.",
    indication_types: ["direction", "move"],
    indication_ranges: [3, 5, 8],
    takeprofit_steps: [2, 3],
    stoploss_ratios: [0.2, 0.4, 0.6],
    trailing_enabled: true,
    trail_starts: [0.3, 0.6],
    trail_stops: [0.1, 0.2],
    strategy_types: ["base"],
    last_positions_counts: [3, 4, 5],
    main_positions_count: [1, 2],
    block_adjustment_enabled: false,
    block_sizes: [2],
    block_adjustment_ratios: [0.5],
    dca_adjustment_enabled: false,
    dca_levels: [3],
    volume_factors: [0.1, 0.2, 0.5],
    min_profit_factor: 0.5,
    min_win_rate: 0.0,
    max_drawdown: 25.0,
    backtest_period_days: 7,
    backtest_enabled: true,
    is_active: true,
  },
  {
    id: "preset-swing",
    name: "Swing Trading",
    description: "Medium-term preset for capturing larger price movements. Holds positions longer.",
    indication_types: ["direction", "active"],
    indication_ranges: [8, 12, 15, 20, 25],
    takeprofit_steps: [4, 6, 8, 12],
    stoploss_ratios: [0.8, 1.0, 1.2, 1.5],
    trailing_enabled: true,
    trail_starts: [0.6, 1.0],
    trail_stops: [0.2, 0.3],
    strategy_types: ["base", "real"],
    last_positions_counts: [6, 8, 12, 25],
    main_positions_count: [2, 3, 4],
    block_adjustment_enabled: true,
    block_sizes: [4, 6, 8],
    block_adjustment_ratios: [1.0, 1.5, 2.0],
    dca_adjustment_enabled: false,
    dca_levels: [5, 7],
    volume_factors: [0.1, 0.2, 0.5],
    min_profit_factor: 0.5,
    min_win_rate: 0.0,
    max_drawdown: 45.0,
    backtest_period_days: 30,
    backtest_enabled: true,
    is_active: true,
  },
]

export const dynamic = "force-dynamic"
export async function POST(request: NextRequest) {
  try {
    const results = []

    for (const preset of PREDEFINED_PRESETS) {
      try {
        // Check if preset already exists
        const existing = await sql`
          SELECT id FROM presets WHERE id = ${preset.id}
        `

        if (existing.length > 0) {
          console.log(`[v0] Preset ${preset.id} already exists, skipping...`)
          results.push({ id: preset.id, status: "exists" })
          continue
        }

        // Insert predefined preset
        await sql`
          INSERT INTO presets (
            id, name, description, indication_types, indication_ranges,
            takeprofit_steps, stoploss_ratios, trailing_enabled,
            trail_starts, trail_stops, strategy_types,
            last_positions_counts, main_positions_count,
            block_adjustment_enabled, block_sizes, block_adjustment_ratios,
            dca_adjustment_enabled, dca_levels, volume_factors,
            min_profit_factor, min_win_rate, max_drawdown,
            backtest_period_days, backtest_enabled, is_active,
            is_predefined, created_by
          )
          VALUES (
            ${preset.id}, ${preset.name}, ${preset.description},
            ${JSON.stringify(preset.indication_types)},
            ${JSON.stringify(preset.indication_ranges)},
            ${JSON.stringify(preset.takeprofit_steps)},
            ${JSON.stringify(preset.stoploss_ratios)},
            ${preset.trailing_enabled},
            ${JSON.stringify(preset.trail_starts)},
            ${JSON.stringify(preset.trail_stops)},
            ${JSON.stringify(preset.strategy_types)},
            ${JSON.stringify(preset.last_positions_counts)},
            ${JSON.stringify(preset.main_positions_count)},
            ${preset.block_adjustment_enabled},
            ${JSON.stringify(preset.block_sizes)},
            ${JSON.stringify(preset.block_adjustment_ratios)},
            ${preset.dca_adjustment_enabled},
            ${JSON.stringify(preset.dca_levels)},
            ${JSON.stringify(preset.volume_factors)},
            ${preset.min_profit_factor},
            ${preset.min_win_rate},
            ${preset.max_drawdown},
            ${preset.backtest_period_days},
            ${preset.backtest_enabled},
            ${preset.is_active},
            true,
            NULL
          )
        `

        console.log(`[v0] Created predefined preset: ${preset.name}`)
        results.push({ id: preset.id, status: "created", name: preset.name })
      } catch (error) {
        console.error(`[v0] Failed to create preset ${preset.id}:`, error)
        results.push({ id: preset.id, status: "error", error: error instanceof Error ? error.message : "Unknown" })
      }
    }

    return NextResponse.json({
      message: "Predefined presets initialization complete",
      results,
      total: PREDEFINED_PRESETS.length,
      created: results.filter((r) => r.status === "created").length,
      existing: results.filter((r) => r.status === "exists").length,
      errors: results.filter((r) => r.status === "error").length,
    })
  } catch (error) {
    console.error("[v0] Failed to initialize predefined presets:", error)
    return NextResponse.json(
      { error: "Failed to initialize predefined presets", details: error instanceof Error ? error.message : "Unknown" },
      { status: 500 },
    )
  }
}
