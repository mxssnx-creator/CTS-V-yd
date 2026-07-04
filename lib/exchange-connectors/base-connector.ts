/**
 * Base Exchange Connector Interface
 * All exchange connectors must implement this interface for consistency
 */

import { getRateLimiter } from "@/lib/rate-limiter"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"
import { validateApiType, validateContractType, getApiPath } from "@/lib/api-type-validator"

// Supported API types across all exchanges
export const VALID_API_TYPES = [
  "spot",
  "perpetual_futures",
  "futures",
  "unified",
  "contract",
  "inverse",
  "margin",
  "portfolio",
  "swap",
  "standard",
] as const

export type ValidApiType = typeof VALID_API_TYPES[number]

export interface ExchangeCredentials {
  apiKey: string
  apiSecret: string
  apiPassphrase?: string
  isTestnet: boolean
  apiType?: string // API type: spot, perpetual_futures, futures, unified, etc.
  contractType?: string // Contract type: usdt-perpetual, coin-perpetual, spot
  subType?: string // Exchange-specific subtype (e.g., BingX subType)
  marginType?: string
  positionMode?: string
  connectionMethod?: string
  connectionLibrary?: string
}

export interface ExchangeBalance {
  asset: string
  free: number
  locked: number
  total: number
}

export interface ExchangePosition {
  symbol: string
  side: "long" | "short"
  contracts: number
  contractSize: number
  currentPrice: number
  markPrice: number
  entryPrice: number
  leverage: number
  marginType: "cross" | "isolated"
  unrealizedPnl: number
  realizedPnl: number
  liquidationPrice: number
  timestamp: number
}

export interface ExchangeOrder {
  orderId: string
  symbol: string
  side: "buy" | "sell"
  type: "limit" | "market"
  quantity: number
  price: number
  status: "pending" | "filled" | "partially_filled" | "cancelled"
  filledQty: number
  filledPrice: number
  timestamp: number
  updateTime: number
}

export interface ExchangeConnectorResult {
  success: boolean
  balance: number // USDT balance
  btcPrice?: number // BTC/USDT price (optional)
  balances?: ExchangeBalance[]
  capabilities: string[]
  error?: string
  logs: string[]
}

/**
 * Optional per-order flags. Kept opt-in so existing callers and connector
 * subclasses that only care about (symbol, side, qty, price, type) keep
 * working unchanged.
 *
 *   reduceOnly    — force the order to only reduce an existing position
 *                   (required for SL / TP / manual-close orders on perp
 *                   exchanges; without it the order can open a NEW
 *                   opposite-side position on hedge-mode accounts).
 *   positionSide  — explicit hedge-mode side of the position this order
 *                   applies to ("LONG" | "SHORT"). Must match the side
 *                   of the opened position, NOT the side of the order.
 *                   When omitted, the connector falls back to deriving
 *                   it from the order `side`.
 *   hedgeMode     — hint from the caller telling the connector whether
 *                   the account is in hedge mode. When set to `false`
 *                   the connector MUST NOT emit a `positionSide` that
 *                   would be rejected on a one-way account.
 */
export interface PlaceOrderOptions {
  reduceOnly?: boolean
  positionSide?: "LONG" | "SHORT"
  hedgeMode?: boolean
  clientOrderId?: string
}

export abstract class BaseExchangeConnector {
  protected credentials: ExchangeCredentials
  protected logs: string[] = []
  protected timeout = 40000 // 40 seconds (increased from 10s to handle BingX API latency)
  protected rateLimiter: ReturnType<typeof getRateLimiter>

  constructor(credentials: ExchangeCredentials, exchange: string) {
    this.credentials = credentials
    this.rateLimiter = getRateLimiter(exchange)
    
    // Validate API type on construction
    const apiValidation = validateApiType(exchange, credentials.apiType || "")
    if (!apiValidation.isValid) {
      this.log(`WARNING: Invalid API type - ${apiValidation.error}`)
    }
    
    // Validate contract type on construction
    const contractValidation = validateContractType(exchange, credentials.apiType || "")
    if (!contractValidation.isValid) {
      this.log(`WARNING: Invalid contract type - ${contractValidation.error}`)
    }
  }

