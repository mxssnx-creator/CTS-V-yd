// Plain `crypto` — Edge build is satisfied by the `crypto: false` alias
// in `next.config.mjs` (runtime guard in `instrumentation.ts` ensures
// the stub is never executed at request time).
import * as crypto from "crypto"
import {
  BaseExchangeConnector,
  type ExchangeCredentials,
  type ExchangeConnectorResult,
  type ExchangeOrder,
  type PlaceOrderOptions,
} from "./base-connector"
import { aggregateTradesTo1sOHLCV } from "./aggregate-1s"

/**
 * Bybit V5 Exchange Connector
 *
 * CRITICAL: Bybit V5 REST auth rules:
 *   - Auth travels in headers, NEVER in the query string:
 *       X-BAPI-API-KEY, X-BAPI-SIGN, X-BAPI-TIMESTAMP, X-BAPI-RECV-WINDOW,
 *       X-BAPI-SIGN-TYPE: 2 (HMAC-SHA256)
 *   - Signed payload differs by method:
 *       GET  → `${timestamp}${apiKey}${recvWindow}${sortedQueryString}`
 *       POST → `${timestamp}${apiKey}${recvWindow}${rawJsonBody}`
 *   - Querystring passed to a V5 endpoint must NOT include api_key, sign,
 *     recv_window, or timestamp. Those live only in headers.
 *
 * Supported API types (credentials.apiType):
 *   - "unified"           → UNIFIED account (V5 default for everything)
 *   - "perpetual_futures" → CONTRACT account (linear / inverse perps)
 *   - "spot"              → SPOT account
 *
 * Trading endpoint category is derived independently of accountType:
 *   - spot  → "spot"
 *   - *    → "linear" (USDT-M perpetual)
 *
 * Docs: https://bybit-exchange.github.io/docs/v5/intro
 */
export class BybitConnector extends BaseExchangeConnector {
  // ── Static (process-wide) time-sync state ────────────────────────────────
  //
  // Bybit enforces a 5–10s timestamp window. On Vercel the VM clock can drift
  // or a cold container may have significant skew. Sharing offset and sync state
  // statically means the first successful sync warms the cache for all
  // subsequent instances — the same approach proven with BingX.
  private static sharedTimeOffset: number = 0
  private static sharedLastSync:   number = 0
  private static sharedSyncPromise: Promise<void> | null = null
  private static lastSyncFailLogTs: number = 0

  private get  timeOffset(): number                { return BybitConnector.sharedTimeOffset }
  private set  timeOffset(v: number)               { BybitConnector.sharedTimeOffset = v }
  private get  lastTimeSync(): number              { return BybitConnector.sharedLastSync }
  private set  lastTimeSync(v: number)             { BybitConnector.sharedLastSync = v }
  private get  syncPromise(): Promise<void> | null { return BybitConnector.sharedSyncPromise }
  private set  syncPromise(v: Promise<void> | null){ BybitConnector.sharedSyncPromise = v }

  // Re-sync every 60 s. Process-wide via static sharing.
  private readonly timeSyncIntervalMs = 60_000
  // recvWindow in ms. Bybit accepts up to 5000ms by default; we use 10000
  // to absorb high-latency Vercel→Bybit links without causing strict-window
  // failures (retCode 10003 / 10004).
  private readonly recvWindowMs = 10_000
  // Small lag bias (ms): always send a timestamp slightly behind server time.
  // Bybit rejects future timestamps; being ~500ms late is absorbed by recvWindow
  // but prevents any clock-fast rejection.
  private readonly timestampLagMs = 500

  constructor(credentials: ExchangeCredentials, exchange: string = "bybit") {
    super(credentials, exchange)
    // Kick off the first time-sync in the background so the offset is
    // ready before the first signed request fires.
    this.syncPromise = this.syncServerTime().catch(() => { this.syncPromise = null })
  }

  private getBaseUrl(): string {
    return this.credentials.isTestnet ? "https://api-testnet.bybit.com" : "https://api.bybit.com"
  }

  /** Trading-endpoint category. Position / order endpoints expect this, NOT accountType. */
  private getTradingCategory(): "linear" | "spot" {
    return this.credentials.apiType === "spot" ? "spot" : "linear"
  }

  // ── Server-time sync ──────────────────────────────────────────────────────

