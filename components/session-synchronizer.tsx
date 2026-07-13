"use client"

import { useEffect } from "react"

/**
 * SessionSynchronizer — triggers server-side Redis snapshots at key moments
 * so session state, engine progress and UI data survive page refreshes,
 * tab switches, rebuilds, and restarts without any gap larger than 3 minutes.
 *
 * Strategy:
 *   - On mount: nothing (server already loaded snapshot at startup)
 *   - Every 3 min: POST /api/persistence/save  (belt-and-suspenders alongside server timer)
 *   - On visibilitychange → hidden: force-save immediately
 *   - On beforeunload: fire-and-forget save via sendBeacon
 */
export function SessionSynchronizer() {
  useEffect(() => {
    const forceSave = async () => {
      try {
        await fetch("/api/persistence/save", { method: "POST" })
      } catch {
        // Ignore — server-side timer is the fallback
      }
    }

    // Belt-and-suspenders: also save from the client side every 3 minutes
    const interval = setInterval(forceSave, 3 * 60 * 1000)

    // Save as soon as the tab is hidden (user switches away or closes)
    const handleVisibility = () => {
      if (document.visibilityState === "hidden") {
        forceSave()
      }
    }

    // sendBeacon is more reliable than fetch during page unload
    const handleBeforeUnload = () => {
      try {
        navigator.sendBeacon("/api/persistence/save", JSON.stringify({ ts: Date.now() }))
      } catch {
        // Fallback: best-effort fetch
        forceSave()
      }
    }

    document.addEventListener("visibilitychange", handleVisibility)
    window.addEventListener("beforeunload", handleBeforeUnload)

    return () => {
      clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibility)
      window.removeEventListener("beforeunload", handleBeforeUnload)
    }
  }, [])

  return null
}
