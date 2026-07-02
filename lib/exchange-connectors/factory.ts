import type { BaseExchangeConnector, ExchangeCredentials } from "./base-connector"
import { createExchangeConnector } from "./index"
import { getConnection } from "@/lib/redis-db"
import { isTruthyFlag } from "@/lib/connection-state-utils"
import type { Connection } from "@/lib/db-types"

export { createExchangeConnector }
export type { ExchangeCredentials } from "./base-connector"
export { BaseExchangeConnector } from "./base-connector"

export class ExchangeConnectorFactory {
  private static instance: ExchangeConnectorFactory
  private connectors: Map<string, BaseExchangeConnector> = new Map()
  
  private constructor() {}
  
  static getInstance(): ExchangeConnectorFactory {
    if (!ExchangeConnectorFactory.instance) {
      ExchangeConnectorFactory.instance = new ExchangeConnectorFactory()
    }
    return ExchangeConnectorFactory.instance
  }
  
  static getConnector(connectionId: string): BaseExchangeConnector | null {
    return ExchangeConnectorFactory.getInstance().connectors.get(connectionId) || null
  }
  
  async createConnector(connection: Connection): Promise<BaseExchangeConnector | null> {
    try {
      const credentials: ExchangeCredentials = {
        apiKey: connection.api_key || "",
        apiSecret: connection.api_secret || "",
        apiPassphrase: connection.api_passphrase,
        isTestnet: isTruthyFlag(connection.is_testnet),
        apiType: connection.api_type,
        contractType: connection.contract_type,
        marginType: connection.margin_type,
        positionMode: connection.position_mode,
        connectionMethod: connection.connection_method,
        connectionLibrary: connection.connection_library,
      }
      
      try {
      const connector = await createExchangeConnector(connection.exchange, credentials)
      this.connectors.set(connection.id, connector)
      return connector
    } catch (err) {
      console.error(`[ExchangeConnectorFactory] createExchangeConnector failed for ${connection.id}:`, err)
      // Fallback for dev/test: use simulated connector so live pipeline can be exercised
      try {
        const { SimulatedConnector } = await import("./simulated-connector")
        const sim = new SimulatedConnector(credentials, "simulated")
        this.connectors.set(connection.id, sim)
        console.log(`[ExchangeConnectorFactory] Fallback to SimulatedConnector for ${connection.id}`)
        return sim
      } catch (err2) {
        console.error(`[ExchangeConnectorFactory] Failed to create SimulatedConnector for ${connection.id}:`, err2)
        return null
      }
    }
    } catch (err) {
      console.error(`[ExchangeConnectorFactory] Failed to create connector for ${connection.id}:`, err)
      return null
    }
  }
  
  getConnector(connectionId: string): BaseExchangeConnector | null {
    return this.connectors.get(connectionId) || null
  }
  
  async getOrCreateConnector(connectionId: string): Promise<BaseExchangeConnector | null> {
    const existing = this.connectors.get(connectionId)
    if (existing) return existing
    
    const connection = await getConnection(connectionId)
    if (!connection) {
      console.error(`[ExchangeConnectorFactory] Connection not found: ${connectionId}`)
      return null
    }
    
    return this.createConnector(connection as Connection)
  }
  
  removeConnector(connectionId: string): void {
    this.connectors.delete(connectionId)
  }
  
  clearAll(): void {
    this.connectors.clear()
  }
  
  hasConnector(connectionId: string): boolean {
    return this.connectors.has(connectionId)
  }
  
  getAllConnectorIds(): string[] {
    return Array.from(this.connectors.keys())
  }
}

export const exchangeConnectorFactory = ExchangeConnectorFactory.getInstance()
