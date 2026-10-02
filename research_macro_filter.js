#!/usr/bin/env node
/**
 * Part 14 — do US real yields and the dollar add an edge on gold? (pre-registered in
 * research_notes.md before this was run).
 *
 * (A) Daily, 2006-2026: does LAGGED macro (5-day change in the 10y TIPS yield and in a
 *     synthetic DXY) predict gold's next-day return? BULL = both falling, BEAR = both rising.
 * (B) The bot's own in-session EMA-Trend signals (signals_d15.json from
 *     research_session_filter.js, live config, 15-min fill delay): do trades ALIGNED with
 *     the macro state beat OPPOSED ones?
 *
 * No look-ahead: DFII10 is used only for dates strictly before the decision's NY date
 * (it is published after the close). The dollar is DXY rebuilt from Oanda FX with the ICE
 * weights at the decision bar itself. FRED's broad dollar (DTWEXBGS) is weekly-published
 * and was rejected for that reason.
 *
 * Env: MF_SP=<dir with DFII10.csv, *_D.json, *_H1.json, signals_d15.json>  MF_BOOT=2000
 */
import fs from 'fs';

const SP = process.env.MF_SP;
const NBOOT = parseInt(process.env.MF_BOOT || '2000');
const FX = { EUR_USD: -0.576, USD_JPY: 0.136, GBP_USD: -0.119, USD_CAD: 0.091, USD_SEK: 0.042, USD_CHF: 0.036 };

const nyDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const nyOf = ms => nyDate.format(new Date(ms));
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const f = (x, d = 3) => Number.isNaN(x) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d);
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }

// ---------- real yields ----------
const ry = fs.readFileSync(`${SP}/DFII10.csv`, 'utf8').trim().split('\n').slice(1)
  .map(l => l.split(',')).filter(([, v]) => v && v !== '.').map(([d, v]) => ({ d, v: +v }));
function ryChange(beforeDate, k) {
  // last observation with date < beforeDate, minus the one k observations earlier (bp)
  let lo = 0, hi = ry.length - 1, j = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ry[m].d < beforeDate) { j = m; lo = m + 1; } else hi = m - 1; }
  if (j < k) return null;
  return 100 * (ry[j].v - ry[j - k].v);
}

// ---------- synthetic DXY ----------
function dxySeries(gran) {
  const by = {};
  for (const p of Object.keys(FX)) by[p] = new Map(JSON.parse(fs.readFileSync(`${SP}/${p}_${gran}.json`)).map(c => [c.time.slice(0, 19), c.close]));
  const times = [...by.EUR_USD.keys()].filter(t => Object.keys(FX).every(p => by[p].has(t))).sort();
  return times.map(t => ({ ms: Date.parse(t + 'Z'), v: 50.14348112 * Object.entries(FX).reduce((acc, [p, w]) => acc * by[p].get(t) ** w, 1) }));
}

function classify(ryc, usdc) {
  if (ryc == null || usdc == null) return 'NA';
  if (ryc < 0 && usdc < 0) return 'BULL';
  if (ryc > 0 && usdc > 0) return 'BEAR';
  return 'MIXED';
}

