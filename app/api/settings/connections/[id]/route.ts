import { type NextRequest, NextResponse } from "next/server"
import { SystemLogger } from "@/lib/system-logger"
import { getConnection, updateConnection, deleteConnection, initRedis } from "@/lib/redis-db"
import { ConnectionDataArchive } from "@/lib/connection-data-archive"
import { recoordinateAfterSettingsChange } from "@/lib/connection-recoordinator"

// SECURITY: never return raw credentials from any handler in this route.
// Masked values keep the UI informative ("key is set, ends in …abcd") while
// the PUT/PATCH sanitizers ignore masked/empty values, so round-tripping a
// fetched connection through an edit dialog can never corrupt stored secrets.
const maskSecret = (v: unknown) =>
  typeof v === "string" && v.length > 4 ? `••••${v.slice(-4)}` : v ? "••••" : v

const maskConnectionSecrets = (conn: Record<string, any>) => ({
  ...conn,
  ...(conn.api_key !== undefined ? { api_key: maskSecret(conn.api_key) } : {}),
  ...(conn.api_secret !== undefined ? { api_secret: maskSecret(conn.api_secret) } : {}),
})

// A value the client sends back that is empty or still masked must never
// overwrite the stored secret.
const isMaskedOrEmpty = (v: unknown) => typeof v === "string" && (v === "" || v.includes("••••"))

