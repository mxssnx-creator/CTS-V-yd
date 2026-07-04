"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { toast } from "@/lib/simple-toast"

export function AutoIndicationSettings() {
  const [settings, setSettings] = useState({
    enabled: false,

    // Time analysis windows
    analysisWindow8h: true,
    analysisWindow1h: true,
    analysisWindow30m: true,

    // Activity ratios
    activityRatios: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0],

    // Time windows (1-20 min)
    timeWindows: [1, 3, 5, 10, 15, 20],

    // Direction tracking
    shortTermDirection: true,
    longTermDirection: true,

    // Progressive analysis
    progressiveActivity: true,
    stepCalculation: true,

    // Optimal coordination
    optimalSituationCoordination: true,
    trailingOptimalRanges: true,
    simultaneousTrading: true,

    // Position increment
    positionIncrementAfterSituation: true,

    // Block strategy
    blockEnabled: true,
    blockPositions: 3,
    blockNeutralWait: true,
    blockNeutralPositions: 3,
    blockVolumeAdjustment: "keep" as "keep" | "reduce",

    // Level strategy
    levelEnabled: true,
    levelType: "optimal" as "linear" | "exponential" | "fibonacci" | "optimal",
    levelMaxLevels: 5,
    levelIncrementRatio: 1.5,
    levelProfitTargetAdjustment: true,

    // DCA strategy
    dcaEnabled: false,
    dcaMaxSteps: 4,
    dcaStep1Volume: 1.5,
    dcaStep2Volume: 2.0,
    dcaStep3Volume: 2.3,
    dcaStep4Volume: 2.5,
    dcaStep1Distance: 0.5,
    dcaStep2Distance: 1.0,
    dcaStep3Distance: 1.5,
    dcaStep4Distance: 2.0,
    dcaTakeProfitAdjustment: "average" as "average" | "first_entry" | "breakeven_plus",

    // Profit back tactics
    profitBackEnabled: true,
    profitBackClosePartial: true,
    profitBackPercent: 50,
    profitBackTrailing: true,
    profitBackAggressiveTp: true,
  })

  useEffect(() => {
    loadSettings()
  }, [])

  const loadSettings = async () => {
    try {
      const response = await fetch("/api/settings/indications/auto")
      if (response.ok) {
        const data = await response.json()
        setSettings({ ...settings, ...data })
      }
    } catch (error) {
      console.error("[v0] Failed to load Auto settings:", error)
    }
  }

  const saveSettings = async () => {
    try {
      const response = await fetch("/api/settings/indications/auto", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      })

      if (!response.ok) throw new Error("Failed to save settings")

      toast.success("Auto indication settings saved")
    } catch (error) {
      console.error("[v0] Failed to save Auto settings:", error)
      toast.error("Failed to save Auto settings")
    }
  }

  return (
    <div className="space-y-6">
      {/* Main Enable */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Auto Indication</CardTitle>
              <CardDescription>
                Comprehensive trading system with 8-hour analysis, progressive strategies, and optimal coordination
              </CardDescription>
            </div>
            <Switch
              checked={settings.enabled}
              onCheckedChange={(checked) => setSettings({ ...settings, enabled: checked })}
            />
          </div>
        </CardHeader>
      </Card>

      {settings.enabled && (
        <>
          {/* Time Analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Time Analysis Windows</CardTitle>
              <CardDescription>Configure which historical timeframes to analyze</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <Label>8-Hour Analysis</Label>
                <Switch
                  checked={settings.analysisWindow8h}
                  onCheckedChange={(checked) => setSettings({ ...settings, analysisWindow8h: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>1-Hour Analysis</Label>
                <Switch
                  checked={settings.analysisWindow1h}
                  onCheckedChange={(checked) => setSettings({ ...settings, analysisWindow1h: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <Label>30-Minute Analysis</Label>
                <Switch
                  checked={settings.analysisWindow30m}
                  onCheckedChange={(checked) => setSettings({ ...settings, analysisWindow30m: checked })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Progressive Analysis */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Progressive Market Analysis</CardTitle>
              <CardDescription>Advanced activity and momentum detection</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Progressive Activity Detection</Label>
                  <p className="text-xs text-muted-foreground">Detect increasing market changes</p>
                </div>
                <Switch
                  checked={settings.progressiveActivity}
                  onCheckedChange={(checked) => setSettings({ ...settings, progressiveActivity: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Step-by-Step Calculation</Label>
                  <p className="text-xs text-muted-foreground">Analyze each price step strength</p>
                </div>
                <Switch
                  checked={settings.stepCalculation}
                  onCheckedChange={(checked) => setSettings({ ...settings, stepCalculation: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Short-Term Direction Tracking (1-5 min)</Label>
                  <p className="text-xs text-muted-foreground">Track immediate direction changes</p>
                </div>
                <Switch
                  checked={settings.shortTermDirection}
                  onCheckedChange={(checked) => setSettings({ ...settings, shortTermDirection: checked })}
                />
              </div>
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Long-Term Direction Tracking (15-60 min)</Label>
                  <p className="text-xs text-muted-foreground">Track broader direction changes</p>
                </div>
                <Switch
                  checked={settings.longTermDirection}
                  onCheckedChange={(checked) => setSettings({ ...settings, longTermDirection: checked })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Block Strategy */}
          <Card className="border-blue-500/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    Block Strategy
                    <Badge variant="default">Strategy</Badge>
                  </CardTitle>
                  <CardDescription>Multiple positions with neutral wait logic</CardDescription>
                </div>
                <Switch
                  checked={settings.blockEnabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, blockEnabled: checked })}
                />
              </div>
            </CardHeader>
            {settings.blockEnabled && (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Block Size (positions)</Label>
                  <Slider
                    min={2}
                    max={10}
                    step={1}
                    value={[settings.blockPositions]}
                    onValueChange={([value]) => setSettings({ ...settings, blockPositions: value })}
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.blockPositions} positions</p>
                </div>

                <Separator />

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>3-Position Neutral Wait</Label>
                    <p className="text-xs text-muted-foreground">Wait for 3 positions before continuing</p>
                  </div>
                  <Switch
                    checked={settings.blockNeutralWait}
                    onCheckedChange={(checked) => setSettings({ ...settings, blockNeutralWait: checked })}
                  />
                </div>

                {settings.blockNeutralWait && (
                  <div className="space-y-2">
                    <Label>Volume Adjustment on Loss</Label>
                    <Select
                      value={settings.blockVolumeAdjustment}
                      onValueChange={(value: "keep" | "reduce") =>
                        setSettings({ ...settings, blockVolumeAdjustment: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="keep">Keep Increased Volume</SelectItem>
                        <SelectItem value="reduce">Reduce Volume to Base</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                )}
              </CardContent>
            )}
          </Card>

          {/* Level Strategy */}
          <Card className="border-purple-500/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    Level Strategy
                    <Badge variant="default">Strategy</Badge>
                  </CardTitle>
                  <CardDescription>Optimal volume incrementing with position levels</CardDescription>
                </div>
                <Switch
                  checked={settings.levelEnabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, levelEnabled: checked })}
                />
              </div>
            </CardHeader>
            {settings.levelEnabled && (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Level Type</Label>
                  <Select
                    value={settings.levelType}
                    onValueChange={(value: any) => setSettings({ ...settings, levelType: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="linear">Linear Increase</SelectItem>
                      <SelectItem value="exponential">Exponential Increase</SelectItem>
                      <SelectItem value="fibonacci">Fibonacci Sequence</SelectItem>
                      <SelectItem value="optimal">Optimal (Best Logic)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label>Maximum Levels</Label>
                  <Slider
                    min={2}
                    max={10}
                    step={1}
                    value={[settings.levelMaxLevels]}
                    onValueChange={([value]) => setSettings({ ...settings, levelMaxLevels: value })}
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.levelMaxLevels} levels</p>
                </div>

                <div className="space-y-2">
                  <Label>Volume Increment Ratio</Label>
                  <Slider
                    min={1.1}
                    max={3.0}
                    step={0.1}
                    value={[settings.levelIncrementRatio]}
                    onValueChange={([value]) => setSettings({ ...settings, levelIncrementRatio: value })}
                  />
                  <p className="text-xs text-muted-foreground">
                    Current: {settings.levelIncrementRatio.toFixed(1)}x per level
                  </p>
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Adjust TP Based on Level</Label>
                    <p className="text-xs text-muted-foreground">Higher levels get adjusted profit targets</p>
                  </div>
                  <Switch
                    checked={settings.levelProfitTargetAdjustment}
                    onCheckedChange={(checked) => setSettings({ ...settings, levelProfitTargetAdjustment: checked })}
                  />
                </div>
              </CardContent>
            )}
          </Card>

          {/* DCA Strategy */}
          <Card className="border-green-500/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    DCA Strategy
                    <Badge variant="default">Strategy</Badge>
                  </CardTitle>
                  <CardDescription>Dollar Cost Averaging with up to 4 steps (max 2.5x per step)</CardDescription>
                </div>
                <Switch
                  checked={settings.dcaEnabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, dcaEnabled: checked })}
                />
              </div>
            </CardHeader>
            {settings.dcaEnabled && (
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Maximum DCA Steps</Label>
                  <Slider
                    min={1}
                    max={4}
                    step={1}
                    value={[settings.dcaMaxSteps]}
                    onValueChange={([value]) => setSettings({ ...settings, dcaMaxSteps: value })}
                  />
                  <p className="text-xs text-muted-foreground">Current: {settings.dcaMaxSteps} steps</p>
                </div>

                <Separator />

                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label>Step 1 Volume</Label>
                    <Input
                      type="number"
                      min="1.0"
                      max="2.5"
                      step="0.1"
                      value={settings.dcaStep1Volume}
                      onChange={(e) => setSettings({ ...settings, dcaStep1Volume: Number.parseFloat(e.target.value) })}
                    />
                    <p className="text-xs text-muted-foreground">{settings.dcaStep1Volume}x base</p>
                  </div>
                  <div className="space-y-2">
                    <Label>Step 1 Distance (%)</Label>
                    <Input
                      type="number"
                      min="0.1"
                      max="5.0"
                      step="0.1"
                      value={settings.dcaStep1Distance}
                      onChange={(e) =>
                        setSettings({ ...settings, dcaStep1Distance: Number.parseFloat(e.target.value) })
                      }
                    />
                  </div>
                </div>

                {settings.dcaMaxSteps >= 2 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Step 2 Volume</Label>
                      <Input
                        type="number"
                        min="1.0"
                        max="2.5"
                        step="0.1"
                        value={settings.dcaStep2Volume}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep2Volume: Number.parseFloat(e.target.value) })
                        }
                      />
                      <p className="text-xs text-muted-foreground">{settings.dcaStep2Volume}x base</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Step 2 Distance (%)</Label>
                      <Input
                        type="number"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={settings.dcaStep2Distance}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep2Distance: Number.parseFloat(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                )}

                {settings.dcaMaxSteps >= 3 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Step 3 Volume</Label>
                      <Input
                        type="number"
                        min="1.0"
                        max="2.5"
                        step="0.1"
                        value={settings.dcaStep3Volume}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep3Volume: Number.parseFloat(e.target.value) })
                        }
                      />
                      <p className="text-xs text-muted-foreground">{settings.dcaStep3Volume}x base</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Step 3 Distance (%)</Label>
                      <Input
                        type="number"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={settings.dcaStep3Distance}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep3Distance: Number.parseFloat(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                )}

                {settings.dcaMaxSteps >= 4 && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>Step 4 Volume</Label>
                      <Input
                        type="number"
                        min="1.0"
                        max="2.5"
                        step="0.1"
                        value={settings.dcaStep4Volume}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep4Volume: Number.parseFloat(e.target.value) })
                        }
                      />
                      <p className="text-xs text-muted-foreground">{settings.dcaStep4Volume}x base</p>
                    </div>
                    <div className="space-y-2">
                      <Label>Step 4 Distance (%)</Label>
                      <Input
                        type="number"
                        min="0.1"
                        max="5.0"
                        step="0.1"
                        value={settings.dcaStep4Distance}
                        onChange={(e) =>
                          setSettings({ ...settings, dcaStep4Distance: Number.parseFloat(e.target.value) })
                        }
                      />
                    </div>
                  </div>
                )}

                <Separator />

                <div className="space-y-2">
                  <Label>Take Profit Calculation</Label>
                  <Select
                    value={settings.dcaTakeProfitAdjustment}
                    onValueChange={(value: any) => setSettings({ ...settings, dcaTakeProfitAdjustment: value })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="average">Average Entry Price</SelectItem>
                      <SelectItem value="first_entry">First Entry Price</SelectItem>
                      <SelectItem value="breakeven_plus">Breakeven + Margin</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardContent>
            )}
          </Card>

          {/* Profit Back to Positive Tactics */}
          <Card className="border-orange-500/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    Profit Back to Positive Tactics
                    <Badge variant="secondary">Advanced</Badge>
                  </CardTitle>
                  <CardDescription>Recovery strategies for drawdown positions</CardDescription>
                </div>
                <Switch
                  checked={settings.profitBackEnabled}
                  onCheckedChange={(checked) => setSettings({ ...settings, profitBackEnabled: checked })}
                />
              </div>
            </CardHeader>
            {settings.profitBackEnabled && (
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Close Partial on Breakeven</Label>
                    <p className="text-xs text-muted-foreground">Close part of position when back to breakeven</p>
                  </div>
                  <Switch
                    checked={settings.profitBackClosePartial}
                    onCheckedChange={(checked) => setSettings({ ...settings, profitBackClosePartial: checked })}
                  />
                </div>

                {settings.profitBackClosePartial && (
                  <div className="space-y-2">
                    <Label>Partial Close Percentage</Label>
                    <Slider
                      min={10}
                      max={90}
                      step={10}
                      value={[settings.profitBackPercent]}
                      onValueChange={([value]) => setSettings({ ...settings, profitBackPercent: value })}
                    />
                    <p className="text-xs text-muted-foreground">Close {settings.profitBackPercent}% at breakeven</p>
                  </div>
                )}

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Trailing After Breakeven</Label>
                    <p className="text-xs text-muted-foreground">Enable trailing stop after reaching breakeven</p>
                  </div>
                  <Switch
                    checked={settings.profitBackTrailing}
                    onCheckedChange={(checked) => setSettings({ ...settings, profitBackTrailing: checked })}
                  />
                </div>

                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label>Aggressive TP Reduction</Label>
                    <p className="text-xs text-muted-foreground">Reduce profit target to exit faster from drawdown</p>
                  </div>
                  <Switch
                    checked={settings.profitBackAggressiveTp}
                    onCheckedChange={(checked) => setSettings({ ...settings, profitBackAggressiveTp: checked })}
                  />
                </div>
              </CardContent>
            )}
          </Card>

          {/* Optimal Coordination */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Optimal Situation Coordination</CardTitle>
              <CardDescription>Advanced coordination and trailing logic</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Optimal Situation Coordination</Label>
                  <p className="text-xs text-muted-foreground">Coordinate all strategies for optimal entry</p>
                </div>
                <Switch
                  checked={settings.optimalSituationCoordination}
                  onCheckedChange={(checked) => setSettings({ ...settings, optimalSituationCoordination: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Trailing Optimal Ranges</Label>
                  <p className="text-xs text-muted-foreground">Calculate optimal trailing ranges dynamically</p>
                </div>
                <Switch
                  checked={settings.trailingOptimalRanges}
                  onCheckedChange={(checked) => setSettings({ ...settings, trailingOptimalRanges: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Simultaneous Trading</Label>
                  <p className="text-xs text-muted-foreground">Trade with AND without trailing at same time</p>
                </div>
                <Switch
                  checked={settings.simultaneousTrading}
                  onCheckedChange={(checked) => setSettings({ ...settings, simultaneousTrading: checked })}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="space-y-0.5">
                  <Label>Position Increment After Situation</Label>
                  <p className="text-xs text-muted-foreground">Add positions after optimal situation confirmed</p>
                </div>
                <Switch
                  checked={settings.positionIncrementAfterSituation}
                  onCheckedChange={(checked) => setSettings({ ...settings, positionIncrementAfterSituation: checked })}
                />
              </div>
            </CardContent>
          </Card>

          <div className="flex gap-3">
            <Button onClick={saveSettings} className="flex-1">
              Save Auto Settings
            </Button>
            <Button variant="outline" onClick={loadSettings} className="flex-1 bg-transparent">
              Reset to Saved
            </Button>
          </div>
        </>
      )}
    </div>
  )
}

export default AutoIndicationSettings