// =====================================================================================
// (A) daily predictability, 2006-2026
// =====================================================================================
function partA(lookback) {
  const gold = JSON.parse(fs.readFileSync(`${SP}/XAU_USD_D.json`));
  const dxy = dxySeries('D');
  const dxyByT = new Map(dxy.map(x => [x.ms, x.v]));
  // align on candle start time (all D candles share the 17:00 NY alignment)
  const g = gold.map(c => ({ ms: Date.parse(c.time.slice(0, 19) + 'Z'), c: c.close }))
    .filter(x => dxyByT.has(x.ms));
  const rows = [];
  for (let i = lookback; i < g.length - 1; i++) {
    const closeMs = g[i].ms + 24 * 3600e3;                 // decision at this candle's close (17:00 NY)
    const d = nyOf(closeMs - 60e3);
    const usd = Math.log(dxyByT.get(g[i].ms) / dxyByT.get(g[i - lookback].ms));
    const ryc = ryChange(d, lookback);                      // dates < d only
    const next = Math.log(g[i + 1].c / g[i].c) * 1e4;       // next-day return, bp
    const same = Math.log(g[i].c / g[i - 1].c) * 1e4;
    const usd1 = Math.log(dxyByT.get(g[i].ms) / dxyByT.get(g[i - 1].ms));
    rows.push({ d, year: +d.slice(0, 4), state: classify(ryc, usd), next, same, usd1 });
  }
  const corr = (a, b) => { const ma = mean(a), mb = mean(b); let s = 0, sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; } return s / Math.sqrt(sa * sb); };
  const periods = [['2006-2012', 2006, 2012], ['2013-2019', 2013, 2019], ['2020-2026', 2020, 2026], ['ALL', 0, 9999]];
  console.log(`\n(A) DAILY, lookback ${lookback}d — next-day gold return (bp) by lagged macro state`);
  for (const [lab, y0, y1] of periods) {
    const r = rows.filter(x => x.year >= y0 && x.year <= y1);
    const bull = r.filter(x => x.state === 'BULL').map(x => x.next), bear = r.filter(x => x.state === 'BEAR').map(x => x.next);
    // year-block bootstrap of BULL-BEAR
    const years = [...new Set(r.map(x => x.year))], byY = {};
    for (const x of r) (byY[x.year] = byY[x.year] || []).push(x);
    const rnd = rng(11); const diffs = [];
    for (let b = 0; b < NBOOT; b++) {
      const bu = [], be = [];
      for (let k = 0; k < years.length; k++) for (const x of byY[years[Math.floor(rnd() * years.length)]]) { if (x.state === 'BULL') bu.push(x.next); else if (x.state === 'BEAR') be.push(x.next); }
      diffs.push(mean(bu) - mean(be));
    }
    diffs.sort((a, b) => a - b);
    const cs = corr(r.map(x => x.same), r.map(x => x.usd1));
    console.log(`  ${lab.padEnd(10)} days ${String(r.length).padStart(4)} | BULL ${String(bull.length).padStart(4)} ${f(mean(bull), 2)}bp  BEAR ${String(bear.length).padStart(4)} ${f(mean(bear), 2)}bp | BULL−BEAR ${f(mean(bull) - mean(bear), 2)}bp 90% CI [${f(diffs[Math.floor(NBOOT * .05)], 2)}, ${f(diffs[Math.floor(NBOOT * .95)], 2)}] | same-day corr(gold, DXY) ${f(cs, 2)}`);
  }
}

