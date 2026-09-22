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
- **Scan for BRACKET ALERTS (highest priority).** Since Sep 1 2026 the bot verifies the post-fill
  stop/target against Oanda instead of assuming the modification applied. Two error-level lines
  mean a real trade is running on levels the bot could NOT confirm, and both also fire a Telegram
  alert: `BRACKET UNVERIFIED` (bracket is off the intended levels — position still protected) and
  `NO STOP LOSS` (position is genuinely unprotected — act immediately, check Oanda by hand).
  Neither has fired yet; the first occurrence is a real incident, not noise.
  `✅ Bracket verified on attempt 2` is the NORMAL happy path, not a retry: attempt 1 reads the
  on-fill (signal-price) levels, finds them off, and writes the fill-based levels in one request;
  attempt 2 re-reads and confirms. Only a `Bracket adjustment attempt n/3 failed` warn is a real retry.
- **Stop filled past its level?** For every `STOP_LOSS_ORDER` exit compare the tracker's `exitPrice`
  to `stopLoss`. More than ~$2 adverse = a gap. Check the clock against NFP (13:30 UK, first Friday),
  CPI (13:30 UK) and FOMC (19:00 UK) BEFORE suspecting the bracket — Sep 4 2026 was a $28 NFP gap
  through a verified stop (−2.40R). The bot has NO calendar filter by DECISION: a 25-month replay with
  real S5 fills (research_notes Part 8, Sep 4 2026) found trades open across releases hit TP 7 of 9,
  flattening before releases costs 0.08R/trade, and the calendar covers 7% of shocks. Do not recommend
  a calendar/flatten rule on the next gap loss; report the slippage and move on.
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
- **Also non-fatal (since Sep 2 2026):** `Position monitor cycle failed (n/3, transient - retrying
  in 60s)` at `warn` is a single Oanda 401/503 on the 60-s monitor. They cluster near
  00:00/04:00/09:00 UTC and self-heal on the next cycle. The companion `Failed to get open trades`
  line is also `warn` now. It escalates to the error-level `Error monitoring positions (N consecutive
  cycles)` only after 3 straight failed cycles - THAT one matters, especially with a trade open.
  Since Sep 13 2026 the error line repeats only at cycle 3 and every 10th cycle after (10, 20, ...);
  the cycles in between log `Position monitor still failing (N consecutive cycles ...)` at `warn`, and
  recovery logs `Position monitor recovered after N failed cycles` at `info`. So a 100-minute outage
  is ~10 error lines, not ~100. **Oanda's Friday-night maintenance** (`System under maintenance` 503
  from ~21:45 UTC for ~100 min after the Friday close) is the usual cause - benign when flat, scans
  keep running because only the account endpoints are down, and the watchdog is untouched.
- **Logs rotate** (`gold_bot.log` → `gold_bot1..4.log`, ~11 MB each). Greps target the current
  `gold_bot.log`; widen to the rotations only when chasing something older than the live file.

```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker logs gold-trading-bot --tail 100 2>&1"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "du -sh /root/Oanda_Gold/logs/*"
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker inspect gold-trading-bot --format 'RestartCount={{.RestartCount}} StartedAt={{.State.StartedAt}}'"
# order rejections + hard errors (last 24h)
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "tail -40 /root/Oanda_Gold/logs/error.log; echo '---REJECTIONS---'; grep -iE 'BOUNDS_VIOLATION|INSUFFICIENT_MARGIN|MARKET_HALTED|REJECT' /root/Oanda_Gold/logs/gold_bot.log | tail -20; echo '---BRACKET ALERTS (any hit = incident)---'; grep -aE 'BRACKET UNVERIFIED|NO STOP LOSS|Bracket adjustment attempt' /root/Oanda_Gold/logs/gold_bot.log | tail -20"
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
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot env | grep -E 'STRATEGY|EMA_TREND|LEG_FILTER|ALLOW_SHORT|TRAILING|TAKE_PROFIT|BREAKOUT_STOP|TRADE_COOLDOWN|TRADING_START|TRADING_END|CONFIG_REGIME|RISK|POSITION_SIZE' | sort"
```

Expected current values — **BRACKET-EXIT regime (Jul 10 2026), risk raised Sep 21 2026** (flag any drift):
- `STRATEGY_TYPE=ema_trend`, `ALLOW_SHORT=true`, `CONFIG_REGIME=bracket-jul10-risk1pct`
- **Exit (the whole point of this regime):** `ENABLE_TRAILING_STOP=false`, `EMA_TREND_BE_TRIGGER_PCT=0`,
  `EMA_TREND_TP_RR=2.0`. Trail and breakeven are BOTH off so the resting 2R TP can fire.
  `TRAILING_STOP_DISTANCE_PIPS=150` is still set but INERT — ignore it, do not "fix" it.
