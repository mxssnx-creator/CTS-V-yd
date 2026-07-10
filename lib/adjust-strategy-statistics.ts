/**
 * Adjust Strategy Statistics & Optimization
 *
 * Purpose: Calculate and track statistics for Adjust Strategies (Block, DCA)
 * independently without affecting core position logic.
 *
 * Approach:
 * - Minimal calculations when no Adjust Type is active
 * - Full statistics only for enabled Adjust Strategies
 * - Independent evaluation for each Set configuration
 * - Volume calculations ONLY at Main level, not Base/Real
 */

import { getSettings, setSettings } from "@/lib/redis-db"
import { sql } from "@/lib/db"

export interface AdjustStrategyStatistics {
  strategy_type: "block" | "dca"
  period_hours: number
  total_positions: number
  successful_positions: number
  failed_positions: number
  win_rate: number
  avg_profit_factor: number
  avg_volume_adjustment: number
  total_adjusted_volume: number
  independent_sets_count: number
  configurations_active: number
  statistics_calculated_at: Date
}

export interface IndependentSetStatistics {
  set_id: string
  symbol: string
  configuration_hash: string
  tp_min: number
  tp_max: number
  sl_ratio: number
  trailing_enabled: boolean
  block_stats?: BlockSetStatistics
  dca_stats?: DCASetStatistics
  combined_performance?: number
}

export interface BlockSetStatistics {
  total_blocks_deployed: number
  block_sizes_used: number[]
  avg_block_effectiveness: number
  neutral_count: number
  increased_volume_wins: number
  standard_volume_wins: number
}

export interface DCASetStatistics {
  total_steps: number
  avg_step_position: number
  averaging_effectiveness: number
  step_win_rates: number[]
  entry_spacing_actual: number
}

export class AdjustStrategyStatisticsCalculator {
  private connectionId: string

  constructor(connectionId: string) {
    this.connectionId = connectionId
  }

  /**
   * Calculate statistics for Block strategy (optional, only when enabled)
   */
  async calculateBlockStatistics(
    periodHours = 24,
    calculateFullStats = false,
  ): Promise<AdjustStrategyStatistics | null> {
    try {
      if (!calculateFullStats) {
        // Minimal calculation mode - return null or basic counts only
        const count = await sql`
          SELECT COUNT(*) as total FROM pseudo_positions
          WHERE connection_id = ${this.connectionId}
            AND adjusted_strategy = 'block'
            AND created_at > NOW() - INTERVAL '${periodHours} hours'
        `
        return null // No overhead calculation
      }

      // Full statistics calculation mode
      const positions = await sql`
        SELECT 
          id, position_cost, pnl, pnl_percentage, 
          adjusted_volume, block_neutral_count, created_at
        FROM pseudo_positions
        WHERE connection_id = ${this.connectionId}
          AND adjusted_strategy = 'block'
          AND created_at > NOW() - INTERVAL '${periodHours} hours'
      `

      if (positions.length === 0) {
        return null
      }

      const successful = positions.filter((p: any) => p.pnl > 0).length
      const failed = positions.length - successful
      const winRate = successful / positions.length

      const totalAdjustedVolume = positions.reduce((sum: number, p: any) => sum + (p.adjusted_volume || 0), 0)
      const avgVolumeAdjustment = totalAdjustedVolume / positions.length

      const avgProfitFactor =
        positions.reduce((sum: number, p: any) => sum + (p.pnl_percentage || 0), 0) / positions.length

      return {
        strategy_type: "block",
        period_hours: periodHours,
        total_positions: positions.length,
        successful_positions: successful,
        failed_positions: failed,
        win_rate: winRate,
        avg_profit_factor: avgProfitFactor,
        avg_volume_adjustment: avgVolumeAdjustment,
        total_adjusted_volume: totalAdjustedVolume,
        independent_sets_count: new Set(positions.map((p: any) => p.configuration_hash)).size,
        configurations_active: 0,
        statistics_calculated_at: new Date(),
      }
    } catch (error) {
      console.error("[v0] Failed to calculate block statistics:", error)
      return null
    }
  }

