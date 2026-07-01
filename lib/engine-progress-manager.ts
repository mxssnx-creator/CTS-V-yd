/**
 * Engine Progress Manager
 * Unified progress tracking for prehistoric data loading, WebSocket data, 
 * async per-symbol processing, continuous indication/strategy processing
 */

import { getRedisClient, getSettings, setSettings } from "@/lib/redis-db"

// ============================================
// Types
// ============================================

export interface SymbolProgress {
  symbol: string
  // Prehistoric data
  prehistoricLoaded: boolean
  prehistoricCandles: number
  prehistoricErrors: number
  prehistoricDuration: number // ms
  // WebSocket data
  wsConnected: boolean
  wsMessagesReceived: number
  wsErrors: number
  wsLastUpdate: string | null
  // Processing
  indicationCycles: number
  strategyCycles: number
  realtimeCycles: number
  lastIndicationTime: string | null
  lastStrategyTime: string | null
  lastRealtimeTime: string | null
  // Errors
  totalErrors: number
  lastError: string | null
}

export interface IndicationTypeMetrics {
  type: string
  evaluations: number
  passed: number
  failed: number
  passRate: number
  avgConfidence: number
  avgStrength: number
}

export interface StrategyStageMetrics {
  stage: 'base' | 'main' | 'real'
  setsCount: number
  evaluated: number
  passed: number
  failed: number
  passRate: number
  avgProfitFactor: number
  avgDrawdownTime: number // minutes
  // Real-stage specific: average position evaluation score (0–1)
  avgPosEvalReal?: number
  // Extra detail fields for prehistoric display
  timeframeSeconds?: number
  intervalsProcessed?: number
  missingIntervalsLoaded?: number
  rangeDays?: number
}

export interface EngineProgressState {
  connectionId: string
  // Overall
  status: 'initializing' | 'loading' | 'processing' | 'running' | 'error' | 'stopped'
  startedAt: string | null
  // Prehistoric
  prehistoricTotalSymbols: number
  prehistoricLoadedSymbols: number
  prehistoricInProgress: boolean
  prehistoricCompleted: boolean
  prehistoricTotalCandles: number
  prehistoricErrors: number
  prehistoricDuration: number // ms
  // WebSocket
  wsSymbolsConnected: number
  wsTotalSymbols: number
  wsMessagesTotal: number
  wsErrorsTotal: number
  wsLastUpdate: string | null
  // Continuous processing
  totalIndicationCycles: number
  totalStrategyCycles: number
  totalRealtimeCycles: number
  lastCycleTime: string | null
  // Indication metrics by type
  indicationMetrics: Record<string, IndicationTypeMetrics>
  // Strategy metrics by stage
  strategyMetrics: {
    base: StrategyStageMetrics
    main: StrategyStageMetrics
    real: StrategyStageMetrics
  }
  // Batch operations metrics (NEW)
  batchOperationMetrics: {
    totalBatches: number
    successfulBatches: number
    failedBatches: number
    totalOrdersPlaced: number
    totalOrdersFailed: number
    totalOrdersCancelled: number
    lastBatchTime: string | null
    avgBatchSize: number
  }
  // Close operations metrics (NEW)
  closeOperationMetrics: {
    totalClosures: number
    automatedCloses: number
    manualCloses: number
    bulkCloses: number
    closeSuccessRate: number
    lastCloseTime: string | null
  }
  // Order query metrics (NEW)
  orderQueryMetrics: {
    totalQueries: number
    queryTypes: Record<string, number>
    lastQueryTime: string | null
    cacheSizeBytes: number
  }
  // Safety metrics (NEW)
  safetyMetrics: {
    killSwitchesActivated: number
    killSwitchesTriggered: number
    emergencyCloseCount: number
    lastKillSwitchTime: string | null
  }
  // Per-symbol progress
  symbols: Record<string, SymbolProgress>
  // Errors
  errors: Array<{
    timestamp: string
    symbol: string | null
    type: string
    message: string
  }>
  // Logs
  logs: Array<{
    timestamp: string
    level: 'info' | 'warn' | 'error'
    message: string
    data?: Record<string, any>
  }>
}

// ============================================
// Engine Progress Manager Class
// ============================================

export class EngineProgressManager {
  private connectionId: string
  private state: EngineProgressState
  private lastSaveAt = 0
  private pendingSave: Promise<void> | null = null
  private static readonly SAVE_THROTTLE_MS = 500

  constructor(connectionId: string) {
    this.connectionId = connectionId
    this.state = this.createInitialState(connectionId)
  }

