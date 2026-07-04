"use client"

import { DEFAULT_VOLUME_STEP_RATIO, MIN_VOLUME_FACTOR } from "@/lib/constants"
export const dynamic = "force-dynamic"
import { useState, useEffect } from "react"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import ExchangeConnectionManager from "@/components/settings/exchange-connection-manager"
import InstallManager from "@/components/settings/install-manager"
import { ConnectionSettingsHeader } from "@/components/settings/connection-settings-header"
import { toast } from "sonner"
import { Save, Download, Upload, RefreshCw, Activity, Layers, X, Plus, Info, Menu, Loader2 } from "lucide-react"
import type { ExchangeConnection } from "@/lib/types"
import { LogsViewer } from "@/components/settings/logs-viewer"
import { Badge } from "@/components/ui/badge"
import { AuthGuard } from "@/components/auth-guard"
import { Separator } from "@/components/ui/separator"
import AutoIndicationSettings from "@/components/settings/auto-indication-settings"
import { StatisticsOverview } from "@/components/settings/statistics-overview"
import { OverallTab } from "@/components/settings/tabs/overall-tab"
import { ExchangeTab } from "@/components/settings/tabs/exchange-tab"
import { IndicationTab } from "@/components/settings/tabs/indication-tab"
import { StrategyTab } from "@/components/settings/tabs/strategy-tab"
import { SystemTab } from "@/components/settings/tabs/system-tab"
import { PageHeader } from "@/components/page-header"
import { useExchange } from "@/lib/exchange-context"

const EXCHANGE_MAX_POSITIONS: Record<string, number> = {
  bybit: 500,
  binance: 500,
  okx: 150,
  kucoin: 150,
  gateio: 150,
  bitget: 150,
  mexc: 100,
  bingx: 100,
}

// Define Settings type for better type safety
interface Settings {
  base_volume_factor: number
  volume_step_ratio: number
  positions_average: number
  max_leverage: number
  negativeChangePercent: number
  leveragePercentage: number
  prehistoricDataDays: number
  prehistoric_range_hours: number // 1-50h, step 1, default 8
  prehistoric_progression_timeout_minutes?: number // 5-25 min, step 2.5, default 10
  marketTimeframe: number
  tradeIntervalSeconds: number
  realPositionsIntervalSeconds: number
  validationTimeoutSeconds: number
  mainTradeInterval: number
  presetTradeInterval: number
  positionCost: number
  useMaximalLeverage: boolean
  baseValueRangeMin: number
  baseValueRangeMax: number
  baseRatioMin: number
  baseRatioMax: number
  trailingOption: boolean
  // Multi-step trailing matrix — Settings → Strategy → Trailing.
  // Each enabled (start, stop) combo spawns one independent Base Set per
  // (indication_type × direction). See `lib/strategy-coordinator.ts`.
  strategyBaseTrailingEnabled: boolean
  strategyBaseTrailingVariants: string[]
  previousPositionsCount: number
  lastStateCount: number
  trailingEnabled: boolean
  trailingStartValues: string
  trailingStopValues: string
  blockAdjustment: boolean
  dcaAdjustment: boolean
  arrangementType: string
  numberOfSymbolsToSelect: number
  quoteAsset: string
  // ── Main Trade PF thresholds per stage ───────────────────────────
  // Operator-tunable gates for Base → Main → Real → Live promotion.
  // Spec defaults: 0.9 / 1.0 / 1.0 / 1.0. Wired into
  // `lib/strategy-coordinator.ts` via `loadAppPFThresholds()` so a
  // slider change in the Strategies tab flows into the live engine
  // within 5s (TTL cap on the loader cache).
  baseProfitFactor: number
  mainProfitFactor: number
  realProfitFactor: number
  liveProfitFactor: number
  trailingStopLoss: boolean
  maxDrawdownTimeMainHours: number
  maxDrawdownTimeRealHours: number
  maxDrawdownTimeLiveHours: number

  // ── Stage minimum position-count evaluation thresholds ──────────────────
  // Per-stage thresholds for how many completed pseudo-positions a Base/Main/
  // Real set must accumulate before PF + drawdown validation runs. Below the
  // threshold the set is SKIPPED (not promoted, not counted as failed) to
  // avoid false negatives on warming-up sets. Values are snapped to the 5-step
  // grid inside the StrategyCoordinator; set 0 → coordinator default applies.
  stageMinPosCountBase: number  // Base→Main  (coord default 15)
  stageMinPosCountMain: number  // Main→Real  (coord default 15)
  stageMinPosCountReal: number  // Real→Live  (coord default 10)

  mainEngineIntervalMs: number
  presetEngineIntervalMs: number
  activeOrderHandlingIntervalMs: number
  databaseSizeBase: number
  databaseSizeMain: number
  databaseSizeReal: number
  databaseSizePreset: number
  positionCooldownMs: number
  maxPositionsPerConfigDirection: number
  // P0-4: Spec cap on concurrent pseudo positions per direction (Long/Short)
  // across ALL config Sets. Default 1. Enforced by PseudoPositionManager.
  maxActiveBasePseudoPositionsPerDirection: number
  maxPositionsLong: number // Max 1 long position per config
  maxPositionsShort: number // Max 1 short position per config
  indicationTimeoutMs: number // 100ms to 3000ms, step 100ms
  maxConcurrentOperations: number
  cyclePauseMs?: number // 10-200ms, step 10, default 50ms — pause between engine cycles
  strategyMaxEntriesPerSet: number
  strategyMainAxisSetsCeiling: number
  strategyRealSetsSafetyCeiling: number
  maxRealSets: number
  strategyLiveSetsCeiling: number
  autoRestartOnErrors: boolean
  logLevel: string
  maxDatabaseSizeMB: number
  databaseThresholdPercent: number
  automaticDatabaseCleanup: boolean
  automaticDatabaseBackups: boolean
  backupInterval: string
  minimumConnectIntervalMs: number
  symbolsPerExchange: number
  defaultMarginType: string
  defaultPositionMode: string
  rateLimitDelayMs: number
  maxConcurrentConnections: number
  enableTestnetByDefault: boolean
  logsLevel: string
  logsCategory: string
  logsLimit: number
   enableSystemMonitoring: boolean
   metricsRetentionDays: number
   mainEngineEnabled: boolean
   presetEngineEnabled: boolean
   databaseLimitPerSecond: number
   databaseLimitPerMinute: number
   databaseLimitPerDay: number
  maxPositionsPerExchange: Record<string, number>
  mainSymbols: string[]
  forcedSymbols: string[]
  useMainSymbols: boolean
  symbolOrderType: string
  indication_time_interval: number
  indication_range_min: number
  indication_range_max: number
  indication_min_profit_factor: number
  strategy_time_interval: number
  strategy_min_profit_factor: number
  stepRelationMinRatio: number
  stepRelationMaxRatio: number
  block_enabled: boolean
  dca_enabled: boolean
  marketActivityEnabled: boolean
  marketActivityCalculationRange: number
  marketActivityPositionCostRatio: number
  directionEnabled: boolean
  directionInterval: number
  directionTimeout: number
  directionRangeFrom: number
  directionRangeTo: number
  moveEnabled: boolean
  moveInterval: number
  moveTimeout: number
  activeEnabled: boolean
  activeInterval: number
  activeTimeout: number
  optimalCoordinationEnabled: boolean
  trailingOptimalRanges: boolean
  simultaneousTrading: boolean
  positionIncrementAfterSituation: boolean
  // Common Indicators - RSI
  rsiEnabled: boolean
  rsiPeriod: number
  rsiOversold: number
  rsiOverbought: number
  rsiPeriodFrom: number
  rsiPeriodTo: number
  rsiPeriodStep: number
  rsiOversoldFrom: number
  rsiOversoldTo: number
  rsiOversoldStep: number
  rsiOverboughtFrom: number
  rsiOverboughtTo: number
  rsiOverboughtStep: number
  // Common Indicators - MACD
  macdEnabled: boolean
  macdFastPeriod: number
  macdSlowPeriod: number
  macdSignalPeriod: number
  macdFastPeriodFrom: number
  macdFastPeriodTo: number
  macdFastPeriodStep: number
  macdSlowPeriodFrom: number
  macdSlowPeriodTo: number
  macdSlowPeriodStep: number
  macdSignalPeriodFrom: number
  macdSignalPeriodTo: number
  macdSignalPeriodStep: number
  // Common Indicators - Bollinger Bands
  bollingerEnabled: boolean
  bollingerPeriod: number
  bollingerStdDev: number
  bollingerPeriodFrom: number
  bollingerPeriodTo: number
  bollingerPeriodStep: number
  bollingerStdDevFrom: number
  bollingerStdDevTo: number
  bollingerStdDevStep: number
  // Common Indicators - EMA (Exponential Moving Average)
  emaEnabled: boolean
  emaShortPeriod: number
  emaLongPeriod: number
  emaShortPeriodFrom: number
  emaShortPeriodTo: number
  emaShortPeriodStep: number
  emaLongPeriodFrom: number
  emaLongPeriodTo: number
  emaLongPeriodStep: number
  // Common Indicators - SMA (Simple Moving Average)
  smaEnabled: boolean
  smaShortPeriod: number
  smaLongPeriod: number
  smaShortPeriodFrom: number
  smaShortPeriodTo: number
  smaShortPeriodStep: number
  smaLongPeriodFrom: number
  smaLongPeriodTo: number
  smaLongPeriodStep: number
  // Common Indicators - Stochastic
  stochasticEnabled: boolean
  stochasticKPeriod: number
  stochasticDPeriod: number
  stochasticSlowing: number
  stochasticKPeriodFrom: number
  stochasticKPeriodTo: number
  stochasticKPeriodStep: number
  stochasticDPeriodFrom: number
  stochasticDPeriodTo: number
  stochasticDPeriodStep: number
  stochasticSlowingFrom: number
  stochasticSlowingTo: number
  stochasticSlowingStep: number
  // Common Indicators - ADX (Average Directional Index)
  adxEnabled: boolean
  adxPeriod: number
  adxThreshold: number
  adxPeriodFrom: number
  adxPeriodTo: number
  adxPeriodStep: number
  adxThresholdFrom: number
  adxThresholdTo: number
  adxThresholdStep: number
  // Common Indicators - ATR (Average True Range)
  atrEnabled: boolean
  atrPeriod: number
  atrMultiplier: number
  atrPeriodFrom: number
  atrPeriodTo: number
  atrPeriodStep: number
  atrMultiplierFrom: number
  atrMultiplierTo: number
  atrMultiplierStep: number
  // Parabolic SAR
  parabolicSAREnabled: boolean
  parabolicSARAcceleration: number
  parabolicSARMaximum: number
  parabolicSARAccelerationFrom: number
  parabolicSARAccelerationTo: number
  parabolicSARAccelerationStep: number
  parabolicSARMaximumFrom: number
  parabolicSARMaximumTo: number
  parabolicSARMaximumStep: number
  autoRestartOnError: boolean
  restartCooldownMinutes: number
  maxRestartAttempts: number
  min_volume_enforcement: boolean
  exchangeDirectionEnabled: boolean
  exchangeMoveEnabled: boolean
  exchangeActiveEnabled: boolean
  exchangeOptimalEnabled: boolean
  exchangeBaseStrategyEnabled: boolean
  exchangeMainStrategyEnabled: boolean
  exchangeRealStrategyEnabled: boolean
  exchangeTrailingEnabled: boolean
  exchangeBlockEnabled: boolean
  exchangeDcaEnabled: boolean
  // Main Trade Specific Settings
  profitFactorMinMain?: number
  drawdownTimeMain?: number
  mainDirectionEnabled?: boolean
  mainMoveEnabled?: boolean
  mainActiveEnabled?: boolean
  mainOptimalEnabled?: boolean
  mainTrailingStrategy?: boolean
  mainBlockStrategy?: boolean
  mainDcaStrategy?: boolean
  // Preset Trade Specific Settings
  profitFactorMinPreset?: number
  drawdownTimePreset?: number
  presetTrailingEnabled?: boolean
  presetBlockEnabled?: boolean
  presetDcaEnabled?: boolean
  presetDirectionEnabled?: boolean
  presetMoveEnabled?: boolean
  presetActiveEnabled?: boolean
  presetOptimalEnabled?: boolean
  presetTrailingStrategy?: boolean
  presetBlockStrategy?: boolean
  presetDcaStrategy?: boolean
  // Trade Mode
  tradeMode?: string
  // Exchange Position Cost
  exchangePositionCost?: number
  // Volume Factor Settings
  baseVolumeFactorLive?: number
  baseVolumeFactorPreset?: number
  // Strategy Configuration Settings
  strategyTrailingEnabled?: boolean
  strategyBlockEnabled?: boolean
  strategyDcaEnabled?: boolean
  // Indication Configuration Settings
  directionRangeStep: number
  directionDrawdownValues: string // comma-separated: "10,20,30,40,50"
  directionMarketChangeFrom: number
  directionMarketChangeTo: number
  directionMarketChangeStep: number
  directionMinCalcTime: number
  directionLastPartRatio: number
  directionRatioFactorFrom: number
  directionRatioFactorTo: number
  directionRatioFactorStep: number

