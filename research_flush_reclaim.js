#!/usr/bin/env node
/**
 * Part 15 — "Flush and reclaim": buy a sharp 15-min drop once price reclaims the drop candle's open
 * (mirror for spikes). Rules pre-registered in research_notes.md Part 15 before any results were seen.
 *
 * Signals on M15 mid candles built from M1; fills on real Oanda M1 bid/ask (longs buy the ask, exit on
 * the bid). Stop and TP touched in the same minute = stop first. A stop gapped through fills at the open.
 *
 * Usage: node research_flush_reclaim.js <XAU_USD_M1.json>   (rows: [unixSec, bO,bH,bL,bC, aO,aH,aL,aC, vol])
 * Env:   FR_BOOT=2000  FR_MID=1 (fill at mid: zero-spread check)  FR_DUMP=<file> (primary trades)
 */
import fs from 'fs';

const NBOOT = parseInt(process.env.FR_BOOT || '2000');
const SPLIT = Date.parse('2025-10-01T00:00:00Z');
const raw = JSON.parse(fs.readFileSync(process.argv[2]));
const n = raw.length;
const t = new Float64Array(n), bO = new Float64Array(n), bH = new Float64Array(n), bL = new Float64Array(n),
  bC = new Float64Array(n), aO = new Float64Array(n), aH = new Float64Array(n), aL = new Float64Array(n),
  aC = new Float64Array(n), mO = new Float64Array(n), mH = new Float64Array(n), mL = new Float64Array(n), mC = new Float64Array(n);
for (let i = 0; i < n; i++) {
  const r = raw[i];
  t[i] = r[0] * 1000; bO[i] = r[1]; bH[i] = r[2]; bL[i] = r[3]; bC[i] = r[4]; aO[i] = r[5]; aH[i] = r[6]; aL[i] = r[7]; aC[i] = r[8];
  mO[i] = (r[1] + r[5]) / 2; mH[i] = (r[2] + r[6]) / 2; mL[i] = (r[3] + r[7]) / 2; mC[i] = (r[4] + r[8]) / 2;
  if (process.env.FR_MID) { bO[i] = aO[i] = mO[i]; bH[i] = aH[i] = mH[i]; bL[i] = aL[i] = mL[i]; bC[i] = aC[i] = mC[i]; }   // zero-spread check
}

// ---------- UK wall clock (DST-aware, cached per hour) ----------
const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23', weekday: 'short' });
const ukCache = new Map();
function uk(ms) {
  const h = Math.floor(ms / 3600e3);
  let v = ukCache.get(h);
  if (!v) {
    const p = Object.fromEntries(ukFmt.formatToParts(new Date(h * 3600e3)).map(x => [x.type, x.value]));
    v = { hour: parseInt(p.hour), wd: p.weekday };
    ukCache.set(h, v);
  }
  return v;
}
const inSession = ms => { const u = uk(ms); return u.hour >= 8 && u.hour < 22 && u.wd !== 'Sat' && u.wd !== 'Sun'; };

// ---------- aggregate M1 -> clock-aligned candles ----------
function aggregate(sec) {
  const out = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    const k = Math.floor(t[i] / (sec * 1000));
    if (!cur || cur.k !== k) {
      if (cur) out.push(cur);
      cur = { k, start: k * sec * 1000, end: (k + 1) * sec * 1000, o: mO[i], h: mH[i], l: mL[i], c: mC[i], i0: i, i1: i };
    } else {
      cur.h = Math.max(cur.h, mH[i]); cur.l = Math.min(cur.l, mL[i]); cur.c = mC[i]; cur.i1 = i;
    }
  }
  if (cur) out.push(cur);
  return out;
}
const M15 = aggregate(900);
const H1 = aggregate(3600);
// Wilder ATR(14) on H1, keyed by candle end time; a M15 candle uses the last H1 that closed at or before its end.
{
  let atr = null;
  for (let j = 0; j < H1.length; j++) {
    const c = H1[j], pc = j ? H1[j - 1].c : c.o;
    const tr = Math.max(c.h - c.l, Math.abs(c.h - pc), Math.abs(c.l - pc));
    atr = j < 14 ? (atr === null ? tr : (atr * j + tr) / (j + 1)) : (atr * 13 + tr) / 14;
    c.atr = j >= 14 ? atr : NaN;
  }
}
{
  let j = 0;
  for (const c of M15) {
    while (j + 1 < H1.length && H1[j + 1].end <= c.end) j++;
    c.atr = H1[j].end <= c.end ? H1[j].atr : NaN;
  }
}

// first M1 index with t >= ms, searching forward from a hint
function idxAtOrAfter(ms, from) { let i = from; while (i < n && t[i] < ms) i++; return i; }

