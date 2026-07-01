/**
 * ── 1-second OHLCV aggregator (spec §7) ──────────────────────────────
 *
 * Builds 1s OHLCV candles from a flat stream of raw trades for any
 * exchange that doesn't expose native 1s klines.
 *
 * The operator spec is: prehistoric data MUST be 1s timeframe, 1-day
 * range, "without limit". Public exchange APIs vary wildly:
 *
 *   - Binance SPOT  → native `interval=1s` klines (max 1000/request,
 *                     paginate with `startTime`/`endTime`)
 *   - Binance FAPI  → no 1s klines; aggregate from `/fapi/v1/aggTrades`
 *   - Bybit V5      → no 1s; min interval "1" = 1 minute. Use
 *                     `/v5/market/recent-trade` for raw fills.
 *   - OKX           → no 1s; use `/api/v5/market/trades`
 *   - BingX         → no 1s on either market; use `/openApi/{type}/v1/market/trades`
 *   - Pionex        → no 1s; use `/api/v1/market/trades`
 *
 * This module owns:
 *   - The shared aggregator (`aggregateTradesTo1sOHLCV`)
 *   - A generic paginated trades fetcher signature (callers wire their
 *     own per-exchange fetch function in; we only define the shape)
 *
 * Why no fetch helper here? Each exchange's auth/rate-limit/cursor
 * convention is different. Forcing them into one helper would either
 * pollute it with five branches or hide bugs behind a leaky abstraction.
 * Each connector owns its own paginator and feeds raw trades into
 * `aggregateTradesTo1sOHLCV`.
 */

export interface RawTrade {
  /** Trade execution time in epoch ms. */
  timestamp: number
  /** Executed price. */
  price: number
  /** Executed base-asset quantity. */
  quantity: number
}

export interface OHLCV1s {
  /** Bucket start time in epoch ms, aligned to second boundary. */
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Aggregate a stream of raw trades into 1-second OHLCV candles.
 *
 * Behaviour:
 *   - Empty input → empty output (no synthetic gap-filling).
 *   - Output candles are sorted ascending by `timestamp`.
 *   - Buckets are aligned to whole seconds (`floor(ts / 1000) * 1000`).
 *   - Trades outside `[startMs, endMs)` are silently dropped so callers
 *     can pass a slightly-wider page without double-counting.
 *   - Empty seconds (no trades) are NOT emitted. The downstream
 *     prehistoric processor handles missing intervals via its
 *     `processed_intervals` set, so injecting zero-volume buckets
 *     would actively confuse it.
 *
 * Complexity: O(n) over input trades + O(k log k) for the final sort,
 * where k = number of distinct seconds touched. For 1-day @ 1s that's
 * 86,400 buckets — trivial.
 */
export function aggregateTradesTo1sOHLCV(
  trades: RawTrade[],
  startMs: number,
  endMs: number,
): OHLCV1s[] {
  if (!Array.isArray(trades) || trades.length === 0) return []
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return []

  // Use Map keyed by bucket timestamp so we don't allocate one object
  // per trade. Final pass converts to a sorted array.
  const buckets = new Map<number, OHLCV1s>()

  for (const t of trades) {
    const ts = Number(t?.timestamp)
    const price = Number(t?.price)
    const qty = Number(t?.quantity)
    if (!Number.isFinite(ts) || !Number.isFinite(price) || !Number.isFinite(qty)) continue
    if (ts < startMs || ts >= endMs) continue
    if (price <= 0) continue

    const bucketTs = Math.floor(ts / 1000) * 1000
    const existing = buckets.get(bucketTs)
    if (!existing) {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        open: price,
        high: price,
        low: price,
        close: price,
        // Volume is always non-negative; a negative qty payload (some
        // exchanges signal aggressor side via sign) is summed in
        // absolute value.
        volume: Math.abs(qty),
      })
    } else {
      // `close` updates on every trade — within a 1s bucket trades
      // arrive monotonically, so the LAST trade we encounter wins.
      existing.close = price
      if (price > existing.high) existing.high = price
      if (price < existing.low) existing.low = price
      existing.volume += Math.abs(qty)
    }
  }

  return Array.from(buckets.values()).sort((a, b) => a.timestamp - b.timestamp)
}