  private createInitialState(connectionId: string): EngineProgressState {
    return {
      connectionId,
      status: 'initializing',
      startedAt: null,
      prehistoricTotalSymbols: 0,
      prehistoricLoadedSymbols: 0,
      prehistoricInProgress: false,
      prehistoricCompleted: false,
      prehistoricTotalCandles: 0,
      prehistoricErrors: 0,
      prehistoricDuration: 0,
      wsSymbolsConnected: 0,
      wsTotalSymbols: 0,
      wsMessagesTotal: 0,
      wsErrorsTotal: 0,
      wsLastUpdate: null,
      totalIndicationCycles: 0,
      totalStrategyCycles: 0,
      totalRealtimeCycles: 0,
      lastCycleTime: null,
      indicationMetrics: {},
      strategyMetrics: {
        base: { stage: 'base', setsCount: 0, evaluated: 0, passed: 0, failed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0, avgPosEvalReal: 0 },
        main: { stage: 'main', setsCount: 0, evaluated: 0, passed: 0, failed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0, avgPosEvalReal: 0 },
        real: { stage: 'real', setsCount: 0, evaluated: 0, passed: 0, failed: 0, passRate: 0, avgProfitFactor: 0, avgDrawdownTime: 0, avgPosEvalReal: 0 },
      },
      // NEW: Batch operation metrics
      batchOperationMetrics: {
        totalBatches: 0,
        successfulBatches: 0,
        failedBatches: 0,
        totalOrdersPlaced: 0,
        totalOrdersFailed: 0,
        totalOrdersCancelled: 0,
        lastBatchTime: null,
        avgBatchSize: 0,
      },
      // NEW: Close operation metrics
      closeOperationMetrics: {
        totalClosures: 0,
        automatedCloses: 0,
        manualCloses: 0,
        bulkCloses: 0,
        closeSuccessRate: 0,
        lastCloseTime: null,
      },
      // NEW: Order query metrics
      orderQueryMetrics: {
        totalQueries: 0,
        queryTypes: {},
        lastQueryTime: null,
        cacheSizeBytes: 0,
      },
      // NEW: Safety metrics
      safetyMetrics: {
        killSwitchesActivated: 0,
        killSwitchesTriggered: 0,
        emergencyCloseCount: 0,
        lastKillSwitchTime: null,
      },
      symbols: {},
      errors: [],
      logs: [],
    }
  }

  // ============================================
  // State Management
  // ============================================

  async loadState(): Promise<void> {
    try {
      const client = getRedisClient()
      const key = `engine_progress:${this.connectionId}`
      const data = await client.get(key)
      if (data) {
        const parsed = JSON.parse(data)
        this.state = { ...this.state, ...parsed }
      }
    } catch (error) {
      console.error(`[ProgressManager] Failed to load state for ${this.connectionId}:`, error)
    }
  }

  async saveState(): Promise<void> {
    const now = Date.now()
    if (this.pendingSave) return this.pendingSave
    if (now - this.lastSaveAt < EngineProgressManager.SAVE_THROTTLE_MS) {
      this.pendingSave = new Promise((resolve) => {
        const delay = EngineProgressManager.SAVE_THROTTLE_MS - (now - this.lastSaveAt)
        setTimeout(() => {
          this.pendingSave = null
          this.saveState().then(resolve).catch(() => resolve())
        }, delay).unref?.()
      })
      return this.pendingSave
    }

    try {
      const client = getRedisClient()
      const key = `engine_progress:${this.connectionId}`
      await client.set(key, JSON.stringify(this.state), { EX: 86400 }) // 24h TTL
      this.lastSaveAt = Date.now()
    } catch (error) {
      console.error(`[ProgressManager] Failed to save state for ${this.connectionId}:`, error)
    }
  }

  getState(): EngineProgressState {
    return { ...this.state }
  }

  // ============================================
  // Status Updates
  // ============================================

  async setStatus(status: EngineProgressState['status']): Promise<void> {
    this.state.status = status
    if (status === 'running' && !this.state.startedAt) {
      this.state.startedAt = new Date().toISOString()
    }
    this.addLog('info', `Status changed to: ${status}`)
    await this.saveState()
  }

  // ============================================
  // Prehistoric Data Tracking
  // ============================================

  async setPrehistoricTotal(symbols: number): Promise<void> {
    this.state.prehistoricTotalSymbols = symbols
    this.addLog('info', `Prehistoric data: ${symbols} symbols to load`)
    await this.saveState()
  }

