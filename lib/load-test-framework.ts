/**
 * Load testing and stress validation framework
 * Simulates high-frequency trading conditions and validates system stability
 */

interface LoadTestConfig {
  connections: number
  symbolsPerConnection: number
  cyclesPerSymbol: number
  concurrencyFactor: number
  failureThreshold: number // Percentage of failures allowed (0-100)
}

interface LoadTestResult {
  totalOperations: number
  successfulOperations: number
  failedOperations: number
  successRate: number
  avgResponseTime: number
  maxResponseTime: number
  minResponseTime: number
  p95ResponseTime: number
  memoryUsedMB: number
  cpuUsagePercent: number
  issues: string[]
  passed: boolean
}

class LoadTestFramework {
  private testResults: LoadTestResult[] = []

  async runLoadTest(config: LoadTestConfig): Promise<LoadTestResult> {
    const startMem = process.memoryUsage().heapUsed / 1024 / 1024
    const startTime = performance.now()

    const operations = config.connections * config.symbolsPerConnection * config.cyclesPerSymbol
    const responseTimes: number[] = []
    let successCount = 0
    let failureCount = 0
    const issues: string[] = []

    // CRITICAL FIX: Properly throttle concurrent operations to prevent memory explosion
    // Previous code accumulated unbounded task array, causing malloc crash with 10K+ tasks.
    // Now we properly await batches of concurrent operations.
    const batchSize = Math.min(config.concurrencyFactor, 100) // Cap at 100 concurrent
    let taskBatch: Promise<any>[] = []

    for (let connIdx = 0; connIdx < config.connections; connIdx++) {
      for (let symIdx = 0; symIdx < config.symbolsPerConnection; symIdx++) {
        for (let cycleIdx = 0; cycleIdx < config.cyclesPerSymbol; cycleIdx++) {
          taskBatch.push(
            this.simulateTradeOperation()
              .then((duration) => {
                responseTimes.push(duration)
                successCount++
              })
              .catch((error) => {
                failureCount++
                issues.push(`Operation failed: ${error.message}`)
              })
          )

          // Execute batch when it reaches size, then clear and start new batch
          if (taskBatch.length >= batchSize) {
            await Promise.allSettled(taskBatch)
            taskBatch = []
          }
        }
      }
    }

    // Wait for any remaining operations in final batch
    if (taskBatch.length > 0) {
      await Promise.allSettled(taskBatch)
    }

    const endTime = performance.now()
    const endMem = process.memoryUsage().heapUsed / 1024 / 1024

    responseTimes.sort((a, b) => a - b)
    const p95Index = Math.floor(responseTimes.length * 0.95)

    const failureRate = (failureCount / operations) * 100
    const passed = failureRate <= config.failureThreshold

    if (!passed) {
      issues.push(`Failure rate ${failureRate.toFixed(2)}% exceeded threshold ${config.failureThreshold}%`)
    }

    if (responseTimes.length > 0 && responseTimes[responseTimes.length - 1] > 300) {
      issues.push(`Cycle duration exceeded 300ms threshold (max: ${responseTimes[responseTimes.length - 1].toFixed(2)}ms)`)
    }

    const result: LoadTestResult = {
      totalOperations: operations,
      successfulOperations: successCount,
      failedOperations: failureCount,
      successRate: (successCount / operations) * 100,
      avgResponseTime: responseTimes.length > 0 ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : 0,
      maxResponseTime: responseTimes.length > 0 ? responseTimes[responseTimes.length - 1] : 0,
      minResponseTime: responseTimes.length > 0 ? responseTimes[0] : 0,
      p95ResponseTime: responseTimes.length > 0 ? responseTimes[p95Index] || 0 : 0,
      memoryUsedMB: endMem - startMem,
      cpuUsagePercent: 0, // Would need process.cpuUsage() integration
      issues,
      passed,
    }

    this.testResults.push(result)
    return result
  }

  private async simulateTradeOperation(): Promise<number> {
    const startTime = performance.now()

    // Simulate operations: price fetch, signal evaluation, order placement
    await this.simulateExchangeCall(10)
    await this.simulateCalculation(5)
    await this.simulateOrderPlacement(15)

    return performance.now() - startTime
  }

  private async simulateExchangeCall(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  private async simulateCalculation(delayMs: number): Promise<void> {
    const start = performance.now()
    while (performance.now() - start < delayMs) {
      Math.sqrt(Math.random())
    }
  }

  private async simulateOrderPlacement(delayMs: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  getTestSummary(): string {
    if (this.testResults.length === 0) return "No tests run"

    const latest = this.testResults[this.testResults.length - 1]
    return `
Load Test Results:
  Total Operations: ${latest.totalOperations}
  Success Rate: ${latest.successRate.toFixed(2)}%
  Avg Cycle: ${latest.avgResponseTime.toFixed(2)}ms
  P95 Cycle: ${latest.p95ResponseTime.toFixed(2)}ms
  Max Cycle: ${latest.maxResponseTime.toFixed(2)}ms
  Memory Delta: ${latest.memoryUsedMB.toFixed(2)}MB
  Status: ${latest.passed ? "PASSED" : "FAILED"}
  ${latest.issues.length > 0 ? `Issues: ${latest.issues.join("; ")}` : ""}
    `
  }
}

export const loadTestFramework = new LoadTestFramework()
