/**
 * Connection Coordinator v3
 * Comprehensive connection management with API type support, rate limiting, and batch operations
 * Uses Redis for persistent storage
 */

import { initRedis, getAllConnections, getConnection as getConnectionFromRedis } from "@/lib/redis-db"
import { SystemLogger } from "@/lib/system-logger"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { BatchProcessor } from "@/lib/batch-processor"
import { getRateLimiter } from "@/lib/rate-limiter"
import { isTruthyFlag } from "@/lib/connection-state-utils"

export type ConnectionApiType = "rest" | "websocket" | "unified" | "perpetual_futures" | "spot" | "margin"
export type ConnectionStatus = "active" | "inactive" | "error" | "testing" | "paused"

export interface Connection {
  id: string
  name: string
  exchange: string
  api_key: string
  api_secret: string
  api_passphrase?: string
  api_type: string
  contract_type?: string
  connection_method: string
  connection_library: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
  is_enabled: boolean
  is_enabled_dashboard: boolean
  is_active: boolean
  is_predefined: boolean
}

export interface ConnectionHealth {
  connectionId: string
  status: ConnectionStatus
  lastCheck: Date
  responseTime: number
  errorCount: number
  successCount: number
  uptime: number // percentage
  rateLimitUsage: number // percentage
}

export interface ConnectionMetrics {
  totalRequests: number
  successfulRequests: number
  failedRequests: number
  averageResponseTime: number
  rateLimitHits: number
  lastErrorMessage?: string
  lastSuccessTime?: Date
}

/**
 * ConnectionCoordinator - Manages all exchange connections with health monitoring
 */
export class ConnectionCoordinator {
  private static instance: ConnectionCoordinator
  private connections: Map<string, Connection> = new Map()
  private health: Map<string, ConnectionHealth> = new Map()
  private metrics: Map<string, ConnectionMetrics> = new Map()
  private batchProcessor: BatchProcessor
  private healthCheckInterval: NodeJS.Timeout | null = null
  private initialized = false

  private isEnabledFlag(value: unknown): boolean {
    return value === true || value === 1 || value === "1" || value === "true"
  }

  private constructor() {
    this.batchProcessor = BatchProcessor.getInstance()
  }

  static getInstance(): ConnectionCoordinator {
    if (!ConnectionCoordinator.instance) {
      ConnectionCoordinator.instance = new ConnectionCoordinator()
    }
    return ConnectionCoordinator.instance
  }

  /**
   * Initialize all connections from Redis
   */
  async initializeConnections(): Promise<void> {
    if (this.initialized) {
      console.log("[v0] ConnectionCoordinator already initialized")
      return
    }

    try {
      await initRedis()
      const connections = await getAllConnections()
      
      if (!Array.isArray(connections)) {
        console.error("[v0] Connections is not an array")
        return
      }

      this.connections.clear()
      for (const conn of connections) {
        this.connections.set(conn.id, conn)
        this.initializeMetrics(conn.id)
        this.initializeHealth(conn.id, conn)
      }

      this.initialized = true
      console.log(`[v0] ConnectionCoordinator initialized with ${this.connections.size} connections from Redis`)
      this.startHealthChecks()
    } catch (error) {
      console.error("[v0] Failed to initialize connections:", error)

    }
  }

  /**
   * Initialize metrics for a connection
   */
  private initializeMetrics(connectionId: string): void {
    this.metrics.set(connectionId, {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
      rateLimitHits: 0,
    })
  }

  /**
   * Initialize health for a connection
   */
  private initializeHealth(connectionId: string, connection: Connection): void {
    this.health.set(connectionId, {
      connectionId,
      status: this.isEnabledFlag(connection.is_enabled) ? "active" : "inactive",
      lastCheck: new Date(),
      responseTime: 0,
      errorCount: 0,
      successCount: 0,
      uptime: 100,
      rateLimitUsage: 0,
    })
  }

  /**
   * Start periodic health checks
   */
  private startHealthChecks(): void {
    // Run health checks every 5 minutes
    this.healthCheckInterval = setInterval(() => {
      this.performHealthChecks()
    }, 300000)

    // Initial health check
    this.performHealthChecks()
  }

  /**
   * Check if a connection has valid (non-placeholder) API credentials.
   * Predefined/base connections are valid when inserted and credentialed.
   */
  private hasValidCredentials(conn: any): boolean {
    // Must be explicitly inserted and dashboard-enabled for runtime checks.
    const isInserted = conn.is_inserted === true || conn.is_inserted === "true" || conn.is_inserted === "1" || conn.is_inserted === 1
    const isActiveInserted = conn.is_active_inserted === true || conn.is_active_inserted === "true" || conn.is_active_inserted === "1" || conn.is_active_inserted === 1
    const isDashboardEnabled = conn.is_enabled_dashboard === true || conn.is_enabled_dashboard === "true" || conn.is_enabled_dashboard === "1" || conn.is_enabled_dashboard === 1
    if (!isInserted || !isActiveInserted || !isDashboardEnabled) return false

    const key = conn.api_key
    const secret = conn.api_secret
    if (!key || key === "" || key.length < 16) return false
    if (!secret || secret === "" || secret.length < 16) return false
    if (key.includes("PLACEHOLDER") || key.includes("00998877") || key.startsWith("test")) return false
    if (secret.includes("PLACEHOLDER") || secret.includes("00998877") || secret.startsWith("test")) return false
    return true
  }