// ---------- simulator ----------
// p: { thr: number | 'atr', tpR, stop: 'fixed' | 'extreme', delay (min), reverse, dir: 'both'|'long'|'short' }
function sim(p) {
  const trades = [];
  let busyUntil = 0;
  for (const c of M15) {
    if (c.end < busyUntil) continue;
    const thr = p.thr === 'atr' ? c.atr : p.thr;
    if (!(thr > 0)) continue;
    const down = c.o - c.l >= thr, up = c.h - c.o >= thr;
    if (down === up) continue;
    let setup = down ? 1 : -1;            // +1 = reclaim long, -1 = reclaim short
    if (p.dir === 'long' && setup !== 1) continue;
    if (p.dir === 'short' && setup !== -1) continue;
    // trigger: first M1 in the 30 min after the close whose mid close is back through the candle's open
    let i = c.i1 + 1, trig = -1;
    for (; i < n && t[i] < c.end + 30 * 60e3; i++) {
      if (t[i] < c.end) continue;
      if (setup === 1 ? mC[i] > c.o : mC[i] < c.o) { trig = i; break; }
    }
    if (trig < 0 || !inSession(t[trig])) continue;
    const want = t[trig] + 60e3 + p.delay * 60e3;
    const e = idxAtOrAfter(want, trig + 1);
    if (e >= n || t[e] > want + 10 * 60e3 || t[e] < busyUntil) continue;   // market closed / gap
    const dir = p.reverse ? -setup : setup;
    const entry = dir === 1 ? aO[e] : bO[e];
    let dist;
    if (p.stop === 'fixed') dist = 10;
    else dist = dir === 1 ? entry - (c.l - 1) : (c.h + 1) - entry;
    if (!(dist > 0.5)) continue;
    const stop = entry - dir * dist, tp = entry + dir * p.tpR * dist;
    let exit = NaN, why = 'END', k = e;
    for (; k < n; k++) {
      if (dir === 1) {
        if (bL[k] <= stop) { exit = Math.min(stop, bO[k]); why = 'SL'; break; }
        if (bH[k] >= tp) { exit = tp; why = 'TP'; break; }
      } else {
        if (aH[k] >= stop) { exit = Math.max(stop, aO[k]); why = 'SL'; break; }
        if (aL[k] <= tp) { exit = tp; why = 'TP'; break; }
      }
    }
    if (k >= n) { k = n - 1; exit = dir === 1 ? bC[k] : aC[k]; }
    trades.push({ ms: t[e], dir, entry, exit, why, R: dir * (exit - entry) / dist, dist, hold: (t[k] - t[e]) / 60e3 });
    busyUntil = t[k] + 60e3;
  }
  return trades;
}

// ---------- stats ----------
function monthKey(ms) { const d = new Date(ms); return d.getUTCFullYear() * 12 + d.getUTCMonth(); }
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
function bootCI(tr) {
  const by = new Map();
  for (const x of tr) { const k = monthKey(x.ms); if (!by.has(k)) by.set(k, []); by.get(k).push(x.R); }
  const blocks = [...by.values()];
  if (blocks.length < 3) return [NaN, NaN];
  const means = [];
  for (let b = 0; b < NBOOT; b++) {
    let s = 0, m = 0;
    for (let j = 0; j < blocks.length; j++) { const bl = blocks[Math.floor(rnd() * blocks.length)]; for (const r of bl) { s += r; m++; } }
    means.push(s / m);
  }
  means.sort((a, b) => a - b);
  return [means[Math.floor(0.05 * NBOOT)], means[Math.floor(0.95 * NBOOT)]];
}
function stats(tr) {
  const N = tr.length;
  if (!N) return { N: 0 };
  const sum = tr.reduce((s, x) => s + x.R, 0), win = tr.filter(x => x.R > 0);
  const gw = win.reduce((s, x) => s + x.R, 0), gl = -tr.filter(x => x.R <= 0).reduce((s, x) => s + x.R, 0);
  const h1 = tr.filter(x => x.ms < SPLIT), h2 = tr.filter(x => x.ms >= SPLIT);
  const mean = a => a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : NaN;
  const months = (t[n - 1] - t[0]) / (30.44 * 864e5);
  return {
    N, perMo: N / months, WR: win.length / N, ER: sum / N, PF: gl ? gw / gl : Infinity,
    TP: tr.filter(x => x.why === 'TP').length / N, ci: bootCI(tr), h1: mean(h1), h2: mean(h2),
    medHold: [...tr].sort((a, b) => a.hold - b.hold)[Math.floor(N / 2)].hold,
  };
}
const f = (x, d = 3) => Number.isFinite(x) ? (x >= 0 ? '+' : '') + x.toFixed(d) : '  n/a';
function row(label, tr) {
  const s = stats(tr);
  if (!s.N) return console.log(`${label.padEnd(44)} n=0`);
  console.log(`${label.padEnd(44)} n=${String(s.N).padStart(4)} ${s.perMo.toFixed(1).padStart(5)}/mo WR ${(100 * s.WR).toFixed(0).padStart(2)}% ` +
    `TP ${(100 * s.TP).toFixed(0).padStart(2)}% E[R] ${f(s.ER)} [${f(s.ci[0])}, ${f(s.ci[1])}] PF ${s.PF.toFixed(2)} ` +
    `H1 ${f(s.h1)} H2 ${f(s.h2)} medHold ${Math.round(s.medHold)}m`);
  return s;
}

