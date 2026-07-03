"use client"

import { useEffect, useState } from "react"
import useSWR from "swr"

interface PositionPnL {
  id: string
  symbol: string
  direction: string
  entry_price: number
  exit_price: number
  quantity: number
  opened_at: string
  closed_at: string
  pnl: number
  pnl_percent: number
  holding_time_min: number
}

interface PnLStats {
  total_positions: number
  closed_positions: number
  open_positions: number
  total_pnl: number
  total_pnl_percent: number
  wins: number
  losses: number
  break_even: number
  win_rate: number
  avg_win: number
  avg_loss: number
  largest_win: number
  largest_loss: number
  profit_factor: number
  expectancy: number
  avg_holding_time_min: number
  last_25_positions: PositionPnL[]
  last_25_pnl: number
  last_25_win_rate: number
}

interface ApiResponse {
  success: boolean
  stats: PnLStats
  duration: number
}

const fetcher = (url: string) => fetch(url).then((res) => res.json())

export function PnLDashboard({ connectionId = "bingx-x01" }: { connectionId?: string }) {
  const { data, error, isLoading } = useSWR<ApiResponse>(
    `/api/trade-engine/pnl-stats?connection_id=${connectionId}`,
    fetcher,
    { refreshInterval: 5000 } // Refresh every 5 seconds
  )

  const stats = data?.stats

  if (isLoading) {
    return (
      <div className="w-full rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-muted-foreground">Loading PnL statistics...</p>
      </div>
    )
  }

  if (error || !stats) {
    return (
      <div className="w-full rounded-lg border border-border bg-card p-6 text-center">
        <p className="text-destructive">Failed to load PnL data</p>
      </div>
    )
  }

  const formatCurrency = (value: number) => {
    const sign = value >= 0 ? "+" : "-"
    const abs = Math.abs(value)
    if (abs >= 1) return `${sign}$${abs.toFixed(2)}`
    return `${sign}$${abs.toFixed(8)}`
  }

  const formatPercent = (value: number) => `${value >= 0 ? "+" : ""}${value.toFixed(2)}%`

  const formatTime = (minutes: number) => {
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const mins = minutes % 60
    return `${hours}h ${mins}m`
  }

  return (
    <div className="w-full space-y-6">
      {/* Main Stats Grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {/* Total PnL */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Total PnL</p>
          <p className={`text-2xl font-bold ${stats.total_pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatCurrency(stats.total_pnl)}
          </p>
          <p className={`text-xs ${stats.total_pnl_percent >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatPercent(stats.total_pnl_percent)}
          </p>
        </div>

        {/* Win Rate */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Win Rate</p>
          <p className="text-2xl font-bold text-blue-600">{stats.win_rate.toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground">
            {stats.wins}W / {stats.losses}L / {stats.break_even}BE
          </p>
        </div>

        {/* Profit Factor */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Profit Factor</p>
          <p className={`text-2xl font-bold ${stats.profit_factor >= 1.2 ? "text-green-600" : stats.profit_factor >= 1 ? "text-blue-600" : "text-red-600"}`}>
            {stats.profit_factor.toFixed(2)}
          </p>
          <p className="text-xs text-muted-foreground">Avg Win: {formatCurrency(stats.avg_win)}</p>
        </div>

        {/* Expectancy */}
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Expectancy / Trade</p>
          <p className={`text-2xl font-bold ${stats.expectancy >= 0 ? "text-green-600" : "text-red-600"}`}>
            {formatCurrency(stats.expectancy)}
          </p>
          <p className="text-xs text-muted-foreground">Avg Loss: {formatCurrency(-stats.avg_loss)}</p>
        </div>
      </div>

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Positions</p>
          <p className="text-2xl font-bold">{stats.closed_positions}</p>
          <p className="text-xs text-muted-foreground">{stats.open_positions} open</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Best / Worst Trade</p>
          <div className="flex justify-between">
            <p className="text-lg font-semibold text-green-600">{formatCurrency(stats.largest_win)}</p>
            <p className="text-lg font-semibold text-red-600">{formatCurrency(stats.largest_loss)}</p>
          </div>
          <p className="text-xs text-muted-foreground">Range: {isFinite(stats.largest_win) && isFinite(stats.largest_loss) ? Math.abs(stats.largest_win - stats.largest_loss).toFixed(8) : "N/A"}</p>
        </div>

        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-sm font-medium text-muted-foreground">Avg Holding Time</p>
          <p className="text-2xl font-bold">{formatTime(stats.avg_holding_time_min)}</p>
          <p className="text-xs text-muted-foreground">Per trade</p>
        </div>
      </div>

      {/* Last 25 Positions Section */}
      <div className="space-y-3">
        <div className="flex items-baseline justify-between">
          <h3 className="text-lg font-semibold">Last 25 Positions</h3>
          <div className="text-sm font-medium">
            <span className={stats.last_25_pnl >= 0 ? "text-green-600" : "text-red-600"}>
              {formatCurrency(stats.last_25_pnl)}
            </span>
            <span className="mx-2 text-muted-foreground">•</span>
            <span className="text-blue-600">{stats.last_25_win_rate.toFixed(1)}% WR</span>
          </div>
        </div>

        <div className="max-h-96 overflow-y-auto rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0 border-b border-border bg-muted">
              <tr>
                <th className="px-3 py-2 text-left font-semibold">Symbol</th>
                <th className="px-3 py-2 text-left font-semibold">Dir</th>
                <th className="px-3 py-2 text-right font-semibold">Entry</th>
                <th className="px-3 py-2 text-right font-semibold">Exit</th>
                <th className="px-3 py-2 text-right font-semibold">PnL</th>
                <th className="px-3 py-2 text-right font-semibold">%</th>
                <th className="px-3 py-2 text-right font-semibold">Time</th>
              </tr>
            </thead>
            <tbody>
              {stats.last_25_positions.map((pos, idx) => (
                <tr key={pos.id} className={idx % 2 === 0 ? "bg-card" : "bg-muted/30"}>
                  <td className="px-3 py-2 font-medium">{pos.symbol}</td>
                  <td className={`px-3 py-2 font-semibold ${pos.direction === "long" ? "text-blue-600" : "text-red-600"}`}>
                    {pos.direction === "long" ? "L" : "S"}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground">${pos.entry_price.toFixed(8)}</td>
                  <td className="px-3 py-2 text-right text-muted-foreground">${pos.exit_price.toFixed(8)}</td>
                  <td className={`px-3 py-2 text-right font-semibold ${pos.pnl >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatCurrency(pos.pnl)}
                  </td>
                  <td className={`px-3 py-2 text-right font-semibold ${pos.pnl_percent >= 0 ? "text-green-600" : "text-red-600"}`}>
                    {formatPercent(pos.pnl_percent)}
                  </td>
                  <td className="px-3 py-2 text-right text-muted-foreground text-xs">
                    {formatTime(pos.holding_time_min)}
                  </td>
                </tr>
              ))}
              {stats.last_25_positions.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-4 text-center text-muted-foreground">
                    No positions closed yet
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Update timestamp */}
      <p className="text-xs text-muted-foreground text-right">Updated: {new Date().toLocaleTimeString()} (API: {data?.duration}ms)</p>
    </div>
  )
}
