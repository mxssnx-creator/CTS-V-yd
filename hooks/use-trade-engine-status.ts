"use client"

import { useState, useEffect, useCallback } from "react"
import { CONNECTION_STATE_CHANGED_EVENT, TRADE_ENGINE_STATUS_INVALIDATE_EVENT } from "@/lib/connection-events"
import { usePoll } from "./use-poll"

export interface TradeEngineStatusData {
  id: string
  name: string
  exchange: string
  enabled: boolean
  activelyUsing: boolean
  status: "running" | "stopped" | "paused" | "queued" | "error"
  trades: number
  positions: number
  progression: {
    cycles_completed: number
    successful_cycles: number
    failed_cycles: number
    cycle_success_rate: string
    total_trades: number
    successful_trades: number
    trade_success_rate: string
    total_profit: string
    last_cycle_time: string | null
  }
}

interface UseTradeEngineStatusOptions {
  connectionId?: string
  refreshInterval?: number // milliseconds
  autoRefresh?: boolean
}

/**
 * Browser event that invalidates trade-engine status caches/read models.
 * Dashboard toggles and progression pages should dispatch this event after
 * enable/disable/progression mutations so status refreshes immediately:
 *
 * window.dispatchEvent(new CustomEvent(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, {
 *   detail: { action, connectionId },
 * }))
 */

/**
 * Hook for fetching and auto-updating trade engine status
 * Polls the API at specified intervals and provides real-time status and progression data
 */
export function useTradeEngineStatus(options: UseTradeEngineStatusOptions = {}) {
  const { connectionId, refreshInterval = 5000, autoRefresh = true } = options

  const [statuses, setStatuses] = useState<TradeEngineStatusData[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const fetchStatus = useCallback(async () => {
    try {
      setError(null)
      const url = connectionId
        ? `/api/trade-engine/status?connectionId=${connectionId}`
        : "/api/trade-engine/status"

      const response = await fetch(url, {
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
      })

      if (!response.ok) {
        throw new Error(`Status API returned ${response.status}`)
      }

      const data = await response.json()
      const statusArray = connectionId 
        ? (Array.isArray(data) ? data : [data])
        : (Array.isArray(data) ? data : data.connections || data.statuses || [])
      
      setStatuses(statusArray.map((status: any) => ({
        ...status,
        status: status.actualRuntimeStatus === "queued" ? "queued" : status.status,
      })))
      setIsLoading(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch status"
      setError(message)
      console.error("[v0] Status fetch error:", message)
      setIsLoading(false)
    }
  }, [connectionId])

  usePoll(fetchStatus, { intervalMs: refreshInterval, enabled: autoRefresh })

  useEffect(() => {
    const handleInvalidation = (event: Event) => {
      const detail = (event as CustomEvent<{ connectionId?: string }>).detail
      if (!connectionId || !detail?.connectionId || detail.connectionId === connectionId) {
        void fetchStatus()
      }
    }

    window.addEventListener(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, handleInvalidation)
    window.addEventListener(CONNECTION_STATE_CHANGED_EVENT, handleInvalidation)

    // Set up auto-refresh if enabled
    if (autoRefresh) {
      const interval = setInterval(fetchStatus, refreshInterval)
      return () => {
        clearInterval(interval)
        window.removeEventListener(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, handleInvalidation)
        window.removeEventListener(CONNECTION_STATE_CHANGED_EVENT, handleInvalidation)
      }
    }

    return () => {
      window.removeEventListener(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, handleInvalidation)
      window.removeEventListener(CONNECTION_STATE_CHANGED_EVENT, handleInvalidation)
    }
  }, [fetchStatus, refreshInterval, autoRefresh, connectionId])

  return {
    statuses,
    isLoading,
    error,
    refresh: fetchStatus,
  }
}

/**
 * Hook for controlling trade engine (start, pause, resume, stop)
 */
export function useTradeEngineControl() {
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const executeControl = useCallback(
    async (action: "start" | "pause" | "resume" | "stop", connectionId?: string) => {
      try {
        setIsLoading(true)
        setError(null)

        const endpoint = connectionId
          ? `/api/trade-engine/${action}?connectionId=${connectionId}`
          : `/api/trade-engine/${action}`

        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ connectionId }),
        })

        if (!response.ok) {
          const data = await response.json()
          throw new Error(data.error || `Failed to ${action} trade engine`)
        }

        const result = await response.json()
        console.log(`[v0] Trade engine ${action} successful:`, result)

        window.dispatchEvent(
          new CustomEvent(TRADE_ENGINE_STATUS_INVALIDATE_EVENT, {
            detail: { action, connectionId },
          })
        )

        setIsLoading(false)
        return result
      } catch (err) {
        const message = err instanceof Error ? err.message : `Error during ${action}`
        setError(message)
        console.error(`[v0] Trade engine ${action} error:`, message)
        setIsLoading(false)
        throw err
      }
    },
    []
  )

  const start = useCallback(
    (connectionId?: string) => executeControl("start", connectionId),
    [executeControl]
  )
  const pause = useCallback(
    (connectionId?: string) => executeControl("pause", connectionId),
    [executeControl]
  )
  const resume = useCallback(
    (connectionId?: string) => executeControl("resume", connectionId),
    [executeControl]
  )
  const stop = useCallback(
    (connectionId?: string) => executeControl("stop", connectionId),
    [executeControl]
  )

  return { start, pause, resume, stop, isLoading, error }
}
