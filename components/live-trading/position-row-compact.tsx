"use client"

import { useState } from "react"
import { ChevronDown, ChevronRight, TrendingUp, TrendingDown, X, MoreVertical } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface Position {
  id: string
  symbol: string
  side: "LONG" | "SHORT"
  entryPrice: number
  currentPrice: number
  quantity: number
  leverage: number
  unrealizedPnl: number
  unrealizedPnlPercent: number
  takeProfitPrice?: number
  stopLossPrice?: number
  createdAt: string
  status: "open" | "closing" | "closed"
}

interface PositionRowCompactProps {
  position: Position
  onClose?: (id: string) => void
  onModify?: (id: string) => void
  index: number
}

function PnlIndicator({ value, percent }: { value: number; percent: number }) {
  const isProfit = value >= 0
  const color = isProfit ? "text-green-400" : "text-red-400"
  const bgColor = isProfit ? "bg-green-500/10" : "bg-red-500/10"

  return (
    <div className={`${bgColor} rounded px-2 py-1 text-xs font-mono flex items-center gap-1`}>
      <span className={color}>{isProfit ? "+" : ""}{value.toFixed(2)} USDT</span>
      <span className={`${color} text-xs`}>({isProfit ? "+" : ""}{percent.toFixed(2)}%)</span>
    </div>
  )
}

export function PositionRowCompact({ position, onClose, onModify, index }: PositionRowCompactProps) {
  const [expanded, setExpanded] = useState(false)
  const [showMenu, setShowMenu] = useState(false)

  const isProfit = position.unrealizedPnl >= 0
  const priceChange = position.currentPrice - position.entryPrice
  const priceChangePercent = (priceChange / position.entryPrice) * 100

  // Smart decimal precision: use enough digits to show non-zero value
  // e.g. 0.01765 → "0.01765", 1234.56 → "1234.56", 0.00042 → "0.00042"
  const formatPrice = (p: number): string => {
    if (p === 0) return "0.00"
    const abs = Math.abs(p)
    if (abs >= 100) return p.toFixed(2)
    if (abs >= 1) return p.toFixed(4)
    // Find first significant digit
    const sig = Math.max(2, Math.ceil(-Math.log10(abs)) + 3)
    return p.toFixed(Math.min(sig, 8))
  }

  return (
    <div className="group border border-slate-700/50 hover:border-slate-600 rounded bg-slate-900/30 hover:bg-slate-900/50 transition-all">
      {/* Main row */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs">
        {/* Expand toggle */}
        <Button
          variant="ghost"
          size="sm"
          className="p-0 h-4 w-4 hover:bg-slate-700/50"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </Button>

        {/* Index */}
        <span className="text-slate-500 font-mono w-4 text-right">{(index + 1).toString().padStart(2, '0')}</span>

        {/* Symbol & side */}
        <div className="flex items-center gap-2 min-w-max">
          <Badge className={`${position.side === "LONG" ? "bg-green-500/20 text-green-300 border-green-500/30" : "bg-red-500/20 text-red-300 border-red-500/30"} border text-xs px-1.5 py-0 h-5 font-bold`}>
            {position.side === "LONG" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
            <span className="ml-1">{position.symbol}</span>
          </Badge>
        </div>

        {/* Price info */}
        <div className="flex items-center gap-2 text-slate-300 font-mono text-xs flex-1 min-w-[180px]">
          <span className="text-slate-500">Entry:</span>
          <span>{formatPrice(position.entryPrice)}</span>
          <span className="text-slate-500">→</span>
          <span className={isProfit ? "text-green-400" : "text-red-400"}>{formatPrice(position.currentPrice)}</span>
          <span className={`text-xs ${isProfit ? "text-green-400" : "text-red-400"}`}>
            ({isProfit ? "+" : ""}{priceChangePercent.toFixed(2)}%)
          </span>
        </div>

        {/* Quantity & leverage */}
        <div className="flex items-center gap-3 text-slate-400 min-w-max">
          <div className="flex items-center gap-1 text-xs">
            <span className="text-slate-500">Qty:</span>
            <span className="font-mono text-cyan-400">{position.quantity.toFixed(4)}</span>
          </div>
          <Badge className="bg-blue-500/20 text-blue-300 border border-blue-500/30 text-xs px-1.5 py-0 h-5">
            {position.leverage}x
          </Badge>
        </div>

        {/* PnL */}
        <div className="min-w-[140px]">
          <PnlIndicator value={position.unrealizedPnl} percent={position.unrealizedPnlPercent} />
        </div>

        {/* Status badge */}
        <Badge className={`${position.status === "open" ? "bg-blue-500/20 text-blue-300 border-blue-500/30" : "bg-slate-500/20 text-slate-300 border-slate-500/30"} border text-xs px-1.5 py-0 h-5`}>
          {position.status.toUpperCase()}
        </Badge>

        {/* Action menu */}
        <div className="relative">
          <Button
            variant="ghost"
            size="sm"
            className="p-1 h-6 w-6 hover:bg-slate-700/50"
            onClick={() => setShowMenu(!showMenu)}
          >
            <MoreVertical className="h-3 w-3" />
          </Button>

          {showMenu && (
            <div className="absolute right-0 top-6 bg-slate-800 border border-slate-700 rounded shadow-lg z-10 min-w-[100px]">
              <button
                onClick={() => {
                  onModify?.(position.id)
                  setShowMenu(false)
                }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-slate-700 transition-colors"
              >
                Modify
              </button>
              <button
                onClick={() => {
                  onClose?.(position.id)
                  setShowMenu(false)
                }}
                className="w-full text-left px-3 py-2 text-xs hover:bg-red-900/30 text-red-300 transition-colors"
              >
                Close
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Expanded details */}
      {expanded && (
        <div className="border-t border-slate-700/50 bg-slate-900/20 px-3 py-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {/* Position details */}
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1 text-xs">Position Details</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                <div>Entry: <span className="text-cyan-400">{position.entryPrice >= 1 ? position.entryPrice.toFixed(4) : position.entryPrice.toFixed(6)}</span></div>
                <div>Current: <span className="text-green-400">{position.currentPrice >= 1 ? position.currentPrice.toFixed(4) : position.currentPrice.toFixed(6)}</span></div>
                <div>Qty: <span className="text-blue-400">{position.quantity.toFixed(6)}</span></div>
                <div>Lev: <span className="text-amber-400">{position.leverage}x</span></div>
              </div>
            </div>

            {/* TP/SL info */}
            <div className="bg-slate-900/50 rounded p-2 border border-slate-700/50">
              <div className="text-slate-400 font-semibold mb-1 text-xs">Take Profit / Stop Loss</div>
              <div className="space-y-0.5 text-slate-300 font-mono text-xs">
                {position.takeProfitPrice ? (
                  <div>TP: <span className="text-green-400">{position.takeProfitPrice >= 1 ? position.takeProfitPrice.toFixed(4) : position.takeProfitPrice.toFixed(6)}</span></div>
                ) : (
                  <div>TP: <span className="text-slate-500">Not Set</span></div>
                )}
                {position.stopLossPrice ? (
                  <div>SL: <span className="text-red-400">{position.stopLossPrice >= 1 ? position.stopLossPrice.toFixed(4) : position.stopLossPrice.toFixed(6)}</span></div>
                ) : (
                  <div>SL: <span className="text-slate-500">Not Set</span></div>
                )}
                <div className="text-slate-500 text-xs mt-1">Created: {new Date(position.createdAt).toLocaleTimeString()}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
