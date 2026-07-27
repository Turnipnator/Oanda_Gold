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
- **Scan for ORDER REJECTIONS** — `BOUNDS_VIOLATION` (slippage guard rejecting fills),
  `INSUFFICIENT_MARGIN`, `MARKET_HALTED`. A burst of these around a trade means the bot
  fought to enter a fast-moving market — correlate with the next fill's outcome.
- **Errors since the last restart only** (don't get distracted by stale clusters): pass
  `--since <container StartedAt>`.
- **Container restart count** — a climbing count means the watchdog is firing (hangs/crashes).
- **Known non-fatal noise — do NOT flag as a problem:** `Telegram polling error (non-fatal)`
  lines (`ECONNRESET`, `ETELEGRAM 429/502`, `ESOCKETTIMEDOUT`) are external Telegram API hiccups,
  handled gracefully and logged at `warn`. They come in bursts and are harmless. Only escalate if
  they coincide with a watchdog restart or stop the 15-min scan / 60-s position monitor from
  logging. The signal to hunt for is `error`-level lines and the order rejections below.
- **Logs rotate** (`gold_bot.log` → `gold_bot1..4.log`, ~11 MB each). Greps target the current
  `gold_bot.log`; widen to the rotations only when chasing something older than the live file.

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker logs gold-trading-bot --tail 100 2>&1"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "du -sh /root/Oanda_Gold/logs/*"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker inspect gold-trading-bot --format 'RestartCount={{.RestartCount}} StartedAt={{.State.StartedAt}}'"
# order rejections + hard errors (last 24h)
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "tail -40 /root/Oanda_Gold/logs/error.log; echo '---REJECTIONS---'; grep -iE 'BOUNDS_VIOLATION|INSUFFICIENT_MARGIN|MARKET_HALTED|REJECT' /root/Oanda_Gold/logs/gold_bot.log | tail -20"
```

## 3. STRATEGY STATUS
The bot currently supports three strategies (check which is LIVE via STRATEGY_TYPE env var):
- **EMA Trend (3/8/21)** — trend-following with pullback entries, ATR-based stops (×1.5, capped $2–$20), 2:1 R:R. **BRACKET EXIT since Jul 10 2026: trail OFF, breakeven OFF** — a trade now resolves at its resting 2R take-profit or its original stop, nothing in between. (Superseded: the BE-at-30% + $1.50 pre-BE trail described in earlier versions of this skill is disabled; `TRAILING_STOP_DISTANCE_PIPS` is inert.) **Leg filter ENFORCED at 2.0×** (Jun 2026) — rejects entries chasing a move that already ran >2× ATR over the last 6 H1 candles.
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

**Leg filter (now ENFORCED) — verify it's actually firing:**
```bash
# Any signals BLOCKED by the leg filter, and any "WOULD BLOCK" still logged
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "grep -iE 'BLOCKED by leg|WOULD BLOCK|LegFilter' /root/Oanda_Gold/logs/gold_bot.log | tail -15"
```
- If a trade fired despite a `WOULD BLOCK` log, enforcement is broken — investigate.
- Cross-check the cooldown is honoured (no re-fires inside `TRADE_COOLDOWN_HOURS`):
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/trade_cooldown.json; docker exec gold-trading-bot cat /app/data/active_positions.json"
```

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
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot env | grep -E 'STRATEGY|EMA_TREND|LEG_FILTER|ALLOW_SHORT|TRAILING|TAKE_PROFIT|BREAKOUT_STOP|TRADE_COOLDOWN|TRADING_START|TRADING_END' | sort"
```

Expected current values — **BRACKET-EXIT regime, deployed Jul 10 2026** (flag any drift):
- `STRATEGY_TYPE=ema_trend`, `ALLOW_SHORT=true`, `CONFIG_REGIME=bracket-jul10`
- **Exit (the whole point of this regime):** `ENABLE_TRAILING_STOP=false`, `EMA_TREND_BE_TRIGGER_PCT=0`,
  `EMA_TREND_TP_RR=2.0`. Trail and breakeven are BOTH off so the resting 2R TP can fire.
  `TRAILING_STOP_DISTANCE_PIPS=150` is still set but INERT — ignore it, do not "fix" it.
- **BALANCED session/filters (Jul 1 2026):** `TRADING_START_HOUR=8`, `TRADING_END_HOUR=22`,
  `EMA_TREND_ADX_MIN=20`, `EMA_TREND_RSI_SELL_MIN=45`, `EMA_TREND_MAX_SL=2000` ($20 cap)
- `EMA_TREND_LEG_FILTER_ENFORCE=true`, `EMA_TREND_LEG_FILTER_THRESHOLD=2.0`
- `EMA_TREND_ATR_SL_MULT=1.5`, `TRADE_COOLDOWN_HOURS=2`
- **Sizing:** `MIN_POSITION_SIZE=10` (was 100 — the floor that caused the £1,818 outlier),
  `MAX_RISK_PER_TRADE=0.005`. At a $20 stop this yields ~21 units ≈ £433 risk. Flag if size
  is pinned at the floor again.

⚠️ Rollback for this regime: `/root/Oanda_Gold/.env.bak-20260710-bracket` then `docker compose up -d`.

These live in THREE places (config.js default, docker-compose.yml `${VAR:-default}`, VPS `.env`
override) — a value can be correct in one and wrong in the container. The `env` output above
is the source of truth for what's actually running.

## 7. OANDA-SPECIFIC CHECKS
- Spread conditions in recent trades
- Account margin usage
- Any requote or rejection issues

## 8. STRATEGY EDGE ASSESSMENT

> ⏰ **POST-CHANGE VALIDATION TRIGGER (set Jun 1 2026).** Baseline EMA Trend trade count was
> **22** when three changes shipped (leg filter enforced @2.0×, breakeven monotonic-trail fix,
> pre-BE trail $0.75→$1.50). **When the count reaches ~37–42 (15–20 new trades), RUN THE
> VALIDATION REVIEW and report it prominently:**
> - Split trades at the Jun 1 baseline (id/time) → compare PF, win rate, avg win, payoff before vs after.
> - **Leg filter:** any trade that fired despite a `WOULD BLOCK` log? Compare blocked-vs-allowed P&L (`legWouldBlock`). Is it still removing losers not winners?
> - **BE fix:** are the $0 give-back-to-breakeven scratches gone?
> - **Trail $1.50:** did avg win rise vs the old ~$212? What's the `TAKE_PROFIT`-hit rate now?
> - **Verdict:** did PF move off 1.11? If the three changes held → this is the green light to revisit risk sizing (the MIN_POSITION_SIZE floor / 0.5%-vs-0.9%) and prep go-live. If not → diagnose before real money.

Use the per-strategy tracker (NOT just trading_stats.json — that blends all strategies and
includes pre-bot history). Pull the live strategy's own trades and compute the edge:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/tracker_data.json" > /tmp/tracker.json
node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/tracker.json"));const t=(d.strategies[d.liveStrategy].trades||[]).filter(x=>typeof x.pnl==="number");const w=t.filter(x=>x.pnl>0),l=t.filter(x=>x.pnl<=0);const s=a=>a.reduce((p,x)=>p+x.pnl,0);console.log(`${d.liveStrategy}: ${t.length} trades, ${w.length}W/${l.length}L (${(100*w.length/t.length).toFixed(0)}%), avgW $${(s(w)/w.length).toFixed(0)}, avgL $${(s(l)/l.length).toFixed(0)}, PF ${(s(w)/Math.abs(s(l))).toFixed(2)}, net $${s(t).toFixed(0)}`)'
```

- Win rate, profit factor, avg win vs avg loss (payoff ratio).
- **ATR-SL CAP — expected, do NOT "fix" by raising the cap.** `lastATR × 1.5` (~$21 at H1
  ATR ~$14) exceeds the $20 `EMA_TREND_MAX_SL` cap, so most stops sit pinned at $20. That is
  intended: the cap bounds worst-case loss. (Historic note: the cap was $8 until Jun 25 2026 and
  the sizing floor was 100u — that combination is what produced the £1,818 outlier. Both are fixed.)
- **POSITION-SIZE FLOOR — the real risk check.** Inspect a `Position sizing:` log line. Healthy
  now looks like `Risk=$433, Distance=$20.00, Size=21 units` — i.e. genuinely risk-scaled, well
  clear of the `MIN_POSITION_SIZE=10` floor. Flag only if size lands ON the floor, which would
  mean actual $ risk exceeds `MAX_RISK_PER_TRADE` again.
- **Is 2:1 R:R actually realized?** Count `TAKE_PROFIT_ORDER` exits vs `STOP_LOSS_ORDER`. Under
  the pre-Jul-10 config the answer was 0/35 — the $1.50 trail always fired first
  (see [[tp-never-reached-trail-preempts]]). **First TP hit Jul 22 2026: +£621, exactly 2.0R.**
  Bracket-era trades need ≥20 before PF means anything; expect ~3/month and holds of hours-to-days.
- **Leg-filter edge:** split trades by `legWouldBlock` and compare P&L of blocked vs allowed —
  confirms the filter is removing losers, not winners, out of sample.
- **Breakeven exits working?** Look for SL-at-entry / small-profit trailing closures (not $0
  scratches — the Jun 2026 monotonic-BE fix should have eliminated the give-back-to-$0 case).

Reference benchmarks (PF 1.73, 47% WR, +£482/59d) come from a SEPARATE **IG-broker** Gold bot
on a **5-minute** timeframe — the strategy was ported here to Oanda H1 (hence ATR_SL_MULT 1.5 vs
IG's 2.5, and the $2–$8 SL cap). These numbers were NEVER validated on Oanda — treat them as the
design's origin, not a target. Judge this bot on its OWN live record.
- Reference: ~47% WR, PF > 1.5, avg win ~2x avg loss (2:1 R:R), breakeven exits ~2-5% of trades.
- NOTE: live WR has run higher (~70%) but with payoff INVERTED (avg loss > avg win) because the
  2R TP rarely fills — so a high WR alone is not evidence of edge. Always check PF + payoff.

## 9. RECOMMENDATIONS
Provide prioritised recommendations:
- P1 (Critical): Issues that need immediate attention
- P2 (Important): Should be addressed soon
- P3 (Nice to have): Optimisations for later

## 10. SUMMARY DASHBOARD
Present a quick status summary table:

| Check | Status | Notes |
|-------|--------|-------|
| Process Running | ?/? | Uptime, restart count |
| Logs Healthy | ?/?/? | Errors since restart, order rejections |
| Strategy Active | ?/? | Which strategy, what signals |
| Leg Filter | ?/? | Enforced @2.0×, firing? any WOULD-BLOCK that still traded |
| Open Trades | ?/? | Any positions, breakeven status, cooldown honoured |
| Resources OK | ?/?/? | |
| Config Correct | ?/? | All 3 sources agree (env = source of truth) |
| Strategy Edge | ?/?/? | PF + payoff (not WR alone); ATR-SL cap; TP-hit rate |

Traffic light summary: GREEN All good / YELLOW Minor issues / RED Needs attention
