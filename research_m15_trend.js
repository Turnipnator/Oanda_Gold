#!/usr/bin/env node
/**
 * Part 17 — Does the live EMA Trend rule work one timeframe down (M15 signals, H1 HTF)?
 * Rules pre-registered in research_notes.md Part 17 before any data was fetched.
 *
 * Real EmaTrendStrategy + TechnicalAnalysis with the live VPS env values. Candles are aggregated
 * from Oanda M1 mids; fills and exits on M1 bid/ask via the same simulateBracket the Phase 0
 * labeller uses (spread paid, stop-first on ties, gaps at the open). One position at a time,
 * occupancy set by the primary 2R exit so the 1R/1.5R columns are paired on identical entries.
 *
 * Also runs the H1/H4 live configuration on the same engine as a calibration anchor (H4 buckets
 * are UTC 4h, not Oanda's NY-aligned H4 — diagnostic only).
 *
 * Usage: OANDA_API_KEY=... node research_m15_trend.js <cacheDir>
 * Env:   M15_BOOT=2000
 */
import fs from 'fs';

// Live VPS values (docker exec env, Oct 29 2026) — must be set before config.js is imported.
Object.assign(process.env, {
  EMA_TREND_ADX_MIN: '20', EMA_TREND_RSI_SELL_MIN: '45', EMA_TREND_MAX_SL: '2000', EMA_TREND_MIN_SL: '200',
  EMA_TREND_ATR_SL_MULT: '1.5', EMA_TREND_PULLBACK_PCT: '0.3', EMA_TREND_LEG_FILTER_ENFORCE: 'true',
  EMA_TREND_LEG_FILTER_THRESHOLD: '2.0', EMA_TREND_FAST: '3', EMA_TREND_MEDIUM: '8', EMA_TREND_SLOW: '21',
  EMA_TREND_TP_RR: '2.0', ALLOW_SHORT: 'true', TRADING_START_HOUR: '8', TRADING_END_HOUR: '22',
});
const { default: Config } = await import('./src/config.js');
const { default: TechnicalAnalysis } = await import('./src/technical_analysis.js');
const { default: EmaTrendStrategy } = await import('./src/ema_trend_strategy.js');
const { simulateBracket, firstBarAtOrAfter } = await import('./scripts/label_signals.mjs');

const DIR = process.argv[2];
const FROM = '2024-10-01T00:00:00Z', TO = '2026-10-28T00:00:00Z';
const SPLIT = Date.parse('2025-10-01T00:00:00Z');
const NBOOT = parseInt(process.env.M15_BOOT || '2000');
const KS = [1, 1.5, 2];
const CAP_MS = 48 * 3600e3;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

