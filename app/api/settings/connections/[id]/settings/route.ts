import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { updateConnection, initRedis, getConnection, getRedisClient, setSettings, getSettings, persistNow } from "@/lib/redis-db"
import { RedisTrades, RedisPositions } from "@/lib/redis-operations"
import { recoordinateAfterSettingsChange } from "@/lib/connection-recoordinator"
import { getTradeEngine } from "@/lib/trade-engine"
import { fetchTopSymbols, normaliseSort } from "@/lib/top-symbols"
import { ProgressionStateManager } from "@/lib/progression-state-manager"
import { toRedisFlag } from "@/lib/boolean-utils"

export const dynamic = "force-dynamic"
export const maxDuration = 30

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    await initRedis()
    const client = getRedisClient()

    const [connection, trades, positions, connSettingsHashRaw, connSettingsPrefixedRaw, tradeEngineStateRaw] = await Promise.all([
      getConnection(id),
      RedisTrades.getTradesByConnection(id).catch(() => []),
      RedisPositions.getPositionsByConnection(id).catch(() => []),
      // The PATCH route mirrors flat fields (symbol_order, symbol_count,
      // leveragePercentage, useMaximalLeverage, etc.) into the separate
      // `connection_settings:{id}` Redis hash so the engine can read them
      // cheaply. The connection.connection_settings JSON blob only carries
      // the nested coordination/strategy structure saved before this hash
      // mirror existed. We must merge both sources so the dialog can hydrate
      // all saved values on open.
      client.hgetall(`connection_settings:${id}`).catch(() => null),
      // ensureBaseConnections and migrations seed into `settings:connection_settings:{id}`
      // (settings:-prefixed). Fall back to this key when the bare key is empty
      // so the dialog always shows the seeded defaults on first boot.
      client.hgetall(`settings:connection_settings:${id}`).catch(() => null),
      // Migrations 055/057/059 and ensureBaseConnections seed symbol_count,
      // live_volume_factor, symbol_order etc. into settings:trade_engine_state:{id}.
      // Read this as an additional source for fields the other hashes may not have yet.
      client.hgetall(`settings:trade_engine_state:${id}`).catch(() => null),
    ])

    // Merge all three hashes: bare key wins over settings:-prefixed wins over trade_engine_state.
    // This ensures symbol_count and live_volume_factor are always available from the
    // migration-seeded trade_engine_state hash even before the user opens the settings dialog.
    const connSettingsHash: Record<string, string> = {
      ...(tradeEngineStateRaw ?? {}),
      ...(connSettingsPrefixedRaw ?? {}),
      ...(connSettingsHashRaw ?? {}),
    }

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Base: parse the nested JSON blob stored on the connection object.
    const jsonSettings = typeof connection.connection_settings === "string"
      ? (() => { try { return JSON.parse(connection.connection_settings) } catch { return {} } })()
      : connection.connection_settings || {}

    // Overlay the flat hash fields on top of the JSON blob. The hash is the
    // authoritative source for any field the PATCH has mirrored there
    // (prevPosMinCount, leveragePercentage, symbol_order, etc.) because the
    // PATCH always writes both stores. Fields that were only ever saved in the
    // JSON blob (coordination_settings, strategies, profitFactorMin) are
    // carried by the JSON blob and not overwritten by the hash overlay.
    const hashSettings: Record<string, unknown> = {}
    if (connSettingsHash && typeof connSettingsHash === "object") {
      for (const [k, v] of Object.entries(connSettingsHash as Record<string, string>)) {
        // Parse numeric strings back to numbers for fields the dialog expects.
        if ([
          "symbol_count", "symbolCount", "leveragePercentage",
          "prevPosMinCount", "prevPosWindow", "mainEvalPosCount",
          "realEvalPosCount", "minStep", "trailingMinStep",
          // Volume / live trading factors
          "live_volume_factor", "volume_factor_live", "preset_volume_factor",
          "volume_step_ratio", "block_volume_step_ratio",
          // Axis max-window values
          "axisPrevMaxWindow", "axisLastMaxWindow", "axisContMaxWindow", "axisPauseMaxWindow",
          // Block strategy tuning
          "blockVolumeRatio", "blockMaxStack", "blockPauseCountRatio", "blockActiveRealEnabled", "blockActiveLiveEnabled",
          "blockVolumeRatio", "blockMaxStack", "blockPauseCountRatio", "blockActiveLiveEnabled",
          // PF / DDT / stage thresholds
          "baseProfitFactor", "mainProfitFactor", "realProfitFactor", "liveProfitFactor",
          "maxDrawdownTimeMainHours", "maxDrawdownTimeRealHours", "maxDrawdownTimeLiveHours",
          "stageMinPosCountBase", "stageMinPosCountMain", "stageMinPosCountReal",
        ].includes(k)) {
          const n = Number(v)
          hashSettings[k] = Number.isFinite(n) ? n : v
        } else if ([
          "useMaximalLeverage",
          "useSystemCloseOnly", "use_system_close_only",
          // Coordination variant toggles
          "variantTrailingEnabled", "variantBlockEnabled",
          "variantDcaEnabled",
          // Axis enable flags
          "axisPrevEnabled", "axisLastEnabled", "axisContEnabled", "axisPauseEnabled",
        ].includes(k)) {
          // Store as boolean so dialog toggle/checkbox checks work correctly.
          hashSettings[k] = v === "true"
        } else if (k === "symbols" || k === "active_symbols" || k === "force_symbols") {
          // Symbols are stored as JSON strings in the hash.
          try { hashSettings[k] = JSON.parse(v) } catch { hashSettings[k] = v }
        } else {
          hashSettings[k] = v
        }
      }
    }

    // Merge: hash fields override JSON blob fields (hash is more recent).
    // Include defaults for newer coordination knobs so existing production
    // connections expose stable values before the first save after upgrade.
    const settings = {
      minStep: 5,
      trailingMinStep: 6,
      ...jsonSettings,
      ...hashSettings,
    }

    return NextResponse.json({
      connection,
      settings,
      statistics: {
        active_trades: trades?.length || 0,
        active_positions: positions?.length || 0,
        created_at: connection.created_at,
        updated_at: connection.updated_at,
      },
    })
  } catch (error) {
    console.error("[v0] [Settings] GET error:", error)
    await SystemLogger.logError(error, "api", "GET /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to fetch settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const body = await request.json()

    await initRedis()
    const client = getRedisClient()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Merge settings with existing (like PATCH does)
    const currentSettings = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}
    const mergedSettings = { ...currentSettings, ...(body.settings || {}) }

    const updated = {
      ...connection,
      name: body.name || connection.name,
      api_type: body.api_type || connection.api_type,
      connection_method: body.connection_method || connection.connection_method,
      connection_library: body.connection_library || connection.connection_library,
      margin_type: body.margin_type || connection.margin_type,
      position_mode: body.position_mode || connection.position_mode,
      is_testnet: body.is_testnet !== undefined ? body.is_testnet : connection.is_testnet,
      is_enabled: body.is_enabled !== undefined ? body.is_enabled : connection.is_enabled,
      is_active: body.is_active !== undefined ? body.is_active : connection.is_active,
      volume_factor: body.volume_factor || connection.volume_factor,
      connection_settings: mergedSettings,
      // Mirror symbol fields to connection hash (CRITICAL - same as PATCH)
      ...(Array.isArray(body.symbols) && body.symbols.length > 0
        ? { force_symbols: JSON.stringify(body.symbols), symbol_count: String(body.symbols.length) }
        : {}),
      updated_at: new Date().toISOString(),
    }

    let effectiveConnection = (await updateConnection(id, updated)) || updated

    // Also write symbols to the flat hash (same as PATCH) so getSymbols() reads them
    if (Array.isArray(body.symbols) && body.symbols.length > 0) {
      try {
        await client.hset(`connection_settings:${id}`, {
          symbols: JSON.stringify(body.symbols),
          force_symbols: JSON.stringify(body.symbols),
          symbol_count: String(body.symbols.length),
        })
      } catch (err) {
        console.warn(`[v0] Failed to update symbol hash for ${id}:`, err)
      }
    }

    // Full propagation: notify + fast-path apply + recoordinate
    // (start/stop/hot-reload as the new state dictates). See
    // lib/connection-recoordinator.ts for the design rationale.
    await recoordinateAfterSettingsChange(id, connection, effectiveConnection, {
      logTag: "PUT /settings",
    })

    await SystemLogger.logConnection(`Updated settings`, id, "info")

    return NextResponse.json({ success: true, connection: effectiveConnection })
  } catch (error) {
    console.error("[v0] [Settings] PUT error:", error)
    await SystemLogger.logError(error, "api", "PUT /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const settings = await request.json()

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const current = typeof connection.connection_settings === "string"
      ? JSON.parse(connection.connection_settings)
      : connection.connection_settings || {}

    const merged = { ...current, ...settings }

    const updated = {
      ...connection,
      connection_settings: merged,
      // Position mode & margin are first-class connection fields that the
      // engine applies to the exchange connector at startup. Mirror them
      // onto the connection object when the dialog sends them so the next
      // (re)start uses the operator's choice.
      ...(typeof settings.position_mode === "string" ? { position_mode: settings.position_mode } : {}),
      ...(typeof settings.margin_mode === "string" ? { margin_type: settings.margin_mode } : {}),
      // MODE FLAGS (CRITICAL): is_live_trade / is_testnet / is_preset_trade are
      // first-class connection flags read by the engine's live-stage on every
      // cycle (connection.is_live_trade), NOT from connection_settings. The
      // previous code stored them only inside the nested settings JSON, so
      // saving Live Trade through this dialog claimed success but the engine
      // never saw it. Mirror them top-level exactly like position_mode.
      ...(settings.is_live_trade !== undefined ? { is_live_trade: toRedisFlag(settings.is_live_trade) } : {}),
      ...(settings.is_testnet !== undefined ? { is_testnet: toRedisFlag(settings.is_testnet) } : {}),
      ...(settings.is_preset_trade !== undefined ? { is_preset_trade: toRedisFlag(settings.is_preset_trade) } : {}),
      // Mirror symbol_count and force_symbols onto the connection hash so
      // getAllConnections() (and the UI card) always shows the current count.
      ...(settings.symbol_count !== undefined ? { symbol_count: String(Number(settings.symbol_count)) } : {}),
      ...(Array.isArray(settings.symbols) && settings.symbols.length > 0
        // Non-empty explicit symbol list → write as force_symbols so getSymbols()
        // uses the operator's resolved / auto-selected list immediately.
        ? { force_symbols: JSON.stringify(settings.symbols), symbol_count: String(settings.symbols.length) }
        // Empty or absent symbols + non-manual order → CLEAR force_symbols so
        // getSymbols() falls through to the exchange auto-resolve path.
        // This lets "volatility_1h" / "volume_24h" etc. re-rank on each start.
        : (Array.isArray(settings.symbols) && settings.symbols.length === 0 &&
           typeof settings.symbol_order === "string" && settings.symbol_order !== "manual")
          ? { force_symbols: "" }
          : {}),
      updated_at: new Date().toISOString(),
    }

    let effectiveConnection = (await updateConnection(id, updated)) || updated

    // ── Flat eval-knob hash mirror (CRITICAL) ───────────────────────────
    // The strategy coordinator and detailed-tracking read the per-eval
    // knobs straight off the `connection_settings:{id}` Redis HASH via
    // hgetall — NOT from the connection object's nested JSON. updateConnection
    // only persists the connection hash (`connection:{id}`), so without this
    // mirror the engine never sees operator changes and silently runs the
    // built-in defaults (prevPosMinCount=5, prevPosWindow=25, etc.). Mirror
    // every flat scalar the merged payload carries so the coordinator's
    // 30s-cached hgetall picks them up on the next refresh window. Values
    // are stringified because the emulator hash stores strings.
    try {
      const flatKnobs: Record<string, string> = {}
      // ── Strategy coordination knobs ─────────────────────────────────────
      const knobKeys = [
        "prevPosMinCount",
        "prevPosWindow",
        "mainEvalPosCount",
        "realEvalPosCount",
        "minStep",
        "trailingMinStep",
      ] as const
      for (const k of knobKeys) {
        const v = (merged as Record<string, unknown>)[k]
        if (typeof v === "number" && Number.isFinite(v)) {
          flatKnobs[k] = String(v)
          // Also write snake_case aliases so both naming styles resolve
          const snake = k.replace(/([A-Z])/g, (m) => "_" + m.toLowerCase())
          if (snake !== k) flatKnobs[snake] = String(v)
        }
      }

      // ── Symbol selection fields ─────────────────────────────────────────
      // Mirror symbol_order, symbol_count, and the resolved symbols list so
      // the GET route can always read them from the hash regardless of whether
      // they were also written to the connection JSON blob.
      {
        const order = (merged as Record<string, unknown>).symbol_order
        if (typeof order === "string" && order.length > 0) flatKnobs.symbol_order = order

        const count = Number((merged as Record<string, unknown>).symbol_count)
        if (Number.isFinite(count) && count > 0) flatKnobs.symbol_count = String(Math.floor(count))

        const syms = (merged as Record<string, unknown>).symbols
        if (Array.isArray(syms) && syms.length > 0) {
          flatKnobs.symbols = JSON.stringify(syms)
          // Also write force_symbols to the connection_settings hash so
          // getSettings("trade_engine_state:{id}") finds the symbols
          flatKnobs.force_symbols = JSON.stringify(syms)
        }
      }

      // ── Position / margin mode ──────────────────────────────────────────
      {
        const pm = (merged as Record<string, unknown>).position_mode
        if (typeof pm === "string") flatKnobs.position_mode = pm

        const mm = (merged as Record<string, unknown>).margin_mode
        if (typeof mm === "string") flatKnobs.margin_mode = mm

        const vt = (merged as Record<string, unknown>).volume_type
        if (typeof vt === "string") flatKnobs.volume_type = vt
      }

      // ── System close flag ───────────────────────────────────────────────
      {
        const sco =
          (merged as Record<string, unknown>).useSystemCloseOnly ??
          (merged as Record<string, unknown>).use_system_close_only
        if (typeof sco === "boolean") {
          flatKnobs.useSystemCloseOnly  = sco ? "true" : "false"
          flatKnobs.use_system_close_only = sco ? "true" : "false"
        }
      }

      // ── Strategy coordination variant / axis / block flattening ─────────
      // The dialog sends the full CoordinationSettings object nested under
      // `coordination_settings`. The strategy coordinator's
      // `loadCoordinationSettings()` reads FLAT scalar keys from the
      // `connection_settings:{id}` hash (axisPrevEnabled,
      // variantBlockEnabled, blockVolumeRatio, etc.). Without flattening
      // here the engine ALWAYS uses its coded defaults (all variants on,
      // all axes off, blockVolumeRatio=1.0) regardless of what the
      // operator sets in the Connection Settings dialog.
      {
        const coord = (merged as Record<string, unknown>).coordination_settings as
          | Record<string, unknown>
          | undefined
        if (coord && typeof coord === "object") {
          // Variant toggles: variants.{trailing,block,dca}; pause is an axis, not a strategy variant.
          //   → flat key variantTrailingEnabled, variantBlockEnabled, …
          const variantsObj = coord.variants as Record<string, unknown> | undefined
          if (variantsObj && typeof variantsObj === "object") {
            for (const [vk, vv] of Object.entries(variantsObj)) {
              if (typeof vv === "boolean" && ["trailing", "block", "dca"].includes(vk)) {
                const cap = vk.charAt(0).toUpperCase() + vk.slice(1)
                flatKnobs[`variant${cap}Enabled`] = vv ? "true" : "false"
              }
            }
          }

          // Axis toggles:  axes.{prev,last,cont,pause}.{enabled,maxWindow}
          //   → flat keys axis{Prev,Last,Cont,Pause}Enabled and …MaxWindow
          const axesObj = coord.axes as Record<string, Record<string, unknown>> | undefined
          if (axesObj && typeof axesObj === "object") {
            for (const [axisKey, axisVal] of Object.entries(axesObj)) {
              if (axisVal && typeof axisVal === "object") {
                const cap = axisKey.charAt(0).toUpperCase() + axisKey.slice(1)
                if (typeof axisVal.enabled === "boolean") {
                  flatKnobs[`axis${cap}Enabled`] = axisVal.enabled ? "true" : "false"
                }
                const mw = Number(axisVal.maxWindow)
                if (Number.isFinite(mw) && mw >= 0) {
                  flatKnobs[`axis${cap}MaxWindow`] = String(mw)
                }
              }
            }
          }

          // Block-strategy tuning knobs (blockVolumeRatio 0.25-3.0,
          // blockMaxStack 1-10, blockPauseCountRatio 1-4 step 0.5,
          // blockActiveRealEnabled boolean).
          // blockMaxStack 2-8, blockPauseCountRatio 1-4 step 0.5,
          // blockActiveLiveEnabled boolean).
          // Previously never written to the hash — engine always used 1.0/3.
          const bvr = Number(coord.blockVolumeRatio)
          if (Number.isFinite(bvr) && bvr > 0) {
            flatKnobs.blockVolumeRatio = String(Math.max(0.25, Math.min(3.0, bvr)))
          }
          const bms = Number(coord.blockMaxStack)
          if (Number.isFinite(bms) && bms >= 1) {
            flatKnobs.blockMaxStack = String(Math.min(10, Math.max(1, Math.floor(bms))))
          }
          const bpcr = Number(coord.blockPauseCountRatio)
          if (Number.isFinite(bpcr) && bpcr > 0) {
            flatKnobs.blockPauseCountRatio = String(Math.max(1, Math.min(4, Math.round(bpcr * 2) / 2)))
          }
          const blockActiveReal =
            typeof coord.blockActiveRealEnabled === "boolean"
              ? coord.blockActiveRealEnabled
              : typeof coord.blockActiveLiveEnabled === "boolean"
                ? coord.blockActiveLiveEnabled
                : undefined
          if (typeof blockActiveReal === "boolean") {
            flatKnobs.blockActiveRealEnabled = String(blockActiveReal)
          }
          if (typeof coord.blockActiveLiveEnabled === "boolean") {
            flatKnobs.blockActiveLiveEnabled = String(coord.blockActiveLiveEnabled)
          }
        }
      }

      // ── Volume factor mirror ─────────────────────────────────────────────
      // Live/Preset order sizing is operator configurable. Base pseudo
      // positions are intentionally ratio/count based and must not expose or
      // persist a separate "Base volume factor" knob, because the base stage
      // never places exchange orders.
      {
        // Accept both field names: the dialog sends volume_factor_live, API callers may send live_volume_factor
        const vflRaw = (merged as Record<string, unknown>).volume_factor_live
          ?? (merged as Record<string, unknown>).live_volume_factor
        const vfl = Number(vflRaw)
        if (Number.isFinite(vfl) && vfl > 0) {
          flatKnobs.volume_factor_live   = String(Math.max(0.1, Math.min(10, vfl)))
          flatKnobs.live_volume_factor   = String(Math.max(0.1, Math.min(10, vfl)))
        }
        const vfp = Number((merged as Record<string, unknown>).volume_factor_preset
          ?? (merged as Record<string, unknown>).preset_volume_factor)
        if (Number.isFinite(vfp) && vfp > 0) {
          flatKnobs.volume_factor_preset  = String(Math.max(0.1, Math.min(10, vfp)))
          flatKnobs.preset_volume_factor  = String(Math.max(0.1, Math.min(10, vfp)))
        }
        const vsr = Number((merged as Record<string, unknown>).volume_step_ratio ?? (merged as Record<string, unknown>).volumeStepRatio)
        if (Number.isFinite(vsr) && vsr > 0) {
          flatKnobs.volume_step_ratio = String(Math.max(0.2, Math.min(1.8, vsr)))
        }
        // control_orders flag — whether to place SL/TP orders
        const co = (merged as Record<string, unknown>).control_orders
        if (co !== undefined && co !== null) {
          flatKnobs.control_orders = co === true || co === "1" || co === "true" ? "1" : "0"
        }
      }

      // ── Per-connection leverage mirror ──────────────────────────────────
      // VolumeCalculator overlays the `connection_settings:{id}` hash on top
      // of global app_settings, reading `leveragePercentage` (1–100) and
      // `useMaximalLeverage` ("true"/"false"). Mirror them so per-connection
      // leverage sizing actually takes effect.
      {
        const lev = Number((merged as Record<string, unknown>).leveragePercentage)
        if (Number.isFinite(lev) && lev > 0) {
          flatKnobs.leveragePercentage = String(Math.max(1, Math.min(100, lev)))
        }
        const useMax = (merged as Record<string, unknown>).useMaximalLeverage
        if (typeof useMax === "boolean") flatKnobs.useMaximalLeverage = useMax ? "true" : "false"
      }

      // ── Per-channel PF / DDT / max-positions flattening (CRITICAL) ──────
      // The dialog stores per-channel strategy tuning nested under
      // `strategies.main.{base,main,real}` as:
      //   min_profit_factor  (× multiplier)
      //   max_drawdown_time  (MINUTES, slider 1–1440)
      //   max_positions      (count)
      // But the coordinator's `loadAppPFThresholds()` reads FLAT, differently
      // named fields and expects DDT in HOURS:
      //   baseProfitFactor / mainProfitFactor / realProfitFactor / liveProfitFactor
      //   maxDrawdownTimeMainHours / ...RealHours / ...LiveHours
      //   stageMinPosCountBase / ...Main / ...Real
      // Until now nothing bridged the two, so per-channel edits silently never
      // reached the engine (it used global app_settings / defaults forever).
      // Flatten + unit-convert here so the coordinator's per-connection
      // resolution (connection hash → global → default) picks them up.
      const strat = (merged as Record<string, unknown>).strategies as
        | Record<string, Record<string, { min_profit_factor?: number; max_drawdown_time?: number; max_positions?: number }>>
        | undefined
      const chan = strat?.main // the live/realtime profile drives the engine
      if (chan) {
        const pf = (raw: unknown): string | null => {
          const n = Number(raw)
          return Number.isFinite(n) && n > 0 ? String(Math.max(0, Math.min(5, n))) : null
        }
        const ddtMinToHr = (raw: unknown): string | null => {
          const n = Number(raw)
          if (!Number.isFinite(n) || n <= 0) return null
          // minutes → hours, clamp to the coordinator's [1,72]h gate window
          return String(Math.max(1, Math.min(72, n / 60)))
        }
        const posCount = (raw: unknown): string | null => {
          const n = Number(raw)
          return Number.isFinite(n) && n > 0 ? String(Math.floor(n)) : null
        }
        const pairs: Array<[string, string | null]> = [
          ["baseProfitFactor", pf(chan.base?.min_profit_factor)],
          ["mainProfitFactor", pf(chan.main?.min_profit_factor)],
          ["realProfitFactor", pf(chan.real?.min_profit_factor)],
          ["maxDrawdownTimeMainHours", ddtMinToHr(chan.main?.max_drawdown_time)],
          ["maxDrawdownTimeRealHours", ddtMinToHr(chan.real?.max_drawdown_time)],
          ["stageMinPosCountBase", posCount(chan.base?.max_positions)],
          ["stageMinPosCountMain", posCount(chan.main?.max_positions)],
          ["stageMinPosCountReal", posCount(chan.real?.max_positions)],
        ]
        for (const [k, v] of pairs) if (v !== null) flatKnobs[k] = v
      }

      if (Object.keys(flatKnobs).length > 0) {
        await getRedisClient().hset(`connection_settings:${id}`, flatKnobs)
        const volumeConnectionPatch: Record<string, string> = {}
        if (flatKnobs.volume_factor_live !== undefined) {
          volumeConnectionPatch.live_volume_factor = flatKnobs.volume_factor_live
        }
        if (flatKnobs.volume_factor_preset !== undefined) {
          volumeConnectionPatch.preset_volume_factor = flatKnobs.volume_factor_preset
        }
        if (flatKnobs.volume_step_ratio !== undefined) {
          volumeConnectionPatch.volume_step_ratio = flatKnobs.volume_step_ratio
        }
        if (flatKnobs.volume_factor !== undefined) {
          volumeConnectionPatch.volume_factor = flatKnobs.volume_factor
        }
        if (Object.keys(volumeConnectionPatch).length > 0) {
          effectiveConnection = (await updateConnection(id, volumeConnectionPatch)) || {
            ...effectiveConnection,
            ...volumeConnectionPatch,
          }
        }
      }
    } catch (mirrorErr) {
      console.error("[v0] [Settings] eval-knob hash mirror failed:", mirrorErr)
    }

    // ── Symbols → engine symbol source (auto-resolve top-N on save) ─────
    // The dialog saves `symbols` (manual list), `symbol_order` (volume /
    // volatility / newest / manual) and `symbol_count` into
    // `connection_settings`. But the engine's `getSymbols()` reads the
    // ACTIVE list from the connection object's `active_symbols` (and the
    // `trade_engine_state:{id}` hash) — it never looks at
    // `connection_settings.symbols`. So without this bridge a saved symbol
    // selection silently never reached the engine.
    //
    // Behaviour:
    //   • symbol_order === "manual" (or a non-empty `symbols` array with that
    //     order): use the operator's explicit list, truncated to symbol_count.
    //   • otherwise: AUTO-RESOLVE the top-N by the chosen order from the public
    //     exchange ticker API (volume / volatility), N = symbol_count.
    // The resolved list is written to BOTH `active_symbols` on the connection
    // and the `trade_engine_state:{id}` hash, then the live engine's symbol
    // cache is invalidated so the next tick (≤ TTL) picks it up without a
    // restart.
    const normalizeSymbolList = (raw: unknown): string[] => {
      if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean)
      if (typeof raw !== "string") return []
      const s = raw.trim()
      if (!s) return []
      if (s.startsWith("[")) {
        try {
          const parsed = JSON.parse(s)
          return Array.isArray(parsed) ? parsed.map(String).map((x) => x.trim()).filter(Boolean) : []
        } catch {
          // fall through to delimiter parsing
        }
      }
      return s.split(/[,|]/).map((x) => x.trim()).filter(Boolean)
    }
    const stableSymbolKey = (symbols: string[]) => symbols.map((s) => s.trim()).filter(Boolean).sort().join("|")
    const beforeForcedSymbols = normalizeSymbolList((connection as Record<string, unknown>).force_symbols)
    const beforeActiveSymbols = normalizeSymbolList((connection as Record<string, unknown>).active_symbols)
    const beforeActiveSymbolKey = stableSymbolKey(beforeForcedSymbols.length > 0 ? beforeForcedSymbols : beforeActiveSymbols)
    let resolvedSymbolsForSettings: string[] | null = null

    const touchedSymbols =
      Array.isArray((settings as Record<string, unknown>).symbols) ||
      typeof (settings as Record<string, unknown>).symbol_order === "string" ||
      (settings as Record<string, unknown>).symbol_count !== undefined
    if (touchedSymbols) {
      try {
        const order = String((merged as Record<string, unknown>).symbol_order || "volume_24h")
        const rawCount = Number((merged as Record<string, unknown>).symbol_count)
        // Allow up to 32 symbols per operator spec (quickstart max 32)
        const count = Number.isFinite(rawCount) && rawCount > 0 ? Math.max(1, Math.min(32, Math.floor(rawCount))) : 15
        const manualList = Array.isArray((merged as Record<string, unknown>).symbols)
          ? ((merged as Record<string, unknown>).symbols as unknown[]).filter(
              (s): s is string => typeof s === "string" && s.length > 0,
            )
          : []

        let resolved: string[] = []
        if (manualList.length > 0) {
          // Operator curated an EXPLICIT symbol list — either typed manually or
          // hand-picked from the ranked 1h-ATR auto-select table in the dialog.
          // Honor it verbatim regardless of `symbol_order`: the order field only
          // records which ranking method seeded the list; once the operator has
          // explicitly chosen symbols, those win over a fresh exchange re-rank.
          //
          // Previously this branch required `order === "manual"`, so any curated
          // selection made while the order was still "volatility_1h" / "volume_24h"
          // (the common case, since the auto-select button sets order to
          // volatility_1h) was silently discarded and the engine re-fetched the
          // exchange top-N instead. The slider count acts only as an upper bound:
          // truncate when the list is LONGER than count, never pad.
          resolved = manualList.length > count ? manualList.slice(0, count) : manualList
        } else {
          // No explicit list — auto-resolve top-N by the chosen order. Call the shared resolver
          // DIRECTLY (no HTTP self-fetch — that fails on loopback/origin inside
          // a route handler, which is why the first cut resolved 0 symbols).
          const exchange = String((connection as Record<string, unknown>).exchange || "bingx").toLowerCase()
          // normaliseSort handles volatility_1h → "volatility_1h" (true 1h ATR)
          // and volatility_24h / volatility → "volatility" (24h priceChangePercent).
          const sort = normaliseSort(order)
          try {
            const { symbols: topSymbols } = await fetchTopSymbols(exchange, count, sort)
            resolved = topSymbols
              .map((s) => s.symbol)
              .filter((s): s is string => typeof s === "string" && s.length > 0)
              .slice(0, count)
          } catch (fetchErr) {
            console.warn(
              "[v0] [Settings] top-symbols auto-resolve failed:",
              fetchErr instanceof Error ? fetchErr.message : fetchErr,
            )
          }
          // If auto-resolve produced nothing, fall back to any manual list the
          // operator had, so we never wipe the engine's symbols.
          if (resolved.length === 0 && manualList.length > 0) resolved = manualList.slice(0, count)
        }

        if (resolved.length > 0) {
          resolvedSymbolsForSettings = resolved
          // 1. Persist as the connection's ACTIVE symbol source (what the engine reads).
          const resolvedSymbolsJson = JSON.stringify(resolved)
          effectiveConnection = (await updateConnection(id, {
            active_symbols: resolvedSymbolsJson,
            // Keep force_symbols in lock-step with the resolved selection.
            // EngineManager.getSymbols() gives force_symbols precedence over
            // active_symbols; leaving an older force_symbols list in place made
            // a successful "save 12 symbols" still boot with the previous
            // migration/admin override list.
            force_symbols: resolvedSymbolsJson,
            symbol_count: String(resolved.length),
            symbol_order: order,
          })) || { ...effectiveConnection, active_symbols: resolvedSymbolsJson, force_symbols: resolvedSymbolsJson, symbol_count: String(resolved.length), symbol_order: order }
          // 2. Mirror into trade_engine_state (the engine's primary lookup) +
          //    seed the prehistoric symbol total so the progress bar denominator
          //    matches the new selection immediately.
          const stateKey = `trade_engine_state:${id}`
          const prevState = (await getSettings(stateKey)) || {}
          const settingsConnectionKey = `connection:${id}`
          const prevSettingsConnection = (await getSettings(settingsConnectionKey)) || {}
          await setSettings(stateKey, {
            ...prevState,
            connection_id: id,
            symbols: resolvedSymbolsJson,
            active_symbols: resolvedSymbolsJson,
            force_symbols: resolvedSymbolsJson,
            config_set_symbols_total: resolved.length,
            updated_at: new Date().toISOString(),
          })
          // 3. Fast-path only: invalidate the running engine's in-memory
          //    symbol cache in this process so the change takes effect on the
          //    next tick without waiting for the durable reload event.
          //    Correctness does NOT depend on this call: production may run
          //    the API route and engine manager in different processes, so
          //    the manager also invalidates its cache when it consumes the
          //    Redis-backed connection_settings reload event below.
          await setSettings(settingsConnectionKey, {
            ...prevSettingsConnection,
            connection_id: id,
            symbols: resolvedSymbolsJson,
            active_symbols: resolvedSymbolsJson,
            force_symbols: resolvedSymbolsJson,
            symbol_count: resolved.length,
            symbol_order: order,
            updated_at: new Date().toISOString(),
          })
          ;(merged as Record<string, unknown>).active_symbols = resolved
          ;(merged as Record<string, unknown>).force_symbols = resolved
          ;(merged as Record<string, unknown>).symbol_count = resolved.length
          // 3. Invalidate the running engine's in-memory symbol cache so the
          //    change takes effect on the next tick without a restart.
          try {
            getTradeEngine()?.getEngineManager(id)?.invalidateSymbolsCache()
          } catch { /* engine may not be running yet — state above is enough */ }
          await persistNow().catch((persistErr: unknown) => {
            console.warn(
              "[v0] [Settings] Persisting resolved symbols failed:",
              persistErr instanceof Error ? persistErr.message : persistErr,
            )
          })
          // Next.js dev can compile this route while another module instance is
          // still finishing migrations. Re-assert the operator's saved symbols
          // shortly after the response so any late migration write that raced
          // this save cannot leave the in-memory store or snapshot on an older
          // canonical symbol list.
          for (const delayMs of [2_000, 6_000]) {
            setTimeout(() => {
              void (async () => {
                await updateConnection(id, {
                  active_symbols: resolvedSymbolsJson,
                  force_symbols: resolvedSymbolsJson,
                  symbol_count: String(resolved.length),
                  symbol_order: order,
                }).catch(() => null)
                await setSettings(stateKey, {
                  connection_id: id,
                  symbols: resolvedSymbolsJson,
                  active_symbols: resolvedSymbolsJson,
                  force_symbols: resolvedSymbolsJson,
                  config_set_symbols_total: resolved.length,
                  updated_at: new Date().toISOString(),
                }).catch(() => null)
                await setSettings(settingsConnectionKey, {
                  connection_id: id,
                  symbols: resolvedSymbolsJson,
                  active_symbols: resolvedSymbolsJson,
                  force_symbols: resolvedSymbolsJson,
                  symbol_count: resolved.length,
                  symbol_order: order,
                  updated_at: new Date().toISOString(),
                }).catch(() => null)
                await persistNow().catch(() => false)
              })()
            }, delayMs)
          }
          console.log(`[v0] [Settings] Resolved ${resolved.length} symbol(s) for ${id} (order=${order}): ${resolved.join(", ")}`)
        }
      } catch (symErr) {
        console.error("[v0] [Settings] symbol auto-resolve failed:", symErr)
      }
    }

    // ── Progression clean-up ONLY on symbol/mode changes (not PF/coordination) ────────
    // Archive + restart progression ONLY when the actual symbols or trade-mode flags
    // change — not on PF / DDT / coordination adjustments which are per-cycle settings
    // that take effect immediately via the hot-reload path. Aggressively archiving on
    // every save caused: (a) the connection to appear "gone" briefly (progression key
    // deleted mid-poll), (b) prehistoric re-run for every PF slider touch, (c) counts
    // reset to 0 just because the operator opened and saved the dialog.
    //
    // SAFE to recoordinate when: symbols list changed, symbol count changed,
    // live/testnet mode flipped, or connection_method changed. NOT on PF/DDT/axis
    // changes, coordination, volume_factor, position_mode, margin_mode alone.
    const beforeSettings = current as Record<string, unknown>
    const afterSettings = merged as Record<string, unknown>
    const scalarChanged = (key: string, beforeFallback?: unknown, afterFallback?: unknown) => {
      if (!Object.prototype.hasOwnProperty.call(settings, key)) return false
      const beforeValue = beforeSettings[key] ?? beforeFallback ?? ""
      const afterValue = afterSettings[key] ?? afterFallback ?? ""
      return JSON.stringify(beforeValue) !== JSON.stringify(afterValue)
    }
    const symbolListChanged =
      resolvedSymbolsForSettings !== null &&
      stableSymbolKey(resolvedSymbolsForSettings) !== beforeActiveSymbolKey
    const manualSymbolsChanged =
      Array.isArray((settings as Record<string, unknown>).symbols) &&
      stableSymbolKey(normalizeSymbolList(beforeSettings.symbols).length > 0
        ? normalizeSymbolList(beforeSettings.symbols)
        : (beforeForcedSymbols.length > 0 ? beforeForcedSymbols : beforeActiveSymbols)) !== stableSymbolKey(normalizeSymbolList(afterSettings.symbols))
    const symbolsModeChanged =
      symbolListChanged ||
      manualSymbolsChanged ||
      scalarChanged("symbol_order", (connection as Record<string, unknown>).symbol_order) ||
      scalarChanged("symbol_count", (connection as Record<string, unknown>).symbol_count) ||
      scalarChanged("is_live_trade", (connection as Record<string, unknown>).is_live_trade, (updated as Record<string, unknown>).is_live_trade) ||
      scalarChanged("is_testnet", (connection as Record<string, unknown>).is_testnet, (updated as Record<string, unknown>).is_testnet) ||
      scalarChanged("is_preset_trade", (connection as Record<string, unknown>).is_preset_trade, (updated as Record<string, unknown>).is_preset_trade) ||
      scalarChanged("connection_method", (connection as Record<string, unknown>).connection_method, (updated as Record<string, unknown>).connection_method)
    let progressionRestartHandled = false
    if (symbolsModeChanged) {
      try {
        const recoordination = await ProgressionStateManager.recoordinateForActualOne(id)
        if (recoordination.changed) {
          // Progression state changed, but the running engine must stay live.
          // Publish a reload-class event so the owning process invalidates symbol
          // and strategy caches in place instead of stopping/restarting live trade.
          try {
            const { notifySettingsChanged } = await import("@/lib/settings-coordinator")
            await notifySettingsChanged(
              id,
              ["connection_settings", "active_symbols", "force_symbols", "symbol_count", "symbol_order"],
              { ...connection, connection_settings: current },
              { ...connection, connection_settings: merged, updated_at: updated.updated_at },
            )
          } catch (notifyErr) {
            console.warn(
              `[v0] [Settings PATCH] reload notify failed for ${id}:`,
              notifyErr instanceof Error ? notifyErr.message : String(notifyErr),
            )
          }
        }
      } catch (recoordErr) {
        console.warn(
          `[v0] [Settings PATCH] recoordinateForActualOne failed for ${id} (non-fatal):`,
          recoordErr instanceof Error ? recoordErr.message : String(recoordErr),
        )
      }

      // The durable reload envelope below carries the concrete symbol/mode
      // field names, so the engine-owning process hot-reloads in place. Do not
      // queue a route-local restart: in production the API route can run in a
      // different worker than the engine, and stop/start races make live trade
      // unstable during normal settings saves.
    }

    // Full propagation. PATCH only ships a partial settings payload, so
    // `detectChangedFields` (which compares top-level connection fields)
    // would report zero changes — pass an explicit override listing the
    // settings keys the caller touched, so the recoordinator knows
    // something inside `connection_settings` actually changed.
    await recoordinateAfterSettingsChange(
      id,
      { ...connection, connection_settings: current },
      { ...effectiveConnection, connection_settings: merged, updated_at: effectiveConnection.updated_at || updated.updated_at },
      {
        logTag: "PATCH /settings",
        changedFieldsOverride: Object.keys(settings).length > 0
          ? Array.from(new Set([...Object.keys(settings), "connection_settings"]))
          : [],
      },
    )

    await SystemLogger.logConnection(`Patched settings`, id, "info")

    return NextResponse.json({ success: true, settings: merged })
  } catch (error) {
    console.error("[v0] [Settings] PATCH error:", error)
    await SystemLogger.logError(error, "api", "PATCH /api/settings/connections/[id]/settings")
    return NextResponse.json(
      { error: "Failed to update settings", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    )
  }
}
