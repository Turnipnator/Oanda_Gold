> **Common Patterns**: See `~/trading-bot-skill.md` for deployment, Docker, Telegram, and strategy patterns shared across all trading bots.

When asked to do research or strategy analysis, first read RESEARCH.md and follow the protocol within it.

- Always remember I am in UK timezone, so next scan of 14:15 isn't applicable to me. Quote times in UK time (GMT in winter, BST = UTC+1 in summer). The container runs `TZ=UTC` and Oanda timestamps are UTC, so convert.

---

# Gold Trading Bot (Oanda XAU/USD)

Automated gold bot on an **Oanda practice (paper) account**. Node 20, ES modules, runs in Docker on the VPS, reports to Telegram. VPS access and deploy commands are in `CLAUDE.local.md`.

**Philosophy:** trade with the trend, manage risk ruthlessly, follow the rules. Change things only on evidence, and never tune on a single trade.

## Status: paper trading, in validation

- **Live strategy: EMA Trend with a bracket exit** (`STRATEGY_TYPE=ema_trend`, `CONFIG_REGIME=bracket-jul10-risk1pct`).
- The live forward test is the judge. **No verdict before n≥20 bracket-era trades**, judged on PF/R, not on any single loss.
- **No go-live on that alone.** It also needs a large-sample replay showing E[R] > 0 with a bootstrap CI that excludes zero.
- Running tallies, reminders and validation history live in auto-memory (`MEMORY.md`), not here.

## Live strategy: EMA Trend (H1, bracket exit)

Evaluated on each completed H1 candle (scan every 15 min). Source: `src/ema_trend_strategy.js`.

**LONG** (SHORT is the mirror image, `ALLOW_SHORT=true`):
1. EMA 3 > EMA 8 > EMA 21, and price > EMA 21.
2. Pullback: price within 0.3% of EMA 3 (not extended).
3. RSI 15–60 for longs (`EMA_TREND_RSI_BUY_MAX=60`); shorts RSI 45–85 (`EMA_TREND_RSI_SELL_MIN=45`).
4. ADX ≥ 20 and not falling (more than 0.5 below the previous bar).
5. H4 trend not against the trade (neutral is allowed, at lower confidence).
6. **Leg filter (enforced):** block if the move over the last 6 H1 candles in the trade direction exceeds 2.0× ATR. This stops chasing exhausted legs.
7. Session 08:00–22:00 UK only. 2-hour cooldown after any trade closes.

**Exit (bracket):**
- Stop = 1.5 × ATR, clamped to $2–$20 (`EMA_TREND_MIN_SL=200`, `EMA_TREND_MAX_SL=2000` pips).
- Take profit = 2.0R, a **resting broker order** (`EMA_TREND_TP_RR=2.0`).
- **No trailing stop and no breakeven move** (`ENABLE_TRAILING_STOP=false`, `EMA_TREND_BE_TRIGGER_PCT=0`).
- After every fill, `ensureBracket()` sets the stop and target and re-reads the trade to verify them. `BRACKET UNVERIFIED` or `NO STOP LOSS` in the logs means a real trade is running on unconfirmed levels.

## Risk and survival guards

- **Sizing:** units = (balance × `MAX_RISK_PER_TRADE` ÷ FX factor) ÷ stop distance, clamped to `MIN_POSITION_SIZE=10`…`MAX_POSITION_SIZE`. Risk is 1.0% per trade (paper; reset deliberately before any go-live). The account is in GBP, so the USD loss is converted with the FX factor, which is refreshed every scan.
- `MAX_PORTFOLIO_RISK=0.05`, plus a daily loss limit.
- **Drawdown kill switch:** 8% from the realised equity peak (`MAX_DRAWDOWN_PCT=0.08`). It latches until `/ddreset` on Telegram.
- **Stale-data guard:** refuse to enter if the price is >120 s old, the instrument isn't tradeable, or the last H1 candle is >75 min old.
- **Entry guards:** `MAX_ENTRY_DRIFT_PIPS` cancels before ordering if price has run away. `MAX_SLIPPAGE_PIPS` bounds the fill.
- **Watchdog:** the process exits (and Docker restarts it) if no scan or monitor cycle completes in 20 min.

## Config and deployment rules (these have bitten before)

