// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult, type ExchangeCredentials } from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

export class OrangeXConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "orangex") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    return "https://api.orangex.com"
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage", "cross_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting OrangeX connection test")
    this.log(`Using endpoint: ${this.getBaseUrl()}`)

    try {
      return await this.getBalance()
    } catch (error) {
      this.logError(error instanceof Error ? error.message : "Unknown error")
      return {
        success: false,
        balance: 0,
        capabilities: this.getCapabilities(),
        error: error instanceof Error ? error.message : "Connection test failed",
        logs: this.logs,
      }
    }
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    const timestamp = Date.now()
    const baseUrl = this.getBaseUrl()

    this.log("Generating signature...")

    try {
      const queryString = `timestamp=${timestamp}`
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      this.log("Fetching account balance...")

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v1/account/balance?${queryString}&signature=${signature}`,
        {
          method: "GET",
          headers: {
            "X-CH-APIKEY": this.credentials.apiKey,
          },
        },
      )

      const data = await safeParseResponse(response)

      // Check for error responses or HTML error pages
      if (!response.ok || data.error || data.code !== "0") {
        const errorMsg = data.error || data.msg || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error: ${errorMsg}`)
        throw new Error(errorMsg)
      }

      this.log("Successfully retrieved account data")

      const balanceData = data.data || []
      const usdtBalance = Number.parseFloat(balanceData.find((b: any) => b.asset === "USDT")?.free || "0")

      const balances = balanceData.map((b: any) => ({
        asset: b.asset,
        free: Number.parseFloat(b.free || "0"),
        locked: Number.parseFloat(b.locked || "0"),
        total: Number.parseFloat(b.free || "0") + Number.parseFloat(b.locked || "0"),
      }))

      this.log(`Account Balance: ${usdtBalance.toFixed(2)} USDT`)

      return {
        success: true,
        balance: usdtBalance,
        balances,
        capabilities: this.getCapabilities(),
        logs: this.logs,
      }
    } catch (error) {
      this.logError(`Connection error: ${error instanceof Error ? error.message : "Unknown"}`)
      throw error
    }
  }

  private generateSignature(queryString: string): string {
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
  }

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit"
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      this.log(`Placing ${orderType} ${side} order: ${quantity} ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const body: Record<string, string> = {
        symbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: String(quantity),
        timestamp,
      }

      if (price && orderType === "limit") {
        body.price = String(price)
      }

      const queryString = Object.entries(body).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const orderId = data.data?.orderId
      this.log(`✓ Order placed successfully: ${orderId}`)
      return { success: true, orderId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to place order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, orderId, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        method: "DELETE",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Order cancelled successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to cancel order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getOrder(symbol: string, orderId: string): Promise<any> {
    try {
      this.log(`Fetching order ${orderId} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, orderId, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/order?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return null
      }

      return data.data
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order: ${errorMsg}`)
      return null
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/openOrders?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch open orders: ${errorMsg}`)
      return []
    }
  }

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { limit: String(limit), timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/trade/allOrders?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { timestamp }
      if (symbol) params.symbol = symbol
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch positions: ${errorMsg}`)
      return []
    }
  }

  async getPosition(symbol: string, _direction?: "long" | "short"): Promise<any> {
    try {
      const positions = await this.getPositions(symbol)
      return positions[0] || null
    } catch {
      return null
    }
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Modifying position for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, timestamp }
      if (leverage) params.leverage = String(leverage)
      if (marginType) params.marginType = marginType

      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/modify?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position modified successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to modify position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Closing position for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, timestamp }
      if (positionSide) params.side = positionSide.toUpperCase()

      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/close?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position closed successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to close position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { coin, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/depositAddress?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const address = data.data?.address
      this.log(`✓ Deposit address retrieved: ${address?.slice(0, 10)}...`)

      return { address }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch deposit address: ${errorMsg}`)
      return { error: errorMsg }
    }
  }

  async withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      this.log(`Withdrawing ${amount} ${coin} to ${address.slice(0, 10)}...`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = {
        coin,
        address,
        amount: String(amount),
        timestamp,
      }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/withdraw?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ coin, address, amount: String(amount) }),
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      const txId = data.data?.withdrawId
      this.log(`✓ Withdrawal initiated: ${txId}`)

      return { success: true, txId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to withdraw: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTransferHistory(limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching transfer history (limit: ${limit})`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { limit: String(limit), timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/account/withdrawHistory?${queryString}&signature=${signature}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        return []
      }

      return data.data || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch transfer history: ${errorMsg}`)
      return []
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting leverage to ${leverage}x for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, leverage: String(leverage), timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/leverage?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Leverage set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set leverage: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting margin type to ${marginType} for ${symbol}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = { symbol, marginType, timestamp }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/marginType?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Margin type set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set margin type: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting position mode to ${hedgeMode ? "hedge" : "one-way"}`)
      const timestamp = Date.now().toString()
      const baseUrl = this.getBaseUrl()

      const params: Record<string, string> = {
        dualSidePosition: hedgeMode ? "true" : "false",
        timestamp,
      }
      const queryString = Object.entries(params).map(([k, v]) => `${k}=${v}`).join("&")
      const signature = this.generateSignature(queryString)

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/position/dualSidePosition?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "X-CH-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0") {
        throw new Error(`OrangeX API error: ${data.error || data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position mode set successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to set position mode: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    try {
      this.log(`Fetching ticker for ${symbol}`)
      const baseUrl = this.getBaseUrl()

      const response = await this.rateLimitedFetch(`${baseUrl}/v1/market/ticker?symbol=${symbol}`, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0" || !data.data) {
        return null
      }

      const ticker = data.data
      const bid = Number.parseFloat(ticker.bidPrice || ticker.bid || "0")
      const ask = Number.parseFloat(ticker.askPrice || ticker.ask || "0")
      const last = Number.parseFloat(ticker.lastPrice || ticker.last || "0")

      this.log(`✓ Ticker fetched: bid=${bid}, ask=${ask}, last=${last}`)
      return { bid, ask, last }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch ticker: ${errorMsg}`)
      return null
    }
  }

  async getOHLCV(symbol: string, timeframe = "1m", limit = 250): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null> {
    try {
      this.log(`Fetching OHLCV for ${symbol} (${timeframe}, ${limit} candles)`)
      // ── 1s timeframe (spec §7) ──
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

      const baseUrl = this.getBaseUrl()

      // Convert timeframe to OrangeX interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "4h": "4h", "1d": "1d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v1/market/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
        { headers: { "X-CH-APIKEY": this.credentials.apiKey } }
      )

      const data = await safeParseResponse(response)

      if (data.error || data.code !== "0" || !data.data) {
        this.logError(`✗ Failed to fetch OHLCV: ${data.error || "Unknown error"}`)
        return null
      }

      const candles = data.data.map((c: any) => ({
        timestamp: Number.parseInt(c.time || c[0]),
        open: Number.parseFloat(c.open || c[1]),
        high: Number.parseFloat(c.high || c[2]),
        low: Number.parseFloat(c.low || c[3]),
        close: Number.parseFloat(c.close || c[4]),
        volume: Number.parseFloat(c.volume || c[5])
      }))

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch OHLCV: ${errorMsg}`)
      return null
    }
  }

  /** ── 1-second OHLCV via aggregated trades (spec §7) ──────────── */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const baseUrl = this.getBaseUrl()
      const url = `${baseUrl}/v1/market/trades?symbol=${symbol}&limit=500`
      const resp = await this.rateLimitedFetch(url, {
        headers: { "X-CH-APIKEY": this.credentials.apiKey },
      })
      if (!resp.ok) return null
      const data = await resp.json().catch(() => null)
      const rows = Array.isArray(data?.data) ? data.data : []
      if (rows.length === 0) return []
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const trades = rows.map((r: any) => ({
        timestamp: Number(r.time ?? r.timestamp ?? r.t),
        price: Number(r.price ?? r.p),
        quantity: Number(r.qty ?? r.q ?? r.size ?? 0),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