  protected log(message: string): void {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ${message}`
    this.logs.push(logMessage)
    if (process.env.NODE_ENV !== "test" && !process.env.JEST_WORKER_ID) {
      console.log(`[v0] ${logMessage}`)
    }
  }

  /**
   * Unified swap-trade execution gateway.
   *
   * BingX implements this with a switch over operation names
   * ("placeOrder", "cancelOrder", "batchPlaceOrders", "closeAllPositions",
   * "getOpenOrders", "setKillSwitch", etc.). Other connectors may override
   * this to expose equivalent operations. The default implementation returns
   * a structured failure so callers can safely branch on `result.success`.
   */
  async executeSwapTrade(
    operation: string,
    _params: Record<string, any> = {},
  ): Promise<any> {
    this.log(`executeSwapTrade("${operation}") is not implemented for this connector`)
    return {
      success: false,
      error: `executeSwapTrade not implemented for ${this.credentials.connectionLibrary || "this"} connector`,
    }
  }

  /**
   * Get the API path for this connection's contract type
   * Different exchanges use different paths based on api_type
   */
  protected getApiPath(): string {
    return getApiPath(
      this.credentials.connectionLibrary || "unknown",
      this.credentials.apiType || "spot"
    )
  }

  /**
   * Validate that this connection can execute an operation for the given contract type
   */
  protected canExecuteOperation(operationType: "trading" | "positions" | "funding"): boolean {
    const apiType = this.credentials.apiType || "spot"
    
    // Spot trading: cannot do positions, limited funding
    if (apiType === "spot") {
      if (operationType === "positions") {
        this.log(`WARNING: Cannot fetch positions for spot trading account`)
        return false
      }
    }
    
    // Perpetual: can do all operations
    if (apiType === "perpetual" || apiType === "perpetual_futures") {
      return true
    }
    
    // All types: can do trading and funding
    return true
  }

  protected logError(message: string): void {
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] ERROR: ${message}`
    this.logs.push(logMessage)
    console.error(`[v0] ${logMessage}`)
  }

  protected getEffectiveAccountType(): string {
    // CRITICAL: Contract types vs Account types are DIFFERENT concepts
    // 
    // CONTRACT TYPES (what you trade): spot, perpetual_futures, futures, unified
    //   - Defines the trading section/market you're accessing
    //   - Independent variable that affects API endpoints and base URLs
    //   - Examples: BTC/USDT spot, BTC/USDT perpetual futures
    //
    // ACCOUNT TYPES (how exchange organizes wallets): UNIFIED, CONTRACT, SPOT
    //   - Bybit-specific parameter for wallet-level organization
    //   - UNIFIED = all contract types in one wallet
    //   - CONTRACT = derivatives/futures only wallet
    //   - SPOT = spot trading only wallet
    //
    // This method maps contract types → Bybit accountType parameter
    
    const apiType = this.credentials.apiType || "unified"
    
    if (apiType === "unified") {
      return "UNIFIED"
    }
    if (apiType === "perpetual_futures" || apiType === "futures") {
      return "CONTRACT"
    }
    if (apiType === "spot") {
      return "SPOT"
    }
    // Default to UNIFIED for backward compatibility
    return "UNIFIED"
  }

  /**
   * Rate-limited fetch. Accepts either a pre-built URL string or a
   * LAZY URL BUILDER function.
   *
   * WHY THE BUILDER MATTERS: signed exchange requests embed a `timestamp`
   * in the query string. When the rate-limiter queue is backed up, a URL
   * built at call time can sit in the queue for seconds before actually
   * being sent — by then the embedded timestamp is stale and exchanges
   * reject it (BingX code=100421 "timestamp mismatch"). Passing a builder
   * defers timestamp + signature computation to the moment the rate-limit
   * slot is actually acquired, so the timestamp is always fresh.
   */
  protected async rateLimitedFetch(
    url: string | (() => string),
    options?: RequestInit,
  ): Promise<Response> {
    // this.timeout is enforced via the rate-limiter's executeTimeoutMs parameter.
    // The timeout starts at dispatch time (when the request leaves the queue and
    // begins executing), NOT at enqueue time. This prevents abort signals from
    // firing during legitimate queue-wait periods and killing requests before
    // they reach BingX.
    return this.rateLimiter.execute(
      async () => {
        // Resolve the URL INSIDE the rate-limit slot so lazily-built signed
        // URLs carry a timestamp from send time, not queue-entry time.
        const resolvedUrl = typeof url === "function" ? url() : url

        const controller = new AbortController()
        // The rate-limiter's executeTimeoutMs fires Promise.race at this.timeout
        // already; this AbortController is a belt-and-suspenders abort so the
        // underlying TCP connection is also cleaned up on timeout.
        const timeoutId = setTimeout(() => controller.abort(), this.timeout)
        try {
          const response = await fetch(resolvedUrl, {
            ...options,
            signal: controller.signal,
          })
          clearTimeout(timeoutId)
          return response
        } catch (error) {
          clearTimeout(timeoutId)
          throw error
        }
      },
      undefined, // no caller AbortSignal — timeouts are managed by executeTimeoutMs
      this.timeout, // executeTimeoutMs: starts at dispatch, not enqueue
    )
  }

