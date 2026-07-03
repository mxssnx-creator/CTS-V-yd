import fs from "fs"
import path from "path"

const DATA_DIR =
  process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME
    ? path.join("/tmp", "data")
    : path.join(process.cwd(), "data")

const CONNECTIONS_FILE = path.join(DATA_DIR, "connections.json")
const SETTINGS_FILE = path.join(DATA_DIR, "settings.json")
const MAIN_INDICATIONS_FILE = path.join(DATA_DIR, "main-indications.json")
const COMMON_INDICATIONS_FILE = path.join(DATA_DIR, "common-indications.json")

const connectionCache = new Map<string, { data: Connection[]; timestamp: number }>()
const settingsCache = new Map<string, { data: any; timestamp: number }>()
const CACHE_TTL = 5000 // 5 seconds

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true })
      console.log("[v0] Created data directory:", DATA_DIR)
    }
  } catch (error) {
    console.error("[v0] Error creating data directory:", error)
    console.warn("[v0] Continuing without persistent storage")
  }
}

export interface Connection {
  id: string
  user_id: number
  name: string
  exchange: string
  exchange_id: number | null
  api_type: string
  connection_method: string
  connection_library: string
  api_key: string
  api_secret: string
  api_passphrase?: string
  margin_type: string
  position_mode: string
  is_testnet: boolean
  is_enabled: boolean
  is_live_trade: boolean
  is_preset_trade: boolean
  is_active: boolean
  is_predefined: boolean
  volume_factor?: number
  connection_settings?: any
  last_test_at?: string
  last_test_status?: string
  last_test_balance?: number
  last_test_error?: string
  last_test_log?: string[]
  last_test_timestamp?: string
  api_capabilities?: string
  created_at: string
  updated_at: string
}

export interface Settings {
  [key: string]: any
}

export interface MainIndicationSettings {
  direction: {
    enabled: boolean
    range: { from: number; to: number; step: number }
    drawdown_ratio: { from: number; to: number; step: number }
    market_change_range: { from: number; to: number; step: number } // Values: 1, 3, 5, 7, 9 (5 variations)
    market_change_lastpart_base: number // Last 20% activity base (0.2 ratio)
    market_change_lastpart_ratios: { from: number; to: number; step: number } // 1.0, 1.5, 2.0, 2.5 (4 variations)
    min_calculation_time: number // Minimum time for market change calculations
    interval: number
    timeout: number
  }
  move: {
    enabled: boolean
    range: { from: number; to: number; step: number }
    drawdown_ratio: { from: number; to: number; step: number }
    market_change_range: { from: number; to: number; step: number } // Values: 1, 3, 5, 7, 9 (5 variations)
    market_change_lastpart_base: number // Last 20% activity base (0.2 ratio)
    market_change_lastpart_ratios: { from: number; to: number; step: number } // 1.0, 1.5, 2.0, 2.5 (4 variations)
    min_calculation_time: number // Minimum time for market change calculations
    interval: number
    timeout: number
  }
  active: {
    enabled: boolean
    range: { from: number; to: number; step: number }
    activity_calculated: { from: number; to: number; step: number }
    activity_lastpart: { from: number; to: number; step: number }
    market_change_range: { from: number; to: number; step: number } // Values: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (10 variations)
    market_change_lastpart_base: number // Last 20% activity base (0.2 ratio)
    market_change_lastpart_ratios: { from: number; to: number; step: number } // 1.0, 1.5, 2.0, 2.5 (4 variations)
    interval: number
    timeout: number
    min_calculation_time: number
  }
  optimal: {
    enabled: boolean
    range: { from: number; to: number; step: number }
    drawdown_ratio: { from: number; to: number; step: number }
    market_change_range: { from: number; to: number; step: number }
    market_change_lastpart_base: number
    market_change_lastpart_ratios: { from: number; to: number; step: number }
    min_calculation_time: number
    base_positions_limit: number // 250 base pseudo positions max
    interval: number
    timeout: number
    // Performance thresholds
    initial_min_win_rate: number
    expanded_min_win_rate: number
    expanded_min_profit_ratio: number
    production_min_win_rate: number
    production_max_drawdown: number
  }
}

