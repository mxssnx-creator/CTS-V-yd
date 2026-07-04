"use client"

import { buildConnectionMutationEventDetail, dispatchConnectionMutationEvents } from "@/lib/connection-events"
import { MIN_VOLUME_FACTOR } from "@/lib/constants"
import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Plus, Loader2, Trash2, Info, Settings, Eye, EyeOff } from 'lucide-react'
import { toast } from "@/lib/simple-toast"
import type { Connection } from "@/lib/db-types"
import { AddConnectionDialog } from "@/components/settings/add-connection-dialog"
import { ConnectionCard } from "@/components/settings/connection-card"
import { BingXCredentialsDialog } from "@/components/settings/bingx-credentials-dialog"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { AlertCircle, Lock, Zap } from "lucide-react"

const EXCHANGES: Record<string, { name: string; subtypes: string[] }> = {
  bybit: { name: "Bybit", subtypes: ["perpetual", "futures", "spot", "options"] },
  bingx: { name: "BingX", subtypes: ["perpetual", "spot"] },
  pionex: { name: "Pionex", subtypes: ["spot"] },
  orangex: { name: "OrangeX", subtypes: ["perpetual", "spot"] },
  binance: { name: "Binance", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  okx: { name: "OKX", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  gateio: { name: "Gate.io", subtypes: ["perpetual", "futures", "spot", "margin", "options"] },
  mexc: { name: "MEXC", subtypes: ["perpetual", "spot"] },
  bitget: { name: "Bitget", subtypes: ["perpetual", "futures", "spot", "margin"] },
  kucoin: { name: "KuCoin", subtypes: ["perpetual", "futures", "spot", "margin"] },
  huobi: { name: "Huobi", subtypes: ["perpetual", "spot", "margin"] },
}

const CONNECTION_METHODS = [
  { value: "rest", label: "REST API" },
  { value: "websocket", label: "WebSocket" },
  { value: "hybrid", label: "Hybrid (REST + WS)" },
]

const CONNECTION_LIBRARIES = [
  { value: "native", label: "Native" },
  { value: "ccxt", label: "CCXT" },
  { value: "exchange-lib", label: "Exchange SDK" },
  { value: "custom", label: "Custom" },
]

const EXCHANGE_CONNECTION_METHODS: Record<string, string[]> = {
  bybit: ["rest", "websocket", "hybrid"],
  bingx: ["rest", "websocket"],
  binance: ["rest", "websocket", "hybrid"],
  okx: ["rest", "websocket", "hybrid"],
  gateio: ["rest", "websocket"],
  kucoin: ["rest", "websocket"],
  mexc: ["rest", "websocket"],
  bitget: ["rest", "websocket"],
  pionex: ["rest", "websocket"],
  orangex: ["rest"],
  huobi: ["rest", "websocket"],
  kraken: ["rest", "websocket"],
  coinbase: ["rest"],
}

// Edit Connection Dialog Component
function EditConnectionDialog({ connection, onSave, exchangeName }: { connection: Connection; onSave: () => Promise<void>; exchangeName: string }) {
  const [loading, setLoading] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testLog, setTestLog] = useState<string[]>([])
  const [showTestLog, setShowTestLog] = useState(false)
  const [showSecrets, setShowSecrets] = useState(false)
  const [btcPrice, setBtcPrice] = useState<string | null>(null)
  const [formData, setFormData] = useState({
    api_key: connection.api_key || "",
    api_secret: connection.api_secret || "",
    api_passphrase: connection.api_passphrase || "",
    margin_type: connection.margin_type || "cross",
    position_mode: connection.position_mode || "hedge",
    is_testnet: connection.is_testnet || false,
    connection_method: connection.connection_method || "rest",
    connection_library: connection.connection_library || "native",
    api_type: connection.api_type || "perpetual",
    api_subtype: connection.api_subtype || "perpetual",
    is_live_trade: connection.is_live_trade ?? false,
  })

  const handleTestConnection = async () => {
    if (!formData.api_key || !formData.api_secret) {
      toast.error("Please enter API Key and API Secret")
      return
    }

    setTesting(true)
    setTestLog([])
    setShowTestLog(true)
    setBtcPrice(null)

    try {
      // Fetch BTC price first
      try {
        const priceResponse = await fetch("https://api.coinbase.com/v2/prices/BTC-USD/spot")
        if (priceResponse.ok) {
          const priceData = await priceResponse.json()
          setBtcPrice(priceData.data?.amount || "N/A")
        }
      } catch (e) {
        console.log("[v0] Could not fetch BTC price")
      }

      console.log("[v0] [Test Connection] Using configured settings:", {
        exchange: connection.exchange,
        api_type: connection.api_type,
        api_subtype: formData.api_subtype,
        connection_method: formData.connection_method,
        connection_library: formData.connection_library,
        is_testnet: formData.is_testnet,
      })

      const response = await fetch(`/api/settings/connections/${connection.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          exchange: connection.exchange,
          api_type: formData.api_type,
          api_subtype: formData.api_subtype,
          connection_method: formData.connection_method,
          connection_library: formData.connection_library,
          api_key: formData.api_key,
          api_secret: formData.api_secret,
          api_passphrase: formData.api_passphrase || "",
          is_testnet: formData.is_testnet,
        }),
      })

      let logs = [
        `[${new Date().toLocaleTimeString()}] Starting connection test...\n`,
        `Exchange: ${connection.exchange.toUpperCase()} (${exchangeName})\n`,
        `API Type: ${formData.api_type} | Subtype: ${formData.api_subtype}\n`,
        `Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}\n`,
        `Testnet: ${formData.is_testnet ? "Yes" : "No"}\n`,
        `Margin: ${formData.margin_type} | Position: ${formData.position_mode}\n`,
        `---\n`,
      ]

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Connection test failed")
      }

      const data = await response.json()
      let responseLogs = data.log || []
      if (!Array.isArray(responseLogs)) {
        responseLogs = [responseLogs.toString()]
      }
      logs.push(...responseLogs)

      // Add balance if available
      if (data.balance !== undefined) {
        const balanceUSD = parseFloat(data.balance).toFixed(2)
        logs.push(`\n✓ Account Balance: $${balanceUSD}`)
      }

      // Add BTC price if available
      if (btcPrice) {
        logs.push(`✓ BTC Price: $${btcPrice}`)
      }

      logs.push(`\n✓ Connection test PASSED - Ready to trade!`)
      setTestLog(logs)
      toast.success("Connection test passed!")
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Test connection error"
      let logs = [
        `[${new Date().toLocaleTimeString()}] Starting connection test...\n`,
        `Exchange: ${connection.exchange.toUpperCase()} (${exchangeName})\n`,
        `API Type: ${connection.api_type} | Subtype: ${formData.api_subtype}\n`,
        `Connection: ${formData.connection_method.toUpperCase()} | Library: ${formData.connection_library}\n`,
        `---\n`,
        `✗ Error: ${errorMsg}`,
      ]
      if (btcPrice) {
        logs.push(`\nℹ BTC Price: $${btcPrice}`)
      }
      setTestLog(logs)
      toast.error(errorMsg)
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setLoading(true)
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: formData.api_key,
          api_secret: formData.api_secret,
          api_passphrase: formData.api_passphrase,
          margin_type: formData.margin_type,
          position_mode: formData.position_mode,
          is_testnet: formData.is_testnet,
          connection_method: formData.connection_method,
          connection_library: formData.connection_library,
          api_subtype: formData.api_subtype,
        }),
      })

      if (!response.ok) throw new Error("Failed to update")
      toast.success("Connection updated")
      await onSave()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update")
    } finally {
      setLoading(false)
    }
  }

  return (
    <Tabs defaultValue="credentials" className="w-full">
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="credentials">API Credentials</TabsTrigger>
        <TabsTrigger value="settings">Settings & Test</TabsTrigger>
      </TabsList>

      <TabsContent value="credentials" className="space-y-4 mt-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 flex gap-3">
          <AlertCircle className="h-4 w-4 shrink-0 text-amber-900 mt-0.5" />
          <div className="text-sm text-amber-900">
            <p className="font-semibold mb-1">Update API Credentials</p>
            <p className="text-xs">Change your API keys here if needed</p>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="font-medium flex items-center gap-2">
            <Lock className="h-4 w-4" />
            API Key
          </Label>
          <div className="relative">
            <Input
              type={showSecrets ? "text" : "password"}
              value={formData.api_key}
              onChange={(e) => setFormData({ ...formData, api_key: e.target.value })}
              placeholder="Enter your API Key"
              disabled={loading}
              className="pr-10 bg-white"
            />
            <button
              type="button"
              onClick={() => setShowSecrets(!showSecrets)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              {showSecrets ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </div>

        <div className="space-y-2">
          <Label className="font-medium flex items-center gap-2">
            <Lock className="h-4 w-4" />
            API Secret
          </Label>
          <Input
            type={showSecrets ? "text" : "password"}
            value={formData.api_secret}
            onChange={(e) => setFormData({ ...formData, api_secret: e.target.value })}
            placeholder="Enter your API Secret"
            disabled={loading}
            className="bg-white"
          />
        </div>

        <div className="space-y-2">
          <Label className="font-medium">API Passphrase (Optional)</Label>
          <Input
            type={showSecrets ? "text" : "password"}
            value={formData.api_passphrase}
            onChange={(e) => setFormData({ ...formData, api_passphrase: e.target.value })}
            placeholder="Leave blank if not required"
            disabled={loading}
            className="bg-white"
          />
        </div>
      </TabsContent>

      <TabsContent value="settings" className="space-y-4 mt-4">
        {/* Connection Configuration Section */}
        <div className="border-b pb-4">
          <h4 className="font-semibold text-sm mb-3">Connection Configuration</h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="font-medium text-xs">API Subtype</Label>
              <Select value={formData.api_subtype} onValueChange={(value) => setFormData({ ...formData, api_subtype: value })}>
                <SelectTrigger disabled={loading} className="bg-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGES[connection.exchange as keyof typeof EXCHANGES]?.subtypes.map((subtype) => (
                    <SelectItem key={subtype} value={subtype}>
                      {subtype.charAt(0).toUpperCase() + subtype.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-xs">Connection Method</Label>
              <Select value={formData.connection_method} onValueChange={(value) => setFormData({ ...formData, connection_method: value })}>
                <SelectTrigger disabled={loading} className="bg-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {EXCHANGE_CONNECTION_METHODS[connection.exchange as keyof typeof EXCHANGE_CONNECTION_METHODS]?.map((method) => (
                    <SelectItem key={method} value={method}>
                      {CONNECTION_METHODS.find(m => m.value === method)?.label || method}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="font-medium text-xs">Connection Library</Label>
              <Select value={formData.connection_library} onValueChange={(value) => setFormData({ ...formData, connection_library: value })}>
                <SelectTrigger disabled={loading} className="bg-white text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="native">Native</SelectItem>
                  <SelectItem value="ccxt">CCXT</SelectItem>
                  <SelectItem value="exchange-lib">Exchange-specific SDK</SelectItem>
                  <SelectItem value="custom">Custom Implementation</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        {/* Trading Settings Section */}
        <div className="border-b pb-4">
          <h4 className="font-semibold text-sm mb-3">Trading Settings</h4>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label className="font-medium">Margin Type</Label>
              <Select value={formData.margin_type} onValueChange={(value) => setFormData({ ...formData, margin_type: value })}>
                <SelectTrigger disabled={loading} className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cross">Cross Margin</SelectItem>
                  <SelectItem value="isolated">Isolated Margin</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label className="font-medium">Position Mode</Label>
              <Select value={formData.position_mode} onValueChange={(value) => setFormData({ ...formData, position_mode: value })}>
                <SelectTrigger disabled={loading} className="bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="hedge">Hedge Mode</SelectItem>
                  <SelectItem value="one-way">One-way Mode</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between border-b pb-4">
          <div>
            <Label className="font-medium">Use Testnet</Label>
            <p className="text-xs text-muted-foreground mt-1">{formData.is_testnet ? "Testnet" : "Live"}</p>
          </div>
          <Switch checked={formData.is_testnet === true || formData.is_testnet === "true" || formData.is_testnet === "1"} onCheckedChange={(checked) => setFormData({ ...formData, is_testnet: checked })} disabled={loading} />
        </div>

        <div className="border-t pt-4 space-y-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4 text-orange-600" />
            <h4 className="font-semibold text-sm">Test Connection</h4>
          </div>

          {!showTestLog && (
            <Button onClick={handleTestConnection} disabled={testing || !formData.api_key || !formData.api_secret || loading} className="w-full bg-orange-600 hover:bg-orange-700">
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Zap className="h-4 w-4 mr-2" />
                  Test Connection
                </>
              )}
            </Button>
          )}

          {showTestLog && testLog.length > 0 && (
            <div className="space-y-2">
              <div className="bg-slate-900 text-slate-100 p-3 rounded font-mono text-xs space-y-1 max-h-48 overflow-y-auto border border-slate-700">
                {testLog.map((log, idx) => (
                  <div key={idx} className="text-slate-300">
                    {log}
                  </div>
                ))}
              </div>
              <Button type="button" onClick={handleTestConnection} disabled={testing || loading} variant="outline" size="sm" className="w-full">
                {testing ? "Testing..." : "Test Again"}
              </Button>
            </div>
          )}
        </div>
      </TabsContent>

      <div className="flex gap-2 justify-end pt-4 mt-4 border-t">
        <Button variant="outline" disabled={loading} onClick={() => window.location.reload()}>
          Cancel
        </Button>
        <Button onClick={handleSave} disabled={loading}>
          {loading ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Changes"
          )}
        </Button>
      </div>
    </Tabs>
  )
}

export default function ExchangeConnectionManager() {
  const [connections, setConnections] = useState<Connection[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [showAddDialog, setShowAddDialog] = useState(false)
  const [testingId, setTestingId] = useState<string | null>(null)
  const [recentlyInsertedBase, setRecentlyInsertedBase] = useState<Set<string>>(new Set())
  const [showBingXCredentialsDialog, setShowBingXCredentialsDialog] = useState(false)

  // Default exchanges to display
  const DEFAULT_EXCHANGES = ["bybit", "bingx", "pionex", "orangex"]
  const toBoolean = (value: unknown): boolean => value === true || value === 1 || value === "1" || value === "true"

  // Separate predefined (templates) from user-created connections
  const predefinedConnections = connections.filter((c: any) => c.is_predefined === true || c.is_predefined === "1")
  const userConnections = connections.filter((c: any) => !(c.is_predefined === true || c.is_predefined === "1"))

  // For display: show user-created connections + base inserted connections
  const displayedConnections = connections.filter((c: any) => {
    const exch = (c.exchange || "").toLowerCase()
    // Show if user-created OR any base exchange connection (keep all 4 base visible consistently)
    const isUserCreated = !(c.is_predefined === true || c.is_predefined === "1")
    const isBase = exch === "bybit" || exch === "bingx" || exch === "pionex" || exch === "orangex"
    return isUserCreated || isBase
  })

  const loadConnections = async () => {
    try {
      setLoading(true)
      setError(null)

      const response = await fetch("/api/settings/connections")
      if (!response.ok) throw new Error("Failed to load connections")

      const data = await response.json()

      // Handle both array and object response formats
      let connectionsArray = Array.isArray(data) ? data : (data?.connections || [])

      if (!Array.isArray(connectionsArray)) {
        console.warn("Invalid connections format:", typeof connectionsArray)
        setConnections([])
        return
      }

      // Validate and normalize connections
      const validConnections = connectionsArray
        .filter((c: any) => {
          if (!c || typeof c !== "object") return false
          if (typeof c.id !== "string" || !c.id) return false
          if (typeof c.name !== "string" || !c.name) return false
          if (typeof c.exchange !== "string" || !c.exchange) return false
          return true
        })
        .map((c: any) => ({
          ...c,
          is_enabled: toBoolean(c.is_enabled),
          is_testnet: toBoolean(c.is_testnet),
          is_live_trade: toBoolean(c.is_live_trade),
          is_preset_trade: toBoolean(c.is_preset_trade),
          is_active: toBoolean(c.is_active),
          is_predefined: toBoolean(c.is_predefined),
          volume_factor: typeof c.volume_factor === "number" ? c.volume_factor : MIN_VOLUME_FACTOR,
          margin_type: c.margin_type || "cross",
          position_mode: c.position_mode || "hedge",
          api_type: c.api_type || "perpetual_futures",
          connection_method: c.connection_method || "rest",
          connection_library: c.connection_library || "library",
        } as Connection))

      setConnections(validConnections)
    } catch (err) {
      console.error("[v0] Error loading connections:", err)
      setError(err instanceof Error ? err.message : "Failed to load connections")
      setConnections([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadConnections()
  }, [])

  const testConnection = async (id: string) => {
    setTestingId(id)
    try {
      console.log("[v0] Testing connection:", id)
      
      const response = await fetch(`/api/settings/connections/${id}/test`, {
        method: "POST",
      })

      const data = await response.json()

      console.log("[v0] Test response status:", response.status, "data:", data)

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Test failed"
        console.error("[v0] Test API error:", errorMsg)
        throw new Error(errorMsg)
      }

      // Update connection with test results
      setConnections((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                last_test_status: data.success ? "success" : "failed",
                last_test_balance: data.balance,
                last_test_log: data.log || [],
              }
            : c
        )
      )

      toast.success(`Connection test successful! Balance: $${data.balance?.toFixed(2) || "0.00"}`)
    } catch (error) {
      console.error("[v0] Test error:", error)
      toast.error(error instanceof Error ? error.message : "Test failed")
    } finally {
      setTestingId(null)
    }
  }

  const handleDeleteConnection = async (id: string) => {
    try {
      const response = await fetch(`/api/settings/connections/${id}`, {
        method: "DELETE",
      })

      if (!response.ok) {
        const data = await response.json()
        throw new Error(data.error || "Failed to delete")
      }

      // Refresh the connections list
      setConnections((prev) => prev.filter((c) => c.id !== id))
      await loadConnections()
      toast.success("Connection deleted")
    } catch (error) {
      console.error("[v0] Delete error:", error)
      toast.error(error instanceof Error ? error.message : "Failed to delete connection")
    }
  }

  const toggleEnabled = async (id: string, enabled: boolean) => {
    try {
      // Find the connection to get current state
      const connection = connections.find(c => c.id === id)
      if (!connection) {
        toast.error("Connection not found")
        return
      }

      console.log("[v0] Toggling connection:", id, "enabled:", enabled)

      const response = await fetch(`/api/settings/connections/${id}/toggle`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ 
          is_enabled: enabled,
          is_live_trade: enabled ? connection.is_live_trade : false,
          is_preset_trade: enabled ? connection.is_preset_trade : false,
        }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Failed to toggle connection"
        console.error("[v0] Toggle failed:", errorMsg)
        throw new Error(errorMsg)
      }

      dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
        connectionId: id,
        connection: { id, name: connection.name, exchange: connection.exchange },
        engine: { action: enabled ? "enable" : "disable", status: data.tradeEngineStarted ? "running" : undefined },
        source: "exchange-connection-manager.toggleConnection",
      }))

      // Update local state immediately
      setConnections((prev) =>
        prev.map((c) => 
          c.id === id 
            ? { 
                ...c, 
                is_enabled: enabled,
                is_live_trade: enabled ? c.is_live_trade : false,
                is_preset_trade: enabled ? c.is_preset_trade : false,
              } 
            : c
        )
      )

      // Show appropriate toast message
      if (enabled) {
        const message = data.tradeEngineStarted 
          ? `Connection enabled and trade engine started automatically`
          : `Connection enabled${connection.api_key ? " (add credentials to auto-start trade engine)" : ""}`
        toast.success(message)
      } else {
        toast.success("Connection disabled")
      }
      
      console.log("[v0] Toggle successful for:", id, "trade engine started:", data.tradeEngineStarted)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to toggle connection"
      console.error("[v0] Toggle error:", errorMsg)
      toast.error(errorMsg)
    }
  }

  const toggleDashboard = async (id: string, enabled: boolean) => {
    try {
      // Find the connection to get current state
      const connection = connections.find(c => c.id === id)
      if (!connection) {
        toast.error("Connection not found")
        return
      }

      console.log("[v0] [Dashboard] Toggling dashboard visibility for:", id, "visible:", enabled)

      const response = await fetch(`/api/settings/connections/${id}/toggle-dashboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ is_enabled_dashboard: enabled }),
      })

      const data = await response.json().catch(() => ({}))

      if (!response.ok) {
        const errorMsg = data.error || data.details || "Failed to toggle dashboard visibility"
        console.error("[v0] Dashboard toggle failed:", errorMsg)
        throw new Error(errorMsg)
      }

      dispatchConnectionMutationEvents(buildConnectionMutationEventDetail(data, {
        connectionId: id,
        connection: { id, name: connection.name, exchange: connection.exchange },
        engine: { action: enabled ? "start" : "stop", status: data.engine?.status },
        source: "exchange-connection-manager.toggleDashboard",
      }))

      // Update local state immediately
      setConnections((prev) =>
        prev.map((c) => 
          c.id === id 
            ? { ...c, is_enabled_dashboard: enabled } 
            : c
        )
      )

      const t = data.changed ? (enabled ? "Connection now enabled in Main Connections" : "Connection disabled in Main Connections") : (enabled ? "Already enabled in Main Connections" : "Already disabled")
      toast.success(t)
      
      console.log("[v0] [Dashboard] Toggle successful for:", id, "is_enabled_dashboard:", enabled)
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Failed to toggle dashboard visibility"
      console.error("[v0] [Dashboard] Toggle error:", errorMsg)
      toast.error(errorMsg)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Base Connections</h3>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>
        <Card>
          <CardContent className="pt-6 flex items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin" />
            <span className="ml-2">Loading connections...</span>
          </CardContent>
        </Card>
        <AddConnectionDialog 
          open={showAddDialog} 
          onOpenChange={setShowAddDialog} 
          onConnectionAdded={async (connectionId) => {
            console.log("[v0] Connection added:", connectionId)
            if (connectionId) {
              setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
              setTimeout(() => {
                setRecentlyInsertedBase((prev) => {
                  const next = new Set(prev)
                  next.delete(connectionId)
                  return next
                })
              }, 10000)
            }
            await loadConnections()
          }} 
        />
      </div>
    )
  }

  if (error) {
    return (
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Base Connections</h3>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-6">
            <p className="text-red-700">{error}</p>
            <Button variant="outline" onClick={loadConnections} className="mt-4">
              Try Again
            </Button>
          </CardContent>
        </Card>
        <AddConnectionDialog 
          open={showAddDialog} 
          onOpenChange={setShowAddDialog} 
          onConnectionAdded={async (connectionId) => {
            console.log("[v0] Connection added:", connectionId)
            if (connectionId) {
              setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
              setTimeout(() => {
                setRecentlyInsertedBase((prev) => {
                  const next = new Set(prev)
                  next.delete(connectionId)
                  return next
                })
              }, 10000)
            }
            await loadConnections()
          }} 
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="font-semibold text-lg">Base Connections</h3>
            <p className="text-sm text-muted-foreground">
              Configure API credentials and connection settings. These are base configurations independent of Main Connections (Active Connections).
            </p>
          </div>
          <Button onClick={() => setShowAddDialog(true)}>
            <Plus className="h-4 w-4 mr-2" />
            Add Connection
          </Button>
        </div>

        {displayedConnections.length === 0 ? (
          <Card>
            <CardContent className="pt-6 text-center">
              <p className="text-muted-foreground mb-4">No default connections configured yet</p>
              <Button onClick={() => setShowAddDialog(true)}>
                <Plus className="h-4 w-4 mr-2" />
                Create First Connection
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {displayedConnections.map((conn) => (
              <ConnectionCard
                key={conn.id}
                connection={conn as any}
                onToggle={() => toggleEnabled(conn.id, !conn.is_enabled)}
                onActivate={() => {
                  // Set as active connection
                }}
                onDelete={() => handleDeleteConnection(conn.id)}
                onEdit={(settings) => {
                  // Handle edit
                  loadConnections()
                }}
                onShowDetails={() => {
                  // Show details
                }}
                onShowLogs={() => {
                  // Show logs
                }}
                onTestConnection={(logs) => {
                  // Connection tested
                }}
                isNewlyAdded={recentlyInsertedBase.has(conn.id)}
              />
            ))}
          </div>
        )}
      </div>

      <AddConnectionDialog 
        open={showAddDialog} 
        onOpenChange={setShowAddDialog} 
        onConnectionAdded={async (connectionId) => {
          console.log("[v0] Connection added:", connectionId)
          // Mark as newly added for auto-test
          if (connectionId) {
            setRecentlyInsertedBase((prev) => new Set(prev).add(connectionId))
            // Clear the flag after 10 seconds
            setTimeout(() => {
              setRecentlyInsertedBase((prev) => {
                const next = new Set(prev)
                next.delete(connectionId)
                return next
              })
            }, 10000)
          }
          await loadConnections()
        }} 
      />

      <BingXCredentialsDialog
        open={showBingXCredentialsDialog}
        onOpenChange={setShowBingXCredentialsDialog}
        onSuccess={() => {
          // Reload connections after credentials are saved
          loadConnections()
        }}
      />
    </div>
  )
}