  moveRangeFrom: number
  moveRangeTo: number
  moveRangeStep: number
  moveDrawdownValues: string
  moveMarketChangeFrom: number
  moveMarketChangeTo: number
  moveMarketChangeStep: number
  moveMinCalcTime: number
  moveLastPartRatio: number
  moveRatioFactorFrom: number
  moveRatioFactorTo: number
  moveRatioFactorStep: number

  activeRangeFrom: number
  activeRangeTo: number
  activeRangeStep: number
  activeDrawdownValues: string
  activeMarketChangeFrom: number
  activeMarketChangeTo: number
  activeMarketChangeStep: number
  activeMinCalcTime: number
  activeLastPartRatio: number
  activeRatioFactorFrom: number
  activeRatioFactorTo: number
  activeRatioFactorStep: number
  activeCalculatedFrom: number
  activeCalculatedTo: number
  activeCalculatedStep: number
  activeLastPartFrom: number
  activeLastPartTo: number
  activeLastPartStep: number
  // ── API & Exchange Timeouts (Settings > System > API & Exchange Timeouts) ──
  apiCallTimeoutMs?: number // 5s - 60s, default 20s
  orderPlacementTimeoutMs?: number // 10s - 120s, default 40s
  orderStatusTimeoutMs?: number // 5s - 60s, default 20s
  positionSyncTimeoutMs?: number // 5s - 60s, default 20s
  orderCancellationTimeoutMs?: number // 5s - 60s, default 15s
  accountQueryTimeoutMs?: number // 3s - 45s, default 15s
}

const initialSettings: Settings = {
  // Overall / Main
  base_volume_factor: MIN_VOLUME_FACTOR,
  volume_step_ratio: DEFAULT_VOLUME_STEP_RATIO,
  // Default raised 50 → 300; see components/settings/utils.ts for the
  // rationale. The two defaults must stay in lock-step or first-load
  // will paint stale UI before the live settings hydrate from Redis.
  positions_average: 300,
  max_leverage: 125,
  negativeChangePercent: 20, // 5-30 step 5, Default 20 - used for loss trigger calculation
  leveragePercentage: 100, // 5-100 step 5, Default 100
  prehistoricDataDays: 5,
  prehistoric_range_hours: 8, // 1-50h, step 1, default 8
  // New system setting: prehistoric_progression_timeout_minutes
  // Range: 5-25 min, step 2.5, default 10
  prehistoric_progression_timeout_minutes: 10,
  marketTimeframe: 1,
  tradeIntervalSeconds: 1,
  realPositionsIntervalSeconds: 0.3,
  validationTimeoutSeconds: 15,
  mainTradeInterval: 1,
  presetTradeInterval: 2,
  positionCost: 0.02, // Fixed default to 0.02 (representing 0.02%)
  useMaximalLeverage: true,
  min_volume_enforcement: true, // Added missing min_volume_enforcement property

  // Base Strategy
  baseValueRangeMin: 0.5,
  baseValueRangeMax: 2.5,
  baseRatioMin: 0.2,
  baseRatioMax: 1,
  trailingOption: false,
  // Multi-step trailing matrix defaults — full 5×5 matrix on.
  // Spec: start ∈ {0.3,0.6,0.9,1.2,1.5}, stop ∈ {0.1,0.2,0.3,0.4,0.5}.
  strategyBaseTrailingEnabled: true,
  strategyBaseTrailingVariants: [
    "0.3:0.1", "0.3:0.2", "0.3:0.3", "0.3:0.4", "0.3:0.5",
    "0.6:0.1", "0.6:0.2", "0.6:0.3", "0.6:0.4", "0.6:0.5",
    "0.9:0.1", "0.9:0.2", "0.9:0.3", "0.9:0.4", "0.9:0.5",
    "1.2:0.1", "1.2:0.2", "1.2:0.3", "1.2:0.4", "1.2:0.5",
    "1.5:0.1", "1.5:0.2", "1.5:0.3", "1.5:0.4", "1.5:0.5",
  ],

  // Main Strategy
  previousPositionsCount: 5,
  lastStateCount: 3,

  // Trailing Configuration
  trailingEnabled: true,
  trailingStartValues: "0.5, 1.0, 1.5",
  trailingStopValues: "0.2, 0.4, 0.6",

  // Adjustment Strategies
  blockAdjustment: true,
  dcaAdjustment: false,
  block_enabled: true,
  dca_enabled: false,

  // Symbol Selection
  arrangementType: "marketCap24h",
  // numberOfSymbolsToSelect: 12, // Moved to exchange tab default
  quoteAsset: "USDT", // Moved to exchange tab default

  // ── Main Trade PF thresholds per stage (spec defaults) ───────────
  // Base 0.9 / Main 1.0 / Real 1.0 / Live 1.0 — operator-tunable via
  // Settings → Strategy → Main → Profit Factor Thresholds. Read by
  // `lib/strategy-coordinator.ts` on every flow cycle (5s TTL cache).
  baseProfitFactor: 0.9,
  mainProfitFactor: 1.0,
  realProfitFactor: 1.0,
  liveProfitFactor: 1.0,

  // Risk Management
  trailingStopLoss: false,
  maxDrawdownTimeMainHours: 4,
  maxDrawdownTimeRealHours: 4,
  maxDrawdownTimeLiveHours: 4,

  // ── Stage minimum position-count thresholds ───────────────────��────────
  stageMinPosCountBase: 0,   // 0 = coordinator default (15)
  stageMinPosCountMain: 0,   // 0 = coordinator default (15)
  stageMinPosCountReal: 0,   // 0 = coordinator default (10)

  // Trade Engine Intervals (milliseconds)
  mainEngineIntervalMs: 100, // 50-1000ms, step 50, default 200ms
  presetEngineIntervalMs: 100, // 50-1000ms, step 50, default 200ms
  activeOrderHandlingIntervalMs: 50, // 50-1000ms, step 50, default 50ms

  // Database Size Configuration (range: 50-750, step 50, default 250)
  databaseSizeBase: 250,
  databaseSizeMain: 250,
  databaseSizeReal: 250,
  databaseSizePreset: 250,

  // Trade Engine Configuration
  positionCooldownMs: 100, // 50-3000ms, default 100ms
  maxPositionsPerConfigDirection: 1, // default 1 (max positions per config per direction)
  // P0-4: spec default 1 — hard cap on concurrent active pseudo
  // positions PER DIRECTION across all config Sets.
  maxActiveBasePseudoPositionsPerDirection: 1,
  maxPositionsLong: 1, // Max 1 long position per configuration
  maxPositionsShort: 1, // Max 1 short position per configuration
  indicationTimeoutMs: 1000, // 100ms to 3000ms, step 100ms, default 1000ms
  maxConcurrentOperations: 100, // 10-250, default 100
  cyclePauseMs: 50, // 10-200ms, step 10, default 50ms — pause between engine cycles
  strategyMaxEntriesPerSet: 250,
  strategyMainAxisSetsCeiling: 50,
  strategyRealSetsSafetyCeiling: 100,
  maxRealSets: 100,
  strategyLiveSetsCeiling: 90,
  // prehistoric_range_hours is already set at line 366 above (first occurrence wins)

  // System Configuration
  autoRestartOnErrors: true,
  logLevel: "info",

  // Database Management
  maxDatabaseSizeMB: 10240,
  databaseThresholdPercent: 80,
  automaticDatabaseCleanup: true,
  automaticDatabaseBackups: true,
  backupInterval: "daily",

  // Connection Settings
  minimumConnectIntervalMs: 200,
  symbolsPerExchange: 50,

  // Connection Defaults
  defaultMarginType: "cross",
  defaultPositionMode: "hedge",
  rateLimitDelayMs: 50,
  maxConcurrentConnections: 3,
  enableTestnetByDefault: false,

  // Application Logs
  logsLevel: "all",
  logsCategory: "all",
  logsLimit: 100,

  // Monitoring Configuration
  enableSystemMonitoring: true,
  metricsRetentionDays: 30,

   mainEngineEnabled: true,
   presetEngineEnabled: true,

   // Database Limits
   databaseLimitPerSecond: 10000, // 10k operations per second (0 = unlimited)
   databaseLimitPerMinute: 500000, // 500k operations per minute (0 = unlimited)
   databaseLimitPerDay: 0, // Unlimited per day (0 = unlimited)

   mainSymbols: ["BTC", "ETH", "BNB", "XRP", "ADA", "SOL"],
  forcedSymbols: ["XRP", "BCH"],

  useMainSymbols: false,
  numberOfSymbolsToSelect: 8,
  symbolOrderType: "volume24h",

  // Indication
  indication_time_interval: 1,
  indication_range_min: 2,
  indication_range_max: 30,
  indication_min_profit_factor: 0.7,

  // Strategy
  strategy_time_interval: 1,
  strategy_min_profit_factor: 0.5,
  stepRelationMinRatio: 0.2, // Moved to strategy section
  stepRelationMaxRatio: 1.0, // Moved to strategy section

  // Main Indication Settings
  marketActivityEnabled: true, // Changed to enabled by default
  marketActivityCalculationRange: 10,
  marketActivityPositionCostRatio: 2,
  directionEnabled: true, // Changed to enabled by default
  directionInterval: 100,
  directionTimeout: 3,
  directionRangeFrom: 2,
  directionRangeTo: 30,
  moveEnabled: true, // Changed to enabled by default
  moveInterval: 100,
  moveTimeout: 3,
  activeEnabled: true, // Changed to enabled by default
  activeInterval: 100,
  activeTimeout: 3,

  // Optimal Indication Settings
  optimalCoordinationEnabled: false,
  trailingOptimalRanges: false,
  simultaneousTrading: false,
  positionIncrementAfterSituation: false,

  // Common Indicators
  rsiEnabled: true, // Changed to true by default
  rsiPeriod: 14,
  rsiOversold: 30,
  rsiOverbought: 70,
  rsiPeriodFrom: 7,
  rsiPeriodTo: 21,
  rsiPeriodStep: 1,
  rsiOversoldFrom: 15,
  rsiOversoldTo: 45,
  rsiOversoldStep: 5,
  rsiOverboughtFrom: 55,
  rsiOverboughtTo: 85,
  rsiOverboughtStep: 5,

  macdEnabled: true, // Changed to true by default
  macdFastPeriod: 12,
  macdSlowPeriod: 26,
  macdSignalPeriod: 9,
  macdFastPeriodFrom: 6,
  macdFastPeriodTo: 18,
  macdFastPeriodStep: 2,
  macdSlowPeriodFrom: 13,
  macdSlowPeriodTo: 39,
  macdSlowPeriodStep: 2,
  macdSignalPeriodFrom: 5,
  macdSignalPeriodTo: 13,
  macdSignalPeriodStep: 1,

  bollingerEnabled: true, // Changed to true by default
  bollingerPeriod: 20,
  bollingerStdDev: 2.0,
  bollingerPeriodFrom: 10,
  bollingerPeriodTo: 30,
  bollingerPeriodStep: 2,
  bollingerStdDevFrom: 1.0,
  bollingerStdDevTo: 3.0,
  bollingerStdDevStep: 0.5,

  emaEnabled: true, // Changed to true by default
  emaShortPeriod: 9,
  emaLongPeriod: 21,
  emaShortPeriodFrom: 5,
  emaShortPeriodTo: 13,
  emaShortPeriodStep: 1,
  emaLongPeriodFrom: 11,
  emaLongPeriodTo: 31,
  emaLongPeriodStep: 2,

  smaEnabled: true, // Changed to true by default
  smaShortPeriod: 10,
  smaLongPeriod: 50,
  smaShortPeriodFrom: 5,
  smaShortPeriodTo: 15,
  smaShortPeriodStep: 1,
  smaLongPeriodFrom: 25,
  smaLongPeriodTo: 75,
  smaLongPeriodStep: 5,

  stochasticEnabled: true, // Changed to true by default
  stochasticKPeriod: 14,
  stochasticDPeriod: 3,
  stochasticSlowing: 3,
  stochasticKPeriodFrom: 7,
  stochasticKPeriodTo: 21,
  stochasticKPeriodStep: 1,
  stochasticDPeriodFrom: 2,
  stochasticDPeriodTo: 4,
  stochasticDPeriodStep: 1,
  stochasticSlowingFrom: 2,
  stochasticSlowingTo: 4,
  stochasticSlowingStep: 1,

  adxEnabled: true, // Changed to true by default
  adxPeriod: 14,
  adxThreshold: 25,
  adxPeriodFrom: 7,
  adxPeriodTo: 21,
  adxPeriodStep: 1,
  adxThresholdFrom: 13,
  adxThresholdTo: 37,
  adxThresholdStep: 2,

  atrEnabled: true, // Changed to true by default
  atrPeriod: 14,
  atrMultiplier: 1.5,
  atrPeriodFrom: 7,
  atrPeriodTo: 21,
  atrPeriodStep: 1,
  atrMultiplierFrom: 1.0,
  atrMultiplierTo: 3.0,
  atrMultiplierStep: 0.5,

  // Parabolic SAR
  parabolicSAREnabled: false, // Disabled by default
  parabolicSARAcceleration: 0.02,
  parabolicSARMaximum: 0.2,
  parabolicSARAccelerationFrom: 0.01,
  parabolicSARAccelerationTo: 0.03,
  parabolicSARAccelerationStep: 0.005,
  parabolicSARMaximumFrom: 0.1,
  parabolicSARMaximumTo: 0.3,
  parabolicSARMaximumStep: 0.05,

  autoRestartOnError: true,
  restartCooldownMinutes: 5,
  maxRestartAttempts: 3,

  // Exchange-specific overrides for indications and strategies
  exchangeDirectionEnabled: true,
  exchangeMoveEnabled: true,
  exchangeActiveEnabled: true,
  exchangeOptimalEnabled: false,
  exchangeBaseStrategyEnabled: true,
  exchangeMainStrategyEnabled: true,
  exchangeRealStrategyEnabled: true,
  exchangeTrailingEnabled: true,
  exchangeBlockEnabled: true,
  exchangeDcaEnabled: true,

  // Initialize maxPositionsPerExchange correctly
  maxPositionsPerExchange: Object.keys(EXCHANGE_MAX_POSITIONS).reduce(
    (acc, key) => {
      acc[key] = EXCHANGE_MAX_POSITIONS[key]
      return acc
    },
    {} as Record<string, number>,
  ),

  // Indication Settings Defaults
  directionRangeStep: 1,
  directionDrawdownValues: "10,20,30,40,50",
  directionMarketChangeFrom: 0.5,
  directionMarketChangeTo: 5,
  directionMarketChangeStep: 0.5,
  directionMinCalcTime: 30,
  directionLastPartRatio: 0.2,
  directionRatioFactorFrom: 0.5,
  directionRatioFactorTo: 2.0,
  directionRatioFactorStep: 0.1,

  moveRangeFrom: 2,
  moveRangeTo: 30,
  moveRangeStep: 1,
  moveDrawdownValues: "10,20,30,40,50",
  moveMarketChangeFrom: 0.5,
  moveMarketChangeTo: 5,
  moveMarketChangeStep: 0.5,
  moveMinCalcTime: 30,
  moveLastPartRatio: 0.2,
  moveRatioFactorFrom: 0.5,
  moveRatioFactorTo: 2.0,
  moveRatioFactorStep: 0.1,

  activeRangeFrom: 2,
  activeRangeTo: 30,
  activeRangeStep: 1,
  activeDrawdownValues: "10,20,30,40,50",
  activeMarketChangeFrom: 0.5,
  activeMarketChangeTo: 5,
  activeMarketChangeStep: 0.5,
  activeMinCalcTime: 30,
  activeLastPartRatio: 0.2,
  activeRatioFactorFrom: 0.5,
  activeRatioFactorTo: 2.0,
  activeRatioFactorStep: 0.1,
  activeCalculatedFrom: 1,
  activeCalculatedTo: 5,
  activeCalculatedStep: 0.1,
  activeLastPartFrom: 1,
  activeLastPartTo: 5,
  activeLastPartStep: 0.1,
}

