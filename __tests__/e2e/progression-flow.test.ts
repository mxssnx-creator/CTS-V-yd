/**
 * End-to-end tests for complete progression flow
 */

describe('Progression Flow - E2E Tests', () => {
  const connectionId = 'bingx-x01'
  const baseUrl = 'http://localhost:3002'
  let serverAvailable = false

  beforeAll(async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null)
    serverAvailable = Boolean(response && response.status < 500)
  })

  describe('No Hanging Under Load', () => {
    test('should complete 20 concurrent requests within timeout', async () => {
      if (!serverAvailable) {
        console.warn('[e2e] Skipping live progression load check because localhost:3002 is not running')
        return
      }

      const concurrentRequests = 20
      const timeoutMs = 30000
      
      const requests = Array(concurrentRequests).fill(null).map(() =>
        fetch(`${baseUrl}/api/connections/progression/${connectionId}/stats`)
      )
      
      const start = Date.now()
      const results = await Promise.all(requests)
      const elapsed = Date.now() - start
      
      expect(elapsed).toBeLessThan(timeoutMs)
      results.forEach(res => {
        expect([200, 304]).toContain(res.status)
      })
    })
  })
})
