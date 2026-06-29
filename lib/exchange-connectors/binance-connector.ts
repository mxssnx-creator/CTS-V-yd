// Plain `crypto` (NOT `node:crypto`). Webpack 5 cannot resolve `node:` URIs
// in the Edge build, and this connector is reached via instrumentation.ts
// (compiled for BOTH nodejs and edge runtimes). The Edge bundle never
// actually executes this code — `instrumentation.ts` returns before
// `await import("@/lib/startup-coordinator")` runs when
// `NEXT_RUNTIME !== "nodejs"` — but Webpack still has to *build* the graph
// for both targets. The Edge build resolves `crypto` to `false` via the
// alias declared in `next.config.mjs`, so the build succeeds and the
// runtime guard ensures the empty stub is never called.
import * as crypto from "crypto"
import { BaseExchangeConnector, type ExchangeConnectorResult, type ExchangeCredentials } from "./base-connector"

export class BinanceConnector extends BaseExchangeConnector {
  constructor(credentials: ExchangeCredentials, exchange: string = "binance") {
    super(credentials, exchange)
  }
  private getBaseUrl(): string {
    const testnet = this.credentials.isTestnet
    const apiType = this.credentials.apiType || "perpetual_futures"
    
    console.log(`[v0] [Binance] getBaseUrl called with apiType: ${apiType}, testnet: ${testnet}`)
    
    // Binance uses DIFFERENT BASE URLs for different contract types
    if (apiType === "spot") {
      const url = testnet ? "https://testnet.binance.vision" : "https://api.binance.com"
      console.log(`[v0] [Binance] Using SPOT base URL: ${url}`)
      return url
    } else if (apiType === "perpetual_futures" || apiType === "futures") {
      // USDT-M Perpetual Futures use separate API domain
      const url = testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com"
      console.log(`[v0] [Binance] Using FUTURES base URL: ${url}`)
      return url
    }
    
    // Default to futures for backward compatibility
    console.log(`[v0] [Binance] No match for apiType '${apiType}', defaulting to FUTURES`)
    return testnet ? "https://testnet.binancefuture.com" : "https://fapi.binance.com"
  }

  getCapabilities(): string[] {
    return ["futures", "perpetual_futures", "spot", "leverage", "hedge_mode", "cross_margin", "isolated_margin"]
  }

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting Binance connection test")
    this.log(`Testnet: ${this.credentials.isTestnet ? "Yes" : "No"}`)
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

      // Use correct endpoint path based on API type
      // Note: Base URL already points to correct domain (api.binance.com for spot, fapi.binance.com for futures)
      const apiType = this.credentials.apiType || "perpetual_futures"
      let endpoint = ""
      
      if (apiType === "spot") {
        endpoint = "/api/v3/account"
        this.log("Using SPOT endpoint: /api/v3/account")
        console.log("[v0] [Binance] Contract Type: SPOT → Endpoint: /api/v3/account")
      } else if (apiType === "perpetual_futures" || apiType === "futures") {
        endpoint = "/fapi/v2/balance"
        this.log("Using FUTURES endpoint: /fapi/v2/balance")
        console.log("[v0] [Binance] Contract Type: FUTURES → Endpoint: /fapi/v2/balance")
      }