export interface CommonIndicationSettings {
  rsi: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    overbought: { from: number; to: number; step: number }
    oversold: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  macd: {
    enabled: boolean
    fastPeriod: { from: number; to: number; step: number }
    slowPeriod: { from: number; to: number; step: number }
    signalPeriod: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  bollinger: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    stdDev: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  ema: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  sma: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  stochastic: {
    enabled: boolean
    kPeriod: { from: number; to: number; step: number }
    dPeriod: { from: number; to: number; step: number }
    overbought: { from: number; to: number; step: number }
    oversold: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  atr: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    multiplier: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  parabolicSAR: {
    enabled: boolean
    acceleration: { from: number; to: number; step: number }
    maximum: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
  adx: {
    enabled: boolean
    period: { from: number; to: number; step: number }
    threshold: { from: number; to: number; step: number }
    interval: number
    timeout: number
  }
}

function getFromCache(key: string): Connection[] | null {
  const cached = connectionCache.get(key)
  if (!cached) return null

  const now = Date.now()
  if (now - cached.timestamp > CACHE_TTL) {
    connectionCache.delete(key)
    return null
  }

  return cached.data
}

function setInCache(key: string, data: Connection[]): void {
  connectionCache.set(key, { data, timestamp: Date.now() })

  // Cleanup old cache entries (keep only last 50)
  if (connectionCache.size > 50) {
    const entries = Array.from(connectionCache.entries())
    entries.sort((a, b) => a[1].timestamp - b[1].timestamp)
    const toRemove = entries.slice(0, entries.length - 50)
    toRemove.forEach(([key]) => connectionCache.delete(key))
  }
}

export function loadConnections(): Connection[] {
  try {
    ensureDataDir()

    const cached = getFromCache("all_connections")
    if (cached) {
      return cached
    }

    if (fs.existsSync(CONNECTIONS_FILE)) {
      const data = fs.readFileSync(CONNECTIONS_FILE, "utf-8")
      if (data && data.trim()) {
        try {
          const connections = JSON.parse(data)
          if (Array.isArray(connections)) {
            setInCache("all_connections", connections)
            return connections
          }
        } catch (parseError) {
          console.error("[v0] Error parsing connections file:", parseError)
        }
      }
    }

    // Return empty array instead of defaults to avoid re-adding deleted connections
    return []
  } catch (error) {
    console.error("[v0] Error loading connections from file:", error)
    return []
  }
}

export function saveConnections(connections: Connection[]): void {
  try {
    ensureDataDir()
    fs.writeFileSync(CONNECTIONS_FILE, JSON.stringify(connections, null, 2), "utf-8")
    console.log("[v0] Saved", connections.length, "connections to file")

    setInCache("all_connections", connections)

    const groupedByExchange = groupConnectionsByExchange(connections)
    for (const [exchange, exchangeConnections] of groupedByExchange.entries()) {
      setInCache(`exchange:${exchange}`, exchangeConnections)
    }
  } catch (error) {
    console.error("[v0] Error saving connections to file:", error)
    throw error
  }
}

export function loadConnectionsByExchange(exchange: string): Connection[] {
  const cacheKey = `exchange:${exchange}`

  const cached = getFromCache(cacheKey)
  if (cached) {
    console.log("[v0] Loaded", cached.length, "connections for", exchange, "from cache")
    return cached
  }

  // Load all and filter
  const allConnections = loadConnections()
  const filtered = allConnections.filter((c) => c.exchange === exchange)

  // Cache the filtered result
  setInCache(cacheKey, filtered)

  return filtered
}

export function loadConnectionsByIds(ids: string[]): Map<string, Connection> {
  const connections = loadConnections()
  const result = new Map<string, Connection>()

  const idSet = new Set(ids)
  for (const conn of connections) {
    if (idSet.has(conn.id)) {
      result.set(conn.id, conn)
    }
  }

  return result
}

export function batchUpdateConnections(updates: Partial<Connection> & { id: string }[]): void {
  if (updates.length === 0) return

  console.log("[v0] Batch updating", updates.length, "connections")

  const connections = loadConnections()
  const updateMap = new Map(updates.map((u) => [u.id, u]))

  const updatedConnections = connections.map((conn) => {
    const update = updateMap.get(conn.id)
    if (update) {
      return { ...conn, ...update, updated_at: new Date().toISOString() }
    }
    return conn
  })

  saveConnections(updatedConnections)
  console.log("[v0] Batch update complete")
}

function groupConnectionsByExchange(connections: Connection[]): Map<string, Connection[]> {
  const grouped = new Map<string, Connection[]>()

  for (const conn of connections) {
    if (!grouped.has(conn.exchange)) {
      grouped.set(conn.exchange, [])
    }
    grouped.get(conn.exchange)!.push(conn)
  }

  return grouped
}

export function getEnabledConnectionsByExchange(): Map<string, Connection[]> {
  const connections = loadConnections()
  const enabled = connections.filter((c) => c.is_enabled && c.is_active)

  return groupConnectionsByExchange(enabled)
}

export function clearConnectionCache(exchangeOrId?: string): void {
  if (!exchangeOrId) {
    // Clear all cache
    connectionCache.clear()
    console.log("[v0] Cleared all connection cache")
    return
  }

  // Clear specific exchange or all if it's a connection ID
  if (connectionCache.has(`exchange:${exchangeOrId}`)) {
    connectionCache.delete(`exchange:${exchangeOrId}`)
    console.log("[v0] Cleared cache for exchange:", exchangeOrId)
  } else {
    // It's a connection ID, need to clear all as we don't know which exchange
    connectionCache.clear()
    console.log("[v0] Cleared all connection cache (connection update)")
  }
}

export function loadSettings(): Settings {
  try {
    ensureDataDir()

    if (fs.existsSync(SETTINGS_FILE)) {
      const data = fs.readFileSync(SETTINGS_FILE, "utf-8")
      if (data && data.trim()) {
        try {
          const settings = JSON.parse(data)
          if (settings && typeof settings === "object") {
            console.log("[v0] Loaded", Object.keys(settings).length, "settings from file")
            return settings
          }
        } catch (parseError) {
          console.error("[v0] Error parsing settings file:", parseError)
        }
      }
    }

    console.log("[v0] No valid settings file found, using defaults")
    const defaults = getDefaultSettings()
    saveSettings(defaults)
    return defaults
  } catch (error) {
    console.error("[v0] Error loading settings from file:", error)
    return getDefaultSettings()
  }
}

export function saveSettings(settings: Settings): void {
  try {
    ensureDataDir()
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf-8")
    console.log("[v0] Saved", Object.keys(settings).length, "settings to file")
  } catch (error) {
    console.error("[v0] Error saving settings to file:", error)
    throw error
  }
}

export function loadMainIndicationSettings(): MainIndicationSettings {
  try {
    ensureDataDir()

    if (fs.existsSync(MAIN_INDICATIONS_FILE)) {
      const data = fs.readFileSync(MAIN_INDICATIONS_FILE, "utf-8")
      if (data.trim()) {
        const settings = JSON.parse(data)
        console.log("[v0] Loaded main indication settings from file")
        return settings
      }
    }

    console.log("[v0] No main indication settings file found, using defaults")
    const defaults = getDefaultMainIndicationSettings()
    saveMainIndicationSettings(defaults)
    return defaults
  } catch (error) {
    console.error("[v0] Error loading main indication settings:", error)
    const defaults = getDefaultMainIndicationSettings()
    try {
      saveMainIndicationSettings(defaults)
    } catch (saveError) {
      console.error("[v0] Error saving default main indication settings:", saveError)
    }
    return defaults
  }
}

export function saveMainIndicationSettings(settings: MainIndicationSettings): void {
  try {
    ensureDataDir()
    fs.writeFileSync(MAIN_INDICATIONS_FILE, JSON.stringify(settings, null, 2), "utf-8")
    console.log("[v0] Saved main indication settings to file")
  } catch (error) {
    console.error("[v0] Error saving main indication settings:", error)
    throw error
  }
}

export function loadCommonIndicationSettings(): CommonIndicationSettings {
  try {
    ensureDataDir()

    if (fs.existsSync(COMMON_INDICATIONS_FILE)) {
      const data = fs.readFileSync(COMMON_INDICATIONS_FILE, "utf-8")
      if (data.trim()) {
        const settings = JSON.parse(data)
        console.log("[v0] Loaded common indication settings from file")
        return settings
      }
    }

    console.log("[v0] No common indication settings file found, using defaults")
    const defaults = getDefaultCommonIndicationSettings()
    saveCommonIndicationSettings(defaults)
    return defaults
  } catch (error) {
    console.error("[v0] Error loading common indication settings:", error)
    const defaults = getDefaultCommonIndicationSettings()
    try {
      saveCommonIndicationSettings(defaults)
    } catch (saveError) {
      console.error("[v0] Error saving default common indication settings:", saveError)
    }
    return defaults
  }
}

export function saveCommonIndicationSettings(settings: CommonIndicationSettings): void {
  try {
    ensureDataDir()
    fs.writeFileSync(COMMON_INDICATIONS_FILE, JSON.stringify(settings, null, 2), "utf-8")
    console.log("[v0] Saved common indication settings to file")
  } catch (error) {
    console.error("[v0] Error saving common indication settings:", error)
    throw error
  }
}

function getDefaultConnections(): Connection[] {
  return [
    {
      id: "bybit-main-perpetual",
      user_id: 1,
      name: "Bybit Main (Perpetual)",
      exchange: "bybit",
      exchange_id: 2,
      api_type: "perpetual_futures",
      connection_method: "rest",
      connection_library: "rest",
      api_key: "00998877009988770099887700998877",
      api_secret: "00998877009988770099887700998877",
      margin_type: "cross",
      position_mode: "hedge",
      is_testnet: false,
      is_enabled: false,
      is_live_trade: false,
      is_preset_trade: false,
      is_active: false,
      is_predefined: true,
      volume_factor: 1.0,
      connection_settings: {},
      last_test_at: "",
      last_test_status: "",
      last_test_balance: 0,
      last_test_error: "",
      last_test_log: [],
      api_capabilities: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    {
      id: "bingx-main-perpetual",
      user_id: 1,
      name: "BingX Main (Perpetual)",
      exchange: "bingx",
      exchange_id: 9,
      api_type: "perpetual_futures",
      connection_method: "rest",
      connection_library: "rest",
      api_key: "00998877009988770099887700998877",
      api_secret: "00998877009988770099887700998877",
      margin_type: "cross",
      position_mode: "hedge",
      is_testnet: false,
      is_enabled: false,
      is_live_trade: false,
      is_preset_trade: false,
      is_active: false,
      is_predefined: true,
      volume_factor: 1.0,
      connection_settings: {},
      last_test_at: "",
      last_test_status: "",
      last_test_balance: 0,
      last_test_error: "",
      last_test_log: [],
      api_capabilities: "",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
  ]
}

function getDefaultSettings(): Settings {
  return {
    // Overall / Main
    base_volume_factor: 0.1,
    volume_step_ratio: 0.6,
    // Default raised 50 → 300 so volume math divides by 300 by
    // default — see components/settings/utils.ts for the rationale.
    positions_average: 300,
    max_leverage: 125,
    risk_percentage: 20,

    prehistoricDataDays: 5, // Legacy (days) — kept for backward compat
    prehistoric_range_hours: 8, // Canonical: 1-50h, step 1, default 8h — read by engine-manager
    marketTimeframe: 1, // Default 1 second update interval (1,2,3,5,10,15 options)

    mainTradeInterval: 1, // Main trade execution interval in seconds (default: 1, range: 1-10)
    presetTradeInterval: 2, // Preset trade execution interval in seconds (default: 2, range: 1-10)

    maxPositionsPerExchange: {
      bybit: 500, // High capacity - 120 req/min, robust WebSocket
      binance: 500, // High capacity - 1200 req/min, best API limits
      okx: 150, // Medium-high capacity - 600 req/min
      bingx: 100, // Standard capacity - 100 req/min
      kucoin: 150, // Medium capacity - 900 req/min
      huobi: 100, // Standard capacity - 300 req/min
      pionex: 50, // Lower capacity - 100 req/min, smaller exchange
      orangex: 100, // Standard capacity - 100 req/min
      gate: 150, // Medium capacity
      bitget: 150, // Medium capacity
      mexc: 100, // Standard capacity
    },

    mainSymbols: ["BTC", "ETH", "BNB", "XRP", "ADA", "SOL", "DOGE", "LTC", "BCH", "LINK"],
    forcedSymbols: ["XRP", "BCH"], // Always included regardless of settings

    // Overall / Connection
    default_margin_type: "cross",
    default_position_mode: "hedge",
    testnet_enabled: false,

    // Overall / System
    auto_restart: true,
    log_level: "info",
    database_backup: true,
    backup_interval: "24h",

    // Overall / Monitoring
    enable_monitoring: true,
    metrics_retention_days: 30,

    // Exchange
    use_main_symbols: false,
    symbols_count: 30,
    min_volume_enforcement: true,

    // Indication
    indication_time_interval: 1,
    indication_range_min: 3,
    indication_range_max: 30,
    indication_min_profit_factor: 0.7,

    // Strategy
    strategy_time_interval: 1,
    strategy_min_profit_factor: 0.5,
    trailing_enabled: true,
    dca_enabled: false,

    // Notification
    enable_notifications: true,
    enable_telegram: false,
    telegram_token: "",
    telegram_chat_id: "",
  }
}

function getDefaultMainIndicationSettings(): MainIndicationSettings {
  return {
    direction: {
      enabled: true,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 }, // 5 variations: 1, 3, 5, 7, 9
      market_change_lastpart_base: 20, // 20% = 0.2 ratio
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 }, // 1.0, 1.5, 2.0, 2.5 (4 variations)
      min_calculation_time: 3, // 3 seconds minimum
      interval: 1,
      timeout: 3,
    },
    move: {
      enabled: true,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 }, // 5 variations: 1, 3, 5, 7, 9
      market_change_lastpart_base: 20, // 20% = 0.2 ratio
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 }, // 1.0, 1.5, 2.0, 2.5 (4 variations)
      min_calculation_time: 3, // 3 seconds minimum
      interval: 1,
      timeout: 3,
    },
    active: {
      enabled: false,
      range: { from: 1, to: 10, step: 1 },
      activity_calculated: { from: 10, to: 90, step: 10 },
      activity_lastpart: { from: 10, to: 90, step: 10 },
      market_change_range: { from: 1, to: 10, step: 1 }, // 10 variations: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10
      market_change_lastpart_base: 20, // 20% = 0.2 ratio
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 }, // 1.0, 1.5, 2.0, 2.5 (4 variations)
      interval: 1,
      timeout: 3,
      min_calculation_time: 3,
    },
    optimal: {
      enabled: false,
      range: { from: 3, to: 30, step: 1 },
      drawdown_ratio: { from: 0.1, to: 0.5, step: 0.1 },
      market_change_range: { from: 1, to: 10, step: 2 },
      market_change_lastpart_base: 20,
      market_change_lastpart_ratios: { from: 1.0, to: 2.5, step: 0.5 },
      min_calculation_time: 3,
      base_positions_limit: 250,
      interval: 1,
      timeout: 3,
      // Performance thresholds
      initial_min_win_rate: 0.4,
      expanded_min_win_rate: 0.45,
      expanded_min_profit_ratio: 1.2,
      production_min_win_rate: 0.42,
      production_max_drawdown: 0.3,
    },
  }
}