- **BALANCED session/filters (Jul 1 2026):** `TRADING_START_HOUR=8`, `TRADING_END_HOUR=22`,
  `EMA_TREND_ADX_MIN=20`, `EMA_TREND_RSI_SELL_MIN=45`, `EMA_TREND_MAX_SL=2000` ($20 cap)
- `EMA_TREND_LEG_FILTER_ENFORCE=true`, `EMA_TREND_LEG_FILTER_THRESHOLD=2.0`
- `EMA_TREND_ATR_SL_MULT=1.5`, `TRADE_COOLDOWN_HOURS=2`
- **Sizing (CHANGED Sep 21 2026 — do NOT flag as drift):** `MIN_POSITION_SIZE=10` (was 100 —
  the floor that caused the £1,818 outlier), **`MAX_RISK_PER_TRADE=0.01`** (was 0.005). At a $20
  stop this yields **~57 units ≈ £861 risk**. Flag if size is pinned at the floor again.
  Two things moved together that day: the config doubled the risk, AND the long-undeployed FX
  fix (`713ef5b`) shipped — the bot had been dividing a GBP budget by a USD stop distance, so
  `0.005` was really risking 0.36%. Combined effect **21u → 57u, £317 → £861 per 1R (2.7×)**.
- **⚠️ £ SCALE BREAK at Sep 21 2026.** R, PF, win rate and TP-rate are currency-free and pool
  across the date unchanged — **only £ breaks**. Never add a post-Sep-21 £ to a pre-Sep-21 total.
  The regime tag keeps the `bracket-jul10` prefix deliberately: prefix-match to pool R stats,
  exact-match to separate the £ scale.
- **Startup FX line is a required check:** logs must show `FX: 1 USD of loss = 0.7xxx account
  currency`. If it is missing or warns "stale", sizing silently falls back to 1.0 and under-risks
  by ~25%. `grep -a 'FX:' /root/Oanda_Gold/logs/gold_bot.log | tail -2`

⚠️ Rollbacks (then `docker compose up -d` — **never** `restart`, it does not re-read `.env`):
- risk 1.0% → 0.5% only: `/root/Oanda_Gold/.env.bak-20260921-risk1pct`
- whole bracket regime: `/root/Oanda_Gold/.env.bak-20260710-bracket`

These live in THREE places (config.js default, docker-compose.yml `${VAR:-default}`, VPS `.env`
override) — a value can be correct in one and wrong in the container. The `env` output above
is the source of truth for what's actually running.

## 7. OANDA-SPECIFIC CHECKS
- Spread conditions in recent trades
- Account margin usage
- Any requote or rejection issues
- **Tracker ties to Oanda?** If a trade has closed since the last healthcheck, run steps 1–2 of the
  `reconcile` skill (`node scripts/reconcile.mjs ...`) before quoting any stats in section 8. Report
  the verdict line (P&L Δ, break count). #854/#872 exitTime are known standing breaks, so don't
  re-flag them. Any **Oanda-only trade after tracking began** or an **open-position mismatch** is P1.

## 8. STRATEGY EDGE ASSESSMENT

> ✅ **The Jun-1 2026 validation trigger is CLOSED** (run Jul 29 2026 at n=37 — PF did not move
> off ~1.1, but the failure was fully explained by the trail capping winners, which the Jul-10
> bracket change fixes). Do NOT re-run it; it is superseded by the trigger below.
>
> ⏰ **LIVE TRIGGER — BRACKET-ERA VALIDATION (n ≥ 20).** Count only trades whose `regime` starts
> `bracket-jul10`. **As of Sep 21 2026 that is 6** (3W/3L, net +£432, +1.63R, PF 1.30, 3 of 6 at
> the 2R TP). At ~3 trades/month, n=20 lands around **Feb 2027**. Until then, report the number
> but **do not draw a verdict** — PF on n<20 is noise. When it fires:
> - PF, win rate, payoff and **mean R** across the bracket era (R pools across the Sep-21 £ break, £ does not).
> - **TP-hit rate vs 33.3%** — that is the breakeven rate for a 2R target. Above it = edge, at it = chance.
> - **Leg filter:** any trade that fired despite `legWouldBlock=true`? (Zero so far.)
> - **Shorts:** all 6 bracket trades are LONG. Has a short finally fired? The regime is untested short-side.
> - **Verdict:** if PF holds >1.3 with the TP rate above 33.3%, that is the green light to prep
>   go-live. If not → diagnose before real money. Do NOT tune exits to close a gap ([[exit-config-not-the-lever]]).

