#!/usr/bin/env node
/**
 * Part 13 — a friend's "US30 NY open" 5-min opening-range breakout checklist, mechanised.
 *
 * Rules as written: mark the 5-min range at the NY open; trade the break in the direction of
 * the 5-min trend on the 1-min chart; no entry on the 30th minute (wait for the 31st);
 * SL 50 pips, TP 100 pips (close at 90-95%), BE at +50; one entry per day; done by 15:30.
 * Units (user-confirmed): gold $1 = 10 pips -> SL $5 / TP $10. US30: 1 pip = 1 point.
 *
 * The ambiguous rules are a grid, not a choice: range candle, trend definition, entry trigger,
 * BE on/off, cutoff clock, TP 95 vs 100. Everything is reported, so the primary spec (see
 * research_notes.md Part 13, pre-registered) cannot be cherry-picked afterwards.
 *
 * Fills are on real Oanda M1 bid/ask: longs buy the ask and sell the bid, so the spread is
 * charged. When SL and TP fall in the same minute the stop is assumed first (pessimistic).
 *
 * Env: ORB_SP=<dir with XAU_USD_M1.json / US30_USD_M1.json> ORB_SLIP=<extra stop slippage, price>
 *      ORB_BOOT=2000  ORB_PLACEBO=300
 * Data rows: [unixSec, bO,bH,bL,bC, aO,aH,aL,aC, volume]
 */
import fs from 'fs';

const SP = process.env.ORB_SP;
const NBOOT = parseInt(process.env.ORB_BOOT || '2000');
const NPLACEBO = parseInt(process.env.ORB_PLACEBO || '300');
const SPLIT = Date.parse('2025-10-01T00:00:00Z');
const HOLIDAYS = new Set(['2024-11-28', '2024-12-25', '2025-01-01', '2025-01-09', '2025-01-20', '2025-02-17', '2025-04-18',
  '2025-05-26', '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25', '2026-01-01', '2026-01-19',
  '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07']);
const FIXED_SPREAD = parseFloat(process.env.ORB_FIXED_SPREAD || '0');
const POP_R = parseFloat(process.env.ORB_POP_R || '1.5'), POP_V = parseFloat(process.env.ORB_POP_V || '1.5');

const INSTR = {
  XAU_USD: { pip: 0.10, slip: parseFloat(process.env.ORB_SLIP_XAU || '0') },
  US30_USD: { pip: 1.0, slip: parseFloat(process.env.ORB_SLIP_US30 || '0') },
};

// ---------- time helpers (DST-aware, cached per hour) ----------
const fmtCache = new Map();
function wallClock(tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'short',
  });
  const cache = new Map();
  return ms => {
    const h = Math.floor(ms / 3600e3);
    let base = cache.get(h);
    if (!base) {
      const p = Object.fromEntries(f.formatToParts(new Date(h * 3600e3)).map(x => [x.type, x.value]));
      base = { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour) % 24, wd: p.weekday };
      cache.set(h, base);
    }
    const min = Math.floor((ms % 3600e3) / 60e3);
    return { date: base.date, mins: base.hour * 60 + min, wd: base.wd };
  };
}
const ET = wallClock('America/New_York');
const UK = wallClock('Europe/London');

