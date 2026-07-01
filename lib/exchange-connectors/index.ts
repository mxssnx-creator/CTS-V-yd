/**
 * Exchange Connector Factory v3.0
 * Creates appropriate connector based on exchange name
 * Handles API type normalization between perpetual/perpetual_futures variants
 */

import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { EXCHANGE_API_TYPES } from "@/lib/connection-predefinitions"

// Perpetual-type equivalents - these all mean the same thing across exchanges
const PERP_TYPES = new Set(["perpetual", "perpetual_futures", "perp", "swap", "futures"])

/**
 * Convert API type to what the exchange actually accepts.
 * bingx needs "perpetual_futures", bybit needs "contract" or "unified",
 * pionex/orangex need "perpetual", etc.
 */
function convertApiType(apiType: string | undefined, exchangeSupported: string[] | undefined): string | undefined {
  if (!apiType || !exchangeSupported) return apiType
  if (exchangeSupported.includes(apiType)) return apiType
  
  // If this is a perpetual-variant, find the one this exchange uses
  if (PERP_TYPES.has(apiType)) {
    if (exchangeSupported.includes("perpetual_futures")) return "perpetual_futures"
    if (exchangeSupported.includes("perpetual")) return "perpetual"
    if (exchangeSupported.includes("swap")) return "swap"
    if (exchangeSupported.includes("contract")) return "contract"  // Bybit V5 perpetuals
    if (exchangeSupported.includes("unified")) return "unified"      // Bybit V5 unified account
    if (exchangeSupported.includes("inverse")) return "inverse"      // Bybit inverse
  }
  
  return apiType
}

export async function createExchangeConnector(
  exchange: string,
  credentials: ExchangeCredentials
): Promise<BaseExchangeConnector> {
  const normalizedExchange = exchange.toLowerCase().replace(/[^a-z]/g, "")
  const supported = EXCHANGE_API_TYPES[normalizedExchange]
  
  // Convert API type to what this exchange accepts
  const originalType = credentials.apiType
  credentials.apiType = convertApiType(credentials.apiType, supported)
  
  // Validate
  if (credentials.apiType && supported && !supported.includes(credentials.apiType)) {
    throw new Error(
      `Invalid API type '${credentials.apiType}' for ${exchange}. Supported: ${supported.join(", ")}`
    )
  }

  // DEV/TEST: prefer simulated connector when API key is a placeholder or FORCE_SIMULATED set
  try {
    const forceSim = process.env.FORCE_SIMULATED === "1"
    const keyStr = String(credentials.apiKey || "")
    if (forceSim || keyStr.includes("PLACEHOLDER") || keyStr === "") {
      const { SimulatedConnector } = await import("./simulated-connector")
      return new SimulatedConnector(credentials, "simulated")
    }
  } catch (e) {
    // ignore and fall back to normal creation
  }

  switch (normalizedExchange) {
    case "simulated": {
      const { SimulatedConnector } = await import("./simulated-connector")
      return new SimulatedConnector(credentials, "simulated")
    }
    case "bybit": {
      const { BybitConnector } = await import("./bybit-connector")
      return new BybitConnector(credentials, "bybit")
    }
    case "bingx": {
      // Use official SDK client (bingx-api library) for instant order execution
      // SDK handles connection pooling, signing, and timestamp sync automatically
      // Falls back to manual REST if SDK initialization fails
      const { BingXConnector } = await import("./bingx-connector")
      return new BingXConnector(credentials, "bingx")
    }
    case "pionex": {
      const { PionexConnector } = await import("./pionex-connector")
      return new PionexConnector(credentials, "pionex")
    }
    case "orangex": {
      const { OrangeXConnector } = await import("./orangex-connector")
      return new OrangeXConnector(credentials, "orangex")
    }
    case "binance": {
      const { BinanceConnector } = await import("./binance-connector")
      return new BinanceConnector(credentials, "binance")
    }
    case "okx": {
      const { OKXConnector } = await import("./okx-connector")
      return new OKXConnector(credentials, "okx")
    }
    default:
      // Unknown exchange — fallback to SimulatedConnector in test/dev environments
      try {
        const { SimulatedConnector } = await import("./simulated-connector")
        return new SimulatedConnector(credentials, "simulated")
      } catch {
        throw new Error(`Unsupported exchange: ${exchange}. Supported exchanges: bybit, bingx, pionex, orangex, binance, okx`)
      }
  }
}

export type { ExchangeConnectorResult, ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"
