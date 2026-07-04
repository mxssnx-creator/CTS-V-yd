"use client"

import React, { useState, useEffect, useRef } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { Slider } from "@/components/ui/slider"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ConnectionStateTabs } from "@/components/dashboard/connection-state-tabs"
import { Input } from "@/components/ui/input"
import { toast } from "sonner"
import type { ExchangeConnection } from "@/lib/types"
import { Activity, AlertCircle, CheckCircle, Trash2, Settings, Info } from "lucide-react"
import { ConnectionDetailedLogDialog } from "./connection-detailed-log-dialog"

interface ConnectionCardProps {
  connection: ExchangeConnection
  onToggleEnable: (id: string, enabled: boolean) => void
  onToggleLiveTrade: (id: string, enabled: boolean) => void
  onTogglePresetTrade: (id: string, enabled: boolean) => void
  onDelete: (id: string) => void
  isActive?: boolean // Independent active status for dashboard
  onToggleActive?: () => void
  balance?: number
  status: "connected" | "connecting" | "error" | "disabled"
  progress?: number
}

interface PresetType {
  id: string
  name: string
  description?: string
  is_active: boolean
  preset_trade_type: string
}

interface ActiveIndicationConfig {
  direction: boolean
  move: boolean
  active: boolean
  optimal: boolean
  active_advanced: boolean // NEW
}

interface StrategyConfig {
  trailing: boolean
  block: boolean
  dca: boolean
}