// ---------- per-instrument preprocessing ----------
function prep(inst) {
  const raw = JSON.parse(fs.readFileSync(`${SP}/${inst}_M1.json`));
  const n = raw.length;
  const t = new Float64Array(n), bO = new Float64Array(n), bH = new Float64Array(n), bL = new Float64Array(n),
    bC = new Float64Array(n), aO = new Float64Array(n), aH = new Float64Array(n), aL = new Float64Array(n),
    aC = new Float64Array(n), v = new Float64Array(n), mH = new Float64Array(n), mL = new Float64Array(n),
    mC = new Float64Array(n), etMin = new Int16Array(n), ukMin = new Int16Array(n);
  const etDate = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = raw[i];
    t[i] = r[0] * 1000; bO[i] = r[1]; bH[i] = r[2]; bL[i] = r[3]; bC[i] = r[4];
    aO[i] = r[5]; aH[i] = r[6]; aL[i] = r[7]; aC[i] = r[8]; v[i] = r[9];
    if (FIXED_SPREAD > 0) {   // re-price on a flat broker spread around the Oanda mid (e.g. IG Wall St 2.4)
      const h = FIXED_SPREAD / 2;
      for (const [B, A, j] of [[bO, aO, 1], [bH, aH, 2], [bL, aL, 3], [bC, aC, 4]]) {
        const m = (r[j] + r[j + 4]) / 2; B[i] = m - h; A[i] = m + h;
      }
    }
    mH[i] = (r[2] + r[6]) / 2; mL[i] = (r[3] + r[7]) / 2; mC[i] = (r[4] + r[8]) / 2;
    const e = ET(t[i]); etMin[i] = e.mins; etDate[i] = e.date;
    ukMin[i] = UK(t[i]).mins;
  }

  // M5 bars from M1 mid, then EMAs and swing pivots. trendAt(ms) uses only M5 bars CLOSED by ms.
  const m5 = [];
  for (let i = 0; i < n; i++) {
    const b = Math.floor(t[i] / 300e3);
    const last = m5[m5.length - 1];
    if (!last || last.b !== b) m5.push({ b, h: mH[i], l: mL[i], c: mC[i] });
    else { last.h = Math.max(last.h, mH[i]); last.l = Math.min(last.l, mL[i]); last.c = mC[i]; }
  }
  const ema = p => { const k = 2 / (p + 1); let e = m5[0].c; return m5.map(x => (e = x.c * k + e * (1 - k))); };
  const e20 = ema(20), e50 = ema(50), e200 = ema(200);
  // 2-left/2-right fractal pivots; a pivot at j is only KNOWN once bar j+2 has closed.
  const swingState = new Array(m5.length);
  const sh = [], sl = [];
  for (let j = 0; j < m5.length; j++) {
    const p = j - 2;
    if (p >= 2) {
      const x = m5[p];
      if (x.h > m5[p - 1].h && x.h > m5[p - 2].h && x.h >= m5[p + 1].h && x.h >= m5[p + 2].h) sh.push(x.h);
      if (x.l < m5[p - 1].l && x.l < m5[p - 2].l && x.l <= m5[p + 1].l && x.l <= m5[p + 2].l) sl.push(x.l);
    }
    let s = 0;
    if (sh.length >= 2 && sl.length >= 2) {
      const hh = sh.at(-1) > sh.at(-2), hl = sl.at(-1) > sl.at(-2);
      if (hh && hl) s = 1; else if (!hh && !hl) s = -1;
    }
    swingState[j] = s;
  }
  const m5b = m5.map(x => x.b);
  function trendAt(ms, kind) {
    // last M5 bar whose END <= ms
    const target = Math.floor(ms / 300e3) - 1;
    let lo = 0, hi = m5b.length - 1, j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (m5b[m] <= target) { j = m; lo = m + 1; } else hi = m - 1; }
    if (j < 200) return 0;
    if (kind === 'ema2050') return e20[j] > e50[j] ? 1 : e20[j] < e50[j] ? -1 : 0;
    if (kind === 'ema200') return m5[j].c > e200[j] ? 1 : m5[j].c < e200[j] ? -1 : 0;
    if (kind === 'swing') return swingState[j];
    return 0;
  }

  // Trading days: index of the 09:25 ET bar per NY weekday date.
  const days = [];
  for (let i = 0; i < n; i++) {
    if (etMin[i] === 9 * 60 + 25) {
      const wd = ET(t[i]).wd;
      if (wd === 'Sat' || wd === 'Sun') continue;
      // require a contiguous 09:25..09:34 block (skips holidays / data gaps)
      let ok = i + 9 < n;
      for (let k = 0; ok && k < 10; k++) if (etMin[i + k] !== 9 * 60 + 25 + k || etDate[i + k] !== etDate[i]) ok = false;
      if (ok) days.push(i);
    }
  }
  // Average daily range of the 14 PRIOR New York dates (no look-ahead), for volatility-scaled stops.
  const dayHL = new Map();
  for (let i = 0; i < n; i++) {
    const d = dayHL.get(etDate[i]);
    if (!d) dayHL.set(etDate[i], [mH[i], mL[i]]); else { d[0] = Math.max(d[0], mH[i]); d[1] = Math.min(d[1], mL[i]); }
  }
  const dates = [...dayHL.keys()], adr = new Map();
  for (let k = 14; k < dates.length; k++) {
    let s = 0; for (let j = k - 14; j < k; j++) { const d = dayHL.get(dates[j]); s += d[0] - d[1]; }
    adr.set(dates[k], s / 14);
  }
  return { inst, n, t, bO, bH, bL, bC, aO, aH, aL, aC, v, mH, mL, mC, etMin, ukMin, etDate, days, trendAt, adr, m5, m5b };
}