Use the per-strategy tracker (NOT just trading_stats.json — that blends all strategies and
includes pre-bot history). Pull the live strategy's own trades and compute the edge:
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/tracker_data.json" > /tmp/tracker.json
# P&L is real broker GBP, not USD. Segment by regime — ALL-TIME pools incompatible exit eras and is meaningless.
node -e 'const d=JSON.parse(require("fs").readFileSync("/tmp/tracker.json"));const all=(d.strategies[d.liveStrategy].trades||[]).filter(x=>typeof x.pnl==="number");const f=(t,lab)=>{if(!t.length)return console.log(lab+": none");const w=t.filter(x=>x.pnl>0),l=t.filter(x=>x.pnl<=0),s=a=>a.reduce((p,x)=>p+x.pnl,0),aw=w.length?s(w)/w.length:0,al=l.length?s(l)/l.length:0;const tp=t.filter(x=>/TAKE_PROFIT/.test(x.exitReason||"")).length;console.log(`${lab}: ${t.length} trades, ${w.length}W/${l.length}L (${(100*w.length/t.length).toFixed(0)}%), avgW GBP ${aw.toFixed(0)}, avgL GBP ${al.toFixed(0)}, payoff ${al?Math.abs(aw/al).toFixed(2):"-"}, PF ${(s(w)/Math.abs(s(l))).toFixed(2)}, net GBP ${s(t).toFixed(0)}, TP-rate ${(100*tp/t.length).toFixed(0)}% (vs 33.3% breakeven)`)};f(all,"ALL-TIME (do NOT read as edge)");f(all.filter(x=>String(x.regime||"").startsWith("bracket-jul10")),"BRACKET ERA  (the one that counts)")'
```

- Win rate, profit factor, avg win vs avg loss (payoff ratio).
- **ATR-SL CAP — expected, do NOT "fix" by raising the cap.** `lastATR × 1.5` (~$21 at H1
  ATR ~$14) exceeds the $20 `EMA_TREND_MAX_SL` cap, so most stops sit pinned at $20. That is
  intended: the cap bounds worst-case loss. (Historic note: the cap was $8 until Jun 25 2026 and
  the sizing floor was 100u — that combination is what produced the £1,818 outlier. Both are fixed.)
- **POSITION-SIZE FLOOR — the real risk check.** Inspect a `Position sizing:` log line. Since
  Sep 21 2026 healthy looks like:
  `Position sizing: Risk=$870.81, Distance=$20.00, Size=57 units (fx 0.7555, risk at stop 861.27 account ccy)`
  — genuinely risk-scaled, well clear of the `MIN_POSITION_SIZE=10` floor, and carrying the `fx`
  suffix that proves the conversion applied. Pre-Sep-21 lines read `Risk=$437, Distance=$20.00,
  Size=21 units` with no `fx` suffix — that is the OLD regime, not a fault.
  **Flag if:** size lands ON the floor (actual risk would exceed `MAX_RISK_PER_TRADE`), or the
  `fx` suffix is absent on a new trade (conversion silently fell back to 1.0, under-risking ~25%).
  Note the grep sorts by FILENAME, so `gold_bot4.log` (oldest rotation) lands last — read
  `gold_bot.log` explicitly for the most recent line.
- **Is 2:1 R:R actually realized?** Count `TAKE_PROFIT_ORDER` exits vs `STOP_LOSS_ORDER`. Under
  the pre-Jul-10 config the answer was 0/35 — the $1.50 trail always fired first
  (see [[tp-never-reached-trail-preempts]]). **Under bracket exit the TP fires: 3 of the first 6
  (Jul 22 +£621, Aug 5 +£626, Aug 17 +£614), all within a few cents of exactly 2.0R on a $20 stop.**
  Bracket-era trades need ≥20 before PF means anything; expect ~3/month and holds of hours-to-days.
- **Stop fills are clean — check, don't assume.** Jul 27 filled $0.04 past its level, Sep 17 $0.12.
  The one exception is Sep 4 2026 at **$28.03** past a verified stop — the NFP print, already
  investigated; see the calendar-filter DECISION in section 2 before proposing a fix.
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
