#!/usr/bin/env node
/**
 * Backtest: EMA Trend breakeven (BE) trigger % and trail distance.
 *
 * Replays the 22 REAL EMA Trend trades bar-by-bar on M5 candles, faithful to the
 * live trade-management logic in src/index.js:
 *   - Initial SL at entry ∓ $8.00, hard TP at entry ± $16.00 (2R)
 *   - Pre-BE: once profit >= activation ($2.00), trail at a FIXED distance (live $0.75)
 *   - BE: once profit >= BE_PCT × TP_dist, SL snaps to entry (overwrites any trailed SL)
 *   - Post-BE: trail at ATR(14,H1) × 1.5  (typically ~$24 — so wide it rarely engages)
 *
 * Stop checks are pessimistic (adverse extreme of the bar tested before the trail is
 * tightened by that same bar's favourable extreme).
 *
 * Units = 100 for every trade, so per-unit price move × 100 ≈ P&L (matches records).
 */
import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';

const HOST = 'https://api-fxpractice.oanda.com';
const KEY = process.env.OANDA_API_KEY;
const H = { Authorization: `Bearer ${KEY}` };
const INSTRUMENT = 'XAU_USD';

const SL_DIST = 8.0;
const TP_DIST = 16.0;
const UNITS = 100;
const ACTIVATION = 2.0;       // $ profit before pre-BE trail activates (live default)
const TRAIL_ATR_MULT = 1.5;   // post-BE trail = ATR × 1.5

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function candles(from, to, granularity) {
  const url = `${HOST}/v3/instruments/${INSTRUMENT}/candles`;
  const params = { from, to, granularity, price: 'M' };
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await axios.get(url, { headers: H, params });
      return (res.data.candles || []).filter(c => c.complete).map(c => ({
        t: c.time,
        o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c,
      }));
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * (attempt + 1));
    }
  }
}

function atr14FromH1(h1) {
  // classic ATR(14) on the H1 candles leading up to entry
  const n = h1.length;
  if (n < 15) return 18.0; // fallback ~ typical gold H1 ATR
  let trs = [];
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      h1[i].h - h1[i].l,
      Math.abs(h1[i].h - h1[i - 1].c),
      Math.abs(h1[i].l - h1[i - 1].c)
    );
    trs.push(tr);
  }
  const last14 = trs.slice(-14);
  return last14.reduce((s, x) => s + x, 0) / last14.length;
}

/**
 * Simulate one trade. Returns per-unit P&L (price terms) and exit label.
 * params: { bePct, preTrail }
 */
function simulate(trade, bars, atr, params) {
  const isLong = trade.signal === 'LONG';
  const entry = trade.entryPrice;
  const beTrigger = params.bePct * TP_DIST;
  // FIXED build caps the post-BE trail to the SL bounds ($2–$8), like the live fix.
  const atrTrail = params.fixed
    ? Math.max(2.0, Math.min(8.0, atr * TRAIL_ATR_MULT))
    : atr * TRAIL_ATR_MULT;

  // SL / TP absolute levels
  let sl = isLong ? entry - SL_DIST : entry + SL_DIST;
  const tp = isLong ? entry + TP_DIST : entry - TP_DIST;
  let beTriggered = false;

  for (const b of bars) {
    // 1) STOP check (pessimistic: uses SL as of start of bar)
    const stopHit = isLong ? b.l <= sl : b.h >= sl;
    if (stopHit) {
      const pnl = isLong ? sl - entry : entry - sl;
      return { pnl, exit: pnl >= 0 ? (beTriggered ? 'TRAIL/BE+' : 'TRAIL+') : 'STOP' };
    }
    // 2) TP check
    const tpHit = isLong ? b.h >= tp : b.l <= tp;
    if (tpHit) return { pnl: TP_DIST, exit: 'TP' };

    // 3) management using this bar's favourable extreme
    const fav = isLong ? b.h : b.l;                       // best price this bar
    const bestProfit = isLong ? fav - entry : entry - fav;

    // BE
    if (!beTriggered && bestProfit >= beTrigger) {
      beTriggered = true;
      if (params.fixed) {
        // monotonic: move to entry only if it tightens the stop (never give back locked profit)
        const beImproves = isLong ? entry > sl : entry < sl;
        if (beImproves) sl = entry;
      } else {
        sl = entry;  // BUGGY live behaviour: snap to entry unconditionally
      }
    }
    // Trail
    const activation = params.activation ?? ACTIVATION;
    const shouldTrail = beTriggered || bestProfit >= activation;
    if (shouldTrail) {
      const trailDist = beTriggered ? atrTrail : params.preTrail;
      const newSL = isLong ? fav - trailDist : fav + trailDist;
      const improved = isLong ? newSL > sl : newSL < sl;
      if (improved) sl = newSL;
    }
  }
  // never resolved within available candles — mark at last close
  const last = bars[bars.length - 1];
  const pnl = isLong ? last.c - entry : entry - last.c;
  return { pnl, exit: 'OPEN(eod)' };
}