// ---------- one day ----------
function runDay(D, i925, cfg, pip, slip, dirOverride) {
  const { t, bO, bH, bL, aO, aH, aL, v, mH, mL, mC, etMin, ukMin, etDate } = D;
  const date = etDate[i925];
  const rs = cfg.range === 'A' ? i925 + 5 : i925;      // A: 09:30-09:34, B: 09:25-09:29
  let hi = -Infinity, lo = Infinity;
  for (let k = rs; k < rs + 5; k++) { hi = Math.max(hi, mH[k]); lo = Math.min(lo, mL[k]); }
  const rangeEndMs = t[rs + 4] + 60e3;
  const firstEntryMin = cfg.range === 'A' ? 9 * 60 + 35 : 9 * 60 + 31;

  let dir = cfg.trend === 'none' ? 0 : D.trendAt(rangeEndMs, cfg.trend === 'counter' ? 'ema2050' : cfg.trend);
  if (cfg.trend === 'counter') dir = -dir;
  if (cfg.trend !== 'none' && dir === 0) return null;   // same day set with or without a placebo override
  if (dirOverride !== undefined) dir = dirOverride;

  const cutoffHit = k => cfg.cutoff === 'uk1530' ? ukMin[k] >= 15 * 60 + 30 : etMin[k] >= 15 * 60 + 30;
  // Stop: his 50 pips by default; cfg.stop = ['pips', n] | ['orw', x opening-range width] | ['adr', x avg daily range].
  // Target and BE keep his shape: TP = (tp/50) x stop, BE at +1 x stop.
  let SL = 50 * pip;
  if (cfg.stop) {
    const [kind, x] = cfg.stop;
    if (kind === 'pips') SL = x * pip;
    else if (kind === 'orw') SL = x * (hi - lo);
    else if (kind === 'adr') { const a = D.adr.get(date); if (!a) return null; SL = x * a; }
    if (!(SL > 0)) return null;
  }
  const TP = SL * cfg.tp / 50, BE = SL;

  // ---- find entry ----
  let k = rs + 5, entryIdx = -1, side = 0, entry = 0;
  for (; k < D.n && etDate[k] === date; k++) {
    if (cutoffHit(k)) return null;
    if (etMin[k] < firstEntryMin) continue;
    if (cfg.entry === 'touch') {
      const wantL = dir >= 0, wantS = dir <= 0;
      const hitL = wantL && aH[k] >= hi, hitS = wantS && bL[k] <= lo;
      if (hitL || hitS) {
        side = hitL && hitS ? (dirOverride !== undefined ? dir : -1) : hitL ? 1 : -1; // both in one bar: assume the worse (short) for 'none'
        entry = side === 1 ? Math.max(hi, aO[k]) : Math.min(lo, bO[k]);
        entryIdx = k; break;
      }
    } else {
      const brkL = (dir >= 0) && mC[k] > hi, brkS = (dir <= 0) && mC[k] < lo;
      if (brkL || brkS) {
        if (cfg.entry === 'pop') {
          let rsum = 0, vsum = 0;
          for (let j = k - 20; j < k; j++) { rsum += mH[j] - mL[j]; vsum += v[j]; }
          const isPop = (mH[k] - mL[k]) >= (globalThis.__pop?.[0] ?? POP_R) * rsum / 20 && v[k] >= (globalThis.__pop?.[1] ?? POP_V) * vsum / 20;
          if (!isPop) return null; // first break was a creep -> stand aside for the day
        }
        side = brkL ? 1 : -1;
        if (k + 1 >= D.n || etDate[k + 1] !== date) return null;
        entryIdx = k + 1;
        entry = side === 1 ? aO[entryIdx] : bO[entryIdx];
        break;
      }
    }
  }
  if (entryIdx < 0) return null;

  // ---- manage ----
  let stop = side === 1 ? entry - SL : entry + SL;
  const tgt = side === 1 ? entry + TP : entry - TP;
  let beDone = false, ambiguous = false, exit = null, reason = '';
  for (let j = entryIdx; j < D.n; j++) {
    if (j > entryIdx && (cutoffHit(j) || etDate[j] !== date)) { exit = side === 1 ? bO[j] : aO[j]; reason = 'time'; break; }
    // exit side prices: long exits on bid, short exits on ask
    const xH = side === 1 ? bH[j] : aH[j], xL = side === 1 ? bL[j] : aL[j], xO = side === 1 ? bO[j] : aO[j];
    const slHit = side === 1 ? xL <= stop : xH >= stop;
    const tpHit = side === 1 ? xH >= tgt : xL <= tgt;
    if (slHit && tpHit) ambiguous = true;
    if (slHit) {                                     // pessimistic: stop first
      const gapFill = j > entryIdx && (side === 1 ? xO < stop : xO > stop) ? xO : stop;
      exit = side === 1 ? gapFill - slip : gapFill + slip; reason = beDone ? 'be' : 'sl'; break;
    }
    if (tpHit) { exit = tgt; reason = 'tp'; break; }
    if (cfg.be && !beDone && (side === 1 ? xH >= entry + BE : xL <= entry - BE)) { stop = entry; beDone = true; }
  }
  if (exit === null) return null;
  const R = (side === 1 ? exit - entry : entry - exit) / SL;
  return { date, ms: t[entryIdx], side, entry, exit, R, reason, ambiguous, rangeW: (hi - lo) / pip, etMin: etMin[entryIdx], slUsd: SL };
}

function runAll(D, cfg, dirFn) {
  const p = INSTR[D.inst];
  const out = [];
  for (const i of D.days) {
    const r = runDay(D, i, cfg, p.pip, p.slip, dirFn ? dirFn() : undefined);
    if (r) out.push(r);
  }
  return out;
}

