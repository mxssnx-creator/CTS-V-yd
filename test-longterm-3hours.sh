#!/bin/bash

# Comprehensive 3-hour long-term trading test with 8 symbols
# Monitors: API performance, memory, cycles, trades, success rates

TEST_DURATION_SECONDS=${1:-10800}  # 3 hours = 10800 seconds
POLL_INTERVAL=30  # Check every 30 seconds
START_TIME=$(date +%s)
END_TIME=$((START_TIME + TEST_DURATION_SECONDS))
CYCLE_COUNT=0
LAST_CYCLES=0
LAST_TRADES=0
MEMORY_PEAK=0
API_TIMEOUTS=0
API_SUCCESSES=0

echo "=========================================="
echo "3-HOUR LONG-TERM TRADING TEST"
echo "8 Symbols: BTCUSDT, ETHUSDT, TAIKO, VELVET, BEAT, ZROU, WLD, JTO"
echo "Start: $(date)"
echo "Duration: $((TEST_DURATION_SECONDS / 60)) minutes"
echo "=========================================="
echo ""

# Create CSV for metrics
METRICS_FILE="/tmp/longterm-metrics-$(date +%s).csv"
echo "timestamp_sec,cycles_completed,trades_total,success_rate,memory_mb,api_latency_ms,api_errors" > "$METRICS_FILE"

while [ $(date +%s) -lt $END_TIME ]; do
  CURRENT_TIME=$(date +%s)
  ELAPSED=$((CURRENT_TIME - START_TIME))
  ELAPSED_MIN=$((ELAPSED / 60))
  
  # Poll progression API
  RESPONSE=$(timeout 15 curl -s http://localhost:3002/api/connections/progression/bingx-x01 2>/dev/null)
  
  if [ -z "$RESPONSE" ]; then
    ((API_TIMEOUTS++))
    echo "[$(date +%H:%M:%S)] API Timeout #$API_TIMEOUTS — retrying in 30s"
  else
    ((API_SUCCESSES++))
    
    # Extract metrics from response
    PHASE=$(echo "$RESPONSE" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
    PROGRESS=$(echo "$RESPONSE" | grep -o '"progress":[0-9]*' | cut -d':' -f2)
    CYCLES=$(echo "$RESPONSE" | grep -o '"cyclesCompleted":[0-9]*' | cut -d':' -f2)
    TRADES=$(echo "$RESPONSE" | grep -o '"totalTrades":[0-9]*' | cut -d':' -f2)
    WIN_RATE=$(echo "$RESPONSE" | grep -o '"tradeSuccessRate":[0-9.]*' | cut -d':' -f2)
    SYMBOL_COUNT=$(echo "$RESPONSE" | grep -o '"symbolsProcessed":[0-9]*' | cut -d':' -f2)
    SYMBOL_TOTAL=$(echo "$RESPONSE" | grep -o '"symbolsTotal":[0-9]*' | cut -d':' -f2)
    PROFIT=$(echo "$RESPONSE" | grep -o '"totalProfit":-*[0-9.]*' | cut -d':' -f2)
    
    MEMORY=$(free | grep Mem | awk '{print int($3 / 1024)}')
    [ $MEMORY -gt $MEMORY_PEAK ] && MEMORY_PEAK=$MEMORY
    
    NEW_CYCLES=$((CYCLES - LAST_CYCLES))
    NEW_TRADES=$((TRADES - LAST_TRADES))
    
    # Print metrics
    echo "[$(date +%H:%M:%S)] Elapsed: ${ELAPSED_MIN}m | Phase: $PHASE | Progress: $PROGRESS% | Cycles: $CYCLES (+$NEW_CYCLES) | Trades: $TRADES (+$NEW_TRADES) | Win Rate: $WIN_RATE% | Symbols: $SYMBOL_COUNT/$SYMBOL_TOTAL | Profit: $PROFIT | Memory: ${MEMORY}MB"
    
    # Log to CSV
    echo "$ELAPSED,$CYCLES,$TRADES,$WIN_RATE,$MEMORY,0,$API_TIMEOUTS" >> "$METRICS_FILE"
    
    LAST_CYCLES=$CYCLES
    LAST_TRADES=$TRADES
  fi
  
  sleep $POLL_INTERVAL
done

# Final summary
FINAL_TIME=$(date +%s)
TOTAL_ELAPSED=$((FINAL_TIME - START_TIME))
FINAL_MIN=$((TOTAL_ELAPSED / 60))
API_TOTAL=$((API_SUCCESSES + API_TIMEOUTS))
API_SUCCESS_RATE=$((API_SUCCESSES * 100 / API_TOTAL))

echo ""
echo "=========================================="
echo "TEST COMPLETE"
echo "=========================================="
echo "Duration: ${FINAL_MIN} minutes"
echo "API Requests: $API_TOTAL (Success: $API_SUCCESS_RATE%, Timeouts: $API_TIMEOUTS)"
echo "Peak Memory: ${MEMORY_PEAK}MB"
echo "Final Cycles: $CYCLES (+$NEW_CYCLES in last interval)"
echo "Final Trades: $TRADES (+$NEW_TRADES in last interval)"
echo "Metrics CSV: $METRICS_FILE"
echo "Dev Log: /tmp/dev.log"
echo "=========================================="
