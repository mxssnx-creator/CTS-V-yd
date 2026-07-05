import type { TradingPosition } from "./trading"
import { resolvePositionCostNotional } from "./tp-sl-ratio"

export interface AnalyticsFilter {
  symbols: string[]
  timeRange: {
    start: Date
    end: Date
  }
  indicationTypes: string[]
  strategyTypes: string[]
  trailingEnabled?: boolean
  minProfitFactor?: number
  maxDrawdown?: number
}

export interface StrategyAnalytics {
  strategy_name: string
  strategy_type: string
  total_trades: number
  profit_factor: number
  profit_factor_last_50: number
  trades_per_day: number
  drawdown_time: number
  takeprofit_factor: number
  tp_sl_ratio: number
  average_hold_time: number
  trailing_info: {
    enabled: boolean
    trail_start?: number
    trail_stop?: number
  }
  volume_factor: number
  win_rate: number
  total_pnl: number
  largest_win: number
  largest_loss: number
  sharpe_ratio: number
  max_consecutive_losses: number
  recovery_factor: number
  avg_base_volume?: number
  avg_adjusted_volume?: number
  total_volume_traded?: number
}

export interface SymbolAnalytics {
  symbol: string
  total_trades: number
  win_rate: number
  total_pnl: number
  avg_profit_per_trade: number
  best_strategy: string
  worst_strategy: string
  volatility: number
  correlation_with_btc: number
}

export interface TimeSeriesData {
  timestamp: Date
  balance: number
  equity: number
  margin: number
  open_positions: number
  daily_pnl: number
  cumulative_pnl: number
}

export class AnalyticsEngine {
  private positions: TradingPosition[] = []

  constructor(positions: TradingPosition[]) {
    this.positions = positions
  }

  // Filter positions based on criteria
  filterPositions(filter: AnalyticsFilter): TradingPosition[] {
    return this.positions.filter((position) => {
      // Symbol filter
      if (filter.symbols.length > 0 && !filter.symbols.includes(position.symbol)) {
        return false
      }

      // Time range filter
      const positionDate = new Date(position.opened_at)
      if (positionDate < filter.timeRange.start || positionDate > filter.timeRange.end) {
        return false
      }

      // Indication type filter
      if (filter.indicationTypes.length > 0 && !filter.indicationTypes.includes(position.indication_type || "")) {
        return false
      }

      // Strategy type filter
      if (filter.strategyTypes.length > 0) {
        const matchesStrategy = filter.strategyTypes.some((type) => position.strategy_type.includes(type))
        if (!matchesStrategy) return false
      }

      // Trailing filter
      if (filter.trailingEnabled !== undefined) {
        // This would need to be stored in position data
        // For now, we'll simulate based on strategy name
        const hasTrailing = position.strategy_type.toLowerCase().includes("trail")
        if (filter.trailingEnabled !== hasTrailing) return false
      }

      return true
    })
  }

  // Generate strategy analytics
  generateStrategyAnalytics(filter: AnalyticsFilter): StrategyAnalytics[] {
    const filteredPositions = this.filterPositions(filter)
    const strategiesMap = new Map<string, TradingPosition[]>()

    // Group positions by strategy
    filteredPositions.forEach((position) => {
      const key = position.strategy_type
      if (!strategiesMap.has(key)) {
        strategiesMap.set(key, [])
      }
      strategiesMap.get(key)!.push(position)
    })

    const analytics: StrategyAnalytics[] = []

    strategiesMap.forEach((positions, strategyName) => {
      const closedPositions = positions.filter((p) => p.status === "closed")
      const winningPositions = closedPositions.filter((p) => p.profit_loss > 0)

      const totalPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)
      const totalVolume = closedPositions.reduce((sum, p) => sum + p.volume, 0)
      const profitFactor = this.calculateProfitFactor(closedPositions)

      // Calculate time-based metrics
      const timeRange = this.getTimeRange(closedPositions)
      const tradesPerDay = timeRange > 0 ? closedPositions.length / timeRange : 0

      // Calculate drawdown
      const drawdownTime = this.calculateDrawdownTime(closedPositions)

      // Calculate hold time
      const avgHoldTime = this.calculateAverageHoldTime(closedPositions)

      // Get last 50 positions for recent performance
      const last50 = closedPositions.slice(-50)
      const profitFactorLast50 = this.calculateProfitFactor(last50)

      const positionsWithVolumeFactor = positions.filter((p) => p.volume_factor !== undefined)
      const avgVolumeFactor =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.volume_factor || 1), 0) /
            positionsWithVolumeFactor.length
          : 1