// ---------- stats ----------
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
function stats(tr) {
  const n = tr.length;
  if (!n) return { n: 0 };
  const Rs = tr.map(x => x.R);
  const sum = Rs.reduce((a, b) => a + b, 0);
  const gw = Rs.filter(r => r > 0).reduce((a, b) => a + b, 0), gl = -Rs.filter(r => r < 0).reduce((a, b) => a + b, 0);
  let eq = 0, pk = 0, dd = 0;
  for (const r of Rs) { eq += r; pk = Math.max(pk, eq); dd = Math.max(dd, pk - eq); }
  const h1 = tr.filter(x => x.ms < SPLIT), h2 = tr.filter(x => x.ms >= SPLIT);
  const avg = a => a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : NaN;
  // month-block bootstrap of mean R
  const byM = new Map();
  for (const x of tr) { const m = x.date.slice(0, 7); if (!byM.has(m)) byM.set(m, []); byM.get(m).push(x.R); }
  const months = [...byM.values()];
  const rnd = rng(12345); const means = [];
  for (let b = 0; b < NBOOT; b++) {
    let s = 0, c = 0;
    for (let m = 0; m < months.length; m++) { const mm = months[Math.floor(rnd() * months.length)]; for (const r of mm) { s += r; c++; } }
    means.push(s / c);
  }
  means.sort((a, b) => a - b);
  return {
    n, wr: tr.filter(x => x.R > 0).length / n, avgR: sum / n, sumR: sum, pf: gl ? gw / gl : Infinity, ddR: dd,
    tpRate: tr.filter(x => x.reason === 'tp').length / n, sl: tr.filter(x => x.reason === 'sl').length / n,
    be: tr.filter(x => x.reason === 'be').length / n, time: tr.filter(x => x.reason === 'time').length / n,
    amb: tr.filter(x => x.ambiguous).length, longs: tr.filter(x => x.side === 1).length,
    y1: avg(h1), y2: avg(h2), n1: h1.length, n2: h2.length,
    lo: means[Math.floor(NBOOT * 0.05)], hi: means[Math.floor(NBOOT * 0.95)],
    pNeg: means.filter(m => m <= 0).length / NBOOT,
  };
}

const f = (x, d = 3) => (x === undefined || Number.isNaN(x)) ? '—' : (x >= 0 ? '+' : '') + x.toFixed(d);
const pct = x => (100 * x).toFixed(0) + '%';
function line(label, s) {
  if (!s.n) return `${label.padEnd(44)} n=0`;
  return `${label.padEnd(44)} n=${String(s.n).padStart(3)} WR ${pct(s.wr).padStart(4)} avgR ${f(s.avgR)} [${f(s.lo, 2)},${f(s.hi, 2)}] PF ${s.pf.toFixed(2)} sumR ${f(s.sumR, 1).padStart(6)} DD ${s.ddR.toFixed(1).padStart(4)}R TP ${pct(s.tpRate).padStart(3)} BE ${pct(s.be).padStart(3)} time ${pct(s.time).padStart(3)} | Y1 ${f(s.y1, 2)} (${s.n1}) Y2 ${f(s.y2, 2)} (${s.n2}) amb ${s.amb}`;
}

const PRIMARY_CFG = { range: 'B', trend: 'ema2050', entry: 'close', be: true, cutoff: 'uk1530', tp: 95 };

// ---------- focus mode: robustness of one cluster ----------
if (process.env.ORB_FOCUS) {
  const [inst, range, trend] = process.env.ORB_FOCUS.split(',');
  const D = prep(inst);
  for (const [r, v] of [[1.0, 1.0], [1.25, 1.25], [1.5, 1.5], [1.75, 1.75], [2.0, 2.0], [1.5, 1.0], [1.0, 1.5], [2.0, 1.0], [1.0, 2.0]]) {
    // POP_R/POP_V are consts; re-run in a child would be cleaner, but a closure swap is enough here
    globalThis.__pop = [r, v];
    const tr = runAll(D, { range, trend, entry: 'pop', be: true, cutoff: 'et1530', tp: 95 });
    console.log(line(`pop range>=${r}x vol>=${v}x`, stats(tr)));
    if (r === 1.5 && v === 1.5) {
      const byQ = new Map();
      for (const x of tr) { const q = x.date.slice(0, 4) + 'Q' + (Math.floor((+x.date.slice(5, 7) - 1) / 3) + 1); byQ.set(q, (byQ.get(q) || []).concat(x.R)); }
      console.log('  by quarter: ' + [...byQ].map(([q, a]) => `${q} ${a.length}:${f(a.reduce((s, y) => s + y, 0), 1)}R`).join('  '));
      const top = [...tr].sort((a, b) => b.R - a.R); const ex = tr.length - 3;
      console.log(`  sumR ${f(tr.reduce((s, x) => s + x.R, 0), 1)}; without the 3 best trades: ${f(top.slice(3).reduce((s, x) => s + x.R, 0), 1)} over ${ex}`);
      const L = tr.filter(x => x.side === 1), S = tr.filter(x => x.side === -1), mean = a => a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : NaN;
      console.log(`  longs ${L.length}: avgR ${f(mean(L))}   shorts ${S.length}: avgR ${f(mean(S))}`);
      // drift control: same filter, same days, direction forced long / short
      for (const d of [1, -1]) console.log(`  forced ${d === 1 ? 'LONG ' : 'SHORT'} every eligible day: ` + line('', stats(runAll(D, { range, trend, entry: 'pop', be: true, cutoff: 'et1530', tp: 95 }, () => d))).trim());
    }
  }
  process.exit(0);
}

