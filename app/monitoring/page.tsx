"use client"
export const dynamic = "force-dynamic"


import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Input } from "@/components/ui/input"
import {
  Download,
  AlertCircle,
  CheckCircle,
  XCircle,
  Clock,
  Activity,
  Globe,
  RefreshCw,
  MessageSquare,
} from "lucide-react"
import type { JSX } from "react/jsx-runtime"
import { useExchange } from "@/lib/exchange-context"
import { TradeEngineStatus } from "@/components/monitoring/trade-engine-status"
import { MonitoringAlerts } from "@/components/monitoring/monitoring-alerts"
import { BackupManager } from "@/components/monitoring/backup-manager"
import { EmergencyStopButton } from "@/components/emergency-stop-button"
import { SystemVerificationPanel } from "@/components/system/system-verification-panel"
import { PageHeader } from "@/components/page-header"
import { PnLDashboard } from "@/components/pnl-dashboard"

type LogLevel = "info" | "warning" | "error" | "debug"
type SystemState = "active" | "inactive" | "error" | "warning"

interface LogEntry {
  id: string
  timestamp: Date
  level: LogLevel
  category: string
  message: string
  details?: string
}

interface SystemStatus {
  name: string
  status: SystemState
  lastUpdate: Date
  details: string
}

export default function MonitoringPage() {
  const { selectedConnectionId, activeConnections } = useExchange()
  const [logs, setLogs] = useState<LogEntry[]>([])
  const [systemStates, setSystemStates] = useState<SystemStatus[]>([])
  const [logFilter, setLogFilter] = useState<LogLevel | "all">("all")
  const [searchQuery, setSearchQuery] = useState("")
  const [siteLogs, setSiteLogs] = useState<LogEntry[]>([])
  const [siteLogFilter, setSiteLogFilter] = useState<LogLevel | "all">("all")
  const [siteSearchQuery, setSiteSearchQuery] = useState("")
  const [toastLogs, setToastLogs] = useState<LogEntry[]>([])
  const [toastFilter, setToastFilter] = useState<"all" | "success" | "error" | "info" | "warning">("all")
  const [toastSearchQuery, setToastSearchQuery] = useState("")
  const [isLoadingToasts, setIsLoadingToasts] = useState(false)
  const [isLoadingLogs, setIsLoadingLogs] = useState(false)
  const [isLoadingSiteLogs, setIsLoadingSiteLogs] = useState(false)
  const [isLoadingSystem, setIsLoadingSystem] = useState(false)

  const loadSystemStates = async () => {
    setIsLoadingSystem(true)
    try {
      // Include connection ID in monitoring request for scoped data
      const connectionParam = selectedConnectionId ? `?connectionId=${selectedConnectionId}` : ""
      const response = await fetch(`/api/monitoring/system${connectionParam}`)
      if (response.ok) {
        const data = await response.json()
        const states: SystemStatus[] = [
          {
            name: "Exchange Connections",
            status: data.states.connections.active > 0 ? "active" : "inactive",
            lastUpdate: new Date(),
            details: `${data.states.connections.active}/${data.states.connections.total} active, ${data.states.connections.liveTrade} live trading`,
          },
          {
            name: "Database",
            status: data.states.database.status === "connected" ? "active" : "error",
            lastUpdate: new Date(),
            details: `Status: ${data.states.database.status}`,
          },
          {
            name: "Trading Engine",
            status: data.states.trading.status === "active" ? "active" : "inactive",
            lastUpdate: new Date(),
            details: `${data.states.trading.realPositions} real positions, ${data.states.trading.pseudoPositions} pseudo positions`,
          },
          {
            name: "Strategy Processor",
            status: data.states.strategy.status === "running" ? "active" : "inactive",
            lastUpdate: new Date(data.states.strategy.lastUpdate),
            details: `Status: ${data.states.strategy.status}`,
          },
          {
            name: "Error Monitor",
            status:
              data.states.errors.status === "healthy"
                ? "active"
                : data.states.errors.status === "warning"
                  ? "warning"
                  : "error",
            lastUpdate: new Date(),
            details: `${data.states.errors.count} recent errors`,
          },
        ]
        setSystemStates(states)
      }
    } catch (error) {
      console.error("[v0] Failed to load system states:", error)
    } finally {
      setIsLoadingSystem(false)
    }
  }

  const loadLogs = async () => {
    setIsLoadingLogs(true)
    try {
      const response = await fetch("/api/monitoring/logs?limit=100")
      if (response.ok) {
        const data = await response.json()
        setLogs(
          data.logs.map((log: any) => ({
            id: log.id.toString(),
            timestamp: new Date(log.timestamp),
            level: log.level as LogLevel,
            category: log.category || "System",
            message: log.message,
            details: log.details || log.metadata,
          })),
        )
      }
    } catch (error) {
      console.error("[v0] Failed to load logs:", error)
    } finally {
      setIsLoadingLogs(false)
    }
  }

  const loadSiteLogs = async () => {
    setIsLoadingSiteLogs(true)
    try {
      const response = await fetch("/api/monitoring/site?limit=100")
      if (response.ok) {
        const data = await response.json()
        setSiteLogs(
          data.map((log: any) => ({
            id: log.id.toString(),
            timestamp: new Date(log.timestamp),
            level: log.level as LogLevel,
            category: log.category || "Site",
            message: log.message,
            details: log.details || log.stack,
          })),
        )
      }
    } catch (error) {
      console.error("[v0] Failed to load site logs:", error)
    } finally {
      setIsLoadingSiteLogs(false)
    }
  }

  const loadToastLogs = async () => {
    setIsLoadingToasts(true)
    try {
      const response = await fetch("/api/monitoring/site?limit=100&category=toast")
      if (response.ok) {
        const data = await response.json()
        setToastLogs(
          data.map((log: any) => ({
            id: log.id.toString(),
            timestamp: new Date(log.timestamp),
            level: log.level as LogLevel,
            category: log.category || "toast",
            message: log.message,
            details: log.metadata ? JSON.parse(log.metadata).toastType : undefined,
          })),
        )
      }
    } catch (error) {
      console.error("[v0] Failed to load toast logs:", error)
    } finally {
      setIsLoadingToasts(false)
    }
  }

  useEffect(() => {
    loadSystemStates()
    loadLogs()
    loadSiteLogs()
    loadToastLogs()

    const interval = setInterval(() => {
      loadSystemStates()
      loadLogs()
      loadSiteLogs()
      loadToastLogs()
    }, 30000)

    return () => clearInterval(interval)
  }, [])

  const filteredLogs = logs.filter((log) => {
    const matchesLevel = logFilter === "all" || log.level === logFilter
    const matchesSearch =
      searchQuery === "" ||
      log.message.toLowerCase().includes(searchQuery.toLowerCase()) ||
      log.category.toLowerCase().includes(searchQuery.toLowerCase())
    return matchesLevel && matchesSearch
  })

  const filteredSiteLogs = siteLogs.filter((log) => {
    const matchesLevel = siteLogFilter === "all" || log.level === siteLogFilter
    const matchesSearch =
      siteSearchQuery === "" ||
      log.message.toLowerCase().includes(siteSearchQuery.toLowerCase()) ||
      log.category.toLowerCase().includes(siteSearchQuery.toLowerCase())
    return matchesLevel && matchesSearch
  })

  const filteredToastLogs = toastLogs.filter((log) => {
    const matchesType = toastFilter === "all" || log.details === toastFilter
    const matchesSearch = toastSearchQuery === "" || log.message.toLowerCase().includes(toastSearchQuery.toLowerCase())
    return matchesType && matchesSearch
  })

  const getStatusIcon = (status: SystemState) => {
    switch (status) {
      case "active":
        return <CheckCircle className="h-5 w-5 text-green-500" />
      case "warning":
        return <AlertCircle className="h-5 w-5 text-yellow-500" />
      case "error":
        return <XCircle className="h-5 w-5 text-red-500" />
      default:
        return <Clock className="h-5 w-5 text-muted-foreground" />
    }
  }

  const getLogLevelBadge = (level: LogLevel) => {
    const variants: Record<
      LogLevel,
      { variant: "default" | "secondary" | "destructive" | "outline"; className: string }
    > = {
      info: { variant: "default", className: "bg-blue-500/10 text-blue-500 border-blue-500/20" },
      warning: { variant: "secondary", className: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20" },
      error: { variant: "destructive", className: "bg-red-500/10 text-red-500 border-red-500/20" },
      debug: { variant: "outline", className: "bg-muted text-muted-foreground" },
    }
    return (
      <Badge variant={variants[level].variant} className={variants[level].className}>
        {level.toUpperCase()}
      </Badge>
    )
  }

  const getToastTypeBadge = (type: string) => {
    const variants: Record<string, { className: string; icon: JSX.Element }> = {
      success: {
        className: "bg-green-500/10 text-green-500 border-green-500/20",
        icon: <CheckCircle className="h-3 w-3" />,
      },
      error: { className: "bg-red-500/10 text-red-500 border-red-500/20", icon: <XCircle className="h-3 w-3" /> },
      warning: {
        className: "bg-yellow-500/10 text-yellow-500 border-yellow-500/20",
        icon: <AlertCircle className="h-3 w-3" />,
      },
      info: {
        className: "bg-blue-500/10 text-blue-500 border-blue-500/20",
        icon: <MessageSquare className="h-3 w-3" />,
      },
    }
    const variant = variants[type] || variants.info
    return (
      <Badge variant="outline" className={variant.className}>
        {variant.icon}
        <span className="ml-1">{type.toUpperCase()}</span>
      </Badge>
    )
  }

  const downloadLogs = (type: string) => {
    let content = ""
    let filename = ""

    switch (type) {
      case "all":
        content = JSON.stringify(logs, null, 2)
        filename = `logs-all-${new Date().toISOString()}.json`
        break
      case "site":
        content = JSON.stringify(siteLogs, null, 2)
        filename = `site-logs-${new Date().toISOString()}.json`
        break
      case "site-local":
        // Download logs from localStorage
        const storedLogs = localStorage.getItem("site_logs")
        content = storedLogs || "[]"
        filename = `site-logs-local-${new Date().toISOString()}.json`
        break
      case "site-errors":
        const siteErrors = siteLogs.filter((log) => log.level === "error")
        content = JSON.stringify(siteErrors, null, 2)
        filename = `site-errors-${new Date().toISOString()}.json`
        break
      case "csv":
        content = [
          "Timestamp,Level,Category,Message,Details",
          ...logs.map(
            (log) =>
              `${log.timestamp.toISOString()},${log.level},${log.category},"${log.message}","${log.details || ""}"`,
          ),
        ].join("\n")
        filename = `logs-${new Date().toISOString()}.csv`
        break
      case "site-csv":
        content = [
          "Timestamp,Level,Category,Message,Details",
          ...siteLogs.map(
            (log) =>
              `${log.timestamp.toISOString()},${log.level},${log.category},"${log.message}","${log.details || ""}"`,
          ),
        ].join("\n")
        filename = `site-logs-${new Date().toISOString()}.csv`
        break
      case "toasts":
        content = JSON.stringify(toastLogs, null, 2)
        filename = `toasts-${new Date().toISOString()}.json`
        break
    }

    const blob = new Blob([content], { type: type.includes("csv") ? "text/csv" : "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  const anyLoading = isLoadingLogs || isLoadingSiteLogs || isLoadingSystem || isLoadingToasts

  return (
    <div className="p-4 space-y-4">
      {/*
        Swapped the bespoke `container mx-auto p-6` + `<h1>` pair for the
        shared `PageHeader` pattern so the Monitoring page matches the rest
        of the sidebar vertically. Action buttons shrunk to `size="sm"` to
        match the new toolbar density.
      */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <PageHeader
          title="System Monitoring"
          description="Real-time system states, logs, and error tracking"
        />
        <div className="flex gap-2">
          <EmergencyStopButton />
          <Button
            variant="outline"
            size="sm"
            className="h-8 text-xs"
            onClick={() => {
              loadSystemStates()
              loadLogs()
              loadSiteLogs()
              loadToastLogs()
            }}
            disabled={anyLoading}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${anyLoading ? "animate-spin" : ""}`} />
            Refresh All
          </Button>
          <Button variant="outline" size="sm" className="h-8 text-xs" onClick={() => downloadLogs("all")}>
            <Download className="h-3 w-3 mr-1" />
            Export Logs
          </Button>
        </div>
      </div>

      <Tabs defaultValue="pnl" className="space-y-4">
        <TabsList className="grid w-full grid-cols-9">
          <TabsTrigger value="pnl">PnL & Performance</TabsTrigger>
          <TabsTrigger value="verification">System Verification</TabsTrigger>
          <TabsTrigger value="states">System States</TabsTrigger>
          <TabsTrigger value="alerts">Alerts</TabsTrigger>
          <TabsTrigger value="backup">Backup</TabsTrigger>
          <TabsTrigger value="trade-engines">Trade Engines</TabsTrigger>
          <TabsTrigger value="site">Site Logs</TabsTrigger>
          <TabsTrigger value="toasts">Toast Messages</TabsTrigger>
          <TabsTrigger value="export">Export</TabsTrigger>
        </TabsList>

        <TabsContent value="pnl" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Real-Time PnL & Performance Tracking</CardTitle>
              <CardDescription>Live profit/loss metrics, win rates, and last 25 executed positions</CardDescription>
            </CardHeader>
            <CardContent>
              <PnLDashboard connectionId={selectedConnectionId || "bingx-x01"} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="verification" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Engine Process Verification</CardTitle>
              <CardDescription>Monitor all phases: prehistoric data, indications, strategies, realtime, live trading</CardDescription>
            </CardHeader>
            <CardContent>
              <SystemVerificationPanel />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="states" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {systemStates.map((state) => (
              <Card key={state.name}>
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">{state.name}</CardTitle>
                    {getStatusIcon(state.status)}
                  </div>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex items-center justify-between text-sm">
                    <span className="text-muted-foreground">Status:</span>
                    <Badge
                      variant={
                        state.status === "active" ? "default" : state.status === "warning" ? "secondary" : "destructive"
                      }
                    >
                      {state.status}
                    </Badge>
                  </div>
                  <div className="text-sm text-muted-foreground">{state.details}</div>
                  <div className="text-xs text-muted-foreground">
                    Last update: {state.lastUpdate.toLocaleTimeString()}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>System Overview</CardTitle>
              <CardDescription>Aggregate system health metrics</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Activity className="h-4 w-4 text-green-500" />
                    <span className="text-sm font-medium">Active Services</span>
                  </div>
                  <div className="text-2xl font-bold">
                    {systemStates.filter((s) => s.status === "active").length}/{systemStates.length}
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <AlertCircle className="h-4 w-4 text-yellow-500" />
                    <span className="text-sm font-medium">Warnings</span>
                  </div>
                  <div className="text-2xl font-bold">{systemStates.filter((s) => s.status === "warning").length}</div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <XCircle className="h-4 w-4 text-red-500" />
                    <span className="text-sm font-medium">Errors</span>
                  </div>
                  <div className="text-2xl font-bold">{siteLogs.filter((log) => log.level === "error").length}</div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Globe className="h-4 w-4 text-blue-500" />
                    <span className="text-sm font-medium">Total Logs</span>
                  </div>
                  <div className="text-2xl font-bold">{logs.length + siteLogs.length}</div>
                </div>
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <MessageSquare className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium">Toast Messages</span>
                  </div>
                  <div className="text-2xl font-bold">{toastLogs.length}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="alerts" className="space-y-4">
          <MonitoringAlerts />
        </TabsContent>

        <TabsContent value="backup" className="space-y-4">
          <BackupManager />
        </TabsContent>

        <TabsContent value="trade-engines" className="space-y-4">
          <TradeEngineStatus />
        </TabsContent>

        <TabsContent value="site" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Globe className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle>Site Application Logs</CardTitle>
                    <CardDescription>Internal application logging and error tracking</CardDescription>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={loadSiteLogs} disabled={isLoadingSiteLogs}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingSiteLogs ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => downloadLogs("site")}>
                    <Download className="h-4 w-4 mr-2" />
                    Download JSON
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => downloadLogs("site-csv")}>
                    <Download className="h-4 w-4 mr-2" />
                    Download CSV
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex gap-2">
                <Select value={siteLogFilter} onValueChange={(value) => setSiteLogFilter(value as LogLevel | "all")}>
                  <SelectTrigger className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All Levels</SelectItem>
                    <SelectItem value="info">Info</SelectItem>
                    <SelectItem value="warning">Warning</SelectItem>
                    <SelectItem value="error">Error</SelectItem>
                    <SelectItem value="debug">Debug</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Search site logs..."
                  value={siteSearchQuery}
                  onChange={(e) => setSiteSearchQuery(e.target.value)}
                  className="flex-1"
                />
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{siteLogs.length}</div>
                    <p className="text-xs text-muted-foreground">Total Logs</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-red-500">
                      {siteLogs.filter((log) => log.level === "error").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Errors</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-yellow-500">
                      {siteLogs.filter((log) => log.level === "warning").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Warnings</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-blue-500">
                      {siteLogs.filter((log) => log.level === "info").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Info</p>
                  </CardContent>
                </Card>
              </div>

              <ScrollArea className="h-[500px] pr-4">
                {isLoadingSiteLogs ? (
                  <div className="flex items-center justify-center h-32">
                    <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredSiteLogs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                    <Globe className="h-8 w-8 mb-2" />
                    <p>No site logs found</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredSiteLogs.map((log) => (
                      <div key={log.id} className="border rounded-lg p-4 space-y-2 hover:bg-muted/50 transition-colors">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            {getLogLevelBadge(log.level)}
                            <Badge variant="outline">{log.category}</Badge>
                            <span className="text-sm text-muted-foreground">{log.timestamp.toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="font-medium">{log.message}</div>
                        {log.details && (
                          <details className="text-sm">
                            <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                              Details
                            </summary>
                            <pre className="mt-2 p-3 bg-muted rounded text-xs overflow-x-auto whitespace-pre-wrap">
                              {log.details}
                            </pre>
                          </details>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="toasts" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <MessageSquare className="h-5 w-5 text-primary" />
                  <div>
                    <CardTitle>Toast Messages</CardTitle>
                    <CardDescription>User notifications and toast message tracking</CardDescription>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={loadToastLogs} disabled={isLoadingToasts}>
                    <RefreshCw className={`h-4 w-4 mr-2 ${isLoadingToasts ? "animate-spin" : ""}`} />
                    Refresh
                  </Button>
                  <Select value={toastFilter} onValueChange={(value) => setToastFilter(value as typeof toastFilter)}>
                    <SelectTrigger className="w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">All Types</SelectItem>
                      <SelectItem value="success">Success</SelectItem>
                      <SelectItem value="error">Error</SelectItem>
                      <SelectItem value="warning">Warning</SelectItem>
                      <SelectItem value="info">Info</SelectItem>
                    </SelectContent>
                  </Select>
                  <Input
                    placeholder="Search toast messages..."
                    value={toastSearchQuery}
                    onChange={(e) => setToastSearchQuery(e.target.value)}
                    className="w-64"
                  />
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold">{toastLogs.length}</div>
                    <p className="text-xs text-muted-foreground">Total Toasts</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-green-500">
                      {toastLogs.filter((log) => log.details === "success").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Success</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-red-500">
                      {toastLogs.filter((log) => log.details === "error").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Errors</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-yellow-500">
                      {toastLogs.filter((log) => log.details === "warning").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Warnings</p>
                  </CardContent>
                </Card>
                <Card>
                  <CardContent className="pt-6">
                    <div className="text-2xl font-bold text-blue-500">
                      {toastLogs.filter((log) => log.details === "info").length}
                    </div>
                    <p className="text-xs text-muted-foreground">Info</p>
                  </CardContent>
                </Card>
              </div>

              <ScrollArea className="h-[500px] pr-4">
                {isLoadingToasts ? (
                  <div className="flex items-center justify-center h-32">
                    <RefreshCw className="h-6 w-6 animate-spin text-muted-foreground" />
                  </div>
                ) : filteredToastLogs.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-32 text-muted-foreground">
                    <MessageSquare className="h-8 w-8 mb-2" />
                    <p>No toast messages found</p>
                    <p className="text-sm">Toast notifications will appear here when triggered</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {filteredToastLogs.map((log) => (
                      <div key={log.id} className="border rounded-lg p-4 space-y-2 hover:bg-muted/50 transition-colors">
                        <div className="flex items-start justify-between">
                          <div className="flex items-center gap-3">
                            {getToastTypeBadge(log.details || "info")}
                            <span className="text-sm text-muted-foreground">{log.timestamp.toLocaleString()}</span>
                          </div>
                        </div>
                        <div className="font-medium">{log.message}</div>
                      </div>
                    ))}
                  </div>
                )}
              </ScrollArea>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="export" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Export Diagnostics</CardTitle>
              <CardDescription>Download logs and system data for diagnostics</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Site Logs (JSON)</CardTitle>
                    <CardDescription>Application logs in JSON format</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button onClick={() => downloadLogs("site")} className="w-full">
                      <Download className="h-4 w-4 mr-2" />
                      Download Site Logs
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Site Logs (CSV)</CardTitle>
                    <CardDescription>Application logs in CSV format</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button onClick={() => downloadLogs("site-csv")} className="w-full">
                      <Download className="h-4 w-4 mr-2" />
                      Download CSV
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Site Errors Only</CardTitle>
                    <CardDescription>All site error entries with details</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button onClick={() => downloadLogs("site-errors")} className="w-full" variant="destructive">
                      <Download className="h-4 w-4 mr-2" />
                      Download Site Errors
                    </Button>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">Toast Messages</CardTitle>
                    <CardDescription>User notification history</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <Button onClick={() => downloadLogs("toasts")} className="w-full">
                      <Download className="h-4 w-4 mr-2" />
                      Download Toasts
                    </Button>
                  </CardContent>
                </Card>
              </div>

              <Card className="bg-muted/50">
                <CardHeader>
                  <CardTitle className="text-base">Diagnostic Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Site Logs:</span>
                    <span className="font-medium">{siteLogs.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Total Errors:</span>
                    <span className="font-medium text-red-500">
                      {siteLogs.filter((log) => log.level === "error").length}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Active Services:</span>
                    <span className="font-medium text-green-500">
                      {systemStates.filter((s) => s.status === "active").length}/{systemStates.length}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">Toast Messages:</span>
                    <span className="font-medium">{toastLogs.length}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-primary/20">
                <CardHeader>
                  <CardTitle className="text-base flex items-center gap-2">
                    <Download className="h-4 w-4" />
                    Local Site Logs
                  </CardTitle>
                  <CardDescription>Download logs stored locally in your browser</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Site logs are now stored locally in your browser and can be downloaded anytime. This prevents network overhead and improves performance.
                  </p>
                  <Button onClick={() => downloadLogs("site-local")} className="w-full">
                    <Download className="h-4 w-4 mr-2" />
                    Download Local Site Logs
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    Stores up to 1000 most recent logs. Logs include navigation, errors, performance metrics, and user interactions.
                  </p>
                </CardContent>
              </Card>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  )
}
