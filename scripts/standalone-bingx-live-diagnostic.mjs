#!/usr/bin/env node
/**
 * Standalone BingX live-readiness diagnostic.
 *
 * This intentionally does not place orders. It verifies that the environment
 * can reach BingX public market data, that the configured symbol fan-out is the
 * operator maximum, and that credentials are present before any real order test
 * can run through the Next.js quickstart API.
 */

import fs from 'node:fs'
import path from 'node:path'

function loadLocalEnv() {
  for (const file of ['.env.local', '.env.production.local', '.env']) {
    const full = path.join(process.cwd(), file)
    if (!fs.existsSync(full)) continue
    for (const line of fs.readFileSync(full, 'utf8').split(/\r?\n/)) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const idx = trimmed.indexOf('=')
      if (idx <= 0) continue
      const key = trimmed.slice(0, idx).trim()
      const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '')
      if (!process.env[key]) process.env[key] = value
    }
  }
}

loadLocalEnv()

const DEFAULT_SYMBOLS = [
  "PLAYSOUTUSDT", "XANUSDT", "BSBUSDT", "NILUSDT", "BILLUSDT", "GITLAWBUSDT", "UBUSDT", "ASTEROIDETHUSDT",
  "RKCUSDT", "ERAUSDT", "DRIFTUSDT", "WIFUSDT", "1000PEPEUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT",
  "SOLUSDT", "SUIUSDT", "LINKUSDT", "AVAXUSDT", "OPUSDT", "ARBUSDT", "APTUSDT", "NEARUSDT",
  "FILUSDT", "DOTUSDT", "LTCUSDT", "BCHUSDT", "UNIUSDT", "TRXUSDT", "ETCUSDT", "ATOMUSDT",
]

function readSymbols() {
  const raw = process.argv[2]
  if (!raw) return DEFAULT_SYMBOLS
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((s) => typeof s === 'string' && s.length > 0).slice(0, 32)
  } catch {}
  return raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 32)
}

function hasBingxCredentials() {
  const key = process.env.BINGX_API_KEY || process.env.BINGX_APIKEY || process.env.NEXT_BINGX_API_KEY || process.env.NEXT_PUBLIC_BINGX_API_KEY
  const secret = process.env.BINGX_API_SECRET || process.env.BINGX_SECRET || process.env.NEXT_BINGX_API_SECRET || process.env.NEXT_PUBLIC_BINGX_API_SECRET
  return Boolean(key && secret && key.length >= 10 && secret.length >= 10)
}

async function fetchBingxTickers() {
  const urls = [
    'https://open-api.bingx.com/openApi/swap/v2/quote/ticker',
    'https://open-api.bingx.com/openApi/swap/v2/quote/contracts',
  ]
  for (const url of urls) {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`BingX public API ${url} returned HTTP ${res.status}`)
    const json = await res.json()
    if (json && (Array.isArray(json.data) || json.data)) return { url, json }
  }
  throw new Error('BingX public API returned no usable data')
}

async function main() {
  const symbols = readSymbols()
  let publicData = null
  let publicApiWarning = null
  try {
    publicData = await fetchBingxTickers()
  } catch (err) {
    publicApiWarning = err instanceof Error ? err.message : String(err)
  }
  const data = publicData && Array.isArray(publicData.json.data) ? publicData.json.data : []
  const symbolSet = new Set(data.map((d) => String(d.symbol || d.contract || '').replace('-', '')).filter(Boolean))
  const available = symbols.filter((s) => symbolSet.has(s) || symbolSet.has(s.replace('USDT', '-USDT')))
  const missing = symbols.filter((s) => !available.includes(s))
  const credentials = hasBingxCredentials()
  const publicApiReachable = Boolean(publicData?.url && !publicApiWarning)

  const result = {
    success: publicApiReachable && available.length > 0,
    mode: 'standalone-readiness-no-orders',
    publicApi: publicData?.url || null,
    publicApiWarning,
    requestedSymbols: symbols.length,
    maxSymbolsAllowed: 32,
    availableSymbols: available.length,
    missingSymbols: missing,
    lowestVolumeFactor: 0.1,
    hasCredentials: credentials,
    canPlaceLiveOrders: credentials && publicApiReachable && available.length > 0,
    note: credentials
      ? publicApiReachable
        ? 'Credentials detected and BingX public API is reachable. Run the Next.js quickstart API only when intentional live order placement is acceptable.'
        : 'Credentials detected, but BingX public API is not reachable from this environment; live order-path testing was not attempted.'
      : 'No BingX credentials detected in this environment; real order placement was intentionally not attempted.',
  }
  console.log(JSON.stringify(result, null, 2))

  if (symbols.length < 1 || symbols.length > 32) process.exit(1)
  if (!result.success) process.exit(1)
}

main().catch((err) => {
  console.error('[standalone-bingx-live-diagnostic] failed:', err instanceof Error ? err.message : String(err))
  process.exit(1)
})
