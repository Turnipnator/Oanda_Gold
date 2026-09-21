#!/usr/bin/env node
/**
 * Leg-filter scorecard across ALL 22 EMA Trend trades (live tracker only stored
 * leg metadata on the last ~7). Recomputes the filter retroactively, faithful to
 * src/ema_trend_strategy.js::_calculateLegInfo:
 *   - lookback = 6 H1 candles fully closed BEFORE entry
 *   - legSize = max(high) - min(low) over those 6 candles
 *   - moveDir = SHORT if lastClose < firstOpen else LONG
 *   - legInDirection = moveDir === signal   (price already ran your way = chasing)
 *   - legATR = legSize / ATR(14, H1)
 *   - wouldBlock = legInDirection && legATR > THRESHOLD
 * Then scores: at each threshold, P&L of blocked trades (losses avoided vs wins forgone).
 */
import axios from 'axios';
import fs from 'fs';

const HOST = 'https://api-fxpractice.oanda.com';
const KEY = process.env.OANDA_API_KEY;
const H = { Authorization: `Bearer ${KEY}` };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function candles(from, to, granularity) {
  const url = `${HOST}/v3/instruments/XAU_USD/candles`;
  const params = { from, to, granularity, price: 'M' };
  for (let a = 0; a < 4; a++) {
    try {
      const res = await axios.get(url, { headers: H, params });
      return (res.data.candles || []).filter(c => c.complete).map(c => ({
        t: new Date(c.time).getTime(),
        open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c,
      }));
    } catch (e) { if (a === 3) throw e; await sleep(500 * (a + 1)); }
  }
}

function atr14(h1) {
  if (h1.length < 15) return null;
  const trs = [];
  for (let i = 1; i < h1.length; i++) {
    trs.push(Math.max(
      h1[i].high - h1[i].low,
      Math.abs(h1[i].high - h1[i - 1].close),
      Math.abs(h1[i].low - h1[i - 1].close)));
  }
  const l14 = trs.slice(-14);
  return l14.reduce((s, x) => s + x, 0) / l14.length;
}

function legInfo(h1, signal, atr, threshold) {
  const recent = h1.slice(-6);
  const legSize = Math.max(...recent.map(c => c.high)) - Math.min(...recent.map(c => c.low));
  const moveDir = recent[recent.length - 1].close < recent[0].open ? 'SHORT' : 'LONG';
  const legInDirection = moveDir === signal;
  const legATR = legSize / atr;
  const wouldBlock = legInDirection && legATR > threshold;
  return { legSize, legInDirection, legATR, wouldBlock };
}

async function main() {
  const trades = JSON.parse(fs.readFileSync('/tmp/ema_trades.json', 'utf8'));
  const rows = [];
  for (const t of trades) {
    const entryMs = new Date(t.entryTime).getTime();
    const all = await candles(new Date(entryMs - 72 * 3600e3).toISOString(), t.entryTime, 'H1');
    // only candles fully closed before entry (start + 1h <= entry)
    const closed = all.filter(c => c.t + 3600e3 <= entryMs);
    const atr = atr14(closed);
    const base = legInfo(closed, t.signal, atr, 2.0);
    rows.push({ t, atr, legSize: base.legSize, legInDirection: base.legInDirection, legATR: base.legATR });
    await sleep(100);
  }

  // detail table
  console.log('PER-TRADE LEG MEASUREMENT (6× H1 before entry)\n');
  console.log('date'.padEnd(13), 'sig'.padEnd(6), 'pnl'.padStart(6),
    'ATR'.padStart(6), 'legSz'.padStart(7), 'legATR'.padStart(7), 'dir'.padStart(5));
  rows.forEach(r => {
    console.log(
      r.t.entryTime.slice(5, 16), r.t.signal.padEnd(6),
      ('$' + r.t.pnl.toFixed(0)).padStart(6),
      r.atr.toFixed(1).padStart(6),
      ('$' + r.legSize.toFixed(1)).padStart(7),
      r.legATR.toFixed(2).padStart(7),
      (r.legInDirection ? 'WITH' : 'vs').padStart(5));
  });

  // scorecard at thresholds
  const thresholds = [1.5, 2.0, 2.5, 3.0];
  const baseTotal = rows.reduce((s, r) => s + r.t.pnl, 0);
  console.log('\n' + '='.repeat(86));
  console.log('SCORECARD — effect of ENFORCING the leg filter (block when legATR > threshold, in-direction)');
  console.log('='.repeat(86));
  console.log('thresh'.padEnd(8), 'blocked'.padStart(8), 'blkW/blkL'.padStart(11),
    'P&L removed'.padStart(13), 'losses avoided'.padStart(15), 'wins forgone'.padStart(13),
    'NET vs base'.padStart(13));
  for (const th of thresholds) {
    const blocked = rows.filter(r => r.legInDirection && r.legATR > th);
    const blkW = blocked.filter(r => r.t.pnl > 0);
    const blkL = blocked.filter(r => r.t.pnl <= 0);
    const removed = blocked.reduce((s, r) => s + r.t.pnl, 0); // sum of blocked pnl
    const lossesAvoided = blkL.reduce((s, r) => s + r.t.pnl, 0); // negative → becomes +ve benefit
    const winsForgone = blkW.reduce((s, r) => s + r.t.pnl, 0);
    const newTotal = baseTotal - removed;
    console.log(
      th.toFixed(1).padEnd(8),
      String(blocked.length).padStart(8),
      `${blkW.length}/${blkL.length}`.padStart(11),
      ('$' + removed.toFixed(0)).padStart(13),
      ('+$' + Math.abs(lossesAvoided).toFixed(0)).padStart(15),
      ('-$' + winsForgone.toFixed(0)).padStart(13),
      (newTotal >= baseTotal ? '+$' : '-$') + Math.abs(newTotal - baseTotal).toFixed(0).padStart(0));
  }
  console.log('='.repeat(86));
  console.log(`Base (no filter): $${baseTotal.toFixed(0)} over ${rows.length} trades`);

  // show which trades blocked at the live threshold (2.0)
  console.log('\nTrades the LIVE filter (2.0×) would have blocked:');
  rows.filter(r => r.legInDirection && r.legATR > 2.0).forEach(r => {
    console.log(`  ${r.t.entryTime.slice(5, 16)} ${r.t.signal}  legATR=${r.legATR.toFixed(2)}×  pnl=$${r.t.pnl.toFixed(0)}  ${r.t.pnl > 0 ? '❌ (would lose a winner)' : '✅ (would dodge a loser)'}`);
  });
}
main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
