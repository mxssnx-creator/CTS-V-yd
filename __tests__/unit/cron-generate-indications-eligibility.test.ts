import { getCronEngineEligibleConnections } from "@/lib/cron-engine-eligibility"

describe("generate-indications cron connection eligibility", () => {
  test("processes only engine-eligible assigned/enabled connections and valid queued starts", async () => {
    const now = new Date().toISOString()
    const fixtureConnections = [
      {
        id: "assigned-only",
        exchange: "bingx",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "0",
        state_switch_version: "1",
      },
      {
        id: "active-inserted-only",
        exchange: "bingx",
        api_type: "perpetual_futures",
        is_active_inserted: "1",
        is_enabled_dashboard: "0",
        state_switch_version: "1",
      },
      {
        id: "dashboard-enabled",
        exchange: "bingx",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "1",
        state_switch_version: "1",
      },
      {
        id: "disabled",
        exchange: "bingx",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "0",
        state_switch_version: "1",
      },
      {
        id: "queued-valid",
        exchange: "bybit",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "1",
        state_switch_version: "7",
      },
      {
        id: "queued-disabled",
        exchange: "bybit",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "0",
        state_switch_version: "3",
      },
      {
        id: "queued-version-mismatch",
        exchange: "bybit",
        api_type: "perpetual_futures",
        is_assigned: "1",
        is_enabled_dashboard: "1",
        state_switch_version: "8",
      },
    ]

    const assignedAndEnabledFixture = fixtureConnections.filter((connection) => connection.id === "dashboard-enabled")
    const getConnection = jest.fn(async (connectionId: string) =>
      fixtureConnections.find((connection) => connection.id === connectionId) ?? null,
    )

    const result = await getCronEngineEligibleConnections(
      async () => assignedAndEnabledFixture,
      async () => [
        { request: { connectionId: "queued-valid", action: "start", state_switch_version: "7", timestamp: now } },
        { request: { connectionId: "queued-disabled", action: "start", state_switch_version: "3", timestamp: now } },
        { request: { connectionId: "queued-version-mismatch", action: "start", state_switch_version: "7", timestamp: now } },
        { request: { connectionId: "active-inserted-only", action: "refresh", state_switch_version: "1", timestamp: now } },
      ],
      getConnection,
    )

    expect(result.map((connection) => connection.id).sort()).toEqual(["dashboard-enabled", "queued-valid"])
    expect(result.map((connection) => connection.id)).not.toContain("assigned-only")
    expect(result.map((connection) => connection.id)).not.toContain("active-inserted-only")
    expect(result.map((connection) => connection.id)).not.toContain("disabled")
    expect(result.map((connection) => connection.id)).not.toContain("queued-disabled")
  })
})
