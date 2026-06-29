import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { createExchangeConnector } from "@/lib/exchange-connectors"
import { initRedis, getConnection, updateConnection, getSettings, getAllConnections } from "@/lib/redis-db"
import { testConnectionLimiter } from "@/lib/connection-rate-limiter"
import { RateLimiter } from "@/lib/rate-limiter"
import { apiErrorHandler, ApiError } from "@/lib/api-error-handler"

const TEST_TIMEOUT_MS = 30000
const MAX_RETRIES = 3
const RETRY_INTERVAL_MS = 1000

// Timeout handler for requests with abort controller
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => 
        controller.signal.addEventListener('abort', () => 
          reject(new Error(`Timeout: ${label} exceeded ${timeoutMs}ms`))
        )
      ),
    ])
  } finally {
    clearTimeout(timeoutId)
  }
}

// Retry handler with configurable attempts and interval
async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = MAX_RETRIES,
  intervalMs: number = RETRY_INTERVAL_MS,
  onRetry?: (attempt: number, error: Error) => void
): Promise<T> {
  let lastError: Error | null = null
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      
      if (attempt < maxRetries) {
        onRetry?.(attempt, lastError)
        await new Promise(resolve => setTimeout(resolve, intervalMs))
      }
    }
  }
  
  throw lastError || new Error("Max retries exceeded")
}