- **Three config sources:** `src/config.js` default → `docker-compose.yml` `${VAR:-default}` → VPS `.env`. A value can be right in one and wrong in the container. **`docker exec gold-trading-bot env` is the source of truth.** When changing a default, update both config.js and docker-compose.yml.
- **After any `.env` change use `docker compose up -d`, never `docker compose restart`.** Restart reuses the old env.
- **Deploys need `ssh -A`.** The VPS pulls from GitHub over SSH using the Mac's forwarded agent.
- **Bump `CONFIG_REGIME`** in the VPS `.env` on any deploy that changes entry or exit behaviour, so stats from different regimes are never pooled. Don't bump it for logging, reporting or guard-only changes.
- Many env vars are leftovers from the Breakout era (`BREAKOUT_*`, `TRAILING_*`, `RSI_BULLISH_*`, `EMA_FAST/SLOW`, `TAKE_PROFIT_*_RR`). They are inert under `STRATEGY_TYPE=ema_trend`. Check the code before assuming one matters.
- The local `.env` API key is stale. For Oanda API scripts, use the VPS `.env`.

## Code map

| File | Role |
|------|------|
| `src/index.js` | Main loop: scans, position monitor, order placement, `ensureBracket()`, watchdog |
| `src/ema_trend_strategy.js` | Live entry logic and leg filter |
| `src/risk_manager.js` | Position sizing, daily stats, drawdown kill switch |
| `src/freshness.js` | Stale-data guard |
| `src/oanda_client.js` | Oanda v20 REST wrapper |
| `src/strategy_tracker.js` | Trade ledger (`/app/data/tracker_data.json`), real broker GBP P&L |
| `src/signal_ledger.js` | Phase 0 log of every trend-aligned candle and why it was skipped (log only) |
| `src/telegram_bot.js` | `/status /positions /pnl /balance /drawdown /ddreset /stop /resume /emergency /compare` |
| `src/config.js` | All parameters and defaults |
| `src/breakout_adx_strategy.js`, `ma_crossover_strategy.js`, `strategy.js` | Archived strategies (selectable, not live) |
| `scripts/reconcile.mjs` | Tracker vs Oanda reconciliation (see the `/reconcile` skill) |
| `research_*.js/.mjs`, `backtest_*.js` | Offline research harnesses, results in `research_notes.md` |

**Tests:** `npm run test:bracket | test:sizing | test:format | test:reconcile | test:killswitch | test:ledger`. No network needed. The Dockerfile only copies `src/`, so **run the tests locally**; they don't exist in the container.

## Research rules

Follow `RESEARCH.md`. Findings go in `research_notes.md` (numbered Parts). The standards we've settled on:
- **Pre-register** the hypothesis, metric and pass bar before running.
- Replay the **real strategy code**, with a **15-min fill delay** (entry at the price actually available) and measured spreads. Exit work needs S5 bid/ask; the old `backtest_trail.js` has known fidelity bugs.
- **Walk-forward:** the result must be positive in both the TRAIN and TEST halves. Use a month-block bootstrap CI, and correct for multiple configs (White's Reality Check).
- One trade, or one counterfactual, never justifies a change. About 9% of signals flip sign on the fill delay alone.

**Tested and rejected; don't reopen without genuinely new evidence:** widening the RSI band, RSI cap 75–80, silver, 8 other markets, M15 entries, news-calendar filter, post-release drift, macro (real-yield/dollar) filter (forward test pre-registered for Oct 2027), flush-reclaim, friend's ORB on gold, ATR pullback gate, wider stop cap, trail variants, TP below 2R, removing the session filter, long-only. The 71-config search found nothing that beats the incumbent.

**Honest expectation:** the measured edge is modest (≈ +0.15–0.23R/trade, ~3 trades/month, roughly 4%/yr at current risk), and the most recent out-of-sample year is weak. The old "3–8% per month" target is not supported by any test.

## Oanda / XAU_USD notes

- Instrument `XAU_USD`. Practice API `https://api-fxpractice.oanda.com`, live `https://api-fxtrade.oanda.com`.
- Prices have 2 decimals: always `parseFloat(price.toFixed(2))`.
- In this codebase **1 pip = $0.01** (e.g. 2000 pips = $20).
- Units = ounces; 1 unit is the minimum. P&L is reported in GBP (account currency).
- Trades 24/5. Expect Friday-night Oanda maintenance 503s (~21:45–23:30 UTC); they're benign when flat.

## Archived strategies (history only)

- **Triple Confirmation** (20/50 EMA + RSI + S/R candle pattern, H4): the original design, which underperformed in backtests.
- **MA Crossover 10/50** (Dec 2025): too few trades.
- **Breakout + ADX MTF** (Jan–Mar 2026): live record 17W/36L, −£8,253. Nearly half the trades were stopped out in under 30 s. Replaced by EMA Trend.

Full detail is in git history (`git log -- CLAUDE.md`) and `research_notes.md`.
