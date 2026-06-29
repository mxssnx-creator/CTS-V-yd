import { getSettings } from "@/lib/redis-db"

export interface SymbolSelectionSnapshot {
  epoch: string
  symbols: string[]
  total: number
}

export function normalizeSymbolList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((s) => String(s).trim()).filter(Boolean)
  if (typeof value !== "string") return []
  const trimmed = value.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed)) return parsed.map((s) => String(s).trim()).filter(Boolean)
  } catch {
    // Legacy fields may be comma/newline separated.
  }
  return trimmed.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
}

export function sameSymbolSelection(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const as = a.map((s) => s.trim()).filter(Boolean).sort()
  const bs = b.map((s) => s.trim()).filter(Boolean).sort()
  return as.every((symbol, index) => symbol === bs[index])
}

export async function getCanonicalSymbolSelection(connectionId: string): Promise<SymbolSelectionSnapshot | null> {
  const state = (await getSettings(`trade_engine_state:${connectionId}`).catch(() => ({}))) as Record<string, unknown>
  const symbols = normalizeSymbolList(state.selected_symbols)
  const total = Number(state.config_set_symbols_total)
  if (symbols.length === 0 && (!Number.isFinite(total) || total <= 0)) return null
  return {
    epoch: String(state.symbol_selection_epoch || state.quickstart_symbol_generation || ""),
    symbols,
    total: symbols.length > 0 ? symbols.length : Math.max(0, total || 0),
  }
}

export async function ownsCanonicalSymbolSelection(connectionId: string, activeSymbols: string[]): Promise<boolean> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (!selection || selection.symbols.length === 0) return true
  return sameSymbolSelection(selection.symbols, activeSymbols)
}

export function epochOwnsActiveSelection(writerEpoch: unknown, activeEpoch: unknown): boolean {
  const active = String(activeEpoch || "").trim()
  if (!active) return true
  return String(writerEpoch || "").trim() === active
}

export async function ownsCanonicalSymbolSelectionEpoch(connectionId: string, activeSymbols: string[], writerEpoch?: unknown): Promise<boolean> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (!selection) return true
  return epochOwnsActiveSelection(writerEpoch ?? selection.epoch, selection.epoch)
    && (selection.symbols.length === 0 || sameSymbolSelection(selection.symbols, activeSymbols))
}

export async function canonicalTotalForSymbols(connectionId: string, activeSymbols: string[]): Promise<number> {
  const selection = await getCanonicalSymbolSelection(connectionId)
  if (selection?.total && selection.total > 0) return selection.total
  return activeSymbols.length
}

export function clampProcessedToTotal(processed: number, total: number): number {
  const safeProcessed = Number.isFinite(processed) && processed > 0 ? Math.floor(processed) : 0
  const safeTotal = Number.isFinite(total) && total > 0 ? Math.floor(total) : 0
  return safeTotal > 0 ? Math.min(safeProcessed, safeTotal) : safeProcessed
}
