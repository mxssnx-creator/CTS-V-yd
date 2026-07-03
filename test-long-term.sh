#!/bin/bash

# Comprehensive Long-Term Testing Script
# Tests 8-symbol BingX trading with continuous monitoring
# Duration: Configurable (default 30 minutes)

TEST_DURATION=${1:-1800}  # Default 30 minutes in seconds
INTERVAL=10               # Test interval in seconds
START_TIME=$(date +%s)
CYCLE=0
FAILURES=0
SUCCESSES=0

# Color codes
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Log file
LOG_FILE="/tmp/longterm-test.log"
> "$LOG_FILE"

log_test() {
  echo "[$(date +'%Y-%m-%d %H:%M:%S')] CYCLE $CYCLE: $1" | tee -a "$LOG_FILE"
}

log_metric() {
  echo "  $1" | tee -a "$LOG_FILE"
}

echo -e "${BLUE}=== COMPREHENSIVE LONG-TERM TRADING TEST ===${NC}"
echo -e "Duration: $(($TEST_DURATION / 60)) minutes"
echo -e "Test Interval: ${INTERVAL}s"
echo -e "Symbols: BTCUSDT, ETHUSDT, TAIKO, VELVET, BEAT, ZROU, WLD, JTO"
echo -e "Log: $LOG_FILE\n"

while true; do
  CYCLE=$((CYCLE + 1))
  ELAPSED=$(($(date +%s) - START_TIME))
  REMAINING=$((TEST_DURATION - ELAPSED))
  
  if [ $REMAINING -le 0 ]; then
    echo -e "\n${GREEN}=== TEST COMPLETE ===${NC}"
    break
  fi
  
  ELAPSED_MIN=$((ELAPSED / 60))
  REMAINING_MIN=$((REMAINING / 60))
  
  log_test "Starting cycle ($ELAPSED_MIN min elapsed, $REMAINING_MIN min remaining)"
  
  # Test 1: Health check
  HEALTH=$(curl -s http://localhost:3002/api/health --max-time 5 2>/dev/null)
  if [ -z "$HEALTH" ]; then
    log_metric "${RED}✗ Health check failed${NC}"
    FAILURES=$((FAILURES + 1))
  else
    CONNECTIONS=$(echo "$HEALTH" | grep -o '"connections":[0-9]*' | cut -d: -f2)
    UPTIME=$(echo "$HEALTH" | grep -o '"uptime":[0-9]*' | cut -d: -f2)
    log_metric "${GREEN}✓ Health OK${NC} - Connections: $CONNECTIONS, Uptime: ${UPTIME}s"
    SUCCESSES=$((SUCCESSES + 1))
  fi
  
  # Test 2: Progression check
  PROG=$(curl -s http://localhost:3002/api/connections/progression/bingx-x01 --max-time 5 2>/dev/null)
  if [ -z "$PROG" ]; then
    log_metric "${RED}✗ Progression check failed${NC}"
    FAILURES=$((FAILURES + 1))
  else
    PHASE=$(echo "$PROG" | grep -o '"phase":"[^"]*"' | cut -d'"' -f4)
    PROGRESS=$(echo "$PROG" | grep -o '"progress":"[^"]*"' | cut -d'"' -f4 | cut -d. -f1)
    CYCLES=$(echo "$PROG" | grep -o '"cyclesCompleted":[0-9]*' | cut -d: -f2)
    SYMBOLS=$(echo "$PROG" | grep -o '"symbols":\[[^\]]*\]' | grep -o '[A-Z][A-Z]*' | wc -l)
    ORDERS=$(echo "$PROG" | grep -o '"orders":\[[^\]]*\]' | grep -o 'order' | wc -l)
    
    log_metric "${GREEN}✓ Progression${NC} - Phase: $PHASE, Progress: $PROGRESS%, Cycles: $CYCLES, Symbols Tracked: $SYMBOLS, Orders: $ORDERS"
    SUCCESSES=$((SUCCESSES + 1))
  fi
  
  # Test 3: Positions check
  POSITIONS=$(curl -s "http://localhost:3002/api/positions?connection_id=bingx-x01&status=open" --max-time 5 2>/dev/null)
  if [ -z "$POSITIONS" ]; then
    log_metric "${RED}✗ Positions check failed${NC}"
    FAILURES=$((FAILURES + 1))
  else
    POS_COUNT=$(echo "$POSITIONS" | grep -o '"positions":\[' | wc -l)
    log_metric "${GREEN}✓ Open Positions${NC} - Count: $POS_COUNT"
    SUCCESSES=$((SUCCESSES + 1))
  fi
  
  # Test 4: Memory check
  MEMORY=$(free | grep Mem | awk '{printf "%.1f", ($3/$2)*100}')
  CPU=$(ps aux | grep "npm run dev" | grep -v grep | awk '{print $3}')
  log_metric "System - Memory: ${MEMORY}%, CPU: ${CPU}%"
  
  # Test 5: Concurrent requests (light load test)
  START_LOAD=$(date +%s%N | cut -b1-13)
  for i in {1..10}; do
    curl -s http://localhost:3002/api/health --max-time 2 2>/dev/null > /dev/null &
  done
  wait
  END_LOAD=$(date +%s%N | cut -b1-13)
  LOAD_TIME=$((END_LOAD - START_LOAD))
  
  if [ $LOAD_TIME -lt 500 ]; then
    log_metric "${GREEN}✓ Load Test${NC} - 10 concurrent requests in ${LOAD_TIME}ms (excellent)"
  elif [ $LOAD_TIME -lt 1000 ]; then
    log_metric "${YELLOW}⚠ Load Test${NC} - 10 concurrent requests in ${LOAD_TIME}ms (acceptable)"
  else
    log_metric "${RED}✗ Load Test${NC} - 10 concurrent requests in ${LOAD_TIME}ms (slow)"
    FAILURES=$((FAILURES + 1))
  fi
  
  # Stats
  TOTAL_TESTS=$((SUCCESSES + FAILURES))
  SUCCESS_RATE=$(echo "scale=1; ($SUCCESSES * 100) / $TOTAL_TESTS" | bc)
  log_metric "Progress - Success: $SUCCESSES/$TOTAL_TESTS ($SUCCESS_RATE%)"
  
  echo "" | tee -a "$LOG_FILE"
  sleep $INTERVAL
done

# Final Report
echo -e "\n${BLUE}=== FINAL TEST REPORT ===${NC}"
echo "Total Cycles: $CYCLE"
echo "Total Tests: $((SUCCESSES + FAILURES))"
echo "Successes: $SUCCESSES"
echo "Failures: $FAILURES"
FINAL_RATE=$(echo "scale=2; ($SUCCESSES * 100) / ($SUCCESSES + $FAILURES)" | bc 2>/dev/null || echo "N/A")
echo "Success Rate: $FINAL_RATE%"
echo "Log File: $LOG_FILE"