  async updateSymbolPrehistoric(symbol: string, candles: number, errors: number, duration: number, completed: boolean): Promise<void> {
    if (!this.state.symbols[symbol]) {
      this.state.symbols[symbol] = this.createSymbolProgress(symbol)
    }
    const sp = this.state.symbols[symbol]
    const wasLoaded = sp.prehistoricLoaded
    const previousCandles = sp.prehistoricCandles || 0
    const previousErrors = sp.prehistoricErrors || 0
    const previousDuration = sp.prehistoricDuration || 0

    if (completed && !wasLoaded) {
      this.state.prehistoricLoadedSymbols++
    } else if (!completed && wasLoaded) {
      this.state.prehistoricLoadedSymbols = Math.max(0, this.state.prehistoricLoadedSymbols - 1)
    }

    this.state.prehistoricTotalCandles = Math.max(0, this.state.prehistoricTotalCandles + candles - previousCandles)
    this.state.prehistoricErrors = Math.max(0, this.state.prehistoricErrors + errors - previousErrors)
    this.state.prehistoricDuration = Math.max(0, this.state.prehistoricDuration + duration - previousDuration)

    sp.prehistoricCandles = candles
    sp.prehistoricErrors = errors
    sp.prehistoricDuration = duration
    sp.prehistoricLoaded = completed

    this.addLog('info', `Symbol ${symbol}: ${candles} candles loaded in ${duration}ms (${errors} errors)`)
    await this.saveState()
  }

  async setPrehistoricInProgress(inProgress: boolean): Promise<void> {
    this.state.prehistoricInProgress = inProgress
    if (inProgress) {
      this.state.status = 'loading'
    }
    await this.saveState()
  }

  async setPrehistoricCompleted(completed: boolean): Promise<void> {
    this.state.prehistoricCompleted = completed
    if (completed) {
      this.addLog('info', `Prehistoric data complete: ${this.state.prehistoricLoadedSymbols}/${this.state.prehistoricTotalSymbols} symbols, ${this.state.prehistoricTotalCandles} candles`)
    }
    await this.saveState()
  }

  // ============================================
  // WebSocket Tracking
  // ============================================

  async setWSTotalSymbols(total: number): Promise<void> {
    this.state.wsTotalSymbols = total
    await this.saveState()
  }

  async updateSymbolWS(symbol: string, connected: boolean, messages: number, errors: number): Promise<void> {
    if (!this.state.symbols[symbol]) {
      this.state.symbols[symbol] = this.createSymbolProgress(symbol)
    }
    const sp = this.state.symbols[symbol]
    const wasConnected = sp.wsConnected
    const messageDelta = Math.max(0, messages - (sp.wsMessagesReceived || 0))
    const errorDelta = Math.max(0, errors - (sp.wsErrors || 0))

    this.state.wsMessagesTotal += messageDelta
    this.state.wsErrorsTotal += errorDelta
    if (connected && !wasConnected) {
      this.state.wsSymbolsConnected++
    } else if (!connected && wasConnected) {
      this.state.wsSymbolsConnected = Math.max(0, this.state.wsSymbolsConnected - 1)
    }

    sp.wsConnected = connected
    sp.wsMessagesReceived = messages
    sp.wsErrors = errors
    sp.wsLastUpdate = new Date().toISOString()
    this.state.wsLastUpdate = new Date().toISOString()
    await this.saveState()
  }

  // ============================================
  // Processing Cycle Tracking
  // ============================================

  async incrementIndicationCycle(symbol: string | null): Promise<void> {
    this.state.totalIndicationCycles++
    this.state.lastCycleTime = new Date().toISOString()
    if (symbol && this.state.symbols[symbol]) {
      this.state.symbols[symbol].indicationCycles++
      this.state.symbols[symbol].lastIndicationTime = new Date().toISOString()
    }
    await this.saveState()
  }

  async incrementStrategyCycle(symbol: string | null): Promise<void> {
    this.state.totalStrategyCycles++
    this.state.lastCycleTime = new Date().toISOString()
    if (symbol && this.state.symbols[symbol]) {
      this.state.symbols[symbol].strategyCycles++
      this.state.symbols[symbol].lastStrategyTime = new Date().toISOString()
    }
    await this.saveState()
  }

  async incrementRealtimeCycle(symbol: string | null): Promise<void> {
    this.state.totalRealtimeCycles++
    this.state.lastCycleTime = new Date().toISOString()
    if (symbol && this.state.symbols[symbol]) {
      this.state.symbols[symbol].realtimeCycles++
      this.state.symbols[symbol].lastRealtimeTime = new Date().toISOString()
    }
    await this.saveState()
  }

  // ============================================
  // Indication Metrics
  // ============================================