// ---------- reality check: is best-of-grid special when direction is a coin flip? ----------
if (process.env.ORB_RC) {
  const D = prep(process.env.ORB_RC);
  const cfgs = [];
  for (const range of ['A', 'B']) for (const trend of ['ema2050', 'ema200', 'swing', 'none'])
    for (const entry of ['close', 'pop', 'touch']) for (const be of [true, false])
      for (const cutoff of ['uk1530', 'et1530']) for (const tp of [95, 100]) cfgs.push({ range, trend, entry, be, cutoff, tp });
  const best = dirFn => {
    let m = -Infinity;
    for (const c of cfgs) {
      const tr = runAll(D, c, dirFn ? (() => { const seq = dirFn(); let i = 0; return () => seq[i++]; })() : undefined);
      if (tr.length >= 30) m = Math.max(m, tr.reduce((a, x) => a + x.R, 0) / tr.length);
    }
    return m;
  };
  const obs = best();
  const N = parseInt(process.env.ORB_RC_N || '200'), maxes = [];
  for (let s = 0; s < N; s++) {
    // one coin-flip sequence per seed, shared by every config (trend days AND no-trend days are randomised alike)
    const r = rng(5000 + s); const seq = D.days.map(() => (r() < 0.5 ? 1 : -1));
    // trend !== 'none' configs skip days with no trend; to keep the same day set, the flip only replaces direction
    maxes.push(best(() => seq));
  }
  maxes.sort((a, b) => a - b);
  console.log(`${process.env.ORB_RC}: observed best-of-${cfgs.length} avgR ${f(obs)}; coin-flip best-of-grid median ${f(maxes[N >> 1])}, 95th pct ${f(maxes[Math.floor(N * 0.95)])}; p = ${(maxes.filter(m => m >= obs).length / N).toFixed(3)}`);
  process.exit(0);
}

// ---------- Part 13e: 15-min range + 5-min break-and-retest ----------
function manage(D, entryIdx, side, entry, slDist, tpR, be, date) {
  const { t, bO, bH, bL, aO, aH, aL, etMin, etDate } = D;
  let stop = side === 1 ? entry - slDist : entry + slDist; const tgt = side === 1 ? entry + tpR * slDist : entry - tpR * slDist;
  let beDone = false;
  for (let j = entryIdx; j < D.n; j++) {
    const xO = side === 1 ? bO[j] : aO[j], xH = side === 1 ? bH[j] : aH[j], xL = side === 1 ? bL[j] : aL[j];
    if (j > entryIdx && (etMin[j] >= 15 * 60 + 30 || etDate[j] !== date)) return { exit: xO, reason: 'time' };
    if (side === 1 ? xL <= stop : xH >= stop) {
      const gap = j > entryIdx && (side === 1 ? xO < stop : xO > stop);
      return { exit: gap ? xO : stop, reason: beDone ? 'be' : 'sl' };
    }
    if (side === 1 ? xH >= tgt : xL <= tgt) return { exit: tgt, reason: 'tp' };
    if (be && !beDone && (side === 1 ? xH >= entry + slDist : xL <= entry - slDist)) { stop = entry; beDone = true; }
  }
  return null;
}

function runRetestDay(D, i925, cfg, dirOverride) {
  const { t, mH, mL, mC, aO, bO, etMin, etDate } = D;
  const date = etDate[i925];
  let rs = -1;
  for (let k = Math.max(0, i925 - 130); k < i925 + 10; k++) if (etDate[k] === date && etMin[k] === cfg.start) { rs = k; break; }
  if (rs < 0) return null;
  for (let k = 0; k < 15; k++) if (etMin[rs + k] !== cfg.start + k || etDate[rs + k] !== date) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = rs; k < rs + 15; k++) { hi = Math.max(hi, mH[k]); lo = Math.min(lo, mL[k]); }
  const rangeEndMs = t[rs + 14] + 60e3;
  let dir = cfg.trend === 'none' ? 0 : D.trendAt(rangeEndMs, 'swing');
  if (cfg.trend !== 'none' && dir === 0) return null;
  if (dirOverride !== undefined) dir = dirOverride;
  // 5-min bars aligned to the range start, built from 1-min mids; each remembers the 1-min index after it
  const bars = [];
  for (let k = rs + 15; k < D.n && etDate[k] === date && etMin[k] < 15 * 60 + 30; k++) {
    const b = Math.floor((etMin[k] - cfg.start) / 5);
    const last = bars[bars.length - 1];
    if (!last || last.b !== b) bars.push({ b, h: mH[k], l: mL[k], c: mC[k], next: k + 1 });
    else { last.h = Math.max(last.h, mH[k]); last.l = Math.min(last.l, mL[k]); last.c = mC[k]; last.next = k + 1; }
  }
  let side = 0, brokeAt = -1;
  for (let i = 0; i < bars.length; i++) {
    const x = bars[i];
    if (!side) {
      if ((dir >= 0) && x.c > hi) { side = 1; brokeAt = i; }
      else if ((dir <= 0) && x.c < lo) { side = -1; brokeAt = i; }
      continue;
    }
    if (i - brokeAt > 12) return null;                                   // no retest within an hour
    const lvl = side === 1 ? hi : lo;
    if (side === 1 ? x.c < hi : x.c > lo) return null;                   // closed back inside: failed break
    if (side === 1 ? x.l <= lvl : x.h >= lvl) {                          // retest held
      const e = x.next;
      if (e >= D.n || etDate[e] !== date || etMin[e] >= 15 * 60 + 30) return null;
      const entry = side === 1 ? aO[e] : bO[e];
      const stopPx = cfg.stop === 'opp' ? (side === 1 ? lo : hi) : (hi + lo) / 2;
      const slDist = side === 1 ? entry - stopPx : stopPx - entry;
      if (!(slDist > 0)) return null;
      const ex = manage(D, e, side, entry, slDist, 2, cfg.be, date);
      if (!ex) return null;
      const R = (side === 1 ? ex.exit - entry : entry - ex.exit) / slDist;
      return { date, ms: t[e], side, entry, exit: ex.exit, R, reason: ex.reason, ambiguous: false, slUsd: slDist };
    }
  }
  return null;
}

