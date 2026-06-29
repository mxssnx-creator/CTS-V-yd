import { BaseExchangeConnector, type ExchangeCredentials } from "./base-connector";
import { v4 as uuidv4 } from "uuid";

// Minimal simulated connector used for tests when external exchange calls are blocked.
// It fakes immediate fills and basic position responses so the live pipeline exercises
// order placement, SL/TP placement, and reconcile paths without network access.

export class SimulatedConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "simulated") {
    super(credentials, exchange)
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage"]
  }

  async testConnection(): Promise<any> {
    return { success: true, balance: 1000, capabilities: this.getCapabilities(), logs: [] }
  }

  async getBalance(): Promise<any> {
    return { success: true, balance: 1000, balances: [{ asset: "USDT", free: 1000, locked: 0, total: 1000 }] }
  }

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType?: "limit" | "market",
    options?: any,
  ): Promise<{ success: boolean; orderId?: string; filledQty?: number; filledPrice?: number; error?: string }> {
    const orderId = `sim-${Date.now()}-${Math.floor(Math.random() * 100000)}`
    // Use the requested price so PF calculations are based on real entry prices.
    // Add ±0.05% slippage to simulate realistic fills.
    const basePrice = price && price > 0 ? price : 1.0
    const slippagePct = side === "buy" ? 1.0005 : 0.9995
    const filledPrice = Math.round(basePrice * slippagePct * 1e8) / 1e8
    return { success: true, orderId, filledQty: quantity, filledPrice }
  }

  async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: any = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    const id = `sim-stop-${Date.now()}`
    return { success: true, orderId: id }
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    return { success: true, orderId, status: "filled", filledQty: 0, avgPrice: 0 }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    return []
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    return []
  }

  async getPosition(symbol: string, _direction?: "long" | "short"): Promise<any> {
    // Return null (no open position) rather than a zeroed stub so the live
    // reconcile path correctly treats this symbol as having no exchange position.
    return null
  }

  async getPositions(): Promise<any[]> {
    return []
  }

  async modifyPosition(symbol: string, leverage?: number, marginType?: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean }> {
    return { success: true }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    return { address: `sim-address-${coin}` }
  }

  async withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }> {
    return { success: true, txId: `sim-tx-${Date.now()}` }
  }

  async getTransferHistory(limit: number = 20): Promise<Array<{ type: string; coin: string; amount: number; timestamp: number }>> {
    return []
  }

  async setLeverage(_symbol: string, _lev: number): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async setMarginType(_symbol: string, _type: string): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async setPositionMode(_hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    return { success: true }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    // Return approximate realistic prices per symbol so PF/PnL simulations
    // are in the right ballpark. These are rough constants — the live engine
    // will use actual market candles for entry prices; this is only hit by
    // the simulated exchange when a real API call would fail.
    const APPROX: Record<string, number> = {
      BTCUSDT: 65000, ETHUSDT: 3500, SOLUSDT: 150, BNBUSDT: 580,
      XRPUSDT: 0.6, AVAXUSDT: 30, DOGEUSDT: 0.15, ADAUSDT: 0.45,
      LINKUSDT: 14, DOTUSDT: 7, LTCUSDT: 85, UNIUSDT: 8, NEARUSDT: 5,
      ATOMUSDT: 8, POLUSDT: 0.4, AAVEUSDT: 190, SUIUSDT: 2.5,
      ARBUSDT: 0.9, APTUSDT: 8, OPUSDT: 1.5,
    }
    const last = APPROX[symbol.toUpperCase()] ?? 100
    const spread = last * 0.0002
    return { bid: last - spread, ask: last + spread, last }
  }

  async getOHLCV(symbol: string, timeframe: string = "1m", limit: number = 100): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null> {
    return []
  }
}
