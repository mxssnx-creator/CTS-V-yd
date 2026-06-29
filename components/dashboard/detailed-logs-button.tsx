"use client"

import { useMemo, useRef, useState } from "react"
import { AlertTriangle, ArrowUp, FileText, RefreshCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"

type DetailedLog = {
  id: string
  timestamp: string
  type: string
  phase: string
  message: string
  connectionId?: string
  symbol?: string
  details?: Record<string, unknown>
}

const FILTERS = ["all", "error", "live", "audit", "strategy", "engine", "indication", "position"] as const

export function DetailedLogsButton() {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState<DetailedLog[]>([])
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("error")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const visibleLogs = useMemo(() => {
    return filter === "all" ? logs : logs.filter((log) => log.type === filter || log.phase?.includes(filter))
  }, [filter, logs])

  const loadLogs = async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await fetch("/api/trade-engine/detailed-logs", { cache: "no-store" })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      setLogs(Array.isArray(data.logs) ? data.logs : [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next && logs.length === 0) void loadLogs()
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <FileText className="h-4 w-4" />
          Detailed Logs
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-5xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-amber-500" />
            Detailed Engine Logs
          </DialogTitle>
          <DialogDescription>
            Scrollable production diagnostics for engine, strategy, live-order, control-order, and error sections.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap gap-2">
            {FILTERS.map((item) => (
              <Button
                key={item}
                variant={filter === item ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(item)}
                className="capitalize"
              >
                {item}
              </Button>
            ))}
          </div>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => scrollContainerRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
            >
              <ArrowUp className="h-4 w-4" />
              Top
            </Button>
            <Button variant="outline" size="sm" onClick={loadLogs} disabled={loading}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            Failed to load logs: {error}
          </div>
        )}

        <ScrollArea className="h-[65vh] rounded-md border bg-muted/20" viewportRef={scrollContainerRef}>
          <div className="space-y-2 p-3">
            {visibleLogs.length === 0 ? (
              <p className="py-10 text-center text-sm text-muted-foreground">
                {loading ? "Loading detailed logs…" : "No logs for this section."}
              </p>
            ) : (
              visibleLogs.map((log) => (
                <div key={log.id} className="rounded-lg border bg-background p-3 text-sm shadow-sm">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <Badge variant={log.type === "error" ? "destructive" : "secondary"}>{log.type}</Badge>
                    <span>{new Date(log.timestamp).toLocaleString()}</span>
                    {log.connectionId && <span>conn={log.connectionId}</span>}
                    {log.symbol && <span>symbol={log.symbol}</span>}
                    <span>phase={log.phase}</span>
                  </div>
                  <p className="mt-2 font-medium">{log.message}</p>
                  {log.details && Object.keys(log.details).length > 0 && (
                    <pre className="mt-2 max-h-40 overflow-auto rounded bg-muted p-2 text-xs">
                      {JSON.stringify(log.details, null, 2)}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