if (process.env.ORB_RETEST) {
  for (const inst of process.env.ORB_RETEST.split(',')) {
    const D = prep(inst);
    const runR = (cfg, dirFn) => D.days.filter(i => !HOLIDAYS.has(D.etDate[i])).map(i => runRetestDay(D, i, cfg, dirFn ? dirFn() : undefined)).filter(Boolean);
    console.log(`\n================ ${inst} — 15m range + 5m break-and-retest ================`);
    const grid = [];
    for (const start of [570, 500]) for (const trend of ['swing', 'none']) for (const stop of ['opp', 'mid']) for (const be of [false, true]) {
      const cfg = { start, trend, stop, be };
      const tr = runR(cfg), st = stats(tr);
      const sl = tr.map(x => x.slUsd).sort((a, b) => a - b);
      const lab = `${start === 570 ? '09:30' : '08:20'} / ${trend} / ${stop} / ${be ? 'BE' : 'noBE'}${start === 570 && trend === 'swing' && stop === 'opp' && !be ? '  <PRIMARY>' : ''}`;
      console.log(line(lab, st) + `  medStop ${sl[sl.length >> 1]?.toFixed(1)}`);
      grid.push({ cfg, st, tr });
    }
    const prim = grid[0];
    const mean = a => a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : NaN;
    const L = prim.tr.filter(x => x.side === 1), S = prim.tr.filter(x => x.side === -1);
    console.log(`\nPRIMARY detail: longs ${L.length} ${f(mean(L))}  shorts ${S.length} ${f(mean(S))}`);
    for (const d of [1, -1]) console.log(`  forced ${d === 1 ? 'LONG ' : 'SHORT'} on same setup days: avgR ${f(mean(runR(prim.cfg, () => d)))}`);
    const pm = []; for (let k = 0; k < 200; k++) { const r = rng(4000 + k); pm.push(mean(runR(prim.cfg, () => (r() < 0.5 ? 1 : -1)))); }
    console.log(`  coin-flip direction: primary beats ${pct(pm.filter(x => x < prim.st.avgR).length / pm.length)} of 200 runs`);
    const obs = Math.max(...grid.filter(g => g.st.n >= 30).map(g => g.st.avgR)), maxes = [];
    for (let k = 0; k < 100; k++) {
      const r = rng(8000 + k); const seq = D.days.map(() => (r() < 0.5 ? 1 : -1));
      let m = -Infinity;
      for (const g of grid) { let i = 0; const tr = runR(g.cfg, () => seq[i++]); if (tr.length >= 30) m = Math.max(m, mean(tr)); }
      maxes.push(m);
    }
    console.log(`  best-of-16 ${f(obs)} vs coin-flip best-of-16: p = ${(maxes.filter(m => m >= obs).length / maxes.length).toFixed(2)}`);
  }
  process.exit(0);
}

