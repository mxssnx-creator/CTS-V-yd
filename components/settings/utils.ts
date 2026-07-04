import { DEFAULT_VOLUME_STEP_RATIO } from "@/lib/constants"
import { Settings } from "./types"
import { toast } from "@/lib/simple-toast"

export const EXCHANGE_MAX_POSITIONS: Record<string, number> = {
  bybit: 500,
  binance: 500,
  okx: 150,
  kucoin: 150,
  gateio: 150,
  bitget: 150,
  mexc: 100,
  bingx: 100,
}

export const initialSettings: Settings = {
  // Overall / Main
  base_volume_factor: 1.0,
  volume_step_ratio: DEFAULT_VOLUME_STEP_RATIO,
  // Default raised 50 → 300 so per-position USD shrinks by 6× and lots
  // more concurrent positions fit inside a tiny live balance. The
  // universal $5 minimum-notional floor in VolumeCalculator still
  // protects every order from going below the exchange minimum.
  positions_average: 300,
  max_leverage: 125,
  negativeChangePercent: 20, // 5-30 step 5, Default 20 - used for loss trigger calculation
  leveragePercentage: 100, // 5-100 step 5, Default 100
  prehistoricDataDays: 5,
  prehistoric_range_hours: 8, // 1-50 hours, step 1, default 8 (canonical prehistoric range)
  marketTimeframe: 1,
  tradeIntervalSeconds: 1,
  realPositionsIntervalSeconds: 0.3,
  validationTimeoutSeconds: 15,
  mainTradeInterval: 1,
  presetTradeInterval: 2,
  positionCost: 0.02, // Fixed default to 0.02 (representing 0.02%)
  useMaximalLeverage: true,
  min_volume_enforcement: true, // Added missing min_volume_enforcement property
  minStep: 5, // 2-30 step 1 — minimum pseudo-position step-window size
  trailingMinStep: 6, // 2-30 step 1 — minimum Base step allowed to fan out into trailing Sets

  // Base Strategy
  baseValueRangeMin: 0.5,
  baseValueRangeMax: 2.5,
  baseRatioMin: 0.2,
  baseRatioMax: 1,
  trailingOption: false,

  // Multi-step trailing — Base Strategies
  // Default: master enabled, full 5×5 matrix on. Operator prunes in
  // Settings → Strategy → Trailing. Spec values:
  //   start ∈ {0.3, 0.6, 0.9, 1.2, 1.5}   step 0.3   (activation)
  //   stop  ∈ {0.1, 0.2, 0.3, 0.4, 0.5}   step 0.1   (trail distance)
  //   step  = stop / 2                                (ratchet increment)
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
  quoteAsset: "USDT",

  // ── Main Trade PF thresholds per stage (spec defaults) ───────────
  // Base 0.9 / Main 1.0 / Real 1.0 / Live 1.0 — mirrored from
  // `app/settings/page.tsx`. Engine reads via
  // `lib/strategy-coordinator.ts:loadAppPFThresholds()` (5s TTL).
  baseProfitFactor: 0.9,
  mainProfitFactor: 1.0,
  realProfitFactor: 1.0,
  liveProfitFactor: 1.0,

  // Risk Management
  trailingStopLoss: false,
  // Per-stage Max Drawdown-Time ceilings (hours). Per-position hold is
  // up to ~2h, so the DDT gate defaults to 4h per stage. Engine reads via
  // loadAppPFThresholds() (h→min). Base stays open.
  maxDrawdownTimeMainHours: 4,
  maxDrawdownTimeRealHours: 4,
  maxDrawdownTimeLiveHours: 4,

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
  maxPositionsPerConfigDirection: 2, // default 2
  maxConcurrentOperations: 100, // 10-250, default 100
  // P0-4: Spec-mandated per-direction cap on active pseudo positions.
  // Default 1 (Long/Short each capped at 1 concurrent pseudo position
  // across ALL Sets). Operator-tunable in Settings → Strategy → Base.
  maxActiveBasePseudoPositionsPerDirection: 1,

  // Strategy pipeline ceilings — Settings → System. Defaults match the
  // production coordinator safety rails so the UI never advertises a value
  // higher than the engine can actually honour.
  strategyMaxEntriesPerSet: 250,
  strategyMainAxisSetsCeiling: 50,
  strategyRealSetsSafetyCeiling: 100,
  maxRealSets: 100,
  strategyLiveSetsCeiling: 90,

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

  database_type: "sqlite",
  database_url: "",
}

export async function saveSettings(settings: Settings) {
  try {
    const response = await fetch("/api/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    })

    if (!response.ok) {
      const errorData = await response.json()
      throw new Error(errorData.error || "Failed to save settings")
    }

    const data = await response.json()
    toast.success("Settings Saved", {
      description: "All settings have been saved successfully",
    })
    return data
  } catch (error) {
    console.error("Error saving settings:", error)
    toast.error("Save Failed", {
      description: error instanceof Error ? error.message : "Failed to save settings",
    })
    throw error
  }
}

export async function loadSettings(): Promise<Settings | null> {
  try {
    const response = await fetch("/api/settings")
    if (response.ok) {
      const data = await response.json()
      if (!data.settings) {
        console.error("[v0] No settings found in response")
        return null
      }
      return data.settings
    }
    return null
  } catch (error) {
    console.error("Error loading settings:", error)
    return null
  }
}

export async function exportSettingsToFile(settings: Settings) {
  try {
    const dataStr = JSON.stringify(settings, null, 2)
    const dataBlob = new Blob([dataStr], { type: "application/json" })
    const url = URL.createObjectURL(dataBlob)
    const link = document.createElement("a")
    link.href = url
    link.download = `settings-${new Date().toISOString().split("T")[0]}.json`
    link.click()
    URL.revokeObjectURL(url)

    toast.success("Settings Exported", {
      description: "Settings file downloaded successfully",
    })
  } catch (error) {
    console.error("Error exporting settings:", error)
    toast.error("Export Failed", {
      description: "Failed to export settings",
    })
  }
}

export function importSettingsFromFile(onSuccess: (settings: Partial<Settings>) => void) {
  const input = document.createElement("input")
  input.type = "file"
  input.accept = ".json"

  input.onchange = async (e) => {
    const file = (e.target as HTMLInputElement).files?.[0]
    if (!file) return

    try {
      const text = await file.text()
      const importedSettings = JSON.parse(text)
      onSuccess(importedSettings)
      toast.success("Settings Imported", {
        description: "Settings imported successfully. Click save to apply.",
      })
    } catch (error) {
      console.error("Error importing settings:", error)
      toast.error("Import Failed", {
        description: "Failed to parse settings file",
      })
    }
  }

  input.click()
}
