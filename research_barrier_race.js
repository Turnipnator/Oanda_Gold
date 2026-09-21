#!/usr/bin/env node
/**
 * TEST 1 — Barrier race (strategy-free). Part 9 of research_notes.
 *
 * QUESTION: from an arbitrary point in gold, is the +X barrier reached before the -X
 * barrier more often than chance (DRIFT = real edge for a 1R:1R long), or merely
 * FASTER (VARIANCE = no edge at symmetric barriers, just quicker round-trips)?
 *
 * Deliberately strategy-free: every H1 close is a sample point, so the result is a
 * property of the MARKET, not of any entry rule. That is the load-bearing claim.
 *
 * Barrier modes:
 *   atr  - 1.5 x ATR(14) clamped [$2,$20]  <- exactly the live stop formula, self-normalising
 *   fix  - flat $20                        <- the live cap; but $20 is 0.77% at $2600 and 0.45% at $4400
 *   pct  - 0.5% of price                   <- scale-free control
 *
 * De-trending: multiplicative deflator D_t = exp(-mu*t), mu = mean M5 log return over the
 * whole sample, applied identically to O/H/L/C of bar t. Preserves intrabar structure
 * exactly while removing the exponential drift. In-sample by construction - it is a
 * DIAGNOSTIC ("is this drift?"), not a tradable rule.
 *
 * Intrabar ambiguity: when one M5 bar spans BOTH barriers we cannot know which came
 * first. Reported as its own bucket and resolved three ways (up / down / excluded); a
 * conclusion only counts if it survives all three.
 *
 * Speed is measured in M5 BARS (market time), not wall-clock, so weekends don't count.
 *
 * Env: SP=<dir> MODE=atr|fix|pct BARRIER=20 DETREND=0|1 MAXBARS=1440 SPREAD=0
 */
import fs from 'fs';
const SP = process.env.SP;
const MODE = process.env.MODE || 'atr';
const BARRIER = parseFloat(process.env.BARRIER || '20');
const DETREND = process.env.DETREND === '1';
const MAXBARS = parseInt(process.env.MAXBARS || '1440');   // 120h of market time
const SPREAD = parseFloat(process.env.SPREAD || '0');
const REGWIN = 120;                                        // 5 trading days of H1

const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
let M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));

// ---- de-trend -------------------------------------------------------------
let mu = 0;
if (DETREND) {
  let s = 0, n = 0;
  for (let i = 1; i < M5.length; i++) { s += Math.log(M5[i].close / M5[i - 1].close); n++; }
  mu = s / n;
  M5 = M5.map((c, i) => { const d = Math.exp(-mu * i);
    return { time: c.time, open: c.open * d, high: c.high * d, low: c.low * d, close: c.close * d }; });
  // H1 closes must be deflated on the SAME clock or entry prices won't line up
  const m5t = M5.map(c => Date.parse(c.time));
  // (H1 deflation handled below via nearest-M5 index)
  global.__m5t = m5t;
}
const M5t = global.__m5t || M5.map(c => Date.parse(c.time));

// ---- ATR(14) on H1 --------------------------------------------------------
const atr = new Array(H1.length).fill(null);
let prevATR = null;
for (let i = 1; i < H1.length; i++) {
  const tr = Math.max(H1[i].high - H1[i].low, Math.abs(H1[i].high - H1[i-1].close), Math.abs(H1[i].low - H1[i-1].close));
  prevATR = prevATR === null ? tr : (prevATR * 13 + tr) / 14;
  if (i >= 14) atr[i] = prevATR;
}

// ---- binary search: first M5 index strictly after time t ------------------
function idxAfter(t) {
  let lo = 0, hi = M5t.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (M5t[m] > t) { ans = m; hi = m - 1; } else lo = m + 1; }
  return ans;
}