console.log(`M1 bars ${n}, ${new Date(t[0]).toISOString().slice(0, 10)} -> ${new Date(t[n - 1]).toISOString().slice(0, 10)}, M15 candles ${M15.length}`);
let sp = 0, spN = 0;
for (let i = 0; i < n; i += 7) if (inSession(t[i])) { sp += aO[i] - bO[i]; spN++; }
console.log(`mean in-session spread $${(sp / spN).toFixed(3)}\n`);

const BASE = { thr: 15, tpR: 2, stop: 'fixed', delay: 0, reverse: false, dir: 'both' };
console.log('=== PRIMARY (pre-registered) ===');
const prim = sim(BASE);
const ps = row('$15 flush, $10 stop, 2R, +0 min', prim);
const d5 = row('  same, +5 min delay', sim({ ...BASE, delay: 5 }));
const pass = ps.ci[0] > 0 && ps.h1 > 0 && ps.h2 > 0 && d5.ER > 0;
console.log(`VERDICT: ${pass ? 'PASS' : 'FAIL'} (needs CI low > 0: ${f(ps.ci[0])}, H1 > 0: ${f(ps.h1)}, H2 > 0: ${f(ps.h2)}, +5min > 0: ${f(d5.ER)})\n`);

console.log('=== GRID (reported in full, nothing chosen) ===');
row('long only', sim({ ...BASE, dir: 'long' }));
row('short only', sim({ ...BASE, dir: 'short' }));
row('REVERSE (momentum: trade with the flush)', sim({ ...BASE, reverse: true }));
for (const delay of [15]) row(`+${delay} min delay`, sim({ ...BASE, delay }));
for (const thr of [10, 20, 'atr']) row(`threshold ${thr === 'atr' ? '1.0x H1 ATR' : '$' + thr}`, sim({ ...BASE, thr }));
for (const tpR of [1, 1.5, 3]) row(`TP ${tpR}R`, sim({ ...BASE, tpR }));
row('stop beyond flush extreme -$1, 2R', sim({ ...BASE, stop: 'extreme' }));
row('stop beyond flush extreme -$1, 1R', sim({ ...BASE, stop: 'extreme', tpR: 1 }));
console.log('\n=== FULL threshold x TP x delay sweep (E[R]) ===');
for (const thr of [10, 15, 20, 'atr']) {
  const cells = [];
  for (const tpR of [1, 1.5, 2, 3]) for (const delay of [0, 5]) cells.push(`${tpR}R+${delay}m ${f(stats(sim({ ...BASE, thr, tpR, delay })).ER, 2)}`);
  console.log(`${String(thr).padEnd(4)} ${cells.join('  ')}`);
}

console.log('\n=== Oct 16 2026 (the day that prompted this) ===');
for (const x of prim.filter(x => new Date(x.ms).toISOString().startsWith('2026-10-16')))
  console.log(new Date(x.ms).toISOString().slice(11, 16), 'UTC', x.dir === 1 ? 'LONG' : 'SHORT', x.entry.toFixed(2), '->', x.exit.toFixed(2), x.why, 'R=' + x.R.toFixed(2));
const day = M15.filter(c => new Date(c.start).toISOString().startsWith('2026-10-16'));
console.log('largest M15 drops/spikes that day:', day.map(c => ({ t: new Date(c.start).toISOString().slice(11, 16), dn: +(c.o - c.l).toFixed(1), up: +(c.h - c.o).toFixed(1) }))
  .sort((a, b) => Math.max(b.dn, b.up) - Math.max(a.dn, a.up)).slice(0, 4).map(x => `${x.t} down $${x.dn} / up $${x.up}`).join('; '));

if (process.env.FR_DUMP) fs.writeFileSync(process.env.FR_DUMP, JSON.stringify(prim));