export const dynamic = "force-dynamic"
export const maxDuration = 15
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const testLog: string[] = []
  const startTime = Date.now()
  const { id } = await params
  const body = await request.json()

  try {
    // Check rate limit using systemwide limiter (includes timeout config)
    const limitResult = await testConnectionLimiter.checkLimit(id)
    
    if (!limitResult.allowed) {
      testLog.push(`[${new Date().toISOString()}] ERROR: Rate limit exceeded`)
      return NextResponse.json(
        {
          error: "Rate limit exceeded",
          details: `Maximum 50 tests per minute. Retry after ${limitResult.retryAfter} seconds.`,
          retryAfter: limitResult.retryAfter,
          resetTime: limitResult.resetTime,
          log: testLog,
        },
        { status: 429, headers: { "Retry-After": String(limitResult.retryAfter) } }
      )
    }

    const timeoutMs = limitResult.timeoutMs || 30000
    testLog.push(`[${new Date().toISOString()}] Starting connection test for ID: ${id}`)
    testLog.push(`[${new Date().toISOString()}] Using API Type: ${body.api_type || "perpetual_futures"}`)
    testLog.push(`[${new Date().toISOString()}] Rate limit remaining: ${limitResult.remaining}`)
    testLog.push(`[${new Date().toISOString()}] Timeout: ${timeoutMs}ms`)

    // CRITICAL: Initialize Redis first and verify it's ready with timeout
    await withTimeout(initRedis(), timeoutMs / 3, "Redis initialization")
    
    // Small delay to ensure Redis client is fully initialized
    await new Promise(resolve => setTimeout(resolve, 100))

    const connection = await getConnection(id)

    if (!connection) {
      // Debug: try to get all connections to verify they exist
      const allConns = await getAllConnections()
      const availableIds = allConns.map((c: any) => c.id)
      console.log("[v0] [Test] Connection not found. Available IDs:", availableIds)
      console.log("[v0] [Test] Looking for ID:", id)
      console.log("[v0] [Test] ID exists in available IDs:", availableIds.includes(id))
      
      testLog.push(`[${new Date().toISOString()}] ERROR: Connection not found (ID: ${id})`)
      testLog.push(`[${new Date().toISOString()}] Available connection IDs: ${availableIds.join(", ")}`)
      throw new ApiError(`Connection not found with ID: ${id}`, {
        statusCode: 404,
        code: "CONNECTION_NOT_FOUND",
        details: { connectionId: id, availableIds },
        context: { operation: "test_connection" },
      })
    }

    testLog.push(`[${new Date().toISOString()}] Connection found: ${connection.name} (${connection.exchange})`)

    // Validate credentials - check for placeholder/test/demo values
    const apiKey = body.api_key || connection.api_key || ""
    const apiSecret = body.api_secret || connection.api_secret || ""
    const isPredefined = connection.is_predefined === "1" || connection.is_predefined === true
    
    // Check for various placeholder patterns
    const isPlaceholder = !apiKey || 
      apiKey === "" || 
      apiKey.includes("PLACEHOLDER") ||
      apiKey.includes("00998877") ||
      apiKey.includes("demo") ||
      apiKey.includes("test") ||
      apiKey.includes("sample") ||
      apiKey.includes("example") ||
      apiKey.startsWith("test") ||
      apiKey.startsWith("demo") ||
      apiKey.length < 20 ||
      !apiSecret ||
      apiSecret === "" ||
      apiSecret.length < 20

    if (isPlaceholder) {
      testLog.push(`[${new Date().toISOString()}] WARNING: API credentials are missing or appear to be placeholder values`)
      testLog.push(`[${new Date().toISOString()}] ${isPredefined ? "This is a predefined template - please add your real API credentials" : "Please configure valid API credentials for this exchange before testing"}`)

      await updateConnection(id, {
        ...connection,
        last_test_status: "warning",
        last_test_log: JSON.stringify(testLog),
        last_test_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })

      // Connection already updated above with last_test_status: "warning"

      return NextResponse.json(
        {
          error: "Credentials not configured",
          details: `This connection is using placeholder credentials. Please enter your real ${connection.exchange.toUpperCase()} API credentials in the Settings page to test the connection.`,
          log: testLog,
          duration: Date.now() - startTime,
        },
        { status: 400 }
      )
    }

    let minInterval = 200
    try {
      const settings = await getSettings("all_settings")
      minInterval = settings?.minimum_connect_interval || 200
    } catch (settingsError) {
      testLog.push(`[${new Date().toISOString()}] Using default connect interval: ${minInterval}ms`)
    }

    testLog.push(`[${new Date().toISOString()}] Minimum connect interval: ${minInterval}ms`)

    const rateLimiter = new RateLimiter(connection.exchange)

    // Execute with retry system: 3 attempts with 1 second interval
    const testResult = await withRetry(
      async () => {
        return await rateLimiter.execute(async () => {
          await new Promise((resolve) => setTimeout(resolve, minInterval))

          // Use request body values (which may be edited, unsaved values) OR fall back to stored connection
          const connector = await createExchangeConnector(connection.exchange, {
            apiKey: body.api_key || connection.api_key,
            apiSecret: body.api_secret || connection.api_secret,
            apiPassphrase: body.api_passphrase || connection.api_passphrase || "",
            isTestnet: body.is_testnet !== undefined ? body.is_testnet : (connection.is_testnet || false),
            apiType: body.api_type || connection.api_type,
            connectionMethod: body.connection_method || connection.connection_method,
            connectionLibrary: body.connection_library || connection.connection_library,
          })

          const testPromise = connector.testConnection()
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Connection test timeout after 30 seconds")), TEST_TIMEOUT_MS)
          )

          return await Promise.race([testPromise, timeoutPromise])
        })
      },
      MAX_RETRIES,
      RETRY_INTERVAL_MS,
      (attempt, error) => {
        testLog.push(`[${new Date().toISOString()}] Retry ${attempt}/${MAX_RETRIES}: ${error.message}`)
      }
    )

    const result = testResult as any

    if (!result.success) {
      throw new Error(result.error || "Connection test failed")
    }

    const duration = Date.now() - startTime
    testLog.push(`[${new Date().toISOString()}] Connection successful!`)
    testLog.push(`[${new Date().toISOString()}] Account Balance: ${result.balance.toFixed(4)} USDT`)
    if (result.btcPrice) {
      testLog.push(`[${new Date().toISOString()}] BTC Price: $${result.btcPrice.toFixed(2)}`)
    }

    const testedApiType = body.api_type || connection.api_type || "perpetual_futures"
    await updateConnection(id, {
      ...connection,
      last_test_status: "success",
      last_test_balance: String(result.balance),
      last_test_log: JSON.stringify(testLog),
      last_test_at: new Date().toISOString(),
      api_type: testedApiType,
      api_capabilities: JSON.stringify(result.capabilities || []),
      updated_at: new Date().toISOString(),
    })

    await SystemLogger.logConnection(`Connection test successful: ${connection.name}`, id, "info", {
      balance: result.balance,
      btcPrice: result.btcPrice,
      duration,
    })

    return NextResponse.json({
      success: true,
      balance: result.balance,
      btcPrice: result.btcPrice || 0,
      balances: result.balances || [],
      capabilities: result.capabilities || [],
      apiType: body.api_type || connection.api_type,
      apiSubtype: body.api_subtype || connection.api_subtype,
      exchange: connection.exchange,
      connectionMethod: body.connection_method || connection.connection_method,
      connectionLibrary: body.connection_library || connection.connection_library,
      log: testLog,
      duration,
    })
  } catch (error) {
    const duration = Date.now() - startTime
    
    if (error instanceof ApiError) {
      // Already an API error, log and return
      await SystemLogger.logError(error, "api", "POST /api/settings/connections/[id]/test")
      return await apiErrorHandler.handleError(error, {
        endpoint: "/api/settings/connections/[id]/test",
        method: "POST",
        operation: "test_connection",
        severity: error.severity,
      })
    }

    const errorMessage = error instanceof Error ? error.message : "Unknown error"
    testLog.push(`[${new Date().toISOString()}] Test failed: ${errorMessage}`)

    let userFriendlyError = errorMessage
    let isCredentialError = false
    
    if (errorMessage.includes("JSON")) {
      userFriendlyError = "API returned invalid response. Check your credentials or try again."
    } else if (errorMessage.includes("401") || errorMessage.includes("Unauthorized")) {
      userFriendlyError = "Invalid API credentials. Please verify your API key and secret."
      isCredentialError = true
    } else if (errorMessage.toLowerCase().includes("incorrect apikey") || errorMessage.toLowerCase().includes("invalid api")) {
      userFriendlyError = "Invalid API key. Please verify your API key is correct and has the required permissions."
      isCredentialError = true
    } else if (errorMessage.includes("100413") || errorMessage.includes("apiKey")) {
      userFriendlyError = "API key validation failed. Please check your API key in exchange settings."
      isCredentialError = true
    } else if (errorMessage.includes("timeout")) {
      userFriendlyError = "Connection timeout. Check your network or if the API endpoint is available."
    } else if (errorMessage.includes("ENOTFOUND") || errorMessage.includes("ERR_MODULE_NOT_FOUND")) {
      userFriendlyError = "Network error. Check your internet connection."
    } else if (errorMessage.includes("signature") || errorMessage.includes("Signature")) {
      userFriendlyError = "Invalid API signature. Please verify your API secret is correct."
      isCredentialError = true
    }

    console.error("[v0] Connection test failed:", error)
    await SystemLogger.logError(error instanceof Error ? error : new Error(String(error)), "api", "POST /api/settings/connections/[id]/test")

    // Try to update connection with error status
    try {
      const existingConnection = await getConnection(id)
      if (existingConnection) {
        await updateConnection(id, {
          ...existingConnection,
          last_test_status: "failed",
          last_test_log: JSON.stringify(testLog),
          last_test_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })

        // Connection already updated above with last_test_status: "error"
      }
    } catch (updateError) {
      console.error("[v0] Failed to update connection error status:", updateError)
    }

    return NextResponse.json(
      {
        success: false,
        error: isCredentialError ? "Invalid credentials" : "Connection test failed",
        details: userFriendlyError,
        isCredentialError,
        log: testLog,
        duration,
      },
      { status: isCredentialError ? 401 : 500 }
    )
  }
}