// ---------- data ----------
async function fetchM1() {
  const file = `${DIR}/XAU_M1_BA.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const rows = [];
  let cursor = FROM;
  for (;;) {
    const u = `https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles?granularity=M1&price=BA&count=5000&from=${encodeURIComponent(cursor)}`;
    let j;
    for (let a = 0; a < 4; a++) {
      try { const r = await fetch(u, { headers: { Authorization: `Bearer ${process.env.OANDA_API_KEY}` } }); j = await r.json(); if (j.candles) break; throw new Error(JSON.stringify(j)); }
      catch (e) { if (a === 3) throw e; await new Promise(r => setTimeout(r, 800 * (a + 1))); }
    }
    const cs = j.candles.filter(c => c.complete && c.time < TO);
    for (const c of cs) {
      const t = Date.parse(c.time);
      if (rows.length && t <= rows[rows.length - 1][0]) continue;
      rows.push([t, +c.bid.o, +c.bid.h, +c.bid.l, +c.bid.c, +c.ask.o, +c.ask.h, +c.ask.l, +c.ask.c]);
    }
    if (j.candles.length < 5000 || !cs.length || j.candles[j.candles.length - 1].time >= TO) break;
    cursor = new Date(rows[rows.length - 1][0] + 60e3).toISOString();
    if (rows.length % 100000 < 5000) process.stderr.write(`  ${rows.length} M1 bars…\n`);
  }
  fs.writeFileSync(file, JSON.stringify(rows));
  return rows;
}

async function fetchOandaH4() {
  const file = `${DIR}/XAU_H4_mid.json`;
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file));
  const u = `https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles?granularity=H4&price=M&count=5000&from=${encodeURIComponent('2024-06-01T00:00:00Z')}`;
  const j = await (await fetch(u, { headers: { Authorization: `Bearer ${process.env.OANDA_API_KEY}` } })).json();
  const out = j.candles.filter(c => c.complete && c.time < TO).map(c => ({ time: c.time, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, complete: true, t: Date.parse(c.time) }));
  fs.writeFileSync(file, JSON.stringify(out));
  return out;
}

function aggregate(rows, ms) {
  const out = [];
  let cur = null;
  for (const r of rows) {
    const b = Math.floor(r[0] / ms) * ms;
    const mo = (r[1] + r[5]) / 2, mh = (r[2] + r[6]) / 2, ml = (r[3] + r[7]) / 2, mc = (r[4] + r[8]) / 2;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, open: mo, high: mh, low: ml, close: mc }; }
    else { cur.high = Math.max(cur.high, mh); cur.low = Math.min(cur.low, ml); cur.close = mc; }
  }
  if (cur) out.push(cur);
  return out.map(c => ({ time: new Date(c.t).toISOString(), open: c.open, high: c.high, low: c.low, close: c.close, complete: true, t: c.t }));
}

// ---------- engine ----------
const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' });
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));

function run(sig, sigMs, htf, htfMs, bars, delayMin, label) {
  const ta = new TechnicalAnalysis(silent);
  const strat = new EmaTrendStrategy(silent, ta);
  strat.saveState = () => {};
  const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL), maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);
  const trades = [];
  let busyUntil = 0, h = 0;
  for (let i = 250; i < sig.length; i++) {
    const closeMs = sig[i].t + sigMs;
    while (h < htf.length && htf[h].t + htfMs <= closeMs) h++;
    const fillMs = closeMs + delayMin * 60e3;
    if (fillMs < busyUntil) continue;
    const hr = ukHour(fillMs);
    if (hr < Config.TRADING_START_HOUR || hr >= Config.TRADING_END_HOUR) continue;
    const win = sig.slice(i - 249, i + 1);
    let analysis;
    try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
    strat.lastSignalCandleTime = null;
    const res = strat.evaluateSetup(analysis, win, htf.slice(Math.max(0, h - 140), h));
    if (!res.signal) continue;
    const slDist = Math.max(minSL, Math.min(maxSL, strat.lastATR * Config.EMA_TREND_ATR_SL_MULT));
    const start = firstBarAtOrAfter(bars, fillMs);
    const R = {}, ex = {};
    let hold = null;
    let ok = true;
    for (const k of KS) {
      const o = simulateBracket(bars, start, res.signal, slDist, k, CAP_MS);
      if (!o) { ok = false; break; }
      R[k] = o.r; ex[k] = o.exitReason;
      if (k === 2) { hold = (o.exitTime - bars[start].t) / 3600e3; busyUntil = o.exitTime + 60e3; }
    }
    if (!ok) break;
    trades.push({ t: fillMs, month: new Date(fillMs).toISOString().slice(0, 7), dir: res.signal, slDist, R, ex, hold });
  }
  return { label, trades };
}

// ---------- stats ----------
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
function boot(trades, k) {
  const months = [...new Set(trades.map(t => t.month))];
  const by = Object.fromEntries(months.map(m => [m, trades.filter(t => t.month === m).map(t => t.R[k])]));
  const d = [];
  for (let b = 0; b < NBOOT; b++) {
    let s = 0, n = 0;
    for (let j = 0; j < months.length; j++) for (const r of by[months[(Math.random() * months.length) | 0]]) { s += r; n++; }
    if (n) d.push(s / n);
  }
  d.sort((x, y) => x - y);
  return [d[Math.floor(0.05 * d.length)], d[Math.floor(0.95 * d.length)]];
}
function report({ label, trades }, nMonths) {
  console.log(`\n--- ${label}: n=${trades.length} (${(trades.length / nMonths).toFixed(1)}/mo), longs ${trades.filter(t => t.dir === 'LONG').length}, median stop $${med(trades.map(t => t.slDist)).toFixed(2)}, median hold ${med(trades.map(t => t.hold)).toFixed(1)}h (2R)`);
  console.log(' TP    E[R]   90% CI              WR%   PF    H1 / H2 E[R]      spread/R');
  for (const k of KS) {
    const R = trades.map(t => t.R[k]);
    const gw = R.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -R.filter(r => r <= 0).reduce((a, b) => a + b, 0);
    const [lo, hi] = boot(trades, k);
    const h1 = mean(trades.filter(t => t.t < SPLIT).map(t => t.R[k])), h2 = mean(trades.filter(t => t.t >= SPLIT).map(t => t.R[k]));
    const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
    console.log(` ${String(k).padEnd(4)} ${f(mean(R))}  [${f(lo)}, ${f(hi)}]  ${(100 * R.filter(r => r > 0).length / R.length).toFixed(0).padStart(4)}  ${(gl ? gw / gl : 99).toFixed(2)}  ${f(h1)} / ${f(h2)}`);
  }
}

// ---------- main ----------
const rows = await fetchM1();
console.log(`M1 bars ${rows.length}  [${new Date(rows[0][0]).toISOString().slice(0, 10)} → ${new Date(rows[rows.length - 1][0]).toISOString().slice(0, 10)}]`);
const toBars = (mid) => rows.map(r => mid
  ? { t: r[0], bo: (r[1] + r[5]) / 2, bh: (r[2] + r[6]) / 2, bl: (r[3] + r[7]) / 2, bc: (r[4] + r[8]) / 2, ao: (r[1] + r[5]) / 2, ah: (r[2] + r[6]) / 2, al: (r[3] + r[7]) / 2, ac: (r[4] + r[8]) / 2 }
  : { t: r[0], bo: r[1], bh: r[2], bl: r[3], bc: r[4], ao: r[5], ah: r[6], al: r[7], ac: r[8] });
const ba = toBars(false), mid = toBars(true);
const M15 = aggregate(rows, 15 * 60e3), H1 = aggregate(rows, 3600e3), H4 = aggregate(rows, 4 * 3600e3);
const nMonths = (rows[rows.length - 1][0] - rows[0][0]) / (30.44 * 86400e3);
const spreadIn = rows.filter(r => { const h = ukHour(r[0]); return h >= 8 && h < 22; }).map(r => r[5] - r[1]);
console.log(`M15 ${M15.length}, H1 ${H1.length}, months ${nMonths.toFixed(1)}, median in-session M1 open spread $${med(spreadIn).toFixed(2)}`);

const primary = run(M15, 15 * 60e3, H1, 3600e3, ba, 1, 'PRIMARY  M15 / H1-HTF, +1 min, bid/ask');
report(primary, nMonths);
report(run(M15, 15 * 60e3, H1, 3600e3, ba, 5, 'ROBUST   M15, +5 min delay'), nMonths);
report(run(M15, 15 * 60e3, H1, 3600e3, mid, 1, 'DIAG     M15, zero spread (mid fills)'), nMonths);
report(run(H1, 3600e3, H4, 4 * 3600e3, ba, 15, 'ANCHOR   live H1 / H4-HTF (UTC buckets), +15 min'), nMonths);
// Oanda's own H4 (NY-aligned) as the HTF, so the anchor matches what the live bot sees.
const H4o = await fetchOandaH4();
const anchor = run(H1, 3600e3, H4o, 4 * 3600e3, ba, 15, 'ANCHOR   live H1 / Oanda H4-HTF, +15 min');
report(anchor, nMonths);
report(run(H1, 3600e3, H4o, 4 * 3600e3, mid, 15, 'ANCHOR   live H1 / Oanda H4, zero spread'), nMonths);
fs.writeFileSync(`${DIR}/h1_anchor_trades.json`, JSON.stringify(anchor.trades));

const P = primary.trades.map(t => t.R[2]);
const [lo] = boot(primary.trades, 2);
const robust = run(M15, 15 * 60e3, H1, 3600e3, ba, 5, '').trades.map(t => t.R[2]);
const crit = {
  a_CI_above_zero: mean(P) > 0 && lo > 0,
  b_both_halves: mean(primary.trades.filter(t => t.t < SPLIT).map(t => t.R[2])) > 0 && mean(primary.trades.filter(t => t.t >= SPLIT).map(t => t.R[2])) > 0,
  c_8_per_month: primary.trades.length / nMonths >= 8,
  d_delay_positive: mean(robust) > 0,
};
console.log('\nPRE-REGISTERED CRITERIA:', crit, '\nVERDICT:', Object.values(crit).every(Boolean) ? 'PASS' : 'FAIL');
fs.writeFileSync(`${DIR}/m15_primary_trades.json`, JSON.stringify(primary.trades));