// =====================================================================================
// (B) the bot's signals
// =====================================================================================
function partB(lookbackDays) {
  const sigs = JSON.parse(fs.readFileSync(`${SP}/signals_d15.json`)).filter(s => s.inSession);
  const dxy = dxySeries('H1');
  const bars = lookbackDays * 24;
  const out = [];
  for (const s of sigs) {
    const decisionMs = Date.parse(s.time) + 3600e3;          // H1 close; fill is 15 min later
    let lo = 0, hi = dxy.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (dxy[m].ms + 3600e3 <= decisionMs) { j = m; lo = m + 1; } else hi = m - 1; }
    const usd = j >= bars ? Math.log(dxy[j].v / dxy[j - bars].v) : null;
    const ryc = ryChange(nyOf(decisionMs), lookbackDays);
    const state = classify(ryc, usd);
    const side = s.signal === 'BUY' ? 1 : -1;
    const align = state === 'BULL' ? (side === 1 ? 'ALIGNED' : 'OPPOSED') : state === 'BEAR' ? (side === -1 ? 'ALIGNED' : 'OPPOSED') : state;
    out.push({ ...s, side, state, align, ryc, usd });
  }
  const months = [...new Set(out.map(s => s.month))].sort();
  const half = months[Math.floor(months.length / 2)];
  const grp = (a, k) => a.filter(s => s.align === k);
  const line = (lab, a) => {
    const R = a.map(s => s.R), gw = R.filter(r => r > 0).reduce((x, y) => x + y, 0), gl = -R.filter(r => r <= 0).reduce((x, y) => x + y, 0);
    return `  ${lab.padEnd(26)} n=${String(a.length).padStart(3)}  E[R] ${f(mean(R))}  WR ${(100 * R.filter(r => r > 0).length / (a.length || 1)).toFixed(0).padStart(3)}%  PF ${(gl ? gw / gl : 0).toFixed(2)}  | H1 ${f(mean(a.filter(s => s.month < half).map(s => s.R)), 2)} (${a.filter(s => s.month < half).length})  H2 ${f(mean(a.filter(s => s.month >= half).map(s => s.R)), 2)} (${a.filter(s => s.month >= half).length})`;
  };
  console.log(`\n(B) BOT SIGNALS (in-session, 15-min delay), lookback ${lookbackDays}d — halves split at ${half}`);
  console.log(line('ALL', out));
  for (const k of ['ALIGNED', 'OPPOSED', 'MIXED', 'NA']) if (grp(out, k).length) console.log(line(k, grp(out, k)));
  console.log(line('ALL minus OPPOSED (filter)', out.filter(s => s.align !== 'OPPOSED')));
  // month-block bootstrap: ALIGNED - OPPOSED, and filtered - all
  const by = {}; for (const m of months) by[m] = out.filter(s => s.month === m);
  const rnd = rng(23); const d1 = [], d2 = [];
  for (let b = 0; b < NBOOT; b++) {
    const smp = []; for (let k = 0; k < months.length; k++) smp.push(...by[months[Math.floor(rnd() * months.length)]]);
    const a = grp(smp, 'ALIGNED').map(s => s.R), o = grp(smp, 'OPPOSED').map(s => s.R);
    if (a.length && o.length) d1.push(mean(a) - mean(o));
    d2.push(mean(smp.filter(s => s.align !== 'OPPOSED').map(s => s.R)) - mean(smp.map(s => s.R)));
  }
  d1.sort((x, y) => x - y); d2.sort((x, y) => x - y);
  const ci = d => `[${f(d[Math.floor(d.length * .05)], 3)}, ${f(d[Math.floor(d.length * .95)], 3)}]`;
  const aH = h => mean(grp(out, 'ALIGNED').filter(s => h ? s.month >= half : s.month < half).map(s => s.R)) - mean(grp(out, 'OPPOSED').filter(s => h ? s.month >= half : s.month < half).map(s => s.R));
  console.log(`  ALIGNED−OPPOSED ${f(mean(grp(out, 'ALIGNED').map(s => s.R)) - mean(grp(out, 'OPPOSED').map(s => s.R)))} 90% CI ${ci(d1)}  (H1 ${f(aH(false), 2)}, H2 ${f(aH(true), 2)})`);
  console.log(`  filter gain (drop OPPOSED) ${f(mean(out.filter(s => s.align !== 'OPPOSED').map(s => s.R)) - mean(out.map(s => s.R)))} 90% CI ${ci(d2)}`);
  // descriptive only (NOT pre-registered): each driver on its own
  const single = (key, lab) => {
    const al = out.filter(s => s[key] != null && Math.sign(-s[key]) === s.side), op = out.filter(s => s[key] != null && Math.sign(s[key]) === s.side);
    return `${lab}: with ${f(mean(al.map(s => s.R)), 2)} (${al.length}) vs against ${f(mean(op.map(s => s.R)), 2)} (${op.length})`;
  };
  console.log(`  [descriptive, not pre-registered] ${single('ryc', 'real yield alone')} | ${single('usd', 'dollar alone')}`);
  return out;
}

partA(5); partA(20);
partB(5); partB(20);
