"use client"

import { useState, useEffect } from "react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, Info, TrendingUp, AlertCircle } from "lucide-react"
import { toast } from "@/lib/simple-toast"
import type { PresetType } from "@/lib/types-preset-coordination"

interface BaseSettings {
  trailingEnabled: boolean
  blockEnabled: boolean
  dcaEnabled: boolean
}

interface IndicatorSettings {
  // RSI
  rsiEnabled: boolean
  rsiPeriodFrom: number
  rsiPeriodTo: number
  rsiPeriodStep: number
  rsiOverboughtFrom: number
  rsiOverboughtTo: number
  rsiOverboughtStep: number
  rsiOversoldFrom: number
  rsiOversoldTo: number
  rsiOversoldStep: number

  // MACD
  macdEnabled: boolean
  macdFastFrom: number
  macdFastTo: number
  macdFastStep: number
  macdSlowFrom: number
  macdSlowTo: number
  macdSlowStep: number
  macdSignalFrom: number
  macdSignalTo: number
  macdSignalStep: number

  // EMA
  emaEnabled: boolean
  emaPeriodFrom: number
  emaPeriodTo: number
  emaPeriodStep: number
}

interface CreateConfigurationSetDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
  presetTypes: PresetType[]
}

export function CreateConfigurationSetDialog({
  open,
  onOpenChange,
  onSuccess,
  presetTypes,
}: CreateConfigurationSetDialogProps) {
  const [isLoading, setIsLoading] = useState(false)
  const [isFetchingSettings, setIsFetchingSettings] = useState(false)
  const [indicatorSettings, setIndicatorSettings] = useState<IndicatorSettings | null>(null)

  const [name, setName] = useState("")
  const [description, setDescription] = useState("")
  const [selectedIndicator, setSelectedIndicator] = useState<string>("")

  // Dynamic parameter ranges (initialized from common settings)
  const [paramRanges, setParamRanges] = useState<Record<string, { from: number; to: number; step: number }>>({})

  // Position configuration ranges
  const [takeProfitFrom, setTakeProfitFrom] = useState(2)
  const [takeProfitTo, setTakeProfitTo] = useState(12)
  const [takeProfitStep, setTakeProfitStep] = useState(2)
  const [stopLossFrom, setStopLossFrom] = useState(0.2)
  const [stopLossTo, setStopLossTo] = useState(1.5)
  const [stopLossStep, setStopLossStep] = useState(0.2)

  // Trailing configuration
  const [trailingEnabled, setTrailingEnabled] = useState(true)

  // Block and DCA configuration
  const [blockEnabled, setBlockEnabled] = useState(false)
  const [dcaEnabled, setDcaEnabled] = useState(false)

  // Base settings state
  const [baseSettings, setBaseSettings] = useState<BaseSettings>({
    trailingEnabled: true,
    blockEnabled: true,
    dcaEnabled: false,
  })

  // Evaluation settings
  const [rangeDays, setRangeDays] = useState(7)
  const [tradesPerDay, setTradesPerDay] = useState(5)
  const [minProfitFactor, setMinProfitFactor] = useState(1.5)
  const [maxDrawdownHours, setMaxDrawdownHours] = useState(12)

  useEffect(() => {
    if (open) {
      fetchCommonIndicatorSettings()
      fetchBaseSettings()
    }
  }, [open])

  useEffect(() => {
    if (selectedIndicator && indicatorSettings) {
      initializeParamRanges()
    }
  }, [selectedIndicator, indicatorSettings])

  const fetchCommonIndicatorSettings = async () => {
    try {
      setIsFetchingSettings(true)
      const response = await fetch("/api/settings")
      if (!response.ok) throw new Error("Failed to fetch settings")

      const data = await response.json()
      setIndicatorSettings(data.settings)
    } catch (error) {
      console.error("[v0] Failed to fetch indicator settings:", error)
      toast.error("Failed to load indicator settings")
    } finally {
      setIsFetchingSettings(false)
    }
  }

  const fetchBaseSettings = async () => {
    try {
      const response = await fetch("/api/settings")
      if (response.ok) {
        const settings = await response.json()
        setBaseSettings({
          trailingEnabled: settings.trailingEnabled !== false,
          blockEnabled: settings.blockEnabled !== false,
          dcaEnabled: settings.dcaEnabled === true,
        })
      }
    } catch (error) {
      console.error("[v0] Failed to fetch base settings:", error)
    }
  }

  const initializeParamRanges = () => {
    if (!indicatorSettings) return

    const ranges: Record<string, { from: number; to: number; step: number }> = {}

    if (selectedIndicator === "rsi") {
      ranges.period = {
        from: indicatorSettings.rsiPeriodFrom,
        to: indicatorSettings.rsiPeriodTo,
        step: indicatorSettings.rsiPeriodStep,
      }
      ranges.overbought = {
        from: indicatorSettings.rsiOverboughtFrom,
        to: indicatorSettings.rsiOverboughtTo,
        step: indicatorSettings.rsiOverboughtStep,
      }
      ranges.oversold = {
        from: indicatorSettings.rsiOversoldFrom,
        to: indicatorSettings.rsiOversoldTo,
        step: indicatorSettings.rsiOversoldStep,
      }
    } else if (selectedIndicator === "macd") {
      ranges.fast = {
        from: indicatorSettings.macdFastFrom,
        to: indicatorSettings.macdFastTo,
        step: indicatorSettings.macdFastStep,
      }
      ranges.slow = {
        from: indicatorSettings.macdSlowFrom,
        to: indicatorSettings.macdSlowTo,
        step: indicatorSettings.macdSlowStep,
      }
      ranges.signal = {
        from: indicatorSettings.macdSignalFrom,
        to: indicatorSettings.macdSignalTo,
        step: indicatorSettings.macdSignalStep,
      }
    } else if (selectedIndicator === "ema") {
      ranges.period = {
        from: indicatorSettings.emaPeriodFrom,
        to: indicatorSettings.emaPeriodTo,
        step: indicatorSettings.emaPeriodStep,
      }
    }

    setParamRanges(ranges)
  }

  const calculateVariations = () => {
    let total = 1

    // Indicator parameter variations
    Object.values(paramRanges).forEach((range) => {
      const count = Math.floor((range.to - range.from) / range.step) + 1
      total *= count
    })

    // Position configuration variations
    const tpCount = Math.floor((takeProfitTo - takeProfitFrom) / takeProfitStep) + 1
    const slCount = Math.floor((stopLossTo - stopLossFrom) / stopLossStep) + 1

    total *= tpCount * slCount

    if (trailingEnabled && baseSettings.trailingEnabled) {
      total *= 3 // trail start variations
      total *= 3 // trail stop variations
    }

    return total
  }

  const handleUpdateRange = (param: string, field: "from" | "to" | "step", value: number) => {
    setParamRanges((prev) => ({
      ...prev,
      [param]: {
        ...prev[param],
        [field]: value,
      },
    }))
  }

  const handleSubmit = async () => {
    if (!name || !selectedIndicator) {
      toast.error("Please fill in all required fields")
      return
    }

    try {
      setIsLoading(true)

      const configSet = {
        name,
        description,
        symbol_mode: "main" as const,
        indication_type: selectedIndicator,
        indication_params: paramRanges,
        takeprofit_min: takeProfitFrom,
        takeprofit_max: takeProfitTo,
        takeprofit_step: takeProfitStep,
        stoploss_min: stopLossFrom,
        stoploss_max: stopLossTo,
        stoploss_step: stopLossStep,
        trailing_enabled: trailingEnabled && baseSettings.trailingEnabled,
        block_enabled: blockEnabled && baseSettings.blockEnabled,
        dca_enabled: dcaEnabled && baseSettings.dcaEnabled,
        range_days: rangeDays,
        trades_per_48h_min: tradesPerDay,
        profit_factor_min: minProfitFactor,
        drawdown_time_max: maxDrawdownHours,
        evaluation_positions_count1: 25,
        evaluation_positions_count2: 75,
        database_positions_per_set: 250,
        database_threshold_percent: 20,
        is_active: true,
      }

      const response = await fetch("/api/preset-config-sets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(configSet),
      })

      if (!response.ok) throw new Error("Failed to create configuration set")

      toast.success("Configuration set created successfully")
      onSuccess()
      onOpenChange(false)
      resetForm()
    } catch (error) {
      console.error("[v0] Failed to create configuration set:", error)
      toast.error("Failed to create configuration set")
    } finally {
      setIsLoading(false)
    }
  }

  const resetForm = () => {
    setName("")
    setDescription("")
    setSelectedIndicator("")
    setParamRanges({})
    setTakeProfitFrom(2)
    setTakeProfitTo(12)
    setTakeProfitStep(2)
    setStopLossFrom(0.2)
    setStopLossTo(1.5)
    setStopLossStep(0.2)
    setTrailingEnabled(true)
    setBlockEnabled(false)
    setDcaEnabled(false)
    setRangeDays(7)
    setTradesPerDay(5)
    setMinProfitFactor(1.5)
    setMaxDrawdownHours(12)
  }

  const totalVariations = calculateVariations()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Create Configuration Set</DialogTitle>
          <DialogDescription>
            Configure indicator parameters and ranges for backtesting. All possible combinations will be tested.
          </DialogDescription>
        </DialogHeader>

        {isFetchingSettings ? (
          <div className="flex items-center justify-center p-8">
            <Loader2 className="h-8 w-8 animate-spin" />
          </div>
        ) : (
          <Tabs defaultValue="basic" className="w-full">
            <TabsList className="grid w-full grid-cols-5">
              <TabsTrigger value="basic">Basic</TabsTrigger>
              <TabsTrigger value="indicator" disabled={!selectedIndicator}>
                Indicator
              </TabsTrigger>
              <TabsTrigger value="position">Position</TabsTrigger>
              <TabsTrigger value="evaluation">Evaluation</TabsTrigger>
              <TabsTrigger value="trailing">Trailing</TabsTrigger>
            </TabsList>

            <TabsContent value="basic" className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Configuration Set Name</Label>
                <Input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My RSI Config" />
              </div>

              <div className="space-y-2">
                <Label htmlFor="description">Description (Optional)</Label>
                <Input
                  id="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="RSI configuration for volatile markets"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="indicator">Select Indicator</Label>
                <Select value={selectedIndicator} onValueChange={setSelectedIndicator}>
                  <SelectTrigger id="indicator">
                    <SelectValue placeholder="Choose an indicator" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="rsi" disabled={!indicatorSettings?.rsiEnabled}>
                      RSI (Relative Strength Index)
                    </SelectItem>
                    <SelectItem value="macd" disabled={!indicatorSettings?.macdEnabled}>
                      MACD (Moving Average Convergence Divergence)
                    </SelectItem>
                    <SelectItem value="ema" disabled={!indicatorSettings?.emaEnabled}>
                      EMA (Exponential Moving Average)
                    </SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-sm text-muted-foreground">
                  Only indicators enabled in Settings/Indication/Common are available
                </p>
              </div>
            </TabsContent>

            <TabsContent value="indicator" className="space-y-4">
              {selectedIndicator && (
                <Card>
                  <CardHeader>
                    <CardTitle>
                      {selectedIndicator.toUpperCase()} Parameter Ranges
                      <Badge variant="secondary" className="ml-2">
                        50% from defaults
                      </Badge>
                    </CardTitle>
                    <CardDescription>
                      Adjust parameter ranges for testing. Values are initialized from Common Indicator settings.
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {Object.entries(paramRanges).map(([param, range]) => (
                      <div key={param} className="space-y-2">
                        <Label className="capitalize">{param}</Label>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <Label className="text-xs text-muted-foreground">From</Label>
                            <Input
                              type="number"
                              value={range.from}
                              onChange={(e) => handleUpdateRange(param, "from", Number(e.target.value))}
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">To</Label>
                            <Input
                              type="number"
                              value={range.to}
                              onChange={(e) => handleUpdateRange(param, "to", Number(e.target.value))}
                            />
                          </div>
                          <div>
                            <Label className="text-xs text-muted-foreground">Step</Label>
                            <Input
                              type="number"
                              value={range.step}
                              onChange={(e) => handleUpdateRange(param, "step", Number(e.target.value))}
                              step={0.1}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-muted-foreground">
                          Variations: {Math.floor((range.to - range.from) / range.step) + 1}
                        </p>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            <TabsContent value="position" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Take Profit Range</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>From</Label>
                      <Input
                        type="number"
                        value={takeProfitFrom}
                        onChange={(e) => setTakeProfitFrom(Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>To</Label>
                      <Input
                        type="number"
                        value={takeProfitTo}
                        onChange={(e) => setTakeProfitTo(Number(e.target.value))}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Step</Label>
                      <Input
                        type="number"
                        value={takeProfitStep}
                        onChange={(e) => setTakeProfitStep(Number(e.target.value))}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Variations: {Math.floor((takeProfitTo - takeProfitFrom) / takeProfitStep) + 1}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Stop Loss Range</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <Label>From</Label>
                      <Input
                        type="number"
                        value={stopLossFrom}
                        onChange={(e) => setStopLossFrom(Number(e.target.value))}
                        step={0.1}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>To</Label>
                      <Input
                        type="number"
                        value={stopLossTo}
                        onChange={(e) => setStopLossTo(Number(e.target.value))}
                        step={0.1}
                      />
                    </div>
                    <div className="space-y-2">
                      <Label>Step</Label>
                      <Input
                        type="number"
                        value={stopLossStep}
                        onChange={(e) => setStopLossStep(Number(e.target.value))}
                        step={0.1}
                      />
                    </div>
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Variations: {Math.floor((stopLossTo - stopLossFrom) / stopLossStep) + 1}
                  </p>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Trailing Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="flex items-center justify-between">
                    <Label>Enable Trailing Stop</Label>
                    <Switch checked={trailingEnabled} onCheckedChange={setTrailingEnabled} />
                  </div>
                  {trailingEnabled && (
                    <p className="text-sm text-muted-foreground pl-4">
                      Trail starts: [0.3, 0.6, 1.0] × Trail stops: [0.1, 0.2, 0.3] = 9 variations
                    </p>
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="evaluation" className="space-y-4">
              <Card>
                <CardHeader>
                  <CardTitle>Backtest Configuration</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Range Days</Label>
                      <Input type="number" value={rangeDays} onChange={(e) => setRangeDays(Number(e.target.value))} />
                      <p className="text-xs text-muted-foreground">Historical days to test (1-20)</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Min Trades per 48h</Label>
                      <Input
                        type="number"
                        value={tradesPerDay}
                        onChange={(e) => setTradesPerDay(Number(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">Minimum activity threshold</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>Performance Thresholds</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Min Profit Factor</Label>
                      <Input
                        type="number"
                        value={minProfitFactor}
                        onChange={(e) => setMinProfitFactor(Number(e.target.value))}
                        step={0.1}
                      />
                      <p className="text-xs text-muted-foreground">Configurations below this are excluded</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Max Drawdown Hours</Label>
                      <Input
                        type="number"
                        value={maxDrawdownHours}
                        onChange={(e) => setMaxDrawdownHours(Number(e.target.value))}
                      />
                      <p className="text-xs text-muted-foreground">Maximum hours in drawdown</p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card className="border-blue-500/20 bg-blue-500/5">
                <CardContent className="p-4">
                  <div className="flex items-start gap-3">
                    <Info className="h-5 w-5 text-blue-500 mt-0.5" />
                    <div className="space-y-1">
                      <p className="text-sm font-medium">Automatic Re-evaluation</p>
                      <p className="text-xs text-muted-foreground">
                        Sets are automatically re-evaluated every hour. Configurations that don't meet profit thresholds
                        for the last X positions are disabled automatically.
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent value="trailing" className="space-y-4 mt-4">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <CardTitle>Strategy Configuration</CardTitle>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Info className="h-3 w-3" />
                      <span>Synced with Base Settings</span>
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  {/* Additional Category - Trailing */}
                  <div className="rounded-lg border border-purple-200 bg-purple-50/50 dark:border-purple-800 dark:bg-purple-950/20 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300 border-purple-300"
                      >
                        Additional
                      </Badge>
                      <span className="text-sm text-muted-foreground">Enhancement strategies</span>
                    </div>

                    <div
                      className={`flex items-center justify-between ${!baseSettings.trailingEnabled ? "opacity-50" : ""}`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Label>Enable Trailing Stop</Label>
                          {!baseSettings.trailingEnabled && (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Disabled in Base Settings
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">Dynamic profit protection with trailing stops</p>
                      </div>
                      <Switch
                        checked={trailingEnabled}
                        onCheckedChange={setTrailingEnabled}
                        disabled={!baseSettings.trailingEnabled}
                      />
                    </div>
                    {trailingEnabled && baseSettings.trailingEnabled && (
                      <p className="text-sm text-muted-foreground pl-4">
                        Trail starts: [0.3, 0.6, 1.0] × Trail stops: [0.1, 0.2, 0.3] = 9 variations
                      </p>
                    )}
                  </div>

                  {/* Adjust Category - Block & DCA */}
                  <div className="rounded-lg border border-blue-200 bg-blue-50/50 dark:border-blue-800 dark:bg-blue-950/20 p-4 space-y-3">
                    <div className="flex items-center gap-2">
                      <Badge
                        variant="outline"
                        className="bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300 border-blue-300"
                      >
                        Adjust
                      </Badge>
                      <span className="text-sm text-muted-foreground">Volume/position adjustment strategies</span>
                    </div>

                    <div
                      className={`flex items-center justify-between ${!baseSettings.blockEnabled ? "opacity-50" : ""}`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Label>Enable Block Strategy</Label>
                          {!baseSettings.blockEnabled && (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Disabled in Base Settings
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">Volume adjustment through block trading</p>
                      </div>
                      <Switch
                        checked={blockEnabled}
                        onCheckedChange={setBlockEnabled}
                        disabled={!baseSettings.blockEnabled}
                      />
                    </div>

                    <div
                      className={`flex items-center justify-between ${!baseSettings.dcaEnabled ? "opacity-50" : ""}`}
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <Label>Enable DCA Strategy</Label>
                          {!baseSettings.dcaEnabled && (
                            <Badge variant="destructive" className="text-xs">
                              <AlertCircle className="h-3 w-3 mr-1" />
                              Disabled in Base Settings
                            </Badge>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">Dollar-cost averaging for position adjustment</p>
                      </div>
                      <Switch
                        checked={dcaEnabled}
                        onCheckedChange={setDcaEnabled}
                        disabled={!baseSettings.dcaEnabled}
                      />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}

        <DialogFooter className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              Total Variations: <strong className="text-foreground">{totalVariations.toLocaleString()}</strong>
            </span>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading || !selectedIndicator}>
              {isLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Create Configuration Set
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
