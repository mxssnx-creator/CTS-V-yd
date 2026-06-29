import { clampProcessedToTotal, epochOwnsActiveSelection, sameSymbolSelection } from "@/lib/trade-engine/symbol-selection-ownership"

describe("symbol total ownership regression", () => {
  test("QuickStart 1→N keeps the new denominator while stale prehistoric progress is in flight", () => {
    const oldEngineSymbols = ["BTCUSDT"]
    const quickStartSymbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "XRPUSDT"]
    const canonicalTotal = quickStartSymbols.length

    expect(sameSymbolSelection(oldEngineSymbols, quickStartSymbols)).toBe(false)

    const staleCompletionIgnored = !sameSymbolSelection(oldEngineSymbols, quickStartSymbols)
      ? 0
      : clampProcessedToTotal(1, canonicalTotal)
    expect(`${staleCompletionIgnored}/${canonicalTotal}`).toBe("0/4")

    const resetForCurrentEpoch = clampProcessedToTotal(0, canonicalTotal)
    expect(`${resetForCurrentEpoch}/${canonicalTotal}`).toBe("0/4")

    const doneForCurrentEpoch = clampProcessedToTotal(quickStartSymbols.length, canonicalTotal)
    expect(`${doneForCurrentEpoch}/${canonicalTotal}`).toBe("4/4")
  })

  test("processed counts never exceed the canonical selected total", () => {
    expect(clampProcessedToTotal(8, 4)).toBe(4)
  })

  test("QuickStart 1→N rejects stale in-flight prehistoric writers by epoch", () => {
    const oldEpoch = "qs-1000"
    const activeEpoch = "qs-2000"
    const activeQuickStartCount = 4
    const stalePrehistoricTotal = 1

    expect(epochOwnsActiveSelection(oldEpoch, activeEpoch)).toBe(false)
    const displayedTotal = epochOwnsActiveSelection(oldEpoch, activeEpoch)
      ? stalePrehistoricTotal
      : activeQuickStartCount

    expect(displayedTotal).toBe(4)
  })
})
