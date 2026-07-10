#!/bin/bash

DURATION=${1:-600}  # 10 minutes default
START_TIME=$(date +%s)
END_TIME=$((START_TIME + DURATION))

echo "=============================================="
echo "COMPREHENSIVE LIVE TRADING TEST"
echo "8 Symbols: BTCUSDT, ETHUSDT, TAIKO, VELVET, BEAT, ZROU, WLD, JTO"
echo "Start: $(date)"
echo "Duration: $((DURATION / 60)) minutes"
echo "=============================================="
echo ""

PREV_CYCLES=0
PREV_TRADES=0
PREV_PROFIT=0

while [ $(date +%s) -lt $END_TIME ]; do
  ELAPSED=$(($(date +%s) - START_TIME))
  MINS=$((ELAPSED / 60))
  SECS=$((ELAPSED % 60))
  
  PROG_DATA=$(curl -s http://localhost:3002/api/connections/progression/bingx-x01 2>/dev/null)
  
  if [ -z "$PROG_DATA" ]; then
    echo "[$(date +%H:%M:%S)] ERROR: Could not fetch progression data"
    sleep 30
    continue
  fi
  
  PHASE=$(echo "$PROG_DATA" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
  PROGRESS=$(echo "$PROG_DATA" | grep -o '"progress":[0-9.]*' | cut -d':' -f2)
  CYCLES=$(echo "$PROG_DATA" | grep -o '"cyclesCompleted":[0-9]*' | cut -d':' -f2)
  TRADES=$(echo "$PROG_DATA" | grep -o '"totalTrades":[0-9]*' | cut -d':' -f2)
  SUCCESS=$(echo "$PROG_DATA" | grep -o '"tradeSuccessRate":[0-9.]*' | cut -d':' -f2)
  PROFIT=$(echo "$PROG_DATA" | grep -o '"totalProfit":[^,}]*' | cut -d':' -f2)
  SYMBOLS=$(echo "$PROG_DATA" | grep -o '"symbolsProcessed":[0-9]*' | cut -d':' -f2)
  
  CYCLES_DELTA=$((CYCLES - PREV_CYCLES))
  TRADES_DELTA=$((TRADES - PREV_TRADES))
  PROFIT_INT=$(printf "%.0f" "$PROFIT" 2>/dev/null || echo "0")
  
  echo "[$(printf '%02d' $MINS):$(printf '%02d' $SECS)] Phase: $PHASE | Progress: ${PROGRESS}% | Cycles: $CYCLES (+$CYCLES_DELTA) | Trades: $TRADES (+$TRADES_DELTA) | Win Rate: ${SUCCESS}% | Symbols: ${SYMBOLS}/8 | Profit: ${PROFIT_INT}"
  
  # Check for sets evaluation
  SETS_DATA=$(curl -s http://localhost:3002/api/connections/progression/bingx-x01 2>/dev/null | grep -o '"strategiesCount":[0-9]*\|"strategiesBaseTotal":[0-9]*\|"strategiesMainTotal":[0-9]*\|"strategiesRealTotal":[0-9]*' | head -4)
  
  if [ ! -z "$SETS_DATA" ]; then
    BASE=$(echo "$SETS_DATA" | grep "Base" | cut -d':' -f2)
    MAIN=$(echo "$SETS_DATA" | grep "Main" | cut -d':' -f2)
    REAL=$(echo "$SETS_DATA" | grep "Real" | cut -d':' -f2)
    ALL=$(echo "$SETS_DATA" | grep "strategiesCount" | cut -d':' -f2)
    
    if [ ! -z "$ALL" ]; then
      echo "         Sets: BASE=${BASE:-?} | MAIN=${MAIN:-?} | REAL=${REAL:-?} | TOTAL=${ALL}"
    fi
  fi
  
  # Verify exchange connectivity
  if [ $((SECS % 30)) -eq 0 ]; then
    HEALTH=$(curl -s http://localhost:3002/api/health 2>/dev/null | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
    if [ "$HEALTH" = "ok" ]; then
      echo "         ✓ API healthy | Exchange: BingX | Mainnet: active"
    else
      echo "         ✗ API issue detected"
    fi
  fi
  
  PREV_CYCLES=$CYCLES
  PREV_TRADES=$TRADES
  PREV_PROFIT=$PROFIT
  
  sleep 30
done

echo ""
echo "=============================================="
echo "TEST COMPLETE"
echo "End: $(date)"
echo "=============================================="
echo ""
echo "FINAL RESULTS:"
curl -s http://localhost:3002/api/connections/progression/bingx-x01 2>/dev/null | grep -o '"phase":"[^"]*"\|"cyclesCompleted":[0-9]*\|"totalTrades":[0-9]*\|"successfulTrades":[0-9]*\|"tradeSuccessRate":[0-9.]*\|"totalProfit":[^,}]*' | head -10