function getDefaultCommonIndicationSettings(): CommonIndicationSettings {
  return {
    rsi: {
      enabled: false,
      period: { from: 8, to: 20, step: 1 },
      overbought: { from: 65, to: 80, step: 1 },
      oversold: { from: 20, to: 35, step: 1 },
      interval: 1,
      timeout: 3,
    },
    macd: {
      enabled: false,
      fastPeriod: { from: 8, to: 16, step: 1 },
      slowPeriod: { from: 20, to: 32, step: 1 },
      signalPeriod: { from: 6, to: 12, step: 1 },
      interval: 1,
      timeout: 3,
    },
    bollinger: {
      enabled: true,
      period: { from: 14, to: 26, step: 1 },
      stdDev: { from: 1.5, to: 2.5, step: 0.1 },
      interval: 1,
      timeout: 3,
    },
    ema: {
      enabled: true,
      period: { from: 8, to: 50, step: 2 },
      interval: 1,
      timeout: 3,
    },
    sma: {
      enabled: true,
      period: { from: 10, to: 50, step: 2 },
      interval: 1,
      timeout: 3,
    },
    stochastic: {
      enabled: true,
      kPeriod: { from: 10, to: 18, step: 1 },
      dPeriod: { from: 2, to: 6, step: 1 },
      overbought: { from: 75, to: 85, step: 1 },
      oversold: { from: 15, to: 25, step: 1 },
      interval: 1,
      timeout: 3,
    },
    atr: {
      enabled: true,
      period: { from: 10, to: 18, step: 1 },
      multiplier: { from: 1.5, to: 3.0, step: 0.1 },
      interval: 1,
      timeout: 3,
    },
    parabolicSAR: {
      enabled: true,
      acceleration: { from: 0.012, to: 0.024, step: 0.001 },
      maximum: { from: 0.12, to: 0.24, step: 0.01 },
      interval: 1,
      timeout: 3,
    },
    adx: {
      enabled: true,
      period: { from: 10, to: 18, step: 1 },
      threshold: { from: 20, to: 30, step: 1 },
      interval: 1,
      timeout: 3,
    },
  }
}

