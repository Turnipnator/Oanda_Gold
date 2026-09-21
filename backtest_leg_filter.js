#!/usr/bin/env node
/**
 * Backtest Filter #2 (Recent Leg Size Filter) against all closed trades.
 *
 * Logic:
 *   1. Fetch every ORDER_FILL transaction from Oanda.
 *   2. Group fills into trades (open + close).
 *   3. For each opening trade, fetch H1 candles for ~30h before entry.
 *   4. Calculate ATR(14) and the 6-candle leg range.
 *   5. If recent leg > 2× ATR in the trade's direction → flag as BLOCKED.
 *   6. Tally: blocked P&L vs allowed P&L, win rates, vs original.
 *
 * Sensitivities also tested: 1.5×, 2.0×, 2.5×, 3.0× ATR thresholds.
 */

import axios from 'axios';

const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const BASE = 'https://api-fxpractice.oanda.com';
const headers = { Authorization: `Bearer ${API_KEY}` };

if (!API_KEY || !ACCOUNT_ID) {
  console.error('Missing OANDA_API_KEY or OANDA_ACCOUNT_ID');
  process.exit(1);
}

async function fetchAllFills() {
  const fills = [];
  let lastId = 0;
  while (true) {
    const url = `${BASE}/v3/accounts/${ACCOUNT_ID}/transactions/sinceid?id=${lastId}&type=ORDER_FILL`;
    const { data } = await axios.get(url, { headers });
    const txns = data.transactions || [];
    if (txns.length === 0) break;
    for (const t of txns) {
      if (t.instrument === 'XAU_USD' && t.type === 'ORDER_FILL') fills.push(t);
    }
    const newLast = parseInt(txns[txns.length - 1].id);
    if (newLast === lastId) break;
    lastId = newLast;
    if (txns.length < 100) break;
  }
  return fills;
}

function groupTrades(fills) {
  // Each open fill creates a tradeOpened; close fills reference tradeClosed.id
  const trades = new Map();
  for (const f of fills) {
    if (f.tradeOpened) {
      trades.set(f.tradeOpened.tradeID, {
        id: f.tradeOpened.tradeID,
        openTime: f.time,
        openPrice: parseFloat(f.tradeOpened.price),
        units: parseFloat(f.tradeOpened.units),
        direction: parseFloat(f.tradeOpened.units) > 0 ? 'LONG' : 'SHORT',
        closeTime: null,
        closePrice: null,
        pl: 0,
        closeReason: null
      });
    }
    if (f.tradesClosed) {
      for (const tc of f.tradesClosed) {
        const t = trades.get(tc.tradeID);
        if (t) {
          t.closeTime = f.time;
          t.closePrice = parseFloat(tc.price);
          t.pl += parseFloat(tc.realizedPL);
          t.closeReason = f.reason;
        }
      }
    }
  }
  return [...trades.values()].filter(t => t.closeTime !== null);
}

async function fetchH1Candles(beforeISO, count = 30) {
  const url = `${BASE}/v3/instruments/XAU_USD/candles?granularity=H1&count=${count}&to=${encodeURIComponent(beforeISO)}&price=M`;
  const { data } = await axios.get(url, { headers });
  return data.candles
    .filter(c => c.complete)
    .map(c => ({
      time: c.time,
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c)
    }));
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const lastTRs = trs.slice(-period);
  return lastTRs.reduce((a, b) => a + b, 0) / period;
}

function evaluateLegFilter(candles, direction, atr, lookback = 6) {
  if (candles.length < lookback) return { legATR: 0, inDirection: false, blocked: false, legSize: 0 };
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const legSize = Math.max(...highs) - Math.min(...lows);
  const firstClose = recent[0].open;
  const lastClose = recent[recent.length - 1].close;
  const moveDir = lastClose < firstClose ? 'SHORT' : 'LONG';
  const inDirection = moveDir === direction;
  const legATR = legSize / atr;
  return { legATR, inDirection, legSize };
}

