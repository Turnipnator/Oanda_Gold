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
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "du -sh /root/Oanda_Gold/logs/* && cat /root/Oanda_Gold/logs/error.log"
```

## 3. SIGNAL GENERATION
- Is the bot actively producing trading signals?
- What was the last signal generated and when?
- Check strategy state file

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/breakout_adx_state.json"
```

## 4. PERFORMANCE METRICS
- Check current trades/positions
- Review recent P&L from trading stats
- Check account balance and margin

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/trading_stats.json"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/summary\" | jq '.account | {balance, pl, unrealizedPL, marginUsed, openTradeCount}'"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/openTrades\""
```

## 5. SYSTEM RESOURCES
- RAM usage, disk space, CPU usage

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "free -h && echo '---' && df -h / && echo '---' && top -bn1 | head -12"
```

## 6. CONFIGURATION REVIEW
- Check key environment variables are set correctly
- Verify strategy settings

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "grep -E 'TIMEFRAME|STRATEGY|ENABLE_' /root/Oanda_Gold/.env"
```

## 7. OANDA-SPECIFIC CHECKS
- Spread conditions in recent trades
- Account margin usage
- Any requote or rejection issues (check error.log)

## 8. STRATEGY EDGE ASSESSMENT
Based on trading_stats.json:
- Calculate win rate (wins / total trades)
- Is the strategy performing as expected?
- Any parameter tweaks recommended?

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
| Signals Active | ?/? | |
| Resources OK | ?/?/? | |
| Strategy Edge | ?/?/? | |

Traffic light summary: ? All good / ? Minor issues / ? Needs attention
