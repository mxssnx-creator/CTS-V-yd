// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult, type ExchangeCredentials } from "./base-connector"
import { safeParseResponse } from "@/lib/safe-response-parser"

export class PionexConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "pionex") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    return "https://api.pionex.com"
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "leverage", "hedge_mode", "cross_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting Pionex connection test")
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

  /**
   * Generate Pionex API signature per official docs:
   * 1. Sort query params by key in ASCII order (including timestamp)
   * 2. Build: METHOD + PATH + ? + sorted_query_string
   * 3. For POST/DELETE with body, append body JSON after step 2
   * 4. HMAC-SHA256 with API Secret, send as PIONEX-SIGNATURE header
   */
  private generateSignature(method: string, path: string, params: Record<string, string>, body?: string): string {
    // Sort params by key in ascending ASCII order
    const sortedKeys = Object.keys(params).sort()
    const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

    // Build the string to sign: METHOD + PATH?sorted_query
    let stringToSign = `${method}${path}?${queryString}`

    // For POST/DELETE with body, append the body
    if (body) {
      stringToSign += body
    }

    return crypto.createHmac("sha256", this.credentials.apiSecret).update(stringToSign).digest("hex")
  }

  async getBalance(): Promise<ExchangeConnectorResult> {
    const timestamp = Date.now().toString()
    const baseUrl = this.getBaseUrl()
    const method = "GET"
    const path = "/api/v1/account/balances"

    this.log("Generating signature...")

    try {
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      // Build sorted query string for the URL
      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      this.log("Fetching account balance...")

      const response = await this.rateLimitedFetch(
        `${baseUrl}${path}?${queryString}`,
        {
          method,
          headers: {
            "PIONEX-KEY": this.credentials.apiKey,
            "PIONEX-SIGNATURE": signature,
          },
        },
      )

      const data = await safeParseResponse(response)

      // Check for error responses
      if (!response.ok || data.error || data.result === false) {
        const errorMsg = data.error || data.message || `HTTP ${response.status}: ${response.statusText}`
        this.logError(`API Error: ${errorMsg}`)
        throw new Error(errorMsg)
      }

      this.log("Successfully retrieved account data")

      const balanceData = data.data?.balances || []
      const usdtBalance = Number.parseFloat(balanceData.find((b: any) => b.coin === "USDT")?.free || "0")

      const balances = balanceData.map((b: any) => ({
        asset: b.coin,
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

  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit"
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      this.log(`Placing ${orderType} ${side} order: ${quantity} ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "POST"
      const path = "/api/v1/trade/order"
      
      const body = {
        symbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: String(quantity),
      } as any

      if (price && orderType === "limit") {
        body.price = String(price)
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "DELETE"
      const path = "/api/v1/trade/order"
      
      const body = {
        orderId,
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "DELETE",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/trade/order?orderId=${orderId}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      let path = "/api/v1/trade/openOrders"
      if (symbol) {
        path += `?symbol=${symbol}`
      }
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}${symbol ? "&" : "?"}${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      let path = `/api/v1/trade/allOrders?limit=${limit}`
      if (symbol) {
        path += `&symbol=${symbol}`
      }
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    // Pionex only supports spot trading, no positions/futures
    this.log("Positions not available for Pionex (spot trading only)")
    return []
  }

  async getPosition(symbol: string, _direction?: "long" | "short"): Promise<any> {
    return null
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Positions not supported on Pionex" }
  }

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Positions not supported on Pionex" }
  }

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/account/depositAddress?coin=${coin}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "POST"
      const path = "/api/v1/account/withdraw"
      
      const body = {
        coin,
        address,
        amount: String(amount),
      }

      const bodyStr = JSON.stringify(body)
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params, bodyStr)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: {
          "PIONEX-KEY": this.credentials.apiKey,
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
        throw new Error(`Pionex API error: ${data.error || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/account/withdrawHistory?limit=${limit}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false) {
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
    return { success: false, error: "Leverage not supported on Pionex (spot trading only)" }
  }

  async setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Margin trading not supported on Pionex (spot trading only)" }
  }

  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    return { success: false, error: "Position mode not supported on Pionex (spot trading only)" }
  }

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    try {
      this.log(`Fetching ticker for ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      const path = `/api/v1/market/ticker?symbol=${symbol}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false || !data.data) {
        return null
      }

      const ticker = data.data
      const bid = Number.parseFloat(ticker.bid || ticker.bidPrice || "0")
      const ask = Number.parseFloat(ticker.ask || ticker.askPrice || "0")
      const last = Number.parseFloat(ticker.last || ticker.lastPrice || "0")

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

      // ── 1s timeframe (spec §7): aggregate trades ──────────────────
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now().toString()
      const method = "GET"
      
      // Convert timeframe to Pionex interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "12h": "12h",
        "1d": "1d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"
      
      const path = `/api/v1/market/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      const params: Record<string, string> = { timestamp }
      const signature = this.generateSignature(method, path, params)

      const sortedKeys = Object.keys(params).sort()
      const queryString = sortedKeys.map((k) => `${k}=${params[k]}`).join("&")

      const response = await this.rateLimitedFetch(`${baseUrl}${path}&${queryString}&signature=${signature}`, {
        headers: { "PIONEX-KEY": this.credentials.apiKey },
      })

      const data = await safeParseResponse(response)

      if (data.error || data.result === false || !data.data) {
        this.logError(`✗ Failed to fetch OHLCV: ${data.error || "Unknown error"}`)
        return null
      }

      const candles = data.data.map((c: any) => ({
        timestamp: Number.parseInt(c.time),
        open: Number.parseFloat(c.open),
        high: Number.parseFloat(c.high),
        low: Number.parseFloat(c.low),
        close: Number.parseFloat(c.close),
        volume: Number.parseFloat(c.volume)
      }))

      this.log(`✓ OHLCV fetched: ${candles.length} candles`)
      return candles
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch OHLCV: ${errorMsg}`)
      return null
    }
  }

  /**
   * ── 1-second OHLCV (spec §7) ──────────────────────────────────────
   * Aggregates from Pionex `/api/v1/market/trades`. Public endpoint
   * is unsigned. Returns up to ~500 trades.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const baseUrl = this.getBaseUrl()
      const url = `${baseUrl}/api/v1/market/trades?symbol=${symbol}&limit=500`
      const resp = await this.rateLimitedFetch(url)
      if (!resp.ok) return null
      const data = await resp.json()
      const rows = Array.isArray(data?.data) ? data.data : []
      if (rows.length === 0) return []
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const trades = rows.map((r: any) => ({
        timestamp: Number(r.time ?? r.timestamp),
        price: Number(r.price ?? r.p),
        quantity: Number(r.size ?? r.qty ?? r.volume ?? 0),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