  /**
   * Calculate statistics for DCA strategy (optional, only when enabled)
   */
  async calculateDCAStatistics(periodHours = 24, calculateFullStats = false): Promise<AdjustStrategyStatistics | null> {
    try {
      if (!calculateFullStats) {
        // Minimal calculation mode
        return null
      }

      // Full statistics calculation mode
      const positions = await sql`
        SELECT 
          id, position_cost, pnl, pnl_percentage,
          dca_step, dca_total_steps, created_at
        FROM pseudo_positions
        WHERE connection_id = ${this.connectionId}
          AND adjusted_strategy = 'dca'
          AND created_at > NOW() - INTERVAL '${periodHours} hours'
      `

      if (positions.length === 0) {
        return null
      }

      const successful = positions.filter((p: any) => p.pnl > 0).length
      const failed = positions.length - successful
      const winRate = successful / positions.length

      const avgProfitFactor =
        positions.reduce((sum: number, p: any) => sum + (p.pnl_percentage || 0), 0) / positions.length

      return {
        strategy_type: "dca",
        period_hours: periodHours,
        total_positions: positions.length,
        successful_positions: successful,
        failed_positions: failed,
        win_rate: winRate,
        avg_profit_factor: avgProfitFactor,
        avg_volume_adjustment: 1.0, // DCA doesn't adjust volume, just positioning
        total_adjusted_volume: 0,
        independent_sets_count: new Set(positions.map((p: any) => p.configuration_hash)).size,
        configurations_active: 0,
        statistics_calculated_at: new Date(),
      }
    } catch (error) {
      console.error("[v0] Failed to calculate DCA statistics:", error)
      return null
    }
  }

  /**
   * Get independent Set statistics for a specific configuration
   */
  async getIndependentSetStatistics(
    setId: string,
    calculateFullStats = false,
  ): Promise<IndependentSetStatistics | null> {
    try {
      if (!calculateFullStats) {
        // Minimal mode - no calculations
        return null
      }

      // Fetch the set configuration
      const setConfig = await sql`
        SELECT id, symbol, configuration_hash, tp_min, tp_max, sl_ratio, trailing_enabled
        FROM configuration_sets
        WHERE id = ${setId} AND connection_id = ${this.connectionId}
      `

      if (!setConfig || setConfig.length === 0) {
        return null
      }

      const config = setConfig[0]

      // Get Block statistics for this set (if Block is enabled)
      const blockStats = await this.getBlockSetStatistics(setId)

      // Get DCA statistics for this set (if DCA is enabled)
      const dcaStats = await this.getDCASetStatistics(setId)

      // Calculate combined performance score
      const combinedPerformance = this.calculateCombinedPerformance(blockStats, dcaStats)

      return {
        set_id: setId,
        symbol: config.symbol,
        configuration_hash: config.configuration_hash,
        tp_min: config.tp_min,
        tp_max: config.tp_max,
        sl_ratio: config.sl_ratio,
        trailing_enabled: config.trailing_enabled,
        block_stats: blockStats || undefined,
        dca_stats: dcaStats || undefined,
        combined_performance: combinedPerformance,
      }
    } catch (error) {
      console.error("[v0] Failed to get independent set statistics:", error)
      return null
    }
  }

  /**
   * Calculate Block strategy statistics for a specific set
   */
  private async getBlockSetStatistics(setId: string): Promise<BlockSetStatistics | null> {
    try {
      const positions = await sql`
        SELECT 
          id, block_neutral_count, adjusted_volume, pnl,
          (adjusted_volume > position_cost * 1.5) as increased_volume
        FROM pseudo_positions
        WHERE configuration_set_id = ${setId}
          AND adjusted_strategy = 'block'
          AND created_at > NOW() - INTERVAL '24 hours'
      `

      if (positions.length === 0) {
        return null
      }

      const increasedVolumeWins = positions.filter((p: any) => p.increased_volume && p.pnl > 0).length
      const standardVolumeWins = positions.filter((p: any) => !p.increased_volume && p.pnl > 0).length

      const avgNeutralCount =
        positions.reduce((sum: number, p: any) => sum + (p.block_neutral_count || 0), 0) / positions.length
      const avgBlockEffectiveness = (increasedVolumeWins + standardVolumeWins) / positions.length

      return {
        total_blocks_deployed: positions.length,
        block_sizes_used: Array.from(new Set(positions.map((p: any) => p.block_neutral_count || 0))),
        avg_block_effectiveness: avgBlockEffectiveness,
        neutral_count: Math.floor(avgNeutralCount),
        increased_volume_wins: increasedVolumeWins,
        standard_volume_wins: standardVolumeWins,
      }
    } catch (error) {
      console.error("[v0] Failed to get block set statistics:", error)
      return null
    }
  }