  async updateIndicationMetrics(type: string, passed: boolean, confidence: number, strength: number): Promise<void> {
    if (!this.state.indicationMetrics[type]) {
      this.state.indicationMetrics[type] = {
        type,
        evaluations: 0,
        passed: 0,
        failed: 0,
        passRate: 0,
        avgConfidence: 0,
        avgStrength: 0,
      }
    }
    const m = this.state.indicationMetrics[type]
    m.evaluations++
    if (passed) m.passed++
    else m.failed++
    m.passRate = m.evaluations > 0 ? (m.passed / m.evaluations) * 100 : 0
    m.avgConfidence = ((m.avgConfidence * (m.evaluations - 1)) + confidence) / m.evaluations
    m.avgStrength = ((m.avgStrength * (m.evaluations - 1)) + strength) / m.evaluations
    await this.saveState()
  }

  // ============================================
  // Strategy Metrics
  // ============================================

  async updateStrategyMetrics(
    stage: 'base' | 'main' | 'real',
    setsCount: number,
    evaluated: number,
    passed: number,
    failed: number,
    avgPF: number,
    avgDDT: number,
    avgPosEvalReal: number = 0,
    extras?: { timeframeSeconds?: number; intervalsProcessed?: number; missingIntervalsLoaded?: number; rangeDays?: number }
  ): Promise<void> {
    const m = this.state.strategyMetrics[stage]
    m.setsCount = setsCount
    m.evaluated = evaluated
    m.passed = passed
    m.failed = failed
    m.passRate = evaluated > 0 ? (passed / evaluated) * 100 : 0
    m.avgProfitFactor = avgPF
    m.avgDrawdownTime = avgDDT
    m.avgPosEvalReal = avgPosEvalReal
    if (extras) {
      if (extras.timeframeSeconds !== undefined) m.timeframeSeconds = extras.timeframeSeconds
      if (extras.intervalsProcessed !== undefined) m.intervalsProcessed = extras.intervalsProcessed
      if (extras.missingIntervalsLoaded !== undefined) m.missingIntervalsLoaded = extras.missingIntervalsLoaded
      if (extras.rangeDays !== undefined) m.rangeDays = extras.rangeDays
    }
    await this.saveState()
  }

  // ============================================
  // Error Tracking
  // ============================================

  async addError(type: string, message: string, symbol: string | null = null): Promise<void> {
    this.state.errors.push({
      timestamp: new Date().toISOString(),
      symbol,
      type,
      message,
    })
    // Keep only last 100 errors
    if (this.state.errors.length > 100) {
      this.state.errors = this.state.errors.slice(-100)
    }
    if (symbol && this.state.symbols[symbol]) {
      this.state.symbols[symbol].totalErrors++
      this.state.symbols[symbol].lastError = message
    }
    this.addLog('error', `[${type}] ${message}`, { symbol })
    await this.saveState()
  }

  // ============================================
  // Logging
  // ============================================

  private addLog(level: 'info' | 'warn' | 'error', message: string, data?: Record<string, any>): void {
    this.state.logs.push({
      timestamp: new Date().toISOString(),
      level,
      message,
      data,
    })
    // Keep only last 500 logs
    if (this.state.logs.length > 500) {
      this.state.logs = this.state.logs.slice(-500)
    }
  }

  async addInfoLog(message: string, data?: Record<string, any>): Promise<void> {
    this.addLog('info', message, data)
    await this.saveState()
  }

  async addWarnLog(message: string, data?: Record<string, any>): Promise<void> {
    this.addLog('warn', message, data)
    await this.saveState()
  }

  // ============================================
  // Symbol Management
  // ============================================

  private createSymbolProgress(symbol: string): SymbolProgress {
    return {
      symbol,
      prehistoricLoaded: false,
      prehistoricCandles: 0,
      prehistoricErrors: 0,
      prehistoricDuration: 0,
      wsConnected: false,
      wsMessagesReceived: 0,
      wsErrors: 0,
      wsLastUpdate: null,
      indicationCycles: 0,
      strategyCycles: 0,
      realtimeCycles: 0,
      lastIndicationTime: null,
      lastStrategyTime: null,
      lastRealtimeTime: null,
      totalErrors: 0,
      lastError: null,
    }
  }

  async addSymbol(symbol: string): Promise<void> {
    if (!this.state.symbols[symbol]) {
      this.state.symbols[symbol] = this.createSymbolProgress(symbol)
      this.addLog('info', `Added symbol: ${symbol}`)
      await this.saveState()
    }
  }

  async removeSymbol(symbol: string): Promise<void> {
    delete this.state.symbols[symbol]
    await this.saveState()
  }

  // ============================================
  // Summary Methods
  // ============================================