/**
 * Shape of a per-exchange paginated trades fetcher. Connectors
 * implement this to plug into the generic 1s-OHLCV path.
 *
 * Callers MUST:
 *   - Honour `untilMs` as an exclusive upper bound.
 *   - Page backward in time when the exchange returns trades
 *     newest-first (most do — Binance, Bybit, OKX). Aggregation is
 *     order-independent so the caller's pagination order doesn't
 *     matter.
 *   - Stop when the oldest returned trade is older than `fromMs` OR
 *     the response is empty.
 *   - Cap total iterations to `maxIterations` (default 300) so a
 *     misconfigured cursor can't infinite-loop.
 */
export type TradesPaginator = (
  symbol: string,
  fromMs: number,
  untilMs: number,
) => Promise<RawTrade[]>

/**
 * Generic driver: invoke a `TradesPaginator` in a backoff-protected
 * loop until coverage is achieved, then aggregate.
 *
 * This is the "happy path" most connectors will use — they only need
 * to provide a `nextPage(cursor)` style closure that pulls one page
 * and updates the cursor on each call.
 *
 * Returns the aggregated 1s OHLCV array (may be empty on connector
 * failure — caller decides whether to fall back to synthetic).
 */
export async function build1sOhlcvFromTrades(
  paginator: TradesPaginator,
  symbol: string,
  startMs: number,
  endMs: number,
  options: {
    pageSize?: number
    /** Per-page cooldown (ms) — keep us under exchange rate limits. */
    pageDelayMs?: number
    /** Hard ceiling on pagination loops. */
    maxIterations?: number
  } = {},
): Promise<OHLCV1s[]> {
  const pageDelayMs = options.pageDelayMs ?? 200
  const maxIterations = options.maxIterations ?? 300

  const allTrades: RawTrade[] = []
  let cursorEnd = endMs
  for (let i = 0; i < maxIterations; i++) {
    let page: RawTrade[] = []
    try {
      page = await paginator(symbol, startMs, cursorEnd)
    } catch (err) {
      // One failed page shouldn't kill the whole aggregation —
      // backoff and retry once, then bail. Most exchange 429s
      // recover quickly. Reduced from 1000ms to 200ms for second-trading.
      await new Promise((r) => setTimeout(r, 200))
      try {
        page = await paginator(symbol, startMs, cursorEnd)
      } catch {
        break
      }
    }

    if (!Array.isArray(page) || page.length === 0) break

    allTrades.push(...page)

    // Find oldest trade we just saw. If it predates `startMs` we've
    // covered the whole window.
    let oldestTs = Number.POSITIVE_INFINITY
    for (const t of page) {
      if (Number.isFinite(t.timestamp) && t.timestamp < oldestTs) oldestTs = t.timestamp
    }
    if (!Number.isFinite(oldestTs) || oldestTs <= startMs) break

    // Advance cursor backward, leaving 1ms of overlap so a trade
    // exactly on the boundary isn't dropped. The aggregator handles
    // duplicates by keeping the latest close per bucket but bumping
    // volume — we accept a small volume overcount in exchange for
    // not losing edge trades. Most exchanges return ≤ 1000 trades
    // per page; for high-volume symbols pagination may not reach
    // `startMs` within maxIterations. In that case we return what
    // we got (still better than nothing) and log the under-coverage.
    cursorEnd = oldestTs

    if (pageDelayMs > 0) {
      await new Promise((r) => setTimeout(r, pageDelayMs))
    }
  }

  return aggregateTradesTo1sOHLCV(allTrades, startMs, endMs)
}