export function ConnectionCard({
  connection,
  onToggleEnable,
  onToggleLiveTrade,
  onTogglePresetTrade,
  onDelete,
  isActive = false,
  onToggleActive,
  balance = 0,
  status,
  progress = 0,
}: ConnectionCardProps) {
  const [expanded, setExpanded] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)
  const [autoTested, setAutoTested] = useState(false)
  const [showLogs, setShowLogs] = useState(false)
  const [showInfo, setShowInfo] = useState(false)
  const [showPresetConfig, setShowPresetConfig] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showAdvancedSettings, setShowAdvancedSettings] = useState(false)
  const [advancedTab, setAdvancedTab] = useState("risk")
  const [showPresetDialog, setShowPresetDialog] = useState(false)
  const [showStrategyDialog, setShowStrategyDialog] = useState(false)
  const [showActivateTradeDialog, setShowActivateTradeDialog] = useState(false)
  const [presetConfig, setPresetConfig] = useState({
    volumeFactor: 0.1,
    profitFactorMin: 0.6,
    maxDrawdownTime: 12,
    trailingEnabled: true,
    blockEnabled: true,
    dcaEnabled: false,
  })
  const [connectionInfo, setConnectionInfo] = useState({
    marginMode: "cross",
    positionType: "single",
    baseVolumeFactor: 0.1,
    liveTradeVolumeFactor: 0.1,
    presetTradeVolumeFactor: 0.1,
    profitFactorBase: 0.6,
    profitFactorMain: 0.6,
    profitFactorReal: 0.6,
    maxDrawdownTime: 12,
    presetType: "momentum",
    strategyStates: {
      trailing: true,
      block: true,
      dca: false,
    },
  })
  const [presetTradeEnabled, setPresetTradeEnabled] = useState(false)
  const [showDisableConfirm, setShowDisableConfirm] = useState(false)
  const [selectedPresetType, setSelectedPresetType] = useState<string>(connection.preset_type_id || "")
  const [availablePresetTypes, setAvailablePresetTypes] = useState<PresetType[]>([])
  const [engineStatus, setEngineStatus] = useState<any>(null)
  const [testingProgress, setTestingProgress] = useState(0)
  const [volumeFactorLive, setVolumeFactorLive] = useState(0.1)
  const [volumeFactorPreset, setVolumeFactorPreset] = useState(0.1)

  // Added state for strategy configuration
  const [activeIndications, setActiveIndications] = useState<ActiveIndicationConfig>({
    direction: true,
    move: true,
    active: true,
    optimal: false,
    active_advanced: false, // NEW
  })
  const [strategyConfig, setStrategyConfig] = useState<StrategyConfig>({
    trailing: true,
    block: true,
    dca: false,
  })

  const [logs, setLogs] = useState<Array<{ timestamp: string; level: string; message: string }>>([])

  // Auto-test on mount if not tested (with proper cleanup)
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    if (!autoTested && !connection.last_test_status && connection.is_enabled) {
      setAutoTested(true)
      // Delay auto-test by 2 seconds to avoid overwhelming the API
      timer = setTimeout(() => {
        handleTestConnection()
      }, 2000)
    }
    return () => { if (timer) clearTimeout(timer) }
  }, [connection.id])

  const addLog = (level: string, message: string) => {
    const timestamp = new Date().toISOString()
    const logEntry = { timestamp, level, message }

    setLogs((prev) => [...prev, logEntry].slice(-50))

    // Send to system logger
    fetch("/api/system/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level,
        category: "connection",
        message,
        connectionId: connection.id,
      }),
    }).catch(() => { /* non-critical */ })
  }

  useEffect(() => {
    const loadLogs = async () => {
      try {
        const response = await fetch(`/api/settings/connections/${connection.id}/logs`)
        if (response.ok) {
          const data = await response.json()
          setLogs(data.logs || [])
        }
      } catch { /* non-critical */ }
    }

    if (showLogs) {
      loadLogs()
    }
  }, [showLogs, connection.id])

  useEffect(() => {
    if (!connection.is_enabled) return

    const pollStatus = async () => {
      try {
        const response = await fetch(`/api/connections/status/${connection.id}`)
        if (response.ok) {
          const statusData = await response.json()
          // Update component state with real data
          if (statusData.progress !== undefined) {
            // Progress update would trigger parent component re-render
          }
        }
      } catch { /* non-critical */ }
    }

    const interval = setInterval(pollStatus, 3000) // Poll every 3 seconds
    pollStatus() // Initial call

    return () => clearInterval(interval)
  }, [connection.is_enabled, connection.id])

  useEffect(() => {
    const loadPresetTypes = async () => {
      try {
        const response = await fetch("/api/preset-types")
        if (response.ok) {
          const data = await response.json()
          setAvailablePresetTypes(data.filter((p: PresetType) => p.is_active))
        }
      } catch { /* non-critical */ }
    }

    loadPresetTypes()
  }, [])

  useEffect(() => {
    if (connection.preset_type_id) {
      setSelectedPresetType(connection.preset_type_id)
    }
  }, [connection.preset_type_id])

  useEffect(() => {
    const loadConnectionInfo = async () => {
      try {
        const response = await fetch("/api/settings")
        if (response.ok) {
          const data = await response.json()
          setConnectionInfo({
            marginMode: data.marginMode || "cross",
            positionType: data.hedgingMode || "single",
            baseVolumeFactor: 0.1,
            liveTradeVolumeFactor: data.liveTradeVolumeFactor || 0.1,
            presetTradeVolumeFactor: data.presetTradeVolumeFactor || 0.1,
            profitFactorBase: data.profitFactorBase || 0.7,
            profitFactorMain: data.profitFactorMain || 0.8,
            profitFactorReal: data.profitFactorReal || 0.9,
            maxDrawdownTime: data.maxDrawdownTime || 12,
            presetType: data.presetType || "momentum",
            strategyStates: {
              trailing: data.strategyTrailingEnabled !== "false",
              block: data.strategyBlockEnabled !== "false",
              dca: data.strategyDcaEnabled !== "false",
            },
          })
        }
      } catch { /* non-critical */ }
    }

    if (showInfo) {
      loadConnectionInfo()
    }
  }, [showInfo])

  useEffect(() => {
    const loadPresetConfig = async () => {
      if (!selectedPresetType) return

      try {
        const response = await fetch(`/api/preset-types/${selectedPresetType}/config`)
        if (response.ok) {
          const data = await response.json()
          setPresetConfig({
            volumeFactor: data.volume_factor || 0.1,
            profitFactorMin: data.profit_factor_min || 0.6,
            maxDrawdownTime: data.max_drawdown_time || 12,
            trailingEnabled: data.trailing_enabled !== false,
            blockEnabled: data.block_enabled !== false,
            dcaEnabled: data.dca_enabled === true,
          })
        }
      } catch { /* non-critical */ }
    }

    if (showSettings || showPresetConfig) {
      loadPresetConfig()
    }
  }, [showSettings, showPresetConfig, selectedPresetType])

  useEffect(() => {
    const loadVolumeFactors = async () => {
      try {
        const response = await fetch(`/api/settings/connections/${connection.id}/settings`)
        if (response.ok) {
          const settings = await response.json()
          setVolumeFactorLive(settings.baseVolumeFactorLive || 0.1)
          setVolumeFactorPreset(settings.baseVolumeFactorPreset || 0.1)
        }
      } catch { /* non-critical */ }
    }

    if (connection.id) {
      loadVolumeFactors()
    }
  }, [connection.id])

  useEffect(() => {
    const loadActiveIndications = async () => {
      try {
        const response = await fetch(`/api/settings/connections/${connection.id}/active-indications`)
        if (response.ok) {
          const data = await response.json()
          setActiveIndications(data)
        }
      } catch { /* non-critical */ }
    }

    if (connection.is_enabled) {
      loadActiveIndications()
    }
  }, [connection.id, connection.is_enabled])

  const getStatusIcon = () => {
    switch (status) {
      case "connected":
        return (
          <span className="text-green-500">
            <CheckCircle />
          </span>
        )
      case "connecting":
        return (
          <span className="text-yellow-500">
            <Activity />
          </span>
        )
      case "error":
        return (
          <span className="text-red-500">
            <AlertCircle />
          </span>
        )
      default:
        return <div className="h-4 w-4 rounded-full bg-gray-300" />
    }
  }

  const getStatusColor = () => {
    switch (status) {
      case "connected":
        return "bg-green-500"
      case "connecting":
        return "bg-yellow-500"
      case "error":
        return "bg-red-500"
      default:
        return "bg-gray-300"
    }
  }

  const getConnectionStatus = (connection: ExchangeConnection) => {
    if (!connection.is_enabled) return "disabled"
    if (connection.is_enabled && !connection.is_live_trade) return "connecting"
    return "connected"
  }

  // Placeholder for addLog function
  // const addLog = (level: string, message: string) => {
  //   console.log(`[${level.toUpperCase()}] ${message}`)
  //   // In a real app, you'd add this to a log state or send it to a logging service
  // }

  const handlePresetTypeChange = async (presetTypeId: string) => {
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}/preset-type`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ preset_type_id: presetTypeId }),
      })

      if (!response.ok) throw new Error("Failed to assign preset type")

      setSelectedPresetType(presetTypeId)
      toast.success("Preset type assigned successfully")
    } catch {
      toast.error("Failed to assign preset type")
    }
  }

  const handleMainEnableToggle = async (enabled: boolean) => {
    if (!enabled) {
      setShowDisableConfirm(true)
    } else {
      try {
        const exchangeType = connection.exchange.toLowerCase()

        let maxPositions = 100
        try {
          const settingsRes = await fetch("/api/settings/system")
          if (settingsRes.ok) {
            const systemSettings = await settingsRes.json()
            maxPositions = systemSettings.maxPositionsPerExchange?.[exchangeType] || 100
          }
        } catch { /* use default */ }

        await onToggleEnable(connection.id, true)
        toast.success(`Connection enabled (max ${maxPositions} positions)`)
      } catch {
        toast.error("Failed to enable connection")
      }
    }
  }

  const confirmDisable = async () => {
    try {
      if (presetTradeEnabled && selectedPresetType) {
        await fetch(`/api/preset-coordination-engine/${connection.id}/${selectedPresetType}/stop`, {
          method: "POST",
        })
        setPresetTradeEnabled(false)
        stopStatusPolling()
      }

      await onToggleEnable(connection.id, false)

      setShowDisableConfirm(false)
      toast.success("Connection disabled - all trading stopped")
    } catch {
      toast.error("Failed to disable connection")
    }
  }

  const handleLiveTradeToggle = async (enabled: boolean) => {
    if (!connection.is_enabled) {
      toast.error("Please enable the connection first")
      return
    }

    if (enabled) {
      // Show dialog to select active indications
      setShowActivateTradeDialog(true)
    } else {
      await onToggleLiveTrade(connection.id, false)
    }
  }

  const confirmLiveTradeActivation = async () => {
    // Check if at least one indication is selected
    if (!Object.values(activeIndications).some((v) => v)) {
      toast.error("Please select at least one indication type")
      return
    }

    // Save indications and activate
    await saveActiveIndications()
    await onToggleLiveTrade(connection.id, true)
  }

  const handlePresetTradeToggle = async (enabled: boolean) => {
    if (!connection.is_enabled) {
      toast.error("Please enable the connection first")
      return
    }

    if (enabled && !selectedPresetType) {
      setShowPresetDialog(true)
      return
    }

    setPresetTradeEnabled(enabled)

    // Call the parent handler to update the connection's is_preset_trade field
    onTogglePresetTrade(connection.id, enabled)

    if (enabled && selectedPresetType) {
      try {
        const response = await fetch(`/api/preset-coordination-engine/${connection.id}/${selectedPresetType}/start`, {
          method: "POST",
        })

        if (response.ok) {
          startStatusPolling()
          toast.success("Preset trade engine started")
        } else {
          setPresetTradeEnabled(false)
          toast.error("Failed to start preset trade engine")
        }
      } catch {
        setPresetTradeEnabled(false)
        toast.error("Failed to start preset trade engine")
      }
    } else if (!enabled && selectedPresetType) {
      try {
        const response = await fetch(`/api/preset-coordination-engine/${connection.id}/${selectedPresetType}/stop`, {
          method: "POST",
        })

        if (response.ok) {
          stopStatusPolling()
          toast.success("Preset trade engine stopped")
        }
      } catch {
        toast.error("Failed to stop preset trade engine")
      }
    }
  }

  // Use ref for status polling to prevent memory leaks
  const statusPollingRef = useRef<NodeJS.Timeout | null>(null)

  const startStatusPolling = () => {
    // Clear any existing polling first
    if (statusPollingRef.current) {
      clearInterval(statusPollingRef.current)
    }
    statusPollingRef.current = setInterval(async () => {
      if (!selectedPresetType) return

      try {
        const response = await fetch(`/api/preset-coordination-engine/${connection.id}/${selectedPresetType}/status`)

        if (response.ok) {
          const status = await response.json()
          setEngineStatus(status)
          setTestingProgress(status.testing_progress || 0)
        }
      } catch { /* non-critical */ }
    }, 2000)
  }

  const stopStatusPolling = () => {
    if (statusPollingRef.current) {
      clearInterval(statusPollingRef.current)
      statusPollingRef.current = null
    }
    setTestingProgress(0)
    setEngineStatus(null)
  }
  
  // Cleanup polling on unmount
  useEffect(() => {
    return () => {
      if (statusPollingRef.current) {
        clearInterval(statusPollingRef.current)
        statusPollingRef.current = null
      }
    }
  }, [])

  const updateVolumeFactor = async (type: "live" | "preset", value: number) => {
    try {
      // Validate value range
      const validatedValue = Math.max(0.1, Math.min(10.0, value))

      const response = await fetch(`/api/settings/connections/${connection.id}/settings`)
      if (!response.ok) throw new Error("Failed to load settings")

      const currentSettings = await response.json()
      const settingKey = type === "live" ? "baseVolumeFactorLive" : "baseVolumeFactorPreset"

      const updatedSettings = {
        ...currentSettings,
        [settingKey]: validatedValue,
      }

      const updateResponse = await fetch(`/api/settings/connections/${connection.id}/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings),
      })

      if (!updateResponse.ok) throw new Error("Failed to update volume factor")

      if (type === "live") {
        setVolumeFactorLive(validatedValue)
      } else {
        setVolumeFactorPreset(validatedValue)
      }

      toast.success(`${type === "live" ? "Live" : "Preset"} volume factor updated to ${validatedValue.toFixed(1)}`)
    } catch {
      toast.error("Failed to update volume factor")
    }
  }

  const savePresetConfig = async () => {
    if (!selectedPresetType) return

    try {
      const response = await fetch(`/api/preset-types/${selectedPresetType}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(presetConfig),
      })

      if (!response.ok) throw new Error("Failed to save preset config")

      toast.success("Preset configuration saved")
      setShowPresetConfig(false)
    } catch {
      toast.error("Failed to save preset configuration")
    }
  }

  const saveActiveIndications = async () => {
    try {
      const response = await fetch(`/api/settings/connections/${connection.id}/active-indications`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(activeIndications),
      })

      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        if (data.needsInit) {
          toast.error("Database not initialized. Please use the Quick Reinit button in the alert banner.")
          return
        }
        throw new Error(data.error || "Failed to save active indications")
      }

      toast.success("Active indications saved")
      setShowActivateTradeDialog(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save active indications")
    }
  }

  const handleTestConnection = async () => {
    setTesting(true)
    setTestResult(null)
    toast.info("Testing connection...")

    try {
      const response = await fetch(`/api/settings/connections/${connection.id}/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_type: connection.api_type || "perpetual_futures",
          api_key: connection.api_key,
          api_secret: connection.api_secret,
          api_passphrase: connection.api_passphrase || "",
          is_testnet: connection.is_testnet || false,
          connection_method: connection.connection_method,
          connection_library: connection.connection_library,
        }),
      })

      const data = await response.json()

      if (response.ok) {
        setTestResult({ success: true, ...data })
        toast.success(`Connection successful! Balance: ${data.balance?.toFixed(2)} USDT (${data.apiType || connection.api_type || "futures"})`)
      } else {
        setTestResult({ success: false, error: data.details || data.error })
        toast.error(data.details || data.error || "Connection test failed")
      }
    } catch {
      setTestResult({ success: false, error: "Network error" })
      toast.error("Failed to test connection")
    } finally {
      setTesting(false)
    }
  }

  return (
    <Card className="relative overflow-hidden hover:shadow-lg transition-shadow">
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0 flex-1 cursor-pointer" onClick={() => setExpanded(!expanded)}>
            <CardTitle className="text-base font-semibold truncate">
              {connection.name} ({connection.exchange})
            </CardTitle>
            <div className="h-4 w-4 shrink-0">{getStatusIcon()}</div>
          </div>
          <div className="flex gap-1.5 items-center shrink-0">
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              onClick={() => setShowLogs(true)}
              title="View connection progression logs and errors"
            >
              Logs
            </Button>
            {connection.last_test_status && (
              <Badge 
                variant={connection.last_test_status === "success" ? "default" : "destructive"}
                className="text-xs px-1.5 py-0"
              >
                {connection.last_test_status === "success" ? "✓ Tested" : "✗ Failed"}
              </Badge>
            )}
            <Badge variant="outline" className="text-xs px-1.5 py-0">
              {connection.api_type}
            </Badge>
          </div>
        </div>
      </CardHeader>

      <CardContent className={`space-y-3 pt-2 ${!expanded ? "hidden" : ""}`}>
        {status === "connecting" && (
          <div className="space-y-2">
            <div className="flex justify-between text-xs">
              <span className="truncate font-medium">Loading historical data...</span>
              <span className="shrink-0 ml-2 font-semibold">{progress}%</span>
            </div>
            <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
              <div
                className="h-2 rounded-full bg-gradient-to-r from-blue-500 to-purple-500 transition-all duration-300 ease-out"
                style={{ width: `${progress}%` }}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              {progress < 25 && "Connecting to exchange API..."}
              {progress >= 25 && progress < 50 && "Fetching market data..."}
              {progress >= 50 && progress < 75 && "Loading historical candles..."}
              {progress >= 75 && progress < 100 && "Initializing trading engine..."}
              {progress === 100 && "Connection ready!"}
            </p>
          </div>
        )}

        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <span className="text-xs font-medium whitespace-nowrap">Enable</span>
              <Switch checked={connection.is_enabled} onCheckedChange={handleMainEnableToggle} />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium whitespace-nowrap">Live Trade</span>
              <Switch
                checked={connection.is_live_trade}
                onCheckedChange={handleLiveTradeToggle}
                disabled={!connection.is_enabled}
              />
            </div>

            <div className="flex items-center gap-2">
              <span className="text-xs font-medium whitespace-nowrap">Preset Mode</span>
              <Switch
                checked={presetTradeEnabled}
                onCheckedChange={handlePresetTradeToggle}
                disabled={!connection.is_enabled}
              />
            </div>
          </div>

          <div className="text-center shrink-0">
            <div className="text-xs text-muted-foreground">Balance</div>
            <div className="text-sm font-bold">
              {"$"}{(() => {
                const bal = testResult?.balance ?? (balance || 0);
                const parsed = typeof bal === "number" ? bal : (parseFloat(String(connection.last_test_balance)) || 0);
                return parsed.toFixed(2);
              })()}
            </div>
            {connection.api_type && (
              <div className="text-[10px] text-muted-foreground uppercase">{String(connection.api_type).replace(/_/g, " ")}</div>
            )}
          </div>

          <div className="flex gap-1 shrink-0">
            {/* Info Button - shows connection details */}
            <Dialog open={showInfo} onOpenChange={setShowInfo}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0 bg-transparent" title="Connection Info">
                  <Info className="h-3.5 w-3.5 text-muted-foreground" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-base">Connection Info - {connection.name}</DialogTitle>
                  <DialogDescription>Connection parameters and current trading configuration.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Connection ID</div>
                      <div className="text-sm font-mono bg-muted p-1.5 rounded truncate">{connection.id}</div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Exchange</div>
                      <div className="text-sm font-semibold capitalize">{connection.exchange}</div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Connection Method</div>
                      <div className="text-sm capitalize">{connection.connection_method || 'REST'}</div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Status</div>
                      <div className="text-sm">
                        {connection.is_enabled ? (
                          <Badge variant="default">Enabled</Badge>
                        ) : (
                          <Badge variant="secondary">Disabled</Badge>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-3">
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Margin Mode</div>
                      <div className="text-sm font-semibold capitalize">{connectionInfo.marginMode}</div>
                    </div>
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Trading Type</div>
                      <div className="text-sm font-semibold capitalize">
                        {connectionInfo.positionType === "single" ? "Single" : "Hedge"}
                      </div>
                    </div>
                  </div>

                  {presetTradeEnabled && (
                    <div className="space-y-0.5">
                      <div className="text-xs font-medium text-muted-foreground">Preset Type</div>
                      <div className="text-sm font-semibold capitalize">{connectionInfo.presetType}</div>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Volume Factors</div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Live Trade</span>
                        <span className="text-xs font-semibold">{connectionInfo.liveTradeVolumeFactor.toFixed(1)}</span>
                      </div>
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Preset Mode</span>
                        <span className="text-xs font-semibold">{connectionInfo.presetTradeVolumeFactor.toFixed(1)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Profit Factor Minimums</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Base</span>
                        <span className="text-xs font-semibold">{connectionInfo.profitFactorBase.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Main</span>
                        <span className="text-xs font-semibold">{connectionInfo.profitFactorMain.toFixed(2)}</span>
                      </div>
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Real</span>
                        <span className="text-xs font-semibold">{connectionInfo.profitFactorReal.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-0.5">
                    <div className="text-xs font-medium text-muted-foreground">Max Drawdown Time</div>
                    <div className="text-sm font-semibold">{connectionInfo.maxDrawdownTime} hours</div>
                  </div>

                  <div className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">Strategy States</div>
                    <div className="grid grid-cols-3 gap-2">
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Trailing</span>
                        <Badge variant={connectionInfo.strategyStates.trailing ? "default" : "secondary"} className="text-xs px-1.5 py-0">
                          {connectionInfo.strategyStates.trailing ? "On" : "Off"}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">Block</span>
                        <Badge variant={connectionInfo.strategyStates.block ? "default" : "secondary"} className="text-xs px-1.5 py-0">
                          {connectionInfo.strategyStates.block ? "On" : "Off"}
                        </Badge>
                      </div>
                      <div className="flex items-center justify-between p-1.5 bg-muted rounded">
                        <span className="text-xs">DCA</span>
                        <Badge variant={connectionInfo.strategyStates.dca ? "default" : "secondary"} className="text-xs px-1.5 py-0">
                          {connectionInfo.strategyStates.dca ? "On" : "Off"}
                        </Badge>
                      </div>
                    </div>
                  </div>
                </div>
                <div className="flex gap-2 mt-4">
                  <Button variant="outline" className="flex-1" onClick={() => setShowInfo(false)}>
                    Close
                  </Button>
                </div>
              </DialogContent>
            </Dialog>

            {/* Settings Button - configurable parameters */}
            <ConnectionDetailedLogDialog connection={connection} />
            
            <Dialog open={showSettings} onOpenChange={setShowSettings}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0 bg-transparent" title="Quick Settings">
                  <Settings className="h-3.5 w-3.5 text-blue-600" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-md max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                  <DialogTitle className="text-base">Settings - {connection.name}</DialogTitle>
                  <DialogDescription>Configure volume factor, risk level, and trading parameters.</DialogDescription>
                </DialogHeader>
                <div className="space-y-4">
                  {/* Preset Configuration Section (when preset is active) */}
                  {presetTradeEnabled && (
                    <div className="space-y-3 p-3 border rounded-lg bg-muted/30">
                      <div className="text-sm font-medium">Preset Mode Configuration</div>
                      <div className="space-y-2">
                        <label className="text-xs font-medium">Volume Factor</label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="10"
                          value={presetConfig.volumeFactor}
                          onChange={(e) =>
                            setPresetConfig({ ...presetConfig, volumeFactor: Number.parseFloat(e.target.value) })
                          }
                          className="h-9"
                        />
                        <p className="text-[10px] text-muted-foreground">Multiplier for trade volume (0.1 - 10.0)</p>
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-medium">Profit Factor Minimum</label>
                        <Input
                          type="number"
                          step="0.1"
                          min="0.1"
                          max="5"
                          value={presetConfig.profitFactorMin}
                          onChange={(e) =>
                            setPresetConfig({ ...presetConfig, profitFactorMin: Number.parseFloat(e.target.value) })
                          }
                          className="h-9"
                        />
                      </div>

                      <div className="space-y-2">
                        <label className="text-xs font-medium">Max Drawdown Time (hours)</label>
                        <Input
                          type="number"
                          step="1"
                          min="1"
                          max="168"
                          value={presetConfig.maxDrawdownTime}
                          onChange={(e) =>
                            setPresetConfig({ ...presetConfig, maxDrawdownTime: Number.parseInt(e.target.value) })
                          }
                          className="h-9"
                        />
                      </div>
                    </div>
                  )}

                  {/* Strategy Toggles */}
                  <div className="space-y-3">
                    <div className="text-sm font-medium">Strategy Toggles</div>

                    <div className="flex items-center justify-between p-2 bg-muted rounded">
                      <span className="text-sm">Trailing Stop</span>
                      <Switch
                        checked={presetConfig.trailingEnabled}
                        onCheckedChange={(checked) => setPresetConfig({ ...presetConfig, trailingEnabled: checked })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 bg-muted rounded">
                      <span className="text-sm">Block Trading</span>
                      <Switch
                        checked={presetConfig.blockEnabled}
                        onCheckedChange={(checked) => setPresetConfig({ ...presetConfig, blockEnabled: checked })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2 bg-muted rounded">
                      <span className="text-sm">DCA (Dollar Cost Averaging)</span>
                      <Switch
                        checked={presetConfig.dcaEnabled}
                        onCheckedChange={(checked) => setPresetConfig({ ...presetConfig, dcaEnabled: checked })}
                      />
                    </div>
                  </div>

                  <div className="flex gap-2 pt-2">
                    <Button
                      variant="outline"
                      className="flex-1 bg-transparent"
                      onClick={() => setShowSettings(false)}
                    >
                      Cancel
                    </Button>
                    <Button className="flex-1" onClick={() => { savePresetConfig(); setShowSettings(false) }}>
                      Save Settings
                    </Button>
                  </div>
                </div>
              </DialogContent>
            </Dialog>

            {/* Advanced Settings Button - with tabs for Risk, Trading, Strategy */}
            <Dialog open={showAdvancedSettings} onOpenChange={setShowAdvancedSettings}>
              <DialogTrigger asChild>
                <Button variant="outline" size="sm" className="h-8 w-8 p-0 bg-transparent" title="Advanced Settings">
                  <Settings className="h-3.5 w-3.5 text-purple-600" />
                </Button>
              </DialogTrigger>
              <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
                <DialogHeader>
                  <DialogTitle className="text-base">Advanced Settings - {connection.name}</DialogTitle>
                  <DialogDescription>Configure risk management, trading parameters, and strategy options.</DialogDescription>
                </DialogHeader>
                
                <Tabs value={advancedTab} onValueChange={setAdvancedTab} className="flex-1 flex flex-col overflow-hidden">
                  <TabsList className="grid w-full grid-cols-3">
                    <TabsTrigger value="risk">Risk Management</TabsTrigger>
                    <TabsTrigger value="trading">Trading Parameters</TabsTrigger>
                    <TabsTrigger value="strategy">Strategy Config</TabsTrigger>
                  </TabsList>

                  <div className="flex-1 overflow-y-auto mt-4">
                    <TabsContent value="risk" className="space-y-4 m-0">
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Max Position Size</label>
                          <Input type="number" step="0.01" placeholder="e.g., 10000" className="h-9" />
                          <p className="text-xs text-muted-foreground">Maximum position size in quote currency</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Stop Loss Percentage</label>
                          <Input type="number" step="0.1" placeholder="e.g., 2.5" className="h-9" />
                          <p className="text-xs text-muted-foreground">Automatic stop loss trigger (% from entry)</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Take Profit Percentage</label>
                          <Input type="number" step="0.1" placeholder="e.g., 5.0" className="h-9" />
                          <p className="text-xs text-muted-foreground">Automatic take profit trigger (% from entry)</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Max Daily Loss</label>
                          <Input type="number" step="0.01" placeholder="e.g., 500" className="h-9" />
                          <p className="text-xs text-muted-foreground">Stop trading if daily loss exceeds this amount</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Max Concurrent Positions</label>
                          <Input type="number" step="1" min="1" placeholder="e.g., 5" className="h-9" />
                          <p className="text-xs text-muted-foreground">Maximum number of open positions at once</p>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="trading" className="space-y-4 m-0">
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Order Type</label>
                          <select className="w-full h-9 px-3 rounded-md border border-input bg-background">
                            <option value="market">Market</option>
                            <option value="limit">Limit</option>
                            <option value="stop-market">Stop Market</option>
                            <option value="stop-limit">Stop Limit</option>
                          </select>
                          <p className="text-xs text-muted-foreground">Default order type for new trades</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Time in Force</label>
                          <select className="w-full h-9 px-3 rounded-md border border-input bg-background">
                            <option value="GTC">Good Till Cancel (GTC)</option>
                            <option value="IOC">Immediate or Cancel (IOC)</option>
                            <option value="FOK">Fill or Kill (FOK)</option>
                          </select>
                          <p className="text-xs text-muted-foreground">Order execution timing preference</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Slippage Tolerance (%)</label>
                          <Input type="number" step="0.02" min="0.02" max="0.3" placeholder="e.g., 0.06" className="h-9" />
                          <p className="text-xs text-muted-foreground">Maximum acceptable price slippage</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Reduce Only Mode</label>
                          <div className="flex items-center justify-between p-2 bg-muted rounded">
                            <span className="text-sm">Enable Reduce Only</span>
                            <Switch />
                          </div>
                          <p className="text-xs text-muted-foreground">Only allow orders that reduce position size</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Post Only Mode</label>
                          <div className="flex items-center justify-between p-2 bg-muted rounded">
                            <span className="text-sm">Enable Post Only</span>
                            <Switch />
                          </div>
                          <p className="text-xs text-muted-foreground">Only submit maker orders (no taker fees)</p>
                        </div>
                      </div>
                    </TabsContent>

                    <TabsContent value="strategy" className="space-y-4 m-0">
                      <div className="space-y-3">
                        <div className="space-y-2">
                          <label className="text-sm font-medium">Entry Strategy</label>
                          <select className="w-full h-9 px-3 rounded-md border border-input bg-background">
                            <option value="signal">Signal Based</option>
                            <option value="breakout">Breakout</option>
                            <option value="mean-reversion">Mean Reversion</option>
                            <option value="grid">Grid Trading</option>
                          </select>
                          <p className="text-xs text-muted-foreground">Strategy for entering new positions</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Exit Strategy</label>
                          <select className="w-full h-9 px-3 rounded-md border border-input bg-background">
                            <option value="target">Target Price</option>
                            <option value="trailing">Trailing Stop</option>
                            <option value="time">Time Based</option>
                            <option value="signal">Signal Based</option>
                          </select>
                          <p className="text-xs text-muted-foreground">Strategy for exiting positions</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Position Sizing Method</label>
                          <select className="w-full h-9 px-3 rounded-md border border-input bg-background">
                            <option value="fixed">Fixed Size</option>
                            <option value="percent-balance">Percent of Balance</option>
                            <option value="kelly">Kelly Criterion</option>
                            <option value="risk-parity">Risk Parity</option>
                          </select>
                          <p className="text-xs text-muted-foreground">How to calculate position sizes</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Rebalance Interval</label>
                          <Input type="number" step="1" min="0" placeholder="e.g., 60" className="h-9" />
                          <p className="text-xs text-muted-foreground">Minutes between position rebalancing (0 = disabled)</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Pyramid Positions</label>
                          <div className="flex items-center justify-between p-2 bg-muted rounded">
                            <span className="text-sm">Allow Pyramiding</span>
                            <Switch />
                          </div>
                          <p className="text-xs text-muted-foreground">Add to winning positions at better prices</p>
                        </div>

                        <div className="space-y-2">
                          <label className="text-sm font-medium">Max Pyramid Levels</label>
                          <Input type="number" step="1" min="1" max="10" placeholder="e.g., 3" className="h-9" />
                          <p className="text-xs text-muted-foreground">Maximum times to add to a position</p>
                        </div>
                      </div>
                    </TabsContent>
                  </div>

                  <div className="flex gap-2 pt-4 mt-4 border-t">
                    <Button variant="outline" className="flex-1" onClick={() => setShowAdvancedSettings(false)}>
                      Cancel
                    </Button>
                    <Button className="flex-1" onClick={() => { toast.success("Advanced settings saved"); setShowAdvancedSettings(false) }}>
                      Save Advanced Settings
                    </Button>
                  </div>
                </Tabs>
              </DialogContent>
            </Dialog>

            <Button
              variant="outline"
              size="sm"
              onClick={() => onDelete(connection.id)}
              className="text-red-600 hover:text-red-700 h-8 w-8 p-0"
              title="Delete connection"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>

        {connection.is_enabled && (
          <div className="pt-2 border-t space-y-3">
            <div className="space-y-2">
              <Label htmlFor={`volume-live-${connection.id}`} className="text-xs font-medium">
                Live Trade Volume Factor
              </Label>
              <div className="flex items-center gap-3">
                <Slider
                  id={`volume-live-${connection.id}`}
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={[volumeFactorLive]}
                  onValueChange={([value]) => updateVolumeFactor("live", value)}
                  className="flex-1"
                />
                <span className="text-xs font-medium w-10 text-right">{volumeFactorLive.toFixed(1)}</span>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`volume-preset-${connection.id}`} className="text-xs font-medium">
                Preset Mode Volume Factor
              </Label>
              <div className="flex items-center gap-3">
                <Slider
                  id={`volume-preset-${connection.id}`}
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={[volumeFactorPreset]}
                  onValueChange={([value]) => updateVolumeFactor("preset", value)}
                  className="flex-1"
                />
                <span className="text-xs font-medium w-10 text-right">{volumeFactorPreset.toFixed(1)}</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Strategies</span>
              <Button variant="outline" size="sm" onClick={() => setShowStrategyDialog(true)} className="h-8">
                <Settings className="h-3.5 w-3.5 mr-1.5" />
                Configure
              </Button>
            </div>
          </div>
        )}

        {presetTradeEnabled && (
          <div className="pt-2 border-t">
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-muted-foreground">Assigned Preset Type</span>
                {selectedPresetType && (
                  <Badge variant="default" className="text-xs">
                    Active
                  </Badge>
                )}
              </div>
              <Select value={selectedPresetType} onValueChange={handlePresetTypeChange}>
                <SelectTrigger className="h-9">
                  <SelectValue placeholder="Select a preset type" />
                </SelectTrigger>
                <SelectContent>
                  {availablePresetTypes.length === 0 ? (
                    <div className="p-2 text-xs text-muted-foreground text-center">
                      No active preset types available
                    </div>
                  ) : (
                    availablePresetTypes.map((presetType) => (
                      <SelectItem key={presetType.id} value={presetType.id}>
                        {presetType.name}
                        {presetType.description && (
                          <span className="text-xs text-muted-foreground ml-2">- {presetType.description}</span>
                        )}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {selectedPresetType && (
                <p className="text-xs text-muted-foreground">
                  Trades will use configuration sets from the selected preset type
                </p>
              )}
            </div>
          </div>
        )}

        {presetTradeEnabled && testingProgress > 0 && testingProgress < 100 && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="truncate">{engineStatus?.testing_message || "Testing configurations..."}</span>
              <span className="shrink-0 ml-2">{testingProgress}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-1.5">
              <div
                className="h-1.5 rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${testingProgress}%` }}
              />
            </div>
          </div>
        )}
      </CardContent>

      {/* Settings handled in Settings > Overall > Connection tab */}

      <Dialog open={showPresetDialog} onOpenChange={setShowPresetDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Select Preset Type</DialogTitle>
            <DialogDescription>
              Choose a preset type from the Presets System to use for preset trading.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Please select a preset type before enabling Preset Trade mode. The preset type contains multiple
              configuration sets that will be evaluated and executed based on the Presets System.
            </p>
            <Select value={selectedPresetType} onValueChange={setSelectedPresetType}>
              <SelectTrigger>
                <SelectValue placeholder="Select a preset type" />
              </SelectTrigger>
              <SelectContent>
                {availablePresetTypes.length === 0 ? (
                  <div className="p-2 text-xs text-muted-foreground text-center">
                    No active preset types available. Create preset types in the Presets section first.
                  </div>
                ) : (
                  availablePresetTypes.map((presetType) => (
                    <SelectItem key={presetType.id} value={presetType.id}>
                      <div>
                        <div className="font-medium">{presetType.name}</div>
                        {presetType.description && (
                          <div className="text-xs text-muted-foreground">{presetType.description}</div>
                        )}
                      </div>
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
            <Button
              className="w-full"
              onClick={() => {
                setShowPresetDialog(false)
                if (selectedPresetType) {
                  handlePresetTypeChange(selectedPresetType)
                  handlePresetTradeToggle(true)
                }
              }}
              disabled={!selectedPresetType}
            >
              Confirm Selection
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showDisableConfirm} onOpenChange={setShowDisableConfirm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Disable Connection?</DialogTitle>
            <DialogDescription>
              This will stop all trading activity on this connection including:
            </DialogDescription>
          </DialogHeader>
          <ul className="list-disc list-inside mt-2 space-y-1 text-sm text-muted-foreground">
            <li>Live Trade Engine</li>
            <li>Preset Trade Engine</li>
            <li>All active positions monitoring</li>
          </ul>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setShowDisableConfirm(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDisable}>
              Disable All Trading
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showStrategyDialog} onOpenChange={setShowStrategyDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Strategy Configuration</DialogTitle>
            <DialogDescription>
              Configure which main indications and strategies are active for this connection
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* Main Indications Section */}
            <div className="space-y-3">
              <div className="text-sm font-medium">Main Indications</div>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2 bg-muted rounded">
                  <span className="text-sm">Direction</span>
                  <Switch
                    checked={activeIndications.direction}
                    onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, direction: checked })}
                  />
                </div>
                <div className="flex items-center justify-between p-2 bg-muted rounded">
                  <span className="text-sm">Move</span>
                  <Switch
                    checked={activeIndications.move}
                    onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, move: checked })}
                  />
                </div>
                <div className="flex items-center justify-between p-2 bg-muted rounded">
                  <span className="text-sm">Active (Fast Change)</span>
                  <Switch
                    checked={activeIndications.active}
                    onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, active: checked })}
                  />
                </div>
                <div className="flex items-center justify-between p-2 bg-muted rounded">
                  <span className="text-sm">Active (Advanced)</span>
                  <Badge variant="default" className="text-xs ml-2">
                    NEW
                  </Badge>
                  <Switch
                    checked={activeIndications.active_advanced}
                    onCheckedChange={(checked) =>
                      setActiveIndications({ ...activeIndications, active_advanced: checked })
                    }
                  />
                </div>
                <div className="flex items-center justify-between p-2 bg-muted rounded">
                  <span className="text-sm">Optimal</span>
                  <Switch
                    checked={activeIndications.optimal}
                    onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, optimal: checked })}
                  />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Active (Advanced) uses optimal market change calculations for frequently and short time trades (1-40min)
              </p>
            </div>

            {/* Additional Category - Trailing */}
            <div className="space-y-3">
              <div className="p-3 border-l-4 border-purple-500 bg-purple-500/5 rounded-r">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium text-purple-700 dark:text-purple-300">
                    Additional (Enhancement)
                  </span>
                </div>
                <div className="flex items-center justify-between p-2 bg-background rounded">
                  <span className="text-sm">Trailing Stop</span>
                  <Switch
                    checked={strategyConfig.trailing}
                    onCheckedChange={(checked) => setStrategyConfig({ ...strategyConfig, trailing: checked })}
                  />
                </div>
              </div>
            </div>

            {/* Adjust Category - Block & DCA */}
            <div className="space-y-3">
              <div className="p-3 border-l-4 border-blue-500 bg-blue-500/5 rounded-r">
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-sm font-medium text-blue-700 dark:text-blue-300">Adjust (Volume/Position)</span>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between p-2 bg-background rounded">
                    <span className="text-sm">Block Trading</span>
                    <Switch
                      checked={strategyConfig.block}
                      onCheckedChange={(checked) => setStrategyConfig({ ...strategyConfig, block: checked })}
                    />
                  </div>
                  <div className="flex items-center justify-between p-2 bg-background rounded">
                    <span className="text-sm">DCA (Dollar Cost Averaging)</span>
                    <Switch
                      checked={strategyConfig.dca}
                      onCheckedChange={(checked) => setStrategyConfig({ ...strategyConfig, dca: checked })}
                    />
                  </div>
                </div>
              </div>
            </div>

            <Button
              className="w-full"
              onClick={() => {
                saveActiveIndications()
                setShowStrategyDialog(false)
              }}
            >
              Save Configuration
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={showActivateTradeDialog} onOpenChange={setShowActivateTradeDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">Activate Live Trade</DialogTitle>
            <DialogDescription>Select which main indications should be active for live trading</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <span className="text-sm">Direction</span>
                <Switch
                  checked={activeIndications.direction}
                  onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, direction: checked })}
                />
              </div>
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <span className="text-sm">Move</span>
                <Switch
                  checked={activeIndications.move}
                  onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, move: checked })}
                />
              </div>
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <span className="text-sm">Active (Fast Change)</span>
                <Switch
                  checked={activeIndications.active}
                  onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, active: checked })}
                />
              </div>
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <div className="flex items-center gap-2">
                  <span className="text-sm">Active (Advanced)</span>
                  <Badge variant="default" className="text-xs">
                    NEW
                  </Badge>
                </div>
                <Switch
                  checked={activeIndications.active_advanced}
                  onCheckedChange={(checked) =>
                    setActiveIndications({ ...activeIndications, active_advanced: checked })
                  }
                />
              </div>
              <div className="flex items-center justify-between p-2 bg-muted rounded">
                <span className="text-sm">Optimal</span>
                <Switch
                  checked={activeIndications.optimal}
                  onCheckedChange={(checked) => setActiveIndications({ ...activeIndications, optimal: checked })}
                />
              </div>
            </div>

            <div className="p-3 bg-blue-50 dark:bg-blue-950/20 rounded-lg border border-blue-200 dark:border-blue-800">
              <div className="text-xs font-medium text-blue-900 dark:text-blue-100 mb-1">Active Indications:</div>
              <div className="text-xs text-blue-700 dark:text-blue-300">
                {Object.entries(activeIndications)
                  .filter(([_, enabled]) => enabled)
                  .map(([type, _]) => type.replace("_", " ").toUpperCase())
                  .join(", ") || "None selected"}
              </div>
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                className="flex-1 bg-transparent"
                onClick={() => setShowActivateTradeDialog(false)}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={confirmLiveTradeActivation}
                disabled={!Object.values(activeIndications).some((v) => v)}
              >
                Activate Live Trade
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Connection State Tabs Dialog */}
      <Dialog open={showLogs} onOpenChange={setShowLogs}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Active Connection - {connection.name}</DialogTitle>
            <DialogDescription>
              Monitor connection state, performance, and real-time activity for this actively used trading connection
            </DialogDescription>
          </DialogHeader>
          
          <ConnectionStateTabs connection={connection} status={status} progress={progress} />
          
          <div className="flex justify-end pt-4 border-t">
            <Button variant="outline" onClick={() => setShowLogs(false)}>
              Close
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <div className={`absolute bottom-0 left-0 right-0 h-1 ${getStatusColor()}`} />
    </Card>
  )
}
