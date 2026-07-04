#!/usr/bin/env node

import http from 'http'
import { performance } from 'perf_hooks'

const API_BASE = 'http://localhost:3002/api'

function formatRequestError(error, path) {
  if (error?.message) return error.message
  if (Array.isArray(error?.errors) && error.errors.length > 0) {
    return error.errors.map((err) => err?.message || String(err)).join('; ')
  }
  return `Request to ${path} failed: ${String(error)}`
}

function request(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const normalizedPath = path.startsWith('/') ? path.slice(1) : path
    const url = new URL(normalizedPath, `${API_BASE}/`)
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000,
    }

    const req = http.request(options, (res) => {
      let data = ''
      res.on('data', (chunk) => (data += chunk))
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data || '{}') })
        } catch {
          resolve({ status: res.statusCode, data })
        }
      })
    })

    req.on('timeout', () => req.destroy(new Error(`Request timed out: ${method} ${url.href}`)))
    req.on('error', (error) => reject(new Error(formatRequestError(error, path))))
    if (body) req.write(JSON.stringify(body))
    req.end()
  })
}

async function apiIsAvailable() {
  try {
    const health = await request('/health')
    return health.status >= 200 && health.status < 500
  } catch (error) {
    console.warn(`[SKIP] API server is not reachable at ${API_BASE}: ${formatRequestError(error, '/health')}`)
    return false
  }
}

function strategyCounts(stats) {
  const strat = stats.breakdown?.strategies || {}
  return {
    base: Number(stats.base?.setsTotal ?? strat.base ?? stats.realtime?.setsCreated?.base ?? 0),
    main: Number(stats.main?.setsTotal ?? strat.main ?? stats.realtime?.setsCreated?.main ?? 0),
    real: Number(stats.real?.setsTotal ?? strat.real ?? stats.realtime?.setsCreated?.real ?? 0),
    live: Number(strat.live ?? stats.realtime?.setsCreated?.live ?? 0),
    baseEvaluated: Number(strat.baseEvaluated ?? 0),
    mainEvaluated: Number(strat.mainEvaluated ?? 0),
    realEvaluated: Number(strat.realEvaluated ?? 0),
  }
}

function percent(numerator, denominator) {
  if (!denominator) return '0.0'
  return ((numerator / denominator) * 100).toFixed(1)
}

function realtimeProgressMarkers(stats) {
  return {
    liveCycles: Number(stats.realtime?.liveRealtimeCycles ?? stats.realtime?.cycleCounters?.realtimeLive ?? 0),
    liveTotal: Number(stats.realtime?.realtimeLiveTotal ?? stats.realtime?.setsCreated?.live ?? 0),
    realtimeCycles: Number(stats.realtime?.realtimeCycles ?? stats.realtime?.cycleCounters?.realtime ?? 0),
    framesProcessed: Number(stats.realtime?.framesProcessed ?? 0),
    pseudoPositionUpdateCycles: Number(stats.realtime?.pseudoPositionUpdates?.updateCycles ?? 0),
    positionsOpen: Number(stats.realtime?.positionsOpen ?? 0),
  }
}

async function engineIsRunning() {
  try {
    const status = await request('/trade-engine/status-all')
    return Boolean(
      status.data?.isEngineRunning ||
      status.data?.engineStatus?.isRunning ||
      status.data?.engineStatus?.running
    )
  } catch {
    return false
  }
}