  getSymbolCount(): number {
    return Object.keys(this.state.symbols).length
  }

  getTotalCycles(): number {
    return this.state.totalIndicationCycles + this.state.totalStrategyCycles + this.state.totalRealtimeCycles
  }

  getOverallPassRate(): number {
    const total = Object.values(this.state.strategyMetrics).reduce((sum, m) => sum + m.evaluated, 0)
    const passed = Object.values(this.state.strategyMetrics).reduce((sum, m) => sum + m.passed, 0)
    return total > 0 ? (passed / total) * 100 : 0
  }

  getErrorCount(): number {
    return this.state.errors.length
  }

  // ============================================
  // Batch Operations Tracking (NEW)
  // ============================================

  async recordBatchOperation(ordersPlaced: number, ordersFailed: number, success: boolean): Promise<void> {
    const metrics = this.state.batchOperationMetrics
    metrics.totalBatches++
    if (success) {
      metrics.successfulBatches++
    } else {
      metrics.failedBatches++
    }
    metrics.totalOrdersPlaced += ordersPlaced
    metrics.totalOrdersFailed += ordersFailed
    metrics.lastBatchTime = new Date().toISOString()
    metrics.avgBatchSize = (metrics.totalOrdersPlaced + metrics.totalOrdersFailed) / metrics.totalBatches
    this.addLog('info', `Batch operation: ${ordersPlaced} placed, ${ordersFailed} failed`)
    await this.saveState()
  }

  // ============================================
  // Close Operations Tracking (NEW)
  // ============================================

  async recordCloseOperation(automated: boolean, bulk: boolean = false): Promise<void> {
    const metrics = this.state.closeOperationMetrics
    metrics.totalClosures++
    if (automated) {
      metrics.automatedCloses++
    } else {
      metrics.manualCloses++
    }
    if (bulk) {
      metrics.bulkCloses++
    }
    metrics.lastCloseTime = new Date().toISOString()
    // closeOperationMetrics only tracks completed closures (no failure
    // counter on this type — failures bubble up earlier in the close
    // path and never reach this recorder). Every recorded entry is by
    // definition a successful close, so success rate is 1.0.
    metrics.closeSuccessRate = 1.0
    this.addLog('info', `Close operation: ${automated ? 'automated' : 'manual'}${bulk ? ' (bulk)' : ''}`)
    await this.saveState()
  }

  // ============================================
  // Order Query Tracking (NEW)
  // ============================================

  async recordOrderQuery(queryType: string): Promise<void> {
    const metrics = this.state.orderQueryMetrics
    metrics.totalQueries++
    metrics.queryTypes[queryType] = (metrics.queryTypes[queryType] || 0) + 1
    metrics.lastQueryTime = new Date().toISOString()
    this.addLog('info', `Order query: ${queryType}`)
    await this.saveState()
  }

  // ============================================
  // Safety Metrics Tracking (NEW)
  // ============================================

  async recordKillSwitchActivation(): Promise<void> {
    const metrics = this.state.safetyMetrics
    metrics.killSwitchesActivated++
    metrics.lastKillSwitchTime = new Date().toISOString()
    this.addLog('warn', `Kill switch activated`)
    await this.saveState()
  }

  async recordKillSwitchTrigger(): Promise<void> {
    const metrics = this.state.safetyMetrics
    metrics.killSwitchesTriggered++
    metrics.emergencyCloseCount++
    this.addLog('warn', `Kill switch triggered - emergency close executed`)
    await this.saveState()
  }

  // ============================================
  // Reset
  // ============================================

  async reset(): Promise<void> {
    this.state = this.createInitialState(this.connectionId)
    await this.saveState()
  }
}

// ============================================
// Global Manager Registry
// ============================================

const progressGlobals = globalThis as unknown as {
  __engineProgressManagers?: Map<string, EngineProgressManager>
}

// Keep managers process-singleton across module reloads (for example Next.js HMR).
// This reduces same-process stale manager duplication while Redis persistence is
// migrated to hash/delta updates for cross-worker overwrite safety.
const managerRegistry =
  progressGlobals.__engineProgressManagers ?? (progressGlobals.__engineProgressManagers = new Map<string, EngineProgressManager>())

export function getProgressManager(connectionId: string): EngineProgressManager {
  if (!managerRegistry.has(connectionId)) {
    managerRegistry.set(connectionId, new EngineProgressManager(connectionId))
  }
  return managerRegistry.get(connectionId)!
}

export function getAllProgressManagers(): Map<string, EngineProgressManager> {
  return managerRegistry
}

export function removeProgressManager(connectionId: string): void {
  managerRegistry.delete(connectionId)
}
