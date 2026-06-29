"use client"

import { createContext, useContext, useState, useEffect, useRef, useCallback, type ReactNode } from "react"

interface ExchangeContextType {
  selectedExchange: string | null
  setSelectedExchange: (exchange: string | null) => void
  selectedConnectionId: string | null
  setSelectedConnectionId: (connectionId: string | null) => void
  selectedConnection: any | null
  activeConnections: any[]
  loadActiveConnections: (options?: { force?: boolean }) => Promise<void>
  isLoading: boolean
}

const ExchangeContext = createContext<ExchangeContextType | undefined>(undefined)

export function ExchangeProvider({ children }: { children: ReactNode }) {
  // IMPORTANT (hydration): these MUST initialise to the same value the server
  // renders (null). Reading localStorage in the useState initialiser gave the
  // client's first render a persisted value while the server rendered null,
  // which mismatched on hydration and cascaded into every consumer (the
  // QuickStart button text and all radix `useId` ids drifted). Instead we
  // hydrate from localStorage in a post-mount effect below, so the first
  // client render is byte-identical to SSR and React reconciles cleanly.
  const [selectedExchange, setSelectedExchange] = useState<string | null>(null)
  const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null)
  const [activeConnections, setActiveConnections] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const loadingRef = useRef(false)
  const lastLoadRef = useRef(0)
  // Use a ref to read selectedConnectionId inside the callback without stale closure
  const selectedConnectionIdRef = useRef<string | null>(null)
  // Skip-first-run guards so the persist effects don't write the initial null
  // state to localStorage before hydration has restored the stored selection
  // (that would wipe it). They begin persisting only on genuine changes.
  const exPersistReady = useRef(false)
  const connPersistReady = useRef(false)
  const LOAD_COOLDOWN = 10000 // 10 seconds between refreshes

  const loadActiveConnections = useCallback(async (options?: { force?: boolean }) => {
    const force = options?.force === true
    if (loadingRef.current) return
    if (!force && Date.now() - lastLoadRef.current < LOAD_COOLDOWN) return

    loadingRef.current = true
    setIsLoading(true)
    try {
      const response = await fetch("/api/settings/connections", {
        cache: "no-store",
        headers: { "Cache-Control": "no-cache" },
      })
      if (response.ok) {
        const data = await response.json()
        const connections = data.connections || []
        
        const toBoolean = (v: unknown) => v === true || v === 1 || v === "1" || v === "true"

        // STABLE ASSIGNMENT RULE: a connection appears in Main Connections ONLY when
        // the user has explicitly assigned it (is_active_inserted / is_dashboard_inserted /
        // is_assigned) or the dashboard toggle is currently on (is_enabled_dashboard).
        // We do NOT auto-include connections just because they are base (bybit/bingx);
        // that was the root cause of cards "re-appearing" after enable/delete.
        const mainConnections = connections.filter((c: any) => {
          const isInserted =
            toBoolean(c.is_active_inserted) ||
            toBoolean(c.is_dashboard_inserted) ||
            toBoolean(c.is_assigned)
          const isDashboardActive = toBoolean(c.is_enabled_dashboard)
          return isInserted || isDashboardActive
        })
        
        setActiveConnections(mainConnections)
        
        // Auto-select only when no connection is currently selected.
        // Read from ref to avoid stale closure (state is always null inside useCallback).
        if (mainConnections.length > 0 && !selectedConnectionIdRef.current) {
          // Prefer BingX, then fall back to first available connection
          const preferred =
            mainConnections.find((c: any) => (c.exchange || "").toLowerCase() === "bingx") ||
            mainConnections[0]
          setSelectedConnectionId(preferred.id)
          setSelectedExchange(preferred.exchange || null)
          selectedConnectionIdRef.current = preferred.id
        }
      }
    } catch (error) {
      console.error("[ExchangeContext] Failed to load connections:", error)
    } finally {
      loadingRef.current = false
      setIsLoading(false)
      lastLoadRef.current = Date.now()
    }
  }, [])

  // Load on mount; also refresh when connections are toggled or added/removed
  useEffect(() => {
    // Hydrate the persisted selection AFTER mount (see note on the useState
    // declarations). Seed the ref synchronously BEFORE loadActiveConnections
    // so the auto-select logic respects the restored connection instead of
    // overwriting it with a default.
    try {
      const persistedConn = localStorage.getItem("ex:selectedConnectionId")
      const persistedEx = localStorage.getItem("ex:selectedExchange")
      if (persistedConn) {
        selectedConnectionIdRef.current = persistedConn
        setSelectedConnectionId(persistedConn)
      }
      if (persistedEx) setSelectedExchange(persistedEx)
    } catch { /* localStorage may be unavailable */ }

    loadActiveConnections()

    const handleConnectionChange = () => {
      loadActiveConnections({ force: true })
    }

    if (typeof window !== "undefined") {
      window.addEventListener("connection-toggled", handleConnectionChange)
      window.addEventListener("connection-removed", handleConnectionChange)
      // When connection settings are saved (via any settings dialog or the
      // options bar), `is_live_trade` and other flags may have changed.
      // Force a refresh so every consumer that reads `activeConnections`
      // (QuickstartOptionsBar, ActiveConnectionCard, etc.) sees fresh data
      // without waiting for the 10 s natural cooldown to expire.
      window.addEventListener("connection-settings-updated", handleConnectionChange)
      // QuickstartConnectionControls fires this after adding/resetting a
      // connection so the picker reflects the change immediately.
      window.addEventListener("quickstart:refresh", handleConnectionChange)
    }

    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("connection-toggled", handleConnectionChange)
        window.removeEventListener("connection-removed", handleConnectionChange)
        window.removeEventListener("connection-settings-updated", handleConnectionChange)
        window.removeEventListener("quickstart:refresh", handleConnectionChange)
      }
    }
  }, [])

  // Persist selection changes to localStorage so reloads restore the exact
  // same session & situation (selected connection drives QuickStart etc.)
  useEffect(() => {
    // Skip the initial mount run (state is still the null SSR default); only
    // persist real selection changes so we never wipe the stored value before
    // the hydration effect above has restored it.
    if (!exPersistReady.current) { exPersistReady.current = true; return }
    try {
      if (selectedExchange) localStorage.setItem("ex:selectedExchange", selectedExchange)
      else localStorage.removeItem("ex:selectedExchange")
    } catch { /* localStorage may be unavailable */ }
  }, [selectedExchange])

  useEffect(() => {
    if (!connPersistReady.current) { connPersistReady.current = true; return }
    try {
      if (selectedConnectionId) localStorage.setItem("ex:selectedConnectionId", selectedConnectionId)
      else localStorage.removeItem("ex:selectedConnectionId")
    } catch { /* localStorage may be unavailable */ }
  }, [selectedConnectionId])

  const selectedConnection = activeConnections.find((connection: any) => connection.id === selectedConnectionId) || null

  return (
    <ExchangeContext.Provider
      value={{
        selectedExchange,
        setSelectedExchange: (exchange) => {
          setSelectedExchange(exchange)
          const matching = activeConnections.find((connection: any) => connection.exchange === exchange)
          setSelectedConnectionId(matching?.id || null)
        },
        selectedConnectionId,
        setSelectedConnectionId: (connectionId) => {
          setSelectedConnectionId(connectionId)
          selectedConnectionIdRef.current = connectionId
          const matching = activeConnections.find((connection: any) => connection.id === connectionId)
          setSelectedExchange(matching?.exchange || null)
        },
        selectedConnection,
        activeConnections,
        loadActiveConnections,
        isLoading,
      }}
    >
      {children}
    </ExchangeContext.Provider>
  )
}

export function useExchange() {
  const context = useContext(ExchangeContext)
  if (context === undefined) {
    throw new Error("useExchange must be used within an ExchangeProvider")
  }
  return context
}