export async function exportConnectionsToFile() {
  try {
    const { query } = await import("@/lib/db")
    const connections = await query(`
      SELECT 
        ec.*,
        vc.base_volume_factor as volume_factor
      FROM exchange_connections ec
      LEFT JOIN volume_configuration vc ON ec.id = vc.connection_id
      WHERE ec.is_active = true
      ORDER BY ec.created_at DESC
    `)

    if (connections.length > 0) {
      saveConnections(connections)
      console.log("[v0] Exported", connections.length, "connections to file")
    }
  } catch (error) {
    console.error("[v0] Error exporting connections:", error)
  }
}

export async function exportSettingsToFile() {
  try {
    const { query } = await import("@/lib/db")
    const settings = await query(`
      SELECT category, subcategory, key, value, value_type
      FROM system_settings
      ORDER BY category, subcategory, key
    `)

    const settingsObject: Settings = {}
    for (const setting of settings) {
      const key = setting.key
      let value = setting.value

      if (setting.value_type === "number") {
        value = Number.parseFloat(value)
      } else if (setting.value_type === "boolean") {
        value = value === "true"
      } else if (setting.value_type === "json") {
        try {
          value = JSON.parse(value)
        } catch {
          value = setting.value
        }
      }

      settingsObject[key] = value
    }

    if (Object.keys(settingsObject).length > 0) {
      saveSettings(settingsObject)
      console.log("[v0] Exported", Object.keys(settingsObject).length, "settings to file")
    }
  } catch (error) {
    console.error("[v0] Error exporting settings:", error)
  }
}