async function main() {
  const trades = JSON.parse(fs.readFileSync('/tmp/ema_trades.json', 'utf8'));
  console.log(`Loaded ${trades.length} trades. Fetching candles...\n`);

  // fetch candles for each trade (cache to /tmp)
  const enriched = [];
  for (const t of trades) {
    const entry = new Date(t.entryTime);
    const exit = t.exitTime ? new Date(t.exitTime) : new Date(entry.getTime() + 24 * 3600e3);
    const h1From = new Date(entry.getTime() - 20 * 3600e3).toISOString();
    // cap window at exit+2h, but never request a future time, and cap span at 24h
    const nowSafe = Date.now() - 5 * 60e3;
    // M1 max 5000 bars/req → cap window at 12h (720 bars); trades resolve well within that
    const cap = Math.min(exit.getTime() + 1 * 3600e3, entry.getTime() + 12 * 3600e3, nowSafe);
    const m5To = new Date(cap).toISOString();
    const h1 = await candles(h1From, t.entryTime, 'H1');
    const m5 = await candles(t.entryTime, m5To, 'M1');
    const atr = atr14FromH1(h1);
    enriched.push({ t, m5, atr });
    process.stdout.write(`  ${t.entryTime.slice(5, 16)} ${t.signal}  ATR(H1)=$${atr.toFixed(1)}  M5bars=${m5.length}\n`);
    await sleep(120);
  }
  console.log('');

  // Pre-BE trail width sweep. All use the FIXED management (monotonic BE + capped trail),
  // BE 30%, activation $2.00 (unchanged) — only the pre-BE trail distance varies.
  const variants = [
    { name: 'preTrail $0.75 (current)', bePct: 0.30, preTrail: 0.75, fixed: true },
    { name: 'preTrail $1.50',           bePct: 0.30, preTrail: 1.50, fixed: true },
    { name: 'preTrail $2.00',           bePct: 0.30, preTrail: 2.00, fixed: true },
    { name: 'preTrail $2.00 + act $2.50', bePct: 0.30, preTrail: 2.00, activation: 2.5, fixed: true },
    { name: 'preTrail $2.50',           bePct: 0.30, preTrail: 2.50, fixed: true },
  ];

  // Harness correction: trades that REALLY hit the full stop went straight to it without
  // going favourable — a wider trail cannot save them. The M1 sim "rescues" them on an
  // intrabar wick (the known fidelity gap), so force their actual full-stop outcome.
  // Threshold −$700 ≈ the $8 stop × 100u. Keeps the sweep honest on the winner side.
  const REAL_STOP = -700;

  // validation: variant A total vs actual recorded pnl
  const actualTotal = trades.reduce((s, t) => s + t.pnl, 0);

  const results = {};
  for (const v of variants) {
    let wins = 0, losses = 0, scratch = 0, gw = 0, gl = 0, tpHits = 0;
    const rows = [];
    for (const e of enriched) {
      let r = simulate(e.t, e.m5, e.atr, v);
      // correct the harness's intrabar loser-rescue: real full stops stay full stops
      if (e.t.pnl <= REAL_STOP) r = { pnl: -SL_DIST, exit: 'STOP(real)' };
      const dollar = r.pnl * UNITS;
      if (r.pnl > 0.5) wins++; else if (r.pnl < -0.5) losses++; else scratch++;
      if (dollar > 0) gw += dollar; else gl += dollar;
      if (r.exit === 'TP') tpHits++;
      rows.push({ ...r, dollar });
    }
    const total = rows.reduce((s, r) => s + r.dollar, 0);
    const n = rows.length;
    const wAll = rows.filter(r => r.dollar > 0);
    const lAll = rows.filter(r => r.dollar <= 0);
    const avgW = wAll.length ? wAll.reduce((s, r) => s + r.dollar, 0) / wAll.length : 0;
    const avgL = lAll.length ? lAll.reduce((s, r) => s + r.dollar, 0) / lAll.length : 0;
    results[v.name] = { total, wins, losses, scratch, avgW, avgL, gw, gl, tpHits, rows };
  }

  console.log('VALIDATION: actual recorded total = $' + actualTotal.toFixed(0) +
    '   | sim variant A = $' + results[variants[0].name].total.toFixed(0) +
    '  (close ⇒ model trustworthy)\n');

  console.log('='.repeat(96));
  console.log('VARIANT'.padEnd(40), 'TOTAL'.padStart(9), 'W/L/scr'.padStart(10),
    'avgW'.padStart(8), 'avgL'.padStart(8), 'PF'.padStart(6), 'TPhit'.padStart(6));
  console.log('='.repeat(96));
  for (const v of variants) {
    const r = results[v.name];
    const pf = r.gl !== 0 ? (r.gw / Math.abs(r.gl)) : Infinity;
    console.log(
      v.name.padEnd(40),
      ('$' + r.total.toFixed(0)).padStart(9),
      `${r.wins}/${r.losses}/${r.scratch}`.padStart(10),
      ('$' + r.avgW.toFixed(0)).padStart(8),
      ('$' + r.avgL.toFixed(0)).padStart(8),
      pf.toFixed(2).padStart(6),
      String(r.tpHits).padStart(6),
    );
  }
  console.log('='.repeat(96));

  // per-trade detail: current $0.75 vs widened $2.00 (winners only — losers are invariant)
  console.log('\nPER-TRADE: $0.75 (current) vs $2.00 trail  [winners; real stops excluded]');
  const A = results[variants[0].name].rows;
  const W = results[variants[2].name].rows;
  enriched.forEach((e, i) => {
    if (e.t.pnl <= REAL_STOP) return;
    const d = W[i].dollar - A[i].dollar;
    console.log(
      e.t.entryTime.slice(5, 16), e.t.signal.padEnd(5),
      '$0.75=$' + A[i].dollar.toFixed(0).padStart(5), A[i].exit.padEnd(11),
      ' $2.00=$' + W[i].dollar.toFixed(0).padStart(5), W[i].exit.padEnd(11),
      (d > 0 ? ' Δ +$' + d.toFixed(0) : d < 0 ? ' Δ -$' + Math.abs(d).toFixed(0) : ' Δ 0'),
    );
  });
}

main().catch(e => { console.error(e.response?.data || e.message); process.exit(1); });