// ---------- export a parity fixture for the IG bot's Python port (src/orb.py) ----------
// ORB_EXPORT=<out.json> [ORB_EXPORT_ALL=1 -> every day]: per day, M1 bid/ask rows 09:05-15:35 NY,
// the last 100 M5 highs/lows closed by 09:35, and this engine's trade for both variants.
if (process.env.ORB_EXPORT) {
  const D = prep('US30_USD');
  const base = { range: 'A', trend: 'swing', be: true, cutoff: 'et1530', tp: 95 };
  const pick = [];
  D.days.forEach((i925, idx) => {
    const pop = runDay(D, i925, { ...base, entry: 'pop' }, 1, 0);
    const plain = runDay(D, i925, { ...base, entry: 'close' }, 1, 0);
    pick.push({ idx, i925, pop, plain });
  });
  let chosen = pick;
  if (!process.env.ORB_EXPORT_ALL) {
    const r = rng(77);
    const popDays = pick.filter(p => p.pop), plainOnly = pick.filter(p => !p.pop && p.plain), none = pick.filter(p => !p.pop && !p.plain);
    const take = (a, k) => a.map(x => [r(), x]).sort((u, w) => u[0] - w[0]).slice(0, k).map(x => x[1]);
    chosen = [...take(popDays, 20), ...take(plainOnly, 10), ...take(none, 6)].sort((a, b) => a.idx - b.idx);
  }
  const R2 = x => Math.round(x * 100) / 100;
  const out = chosen.map(({ i925, pop, plain }) => {
    const date = D.etDate[i925];
    const rows = [];
    for (let k = i925 - 20; k < D.n && (D.etDate[k] === date || k < i925); k++) {
      if (D.etDate[k] === date && D.etMin[k] > 15 * 60 + 35) break;
      rows.push([D.t[k] / 1000, D.bO[k], D.bH[k], D.bL[k], D.bC[k], D.aO[k], D.aH[k], D.aL[k], D.aC[k], D.v[k]]);
    }
    const rangeEnd = D.t[i925 + 9] + 60e3, target = Math.floor(rangeEnd / 300e3) - 1;
    let j = D.m5b.length - 1; while (j >= 0 && D.m5b[j] > target) j--;
    const m5 = D.m5.slice(Math.max(0, j - 99), j + 1);
    const tr = x => x && { side: x.side, entry: x.entry, exit: R2(x.exit), R: Math.round(x.R * 1e4) / 1e4, reason: x.reason, ms: x.ms };
    return { date, trend: D.trendAt(rangeEnd, 'swing'), m5h: m5.map(c => c.h), m5l: m5.map(c => c.l), rows, pop: tr(pop), plain: tr(plain) };
  });
  fs.writeFileSync(process.env.ORB_EXPORT, JSON.stringify(out));
  console.log(`exported ${out.length} days; pop trades ${out.filter(d => d.pop).length}, plain trades ${out.filter(d => d.plain).length}`);
  process.exit(0);
}

// ---------- check one config: quarters, long/short, forced direction, coin-flip placebo ----------
if (process.env.ORB_CHECK) {
  const [inst, range, trend, entry, be, cutoff, sk, sv] = process.env.ORB_CHECK.split(',');
  const D = prep(inst);
  const cfg = { range, trend, entry, be: be === 'BE', cutoff, tp: 95, stop: [sk, parseFloat(sv)] };
  const tr = runAll(D, cfg), st = stats(tr);
  console.log(line(process.env.ORB_CHECK, st));
  const byQ = new Map();
  for (const x of tr) { const q = x.date.slice(0, 4) + 'Q' + (Math.floor((+x.date.slice(5, 7) - 1) / 3) + 1); byQ.set(q, (byQ.get(q) || []).concat(x.R)); }
  console.log('  by quarter: ' + [...byQ].map(([q, a]) => `${q} ${a.length}:${f(a.reduce((s, y) => s + y, 0), 1)}R`).join('  '));
  const mean = a => a.length ? a.reduce((s, x) => s + x.R, 0) / a.length : NaN;
  const L = tr.filter(x => x.side === 1), S = tr.filter(x => x.side === -1);
  console.log(`  longs ${L.length}: ${f(mean(L))}   shorts ${S.length}: ${f(mean(S))}   exits: TP ${pct(st.tpRate)} SL ${pct(st.sl)} time ${pct(st.time)}`);
  for (const d of [1, -1]) console.log(`  forced ${d === 1 ? 'LONG ' : 'SHORT'}: avgR ${f(stats(runAll(D, cfg, () => d)).avgR)}`);
  const pm = [];
  for (let k = 0; k < 300; k++) { const r = rng(9000 + k); pm.push(mean(runAll(D, cfg, () => (r() < 0.5 ? 1 : -1)))); }
  console.log(`  coin-flip direction: beats ${pct(pm.filter(x => x < st.avgR).length / pm.length)} of 300 runs`);
  process.exit(0);
}

