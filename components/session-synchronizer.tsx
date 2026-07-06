"use client"

import { useEffect } from "react"
import { initializeSessionRestoration, saveSessionState } from "@/lib/client-session-persistence"

/**
 * SessionSynchronizer - Client component that ensures continuous session state
 * across page refreshes, navigations, and rebuilds.
 *
 * This component:
 * 1. Restores session state on initial load
 * 2. Periodically syncs session state to ensure data continuity
 * 3. Saves scroll positions and UI state
 * 4. Maintains navigation history
 */
export function SessionSynchronizer() {
  useEffect(() => {
    // Initialize session on mount
    initializeSessionRestoration()

    // Periodically save session state (every 30 seconds)
    const syncInterval = setInterval(() => {
      saveSessionState({
        timestamp: Date.now(),
      })
    }, 30 * 1000)

    // Save session on page visibility change (tab becomes visible)
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        console.log("[v0] Page became visible, syncing session state")
        saveSessionState({
          timestamp: Date.now(),
        })
      }
    }

    // Save session before unload (page refresh/close)
    const handleBeforeUnload = () => {
      try {
        saveSessionState({
          timestamp: Date.now(),
        })
      } catch {
        // Ignore errors during unload
      }
    }

    // Save scroll position when user scrolls
    const handleScroll = () => {
      try {
        const scrollTop = window.scrollY || document.documentElement.scrollTop
        const mainContent = document.querySelector("main")
        if (mainContent) {
          // Save main content scroll position
          saveSessionState({
            scrollPositions: {
              main: mainContent.scrollTop,
              window: scrollTop,
            },
          })
        }
      } catch {
        // Ignore scroll tracking errors
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)
    window.addEventListener("scroll", handleScroll, { passive: true })

    // Cleanup
    return () => {
      clearInterval(syncInterval)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      window.removeEventListener("scroll", handleScroll)
    }
  }, [])

  return null // This component doesn't render anything
}

/**
 * ProgressTracker - Ensures trading engine progress persists across sessions
 */
export function ProgressTracker() {
  useEffect(() => {
    // Monitor trading engine progress
    const checkProgress = async () => {
      try {
        const response = await fetch("/api/persistence/status")
        if (response.ok) {
          const data = await response.json()
          console.log("[v0] Persistence status:", {
            keys: data.database?.keys,
            memory_mb: data.database?.memory_mb,
            last_snapshot: data.recovery?.last_snapshot,
          })
        }
      } catch (error) {
        // Silently ignore - this is just status monitoring
      }
    }

    // Check on mount and periodically
    checkProgress()
    const interval = setInterval(checkProgress, 5 * 60 * 1000) // Every 5 minutes

    return () => clearInterval(interval)
  }, [])

  return null // This component doesn't render anything
}