export default function SettingsPage() {
  // useToast hook removed, toast from sonner imported and used.
  const { selectedConnectionId } = useExchange()
  const [newMainSymbol, setNewMainSymbol] = useState("")
  const [newForcedSymbol, setNewForcedSymbol] = useState("")

  // FIX: positionCost default to 0.02 meaning 0.02% (displayed as 0.02%, not 2%)
  const [settings, setSettings] = useState<Settings>({
    ...initialSettings,
    // Ensure defaults are applied if not present in initialSettings
    positionCost: initialSettings.positionCost ?? 0.1, // 0.1% default (slider value)
    exchangePositionCost: initialSettings.exchangePositionCost ?? 0.1, // Sync with positionCost
    baseVolumeFactorLive: initialSettings.baseVolumeFactorLive ?? MIN_VOLUME_FACTOR,
    baseVolumeFactorPreset: initialSettings.baseVolumeFactorPreset ?? MIN_VOLUME_FACTOR,
    profitFactorMinMain: initialSettings.profitFactorMinMain ?? 0.6,
    drawdownTimeMain: initialSettings.drawdownTimeMain ?? 300,
    mainDirectionEnabled: initialSettings.mainDirectionEnabled ?? true,
    mainMoveEnabled: initialSettings.mainMoveEnabled ?? true,
    mainActiveEnabled: initialSettings.mainActiveEnabled ?? true,
    mainOptimalEnabled: initialSettings.mainOptimalEnabled ?? false,
    mainTrailingStrategy: initialSettings.mainTrailingStrategy ?? true,
    mainBlockStrategy: initialSettings.mainBlockStrategy ?? false,
    mainDcaStrategy: initialSettings.mainDcaStrategy ?? false,
    profitFactorMinPreset: initialSettings.profitFactorMinPreset ?? 0.6,
    drawdownTimePreset: initialSettings.drawdownTimePreset ?? 300,
    presetTrailingEnabled: initialSettings.presetTrailingEnabled ?? false,
    presetBlockEnabled: initialSettings.presetBlockEnabled ?? false,
    presetDcaEnabled: initialSettings.presetDcaEnabled ?? false,
    presetDirectionEnabled: initialSettings.presetDirectionEnabled ?? true,
    presetMoveEnabled: initialSettings.presetMoveEnabled ?? true,
    presetActiveEnabled: initialSettings.presetActiveEnabled ?? true,
    presetOptimalEnabled: initialSettings.presetOptimalEnabled ?? false,
    presetTrailingStrategy: initialSettings.presetTrailingStrategy ?? false,
    presetBlockStrategy: initialSettings.presetBlockStrategy ?? false,
    presetDcaStrategy: initialSettings.presetDcaStrategy ?? false,
    tradeMode: initialSettings.tradeMode ?? "both",
    strategyTrailingEnabled: initialSettings.strategyTrailingEnabled ?? true,
    strategyBlockEnabled: initialSettings.strategyBlockEnabled ?? true,
    strategyDcaEnabled: initialSettings.strategyDcaEnabled ?? false,
    // FIX: Ensure useMainSymbols default is applied
    useMainSymbols: initialSettings.useMainSymbols ?? false,
    // FIX: Ensure numberOfSymbolsToSelect default is applied
    numberOfSymbolsToSelect: initialSettings.numberOfSymbolsToSelect ?? 8,
    // FIX: Ensure quoteAsset default is applied
    quoteAsset: initialSettings.quoteAsset ?? "USDT",
    // FIX: Ensure symbolOrderType default is applied
    symbolOrderType: initialSettings.symbolOrderType ?? "volume24h",
    // FIX: Ensure min_volume_enforcement default is applied
    min_volume_enforcement: initialSettings.min_volume_enforcement ?? false, // Now defaults to false in initialSettings
    // Apply defaults for new indicator ranges
    rsiPeriodFrom: initialSettings.rsiPeriodFrom ?? 5,
    rsiPeriodTo: initialSettings.rsiPeriodTo ?? 20,
    rsiPeriodStep: initialSettings.rsiPeriodStep ?? 1,
    rsiOversoldFrom: initialSettings.rsiOversoldFrom ?? 20,
    rsiOversoldTo: initialSettings.rsiOversoldTo ?? 40,
    rsiOversoldStep: initialSettings.rsiOversoldStep ?? 1,
    rsiOverboughtFrom: initialSettings.rsiOverboughtFrom ?? 60,
    rsiOverboughtTo: initialSettings.rsiOverboughtTo ?? 80,
    rsiOverboughtStep: initialSettings.rsiOverboughtStep ?? 1,
    macdFastPeriodFrom: initialSettings.macdFastPeriodFrom ?? 5,
    macdFastPeriodTo: initialSettings.macdFastPeriodTo ?? 25,
    macdFastPeriodStep: initialSettings.macdFastPeriodStep ?? 1,
    macdSlowPeriodFrom: initialSettings.macdSlowPeriodFrom ?? 20,
    macdSlowPeriodTo: initialSettings.macdSlowPeriodTo ?? 50,
    macdSlowPeriodStep: initialSettings.macdSlowPeriodStep ?? 1,
    macdSignalPeriodFrom: initialSettings.macdSignalPeriodFrom ?? 5,
    macdSignalPeriodTo: initialSettings.macdSignalPeriodTo ?? 25,
    macdSignalPeriodStep: initialSettings.macdSignalPeriodStep ?? 1,
    bollingerPeriodFrom: initialSettings.bollingerPeriodFrom ?? 5,
    bollingerPeriodTo: initialSettings.bollingerPeriodTo ?? 50,
    bollingerPeriodStep: initialSettings.bollingerPeriodStep ?? 1,
    bollingerStdDevFrom: initialSettings.bollingerStdDevFrom ?? 0.5,
    bollingerStdDevTo: initialSettings.bollingerStdDevTo ?? 5.0,
    bollingerStdDevStep: initialSettings.bollingerStdDevStep ?? 0.1,
    emaShortPeriodFrom: initialSettings.emaShortPeriodFrom ?? 5,
    emaShortPeriodTo: initialSettings.emaShortPeriodTo ?? 25,
    emaShortPeriodStep: initialSettings.emaShortPeriodStep ?? 1,
    emaLongPeriodFrom: initialSettings.emaLongPeriodFrom ?? 20,
    emaLongPeriodTo: initialSettings.emaLongPeriodTo ?? 50,
    emaLongPeriodStep: initialSettings.emaLongPeriodStep ?? 1,
    smaShortPeriodFrom: initialSettings.smaShortPeriodFrom ?? 5,
    smaShortPeriodTo: initialSettings.smaShortPeriodTo ?? 25,
    smaShortPeriodStep: initialSettings.smaShortPeriodStep ?? 1,
    smaLongPeriodFrom: initialSettings.smaLongPeriodFrom ?? 20,
    smaLongPeriodTo: initialSettings.smaLongPeriodTo ?? 50,
    smaLongPeriodStep: initialSettings.smaLongPeriodStep ?? 1,
    stochasticKPeriodFrom: initialSettings.stochasticKPeriodFrom ?? 5,
    stochasticKPeriodTo: initialSettings.stochasticKPeriodTo ?? 25,
    stochasticKPeriodStep: initialSettings.stochasticKPeriodStep ?? 1,
    stochasticDPeriodFrom: initialSettings.stochasticDPeriodFrom ?? 2,
    stochasticDPeriodTo: initialSettings.stochasticDPeriodTo ?? 10,
    stochasticDPeriodStep: initialSettings.stochasticDPeriodStep ?? 1,
    stochasticSlowingFrom: initialSettings.stochasticSlowingFrom ?? 1,
    stochasticSlowingTo: initialSettings.stochasticSlowingTo ?? 5,
    stochasticSlowingStep: initialSettings.stochasticSlowingStep ?? 1,
    adxPeriodFrom: initialSettings.adxPeriodFrom ?? 5,
    adxPeriodTo: initialSettings.adxPeriodTo ?? 30,
    adxPeriodStep: initialSettings.adxPeriodStep ?? 1,
    adxThresholdFrom: initialSettings.adxThresholdFrom ?? 15,
    adxThresholdTo: initialSettings.adxThresholdTo ?? 40,
    adxThresholdStep: initialSettings.adxThresholdStep ?? 1,
    atrPeriodFrom: initialSettings.atrPeriodFrom ?? 5,
    atrPeriodTo: initialSettings.atrPeriodTo ?? 30,
    atrPeriodStep: initialSettings.atrPeriodStep ?? 1,
    atrMultiplierFrom: initialSettings.atrMultiplierFrom ?? 1.0,
    atrMultiplierTo: initialSettings.atrMultiplierTo ?? 3.0,
    atrMultiplierStep: initialSettings.atrMultiplierStep ?? 0.1,
  })

  const [activeTab, setActiveTab] = useState("overall")
  const [indicationSubTab, setIndicationSubTab] = useState("main")
  const [indicationMainSubTab, setIndicationMainSubTab] = useState("main")

  const [connections, setConnections] = useState<ExchangeConnection[]>([])
  const [selectedExchangeConnection, setSelectedExchangeConnection] = useState<string | null>(null) // Added state for selected exchange connection
  const [exchangeSymbols, setExchangeSymbols] = useState<string[]>([]) // Added state for exchange symbols
  const [loadingSymbols, setLoadingSymbols] = useState(false) // Added state for loading symbols

  const [saving, setSaving] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [reorganizing, setReorganizing] = useState(false)
  const [migrating, setMigrating] = useState(false)

  const [isRestarting, setIsRestarting] = useState(false)
  const [restartHistory, setRestartHistory] = useState<
    Array<{
      timestamp: string
      status: string
      message: string
    }>
  >([])

  const handleRestartEngine = async (options: { force?: boolean; clearCache?: boolean } = {}) => {
    setIsRestarting(true)
    try {
      const response = await fetch("/api/trade-engine/restart", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(options),
      })

      const data = await response.json()

      const historyEntry = {
        timestamp: new Date().toISOString(),
        status: data.success ? "success" : "error",
        message: data.message || data.error || "Unknown result",
      }

      setRestartHistory((prev) => [historyEntry, ...prev.slice(0, 9)])

      if (data.success) {
        toast.success("Engine Restarted", {
          description: "Trade engine restarted successfully",
        })
      } else {
        toast.error("Restart Failed", {
          description: data.error || "Failed to restart engine",
        })
      }
    } catch (error) {
      console.error("Error restarting engine:", error)
      toast.error("Error", {
        description: "Failed to restart trade engine",
      })
    } finally {
      setIsRestarting(false)
    }
  }

  const handleRunMigrations = async () => {
    setMigrating(true)
    try {
      const response = await fetch("/api/admin/run-migrations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })

      const data = await response.json()

      if (data.success) {
        toast.success("Migrations Completed", {
          description: `Applied: ${data.applied}, Skipped: ${data.skipped}${data.failed > 0 ? `, Failed: ${data.failed}` : ""}`,
        })
      } else {
        toast.error("Migration Failed", {
          description: data.error || "Failed to run migrations",
        })
      }
    } catch (error) {
      console.error("Error running migrations:", error)
      toast.error("Error", {
        description: "Failed to run database migrations",
      })
    } finally {
      setMigrating(false)
    }
  }

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings")
      if (response.ok) {
        const data = await response.json()
        if (!data.settings) {
          console.error("[v0] No settings found in response")
          return
        }
        // Merge loaded settings with existing state, prioritizing loaded data
        setSettings((prevSettings: Settings) => {
          const updatedSettings = { ...prevSettings, ...data.settings }

          // Ensure arrays are not overwritten if empty in the loaded data
          if (data.settings.mainSymbols && Array.isArray(data.settings.mainSymbols)) {
            updatedSettings.mainSymbols = data.settings.mainSymbols
          }
          if (data.settings.forcedSymbols && Array.isArray(data.settings.forcedSymbols)) {
            updatedSettings.forcedSymbols = data.settings.forcedSymbols
          }
          if (data.settings.maxPositionsPerExchange && typeof data.settings.maxPositionsPerExchange === "object") {
            updatedSettings.maxPositionsPerExchange = data.settings.maxPositionsPerExchange
          }
          // Ensure engine interval defaults are applied if not present in loaded data
          if (data.settings.mainEngineIntervalMs === undefined) {
            updatedSettings.mainEngineIntervalMs = 100
          }
          if (data.settings.presetEngineIntervalMs === undefined) {
            updatedSettings.presetEngineIntervalMs = 100
          }
          if (data.settings.activeOrderHandlingIntervalMs === undefined) {
            updatedSettings.activeOrderHandlingIntervalMs = 50
          }
          // Ensure engine toggles are applied
          if (data.settings.mainEngineEnabled === undefined) {
            updatedSettings.mainEngineEnabled = true
          }
          if (data.settings.presetEngineEnabled === undefined) {
            updatedSettings.presetEngineEnabled = true
          }
          // Ensure trade engine configuration defaults are applied
          if (data.settings.positionCooldownMs === undefined) {
            updatedSettings.positionCooldownMs = 100
          }
          if (data.settings.maxPositionsPerConfigDirection === undefined) {
            updatedSettings.maxPositionsPerConfigDirection = 2
          }
          // P0-4 migration: default to spec value 1 when the setting
          // isn't present in the persisted state hash.
          if (data.settings.maxActiveBasePseudoPositionsPerDirection === undefined) {
            updatedSettings.maxActiveBasePseudoPositionsPerDirection = 1
          }
          if (data.settings.maxConcurrentOperations === undefined) {
            updatedSettings.maxConcurrentOperations = 100
          }
          // FIX: Ensure positionCost default is applied if not present in loaded data
          if (data.settings.positionCost === undefined) {
            updatedSettings.positionCost = 0.02
          }
          if (data.settings.negativeChangePercent === undefined) {
            updatedSettings.negativeChangePercent = 20
          }
          // Fix typo: data.data.settings.leveragePercentage -> data.settings.leveragePercentage
          if (data.settings.leveragePercentage === undefined) {
            updatedSettings.leveragePercentage = 100
          }

          // Merge exchange-specific settings, prioritizing loaded data but falling back to defaults if needed
          updatedSettings.exchangeDirectionEnabled =
            data.settings.exchangeDirectionEnabled ?? prevSettings.directionEnabled
          updatedSettings.exchangeMoveEnabled = data.settings.exchangeMoveEnabled ?? prevSettings.moveEnabled
          updatedSettings.exchangeActiveEnabled = data.settings.exchangeActiveEnabled ?? prevSettings.activeEnabled
          updatedSettings.exchangeOptimalEnabled =
            data.settings.exchangeOptimalEnabled ?? prevSettings.optimalCoordinationEnabled
          updatedSettings.exchangeBaseStrategyEnabled =
            data.settings.exchangeBaseStrategyEnabled ?? prevSettings.exchangeBaseStrategyEnabled
          updatedSettings.exchangeMainStrategyEnabled =
            data.settings.exchangeMainStrategyEnabled ?? prevSettings.exchangeMainStrategyEnabled
          updatedSettings.exchangeRealStrategyEnabled =
            data.settings.exchangeRealStrategyEnabled ?? prevSettings.exchangeRealStrategyEnabled
          updatedSettings.exchangeTrailingEnabled =
            data.settings.exchangeTrailingEnabled ?? prevSettings.trailingEnabled
          updatedSettings.exchangeBlockEnabled = data.settings.exchangeBlockEnabled ?? prevSettings.blockAdjustment
          updatedSettings.exchangeDcaEnabled = data.settings.exchangeDcaEnabled ?? prevSettings.dcaAdjustment

          // Apply specific settings from loaded data or fall back to initial defaults
          updatedSettings.profitFactorMinMain = data.settings.profitFactorMinMain ?? initialSettings.profitFactorMinMain
          updatedSettings.drawdownTimeMain = data.settings.drawdownTimeMain ?? initialSettings.drawdownTimeMain
          updatedSettings.mainDirectionEnabled =
            data.settings.mainDirectionEnabled ?? initialSettings.mainDirectionEnabled
          updatedSettings.mainMoveEnabled = data.settings.mainMoveEnabled ?? initialSettings.mainMoveEnabled
          updatedSettings.mainActiveEnabled = data.settings.mainActiveEnabled ?? initialSettings.mainActiveEnabled
          updatedSettings.mainOptimalEnabled = data.settings.mainOptimalEnabled ?? initialSettings.mainOptimalEnabled
          updatedSettings.mainTrailingStrategy =
            data.settings.mainTrailingStrategy ?? initialSettings.mainTrailingStrategy
          updatedSettings.mainBlockStrategy = data.settings.mainBlockStrategy ?? initialSettings.mainBlockStrategy
          updatedSettings.mainDcaStrategy = data.settings.mainDcaStrategy ?? initialSettings.mainDcaStrategy

          updatedSettings.profitFactorMinPreset =
            data.settings.profitFactorMinPreset ?? initialSettings.profitFactorMinPreset
          updatedSettings.drawdownTimePreset = data.settings.drawdownTimePreset ?? initialSettings.drawdownTimePreset
          updatedSettings.presetTrailingEnabled =
            data.settings.presetTrailingEnabled ?? initialSettings.presetTrailingEnabled
          updatedSettings.presetBlockEnabled = data.settings.presetBlockEnabled ?? initialSettings.presetBlockEnabled
          updatedSettings.presetDcaEnabled = data.settings.presetDcaEnabled ?? initialSettings.presetDcaEnabled
          updatedSettings.presetDirectionEnabled =
            data.settings.presetDirectionEnabled ?? initialSettings.presetDirectionEnabled
          updatedSettings.presetMoveEnabled = data.settings.presetMoveEnabled ?? initialSettings.presetMoveEnabled
          updatedSettings.presetActiveEnabled = data.settings.presetActiveEnabled ?? initialSettings.presetActiveEnabled
          updatedSettings.presetOptimalEnabled =
            data.settings.presetOptimalEnabled ?? initialSettings.presetOptimalEnabled
          updatedSettings.presetTrailingStrategy =
            data.settings.presetTrailingStrategy ?? initialSettings.presetTrailingStrategy
          updatedSettings.presetBlockStrategy = data.settings.presetBlockStrategy ?? initialSettings.presetBlockStrategy
          updatedSettings.presetDcaStrategy = data.settings.presetDcaStrategy ?? initialSettings.presetDcaStrategy

          updatedSettings.tradeMode = data.settings.tradeMode ?? initialSettings.tradeMode

          // FIX: Ensure exchangePositionCost is synced if not explicitly loaded
          if (data.settings.exchangePositionCost === undefined) {
            updatedSettings.exchangePositionCost = updatedSettings.positionCost
          } else {
            updatedSettings.exchangePositionCost = data.settings.exchangePositionCost
          }

          // FIX: Apply defaults for the newly added settings if they are missing in loaded data
          updatedSettings.useMainSymbols = data.settings.useMainSymbols ?? initialSettings.useMainSymbols
          updatedSettings.numberOfSymbolsToSelect =
            data.settings.numberOfSymbolsToSelect ?? initialSettings.numberOfSymbolsToSelect
          updatedSettings.symbolOrderType = data.settings.symbolOrderType ?? initialSettings.symbolOrderType
          updatedSettings.quoteAsset = data.settings.quoteAsset ?? initialSettings.quoteAsset
          updatedSettings.min_volume_enforcement =
            data.settings.min_volume_enforcement ?? initialSettings.min_volume_enforcement

          // Apply Indication Settings Defaults if not present in loaded data
          updatedSettings.directionRangeStep = data.settings.directionRangeStep ?? initialSettings.directionRangeStep
          updatedSettings.directionDrawdownValues =
            data.settings.directionDrawdownValues ?? initialSettings.directionDrawdownValues
          updatedSettings.directionMarketChangeFrom =
            data.settings.directionMarketChangeFrom ?? initialSettings.directionMarketChangeFrom
          updatedSettings.directionMarketChangeTo =
            data.settings.directionMarketChangeTo ?? initialSettings.directionMarketChangeTo
          updatedSettings.directionMarketChangeStep =
            data.settings.directionMarketChangeStep ?? initialSettings.directionMarketChangeStep
          updatedSettings.directionMinCalcTime =
            data.settings.directionMinCalcTime ?? initialSettings.directionMinCalcTime
          updatedSettings.directionLastPartRatio =
            data.settings.directionLastPartRatio ?? initialSettings.directionLastPartRatio
          updatedSettings.directionRatioFactorFrom =
            data.settings.directionRatioFactorFrom ?? initialSettings.directionRatioFactorFrom
          updatedSettings.directionRatioFactorTo =
            data.settings.directionRatioFactorTo ?? initialSettings.directionRatioFactorTo
          updatedSettings.directionRatioFactorStep =
            data.settings.directionRatioFactorStep ?? initialSettings.directionRatioFactorStep

          updatedSettings.moveRangeStep = data.settings.moveRangeStep ?? initialSettings.moveRangeStep
          updatedSettings.moveDrawdownValues = data.settings.moveDrawdownValues ?? initialSettings.moveDrawdownValues
          updatedSettings.moveMarketChangeFrom =
            data.settings.moveMarketChangeFrom ?? initialSettings.moveMarketChangeFrom
          updatedSettings.moveMarketChangeTo = data.settings.moveMarketChangeTo ?? initialSettings.moveMarketChangeTo
          updatedSettings.moveMarketChangeStep =
            data.settings.moveMarketChangeStep ?? initialSettings.moveMarketChangeStep
          updatedSettings.moveMinCalcTime = data.settings.moveMinCalcTime ?? initialSettings.moveMinCalcTime
          updatedSettings.moveLastPartRatio = data.settings.moveLastPartRatio ?? initialSettings.moveLastPartRatio
          updatedSettings.moveRatioFactorFrom = data.settings.moveRatioFactorFrom ?? initialSettings.moveRatioFactorFrom
          updatedSettings.moveRatioFactorTo = data.settings.moveRatioFactorTo ?? initialSettings.moveRatioFactorTo
          updatedSettings.moveRatioFactorStep = data.settings.moveRatioFactorStep ?? initialSettings.moveRatioFactorStep

          updatedSettings.activeRangeStep = data.settings.activeRangeStep ?? initialSettings.activeRangeStep
          updatedSettings.activeDrawdownValues =
            data.settings.activeDrawdownValues ?? initialSettings.activeDrawdownValues
          updatedSettings.activeMarketChangeFrom =
            data.settings.activeMarketChangeFrom ?? initialSettings.activeMarketChangeFrom
          updatedSettings.activeMarketChangeTo =
            data.settings.activeMarketChangeTo ?? initialSettings.activeMarketChangeTo
          updatedSettings.activeMarketChangeStep =
            data.settings.activeMarketChangeStep ?? initialSettings.activeMarketChangeStep
          updatedSettings.activeMinCalcTime = data.settings.activeMinCalcTime ?? initialSettings.activeMinCalcTime
          updatedSettings.activeLastPartRatio = data.settings.activeLastPartRatio ?? initialSettings.activeLastPartRatio
          updatedSettings.activeRatioFactorFrom =
            data.settings.activeRatioFactorFrom ?? initialSettings.activeRatioFactorFrom
          updatedSettings.activeRatioFactorTo = data.settings.activeRatioFactorTo ?? initialSettings.activeRatioFactorTo
          updatedSettings.activeRatioFactorStep =
            data.settings.activeRatioFactorStep ?? initialSettings.activeRatioFactorStep
          updatedSettings.activeCalculatedFrom =
            data.settings.activeCalculatedFrom ?? initialSettings.activeCalculatedFrom
          updatedSettings.activeCalculatedTo = data.settings.activeCalculatedTo ?? initialSettings.activeCalculatedTo
          updatedSettings.activeCalculatedStep =
            data.settings.activeCalculatedStep ?? initialSettings.activeCalculatedStep
          updatedSettings.activeLastPartFrom = data.settings.activeLastPartFrom ?? initialSettings.activeLastPartFrom
          updatedSettings.activeLastPartTo = data.settings.activeLastPartTo ?? initialSettings.activeLastPartTo
          updatedSettings.activeLastPartStep = data.settings.activeLastPartStep ?? initialSettings.activeLastPartStep

          // Apply new indicator range defaults
          updatedSettings.rsiPeriodFrom = data.settings.rsiPeriodFrom ?? initialSettings.rsiPeriodFrom
          updatedSettings.rsiPeriodTo = data.settings.rsiPeriodTo ?? initialSettings.rsiPeriodTo
          updatedSettings.rsiPeriodStep = data.settings.rsiPeriodStep ?? initialSettings.rsiPeriodStep
          updatedSettings.rsiOversoldFrom = data.settings.rsiOversoldFrom ?? initialSettings.rsiOversoldFrom
          updatedSettings.rsiOversoldTo = data.settings.rsiOversoldTo ?? initialSettings.rsiOversoldTo
          updatedSettings.rsiOversoldStep = data.settings.rsiOversoldStep ?? initialSettings.rsiOversoldStep
          updatedSettings.rsiOverboughtFrom = data.settings.rsiOverboughtFrom ?? initialSettings.rsiOverboughtFrom
          updatedSettings.rsiOverboughtTo = data.settings.rsiOverboughtTo ?? initialSettings.rsiOverboughtTo
          updatedSettings.rsiOverboughtStep = data.settings.rsiOverboughtStep ?? initialSettings.rsiOverboughtStep

          updatedSettings.macdFastPeriodFrom = data.settings.macdFastPeriodFrom ?? initialSettings.macdFastPeriodFrom
          updatedSettings.macdFastPeriodTo = data.settings.macdFastPeriodTo ?? initialSettings.macdFastPeriodTo
          updatedSettings.macdFastPeriodStep = data.settings.macdFastPeriodStep ?? initialSettings.macdFastPeriodStep
          updatedSettings.macdSlowPeriodFrom = data.settings.macdSlowPeriodFrom ?? initialSettings.macdSlowPeriodFrom
          updatedSettings.macdSlowPeriodTo = data.settings.macdSlowPeriodTo ?? initialSettings.macdSlowPeriodTo
          updatedSettings.macdSlowPeriodStep = data.settings.macdSlowPeriodStep ?? initialSettings.macdSlowPeriodStep
          updatedSettings.macdSignalPeriodFrom =
            data.settings.macdSignalPeriodFrom ?? initialSettings.macdSignalPeriodFrom
          updatedSettings.macdSignalPeriodTo = data.settings.macdSignalPeriodTo ?? initialSettings.macdSignalPeriodTo
          updatedSettings.macdSignalPeriodStep =
            data.settings.macdSignalPeriodStep ?? initialSettings.macdSignalPeriodStep

          updatedSettings.bollingerPeriodFrom = data.settings.bollingerPeriodFrom ?? initialSettings.bollingerPeriodFrom
          updatedSettings.bollingerPeriodTo = data.settings.bollingerPeriodTo ?? initialSettings.bollingerPeriodTo
          updatedSettings.bollingerPeriodStep = data.settings.bollingerPeriodStep ?? initialSettings.bollingerPeriodStep
          updatedSettings.bollingerStdDevFrom = data.settings.bollingerStdDevFrom ?? initialSettings.bollingerStdDevFrom
          updatedSettings.bollingerStdDevTo = data.settings.bollingerStdDevTo ?? initialSettings.bollingerStdDevTo
          updatedSettings.bollingerStdDevStep = data.settings.bollingerStdDevStep ?? initialSettings.bollingerStdDevStep

          updatedSettings.emaShortPeriodFrom = data.settings.emaShortPeriodFrom ?? initialSettings.emaShortPeriodFrom
          updatedSettings.emaShortPeriodTo = data.settings.emaShortPeriodTo ?? initialSettings.emaShortPeriodTo
          updatedSettings.emaShortPeriodStep = data.settings.emaShortPeriodStep ?? initialSettings.emaShortPeriodStep
          updatedSettings.emaLongPeriodFrom = data.settings.emaLongPeriodFrom ?? initialSettings.emaLongPeriodFrom
          updatedSettings.emaLongPeriodTo = data.settings.emaLongPeriodTo ?? initialSettings.emaLongPeriodTo
          updatedSettings.emaLongPeriodStep = data.settings.emaLongPeriodStep ?? initialSettings.emaLongPeriodStep

          updatedSettings.smaShortPeriodFrom = data.settings.smaShortPeriodFrom ?? initialSettings.smaShortPeriodFrom
          updatedSettings.smaShortPeriodTo = data.settings.smaShortPeriodTo ?? initialSettings.smaShortPeriodTo
          updatedSettings.smaShortPeriodStep = data.settings.smaShortPeriodStep ?? initialSettings.smaShortPeriodStep
          updatedSettings.smaLongPeriodFrom = data.settings.smaLongPeriodFrom ?? initialSettings.smaLongPeriodFrom
          updatedSettings.smaLongPeriodTo = data.settings.smaLongPeriodTo ?? initialSettings.smaLongPeriodTo
          updatedSettings.smaLongPeriodStep = data.settings.smaLongPeriodStep ?? initialSettings.smaLongPeriodStep

          updatedSettings.stochasticKPeriodFrom =
            data.settings.stochasticKPeriodFrom ?? initialSettings.stochasticKPeriodFrom
          updatedSettings.stochasticKPeriodTo = data.settings.stochasticKPeriodTo ?? initialSettings.stochasticKPeriodTo
          updatedSettings.stochasticKPeriodStep =
            data.settings.stochasticKPeriodStep ?? initialSettings.stochasticKPeriodStep
          updatedSettings.stochasticDPeriodFrom =
            data.settings.stochasticDPeriodFrom ?? initialSettings.stochasticDPeriodFrom
          updatedSettings.stochasticDPeriodTo = data.settings.stochasticDPeriodTo ?? initialSettings.stochasticDPeriodTo
          updatedSettings.stochasticDPeriodStep =
            data.settings.stochasticDPeriodStep ?? initialSettings.stochasticDPeriodStep
          updatedSettings.stochasticSlowingFrom =
            data.settings.stochasticSlowingFrom ?? initialSettings.stochasticSlowingFrom
          updatedSettings.stochasticSlowingTo = data.settings.stochasticSlowingTo ?? initialSettings.stochasticSlowingTo
          updatedSettings.stochasticSlowingStep =
            data.settings.stochasticSlowingStep ?? initialSettings.stochasticSlowingStep

          updatedSettings.adxPeriodFrom = data.settings.adxPeriodFrom ?? initialSettings.adxPeriodFrom
          updatedSettings.adxPeriodTo = data.settings.adxPeriodTo ?? initialSettings.adxPeriodTo
          updatedSettings.adxPeriodStep = data.settings.adxPeriodStep ?? initialSettings.adxPeriodStep
          updatedSettings.adxThresholdFrom = data.settings.adxThresholdFrom ?? initialSettings.adxThresholdFrom
          updatedSettings.adxThresholdTo = data.settings.adxThresholdTo ?? initialSettings.adxThresholdTo
          updatedSettings.adxThresholdStep = data.settings.adxThresholdStep ?? initialSettings.adxThresholdStep

          updatedSettings.atrPeriodFrom = data.settings.atrPeriodFrom ?? initialSettings.atrPeriodFrom
          updatedSettings.atrPeriodTo = data.settings.atrPeriodTo ?? initialSettings.atrPeriodTo
          updatedSettings.atrPeriodStep = data.settings.atrPeriodStep ?? initialSettings.atrPeriodStep
          updatedSettings.atrMultiplierFrom = data.settings.atrMultiplierFrom ?? initialSettings.atrMultiplierFrom
          updatedSettings.atrMultiplierTo = data.settings.atrMultiplierTo ?? initialSettings.atrMultiplierTo
          updatedSettings.atrMultiplierStep = data.settings.atrMultiplierStep ?? initialSettings.atrMultiplierStep

          // Add Parabolic SAR defaults if missing
          updatedSettings.parabolicSAREnabled = data.settings.parabolicSAREnabled ?? initialSettings.parabolicSAREnabled
          updatedSettings.parabolicSARAcceleration =
            data.settings.parabolicSARAcceleration ?? initialSettings.parabolicSARAcceleration
          updatedSettings.parabolicSARMaximum = data.settings.parabolicSARMaximum ?? initialSettings.parabolicSARMaximum
          updatedSettings.parabolicSARAccelerationFrom =
            data.settings.parabolicSARAccelerationFrom ?? initialSettings.parabolicSARAccelerationFrom
          updatedSettings.parabolicSARAccelerationTo =
            data.settings.parabolicSARAccelerationTo ?? initialSettings.parabolicSARAccelerationTo
          updatedSettings.parabolicSARAccelerationStep =
            data.settings.parabolicSARAccelerationStep ?? initialSettings.parabolicSARAccelerationStep
          updatedSettings.parabolicSARMaximumFrom =
            data.settings.parabolicSARMaximumFrom ?? initialSettings.parabolicSARMaximumFrom
          updatedSettings.parabolicSARMaximumTo =
            data.settings.parabolicSARMaximumTo ?? initialSettings.parabolicSARMaximumTo
          updatedSettings.parabolicSARMaximumStep =
            data.settings.parabolicSARMaximumStep ?? initialSettings.parabolicSARMaximumStep
          if (data.settings.database_url !== undefined) {
            updatedSettings.database_url = data.settings.database_url
          }

          return updatedSettings
        })
      }
    } catch (error) {
      console.error("[v0] Failed to load settings:", error)
    }
  }

  // Dummy function added to avoid runtime errors if loadPresetConnections is called elsewhere
  const loadPresetConnections = async () => {
    // Placeholder for loading preset connections if needed in the future
  }

  useEffect(() => {
    // Load connections when the component mounts or when the 'exchange' tab is active
    if (activeTab === "exchange") {
      loadConnections()
    }
  }, [activeTab])

  // Added function to load symbols for a specific exchange connection
  const loadExchangeSymbols = async (connectionId: string) => {
    if (!connectionId) return
    setLoadingSymbols(true)
    try {
      const response = await fetch(`/api/settings/connections/${connectionId}/symbols`)
      if (response.ok) {
        const data = await response.json()
        setExchangeSymbols(data.symbols || [])
      } else {
        setExchangeSymbols([]) // Clear symbols if request fails
      }
    } catch (error) {
      console.error("Failed to load exchange symbols:", error)
      setExchangeSymbols([]) // Clear symbols on error
    } finally {
      setLoadingSymbols(false)
    }
  }

  const handleSettingChange = (key: string | number, value: any) => {
    setSettings((prev) => ({ ...prev, [key]: value }))
  }

  // Effect to load symbols when the selected connection changes
  useEffect(() => {
    if (selectedExchangeConnection) {
      loadExchangeSymbols(selectedExchangeConnection)
    } else {
      setExchangeSymbols([]) // Clear symbols if no connection is selected
    }
  }, [selectedExchangeConnection])

  // Effect to load connection-specific settings when selectedConnectionId changes (from exchange context)
  useEffect(() => {
    if (selectedConnectionId) {
      // Show a toast that settings have been reloaded for the connection
      toast.info("Loading settings for connection", {
        description: `Settings are now scoped to the selected connection.`,
      })
      // In the future, this will load connection-specific settings
      // For now, the current implementation works with global settings
      // which will be enhanced in the next phase
    }
  }, [selectedConnectionId])

  // Effect to set the initial selected connection when connections load
  useEffect(() => {
    if (connections.length > 0 && !selectedExchangeConnection) {
      // Try to find an active and enabled connection, otherwise pick the first one
      const activeConn = connections.find((c) => c.is_active && c.is_enabled) || connections[0]
      if (activeConn) {
        setSelectedExchangeConnection(activeConn.id)
        localStorage.setItem("activeExchangeConnection", activeConn.id)
      }
    } else if (connections.length === 0 && selectedExchangeConnection) {
      // If connections are cleared, reset selected connection
      setSelectedExchangeConnection(null)
      localStorage.removeItem("activeExchangeConnection")
    }
  }, [connections, selectedExchangeConnection])

  const saveAllSettings = async () => {
    setSaving(true)
    setReorganizing(false)

    try {
      console.log("[v0] Starting settings save operation...")
      toast.info("Saving settings...", {
        description: "Please wait while we save your configuration.",
      })

      // Step 1: Fetch previous settings to detect database size changes
      const previousSettingsResponse = await fetch("/api/settings")
      if (!previousSettingsResponse.ok) {
        throw new Error("Failed to fetch previous settings")
      }
      const previousSettingsData = await previousSettingsResponse.json()

      const previousSettings = previousSettingsData?.settings || {}
      const prevDatabaseSizeBase = previousSettings.databaseSizeBase ?? 250
      const prevDatabaseSizeMain = previousSettings.databaseSizeMain ?? 250
      const prevDatabaseSizeReal = previousSettings.databaseSizeReal ?? 250
      const prevDatabaseSizePreset = previousSettings.databaseSizePreset ?? 250
      const prevMainEngineIntervalMs = previousSettings.mainEngineIntervalMs ?? 100
      const prevPresetEngineIntervalMs = previousSettings.presetEngineIntervalMs ?? 100
      const prevActiveOrderHandlingIntervalMs = previousSettings.activeOrderHandlingIntervalMs ?? 50

      // Step 2: Check if database sizes changed (requires reorganization)
      const databaseSizesChanged =
        prevDatabaseSizeBase !== settings.databaseSizeBase ||
        prevDatabaseSizeMain !== settings.databaseSizeMain ||
        prevDatabaseSizeReal !== settings.databaseSizeReal ||
        prevDatabaseSizePreset !== settings.databaseSizePreset

      // Step 3: Check if engine intervals changed (requires engine restart)
      const engineIntervalsChanged =
        prevMainEngineIntervalMs !== settings.mainEngineIntervalMs ||
        prevPresetEngineIntervalMs !== settings.presetEngineIntervalMs ||
        prevActiveOrderHandlingIntervalMs !== settings.activeOrderHandlingIntervalMs

      if (databaseSizesChanged || engineIntervalsChanged) {
        setReorganizing(true)
        console.log("[v0] Critical changes detected, pausing engine...")
        toast.info("Pausing trade engine...", {
          description: "Applying critical configuration changes requires pausing the engine.",
        })

        // Step 3a: Pause trade engine
        const pauseResponse = await fetch("/api/trade-engine/pause", { method: "POST" })
        if (!pauseResponse.ok) {
          console.warn("[v0] Failed to pause trade engine, continuing anyway...")
        } else {
          console.log("[v0] Trade engine paused successfully")
        }

        // Step 3b: Wait for engine to fully stop
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }

      // Step 4: Save settings to database
      console.log("[v0] Saving settings to database...")
      const settingsResponse = await fetch("/api/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ settings }),
      })

      // Handle potential HTML responses (server errors, gateway timeouts, etc.)
      const contentType = settingsResponse.headers.get("content-type") || ""
      let settingsData = null
      
      try {
        if (contentType.includes("application/json")) {
          settingsData = await settingsResponse.json()
        } else if (contentType.includes("text/html") || !settingsResponse.ok) {
          // Server returned HTML or error - likely 500, 502, 503
          const responseText = await settingsResponse.text()
          if (responseText.includes("<!DOCTYPE") || responseText.includes("<html")) {
            console.error("[v0] Server returned HTML error response. Status:", settingsResponse.status)
            throw new Error(`Server Error (HTTP ${settingsResponse.status}): ${settingsResponse.statusText || "Unknown error"}. Try again in a moment.`)
          }
          // Try to extract error message from response
          settingsData = { error: responseText.substring(0, 200) }
        }
      } catch (parseError) {
        if (parseError instanceof Error && parseError.message.includes("Server Error")) {
          throw parseError
        }
        console.error("[v0] Failed to parse settings response:", parseError)
        throw new Error("Failed to parse server response. Server may be experiencing issues.")
      }

      if (!settingsResponse.ok) {
        const errorMsg = settingsData?.error || settingsData?.message || "Failed to save settings to file"
        throw new Error(errorMsg)
      }
      
      console.log("[v0] Settings saved to file successfully")

      toast.success("Settings saved!", {
        description: "All changes have been applied successfully.",
      })

      // Step 5: If database sizes changed, reorganize database
      if (databaseSizesChanged) {
        console.log("[v0] Database sizes changed, reorganizing...")
        toast.info("Reorganizing database with new size limits...", {
          description: "Applying new database size configurations.",
        })

        const reorganizeResponse = await fetch("/api/database/reorganize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            baseSize: settings.databaseSizeBase,
            mainSize: settings.databaseSizeMain,
            realSize: settings.databaseSizeReal,
            presetSize: settings.databaseSizePreset,
          }),
        })

        // Handle potential HTML responses
        const reorganizeContentType = reorganizeResponse.headers.get("content-type") || ""
        let reorganizeData = null
        
        try {
          if (reorganizeContentType.includes("application/json")) {
            reorganizeData = await reorganizeResponse.json()
          } else if (reorganizeContentType.includes("text/html") || !reorganizeResponse.ok) {
            const responseText = await reorganizeResponse.text()
            if (responseText.includes("<!DOCTYPE") || responseText.includes("<html")) {
              console.error("[v0] Database reorganize returned HTML error. Status:", reorganizeResponse.status)
              throw new Error(`Database reorganize failed: Server error (HTTP ${reorganizeResponse.status})`)
            }
          }
        } catch (parseError) {
          if (parseError instanceof Error && parseError.message.includes("Database reorganize")) {
            throw parseError
          }
          console.error("[v0] Failed to parse reorganize response:", parseError)
        }

        if (!reorganizeResponse.ok) {
          const errorMsg = reorganizeData?.error || reorganizeData?.message || "Database reorganization failed"
          console.error("[v0] Database reorganization failed:", errorMsg)
          toast.error("Database reorganization failed", {
            description: "Settings saved but limits not applied. Please check logs.",
          })
        } else {
          console.log("[v0] Database reorganized successfully")
          toast.success("Database reorganized successfully", {
            description: "New size limits have been applied.",
          })
        }
      }

      // Step 6: If critical settings changed, resume engine
      if (databaseSizesChanged || engineIntervalsChanged) {
        console.log("[v0] Resuming trade engine with new settings...")
        toast.info("Resuming trade engine...", {
          description: "Trade engine will restart with updated configuration.",
        })

        // Wait a moment before resuming
        await new Promise((resolve) => setTimeout(resolve, 1000))

        const resumeResponse = await fetch("/api/trade-engine/resume", { method: "POST" })
        if (!resumeResponse.ok) {
          console.error("[v0] Failed to resume trade engine")
          toast.error("Failed to resume trade engine", {
            description: "Please check System status to ensure it is running.",
          })
        } else {
          console.log("[v0] Trade engine resumed successfully")
          toast.success("Trade engine resumed", {
            description: "Engine is now running with the new settings.",
          })
        }

        // Step 7: Reload page to refresh all components with new settings
        toast.info("Applying all changes...", {
          description: "The page will reload to fully apply all updated settings.",
        })
        setTimeout(() => {
          window.location.reload()
        }, 2000)
      }
    } catch (error) {
      console.error("[v0] Error saving settings:", error)
      toast.error("Error saving settings", {
        description: error instanceof Error ? error.message : "An unknown error occurred",
      })

      // Try to resume engine if it was paused
      try {
        await fetch("/api/trade-engine/resume", { method: "POST" })
      } catch (resumeError) {
        console.error("[v0] Failed to resume engine after error:", resumeError)
      }
    } finally {
      setSaving(false)
      setReorganizing(false)
    }
  }

  const exportSettings = async () => {
    setExporting(true)
    try {
      const response = await fetch("/api/settings/export")
      const data = await response.json()

      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `settings-${new Date().toISOString()}.json`
      a.click()
      URL.revokeObjectURL(url)

      toast.success("Settings exported", {
        description: "Your configuration has been successfully exported.",
      })
    } catch (error) {
      console.error("[v0] Failed to export settings:", error)
      toast.error("Export Failed", {
        description: "Could not export settings. Please try again.",
      })
    } finally {
      setExporting(false)
    }
  }

  const importSettings = async () => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept = "application/json"

    input.onchange = async (e: any) => {
      setImporting(true)
      try {
        const file = e.target.files[0]
        const text = await file.text()
        const data = JSON.parse(text)

        const response = await fetch("/api/settings/import", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        })

        if (!response.ok) throw new Error("Failed to import settings")

        await loadSettings()
        toast.success("Settings Imported", {
          description: "Configuration has been successfully imported and applied.",
        })
      } catch (error) {
        console.error("[v0] Failed to import settings:", error)
        toast.error("Import Failed", {
          description: "Could not import settings. Please check the file format and try again.",
        })
      } finally {
        setImporting(false)
      }
    }

    input.click()
  }

  const addMainSymbol = () => {
    if (!newMainSymbol.trim()) return
    const currentSymbols = Array.isArray(settings.mainSymbols) ? settings.mainSymbols : []
    let symbol = newMainSymbol.trim().toUpperCase()
    symbol = symbol.replace(/(USDT|BUSD|USD|BTC|ETH|BNB)$/, "")
    if (!currentSymbols.includes(symbol) && symbol.length > 0) {
      handleSettingChange("mainSymbols", [...currentSymbols, symbol])
      setNewMainSymbol("")
    }
  }

  const removeMainSymbol = (symbol: string) => {
    const currentSymbols = Array.isArray(settings.mainSymbols) ? settings.mainSymbols : []
    handleSettingChange(
      "mainSymbols",
      currentSymbols.filter((s) => s !== symbol),
    )
  }

  const addForcedSymbol = () => {
    if (!newForcedSymbol.trim()) return
    const currentSymbols = Array.isArray(settings.forcedSymbols) ? settings.forcedSymbols : []
    let symbol = newForcedSymbol.trim().toUpperCase()
    symbol = symbol.replace(/(USDT|BUSD|USD|BTC|ETH|BNB)$/, "")
    if (!currentSymbols.includes(symbol) && symbol.length > 0) {
      handleSettingChange("forcedSymbols", [...currentSymbols, symbol])
      setNewForcedSymbol("")
    }
  }

  const removeForcedSymbol = (symbol: string) => {
    const currentSymbols = Array.isArray(settings.forcedSymbols) ? settings.forcedSymbols : []
    handleSettingChange(
      "forcedSymbols",
      currentSymbols.filter((s) => s !== symbol),
    )
  }

  const handleDatabaseTypeChange = async (newType: "sqlite" | "postgresql" | "remote") => {
    if (!confirm("Changing database type requires system restart. Continue?")) return

    try {
      toast.info("Changing database type...", {
        description: "This may take a moment.",
      })

      const response = await fetch("/api/database/change-type", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: newType }),
      })

      if (!response.ok) {
        throw new Error("Failed to change database type")
      }

      toast.info("Database type changed", {
        description: "The page will reload to apply changes.",
      })

      setTimeout(() => {
        window.location.reload()
      }, 2000)
    } catch (error) {
      console.error("[v0] Failed to change database type:", error)
      toast.error("Error", {
        description: error instanceof Error ? error.message : "Failed to change database type",
      })
    }
  }

  const loadConnections = async () => {
    try {
      const response = await fetch("/api/settings/connections")
      if (response.ok) {
        const data = await response.json()
        setConnections(data.connections || [])
        // If connections loaded and a selected connection exists, ensure it's still valid
        if (data.connections && data.connections.length > 0 && selectedExchangeConnection) {
          const currentConn = data.connections.find((c: ExchangeConnection) => c.id === selectedExchangeConnection)
          if (!currentConn || !currentConn.is_enabled) {
            // If selected connection is disabled or deleted, reset selection
            setSelectedExchangeConnection(null)
            localStorage.removeItem("activeExchangeConnection")
          }
        } else if (data.connections && data.connections.length === 0) {
          setSelectedExchangeConnection(null)
          localStorage.removeItem("activeExchangeConnection")
        }
      } else {
        console.error("[v0] Failed to load connections")
      }
    } catch (error) {
      console.error("[v0] Error loading connections:", error)
    }
  }

  useEffect(() => {
    async function loadSettingsAndDB() {
      try {
        console.log("[v0] Loading settings from API...")
        // Fetch settings
        const settingsResponse = await fetch("/api/settings")
        if (settingsResponse.ok) {
          const data = await settingsResponse.json()
          if (!data.settings) {
            console.error("[v0] No settings found in response")
            toast.error("Failed to load settings")
          } else {
            console.log("[v0] Settings loaded:", Object.keys(data.settings).length, "keys")
            setSettings((prevSettings: Settings) => {
              const updatedSettings = { ...prevSettings, ...data.settings }
              // Ensure arrays are not overwritten if empty in the loaded data
              if (data.settings.mainSymbols && Array.isArray(data.settings.mainSymbols)) {
                updatedSettings.mainSymbols = data.settings.mainSymbols
              }
              if (data.settings.forcedSymbols && Array.isArray(data.settings.forcedSymbols)) {
                updatedSettings.forcedSymbols = data.settings.forcedSymbols
              }
              if (data.settings.maxPositionsPerExchange && typeof data.settings.maxPositionsPerExchange === "object") {
                updatedSettings.maxPositionsPerExchange = data.settings.maxPositionsPerExchange
              }
              // Ensure engine interval defaults
              if (data.settings.mainEngineIntervalMs === undefined) updatedSettings.mainEngineIntervalMs = 100
              if (data.settings.presetEngineIntervalMs === undefined) updatedSettings.presetEngineIntervalMs = 100
              if (data.settings.activeOrderHandlingIntervalMs === undefined)
                updatedSettings.activeOrderHandlingIntervalMs = 50
              // Ensure engine toggles
              if (data.settings.mainEngineEnabled === undefined) updatedSettings.mainEngineEnabled = true
              if (data.settings.presetEngineEnabled === undefined) updatedSettings.presetEngineEnabled = true
              // Trade engine config defaults
              if (data.settings.positionCooldownMs === undefined) updatedSettings.positionCooldownMs = 100
              if (data.settings.maxPositionsPerConfigDirection === undefined)
                updatedSettings.maxPositionsPerConfigDirection = 2
              // P0-4 migration (spec default = 1).
              if (data.settings.maxActiveBasePseudoPositionsPerDirection === undefined)
                updatedSettings.maxActiveBasePseudoPositionsPerDirection = 1
              if (data.settings.maxConcurrentOperations === undefined) updatedSettings.maxConcurrentOperations = 100
              // Position cost default
              if (data.settings.positionCost === undefined) updatedSettings.positionCost = 0.02
              if (data.settings.negativeChangePercent === undefined) updatedSettings.negativeChangePercent = 20
              if (data.settings.leveragePercentage === undefined) updatedSettings.leveragePercentage = 100
              // Merge exchange-specific settings
              updatedSettings.exchangeDirectionEnabled =
                data.settings.exchangeDirectionEnabled ?? prevSettings.directionEnabled
              updatedSettings.exchangeMoveEnabled = data.settings.exchangeMoveEnabled ?? prevSettings.moveEnabled
              updatedSettings.exchangeActiveEnabled = data.settings.exchangeActiveEnabled ?? prevSettings.activeEnabled
              updatedSettings.exchangeOptimalEnabled =
                data.settings.exchangeOptimalEnabled ?? prevSettings.optimalCoordinationEnabled
              updatedSettings.exchangeBaseStrategyEnabled =
                data.settings.exchangeBaseStrategyEnabled ?? prevSettings.exchangeBaseStrategyEnabled
              updatedSettings.exchangeMainStrategyEnabled =
                data.settings.exchangeMainStrategyEnabled ?? prevSettings.exchangeMainStrategyEnabled
              updatedSettings.exchangeRealStrategyEnabled =
                data.settings.exchangeRealStrategyEnabled ?? prevSettings.exchangeRealStrategyEnabled
              updatedSettings.exchangeTrailingEnabled =
                data.settings.exchangeTrailingEnabled ?? prevSettings.trailingEnabled
              updatedSettings.exchangeBlockEnabled = data.settings.exchangeBlockEnabled ?? prevSettings.blockAdjustment
              updatedSettings.exchangeDcaEnabled = data.settings.exchangeDcaEnabled ?? prevSettings.dcaAdjustment
              // Apply specific settings or fall back
              updatedSettings.profitFactorMinMain =
                data.settings.profitFactorMinMain ?? initialSettings.profitFactorMinMain
              updatedSettings.drawdownTimeMain = data.settings.drawdownTimeMain ?? initialSettings.drawdownTimeMain
              updatedSettings.mainDirectionEnabled =
                data.settings.mainDirectionEnabled ?? initialSettings.mainDirectionEnabled
              updatedSettings.mainMoveEnabled = data.settings.mainMoveEnabled ?? initialSettings.mainMoveEnabled
              updatedSettings.mainActiveEnabled = data.settings.mainActiveEnabled ?? initialSettings.mainActiveEnabled
              updatedSettings.mainOptimalEnabled =
                data.settings.mainOptimalEnabled ?? initialSettings.mainOptimalEnabled
              updatedSettings.mainTrailingStrategy =
                data.settings.mainTrailingStrategy ?? initialSettings.mainTrailingStrategy
              updatedSettings.mainBlockStrategy = data.settings.mainBlockStrategy ?? initialSettings.mainBlockStrategy
              updatedSettings.mainDcaStrategy = data.settings.mainDcaStrategy ?? initialSettings.mainDcaStrategy
              updatedSettings.profitFactorMinPreset =
                data.settings.profitFactorMinPreset ?? initialSettings.profitFactorMinPreset
              updatedSettings.drawdownTimePreset =
                data.settings.drawdownTimePreset ?? initialSettings.drawdownTimePreset
              updatedSettings.presetTrailingEnabled =
                data.settings.presetTrailingEnabled ?? initialSettings.presetTrailingEnabled
              updatedSettings.presetBlockEnabled =
                data.settings.presetBlockEnabled ?? initialSettings.presetBlockEnabled
              updatedSettings.presetDcaEnabled = data.settings.presetDcaEnabled ?? initialSettings.presetDcaEnabled
              updatedSettings.presetDirectionEnabled =
                data.settings.presetDirectionEnabled ?? initialSettings.presetDirectionEnabled
              updatedSettings.presetMoveEnabled = data.settings.presetMoveEnabled ?? initialSettings.presetMoveEnabled
              updatedSettings.presetActiveEnabled =
                data.settings.presetActiveEnabled ?? initialSettings.presetActiveEnabled
              updatedSettings.presetOptimalEnabled =
                data.settings.presetOptimalEnabled ?? initialSettings.presetOptimalEnabled
              updatedSettings.presetTrailingStrategy =
                data.settings.presetTrailingStrategy ?? initialSettings.presetTrailingStrategy
              updatedSettings.presetBlockStrategy =
                data.settings.presetBlockStrategy ?? initialSettings.presetBlockStrategy
              updatedSettings.presetDcaStrategy = data.settings.presetDcaStrategy ?? initialSettings.presetDcaStrategy
              updatedSettings.tradeMode = data.settings.tradeMode ?? initialSettings.tradeMode
              // Sync exchangePositionCost
              if (data.settings.exchangePositionCost === undefined) {
                updatedSettings.exchangePositionCost = updatedSettings.positionCost
              } else {
                updatedSettings.exchangePositionCost = data.settings.exchangePositionCost
              }
              // Apply defaults for new settings
              updatedSettings.useMainSymbols = data.settings.useMainSymbols ?? initialSettings.useMainSymbols
              updatedSettings.numberOfSymbolsToSelect =
                data.settings.numberOfSymbolsToSelect ?? initialSettings.numberOfSymbolsToSelect
              updatedSettings.symbolOrderType = data.settings.symbolOrderType ?? initialSettings.symbolOrderType
              updatedSettings.quoteAsset = data.settings.quoteAsset ?? initialSettings.quoteAsset
              updatedSettings.min_volume_enforcement =
                data.settings.min_volume_enforcement ?? initialSettings.min_volume_enforcement
              // Apply Indication Settings Defaults
              updatedSettings.directionRangeStep =
                data.settings.directionRangeStep ?? initialSettings.directionRangeStep
              updatedSettings.directionDrawdownValues =
                data.settings.directionDrawdownValues ?? initialSettings.directionDrawdownValues
              updatedSettings.directionMarketChangeFrom =
                data.settings.directionMarketChangeFrom ?? initialSettings.directionMarketChangeFrom
              updatedSettings.directionMarketChangeTo =
                data.settings.directionMarketChangeTo ?? initialSettings.directionMarketChangeTo
              updatedSettings.directionMarketChangeStep =
                data.settings.directionMarketChangeStep ?? initialSettings.directionMarketChangeStep
              updatedSettings.directionMinCalcTime =
                data.settings.directionMinCalcTime ?? initialSettings.directionMinCalcTime
              updatedSettings.directionLastPartRatio =
                data.settings.directionLastPartRatio ?? initialSettings.directionLastPartRatio
              updatedSettings.directionRatioFactorFrom =
                data.settings.directionRatioFactorFrom ?? initialSettings.directionRatioFactorFrom
              updatedSettings.directionRatioFactorTo =
                data.settings.directionRatioFactorTo ?? initialSettings.directionRatioFactorTo
              updatedSettings.directionRatioFactorStep =
                data.settings.directionRatioFactorStep ?? initialSettings.directionRatioFactorStep
              updatedSettings.moveRangeStep = data.settings.moveRangeStep ?? initialSettings.moveRangeStep
              updatedSettings.moveDrawdownValues =
                data.settings.moveDrawdownValues ?? initialSettings.moveDrawdownValues
              updatedSettings.moveMarketChangeFrom =
                data.settings.moveMarketChangeFrom ?? initialSettings.moveMarketChangeFrom
              updatedSettings.moveMarketChangeTo =
                data.settings.moveMarketChangeTo ?? initialSettings.moveMarketChangeTo
              updatedSettings.moveMarketChangeStep =
                data.settings.moveMarketChangeStep ?? initialSettings.moveMarketChangeStep
              updatedSettings.moveMinCalcTime = data.settings.moveMinCalcTime ?? initialSettings.moveMinCalcTime
              updatedSettings.moveLastPartRatio = data.settings.moveLastPartRatio ?? initialSettings.moveLastPartRatio
              updatedSettings.moveRatioFactorFrom =
                data.settings.moveRatioFactorFrom ?? initialSettings.moveRatioFactorFrom
              updatedSettings.moveRatioFactorTo = data.settings.moveRatioFactorTo ?? initialSettings.moveRatioFactorTo
              updatedSettings.moveRatioFactorStep =
                data.settings.moveRatioFactorStep ?? initialSettings.moveRatioFactorStep
              updatedSettings.activeRangeStep = data.settings.activeRangeStep ?? initialSettings.activeRangeStep
              updatedSettings.activeDrawdownValues =
                data.settings.activeDrawdownValues ?? initialSettings.activeDrawdownValues
              updatedSettings.activeMarketChangeFrom =
                data.settings.activeMarketChangeFrom ?? initialSettings.activeMarketChangeFrom
              updatedSettings.activeMarketChangeTo =
                data.settings.activeMarketChangeTo ?? initialSettings.activeMarketChangeTo
              updatedSettings.activeMarketChangeStep =
                data.settings.activeMarketChangeStep ?? initialSettings.activeMarketChangeStep
              updatedSettings.activeMinCalcTime = data.settings.activeMinCalcTime ?? initialSettings.activeMinCalcTime
              updatedSettings.activeLastPartRatio =
                data.settings.activeLastPartRatio ?? initialSettings.activeLastPartRatio
              updatedSettings.activeRatioFactorFrom =
                data.settings.activeRatioFactorFrom ?? initialSettings.activeRatioFactorFrom
              updatedSettings.activeRatioFactorTo =
                data.settings.activeRatioFactorTo ?? initialSettings.activeRatioFactorTo
              updatedSettings.activeRatioFactorStep =
                data.settings.activeRatioFactorStep ?? initialSettings.activeRatioFactorStep
              updatedSettings.activeCalculatedFrom =
                data.settings.activeCalculatedFrom ?? initialSettings.activeCalculatedFrom
              updatedSettings.activeCalculatedTo =
                data.settings.activeCalculatedTo ?? initialSettings.activeCalculatedTo
              updatedSettings.activeCalculatedStep =
                data.settings.activeCalculatedStep ?? initialSettings.activeCalculatedStep
              updatedSettings.activeLastPartFrom =
                data.settings.activeLastPartFrom ?? initialSettings.activeLastPartFrom
              updatedSettings.activeLastPartTo = data.settings.activeLastPartTo ?? initialSettings.activeLastPartTo
              updatedSettings.activeLastPartStep =
                data.settings.activeLastPartStep ?? initialSettings.activeLastPartStep
              // Apply new indicator range defaults
              updatedSettings.rsiPeriodFrom = data.settings.rsiPeriodFrom ?? initialSettings.rsiPeriodFrom
              updatedSettings.rsiPeriodTo = data.settings.rsiPeriodTo ?? initialSettings.rsiPeriodTo
              updatedSettings.rsiPeriodStep = data.settings.rsiPeriodStep ?? initialSettings.rsiPeriodStep
              updatedSettings.rsiOversoldFrom = data.settings.rsiOversoldFrom ?? initialSettings.rsiOversoldFrom
              updatedSettings.rsiOversoldTo = data.settings.rsiOversoldTo ?? initialSettings.rsiOversoldTo
              updatedSettings.rsiOversoldStep = data.settings.rsiOversoldStep ?? initialSettings.rsiOversoldStep
              updatedSettings.rsiOverboughtFrom = data.settings.rsiOverboughtFrom ?? initialSettings.rsiOverboughtFrom
              updatedSettings.rsiOverboughtTo = data.settings.rsiOverboughtTo ?? initialSettings.rsiOverboughtTo
              updatedSettings.rsiOverboughtStep = data.settings.rsiOverboughtStep ?? initialSettings.rsiOverboughtStep

              updatedSettings.macdFastPeriodFrom =
                data.settings.macdFastPeriodFrom ?? initialSettings.macdFastPeriodFrom
              updatedSettings.macdFastPeriodTo = data.settings.macdFastPeriodTo ?? initialSettings.macdFastPeriodTo
              updatedSettings.macdFastPeriodStep =
                data.settings.macdFastPeriodStep ?? initialSettings.macdFastPeriodStep
              updatedSettings.macdSlowPeriodFrom =
                data.settings.macdSlowPeriodFrom ?? initialSettings.macdSlowPeriodFrom
              updatedSettings.macdSlowPeriodTo = data.settings.macdSlowPeriodTo ?? initialSettings.macdSlowPeriodTo
              updatedSettings.macdSlowPeriodStep =
                data.settings.macdSlowPeriodStep ?? initialSettings.macdSlowPeriodStep
              updatedSettings.macdSignalPeriodFrom =
                data.settings.macdSignalPeriodFrom ?? initialSettings.macdSignalPeriodFrom
              updatedSettings.macdSignalPeriodTo =
                data.settings.macdSignalPeriodTo ?? initialSettings.macdSignalPeriodTo
              updatedSettings.macdSignalPeriodStep =
                data.settings.macdSignalPeriodStep ?? initialSettings.macdSignalPeriodStep

              updatedSettings.bollingerPeriodFrom =
                data.settings.bollingerPeriodFrom ?? initialSettings.bollingerPeriodFrom
              updatedSettings.bollingerPeriodTo = data.settings.bollingerPeriodTo ?? initialSettings.bollingerPeriodTo
              updatedSettings.bollingerPeriodStep =
                data.settings.bollingerPeriodStep ?? initialSettings.bollingerPeriodStep
              updatedSettings.bollingerStdDevFrom =
                data.settings.bollingerStdDevFrom ?? initialSettings.bollingerStdDevFrom
              updatedSettings.bollingerStdDevTo = data.settings.bollingerStdDevTo ?? initialSettings.bollingerStdDevTo
              updatedSettings.bollingerStdDevStep =
                data.settings.bollingerStdDevStep ?? initialSettings.bollingerStdDevStep

              updatedSettings.emaShortPeriodFrom =
                data.settings.emaShortPeriodFrom ?? initialSettings.emaShortPeriodFrom
              updatedSettings.emaShortPeriodTo = data.settings.emaShortPeriodTo ?? initialSettings.emaShortPeriodTo
              updatedSettings.emaShortPeriodStep =
                data.settings.emaShortPeriodStep ?? initialSettings.emaShortPeriodStep
              updatedSettings.emaLongPeriodFrom = data.settings.emaLongPeriodFrom ?? initialSettings.emaLongPeriodFrom
              updatedSettings.emaLongPeriodTo = data.settings.emaLongPeriodTo ?? initialSettings.emaLongPeriodTo
              updatedSettings.emaLongPeriodStep = data.settings.emaLongPeriodStep ?? initialSettings.emaLongPeriodStep

              updatedSettings.smaShortPeriodFrom =
                data.settings.smaShortPeriodFrom ?? initialSettings.smaShortPeriodFrom
              updatedSettings.smaShortPeriodTo = data.settings.smaShortPeriodTo ?? initialSettings.smaShortPeriodTo
              updatedSettings.smaShortPeriodStep =
                data.settings.smaShortPeriodStep ?? initialSettings.smaShortPeriodStep
              updatedSettings.smaLongPeriodFrom = data.settings.smaLongPeriodFrom ?? initialSettings.smaLongPeriodFrom
              updatedSettings.smaLongPeriodTo = data.settings.smaLongPeriodTo ?? initialSettings.smaLongPeriodTo
              updatedSettings.smaLongPeriodStep = data.settings.smaLongPeriodStep ?? initialSettings.smaLongPeriodStep

              updatedSettings.stochasticKPeriodFrom =
                data.settings.stochasticKPeriodFrom ?? initialSettings.stochasticKPeriodFrom
              updatedSettings.stochasticKPeriodTo =
                data.settings.stochasticKPeriodTo ?? initialSettings.stochasticKPeriodTo
              updatedSettings.stochasticKPeriodStep =
                data.settings.stochasticKPeriodStep ?? initialSettings.stochasticKPeriodStep
              updatedSettings.stochasticDPeriodFrom =
                data.settings.stochasticDPeriodFrom ?? initialSettings.stochasticDPeriodFrom
              updatedSettings.stochasticDPeriodTo =
                data.settings.stochasticDPeriodTo ?? initialSettings.stochasticDPeriodTo
              updatedSettings.stochasticDPeriodStep =
                data.settings.stochasticDPeriodStep ?? initialSettings.stochasticDPeriodStep
              updatedSettings.stochasticSlowingFrom =
                data.settings.stochasticSlowingFrom ?? initialSettings.stochasticSlowingFrom
              updatedSettings.stochasticSlowingTo =
                data.settings.stochasticSlowingTo ?? initialSettings.stochasticSlowingTo
              updatedSettings.stochasticSlowingStep =
                data.settings.stochasticSlowingStep ?? initialSettings.stochasticSlowingStep

              updatedSettings.adxPeriodFrom = data.settings.adxPeriodFrom ?? initialSettings.adxPeriodFrom
              updatedSettings.adxPeriodTo = data.settings.adxPeriodTo ?? initialSettings.adxPeriodTo
              updatedSettings.adxPeriodStep = data.settings.adxPeriodStep ?? initialSettings.adxPeriodStep
              updatedSettings.adxThresholdFrom = data.settings.adxThresholdFrom ?? initialSettings.adxThresholdFrom
              updatedSettings.adxThresholdTo = data.settings.adxThresholdTo ?? initialSettings.adxThresholdTo
              updatedSettings.adxThresholdStep = data.settings.adxThresholdStep ?? initialSettings.adxThresholdStep

              updatedSettings.atrPeriodFrom = data.settings.atrPeriodFrom ?? initialSettings.atrPeriodFrom
              updatedSettings.atrPeriodTo = data.settings.atrPeriodTo ?? initialSettings.atrPeriodTo
              updatedSettings.atrPeriodStep = data.settings.atrPeriodStep ?? initialSettings.atrPeriodStep
              updatedSettings.atrMultiplierFrom = data.settings.atrMultiplierFrom ?? initialSettings.atrMultiplierFrom
              updatedSettings.atrMultiplierTo = data.settings.atrMultiplierTo ?? initialSettings.atrMultiplierTo
              updatedSettings.atrMultiplierStep = data.settings.atrMultiplierStep ?? initialSettings.atrMultiplierStep

              // Add Parabolic SAR defaults if missing
              updatedSettings.parabolicSAREnabled =
                data.settings.parabolicSAREnabled ?? initialSettings.parabolicSAREnabled
              updatedSettings.parabolicSARAcceleration =
                data.settings.parabolicSARAcceleration ?? initialSettings.parabolicSARAcceleration
              updatedSettings.parabolicSARMaximum =
                data.settings.parabolicSARMaximum ?? initialSettings.parabolicSARMaximum
              updatedSettings.parabolicSARAccelerationFrom =
                data.settings.parabolicSARAccelerationFrom ?? initialSettings.parabolicSARAccelerationFrom
              updatedSettings.parabolicSARAccelerationTo =
                data.settings.parabolicSARAccelerationTo ?? initialSettings.parabolicSARAccelerationTo
              updatedSettings.parabolicSARAccelerationStep =
                data.settings.parabolicSARAccelerationStep ?? initialSettings.parabolicSARAccelerationStep
              updatedSettings.parabolicSARMaximumFrom =
                data.settings.parabolicSARMaximumFrom ?? initialSettings.parabolicSARMaximumFrom
              updatedSettings.parabolicSARMaximumTo =
                data.settings.parabolicSARMaximumTo ?? initialSettings.parabolicSARMaximumTo
              updatedSettings.parabolicSARMaximumStep =
                data.settings.parabolicSARMaximumStep ?? initialSettings.parabolicSARMaximumStep

              return updatedSettings
            })
          }
        }

        // Load current database type and URL
        const dbTypeResponse = await fetch("/api/database/type")
        if (dbTypeResponse.ok) {
          const dbData = await dbTypeResponse.json()
          setSettings((prev) => ({
            ...prev,
            database_type: dbData.database_type || "sqlite",
            database_url: dbData.database_url || "",
          }))
        }

        loadConnections() // Load connections on initial mount as well
        loadPresetConnections()
      } catch (error) {
        console.error("[v0] Failed to load settings:", error)
      }
    }
    
    loadSettingsAndDB()
  }, [])

  const getMinIndicationInterval = () => {
    // Indication intervals should be at least as long as the main engine interval
    return Math.max(settings.mainEngineIntervalMs || 100, 50)
  }

  const getMinActiveIndicationInterval = () => {
    // Active indication is part of main trade engine, uses main engine interval as minimum
    return Math.max(settings.mainEngineIntervalMs || 100, 50)
  }

  return (
    <AuthGuard>
      <div className="flex min-h-0 flex-col">
        <PageHeader title="Settings" description="Configure system parameters and trading strategies">
          <Button onClick={saveAllSettings} disabled={saving} size="sm">
            <Save className="h-4 w-4 mr-2" />
            {reorganizing ? "Reorganizing..." : saving ? "Saving..." : "Save Changes"}
          </Button>
        </PageHeader>
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="mx-auto max-w-7xl space-y-6">
        <Tabs value={activeTab} onValueChange={setActiveTab}>
          <div className="overflow-x-auto pb-1">
            <TabsList className="grid w-full min-w-[640px] grid-cols-5">
              <TabsTrigger value="overall">Overall</TabsTrigger>
              <TabsTrigger value="exchange">Exchange</TabsTrigger>
              <TabsTrigger value="indication">Indication</TabsTrigger>
              <TabsTrigger value="strategy">Strategy</TabsTrigger>
              <TabsTrigger value="system">System</TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="overall" className="space-y-4">
            <OverallTab
              settings={settings}
              handleSettingChange={handleSettingChange}
              addMainSymbol={addMainSymbol}
              removeMainSymbol={removeMainSymbol}
              addForcedSymbol={addForcedSymbol}
              removeForcedSymbol={removeForcedSymbol}
              newMainSymbol={newMainSymbol}
              setNewMainSymbol={setNewMainSymbol}
              newForcedSymbol={newForcedSymbol}
              setNewForcedSymbol={setNewForcedSymbol}
              connections={connections}
              exportSettings={exportSettings}
              importSettings={importSettings}
              exporting={exporting}
              importing={importing}
            />
          </TabsContent>

          <TabsContent value="exchange" className="space-y-4">
            <ExchangeTab
              settings={settings}
              handleSettingChange={handleSettingChange}
              newMainSymbol={newMainSymbol}
              setNewMainSymbol={setNewMainSymbol}
              addMainSymbol={addMainSymbol}
              removeMainSymbol={removeMainSymbol}
              newForcedSymbol={newForcedSymbol}
              setNewForcedSymbol={setNewForcedSymbol}
              addForcedSymbol={addForcedSymbol}
              removeForcedSymbol={removeForcedSymbol}
              connections={connections}
            />
          </TabsContent>

          <TabsContent value="indication" className="space-y-4">
            <IndicationTab
              settings={settings}
              handleSettingChange={handleSettingChange}
              getMinIndicationInterval={getMinIndicationInterval}
            />
          </TabsContent>

          <TabsContent value="strategy" className="space-y-4">
            <StrategyTab settings={settings} handleSettingChange={handleSettingChange} />
          </TabsContent>

          <TabsContent value="system" className="space-y-4">
            <SystemTab
              settings={settings}
              handleSettingChange={handleSettingChange}
            />
          </TabsContent>
        </Tabs>
          </div>
        </div>
      </div>
    </AuthGuard>
  )
}