  abstract testConnection(): Promise<ExchangeConnectorResult>
  abstract getBalance(): Promise<ExchangeConnectorResult>
  abstract getCapabilities(): string[]

  // Trading Methods (Order Management)
  //
  // NOTE: the 6th `options` param is optional; subclasses that don't yet
  // understand reduce-only / positionSide / hedgeMode are free to ignore it
  // (TS method parameter contravariance allows a narrower implementation).
  abstract placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType?: "limit" | "market",
    options?: PlaceOrderOptions
  ): Promise<{ success: boolean; orderId?: string; error?: string }>

  /**
   * Place a CONDITIONAL (stop / take-profit) order.
   *
   * Why it exists: a regular LIMIT order placed at the trigger price is
   * NOT a stop-loss. For SL on a long it's a sell-limit *below* market —
   * which most exchanges reject as an aggressive reduce-only, or worse,
   * fill instantly at the current bid. The result is no actual exchange
   * protection at all. A real SL/TP on perp exchanges is a separate
   * conditional order family (BingX `STOP_MARKET` / `TAKE_PROFIT_MARKET`,
   * Bybit `triggerPrice` + `triggerDirection`, etc.).
   *
   * The default implementation here delegates to `placeOrder` with a
   * limit at the trigger price — which is the legacy behaviour, kept as
   * a fallback so connectors without native conditional-order support
   * continue to compile and operate without code changes. Connectors
   * that DO support conditional orders MUST override this method.
   *
   * @param closeSide       Order side that CLOSES the position
   *                        (sell for a long, buy for a short).
   * @param triggerPrice    Absolute price at which the conditional order
   *                        becomes a market order on the exchange.
   * @param kind            "stop_loss" or "take_profit" — connectors
   *                        use this to pick the correct trigger
   *                        direction and / or order type.
   */
  async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    // Mark `kind` as intentionally consumed — base impl is exchange-agnostic.
    void kind
    return this.placeOrder(symbol, closeSide, quantity, triggerPrice, "limit", options)
  }

  abstract cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }>

  abstract getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null>

  abstract getOpenOrders(symbol?: string): Promise<ExchangeOrder[]>

  abstract getOrderHistory(symbol?: string, limit?: number): Promise<ExchangeOrder[]>

  // Position Methods (Perpetual/Futures Only)
  abstract getPositions(symbol?: string): Promise<ExchangePosition[]>

  abstract getPosition(symbol: string, direction?: "long" | "short"): Promise<ExchangePosition | null>

  abstract modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated"
  ): Promise<{ success: boolean; error?: string }>

  abstract closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }>

  // Funding Methods (Deposits/Withdrawals)
  abstract getDepositAddress(coin: string): Promise<{ address?: string; error?: string }>

  abstract withdraw(coin: string, address: string, amount: number): Promise<{ success: boolean; txId?: string; error?: string }>

  abstract getTransferHistory(limit?: number): Promise<Array<{ type: string; coin: string; amount: number; timestamp: number }>>

  // Risk Management Methods
  abstract setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }>

  abstract setMarginType(symbol: string, marginType: "cross" | "isolated"): Promise<{ success: boolean; error?: string }>

  abstract setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }>

  abstract getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null>

  abstract getOHLCV(symbol: string, timeframe?: string, limit?: number): Promise<Array<{timestamp: number; open: number; high: number; low: number; close: number; volume: number}> | null>

  async getTopSymbols(_limit?: number): Promise<string[]> {
    return []
  }

  /**
   * Validate API type is supported for the exchange
   * @param exchange - Exchange name (e.g., "bybit", "bingx")
   * @param apiType - API type to validate (e.g., "spot", "perpetual_futures")
   * @returns true if valid, false if not
   */
  static validateApiType(exchange: string, apiType?: string): boolean {
    if (!apiType) return true // Undefined is OK, will use default

    const supported = EXCHANGE_API_TYPES[exchange.toLowerCase()]
    if (!supported) {
      console.warn(`[v0] [Connector] Unknown exchange: ${exchange}`)
      return false
    }

    const isValid = supported.includes(apiType)
    if (!isValid) {
      console.warn(`[v0] [Connector] Invalid API type '${apiType}' for ${exchange}. Supported: ${supported.join(", ")}`)
    }

    return isValid
  }

  /**
   * Get supported API types for an exchange
   * @param exchange - Exchange name
   * @returns Array of supported API types
   */
  static getSupportedApiTypes(exchange: string): string[] {
    return EXCHANGE_API_TYPES[exchange.toLowerCase()] || []
  }
}