  /**
   * Synchronize local clock with Bybit server time to prevent retCode 10003
   * ("Illegal timestamp parameter"). Uses `/v5/market/time` (public, no auth).
   */
  private async syncServerTime(): Promise<void> {
    if (Date.now() - this.lastTimeSync < this.timeSyncIntervalMs) return

    if (this.syncPromise) {
      await this.syncPromise
      return
    }

    this.syncPromise = (async () => {
      try {
        const fetchTime = async () => {
          const ctrl = new AbortController()
          const timer = setTimeout(() => ctrl.abort(), 8000)
          try {
            return await fetch(`${this.getBaseUrl()}/v5/market/time`, {
              method: "GET",
              signal: ctrl.signal,
            })
          } finally {
            clearTimeout(timer)
          }
        }

        const t0 = Date.now()
        let response: Response
        try {
          response = await fetchTime()
        } catch {
          response = await fetchTime() // one retry on transient failure
        }
        const t1 = Date.now()
        const data = await response.json().catch(() => null as any)

        // Bybit /v5/market/time response: { retCode: 0, result: { timeSecond, timeNano } }
        let serverTime = 0
        if (data?.result?.timeNano) {
          serverTime = Math.floor(Number(data.result.timeNano) / 1_000_000)
        } else if (data?.result?.timeSecond) {
          serverTime = Number(data.result.timeSecond) * 1000
        } else if (data?.time) {
          serverTime = Number(data.time)
        }

        if (serverTime > 0) {
          const rtt = t1 - t0
          const localMidpoint = t0 + rtt / 2
          const measured = serverTime - localMidpoint
          const newOffset = Math.round(measured)
          this.timeOffset = newOffset
          this.lastTimeSync = t1
          if (Math.abs(measured) > 100) {
            this.log(
              `[v0] Bybit time sync: offset=${newOffset.toFixed(0)}ms (rtt=${rtt}ms)`,
            )
          }
        }
      } catch (err) {
        const now = Date.now()
        this.lastTimeSync = now - this.timeSyncIntervalMs + 10_000 // retry in ~10s
        if (now - BybitConnector.lastSyncFailLogTs > 30_000) {
          BybitConnector.lastSyncFailLogTs = now
          this.log(`[v0] Bybit time sync failed (non-fatal): ${String(err).slice(0, 80)}`)
        }
      } finally {
        this.syncPromise = null
      }
    })()

    await this.syncPromise
  }

  /**
   * Get a corrected timestamp for use in V5 auth headers.
   * Applies the clock offset and lag bias so the timestamp is always
   * slightly behind server time — absorbs RTT noise without any risk of
   * "future timestamp" rejection.
   */
  private getTimestamp(): number {
    const offset = Number.isFinite(this.timeOffset) ? this.timeOffset : 0
    return Math.floor(Date.now() + offset - this.timestampLagMs)
  }

  /**
   * Detect Bybit timestamp errors (retCode 10003 / 10004) and force-resync.
   * Returns true if the caller should retry the request once.
   */
  private async resyncOnTimestampError(data: any): Promise<boolean> {
    const code = String(data?.retCode ?? "")
    // 10003 = "Invalid timestamp"  10004 = "Recv window expired"
    const isTimestampError = code === "10003" || code === "10004"
    if (isTimestampError) {
      this.lastTimeSync = 0
      this.syncPromise = null
      await this.syncServerTime()
      return true
    }
    return false
  }

  // ── Signing ───────────────────────────────────────────────────────────────

  /**
   * Produce the V5 HMAC signature.
   * For GET: `${timestamp}${apiKey}${recvWindow}${sortedQueryString}`
   * For POST: `${timestamp}${apiKey}${recvWindow}${rawJsonBody}`
   */
  private signV5(timestamp: string, recvWindow: string, payloadSuffix: string): string {
    const message = `${timestamp}${this.credentials.apiKey}${recvWindow}${payloadSuffix}`
    return crypto.createHmac("sha256", this.credentials.apiSecret).update(message).digest("hex")
  }

