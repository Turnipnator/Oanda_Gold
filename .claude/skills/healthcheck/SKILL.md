---
name: healthcheck
description: Run a comprehensive health check on the Gold trading bot
---

# Gold Trading Bot Health Check

Run a comprehensive health check on the gold-trading-bot. Work through each section systematically and provide a summary dashboard at the end.

## VPS Details
- Server: 109.199.105.63
- SSH Key: ~/.ssh/id_ed25519_vps
- Container: gold-trading-bot

## 1. PROCESS STATUS
- Is the bot process running? Check with `docker ps`
- How long has it been running (uptime)?
- Any recent restarts or crashes?

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker ps --format '{{.Names}}\t{{.Status}}\t{{.RunningFor}}' | grep gold"
```

## 2. LOG ANALYSIS
- Check the last 100 lines of logs for errors, warnings, or anomalies
- Identify any recurring error patterns
- Check log file sizes (logs not growing unbounded)

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker logs gold-trading-bot --tail 100 2>&1"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "du -sh /root/Oanda_Gold/logs/*"
```

## 3. STRATEGY STATUS
The bot currently supports three strategies (check which is LIVE via STRATEGY_TYPE env var):
- **EMA Trend (3/8/21)** — trend-following with pullback entries, ATR-based stops, 2:1 R:R, breakeven at 70%
- **Breakout + ADX** — Donchian channel breakouts with MTF pullback entries
- **Triple Confirmation** — EMA crossover + RSI + candlestick patterns

Check which strategy is active and its state:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot env | grep -E 'STRATEGY_TYPE|ALLOW_SHORT|TRADING_START|TRADING_END|EMA_TREND'"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/ema_trend_state.json 2>/dev/null || echo 'No EMA Trend state'"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/breakout_adx_state.json 2>/dev/null || echo 'No Breakout state'"
```

For EMA Trend strategy, key things to check in logs:
- Are the fast EMAs (3/8/21) calculating correctly?
- What's the current ATR value? (determines stop/TP size)
- Is HTF (H4) alignment being checked?
- Are pullback entries being detected? (price within 0.3% of fast EMA)
- Is ADX rising or declining?

## 4. PERFORMANCE METRICS
- Check current trades/positions
- Review recent P&L from trading stats
- Check account balance and margin
- For EMA Trend trades: check if breakeven was triggered, what ATR-based SL/TP were used

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/trading_stats.json"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/summary\" | jq '.account | {balance, pl, unrealizedPL, marginUsed, openTradeCount}'"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/openTrades\""
```

Check for any trades since the strategy switch (Mar 18 2026):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/transactions?from=2026-03-18T00:00:00Z&type=ORDER_FILL\""
```

## 5. SYSTEM RESOURCES
- RAM usage, disk space, CPU usage

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker stats gold-trading-bot --no-stream --format '{{.MemUsage}}\t{{.CPUPerc}}' && echo '---' && df -h /"
```

## 6. CONFIGURATION REVIEW
- Verify strategy selection and key parameters
- Check that EMA Trend config matches expectations (fast EMAs, ATR multipliers, R:R)

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot env | grep -E 'STRATEGY|EMA_TREND|ALLOW_SHORT|TRAILING|TAKE_PROFIT|BREAKOUT_STOP|TRADE_COOLDOWN|TRADING_START|TRADING_END' | sort"
```

## 7. OANDA-SPECIFIC CHECKS
- Spread conditions in recent trades
- Account margin usage
- Any requote or rejection issues

## 8. STRATEGY EDGE ASSESSMENT
Based on trading_stats.json and recent trades:
- Calculate win rate (wins / total trades)
- For EMA Trend: are ATR-based stops sizing correctly? (should be $2-$8 range)
- Is the 2:1 R:R being achieved? (check actual win/loss amounts)
- Are breakeven triggers working? (check for SL-at-entry closures)
- Compare hypothetical signals from other strategies in logs

Key benchmarks for EMA Trend (from IG backtest):
- Target win rate: ~47%
- Target profit factor: > 1.5
- Avg win should be ~2x avg loss (2:1 R:R)
- Breakeven exits should be ~2-5% of trades

## 9. RECOMMENDATIONS
Provide prioritised recommendations:
- P1 (Critical): Issues that need immediate attention
- P2 (Important): Should be addressed soon
- P3 (Nice to have): Optimisations for later

## 10. SUMMARY DASHBOARD
Present a quick status summary table:

| Check | Status | Notes |
|-------|--------|-------|
| Process Running | ?/? | |
| Logs Healthy | ?/?/? | |
| Strategy Active | ?/? | Which strategy, what signals |
| Open Trades | ?/? | Any positions, breakeven status |
| Resources OK | ?/?/? | |
| Config Correct | ?/? | Strategy params, trading hours, shorts |
| Strategy Edge | ?/?/? | Win rate, R:R, profit factor |

Traffic light summary: GREEN All good / YELLOW Minor issues / RED Needs attention