// ---------- stop sweep: does a wider gold stop rescue it? ----------
if (process.env.ORB_STOPS) {
  const D = prep(process.env.ORB_STOPS);
  const STOPS = [['pips', 50], ['pips', 75], ['pips', 100], ['pips', 150], ['pips', 200], ['pips', 250],
    ['orw', 1], ['orw', 1.5], ['orw', 2], ['adr', 0.1], ['adr', 0.15], ['adr', 0.2], ['adr', 0.3]];
  const sweep = [];
  for (const stop of STOPS) {
    const lab = stop[0] === 'pips' ? `$${(stop[1] * INSTR[D.inst].pip).toFixed(2)} fixed` : `${stop[1]}x ${stop[0] === 'orw' ? 'open-range' : 'daily-range'}`;
    const prim = runAll(D, { ...PRIMARY_CFG, stop });
    const ps = stats(prim);
    const sl = prim.map(x => x.slUsd).sort((a, b) => a - b);
    const grid = [];
    for (const range of ['A', 'B']) for (const trend of ['ema2050', 'ema200', 'swing', 'none'])
      for (const entry of ['close', 'pop', 'touch']) for (const be of [true, false]) for (const cutoff of ['uk1530', 'et1530']) {
        const cfg = { range, trend, entry, be, cutoff, tp: 95, stop };
        const st = stats(runAll(D, cfg)); if (st.n >= 30) grid.push({ ...cfg, ...st });
      }
    const med = grid.map(g => g.avgR).sort((a, b) => a - b)[grid.length >> 1];
    const best = [...grid].sort((a, b) => b.avgR - a.avgR)[0];
    sweep.push({ lab, ps, grid });
    console.log(`\n== stop ${lab}  (median stop $${sl[sl.length >> 1]?.toFixed(2)})`);
    console.log(line('  primary B/ema2050/close/BE/uk1530', ps));
    console.log(line('  primary but hold to 15:30 ET', stats(runAll(D, { ...PRIMARY_CFG, cutoff: 'et1530', stop }))));
    console.log(`  grid of ${grid.length}: ${grid.filter(g => g.avgR > 0).length} positive, ${grid.filter(g => g.lo > 0).length} with CI>0, median ${f(med)}; best ${best.range}/${best.trend}/${best.entry}/${best.be ? 'BE' : 'noBE'}/${best.cutoff} ${f(best.avgR)} n=${best.n} Y1 ${f(best.y1, 2)} Y2 ${f(best.y2, 2)} L/S ${best.longs}/${best.n - best.longs}`);
  }
  process.exit(0);
}

// ---------- main ----------
const results = [];
const PRIMARY = PRIMARY_CFG;
for (const inst of ['XAU_USD', 'US30_USD']) {
  const D = prep(inst);
  console.log(`\n================ ${inst}: ${D.days.length} NY sessions ================`);

  const prim = runAll(D, PRIMARY);
  const ps = stats(prim);
  console.log('\nPRIMARY (pre-registered):');
  console.log(line('B / ema2050 / close / BE / uk1530 / tp95', ps));
  const rw = prim.map(x => x.rangeW).sort((a, b) => a - b);
  console.log(`  opening-range width (pips): median ${rw[rw.length >> 1]?.toFixed(0)}, p90 ${rw[Math.floor(rw.length * 0.9)]?.toFixed(0)}`);

  // placebo: same rules, random direction each day
  const pm = [];
  for (let s = 0; s < NPLACEBO; s++) { const r = rng(1000 + s); pm.push(stats(runAll(D, PRIMARY, () => (r() < 0.5 ? 1 : -1))).avgR); }
  pm.sort((a, b) => a - b);
  console.log(`  random-direction placebo avgR: median ${f(pm[pm.length >> 1])}, 5-95% [${f(pm[Math.floor(pm.length * 0.05)])}, ${f(pm[Math.floor(pm.length * 0.95)])}]; trend filter beats ${pct(pm.filter(x => x < ps.avgR).length / pm.length)} of placebo runs`);

  console.log('\nGRID (each line = one interpretation):');
  for (const range of ['A', 'B']) for (const trend of ['ema2050', 'ema200', 'swing', 'none', 'counter'])
    for (const entry of ['close', 'pop', 'touch']) for (const be of [true, false])
      for (const cutoff of ['uk1530', 'et1530']) for (const tp of [95, 100]) {
        const cfg = { range, trend, entry, be, cutoff, tp };
        const s = stats(runAll(D, cfg));
        results.push({ inst, ...cfg, ...s });
        if (tp === 95) console.log(line(`${range} / ${trend} / ${entry} / ${be ? 'BE' : 'noBE'} / ${cutoff}`, s));
      }
}
if (SP) fs.writeFileSync(`${SP}/orb_grid.json`, JSON.stringify(results));

console.log('\n================ GRID SUMMARY ================');
for (const inst of ['XAU_USD', 'US30_USD']) {
  const g = results.filter(r => r.inst === inst && r.trend !== 'counter' && r.n >= 30);
  const pos = g.filter(r => r.avgR > 0).length, sig = g.filter(r => r.lo > 0).length;
  const best = [...g].sort((a, b) => b.avgR - a.avgR)[0];
  console.log(`${inst}: ${g.length} interpretations (n>=30, excl. counter-trend placebo): ${pos} with avgR>0, ${sig} with 90% CI above 0. Median avgR ${f(g.map(r => r.avgR).sort((a, b) => a - b)[g.length >> 1])}. Best ${best.range}/${best.trend}/${best.entry}/${best.be ? 'BE' : 'noBE'}/${best.cutoff}/tp${best.tp}: avgR ${f(best.avgR)} n=${best.n} Y1 ${f(best.y1, 2)} Y2 ${f(best.y2, 2)}`);
}