const rows = [];
for (let i = REGWIN; i < H1.length; i++) {
  const t = Date.parse(H1[i].time);
  const j0 = idxAfter(t);
  if (j0 < 0) continue;

  // entry price taken from the M5 series so the de-trended run is self-consistent
  const entry = M5[j0].open;
  if (!isFinite(entry)) continue;

  let width;
  if (MODE === 'atr') { if (atr[i] == null) continue; width = Math.min(Math.max(atr[i] * 1.5, 2), 20); }
  else if (MODE === 'pct') width = entry * (BARRIER / 100);
  else width = BARRIER;

  const up = entry + width + SPREAD;
  const dn = entry - width;

  let winner = null, bars = 0, ambig = false;
  for (let j = j0; j < M5.length && (j - j0) < MAXBARS; j++) {
    const hitU = M5[j].high >= up, hitD = M5[j].low <= dn;
    if (hitU || hitD) {
      bars = j - j0 + 1;
      if (hitU && hitD) { ambig = true; winner = 'amb'; }
      else winner = hitU ? 'up' : 'dn';
      break;
    }
  }
  if (!winner) { winner = 'cens'; bars = MAXBARS; }

  // regime from PAST data only: trailing 5-day H1 return to the sample bar
  const trail = (H1[i].close - H1[i - REGWIN].close) / H1[i - REGWIN].close;
  rows.push({ t: H1[i].time, entry, width, winner, bars, trail, ambig });
}

// ---- terciles on trailing return ------------------------------------------
const sorted = rows.map(r => r.trail).sort((a, b) => a - b);
const q1 = sorted[Math.floor(sorted.length / 3)], q2 = sorted[Math.floor(2 * sorted.length / 3)];
const regOf = r => r.trail <= q1 ? 'DOWN' : r.trail <= q2 ? 'FLAT' : 'UP';

function med(a) { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }

function report(set, label) {
  const u = set.filter(r => r.winner === 'up'), d = set.filter(r => r.winner === 'dn');
  const a = set.filter(r => r.winner === 'amb'), c = set.filter(r => r.winner === 'cens');
  const dec = u.length + d.length;
  const p = 100 * u.length / dec;
  // ambiguity sensitivity: assign all-up / all-down / exclude
  const pUp = 100 * (u.length + a.length) / (dec + a.length);
  const pDn = 100 * u.length / (dec + a.length);
  console.log(
    `${label.padEnd(9)} n=${String(set.length).padStart(5)}  P(up first)=${p.toFixed(1)}%` +
    `  [amb->up ${pUp.toFixed(1)}% / amb->dn ${pDn.toFixed(1)}%]` +
    `  medBars up=${String(med(u.map(r=>r.bars))).padStart(4)} dn=${String(med(d.map(r=>r.bars))).padStart(4)}` +
    `  amb=${(100*a.length/set.length).toFixed(1)}% cens=${(100*c.length/set.length).toFixed(1)}%`);
  return { p, n: dec, u: u.length, d: d.length };
}

console.log(`\n=== BARRIER RACE  mode=${MODE}${MODE!=='atr'?`(${BARRIER})`:''} detrend=${DETREND?'YES':'no'} spread=$${SPREAD} maxbars=${MAXBARS} ===`);
if (DETREND) console.log(`    mu = ${(mu*1e6).toFixed(3)}e-6 per M5 bar  (~${(mu*288*365*100).toFixed(1)}%/yr removed)`);
console.log(`    median barrier width $${med(rows.map(r=>r.width)).toFixed(2)}   sample ${rows[0].t.slice(0,10)} -> ${rows[rows.length-1].t.slice(0,10)}\n`);
const all = report(rows, 'ALL');
for (const g of ['DOWN', 'FLAT', 'UP']) report(rows.filter(r => regOf(r) === g), g);

// ---- month-block bootstrap on P(up first) ---------------------------------
const byMonth = {};
for (const r of rows) { const k = r.t.slice(0, 7); (byMonth[k] ||= []).push(r); }
const months = Object.keys(byMonth);
const boot = [];
for (let b = 0; b < 2000; b++) {
  let u = 0, d = 0;
  for (let m = 0; m < months.length; m++) {
    for (const r of byMonth[months[(Math.random() * months.length) | 0]]) {
      if (r.winner === 'up') u++; else if (r.winner === 'dn') d++;
    }
  }
  boot.push(100 * u / (u + d));
}
boot.sort((a, b) => a - b);
console.log(`\n  P(up first) = ${all.p.toFixed(1)}%   90% month-block CI [${boot[100].toFixed(1)}%, ${boot[1900].toFixed(1)}%]   (${months.length} months)`);
console.log(`  break-even for 1R:1R = 50%${SPREAD?` (+spread -> ~${(50+100*SPREAD/(2*med(rows.map(r=>r.width)))).toFixed(1)}%)`:''};  to match live 2R geometry needs ~57.5-61.5%`);
fs.writeFileSync(`${SP}/rows_${MODE}_${DETREND?'dt':'raw'}.json`, JSON.stringify(rows));