  /**
   * Perform health checks on all active connections
   * Only checks connections that are inserted, enabled, AND have valid API credentials
   */
  private async performHealthChecks(): Promise<void> {
    const eligible = Array.from(this.connections.values())
      .filter((conn) => this.isEnabledFlag(conn.is_enabled) && this.hasValidCredentials(conn))

    if (eligible.length === 0) return

    console.log(`[v0] Starting health checks on ${eligible.length} eligible connections`)

    const tasks = eligible.map((conn) => ({
        id: `health-${conn.id}`,
        connectionId: conn.id,
        operation: "health-check" as const,
        priority: 5,
      }))

    this.batchProcessor.enqueueBatch(tasks)
  }

  /**
   * Test a single connection
   */
  async testConnection(connectionId: string): Promise<{
    success: boolean
    balance?: number
    error?: string
    logs?: string[]
  }> {
    // Ensure coordinator is initialized
    if (!this.initialized) {
      await this.initializeConnections()
    }

    // Reload connection from Redis to get fresh credentials
    try {
      await initRedis()
      const freshConnection = await getConnectionFromRedis(connectionId)
      
      if (freshConnection) {
        this.connections.set(connectionId, freshConnection)
      }
    } catch (error) {
      console.error("[v0] Failed to reload connection from Redis:", error)
    }

    const connection = this.connections.get(connectionId)
    if (!connection) {
      return { success: false, error: "Connection not found" }
    }

    const startTime = Date.now()

    try {
      if (!this.hasValidCredentials(connection)) {
        return { success: false, error: "API credentials not configured or using placeholder values" }
      }

      const connector = await createExchangeConnector(connection.exchange, {
        apiKey: connection.api_key,
        apiSecret: connection.api_secret,
        apiPassphrase: connection.api_passphrase,
        apiType: connection.api_type,
        contractType: connection.contract_type,
        isTestnet: isTruthyFlag(connection.is_testnet),
      })

      const result = await connector.testConnection()
      const duration = Date.now() - startTime

      this.updateMetrics(connectionId, true, duration)
      this.updateHealth(connectionId, true, duration)

      return {
        success: result.success,
        balance: result.balance,
        logs: result.logs,
      }
    } catch (error) {
      const duration = Date.now() - startTime
      this.updateMetrics(connectionId, false, duration)
      this.updateHealth(connectionId, false, duration)

      const errorMessage = error instanceof Error ? error.message : "Unknown error"
      return {
        success: false,
        error: errorMessage,
      }
    }
  }

  /**
   * Test multiple connections in batch
   */
  async testConnections(connectionIds: string[]): Promise<Map<string, { success: boolean; error?: string }>> {
    const results = new Map()

    for (const connectionId of connectionIds) {
      const result = await this.testConnection(connectionId)
      results.set(connectionId, result)
    }

    return results
  }

  /**
   * Update metrics for a connection
   */
  private updateMetrics(connectionId: string, success: boolean, duration: number): void {
    const metrics = this.metrics.get(connectionId)
    if (!metrics) return

    metrics.totalRequests++
    if (success) {
      metrics.successfulRequests++
      metrics.lastSuccessTime = new Date()
    } else {
      metrics.failedRequests++
    }

    // Update average response time
    metrics.averageResponseTime =
      (metrics.averageResponseTime * (metrics.totalRequests - 1) + duration) / metrics.totalRequests
  }

  /**
   * Update health status for a connection
   */
  private updateHealth(connectionId: string, success: boolean, duration: number): void {
    const health = this.health.get(connectionId)
    if (!health) return

    health.lastCheck = new Date()
    health.responseTime = duration

    if (success) {
      health.successCount++
      health.status = "active"
    } else {
      health.errorCount++
      health.status = health.errorCount > 3 ? "error" : "active"
    }

    // Calculate uptime percentage
    const total = health.successCount + health.errorCount
    health.uptime = total > 0 ? (health.successCount / total) * 100 : 100
  }

  /**
   * Get connection health
   */
  getConnectionHealth(connectionId: string): ConnectionHealth | undefined {
    return this.health.get(connectionId)
  }

  /**
   * Get all connections health
   */
  getAllConnectionsHealth(): ConnectionHealth[] {
    return Array.from(this.health.values())
  }

  /**
   * Get connection metrics
   */
  getConnectionMetrics(connectionId: string): ConnectionMetrics | undefined {
    return this.metrics.get(connectionId)
  }

  /**
   * Get all connections metrics
   */
  getAllConnectionsMetrics(): ConnectionMetrics[] {
    return Array.from(this.metrics.values())
  }

  /**
   * Get connection by ID
   */
  getConnection(connectionId: string): Connection | undefined {
    return this.connections.get(connectionId)
  }

  /**
   * Get all connections
   */
  getAllConnections(): Connection[] {
    return Array.from(this.connections.values())
  }

  /**
   * Get connections by exchange
   */
  getConnectionsByExchange(exchange: string): Connection[] {
    return Array.from(this.connections.values()).filter(
      (conn) => conn.exchange.toLowerCase() === exchange.toLowerCase(),
    )
  }

  /**
   * Get connections by API type
   */
  getConnectionsByApiType(apiType: ConnectionApiType): Connection[] {
    return Array.from(this.connections.values()).filter((conn) => conn.api_type === apiType)
  }

  /**
   * Get active connections
   */
  getActiveConnections(): Connection[] {
    return Array.from(this.connections.values()).filter((conn) => this.isEnabledFlag(conn.is_enabled) && this.isEnabledFlag(conn.is_active))
  }

  /**
   * Reload connections from storage
   */
  async reloadConnections(): Promise<void> {
    this.initialized = false
    await this.initializeConnections()
  }

  /**
   * Stop health checks
   */
  stop(): void {
    if (this.healthCheckInterval) {
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
  }

  /**
   * Cleanup old health data
   */
  cleanup(): void {
    this.batchProcessor.clearOldResults()
    console.log("[v0] ConnectionCoordinator cleanup completed")
  }
}
