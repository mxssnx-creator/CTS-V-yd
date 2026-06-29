export function hasRealTradeBlock(settings: Record<string, any>): boolean {
  return String(settings.live_trade_blocked_reason || "").trim().length > 0
}
