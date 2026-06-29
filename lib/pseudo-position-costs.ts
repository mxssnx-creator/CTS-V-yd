export const PSEUDO_POSITION_CLOSE_COST_RATIO = 0.001 // 0.1% of position notional

export type PseudoPositionSide = "long" | "short"

export interface PseudoClosePnlInput {
  entryPrice: number
  currentPrice: number
  quantity: number
  side: PseudoPositionSide | string
}

export interface PseudoClosePnlResult {
  grossPnl: number
  positionCost: number
  netPnl: number
  grossPnlPct: number
  netPnlPct: number
  notional: number
}

export function calculatePseudoClosePnl(input: PseudoClosePnlInput): PseudoClosePnlResult {
  const entryPrice = Number(input.entryPrice)
  const currentPrice = Number(input.currentPrice)
  const quantity = Number(input.quantity)
  const side = input.side === "short" ? "short" : "long"
  const notional = entryPrice > 0 && quantity > 0 ? entryPrice * quantity : 0
  const grossPnl = side === "long"
    ? (currentPrice - entryPrice) * quantity
    : (entryPrice - currentPrice) * quantity
  const positionCost = notional * PSEUDO_POSITION_CLOSE_COST_RATIO
  const netPnl = grossPnl - positionCost
  return {
    grossPnl,
    positionCost,
    netPnl,
    grossPnlPct: notional > 0 ? (grossPnl / notional) * 100 : 0,
    netPnlPct: notional > 0 ? (netPnl / notional) * 100 : 0,
    notional,
  }
}
