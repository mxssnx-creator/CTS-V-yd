// Plain `crypto` — Edge build aliases this to `false` via `next.config.mjs`.
import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult, type ExchangeCredentials } from "./base-connector"

export class OKXConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "okx") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://www.okx.com" : "https://www.okx.com"
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "spot", "leverage", "hedge_mode", "cross_margin", "isolated_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting OKX connection test")
    this.log(`Testnet: ${this.credentials.isTestnet ? "Yes" : "No"}`)
    this.log(`Using endpoint: ${this.getBaseUrl()}`)

    // Don't make API calls with placeholder/invalid credentials
    // Note: Don't check apiKey.length — valid credentials vary by exchange
    if (!this.credentials.apiKey || this.credentials.apiKey.includes("PLACEHOLDER") || 
        !this.credentials.apiSecret || this.credentials.apiSecret.includes("PLACEHOLDER")) {
      this.logError("Invalid or placeholder credentials - skipping API call")
      return {
        success: false,
        balance: 0,
        capabilities: this.getCapabilities(),
        error: "Invalid or placeholder API credentials",
        logs: this.logs,
      }
    }

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
    const timestamp = new Date().toISOString()
    const baseUrl = this.getBaseUrl()
    const apiType = this.credentials.apiType || "perpetual_futures"

    this.log(`API Type: ${apiType}`)
    this.log("Generating signature...")

    try {
      const method = "GET"
      // OKX uses different endpoints or filter parameters for different account types
      // /api/v5/account/balance returns balances for configured accounts
      // ccy parameter can filter by currency
      const requestPath = "/api/v5/account/balance"
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      this.log("Fetching account balance...")
      console.log(`[v0] [OKX] API Type: ${apiType}`)

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "GET",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
      })

      const data = await response.json()

      if (!response.ok || data.code !== "0") {
        this.logError(`API Error: ${data.msg || "Unknown error"}`)
        throw new Error(data.msg || "OKX API error")
      }

      this.log("Successfully retrieved account data")

      // OKX returns account details with balances for each currency
      const details = data.data?.[0]?.details || []
      const usdtDetail = details.find((d: any) => d.ccy === "USDT")
      const usdtBalance = Number.parseFloat(usdtDetail?.eq || "0") // eq = equity (total balance)

      this.log(`USDT Equity (Total): ${usdtBalance.toFixed(2)}`)
      this.log(`USDT Available: ${Number.parseFloat(usdtDetail?.availBal || "0").toFixed(2)}`)
      this.log(`USDT Frozen: ${Number.parseFloat(usdtDetail?.frozenBal || "0").toFixed(2)}`)

      const balances = details.map((d: any) => ({
        asset: d.ccy,
        free: Number.parseFloat(d.availBal || "0"), // Available balance
        locked: Number.parseFloat(d.frozenBal || "0"), // Frozen/locked balance
        total: Number.parseFloat(d.eq || "0"), // Total equity
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/trade/order"
      
      const body = {
        instId: symbol,
        tdMode: "cross",
        side: side.toLowerCase(),
        ordType: orderType === "market" ? "market" : "limit",
        sz: String(quantity),
      } as any

      if (price && orderType === "limit") {
        body.px = String(price)
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      const orderId = data.data?.[0]?.ordId
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/trade/cancel-order"
      
      const body = {
        instId: symbol,
        ordId: orderId,
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      const requestPath = `/api/v5/trade/order?instId=${symbol}&ordId=${orderId}`
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
        return null
      }

      return data.data?.[0]
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order: ${errorMsg}`)
      return null
    }
  }

  async getOpenOrders(symbol?: string): Promise<any[]> {
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      let requestPath = "/api/v5/trade/orders-pending"
      if (symbol) {
        requestPath += `?instId=${symbol}`
      }
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      let requestPath = `/api/v5/trade/orders-history?limit=${limit}`
      if (symbol) {
        requestPath += `&instId=${symbol}`
      }
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      let requestPath = "/api/v5/account/positions"
      if (symbol) {
        requestPath += `?instId=${symbol}`
      }
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
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
    const positions = await this.getPositions(symbol)
    return positions.length > 0 ? positions[0] : null
  }

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Modifying position ${symbol}${leverage ? ` leverage=${leverage}` : ""}${marginType ? ` marginType=${marginType}` : ""}`)

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/account/set-leverage"
      
      const body: any = {
        instId: symbol,
      }

      if (leverage) {
        body.lever = String(leverage)
        body.mgnMode = marginType === "cross" ? "cross" : "isolated"
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
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
      this.log(`Closing position ${symbol}${positionSide ? ` (${positionSide})` : ""}`)

      const position = await this.getPosition(symbol)
      if (!position) {
        return { success: false, error: "Position not found" }
      }

      const side = position.posSide === "long" ? "sell" : "buy"
      const result = await this.placeOrder(symbol, side as "buy" | "sell", Math.abs(parseFloat(position.pos)), undefined, "market")

      if (!result.success) {
        return result
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      const requestPath = `/api/v5/asset/deposit-address?ccy=${coin}`
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      const address = data.data?.[0]?.addr
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/asset/withdrawal"
      
      const body = {
        ccy: coin,
        toAddr: address,
        amt: String(amount),
        chain: `${coin}-ON`, // Default chain
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      const txId = data.data?.[0]?.wdId
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      const requestPath = `/api/v5/asset/withdrawal-history?limit=${limit}`
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/account/set-leverage"
      
      const body = {
        instId: symbol,
        lever: String(leverage),
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      this.log(`✓ Leverage set to ${leverage}x`)
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/account/set-leverage"
      
      const body = {
        instId: symbol,
        mgnMode: marginType === "cross" ? "cross" : "isolated",
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      this.log(`✓ Margin type set to ${marginType}`)
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "POST"
      const requestPath = "/api/v5/account/set-position-mode"
      
      const body = {
        posMode: hedgeMode ? "long_short_mode" : "net_mode",
      }

      const bodyStr = JSON.stringify(body)
      const prehash = timestamp + method + requestPath + bodyStr
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        method: "POST",
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
          "Content-Type": "application/json",
        },
        body: bodyStr,
      })

      const data = await response.json()

      if (data.code !== "0") {
        throw new Error(`OKX API error: ${data.msg || "Unknown error"}`)
      }

      this.log(`✓ Position mode set to ${hedgeMode ? "hedge" : "one-way"}`)
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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      const method = "GET"
      const requestPath = `/api/v5/market/ticker?instId=${symbol}`
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0" || !data.data?.[0]) {
        return null
      }

      const ticker = data.data[0]
      const bid = Number.parseFloat(ticker.bidPx || "0")
      const ask = Number.parseFloat(ticker.askPx || "0")
      const last = Number.parseFloat(ticker.last || "0")

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

      const timestamp = new Date().toISOString()
      const baseUrl = this.getBaseUrl()
      
      // Convert timeframe to OKX bar format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1H", "2h": "2H", "4h": "4H", "6h": "6H", "12h": "12H",
        "1d": "1D", "1w": "1W", "1M": "1M"
      }
      const bar = intervalMap[timeframe] || "1m"

      const method = "GET"
      const requestPath = `/api/v5/market/candles?instId=${symbol}&bar=${bar}&limit=${limit}`
      const body = ""
      const prehash = timestamp + method + requestPath + body
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(prehash).digest("base64")

      const response = await this.rateLimitedFetch(`${baseUrl}${requestPath}`, {
        headers: {
          "OK-ACCESS-KEY": this.credentials.apiKey,
          "OK-ACCESS-SIGN": signature,
          "OK-ACCESS-TIMESTAMP": timestamp,
          "OK-ACCESS-PASSPHRASE": this.credentials.apiPassphrase || "",
        },
      })

      const data = await response.json()

      if (data.code !== "0") {
        this.logError(`✗ Failed to fetch OHLCV: ${data.msg || "Unknown error"}`)
        return null
      }

      // OKX returns: [timestamp, open, high, low, close, volume, ...]
      const candles = data.data.map((c: string[]) => ({
        timestamp: Number.parseInt(c[0]),
        open: Number.parseFloat(c[1]),
        high: Number.parseFloat(c[2]),
        low: Number.parseFloat(c[3]),
        close: Number.parseFloat(c[4]),
        volume: Number.parseFloat(c[5])
      })).reverse() // Reverse to get chronological order

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
   *
   * Aggregates from `/api/v5/market/trades`. OKX returns the last 500
   * trades by default (max 500). Like Bybit, true backfill of a full
   * day is not possible from public endpoints — we return whatever
   * coverage we get.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const baseUrl = this.getBaseUrl()
      const { aggregateTradesTo1sOHLCV } = await import("./aggregate-1s")
      const url = `${baseUrl}/api/v5/market/trades?instId=${symbol}&limit=500`
      const resp = await this.rateLimitedFetch(url)
      if (!resp.ok) return null
      const data = await resp.json()
      const rows = data?.data as Array<{ ts: string; px: string; sz: string }> | undefined
      if (!Array.isArray(rows) || rows.length === 0) return []
      const trades = rows.map((r) => ({
        timestamp: Number(r.ts),
        price: Number(r.px),
        quantity: Number(r.sz),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
