---
name: reconcile
description: Reconcile the bot's strategy tracker against Oanda trade by trade — find every break (P&L, fill price, stop, exit reason, exit time, missing or phantom trades), state its root cause in one line, and propose the fix. Use before any stats review, at each n=20 validation checkpoint, or when tracker numbers look off.
---

# Reconcile tracker ↔ Oanda

Every win rate, PF, TP-rate and R figure comes from `tracker_data.json`, which is the bot's
**own** record. Oanda is the source of truth. This skill lines the two up trade by trade.
It is read-only: it diagnoses and proposes, and never edits the tracker without the user's go-ahead.

Method borrowed from the gl-reconciler / break-trace agents in anthropics/financial-services:
**match → diff → classify → root-cause each break in one sentence → route the fix.**

## 1. Pull both sides

```bash
R=$(mktemp -d)
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker exec gold-trading-bot cat /app/data/tracker_data.json" > $R/tracker.json
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/trades?state=CLOSED&instrument=XAU_USD&count=500\"" > $R/closed.json
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "source /root/Oanda_Gold/.env && curl -s -H \"Authorization: Bearer \$OANDA_API_KEY\" \"https://api-fxpractice.oanda.com/v3/accounts/\$OANDA_ACCOUNT_ID/openTrades\"" > $R/open.json
```

Always use the VPS `.env` key (the local one is stale). `count=500` is Oanda's maximum. Once
the account passes 500 XAU_USD trades, page back with `beforeID=<oldest id>` and merge the pages.

## 2. Run the matcher

```bash
node scripts/reconcile.mjs --tracker $R/tracker.json --closed $R/closed.json --open $R/open.json
```

Exit code 0 means clean, 1 means breaks, 2 means bad input. Exit 2 usually means Oanda returned
an error body such as a 401. The script matches on direction, units and the nearest open time
(within 10 min), because the tracker stores no Oanda trade ID. Its logic is pinned by
`npm run test:reconcile`.

What the output means:
- **Breaks**: the two sides disagree in a way that corrupts stats. Every one needs a root cause.
- **Explained differences**: expected and not errors. These are pre-bracket trail/BE stop moves,
  overnight financing (Oanda's `realizedPL` excludes it, and so does the tracker), and stops that
  gapped past their level (check NFP/CPI/FOMC; see the healthcheck's gap guidance).
- **Pre-history**: Oanda trades from before the first tracker trade (the breakout era and
  pre-bot Sep–Dec 2025). These are not checked.

## 3. Trace every break the script can't explain

The script writes a cause for every break it recognises. For any cause that says "trace by hand",
or that doesn't fit the facts, follow the audit trail on both sides:

- **Oanda side**: `GET /v3/accounts/{id}/trades/{tradeId}` for the trade, and
  `GET /v3/accounts/{id}/transactions/idrange?from=<open txn>&to=<close txn>` for every order,
  modification, fill and reject in between.
- **Bot side**: `grep -a "<trade id>\|<entry time HH:MM>" /root/Oanda_Gold/logs/gold_bot.log`, or
  `docker logs` if the file has rotated.
- Diff the attributes (fill price, units, stop/TP prices, close transaction type, times). The
  attribute that differs is usually the cause.

Write each root cause as **"⟨side⟩ ⟨did what⟩ because ⟨reason⟩ — ⟨consequence⟩"**, e.g.
"Tracker exitTime is 13.8d after Oanda's close because the trade was inserted by a manual
backfill that stamped the edit time — hold-time stats are wrong, P&L is right."

## 4. Report

Lead with the verdict: **P&L ties / doesn't tie**, plus the break count. Then give one row per break:

| Trade | Field | Root cause | Stats affected | Action |
|---|---|---|---|---|

- **Stats affected**: name what the break corrupts (PF, WR, TP-rate, R, hold-time, £-tally),
  or "none". A break that only touches hold-time does not change the bracket-era verdict.
- **Action**: one of `fix-tracker` (edit the data), `fix-code` (the bot records it wrong going
  forward), `monitor`, or `accept` (known and harmless).
- Separately flag any **Oanda-only trade after tracking began**. It means a trade the bot lost
  or a manual trade, and it is the most serious break: the stats are missing a real P&L.
- Separately flag any **open-position mismatch** (tracker open vs Oanda open). An Oanda-open
  trade the tracker doesn't know about is unmanaged. Treat it as P1.

## 5. Fixing the tracker (only with the user's go-ahead)

The bot reads the tracker only at startup and rewrites it on every trade event, so a live edit
gets overwritten. The procedure is:
1. Back up: `cp data/tracker_data.json data/tracker_data.json.bak-$(date +%Y%m%d)-reconcile`
2. `docker compose stop gold-bot`, but only when **no trade is open** (check `open.json`).
3. Apply the edit with a script (never hand-edit the JSON), recompute the strategy aggregates
   (`totalPnL`, W/L counts, largest win/loss, drawdown) from `trades[]`, and verify by rerunning step 2.
4. `docker compose up -d`, then rerun this skill. It must come back with the fixed breaks gone.

## Known standing breaks (as of Sep 22 2026)

- **#854 (Mar 26) and #872 (Mar 27) exitTime**: stamped 2026-04-09 10:50 by the Apr 9 manual
  reconciliation, 13+ days after the real close. P&L, prices and exit reason all tie. Only
  hold-time is wrong. Action: `fix-tracker` at the next safe window, or `accept`.

Baseline at the first run (Sep 22 2026): 41/41 EMA Trend trades matched, closed P&L
**−£1,300.33 on both sides (Δ £0.00)**, financing −£3.83, no missing or phantom trades.