async function run() {
  console.log('Fetching all XAU_USD fills…');
  const fills = await fetchAllFills();
  console.log(`Got ${fills.length} fills`);

  let trades = groupTrades(fills);
  console.log(`Reconstructed ${trades.length} closed trades total`);

  // Filter to EMA Trend strategy era (post Mar 18 2026)
  const CUTOFF = '2026-03-18T00:00:00Z';
  trades = trades.filter(t => t.openTime >= CUTOFF);
  console.log(`Filtered to ${trades.length} trades opened on/after ${CUTOFF.slice(0, 10)} (EMA Trend era)\n`);

  const thresholds = [1.5, 2.0, 2.5, 3.0];

  // Enrich each trade with filter data
  let processed = 0;
  for (const t of trades) {
    try {
      const candles = await fetchH1Candles(t.openTime, 30);
      // ATR from full 30-candle window (excluding last 6 leg if we want, but cleaner: use full window)
      const atr = calcATR(candles, 14);
      const leg = evaluateLegFilter(candles, t.direction, atr, 6);
      t.atr = atr;
      t.legATR = leg.legATR;
      t.inDirection = leg.inDirection;
      t.legSize = leg.legSize;
    } catch (e) {
      t.error = e.message;
    }
    processed++;
    if (processed % 10 === 0) process.stderr.write(`.${processed}.`);
    await new Promise(r => setTimeout(r, 80)); // be nice to API
  }
  console.log(`\n\nProcessed ${processed} trades\n`);

  // Original stats
  const originalPL = trades.reduce((a, t) => a + t.pl, 0);
  const originalWins = trades.filter(t => t.pl > 0).length;
  const originalLosses = trades.filter(t => t.pl <= 0).length;

  console.log('═══════════════════════════════════════════════════════════');
  console.log('ORIGINAL STATS (no filter)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Trades: ${trades.length}`);
  console.log(`Wins: ${originalWins}   Losses: ${originalLosses}`);
  console.log(`Win rate: ${(originalWins / trades.length * 100).toFixed(1)}%`);
  console.log(`Total P&L: $${originalPL.toFixed(2)}`);
  console.log(`Avg P&L per trade: $${(originalPL / trades.length).toFixed(2)}\n`);

  // Run filter at each threshold
  for (const thresh of thresholds) {
    const blocked = trades.filter(t => t.legATR && t.inDirection && t.legATR > thresh);
    const allowed = trades.filter(t => !(t.legATR && t.inDirection && t.legATR > thresh));
    const blockedPL = blocked.reduce((a, t) => a + t.pl, 0);
    const allowedPL = allowed.reduce((a, t) => a + t.pl, 0);
    const blockedWins = blocked.filter(t => t.pl > 0).length;
    const allowedWins = allowed.filter(t => t.pl > 0).length;

    console.log('═══════════════════════════════════════════════════════════');
    console.log(`FILTER: leg > ${thresh}× ATR in trade direction → BLOCK`);
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`BLOCKED: ${blocked.length} trades   P&L: $${blockedPL.toFixed(2)}   Win rate: ${blocked.length ? (blockedWins / blocked.length * 100).toFixed(1) : 'n/a'}%`);
    console.log(`ALLOWED: ${allowed.length} trades   P&L: $${allowedPL.toFixed(2)}   Win rate: ${allowed.length ? (allowedWins / allowed.length * 100).toFixed(1) : 'n/a'}%`);
    console.log(`IMPROVEMENT: $${(allowedPL - originalPL).toFixed(2)}  (skipping blocked saves you their net P&L)`);
    console.log('');
  }

  // Detail dump of all blocked trades at 2× threshold
  console.log('═══════════════════════════════════════════════════════════');
  console.log('BLOCKED TRADES AT 2.0× THRESHOLD (the recommended filter)');
  console.log('═══════════════════════════════════════════════════════════');
  console.log('time                | dir   | entry    | exit     |    P&L | legATR | legSize');
  console.log('--------------------|-------|----------|----------|--------|--------|--------');
  const sorted = trades
    .filter(t => t.legATR && t.inDirection && t.legATR > 2.0)
    .sort((a, b) => new Date(a.openTime) - new Date(b.openTime));
  for (const t of sorted) {
    console.log(
      `${t.openTime.slice(0, 16).padEnd(20)}| ${t.direction.padEnd(6)}| ${t.openPrice.toFixed(2).padStart(8)} | ${t.closePrice.toFixed(2).padStart(8)} | ${t.pl.toFixed(2).padStart(6)} | ${t.legATR.toFixed(2).padStart(6)} | $${t.legSize.toFixed(2)}`
    );
  }
}

run().catch(e => { console.error(e); process.exit(1); });