      this.log(`Full URL: ${baseUrl}${endpoint}`)

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        method: "GET",
        headers: {
          "X-MBX-APIKEY": this.credentials.apiKey,
        },
      })

      const data = await response.json()

      if (!response.ok) {
        this.logError(`API Error: ${data.msg || "Unknown error"}`)
        throw new Error(data.msg || "Binance API error")
      }

      this.log("Successfully retrieved account data")

      // Parse balance data differently for spot vs futures
      let usdtBalance = 0
      let balances: any[] = []

      if (apiType === "spot") {
        // Spot API returns {balances: [{asset, free, locked}]}
        // 'free' = available to trade, 'locked' = in open orders
        const spotBalances = data.balances || []
        const usdtData = spotBalances.find((b: any) => b.asset === "USDT")
        // For SPOT: total balance = free + locked
        usdtBalance = Number.parseFloat(usdtData?.free || "0") + Number.parseFloat(usdtData?.locked || "0")
        
        this.log(`SPOT USDT Balance - Free: ${Number.parseFloat(usdtData?.free || "0").toFixed(2)}, Locked: ${Number.parseFloat(usdtData?.locked || "0").toFixed(2)}, Total: ${usdtBalance.toFixed(2)}`)
        
        balances = spotBalances.map((b: any) => ({
          asset: b.asset,
          free: Number.parseFloat(b.free || "0"),
          locked: Number.parseFloat(b.locked || "0"),
          total: Number.parseFloat(b.free || "0") + Number.parseFloat(b.locked || "0"),
        }))
      } else {
        // Futures API returns array of [{asset, balance, availableBalance}]
        // 'balance' = total in account, 'availableBalance' = available to trade
        const usdtFutures = data.find((b: any) => b.asset === "USDT")
        usdtBalance = Number.parseFloat(usdtFutures?.balance || "0")
        
        this.log(`FUTURES USDT Balance - Available: ${Number.parseFloat(usdtFutures?.availableBalance || "0").toFixed(2)}, Total: ${usdtBalance.toFixed(2)}`)
        
        balances = data.map((b: any) => ({
          asset: b.asset,
          free: Number.parseFloat(b.availableBalance || "0"),
          locked: Number.parseFloat(b.balance || "0") - Number.parseFloat(b.availableBalance || "0"),
          total: Number.parseFloat(b.balance || "0"),
        }))
      }

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
      const timestamp = Date.now()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      const params: Record<string, any> = {
        symbol,
        side: side.toUpperCase(),
        type: orderType === "market" ? "MARKET" : "LIMIT",
        quantity: String(quantity),
        timestamp,
      }

      if (price && orderType === "limit") {
        params.price = String(price)
        params.timeInForce = "GTC"
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = "/api/v3/order"
      } else {
        endpoint = "/fapi/v1/order"
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
      }

      const orderId = data.orderId
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
      const timestamp = Date.now()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      const params: Record<string, string> = {
        symbol,
        orderId,
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = "/api/v3/order"
      } else {
        endpoint = "/fapi/v1/order"
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        method: "DELETE",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
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
      const timestamp = Date.now()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      const params: Record<string, string> = {
        symbol,
        orderId,
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = "/api/v3/order"
      } else {
        endpoint = "/fapi/v1/order"
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()
      
      if (!response.ok) {
        return null
      }

      return Array.isArray(data) ? data[0] : data
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
      const timestamp = Date.now()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      const params: Record<string, any> = { timestamp }
      if (symbol) params.symbol = symbol

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = "/api/v3/openOrders"
      } else {
        endpoint = "/fapi/v1/openOrders"
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()
      return Array.isArray(data) ? data : []
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
      const timestamp = Date.now()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      const params: Record<string, any> = { timestamp, limit }
      if (symbol) params.symbol = symbol

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = "/api/v3/allOrders"
      } else {
        endpoint = "/fapi/v1/allOrders"
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()
      return Array.isArray(data) ? data : []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch order history: ${errorMsg}`)
      return []
    }
  }

  async getPositions(symbol?: string): Promise<any[]> {
    if (this.credentials.apiType === "spot") {
      this.log("Positions not available for spot trading")
      return []
    }

    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      
      const params: Record<string, any> = { timestamp }
      if (symbol) params.symbol = symbol

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/fapi/v2/positionRisk?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()
      return Array.isArray(data) ? data : []
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      
      const params: Record<string, any> = { symbol, timestamp }
      if (leverage) params.leverage = leverage
      if (marginType) params.marginType = marginType === "cross" ? "CROSSED" : "ISOLATED"

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
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

      const side = position.positionSide === "LONG" ? "sell" : "buy"
      const result = await this.placeOrder(symbol, side as "buy" | "sell", Math.abs(parseFloat(position.positionAmt)), undefined, "market")

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

      const baseUrl = "https://api.binance.com"
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        coin,
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/sapi/v1/capital/deposit/address?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
      }

      const address = data.address
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

      const baseUrl = "https://api.binance.com"
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        coin,
        withdrawOrderId: `withdraw_${Date.now()}`,
        address,
        amount: String(amount),
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/sapi/v1/capital/withdraw/apply?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
      }

      const txId = data.id
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

      const baseUrl = "https://api.binance.com"
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        timestamp: String(timestamp),
        limit: String(limit),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/sapi/v1/capital/withdraw/history?${queryString}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()
      return Array.isArray(data) ? data : []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`✗ Failed to fetch transfer history: ${errorMsg}`)
      return []
    }
  }

  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting leverage to ${leverage}x for ${symbol}`)

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        symbol,
        leverage: String(leverage),
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/fapi/v1/leverage?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        symbol,
        marginType: marginType === "cross" ? "CROSSED" : "ISOLATED",
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/fapi/v1/marginType?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const timestamp = Date.now()
      
      const params: Record<string, string> = {
        dualSidePosition: hedgeMode ? "true" : "false",
        timestamp: String(timestamp),
      }

      const queryString = new URLSearchParams(params).toString()
      const signature = crypto.createHmac("sha256", this.credentials.apiSecret).update(queryString).digest("hex")

      const response = await this.rateLimitedFetch(`${baseUrl}/fapi/v1/positionSide/dual?${queryString}&signature=${signature}`, {
        method: "POST",
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok || data.code !== 0) {
        throw new Error(`Binance API error: ${data.msg || "Unknown error"}`)
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

      const baseUrl = this.getBaseUrl()
      const apiType = this.credentials.apiType || "perpetual_futures"
      
      let endpoint = ""
      if (apiType === "spot") {
        endpoint = `/api/v3/ticker/bookTicker?symbol=${symbol}`
      } else {
        endpoint = `/fapi/v1/ticker/bookTicker?symbol=${symbol}`
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      const data = await response.json()

      if (!response.ok) {
        return null
      }

      const bid = Number.parseFloat(data.bidPrice || "0")
      const ask = Number.parseFloat(data.askPrice || "0")
      
      let lastEndpoint = ""
      if (apiType === "spot") {
        lastEndpoint = `/api/v3/ticker/price?symbol=${symbol}`
      } else {
        lastEndpoint = `/fapi/v1/ticker/price?symbol=${symbol}`
      }
      
      const lastResponse = await this.rateLimitedFetch(`${baseUrl}${lastEndpoint}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })
      const lastData = await lastResponse.json()
      const last = Number.parseFloat(lastData.price || "0")

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

      const baseUrl = this.getBaseUrl()
      const apiType = this.credentials.apiType || "perpetual_futures"

      // ── 1-second timeframe (spec §7) ─────────────────────────────
      //
      // Binance SPOT supports `interval=1s` natively (since 2023).
      // FUTURES does NOT — for FAPI we aggregate `/fapi/v1/aggTrades`.
      // We page backward from now and cap the total fetch at `limit`
      // seconds (caller already passes a 1-day-sized limit). The
      // shared aggregator handles bucket alignment + missing seconds.
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) {
          this.log(`✓ OHLCV 1s built: ${aggregated.length} buckets (window ${Math.round((endMs - startMs) / 1000)}s)`)
          return aggregated
        }
        this.log(`⚠ 1s aggregation returned 0 buckets for ${symbol}`)
        return null
      }

      // Convert timeframe to Binance interval format
      const intervalMap: Record<string, string> = {
        "1m": "1m", "3m": "3m", "5m": "5m", "15m": "15m", "30m": "30m",
        "1h": "1h", "2h": "2h", "4h": "4h", "6h": "6h", "8h": "8h", "12h": "12h",
        "1d": "1d", "3d": "3d", "1w": "1w", "1M": "1M"
      }
      const interval = intervalMap[timeframe] || "1m"

      let endpoint = ""
      if (apiType === "spot") {
        endpoint = `/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      } else {
        endpoint = `/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
      }

      const response = await this.rateLimitedFetch(`${baseUrl}${endpoint}`, {
        headers: { "X-MBX-APIKEY": this.credentials.apiKey },
      })

      if (!response.ok) {
        const errorData = await response.json()
        this.logError(`✗ Failed to fetch OHLCV: ${errorData.msg || response.statusText}`)
        return null
      }

      const data = await response.json()
      
      // Binance returns: [timestamp, open, high, low, close, volume, ...]
      const candles = data.map((c: string[]) => ({
        timestamp: Number.parseInt(c[0]),
        open: Number.parseFloat(c[1]),
        high: Number.parseFloat(c[2]),
        low: Number.parseFloat(c[3]),
        close: Number.parseFloat(c[4]),
        volume: Number.parseFloat(c[5])
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
   *
   * Strategy:
   *   - SPOT  → use native `interval=1s` klines, paginate by `startTime`.
   *   - FAPI  → aggregate from `/fapi/v1/aggTrades`, paginate by `endTime`.
   *
   * Returns an array of 1s OHLCV candles in [startMs, endMs), sorted
   * ascending. Returns null on hard error; empty array if no data.
   *
   * Caller (market-data-loader / engine-manager) decides whether to
   * fall back to synthetic.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null> {
    try {
      const apiType = this.credentials.apiType || "perpetual_futures"
      const baseUrl = this.getBaseUrl()
      const isSpot = apiType === "spot"

      if (isSpot) {
        // ── Native 1s klines (spot only) ──────────────────────────
        // Max 1000 per call; we page forward by `startTime`. The
        // weight cost is 2 for `limit=1000` on spot — at one call
        // per second of wall clock we comfortably stay under the
        // 6000/min IP-weight cap.
        const out: Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> = []
        const PAGE = 1000
        let cursor = startMs
        let iter = 0
        while (cursor < endMs && iter < 200) {
          iter++
          const url = `${baseUrl}/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${cursor}&endTime=${endMs}&limit=${PAGE}`
          const resp = await this.rateLimitedFetch(url, {
            headers: { "X-MBX-APIKEY": this.credentials.apiKey },
          })
          if (!resp.ok) {
            this.logError(`✗ 1s klines page ${iter} HTTP ${resp.status}`)
            break
          }
          const rows = (await resp.json()) as any[][]
          if (!Array.isArray(rows) || rows.length === 0) break
          for (const r of rows) {
            const ts = Number(r[0])
            if (!Number.isFinite(ts) || ts < startMs || ts >= endMs) continue
            out.push({
              timestamp: ts,
              open: Number(r[1]),
              high: Number(r[2]),
              low: Number(r[3]),
              close: Number(r[4]),
              volume: Number(r[5]),
            })
          }
          const lastTs = Number(rows[rows.length - 1]?.[0])
          if (!Number.isFinite(lastTs) || lastTs <= cursor) break
          // Advance cursor PAST the last returned bucket (each row is
          // a 1s bucket, so +1000ms gives the next second).
          cursor = lastTs + 1000
          if (rows.length < PAGE) break
        }
        return out
      }

      // ── Futures: aggregate aggTrades into 1s buckets ───────────
      const { build1sOhlcvFromTrades } = await import("./aggregate-1s")
      const paginator = async (sym: string, fromMs: number, untilMs: number) => {
        // /fapi/v1/aggTrades returns 500 trades by default, max 1000.
        // We page BACKWARD by `endTime` (cursor at right edge).
        const url = `${baseUrl}/fapi/v1/aggTrades?symbol=${sym}&startTime=${fromMs}&endTime=${untilMs}&limit=1000`
        const resp = await this.rateLimitedFetch(url, {
          headers: { "X-MBX-APIKEY": this.credentials.apiKey },
        })
        if (!resp.ok) return []
        const rows = (await resp.json()) as Array<{ T: number; p: string; q: string }>
        if (!Array.isArray(rows)) return []
        return rows.map((r) => ({
          timestamp: Number(r.T),
          price: Number(r.p),
          quantity: Number(r.q),
        }))
      }
      return await build1sOhlcvFromTrades(paginator, symbol, startMs, endMs, {
        pageSize: 1000,
        pageDelayMs: 250,
        maxIterations: 400,
      })
    } catch (error) {
      this.logError(`✗ getOHLCV1s failed: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
}