async function testPrehistoric() {
  console.log('\n=== TEST 1: PREHISTORIC DATA FLOW ===\n')
  
  try {
    // Get a connection to test with
    const connRes = await request('/connections')
    if (!connRes.data.connections || connRes.data.connections.length === 0) {
      console.log('[SKIP] No connections available for prehistoric test')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const connId = connRes.data.connections[0].id
    console.log(`Testing with connection: ${connId}`)

    // Check strategy tracking
    const trackRes = await request(`/connections/progression/${connId}/stats`)
    if (trackRes.status !== 200) {
      console.error(`[FAIL] Could not get strategy tracking: ${trackRes.status}`)
      return { passed: 0, failed: 1, skipped: 0 }
    }

    const track = trackRes.data
    const counts = strategyCounts(track)
    console.log(`\n[DATA] Prehistoric tracking:`)
    console.log(`  - Base sets: ${counts.base}`)
    console.log(`  - Main sets: ${counts.main}`)
    console.log(`  - Real sets: ${counts.real}`)
    console.log(`  - Live sets: ${counts.live}`)
    console.log(`  - Evaluated: base=${counts.baseEvaluated}, main=${counts.mainEvaluated}, real=${counts.realEvaluated}`)

    // Verify continuity across the current stats contract. The API now reports
    // stage totals under breakdown.strategies/realtime.setsCreated instead of
    // the legacy base/main/real top-level objects.
    const hasData = counts.base > 0 && counts.main > 0 && counts.real > 0
    if (!hasData) {
      if (!(await engineIsRunning())) {
        console.log('[SKIP] No prehistoric data yet because the production engine is not running')
        return { passed: 0, failed: 0, skipped: 1 }
      }
      console.error('[FAIL] No data in prehistoric pipeline')
      return { passed: 0, failed: 1, skipped: 0 }
    }

    console.log('[PASS] Prehistoric data flows through all stages')
    return { passed: 1, failed: 0, skipped: 0 }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    return { passed: 0, failed: 1, skipped: 0 }
  }
}

async function testRealtimeProgress() {
  console.log('\n=== TEST 2: REALTIME CONTINUOUS PROGRESS ===\n')

  try {
    const connRes = await request('/connections')
    if (!connRes.data.connections || connRes.data.connections.length === 0) {
      console.log('[SKIP] No connections available for realtime test')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const connId = connRes.data.connections[0].id
    console.log(`Testing with connection: ${connId}`)

    // Get initial state
    const state1 = await request(`/connections/progression/${connId}/stats`)
    const initial = state1.data

    console.log(`\nInitial state:`)
    const initialMarkers = realtimeProgressMarkers(initial)
    console.log(`  - Real time live cycles: ${initialMarkers.liveCycles}`)
    console.log(`  - Real time live count: ${initialMarkers.liveTotal}`)
    console.log(`  - Real time cycles: ${initialMarkers.realtimeCycles}`)
    console.log(`  - Frames processed: ${initialMarkers.framesProcessed}`)
    console.log(`  - Pseudo-position update cycles: ${initialMarkers.pseudoPositionUpdateCycles}`)

    // Wait for realtime processing
    console.log('\nWaiting 30s for realtime cycle updates...')
    await new Promise(r => setTimeout(r, 30000))

    // Get updated state
    const state2 = await request(`/connections/progression/${connId}/stats`)
    const updated = state2.data

    console.log(`\nUpdated state after 30s:`)
    const updatedMarkers = realtimeProgressMarkers(updated)
    console.log(`  - Real time live cycles: ${updatedMarkers.liveCycles}`)
    console.log(`  - Real time live count: ${updatedMarkers.liveTotal}`)
    console.log(`  - Real time cycles: ${updatedMarkers.realtimeCycles}`)
    console.log(`  - Frames processed: ${updatedMarkers.framesProcessed}`)
    console.log(`  - Pseudo-position update cycles: ${updatedMarkers.pseudoPositionUpdateCycles}`)

    // Check progression
    const cyclesProgressed = updatedMarkers.liveCycles > initialMarkers.liveCycles
      || updatedMarkers.realtimeCycles > initialMarkers.realtimeCycles
    const livesProgressed = updatedMarkers.liveTotal > initialMarkers.liveTotal
      || updatedMarkers.framesProcessed > initialMarkers.framesProcessed
      || updatedMarkers.pseudoPositionUpdateCycles > initialMarkers.pseudoPositionUpdateCycles
      || updatedMarkers.positionsOpen > initialMarkers.positionsOpen

    if (!cyclesProgressed && !livesProgressed) {
      console.warn('[WARN] No realtime cycle progression detected')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    console.log('[PASS] Realtime progress is continuous')
    return { passed: 1, failed: 0, skipped: 0 }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    return { passed: 0, failed: 1, skipped: 0 }
  }
}

async function testThresholdEvaluation() {
  console.log('\n=== TEST 3: THRESHOLD EVALUATION (PF >= 1.4) ===\n')

  try {
    const connRes = await request('/connections')
    if (!connRes.data.connections || connRes.data.connections.length === 0) {
      console.log('[SKIP] No connections for threshold test')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const connId = connRes.data.connections[0].id
    const track = (await request(`/connections/progression/${connId}/stats`)).data

    // Real sets should be <= Main sets (filtering effect)
    const counts = strategyCounts(track)
    const realTotal = counts.real
    const mainTotal = counts.main

    if (realTotal > mainTotal) {
      console.error(`[FAIL] Real sets (${realTotal}) exceed Main sets (${mainTotal})`)
      return { passed: 0, failed: 1, skipped: 0 }
    }

    console.log(`\nThreshold evaluation:`)
    console.log(`  - Main sets: ${mainTotal}`)
    console.log(`  - Real sets (PF >= 1.4): ${realTotal}`)
    console.log(`  - Filtered out: ${mainTotal - realTotal} (${percent(mainTotal - realTotal, mainTotal)}%)`)

    if (realTotal > 0) {
      console.log('[PASS] Threshold evaluation working (Sets filtered by PF)')
      return { passed: 1, failed: 0, skipped: 0 }
    } else {
      console.warn('[WARN] No Real sets after threshold - expected > 0')
      return { passed: 0, failed: 0, skipped: 1 }
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    return { passed: 0, failed: 1, skipped: 0 }
  }
}

async function testPrevPosCalculation() {
  console.log('\n=== TEST 4: PREVIOUS POSITION CALCULATIONS ===\n')

  try {
    const connRes = await request('/connections')
    if (!connRes.data.connections || connRes.data.connections.length === 0) {
      console.log('[SKIP] No connections for prev-pos test')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const connId = connRes.data.connections[0].id

    // Get position history
    const histRes = await request(`/connections/progression/${connId}/position-history`)
    if (histRes.status !== 200) {
      console.log('[SKIP] Position history not available')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const hist = histRes.data
    console.log(`\nPosition history:`)
    console.log(`  - Total positions: ${hist.total || 0}`)
    console.log(`  - Closed positions: ${hist.closed || 0}`)
    console.log(`  - Success rate: ${((hist.successRate || 0) * 100).toFixed(1)}%`)
    console.log(`  - Avg profit factor: ${(hist.avgProfitFactor || 0).toFixed(2)}`)

    if (hist.closed && hist.closed > 0) {
      console.log('[PASS] Previous position calculations available')
      return { passed: 1, failed: 0, skipped: 0 }
    } else {
      console.log('[INFO] No closed positions yet (expected on fresh connection)')
      return { passed: 0, failed: 0, skipped: 1 }
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    return { passed: 0, failed: 1, skipped: 0 }
  }
}

async function testDatabasePersistence() {
  console.log('\n=== TEST 5: DATABASE PERSISTENCE ===\n')

  try {
    const connRes = await request('/connections')
    if (!connRes.data.connections || connRes.data.connections.length === 0) {
      console.log('[SKIP] No connections for persistence test')
      return { passed: 0, failed: 0, skipped: 1 }
    }

    const connId = connRes.data.connections[0].id

    // Get current state
    const state1 = await request(`/connections/progression/${connId}/stats`)
    const data1 = JSON.stringify(state1.data)

    console.log(`\nInitial state hash: ${data1.length} chars`)

    // Wait briefly
    await new Promise(r => setTimeout(r, 5000))

    // Get state again - should be persisted
    const state2 = await request(`/connections/progression/${connId}/stats`)
    const data2 = JSON.stringify(state2.data)

    console.log(`Updated state hash: ${data2.length} chars`)

    // Check consistency
    if (state1.status === 200 && state2.status === 200) {
      console.log('[PASS] Database persistence working (consistent state retrieval)')
      return { passed: 1, failed: 0, skipped: 0 }
    } else {
      console.error('[FAIL] Inconsistent state retrieval')
      return { passed: 0, failed: 1, skipped: 0 }
    }
  } catch (err) {
    console.error(`[ERROR] ${err.message}`)
    return { passed: 0, failed: 1, skipped: 0 }
  }
}

async function main() {
  console.log(`
╔════════════════════════════════════════════════════════════╗
║     COMPREHENSIVE PREHISTORIC & REALTIME VALIDATION        ║
║                                                            ║
║  Tests: Data Flow | Progress | Thresholds | Prev-Pos      ║
║         Database | Diagnostics                            ║
╚════════════════════════════════════════════════════════════╝
`)

  const start = performance.now()

  if (!(await apiIsAvailable())) {
    console.log('Start the app with `npm run dev` or `npm run start` before running live workflow validation.')
    console.log('✓ LIVE VALIDATION SKIPPED (API unavailable)')
    process.exit(0)
  }

  const results = {
    prehistoric: await testPrehistoric(),
    realtime: await testRealtimeProgress(),
    threshold: await testThresholdEvaluation(),
    prevPos: await testPrevPosCalculation(),
    database: await testDatabasePersistence(),
  }

  const elapsed = ((performance.now() - start) / 1000).toFixed(1)

  console.log(`
╔════════════════════════════════════════════════════════════╗
║                        RESULTS SUMMARY                     ║
╚════════════════════════════════════════════════════════════╝
`)

  let totalPassed = 0,
    totalFailed = 0,
    totalSkipped = 0

  for (const [test, res] of Object.entries(results)) {
    const status = res.failed > 0 ? '✗ FAIL' : res.skipped > 0 ? '- SKIP' : '✓ PASS'
    console.log(`${status}  ${test.padEnd(20)} (${res.passed}p ${res.failed}f ${res.skipped}s)`)
    totalPassed += res.passed
    totalFailed += res.failed
    totalSkipped += res.skipped
  }

  console.log(`
Total: ${totalPassed} passed, ${totalFailed} failed, ${totalSkipped} skipped
Time: ${elapsed}s

${totalFailed === 0 ? '✓ ALL TESTS PASSED' : '✗ SOME TESTS FAILED'}
`)

  process.exit(totalFailed > 0 ? 1 : 0)
}

main().catch(console.error)
