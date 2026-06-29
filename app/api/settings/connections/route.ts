import { type NextRequest, NextResponse } from "next/server"
import { getAllConnections, initRedis, createConnection } from "@/lib/redis-db"
import { generateConnectionIdFromApiKey, isApiKeyInUse } from "@/lib/connection-id-manager"
import { CONNECTION_PREDEFINITIONS } from "@/lib/connection-predefinitions"
import { API_VERSIONS } from "@/lib/system-version"

export const dynamic = "force-dynamic"
export const runtime = "nodejs"
export const maxDuration = 30

const API_VERSION = API_VERSIONS.connections

export async function GET(request: NextRequest) {
  try {
    // Set explicit cache-control headers to prevent caching
    const headers = {
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
      "Pragma": "no-cache",
      "Expires": "0",
      "X-API-Version": API_VERSION,
    }
    
    const { searchParams } = new URL(request.url)
    const clientVersion = searchParams.get("v")
    const exchange = searchParams.get("exchange")
    const enabled = searchParams.get("enabled")
    const active = searchParams.get("active")

    console.log(`[v0] [API] [Connections] ${API_VERSION} - Client version: ${clientVersion}`)

    await initRedis()

    // STABILITY RULE: defaults are assigned only at startup (via /api/startup/initialize
    // and the base seeder with its persistent marker). This GET MUST NOT trigger
    // re-seeding — otherwise deleting/unassigning a base connection would re-spawn it
    // on the next poll. An empty list is a valid, respected state.
    let connections = await getAllConnections()

    if (exchange) {
      connections = connections.filter((c) => c.exchange?.toLowerCase() === exchange.toLowerCase())
    }

    // Filter by is_enabled for trade engine status (Settings connections)
    if (enabled === "true") {
      connections = connections.filter((c) => {
        // Handle both boolean and string representations
        const isEnabled = c.is_enabled === true || c.is_enabled === "1" || c.is_enabled === "true"
        return isEnabled
      })
    }

    // Filter by is_enabled_dashboard for actively using connections (INDEPENDENT from Settings)
    if (active === "true") {
      connections = connections.filter((c) => {
        // Handle both boolean and string representations
        const isEnabledDash = c.is_enabled_dashboard === true || c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === "true"
        return isEnabledDash
      })
    }

    // Log what we're returning
    const bingxOnly = connections.filter(c => ["bingx"].includes((c.exchange || "").toLowerCase()))
    const inserted = connections.filter(c => c.is_inserted === "1" || c.is_inserted === true)
    const activeInserted = connections.filter(c => c.is_active_inserted === "1" || c.is_active_inserted === true)
    
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Returning ${connections.length} total connections`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: BingX: ${bingxOnly.length}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Inserted (visible): ${inserted.map(c => c.name).join(', ')}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Active-inserted (in main panel): ${activeInserted.map(c => c.name).join(', ') || 'none'}`)
    console.log(`[v0] [API] [Connections] ${API_VERSION}: Enabled dashboard: ${connections.filter(c => c.is_enabled_dashboard === "1" || c.is_enabled_dashboard === true).map(c => c.name).join(', ') || 'none'}`)
    
    // SECURITY: never return raw credentials. Previous code returned every
    // connection's api_key/api_secret in PLAINTEXT to any caller.
    const maskSecret = (v: unknown) =>
      typeof v === "string" && v.length > 4 ? `••••${v.slice(-4)}` : v ? "••••" : v
    const safeConnections = connections.map((c) => ({
      ...c,
      ...(c.api_key !== undefined ? { api_key: maskSecret(c.api_key) } : {}),
      ...(c.api_secret !== undefined ? { api_secret: maskSecret(c.api_secret) } : {}),
    }))

    return NextResponse.json({ success: true, count: safeConnections.length, connections: safeConnections, version: API_VERSION }, { headers })
  } catch (error) {
    console.error(`[v0] [API] [Connections] ${API_VERSION}: Error:`, error instanceof Error ? error.message : String(error))
    return NextResponse.json({ success: false, error: "Failed to fetch connections", connections: [], version: API_VERSION }, { status: 500, headers: {
      "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
      "X-API-Version": API_VERSION,
    }})
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json()
    
    // Validate required fields
    if (!body.name || !body.exchange || !body.api_key || !body.api_secret) {
      return NextResponse.json(
        { error: "Missing required fields: name, exchange, api_key, api_secret" },
        { status: 400 }
      )
    }

    await initRedis()

    // Check if API key is already in use
    const exists = await isApiKeyInUse(body.exchange, body.api_key)
    if (exists) {
      return NextResponse.json(
        { 
          error: "This API key is already connected",
          details: "Please remove the existing connection first or use a different API key"
        },
        { status: 409 }
      )
    }

    // Generate unique connection ID based on exchange + API key
    const connectionId = generateConnectionIdFromApiKey(body.exchange, body.api_key)

    // Create connection object with all required fields
    const connection = {
      id: connectionId,
      name: body.name,
      exchange: body.exchange,
      api_key: body.api_key,
      api_secret: body.api_secret,
      api_passphrase: body.api_passphrase || "",
      api_type: body.api_type || "perpetual_futures",
      api_subtype: body.api_type === "unified" ? (body.api_subtype || "perpetual") : undefined,
      connection_method: body.connection_method || "rest",
      connection_library: body.connection_library || "native",
      margin_type: body.margin_type || "cross",
      position_mode: body.position_mode || "hedge",
      contract_type: body.contract_type || "usdt-perpetual",
      is_testnet: body.is_testnet || false,
      is_enabled: body.is_enabled === true, // Settings: enabled by default for base connections
      is_inserted: true, // User-created connection is "inserted" (available for use)
      is_dashboard_inserted: false, // Not yet added to Active Connections dashboard
      is_active_inserted: false, // Not yet in Active panel
      is_enabled_dashboard: false, // Dashboard toggle OFF by default
      is_active: false, // Not actively processing
      is_predefined: false, // User-created, not predefined template
      is_live_trade: false,
      is_preset_trade: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }

    // Save to Redis database
    await createConnection(connection)

    console.log("[v0] [API] Connection created successfully:", {
      id: connectionId,
      name: body.name,
      exchange: body.exchange,
    })

    // Auto-test the newly created connection (non-blocking)
    let testResult = null
    if (body.api_key && body.api_secret) {
      try {
        console.log("[v0] [API] Auto-testing newly created connection:", connectionId)
        const testResponse = await fetch(
          new URL(`/api/settings/connections/${connectionId}/test`, process.env.NEXT_PUBLIC_APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${process.env.PORT || "3002"}`)).toString(),
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ source: "creation" }),
          }
        )
        if (testResponse.ok) {
          testResult = await testResponse.json()
          console.log("[v0] [API] Auto-test result:", testResult.success ? "PASSED" : "FAILED")
        }
      } catch (testError) {
        console.log("[v0] [API] Auto-test skipped (non-blocking error):", testError instanceof Error ? testError.message : "Unknown")
      }
    }

    return NextResponse.json(
      {
        success: true,
        message: "Connection created successfully",
        id: connectionId,
        connectionId: connectionId,
        autoTest: testResult ? { ran: true, success: testResult.success } : { ran: false, reason: "No API credentials provided" },
      },
      { status: 201 }
    )
  } catch (error) {
    console.error("[v0] Error creating connection:", error instanceof Error ? error.message : String(error))
    return NextResponse.json(
      { error: "Failed to create connection", details: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