export const dynamic = "force-dynamic"
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    
    console.log("[v0] Fetching connection from Redis:", id)
    await initRedis()
    
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Previous code returned the full connection hash including api_key and
    // api_secret in PLAINTEXT to any caller.
    return NextResponse.json(maskConnectionSecrets(connection), { status: 200 })
  } catch (error) {
    console.error("[v0] Failed to fetch connection:", error)
    await SystemLogger.logError(error, "api", `GET /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to fetch connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    console.log("[v0] Deleting connection from Redis:", id)
    await SystemLogger.logConnection(`Deleting connection`, id, "info")

    await initRedis()

    // STABILITY: stop any running engine BEFORE archiving/deleting so that
    // the self-scheduling indication/strategy/realtime loops don't keep firing
    // against a deleted connection and the "running" marker doesn't leak into
    // the next startup's reconciliation pass (which would otherwise interpret
    // the dangling flag as a stale engine and try to restart).
    try {
      const { getGlobalTradeEngineCoordinator } = await import("@/lib/trade-engine")
      const coordinator = getGlobalTradeEngineCoordinator()
      if (coordinator && coordinator.isEngineRunning(id)) {
        console.log(`[v0] [DELETE] Stopping engine for ${id} before archive`)
        await coordinator.stopEngine(id, { operatorRequested: true })
      }
    } catch (stopErr) {
      // Non-fatal: we still want to delete the record even if engine stop fails.
      console.warn(
        `[v0] [DELETE] Engine stop failed for ${id} (continuing with delete):`,
        stopErr instanceof Error ? stopErr.message : stopErr,
      )
      await SystemLogger.logError(stopErr, "api", `DELETE /api/settings/connections/${id}#stopEngine`)
    }

    // Clear engine-running hint so reconciliation does not re-start it.
    // Must use client.set (string "0") to match setRunningFlag in engine-manager.
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      await client.set(`engine_is_running:${id}`, "0")
    } catch {
      /* non-critical */
    }

    console.log(`[v0] Archiving data for connection ${id}...`)
    await ConnectionDataArchive.archiveConnectionData(id)

    await deleteConnection(id)

    // ── Tombstone the connection ID ───────────────────────────────────
    // Bug being fixed: deleting a base/main connection (e.g. bybit-x03,
    // bingx-x01) caused it to immediately reappear after the next page
    // load because `ensureBaseConnections` in `lib/redis-migrations.ts`
    // unconditionally re-creates every entry in `BASE_CONNECTION_CONFIG`
    // on each migration run. Without a tombstone there is no way for
    // the system to remember an explicit operator delete decision.
    //
    // Add the ID to `connections:tombstoned` (a Redis Set). The
    // migration consults this set and skips any tombstoned ID. The
    // tombstone persists indefinitely — to "un-delete" a base
    // connection the operator removes it from the set explicitly
    // (e.g. via the Recover button or by clearing the DB).
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      await client.sadd("connections:tombstoned", id)
      // Also store the deletion timestamp for audit/UX (Recover button
      // can show "deleted 3 days ago"). 90-day TTL on the per-id record
      // bounds storage growth without affecting the tombstone itself.
      await client.set(
        `connection:${id}:tombstoned_at`,
        new Date().toISOString(),
        { EX: 90 * 24 * 60 * 60 },
      )
      console.log(`[v0] [DELETE] Tombstoned connection id=${id} (will not be auto-recreated)`)
    } catch (tombErr) {
      console.warn(
        `[v0] [DELETE] Failed to tombstone ${id} (delete still succeeded):`,
        tombErr instanceof Error ? tombErr.message : tombErr,
      )
    }

    await SystemLogger.logConnection(`Connection deleted`, id, "info")

    return NextResponse.json({ success: true, message: "Connection deleted and data archived" })
  } catch (error) {
    console.error("[v0] Failed to delete connection:", error)
    await SystemLogger.logError(error, "api", `DELETE /api/settings/connections/${id}`)
    return NextResponse.json(
      { error: "Failed to delete connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    console.log("[v0] Patching connection in Redis:", id, "with", Object.keys(body).length, "fields")
    await SystemLogger.logConnection(`Patching connection`, id, "info", body)

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    const sanitizedBody = { ...body }
    // Ignore empty AND masked values (the GET handler returns masked secrets,
    // so an edit dialog round-trip would otherwise overwrite the real key
    // with "••••abcd").
    if (isMaskedOrEmpty(sanitizedBody.api_key) && connection.api_key) {
      delete sanitizedBody.api_key
    }
    if (isMaskedOrEmpty(sanitizedBody.api_secret) && connection.api_secret) {
      delete sanitizedBody.api_secret
    }

    const updatedConnection = {
      ...connection,
      ...sanitizedBody,
      id: connection.id,
      created_at: connection.created_at,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updatedConnection)

    // Full propagation: notify + fast-path apply + recoordinate
    // (start the engine if it now should run, stop if it now shouldn't,
    // hot-reload if it already is). See lib/connection-recoordinator.ts
    // for the full rationale — this single call replaces the three
    // separate steps that previously diverged across handlers.
    await recoordinateAfterSettingsChange(id, connection, updatedConnection, {
      logTag: "PATCH /connections/[id]",
    })

    await SystemLogger.logConnection(`Connection patched successfully`, id, "info")

    return NextResponse.json({ success: true, connection: maskConnectionSecrets(updatedConnection) })
  } catch (error) {
    console.error("[v0] Failed to patch connection:", error)
    await SystemLogger.logError(error, "api", `PATCH /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to patch connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}

export async function PUT(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const body = await request.json()

    console.log("[v0] Updating connection in Redis:", id, body)
    await SystemLogger.logConnection(`Updating connection`, id, "info", body)

    await initRedis()
    const connection = await getConnection(id)

    if (!connection) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 })
    }

    // Lift any tombstone on this id — operator is explicitly re-saving
    // this connection, which is a clear "un-delete" intent. Without this
    // a re-saved base connection would still be skipped by the next
    // migration sweep (see `lib/redis-migrations.ts → ensureBaseConnections`).
    try {
      const { getRedisClient } = await import("@/lib/redis-db")
      const client = getRedisClient()
      const wasTombstoned = await client.sismember("connections:tombstoned", id)
      if (wasTombstoned) {
        await client.srem("connections:tombstoned", id)
        await client.del(`connection:${id}:tombstoned_at`)
        console.log(`[v0] [PUT] Lifted tombstone on ${id} (operator re-saved connection)`)
      }
    } catch { /* non-critical */ }

    const sanitizedBody = { ...body }
    // Ignore empty AND masked values (see PATCH above).
    if (isMaskedOrEmpty(sanitizedBody.api_key) && connection.api_key) {
      delete sanitizedBody.api_key
    }
    if (isMaskedOrEmpty(sanitizedBody.api_secret) && connection.api_secret) {
      delete sanitizedBody.api_secret
    }

    const updatedConnection = {
      ...connection,
      ...sanitizedBody,
      id: connection.id,
      created_at: connection.created_at,
      updated_at: new Date().toISOString(),
    }

    await updateConnection(id, updatedConnection)

    // Full propagation: notify + fast-path apply + recoordinate.
    // See PATCH above (and lib/connection-recoordinator.ts) for full
    // rationale.
    await recoordinateAfterSettingsChange(id, connection, updatedConnection, {
      logTag: "PUT /connections/[id]",
    })

    await SystemLogger.logConnection(`Connection updated successfully`, id, "info")

    return NextResponse.json({ success: true, connection: maskConnectionSecrets(updatedConnection) })
  } catch (error) {
    console.error("[v0] Failed to update connection:", error)
    await SystemLogger.logError(error, "api", `PUT /api/settings/connections/${(await params).id}`)
    return NextResponse.json(
      { error: "Failed to update connection", details: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 },
    )
  }
}
