/**
 * Integration tests for progression API endpoints
 */

describe('Progression API - Integration Tests', () => {
  const baseUrl = 'http://localhost:3002'
  const connectionId = 'bingx-x01'
  let serverAvailable = false

  beforeAll(async () => {
    const response = await fetch(`${baseUrl}/api/health`, {
      signal: AbortSignal.timeout(1500),
    }).catch(() => null)
    serverAvailable = Boolean(response && response.status < 500)
  })

  describe('API Availability', () => {
    test('should return 200 for valid endpoints', async () => {
      if (!serverAvailable) {
        console.warn('[integration] Skipping live API availability check because localhost:3002 is not running')
        return
      }

      const endpoints = [
        `${baseUrl}/api/connections`,
        `${baseUrl}/api/connections/progression/${connectionId}/stats`,
      ]
      
      for (const endpoint of endpoints) {
        const response = await fetch(endpoint).catch(() => ({ status: 0 }))
        expect([200, 304]).toContain(response.status)
      }
    })
  })
})