  /**
   * Build a deterministic, V5-compliant querystring from a params bag.
   * Drops undefined / null / "" values.
   */
  private toQueryString(query?: Record<string, any>): string {
    if (!query) return ""
    const parts: string[] = []
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === "") continue
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    }
    return parts.join("&")
  }

  /** Single V5-authenticated request helper used by every private method below. */
  private async signedRequestV5<T = any>(opts: {
    method: "GET" | "POST"
    path: string
    query?: Record<string, any>
    body?: Record<string, any>
  }): Promise<{ ok: boolean; data: T; status: number }> {
    const { method, path, query, body } = opts
    // Always sync before signing so the timestamp is fresh.
    await this.syncServerTime()

    const timestamp = String(this.getTimestamp())
    const recvWindow = String(this.recvWindowMs)
    const baseUrl = this.getBaseUrl()

    const queryString = method === "GET" ? this.toQueryString(query) : ""
    const rawBody = method === "POST" && body ? JSON.stringify(body) : ""
    const payloadSuffix = method === "GET" ? queryString : rawBody
    const signature = this.signV5(timestamp, recvWindow, payloadSuffix)

    const url = queryString ? `${baseUrl}${path}?${queryString}` : `${baseUrl}${path}`
    const headers: Record<string, string> = {
      "X-BAPI-API-KEY":    this.credentials.apiKey,
      "X-BAPI-SIGN":       signature,
      "X-BAPI-SIGN-TYPE":  "2",
      "X-BAPI-TIMESTAMP":  timestamp,
      "X-BAPI-RECV-WINDOW": recvWindow,
    }
    const init: RequestInit = { method, headers }
    if (method === "POST") {
      headers["Content-Type"] = "application/json"
      ;(init as any).body = rawBody
    }

    const response = await this.rateLimitedFetch(url, init)
    const data = (await this.safeJson(response)) as T
    return { ok: response.ok, data, status: response.status }
  }

  /**
   * Re-sign and retry a V5 request after a timestamp resync.
   * Receives the original opts so headers are rebuilt with fresh timestamp.
   */
  private async retryAfterResync<T = any>(opts: {
    method: "GET" | "POST"
    path: string
    query?: Record<string, any>
    body?: Record<string, any>
  }): Promise<{ ok: boolean; data: T; status: number }> {
    this.lastTimeSync = 0
    this.syncPromise = null
    await this.syncServerTime()
    return this.signedRequestV5<T>(opts)
  }

  // ── Big-number safe JSON ───────────────────────────────────────────────────

  /**
   * Safe JSON parse that preserves Bybit order ID precision.
   * Bybit emits orderId as a JSON number up to 19 digits — beyond
   * Number.MAX_SAFE_INTEGER. Same quote-wrap strategy as BingXConnector.
   */
  private async safeJson(response: Response): Promise<any> {
    const text = await response.text()
    if (!text) return {}
    const idFields = ["orderId", "orderID", "id", "clientOrderId", "orderLinkId"]
    const pattern = new RegExp(
      `("(?:${idFields.join("|")})"\\s*:\\s*)(-?\\d+)(\\s*[,}\\]])`,
      "g",
    )
    const safeText = text.replace(pattern, '$1"$2"$3')
    try {
      return JSON.parse(safeText)
    } catch {
      try { return JSON.parse(text) } catch { return {} }
    }
  }

  // ── Capabilities ──────────────────────────────────────────────────────────

  getCapabilities(): string[] {
    return [
      "unified",
      "perpetual_futures",
      "spot",
      "leverage",
      "hedge_mode",
      "trailing",
      "cross_margin",
      "isolated_margin",
      "reduce_only",
    ]
  }

  // ── Connection test ───────────────────────────────────────────────────────

  async testConnection(): Promise<ExchangeConnectorResult> {
    this.log("Starting Bybit connection test")
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

  // ── Balance ───────────────────────────────────────────────────────────────

  async getBalance(): Promise<ExchangeConnectorResult> {
    const accountType = this.getEffectiveAccountType()
    const apiType = this.credentials.apiType || "perpetual_futures"
    this.log(`Configured API Type: ${apiType} → Bybit accountType: ${accountType}`)

    const opts = {
      method: "GET" as const,
      path: "/v5/account/wallet-balance",
      query: { accountType },
    }
    let { ok, data } = await this.signedRequestV5<any>(opts)

    // Timestamp retry
    if (!ok || data?.retCode !== 0) {
      if (await this.resyncOnTimestampError(data)) {
        const retry = await this.retryAfterResync<any>(opts)
        ok = retry.ok
        data = retry.data
      }
    }

    if (!ok || data?.retCode !== 0) {
      const msg = data?.retMsg || data?.error || `HTTP error`
      this.logError(`API Error: ${msg}`)
      throw new Error(msg)
    }

    const coins = data.result?.list?.[0]?.coin || []
    const usdtCoin = coins.find((c: any) => c.coin === "USDT")
    const usdtBalance = Number.parseFloat(usdtCoin?.walletBalance || "0")

    const balances = coins.map((c: any) => ({
      asset: c.coin,
      free: Number.parseFloat(c.availableToWithdraw || c.availableToBorrow || "0"),
      locked: Number.parseFloat(c.locked || "0"),
      total: Number.parseFloat(c.walletBalance || "0"),
    }))

    this.log(`Account Balance: ${usdtBalance.toFixed(2)} USDT`)
    return {
      success: true,
      balance: usdtBalance,
      balances,
      capabilities: this.getCapabilities(),
      logs: this.logs,
    }
  }

  // ── Place order ───────────────────────────────────────────────────────────

  /**
   * Place a regular (market / limit) order on Bybit V5.
   *
   * Hedge / one-way handling:
   *   - One-way mode (default): `positionIdx = 0`.
   *   - Hedge mode: `positionIdx = 1` for LONG, `2` for SHORT.
   *
   * On retCode 10001 ("position idx not match position mode") we retry once
   * with the opposite idx convention. On retCode 10003/10004 (timestamp) we
   * resync and retry once.
   */
  async placeOrder(
    symbol: string,
    side: "buy" | "sell",
    quantity: number,
    price?: number,
    orderType: "limit" | "market" = "limit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `Invalid quantity: ${quantity}` }
      }
      // Round to 6 decimal places — matches most Bybit linear symbols and
      // avoids rounding artifacts from 8dp on low-precision tickers.
      const roundedQty = Math.round(quantity * 1e6) / 1e6
      const qtyStr = roundedQty.toFixed(6).replace(/\.?0+$/, "")
      if (roundedQty < 1e-6) {
        return { success: false, error: `Quantity too small after rounding: ${quantity}` }
      }

      const category = this.getTradingCategory()
      const hedgeMode = options.hedgeMode === true
      const explicitSide = options.positionSide
      const effectivePositionSide: "LONG" | "SHORT" = explicitSide
        ? explicitSide
        : options.reduceOnly
          ? side === "sell" ? "LONG" : "SHORT"
          : side === "buy" ? "LONG" : "SHORT"

      const body: Record<string, any> = {
        category,
        symbol,
        side: side === "buy" ? "Buy" : "Sell",
        orderType: orderType === "market" ? "Market" : "Limit",
        qty: qtyStr,
        timeInForce: orderType === "market" ? "IOC" : "GTC",
      }
      if (price && orderType === "limit") {
        const priceRounded = Math.round(price * 1e8) / 1e8
        body.price = priceRounded.toFixed(8).replace(/\.?0+$/, "")
      }
      if (options.clientOrderId) body.orderLinkId = options.clientOrderId
      if (category === "linear") {
        body.positionIdx = hedgeMode ? (effectivePositionSide === "LONG" ? 1 : 2) : 0
        if (options.reduceOnly) body.reduceOnly = true
      }

      this.log(
        `Placing ${orderType} ${side} order: ${qtyStr} ${symbol}` +
          `${options.reduceOnly ? " [reduceOnly]" : ""}` +
          ` idx=${body.positionIdx ?? "-"} cat=${category}`,
      )

      const path = "/v5/order/create"
      const opts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(opts)

      // Timestamp error → resync and retry once
      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(opts)).data
      }

      if (data?.retCode !== 0) {
        // 10001 = "position idx not match position mode"
        if (String(data?.retCode) === "10001" && category === "linear") {
          this.log("Retrying with flipped position mode (idx mismatch)")
          body.positionIdx = body.positionIdx === 0 ? (effectivePositionSide === "LONG" ? 1 : 2) : 0
          const retry = await this.signedRequestV5<any>({ method: "POST", path, body })
          if (retry.data?.retCode === 0) {
            const retryId = retry.data.result?.orderId
            if (!retryId) {
              return { success: false, error: "Bybit returned success on idx-retry but orderId was missing" }
            }
            this.log(`Order placed on idx retry: ${retryId}`)
            return { success: true, orderId: String(retryId) }
          }
          return { success: false, error: `Bybit API error: ${retry.data?.retMsg || "Unknown error"}` }
        }
        return { success: false, error: `Bybit API error (code=${data?.retCode}): ${data?.retMsg || "Unknown error"}` }
      }

      const orderId = data.result?.orderId
      if (!orderId) {
        return { success: false, error: "Bybit returned success but orderId was missing from response" }
      }
      this.log(`Order placed successfully: ${orderId}`)
      return { success: true, orderId: String(orderId) }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to place order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Place stop / take-profit order ────────────────────────────────────────

  /**
   * Bybit-native conditional order via `/v5/order/create`.
   *
   * Uses `triggerPrice` + `triggerDirection` + `orderType: "Market"` + `reduceOnly: true`.
   * This is a real stop-market / take-profit-market conditional, not a limit at the
   * trigger price (which would fill immediately or be rejected as aggressive reduce-only).
   *
   * Trigger direction matrix:
   *   long  TP  → close=sell, trigger when price RISES   (triggerDirection=1)
   *   long  SL  → close=sell, trigger when price FALLS   (triggerDirection=2)
   *   short TP  → close=buy,  trigger when price FALLS   (triggerDirection=2)
   *   short SL  → close=buy,  trigger when price RISES   (triggerDirection=1)
   *
   * Retries:
   *   - retCode 10003/10004 (timestamp)  → resync + retry once
   *   - retCode 10001 (positionIdx mismatch) → flip idx + retry once
   */
  override async placeStopOrder(
    symbol: string,
    closeSide: "buy" | "sell",
    quantity: number,
    triggerPrice: number,
    kind: "stop_loss" | "take_profit",
    options: PlaceOrderOptions = {},
  ): Promise<{ success: boolean; orderId?: string; error?: string }> {
    try {
      const category = this.getTradingCategory()
      if (category !== "linear") {
        // Spot — no native trigger order family; fall back to legacy implementation.
        return super.placeStopOrder(symbol, closeSide, quantity, triggerPrice, kind, options)
      }

      if (!Number.isFinite(quantity) || quantity <= 0) {
        return { success: false, error: `Invalid quantity: ${quantity}` }
      }
      if (!Number.isFinite(triggerPrice) || triggerPrice <= 0) {
        return { success: false, error: `Invalid trigger price: ${triggerPrice}` }
      }

      const roundedQty = Math.round(quantity * 1e6) / 1e6
      const qtyStr = roundedQty.toFixed(6).replace(/\.?0+$/, "")
      const trigRounded = Math.round(triggerPrice * 1e8) / 1e8
      const trigStr = trigRounded.toFixed(8).replace(/\.?0+$/, "")

      const hedgeMode = options.hedgeMode === true
      const positionSide: "LONG" | "SHORT" = options.positionSide
        ?? (closeSide === "sell" ? "LONG" : "SHORT")

      // Trigger direction: 1 = triggers when price rises through level,
      //                    2 = triggers when price falls through level.
      const isLong = positionSide === "LONG"
      let triggerDirection: 1 | 2
      if (kind === "take_profit") {
        triggerDirection = isLong ? 1 : 2  // TP long fires on rise; TP short fires on fall
      } else {
        triggerDirection = isLong ? 2 : 1  // SL long fires on fall; SL short fires on rise
      }

      const body: Record<string, any> = {
        category,
        symbol,
        side: closeSide === "buy" ? "Buy" : "Sell",
        orderType: "Market",
        qty: qtyStr,
        timeInForce: "IOC",
        triggerPrice: trigStr,
        triggerDirection,
        // LastPrice matches Bybit's UI default and avoids mark-vs-last drift.
        triggerBy: "LastPrice",
        reduceOnly: true,
        positionIdx: hedgeMode ? (isLong ? 1 : 2) : 0,
      }
      if (options.clientOrderId) body.orderLinkId = options.clientOrderId

      this.log(
        `Placing ${kind === "take_profit" ? "TP" : "SL"}-Market ${closeSide} ${qtyStr} ${symbol}` +
          ` @ trig=${trigStr} dir=${triggerDirection} idx=${body.positionIdx}`,
      )

      const path = "/v5/order/create"
      const reqOpts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(reqOpts)

      // Timestamp error → resync and retry once
      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(reqOpts)).data
      }

      if (data?.retCode !== 0) {
        // 10001 = positionIdx mismatch → flip and retry once
        if (String(data?.retCode) === "10001") {
          this.log("Retrying stop order with flipped position mode (idx mismatch)")
          body.positionIdx = body.positionIdx === 0 ? (isLong ? 1 : 2) : 0
          const retry = await this.signedRequestV5<any>({ method: "POST", path, body })
          if (retry.data?.retCode === 0) {
            const retryId = retry.data.result?.orderId
            if (!retryId) {
              return { success: false, error: "Bybit returned success on stop-order idx-retry but orderId was missing" }
            }
            this.log(`Stop order placed on idx retry: ${retryId}`)
            return { success: true, orderId: String(retryId) }
          }
          return { success: false, error: `Bybit stop order error (code=${retry.data?.retCode}): ${retry.data?.retMsg || "Unknown"}` }
        }
        return { success: false, error: `Bybit stop order error (code=${data?.retCode}): ${data?.retMsg || "Unknown"}` }
      }

      const orderId = data.result?.orderId
      if (!orderId) {
        // Bybit returned success but no orderId — treat as a failure so
        // the position is not marked as protected when no order actually exists.
        return { success: false, error: "Bybit returned success but orderId was missing from stop order response" }
      }
      this.log(`Stop order placed: ${orderId} @ ${trigStr}`)
      return { success: true, orderId: String(orderId) }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to place stop order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Cancel order ──────────────────────────────────────────────────────────

  async cancelOrder(symbol: string, orderId: string): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Cancelling order ${orderId} for ${symbol}`)

      const path = "/v5/order/cancel"
      const body = { category: this.getTradingCategory(), symbol, orderId }
      const opts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(opts)

      // Timestamp drift retry — a serial stuck-placed cleanup loop spanning
      // 20–30s can cause the cached offset to drift past Bybit's window.
      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(opts)).data
      }

      if (data?.retCode !== 0) {
        // retCode 110001 = "order not exist or too late to cancel"
        // Treat as non-fatal: the order was already filled/cancelled.
        if (String(data?.retCode) === "110001") {
          this.log(`Order ${orderId} already gone (110001) — treating as cancelled`)
          return { success: true }
        }
        throw new Error(`Bybit cancel error (code=${data?.retCode}): ${data?.retMsg || "Unknown error"}`)
      }
      this.log(`Order cancelled successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to cancel order: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Get order ─────────────────────────────────────────────────────────────

  async getOrder(symbol: string, orderId: string): Promise<ExchangeOrder | null> {
    try {
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/realtime",
        query: { category: this.getTradingCategory(), symbol, orderId },
      })
      if (data?.retCode !== 0) return null
      const raw = data.result?.list?.[0]
      if (!raw) return null
      return this.normalizeOrder(raw)
    } catch {
      return null
    }
  }

  /**
   * Normalize a raw Bybit V5 order object to the ExchangeOrder interface.
   * Maps Bybit's camelCase fields to the common interface with filledQty,
   * filledPrice, and status strings the engine relies on.
   */
  private normalizeOrder(raw: any): ExchangeOrder {
    const rawStatus = String(raw.orderStatus ?? raw.status ?? "").toUpperCase()
    const normalizedStatus =
      rawStatus === "FILLED"           ? "filled" :
      rawStatus === "PARTLYFILLED"     ? "partially_filled" :
      rawStatus === "PARTIALLY_FILLED" ? "partially_filled" :
      rawStatus === "CANCELLED"        ? "cancelled" :
      rawStatus === "CANCELED"         ? "cancelled" :
      rawStatus === "REJECTED"         ? "cancelled" :
      rawStatus === "NEW"              ? "pending" :
      rawStatus === "UNTRIGGERED"      ? "pending" :
      rawStatus === "TRIGGERED"        ? "pending" : "pending"

    return {
      orderId:     String(raw.orderId    ?? raw.orderLinkId ?? ""),
      symbol:      String(raw.symbol     ?? ""),
      side:        String(raw.side       ?? "").toLowerCase() === "buy" ? "buy" : "sell",
      type:        raw.orderType === "Limit" ? "limit" : "market",
      quantity:    parseFloat(String(raw.qty         ?? "0")),
      price:       parseFloat(String(raw.price       ?? raw.avgPrice ?? "0")),
      status:      normalizedStatus as ExchangeOrder["status"],
      filledQty:   parseFloat(String(raw.cumExecQty  ?? raw.leavesQty ?? "0")),
      filledPrice: parseFloat(String(raw.avgPrice    ?? raw.execPrice ?? "0")),
      timestamp:   Number(raw.createdTime ?? Date.now()),
      updateTime:  Number(raw.updatedTime ?? raw.createdTime ?? Date.now()),
    }
  }

  // ── Open orders ───────────────────────────────────────────────────────────

  async getOpenOrders(symbol?: string): Promise<ExchangeOrder[]> {
    try {
      this.log(`Fetching open orders${symbol ? ` for ${symbol}` : ""}`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/realtime",
        query: {
          category: this.getTradingCategory(),
          openOnly: 1,
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
      const list = data.result?.list || []
      return list.map((o: any) => this.normalizeOrder(o))
    } catch {
      return []
    }
  }

  // ── Order history ─────────────────────────────────────────────────────────

  async getOrderHistory(symbol?: string, limit: number = 50): Promise<ExchangeOrder[]> {
    try {
      this.log(`Fetching order history${symbol ? ` for ${symbol}` : ""} (limit: ${limit})`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/order/history",
        query: {
          category: this.getTradingCategory(),
          limit,
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
      const list = data.result?.list || []
      return list.map((o: any) => this.normalizeOrder(o))
    } catch {
      return []
    }
  }

  // ── Positions ─────────────────────────────────────────────────────────────

  async getPositions(symbol?: string): Promise<any[]> {
    if (this.credentials.apiType === "spot") {
      this.log("Positions not available for spot trading")
      return []
    }
    try {
      this.log(`Fetching positions${symbol ? ` for ${symbol}` : ""}`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/position/list",
        query: {
          category: "linear",
          ...(symbol ? { symbol } : { settleCoin: "USDT" }),
        },
      })
      if (data?.retCode !== 0) return []
      return data.result?.list || []
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to fetch positions: ${errorMsg}`)
      return []
    }
  }

  async getPosition(symbol: string, _direction?: "long" | "short"): Promise<any> {
    const positions = await this.getPositions(symbol)
    return positions.find((p: any) => Number.parseFloat(p.size || "0") > 0) || positions[0] || null
  }

  // ── Modify position ───────────────────────────────────────────────────────

  async modifyPosition(
    symbol: string,
    leverage?: number,
    marginType?: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const tasks: Array<Promise<{ success: boolean; error?: string }>> = []
      if (typeof leverage === "number") tasks.push(this.setLeverage(symbol, leverage))
      if (marginType) tasks.push(this.setMarginType(symbol, marginType))
      if (tasks.length === 0) return { success: true }
      const results = await Promise.all(tasks)
      const failed = results.find((r) => !r.success)
      if (failed) return failed
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to modify position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Close position ────────────────────────────────────────────────────────

  async closePosition(symbol: string, positionSide?: "long" | "short"): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Closing position ${symbol}${positionSide ? ` (${positionSide})` : ""}`)

      const positions = await this.getPositions(symbol)
      const leg = positionSide
        ? positions.find(
            (p: any) =>
              String(p.side || "").toLowerCase() === positionSide &&
              Number.parseFloat(p.size || "0") > 0,
          )
        : positions.find((p: any) => Number.parseFloat(p.size || "0") > 0)

      if (!leg) return { success: false, error: "No open position to close" }

      const openSide = String(leg.side || "Buy")
      const posDirection: "long" | "short" = openSide === "Buy" ? "long" : "short"
      const closeSide: "buy" | "sell" = openSide === "Buy" ? "sell" : "buy"
      const qty = Number.parseFloat(leg.size || "0")
      if (!qty || qty <= 0) return { success: false, error: "Position size is zero — nothing to close" }

      const hedgeMode = leg.positionIdx === 1 || leg.positionIdx === 2

      const result = await this.placeOrder(symbol, closeSide, qty, undefined, "market", {
        reduceOnly: true,
        hedgeMode,
        positionSide: posDirection === "long" ? "LONG" : "SHORT",
      })

      if (!result.success) return result
      this.log(`Position closed successfully`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to close position: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Deposit address ───────────────────────────────────────────────────────

  async getDepositAddress(coin: string): Promise<{ address?: string; error?: string }> {
    try {
      this.log(`Fetching deposit address for ${coin}`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/asset/deposit/query-address",
        query: { coin },
      })
      if (data?.retCode !== 0) throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
      const address = data.result?.chains?.[0]?.addressDeposit || data.result?.address
      this.log(`Deposit address retrieved`)
      return { address }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to fetch deposit address: ${errorMsg}`)
      return { error: errorMsg }
    }
  }

  // ── Withdraw ──────────────────────────────────────────────────────────────

  async withdraw(
    coin: string,
    address: string,
    amount: number,
  ): Promise<{ success: boolean; txId?: string; error?: string }> {
    try {
      this.log(`Withdrawing ${amount} ${coin}`)
      const { data } = await this.signedRequestV5<any>({
        method: "POST",
        path: "/v5/asset/withdraw/create",
        body: {
          coin,
          address,
          amount: String(amount),
          chain: coin === "USDT" ? "TRX" : coin,
          timestamp: this.getTimestamp(),
        },
      })
      if (data?.retCode !== 0) throw new Error(`Bybit API error: ${data?.retMsg || "Unknown error"}`)
      const txId = data.result?.id
      this.log(`Withdrawal initiated: ${txId}`)
      return { success: true, txId }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to withdraw: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Transfer history ──────────────────────────────────────────────────────

  async getTransferHistory(limit: number = 50): Promise<any[]> {
    try {
      this.log(`Fetching transfer history (limit: ${limit})`)
      const { data } = await this.signedRequestV5<any>({
        method: "GET",
        path: "/v5/asset/transfer/query-inter-transfer-list",
        query: { limit },
      })
      if (data?.retCode !== 0) return []
      return data.result?.list || []
    } catch {
      return []
    }
  }

  // ── Set leverage ──────────────────────────────────────────────────────────

  /**
   * Set leverage on Bybit V5.
   *
   * Fires buyLeverage and sellLeverage simultaneously so hedge-mode accounts
   * get matching leverage on both sides (same pattern as BingX's LONG+SHORT
   * dual setLeverage).
   *
   * retCode 110043 = "leverage not modified" — treat as success.
   * retCode 10003/10004 → resync + retry.
   */
  async setLeverage(symbol: string, leverage: number): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting leverage to ${leverage}x for ${symbol}`)

      const path = "/v5/position/set-leverage"
      const body = {
        category: "linear",
        symbol,
        buyLeverage: String(leverage),
        sellLeverage: String(leverage),
      }
      const opts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(opts)

      // Timestamp drift retry
      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(opts)).data
      }

      // 110043 = "leverage not modified" (same leverage already set)
      if (data?.retCode !== 0 && String(data?.retCode) !== "110043") {
        throw new Error(`Bybit leverage error (code=${data?.retCode}): ${data?.retMsg || "Unknown error"}`)
      }
      this.log(`Leverage set to ${leverage}x`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to set leverage: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Set margin type ───────────────────────────────────────────────────────

  /**
   * Switch between cross and isolated margin on Bybit V5.
   *
   * CRITICAL: We must pass the CURRENT leverage so Bybit does not reset
   * leverage to the exchange default when switching modes. We first query
   * the current leverage from the position, then send it back.
   *
   * retCode 110026 = "cross/isolated mode not changed" — treat as success.
   */
  async setMarginType(
    symbol: string,
    marginType: "cross" | "isolated",
  ): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting margin type to ${marginType} for ${symbol}`)

      // Resolve current leverage to avoid accidentally resetting it.
      let currentLeverage = "10"
      try {
        const positionData = await this.getPositions(symbol)
        const pos = positionData?.[0]
        if (pos?.leverage) {
          currentLeverage = String(Math.round(Number(pos.leverage)))
        }
      } catch {
        // Non-fatal — fall back to safe default of 10x
      }

      const path = "/v5/position/switch-isolated"
      const body: Record<string, any> = {
        category: "linear",
        symbol,
        tradeMode: marginType === "cross" ? 0 : 1,
        buyLeverage: currentLeverage,
        sellLeverage: currentLeverage,
      }
      const opts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(opts)

      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(opts)).data
      }

      // 110026 = "cross/isolated mode not changed" — already set
      if (data?.retCode !== 0 && String(data?.retCode) !== "110026") {
        throw new Error(`Bybit margin type error (code=${data?.retCode}): ${data?.retMsg || "Unknown error"}`)
      }
      this.log(`Margin type set to ${marginType}`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to set margin type: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Set position mode ─────────────────────────────────────────────────────

  /**
   * Switch Bybit V5 between one-way (0) and hedge (3) position modes.
   * retCode 110025 = "position mode not modified" — treat as success.
   */
  async setPositionMode(hedgeMode: boolean): Promise<{ success: boolean; error?: string }> {
    try {
      this.log(`Setting position mode to ${hedgeMode ? "hedge" : "one-way"}`)
      const path = "/v5/position/switch-mode"
      const body = {
        category: "linear",
        coin: "USDT",
        mode: hedgeMode ? 3 : 0, // V5: 0 = one-way, 3 = hedge (BothSides)
      }
      const opts = { method: "POST" as const, path, body }
      let { data } = await this.signedRequestV5<any>(opts)

      if (data?.retCode !== 0 && await this.resyncOnTimestampError(data)) {
        data = (await this.retryAfterResync<any>(opts)).data
      }

      // 110025 = "position mode not modified"
      if (data?.retCode !== 0 && String(data?.retCode) !== "110025") {
        throw new Error(`Bybit position mode error (code=${data?.retCode}): ${data?.retMsg || "Unknown error"}`)
      }
      this.log(`Position mode set to ${hedgeMode ? "hedge" : "one-way"}`)
      return { success: true }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error)
      this.logError(`Failed to set position mode: ${errorMsg}`)
      return { success: false, error: errorMsg }
    }
  }

  // ── Ticker ────────────────────────────────────────────────────────────────

  async getTicker(symbol: string): Promise<{ bid: number; ask: number; last: number } | null> {
    // Public endpoint — no signature required.
    try {
      const baseUrl = this.getBaseUrl()
      const category = this.getTradingCategory()
      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/tickers?category=${category}&symbol=${encodeURIComponent(symbol)}`,
      )
      const data = await response.json()
      if (data.retCode !== 0 || !data.result?.list?.[0]) return null
      const ticker = data.result.list[0]
      const bid  = Number.parseFloat(ticker.bid1Price || "0")
      const ask  = Number.parseFloat(ticker.ask1Price || "0")
      const last = Number.parseFloat(ticker.lastPrice  || "0")
      return { bid, ask, last }
    } catch {
      return null
    }
  }

  // ── OHLCV ─────────────────────────────────────────────────────────────────

  async getOHLCV(
    symbol: string,
    timeframe = "1m",
    limit = 250,
  ): Promise<
    Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null
  > {
    try {
      // 1s timeframe: aggregate from recent trades (Bybit has no sub-1m klines)
      if (timeframe === "1s") {
        const endMs = Date.now()
        const startMs = endMs - (Math.max(1, Math.min(86_400, limit)) * 1000)
        const aggregated = await this.getOHLCV1s(symbol, startMs, endMs)
        if (aggregated && aggregated.length > 0) return aggregated
        return null
      }

      const baseUrl = this.getBaseUrl()
      const category = this.getTradingCategory()
      const intervalMap: Record<string, string> = {
        "1m": "1", "3m": "3", "5m": "5", "15m": "15", "30m": "30",
        "1h": "60", "2h": "120", "4h": "240", "6h": "360", "12h": "720",
        "1d": "D", "1w": "W", "1M": "M",
      }
      const interval = intervalMap[timeframe] || "1"

      const response = await this.rateLimitedFetch(
        `${baseUrl}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${interval}&limit=${limit}`,
      )
      const contentType = response.headers.get("content-type") || ""
      if (contentType.includes("text/html") || !response.ok) return null

      const data = await response.json()
      if (data.retCode !== 0 || !data.result?.list) return null

      const candles = (data.result.list as string[][])
        .map((c) => ({
          timestamp: Number.parseInt(c[0]),
          open:      Number.parseFloat(c[1]),
          high:      Number.parseFloat(c[2]),
          low:       Number.parseFloat(c[3]),
          close:     Number.parseFloat(c[4]),
          volume:    Number.parseFloat(c[5]),
        }))
        .reverse()

      return candles
    } catch {
      return null
    }
  }

  /**
   * 1-second OHLCV: aggregates from `/v5/market/recent-trade`.
   * Bybit returns trades newest-first, capped at 1000 per page.
   */
  async getOHLCV1s(
    symbol: string,
    startMs: number,
    endMs: number,
  ): Promise<
    Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }> | null
  > {
    try {
      const baseUrl = this.getBaseUrl()
      const category = this.getTradingCategory()
      const url = `${baseUrl}/v5/market/recent-trade?category=${category}&symbol=${encodeURIComponent(symbol)}&limit=1000`
      const resp = await this.rateLimitedFetch(url)
      if (!resp.ok) return null
      const data = await resp.json()
      const rows = data?.result?.list as Array<{ time: string; price: string; size: string }> | undefined
      if (!Array.isArray(rows) || rows.length === 0) return []
      const trades = rows.map((r) => ({
        timestamp: Number(r.time),
        price:     Number(r.price),
        quantity:  Number(r.size),
      }))
      return aggregateTradesTo1sOHLCV(trades, startMs, endMs)
    } catch {
      return null
    }
  }
}