  /**
   * Calculate DCA strategy statistics for a specific set
   */
  private async getDCASetStatistics(setId: string): Promise<DCASetStatistics | null> {
    try {
      const positions = await sql`
        SELECT 
          id, dca_step, dca_total_steps, pnl, position_cost,
          entry_price
        FROM pseudo_positions
        WHERE configuration_set_id = ${setId}
          AND adjusted_strategy = 'dca'
          AND created_at > NOW() - INTERVAL '24 hours'
        ORDER BY dca_step ASC
      `

      if (positions.length === 0) {
        return null
      }

      const stepWinRates: number[] = []
      const stepPositions = positions.reduce(
        (acc: any, p: any) => {
          if (!acc[p.dca_step]) {
            acc[p.dca_step] = []
          }
          acc[p.dca_step].push(p)
          return acc
        },
        {} as Record<number, any[]>,
      )

      for (const step in stepPositions) {
        const stepPosArray = stepPositions[step]
        const stepWins = stepPosArray.filter((p: any) => p.pnl > 0).length
        stepWinRates.push(stepWins / stepPosArray.length)
      }

      const avgStepPosition = positions.reduce((sum: number, p: any) => sum + (p.dca_step || 1), 0) / positions.length

      const avgAveragingEffectiveness = stepWinRates.length > 0 ? stepWinRates.reduce((a, b) => a + b, 0) / stepWinRates.length : 0

      return {
        total_steps: Math.max(...positions.map((p: any) => p.dca_total_steps || 4)),
        avg_step_position: avgStepPosition,
        averaging_effectiveness: avgAveragingEffectiveness,
        step_win_rates: stepWinRates,
        entry_spacing_actual: 2.0, // Placeholder - should calculate from actual entries
      }
    } catch (error) {
      console.error("[v0] Failed to get DCA set statistics:", error)
      return null
    }
  }

  /**
   * Calculate combined performance score (simple average for now)
   */
  private calculateCombinedPerformance(
    blockStats: BlockSetStatistics | null,
    dcaStats: DCASetStatistics | null,
  ): number {
    const scores: number[] = []

    if (blockStats) {
      scores.push(blockStats.avg_block_effectiveness)
    }

    if (dcaStats) {
      scores.push(dcaStats.averaging_effectiveness)
    }

    if (scores.length === 0) {
      return 0
    }

    return scores.reduce((a, b) => a + b, 0) / scores.length
  }

  /**
   * Store statistics for dashboard/reporting (optional)
   */
  async storeStatisticsSnapshot(statistics: AdjustStrategyStatistics): Promise<void> {
    try {
      await sql`
        INSERT INTO adjust_strategy_statistics (
          connection_id, strategy_type, period_hours, 
          total_positions, successful_positions, failed_positions,
          win_rate, avg_profit_factor, independent_sets_count,
          calculated_at
        )
        VALUES (
          ${this.connectionId},
          ${statistics.strategy_type},
          ${statistics.period_hours},
          ${statistics.total_positions},
          ${statistics.successful_positions},
          ${statistics.failed_positions},
          ${statistics.win_rate},
          ${statistics.avg_profit_factor},
          ${statistics.independent_sets_count},
          NOW()
        )
      `
    } catch (error) {
      console.error("[v0] Failed to store statistics snapshot:", error)
    }
  }
}