      const avgBaseVolume =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.base_volume || 0), 0) /
            positionsWithVolumeFactor.length
          : undefined

      const avgAdjustedVolume =
        positionsWithVolumeFactor.length > 0
          ? positionsWithVolumeFactor.reduce((sum, p) => sum + (p.adjusted_volume || 0), 0) /
            positionsWithVolumeFactor.length
          : undefined

      analytics.push({
        strategy_name: strategyName,
        strategy_type: this.getStrategyType(strategyName),
        total_trades: closedPositions.length,
        profit_factor: profitFactor,
        profit_factor_last_50: profitFactorLast50,
        trades_per_day: tradesPerDay,
        drawdown_time: drawdownTime,
        takeprofit_factor: this.extractTakeProfitFactor(positions),
        tp_sl_ratio: this.calculateTPSLRatio(positions),
        average_hold_time: avgHoldTime,
        trailing_info: {
          enabled: strategyName.toLowerCase().includes("trail"),
          trail_start: 0.6, // Mock data
          trail_stop: 0.2, // Mock data
        },
        volume_factor: avgVolumeFactor,
        win_rate: closedPositions.length > 0 ? winningPositions.length / closedPositions.length : 0,
        total_pnl: totalPnl,
        largest_win: Math.max(...closedPositions.map((p) => p.profit_loss), 0),
        largest_loss: Math.min(...closedPositions.map((p) => p.profit_loss), 0),
        sharpe_ratio: this.calculateSharpeRatio(closedPositions),
        max_consecutive_losses: this.calculateMaxConsecutiveLosses(closedPositions),
        recovery_factor: totalPnl / Math.abs(Math.min(...closedPositions.map((p) => p.profit_loss), -1)),
        avg_base_volume: avgBaseVolume,
        avg_adjusted_volume: avgAdjustedVolume,
        total_volume_traded: totalVolume,
      })
    })

    return analytics.sort((a, b) => b.profit_factor - a.profit_factor)
  }

  // Generate symbol analytics
  generateSymbolAnalytics(filter: AnalyticsFilter): SymbolAnalytics[] {
    const filteredPositions = this.filterPositions(filter)
    const symbolsMap = new Map<string, TradingPosition[]>()

    filteredPositions.forEach((position) => {
      if (!symbolsMap.has(position.symbol)) {
        symbolsMap.set(position.symbol, [])
      }
      symbolsMap.get(position.symbol)!.push(position)
    })

    const analytics: SymbolAnalytics[] = []

    symbolsMap.forEach((positions, symbol) => {
      const closedPositions = positions.filter((p) => p.status === "closed")
      const winningPositions = closedPositions.filter((p) => p.profit_loss > 0)
      const totalPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)

      // Find best and worst performing strategies for this symbol
      const strategyPerformance = this.getStrategyPerformanceBySymbol(positions)

      analytics.push({
        symbol,
        total_trades: closedPositions.length,
        win_rate: closedPositions.length > 0 ? winningPositions.length / closedPositions.length : 0,
        total_pnl: totalPnl,
        avg_profit_per_trade: closedPositions.length > 0 ? totalPnl / closedPositions.length : 0,
        best_strategy: strategyPerformance.best,
        worst_strategy: strategyPerformance.worst,
        volatility: this.calculateVolatility(positions),
        correlation_with_btc: symbol === "BTCUSDT" ? 1 : Math.random() * 0.8 + 0.1, // Mock correlation
      })
    })

    return analytics.sort((a, b) => b.total_pnl - a.total_pnl)
  }

  // Generate time series data for charts
  generateTimeSeriesData(filter: AnalyticsFilter): TimeSeriesData[] {
    const filteredPositions = this.filterPositions(filter).sort(
      (a, b) => new Date(a.opened_at).getTime() - new Date(b.opened_at).getTime(),
    )

    const timeSeriesData: TimeSeriesData[] = []
    let cumulativePnl = 0
    let balance = 10000 // Starting balance

    // Group positions by day
    const dailyGroups = new Map<string, TradingPosition[]>()
    filteredPositions.forEach((position) => {
      const date = new Date(position.opened_at).toDateString()
      if (!dailyGroups.has(date)) {
        dailyGroups.set(date, [])
      }
      dailyGroups.get(date)!.push(position)
    })

    dailyGroups.forEach((positions, dateString) => {
      const date = new Date(dateString)
      const closedPositions = positions.filter((p) => p.status === "closed")
      const dailyPnl = closedPositions.reduce((sum, p) => sum + p.profit_loss, 0)

      cumulativePnl += dailyPnl
      balance += dailyPnl

      const openPositions = positions.filter((p) => p.status === "open").length
      const marginUsed = positions.reduce((sum, p) => sum + (p.margin_used || 0), 0)

      timeSeriesData.push({
        timestamp: date,
        balance: balance,
        equity: balance + positions.reduce((sum, p) => sum + (p.unrealized_pnl || 0), 0),
        margin: marginUsed,
        open_positions: openPositions,
        daily_pnl: dailyPnl,
        cumulative_pnl: cumulativePnl,
      })
    })

    return timeSeriesData
  }

  // Helper methods
  private calculateProfitFactor(positions: TradingPosition[]): number {
    const grossProfit = positions.filter((p) => p.profit_loss > 0).reduce((sum, p) => sum + p.profit_loss, 0)
    const grossLoss = Math.abs(positions.filter((p) => p.profit_loss < 0).reduce((sum, p) => sum + p.profit_loss, 0))
    
    // Cost-adjusted PF: totalWinPnL / (totalLossPnL + totalPositionCosts).
    // Prefer entry_price × quantity when present; fall back to the stored
    // notional volume. `stoploss_ratio` is TP-relative elsewhere and is not a
    // quantity proxy.
    const totalPositionCosts = positions.reduce((sum, p) => sum + resolvePositionCostNotional(p) * 0.001, 0)
    
    // Cap PF at 99 when den == 0 so "all wins" doesn't poison min-blend math.
    const adjustedDenominator = grossLoss + totalPositionCosts
    return adjustedDenominator > 0 ? grossProfit / adjustedDenominator : grossProfit > 0 ? 99 : 0
  }

  private calculateDrawdownTime(positions: TradingPosition[]): number {
    // Simplified drawdown calculation in hours
    let maxEquity = 0
    let drawdownHours = 0
    let inDrawdown = false
    let drawdownStart: Date | null = null

    positions.forEach((position) => {
      const equity = position.profit_loss
      if (equity > maxEquity) {
        maxEquity = equity
        if (inDrawdown && drawdownStart) {
          drawdownHours += (new Date(position.opened_at).getTime() - drawdownStart.getTime()) / (1000 * 60 * 60)
          inDrawdown = false
          drawdownStart = null
        }
      } else if (equity < maxEquity && !inDrawdown) {
        inDrawdown = true
        drawdownStart = new Date(position.opened_at)
      }
    })

    return drawdownHours
  }

  private calculateAverageHoldTime(positions: TradingPosition[]): number {
    const closedPositions = positions.filter((p) => p.status === "closed" && p.closed_at)
    if (closedPositions.length === 0) return 0

    const totalHoldTime = closedPositions.reduce((sum, p) => {
      const openTime = new Date(p.opened_at).getTime()
      const closeTime = new Date(p.closed_at!).getTime()
      return sum + (closeTime - openTime) / (1000 * 60) // Convert to minutes
    }, 0)

    return totalHoldTime / closedPositions.length
  }

  private getTimeRange(positions: TradingPosition[]): number {
    if (positions.length < 2) return 0
    const earliest = Math.min(...positions.map((p) => new Date(p.opened_at).getTime()))
    const latest = Math.max(...positions.map((p) => new Date(p.opened_at).getTime()))
    return (latest - earliest) / (1000 * 60 * 60 * 24) // Days
  }

  private getStrategyType(strategyName: string): string {
    if (strategyName.includes("Base")) return "Base"
    if (strategyName.includes("Partial") || strategyName.includes("Main")) return "Main"
    if (strategyName.includes("Count") || strategyName.includes("Real")) return "Real"
    if (strategyName.includes("Block")) return "Block"
    if (strategyName.includes("DCA")) return "DCA"
    return "Other"
  }

  private extractTakeProfitFactor(positions: TradingPosition[]): number {
    if (positions.length === 0) return 1.05 // Default 5% TP
    
    // Extract from takeprofit field or estimate from strategy
    const avgTP = positions.reduce((sum, p) => {
      if (p.takeprofit && p.entry_price) {
        return sum + p.takeprofit / p.entry_price
      }
      return sum + 1.05 // Default 5% TP
    }, 0)
    return avgTP / positions.length
  }

  private calculateTPSLRatio(positions: TradingPosition[]): number {
    if (positions.length === 0) return 2 // Default 2:1 ratio
    
    const avgRatio = positions.reduce((sum, p) => {
      if (p.takeprofit && p.stoploss && p.entry_price) {
        const tpDistance = Math.abs(p.takeprofit - p.entry_price)
        const slDistance = Math.abs(p.entry_price - p.stoploss)
        return sum + (slDistance > 0 ? tpDistance / slDistance : 2)
      }
      return sum + 2 // Default 2:1 ratio
    }, 0)
    return avgRatio / positions.length
  }

  private calculateSharpeRatio(positions: TradingPosition[]): number {
    if (positions.length < 2) return 0

    const returns = positions.map((p) => p.profit_loss)
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    const stdDev = Math.sqrt(variance)

    return stdDev > 0 ? avgReturn / stdDev : 0
  }

  private calculateMaxConsecutiveLosses(positions: TradingPosition[]): number {
    let maxConsecutive = 0
    let currentConsecutive = 0

    positions.forEach((position) => {
      if (position.profit_loss < 0) {
        currentConsecutive++
        maxConsecutive = Math.max(maxConsecutive, currentConsecutive)
      } else {
        currentConsecutive = 0
      }
    })

    return maxConsecutive
  }

  private calculateVolatility(positions: TradingPosition[]): number {
    const returns = positions.map((p) => (p.current_price - p.entry_price) / p.entry_price)
    const avgReturn = returns.reduce((sum, r) => sum + r, 0) / returns.length
    const variance = returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
    return Math.sqrt(variance)
  }

  private getStrategyPerformanceBySymbol(positions: TradingPosition[]): { best: string; worst: string } {
    const strategyPnl = new Map<string, number>()

    positions.forEach((position) => {
      const current = strategyPnl.get(position.strategy_type) || 0
      strategyPnl.set(position.strategy_type, current + position.profit_loss)
    })

    const sorted = Array.from(strategyPnl.entries()).sort((a, b) => b[1] - a[1])
    return {
      best: sorted[0]?.[0] || "N/A",
      worst: sorted[sorted.length - 1]?.[0] || "N/A",
    }
  }
}
