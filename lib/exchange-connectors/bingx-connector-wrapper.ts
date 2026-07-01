/**
 * BingX Connector Wrapper
 * 
 * Unified interface that routes API calls to:
 * 1. Library adapter (for instant responses with pooling) - PRIMARY
 * 2. Old REST connector (for backward compatibility) - FALLBACK
 * 
 * This allows gradual migration to the library while maintaining stability.
 * Production will use library for all calls for maximum performance.
 */

import type { ExchangeCredentials, ExchangeConnectorResult, ExchangeOrder, PlaceOrderOptions } from "./base-connector"
import { BingXConnector } from "./bingx-connector"
import { getBingXLibraryClient, type BingXLibraryClient } from "./bingx-library-adapter"

/**
 * Unified wrapper that provides instant API responses
 * Uses library adapter for operations, falls back to REST if needed
 */
export class BingXConnectorWrapper extends BingXConnector {
  private libraryClient: BingXLibraryClient | null = null
  private useLibraryMode: boolean = true

  constructor(credentials: ExchangeCredentials, useLibraryMode: boolean = true) {
    super(credentials)
    this.useLibraryMode = useLibraryMode

    // Initialize library client if enabled
    if (this.useLibraryMode) {
      try {
        this.libraryClient = getBingXLibraryClient(credentials)
        console.log("[v0] [BingXWrapper] Using library adapter for instant API responses")
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Failed to initialize library adapter, falling back to REST:", err)
        this.useLibraryMode = false
      }
    }
  }

  /**
   * Override getBalance to use library for instant response
   */
  async getBalance(): Promise<ExchangeConnectorResult<any>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const balance = await this.libraryClient.getBalance("swap")
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] getBalance completed in ${latency}ms (library)`)
        return { success: true, data: balance }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library getBalance failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.getBalance()
  }

  /**
   * Override getPositions to use library for instant response
   */
  async getPositions(symbol?: string): Promise<ExchangeConnectorResult<any[]>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const positions = await this.libraryClient.getOpenPositions(symbol)
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] getPositions completed in ${latency}ms (library)`)
        return { success: true, data: Array.isArray(positions) ? positions : [positions] }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library getPositions failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.getPositions(symbol)
  }

  /**
   * Override getOrder to use library for instant lookup
   */
  async getOrder(orderId: string, symbol?: string): Promise<ExchangeConnectorResult<ExchangeOrder>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const order = await this.libraryClient.getOrder(orderId, symbol)
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] getOrder completed in ${latency}ms (library)`)
        return { success: true, data: order }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library getOrder failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.getOrder(orderId, symbol)
  }

  /**
   * Override placeOrder to use library for instant execution
   */
  async placeOrder(symbol: string, side: string, quantity: number, options?: PlaceOrderOptions): Promise<ExchangeConnectorResult<ExchangeOrder>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const order = await this.libraryClient.placeOrder({
          symbol,
          side: side.toUpperCase() as "BUY" | "SELL",
          type: options?.type === "MARKET" ? "MARKET" : "LIMIT",
          quantity,
          price: options?.price,
          leverage: options?.leverage,
          stopPrice: options?.stopPrice,
          takeProfitPrice: options?.takeProfit,
          stopLossPrice: options?.stopLoss,
        })
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] placeOrder completed in ${latency}ms (library)`)
        return { success: true, data: order }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library placeOrder failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.placeOrder(symbol, side, quantity, options)
  }

  /**
   * Override cancelOrder to use library for instant cancellation
   */
  async cancelOrder(orderId: string, symbol?: string): Promise<ExchangeConnectorResult<any>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const result = await this.libraryClient.cancelOrder(orderId, symbol)
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] cancelOrder completed in ${latency}ms (library)`)
        return { success: true, data: result }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library cancelOrder failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.cancelOrder(orderId, symbol)
  }

  /**
   * Override setLeverage to use library for instant update
   */
  async setLeverage(symbol: string, leverage: number): Promise<ExchangeConnectorResult<any>> {
    if (this.useLibraryMode && this.libraryClient) {
      try {
        const start = Date.now()
        const result = await this.libraryClient.setLeverage(symbol, leverage)
        const latency = Date.now() - start
        console.log(`[v0] [BingXWrapper] setLeverage completed in ${latency}ms (library)`)
        return { success: true, data: result }
      } catch (err) {
        console.warn("[v0] [BingXWrapper] Library setLeverage failed, using REST fallback:", err)
      }
    }

    // Fallback to REST implementation
    return super.setLeverage(symbol, leverage)
  }

  /**
   * Switch between library and REST mode at runtime
   */
  setLibraryMode(enabled: boolean) {
    this.useLibraryMode = enabled && this.libraryClient !== null
    console.log(`[v0] [BingXWrapper] Switched to ${this.useLibraryMode ? "library (instant)" : "REST"} mode`)
  }

  /**
   * Get current mode for monitoring
   */
  getLibraryMode(): boolean {
    return this.useLibraryMode && this.libraryClient !== null
  }
}
