#!/usr/bin/env node
/**
 * Session-filter study: are out-of-hours (22:00-08:00 UK) signals genuinely worse,
 * or does the filter mostly discard good trades in strong trends?
 *
 * Motivated by two live counterfactuals (Aug 10 and Aug 21 2026) where a clean setup
 * fired overnight, was skipped by TRADING_START_HOUR=8, and would have paid 2R. Two
 * anecdotes prove nothing; this replays 24 months and turns them into a distribution.
 *
 * METHOD — deliberately signal-level, not portfolio-level:
 *   Every H1 bar is evaluated INDEPENDENTLY with the real EmaTrendStrategy (dedup reset,
 *   no cooldown, no overlap suppression). That is the only way to compare in-session and
 *   out-of-session fairly: under a sequential run the two sets are drawn from different
 *   cooldown-shifted timelines, so a difference in mean R could just be selection.
 *   The cost is that overlapping signals are serially correlated, so significance comes
 *   from a MONTH-BLOCK bootstrap rather than an iid standard error.
 *
 * Exits replicate the live bracket regime exactly: stop = clamp(ATR*1.5, $2, $20),
 * TP = 2R resting order, no breakeven, no trail. M5 resolution, pessimistic (adverse
 * extreme assumed to hit before the favourable one within a bar).
 *
 * Two realism knobs the earlier engine lacked, both of which bias AGAINST the
 * out-of-session set and so must be modelled or the result is flattering:
 *   SF_DELAY_MIN : the live bot scans every 15 min, so a signal off the H1 close is
 *                  filled up to a scan later, at whatever price. 0 = idealised.
 *   SF_SPREAD_OOS: overnight spreads on gold are wider than London/NY. Charged as an
 *                  extra per-unit cost on out-of-session entries only.
 *
 * Regime is classified from PAST DATA ONLY (trailing return to the signal bar) and
 * reported by tercile rather than a hand-picked "strong trend" threshold, because
 * picking a cutoff that matches the current episode is exactly the snooping the
 * research protocol warns about.
 *
 * Env: SF_SP=<dir> SF_DELAY_MIN=15 SF_SPREAD=0.30 SF_SPREAD_OOS=0.30 SF_BOOT=2000
 * Writes signals_<tag>.json to the scratchpad; prints a report to stdout.
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';

const SP = process.env.SF_SP;
const DELAY_MIN = parseFloat(process.env.SF_DELAY_MIN || '0');
const SPREAD = parseFloat(process.env.SF_SPREAD || '0.30');
const SPREAD_OOS = parseFloat(process.env.SF_SPREAD_OOS || SPREAD);
const NBOOT = parseInt(process.env.SF_BOOT || '2000');
const MAXHOLD_MS = parseFloat(process.env.SF_MAXHOLD_H || '120') * 3600e3;
const TAG = process.env.SF_TAG || 'base';
const WIN = 250;

const silent = { info() {}, error() {}, warn() {}, debug() {} };
const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
const H4 = JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t = M5.map(c => Date.parse(c.time));

const ta = new TechnicalAnalysis(silent);
const strat = new EmaTrendStrategy(silent, ta);
strat.saveState = () => {};

const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);

// UK wall-clock hour, BST-aware — mirrors index.js's Europe/London conversion so the
// study splits on exactly the boundary the live filter uses.
const ukFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/London', hour: 'numeric', hour12: false,
});
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));

function m5After(t) {
  let lo = 0, hi = M5t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (M5t[m] <= t) lo = m + 1; else hi = m; }
  return lo;
}

/** Pure bracket exit: original stop or resting 2R TP, nothing between. */
function manageBracket(isLong, entry, slDist, entryMs) {
  const tpDist = slDist * Config.EMA_TREND_TP_RR;
  const sl = isLong ? entry - slDist : entry + slDist;
  const tp = isLong ? entry + tpDist : entry - tpDist;
  let mfe = 0, mae = 0;
  for (let i = m5After(entryMs); i < M5.length; i++) {
    const b = M5[i], bt = M5t[i];
    if (bt - entryMs > MAXHOLD_MS) {
      const per = isLong ? b.open - entry : entry - b.open;
      return { R: per / slDist, exit: 'TIME', holdH: (bt - entryMs) / 3600e3, mfe, mae };
    }
    const fav = isLong ? b.high - entry : entry - b.low;
    const adv = isLong ? entry - b.low : b.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    const hitSL = isLong ? b.low <= sl : b.high >= sl;
    const hitTP = isLong ? b.high >= tp : b.low <= tp;
    // Pessimistic: if a bar spans both, assume the stop filled first.
    if (hitSL) return { R: -1, exit: 'STOP', holdH: (bt - entryMs) / 3600e3, mfe, mae };
    if (hitTP) return { R: Config.EMA_TREND_TP_RR, exit: 'TP', holdH: (bt - entryMs) / 3600e3, mfe, mae };
  }
  const last = M5[M5.length - 1];
  const per = isLong ? last.close - entry : entry - last.close;
  return { R: per / slDist, exit: 'OPEN', holdH: (M5t[M5.length - 1] - entryMs) / 3600e3, mfe, mae };
}

function collect() {
  const sigs = [];
  const closes = H1.map(c => c.close);
  for (let i = WIN; i < H1.length; i++) {
    const bar = H1[i], bt = Date.parse(bar.time);
    const win = H1.slice(i - WIN + 1, i + 1);
    // HTF must be CLOSED by bar time or the in-progress H4 leaks future price.
    const htf = H4.filter(c => Date.parse(c.time) + 4 * 3600e3 <= bt).slice(-140);
    let analysis;
    try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
    strat.lastSignalCandleTime = null;            // independent evaluation, no dedup
    const res = strat.evaluateSetup(analysis, win, htf);
    if (!res.signal) continue;

    const atr = strat.lastATR;
    const isLong = res.signal === 'LONG';
    const slDist = Math.max(minSL, Math.min(maxSL, atr * Config.EMA_TREND_ATR_SL_MULT));

    // Fill moment: H1 close (= bar start + 1h) plus the scan-latency delay.
    const closeMs = bt + 3600e3;
    const fillMs = closeMs + DELAY_MIN * 60e3;
    let entry = bar.close;
    if (DELAY_MIN > 0) {
      const k = m5After(fillMs - 1);
      if (k >= M5.length) continue;
      entry = M5[k].open;                          // price actually available at the scan
    }

    const hour = ukHour(fillMs);
    const inSession = hour >= Config.TRADING_START_HOUR && hour < Config.TRADING_END_HOUR;

    const m = manageBracket(isLong, entry, slDist, fillMs);
    const cost = (inSession ? SPREAD : SPREAD_OOS) / slDist;
    const R = m.R - cost;

    // Regime, from past data only: trailing returns to this bar.
    const r10d = i >= 240 ? closes[i] / closes[i - 240] - 1 : null;
    const r2d = i >= 48 ? closes[i] / closes[i - 48] - 1 : null;
    const sma200 = closes.slice(i - 199, i + 1).reduce((a, b) => a + b, 0) / 200;

    sigs.push({
      time: bar.time, month: bar.time.slice(0, 7), signal: res.signal, hour, inSession,
      atr, slDist, rsi: analysis.indicators.rsi, adx: analysis.indicators.adx,
      entry, R, exit: m.exit, holdH: m.holdH,
      mfeR: m.mfe / slDist, maeR: m.mae / slDist,
      r10d, r2d, vsSma200: closes[i] / sma200 - 1,
    });
  }
  return sigs;
}

// ---------- statistics ----------
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
function summarise(a) {
  if (!a.length) return { n: 0 };
  const R = a.map(s => s.R);
  const W = R.filter(r => r > 0), L = R.filter(r => r <= 0);
  const gw = W.reduce((x, y) => x + y, 0), gl = -L.reduce((x, y) => x + y, 0);
  return {
    n: a.length, expR: +mean(R).toFixed(3), sumR: +R.reduce((x, y) => x + y, 0).toFixed(1),
    wr: +(100 * W.length / a.length).toFixed(1),
    pf: +(gl ? gw / gl : 99).toFixed(2),
    tpRate: +(100 * a.filter(s => s.exit === 'TP').length / a.length).toFixed(1),
    medHold: +a.map(s => s.holdH).sort((x, y) => x - y)[Math.floor(a.length / 2)].toFixed(1),
  };
}

/** Month-block bootstrap: resample whole calendar months to respect serial correlation. */
function bootDiff(inS, outS, nboot) {
  const months = [...new Set([...inS, ...outS].map(s => s.month))];
  const byMonthIn = {}, byMonthOut = {};
  for (const m of months) { byMonthIn[m] = []; byMonthOut[m] = []; }
  for (const s of inS) byMonthIn[s.month].push(s.R);
  for (const s of outS) byMonthOut[s.month].push(s.R);
  const diffs = [];
  for (let b = 0; b < nboot; b++) {
    const a = [], c = [];
    for (let k = 0; k < months.length; k++) {
      const m = months[Math.floor(Math.random() * months.length)];
      a.push(...byMonthIn[m]); c.push(...byMonthOut[m]);
    }
    if (!a.length || !c.length) continue;
    diffs.push(mean(c) - mean(a));       // out-of-session minus in-session
  }
  diffs.sort((x, y) => x - y);
  const q = p => diffs[Math.floor(p * diffs.length)];
  return { lo: +q(0.05).toFixed(3), mid: +q(0.5).toFixed(3), hi: +q(0.95).toFixed(3),
           pOutWorse: +(diffs.filter(d => d < 0).length / diffs.length).toFixed(3) };
}

/** One-sample month-block CI on mean R of a single set. */
function bootMean(set, nboot) {
  const months = [...new Set(set.map(s => s.month))];
  const by = {}; for (const m of months) by[m] = [];
  for (const s of set) by[s.month].push(s.R);
  const ms = [];
  for (let b = 0; b < nboot; b++) {
    const a = [];
    for (let k = 0; k < months.length; k++) a.push(...by[months[Math.floor(Math.random() * months.length)]]);
    if (a.length) ms.push(mean(a));
  }
  ms.sort((x, y) => x - y);
  return { lo: +ms[Math.floor(0.05 * ms.length)].toFixed(3), hi: +ms[Math.floor(0.95 * ms.length)].toFixed(3) };
}

// ---------- report ----------
const sigs = collect();
fs.writeFileSync(`${SP}/signals_${TAG}.json`, JSON.stringify(sigs));

const inS = sigs.filter(s => s.inSession), outS = sigs.filter(s => !s.inSession);
console.log(`\n=== SESSION FILTER STUDY [${TAG}] ===`);
console.log(`window ${H1[0].time.slice(0, 10)} → ${H1[H1.length - 1].time.slice(0, 10)}   ` +
            `delay ${DELAY_MIN}min   spread in $${SPREAD} / out $${SPREAD_OOS}`);
console.log(`signals: ${sigs.length}  (in-session ${inS.length}, out ${outS.length})\n`);

console.log('OVERALL');
console.table({ 'IN  08-22': summarise(inS), 'OUT 22-08': summarise(outS) });

console.log('\nBY UK HOUR');
const rows = {};
for (let h = 0; h < 24; h++) {
  const a = sigs.filter(s => s.hour === h);
  if (a.length) rows[`${String(h).padStart(2, '0')}:00${h >= 8 && h < 22 ? '' : ' *'}`] =
    { n: a.length, expR: summarise(a).expR, wr: summarise(a).wr, tpRate: summarise(a).tpRate };
}
console.table(rows);
console.log('* = currently blocked by TRADING_START_HOUR/END_HOUR');

console.log('\nBY TRAILING-10-DAY-RETURN TERCILE (regime, past data only)');
const withR = sigs.filter(s => s.r10d !== null).sort((a, b) => a.r10d - b.r10d);
const t1 = Math.floor(withR.length / 3), t2 = Math.floor(2 * withR.length / 3);
const terciles = [
  ['T1 weakest', withR.slice(0, t1)],
  ['T2 middle ', withR.slice(t1, t2)],
  ['T3 strongest', withR.slice(t2)],
];
const treg = {};
for (const [name, set] of terciles) {
  const i2 = set.filter(s => s.inSession), o2 = set.filter(s => !s.inSession);
  treg[name] = {
    range: `${(100 * set[0].r10d).toFixed(1)}%..${(100 * set[set.length - 1].r10d).toFixed(1)}%`,
    nIn: i2.length, expR_IN: summarise(i2).expR,
    nOut: o2.length, expR_OUT: summarise(o2).expR,
  };
}
console.table(treg);

console.log('\nBOOTSTRAP (month-block, %d resamples)'.replace('%d', NBOOT));
const d = bootDiff(inS, outS, NBOOT);
console.log(`  E[R] in-session      : ${summarise(inS).expR}  90% CI ${JSON.stringify(bootMean(inS, NBOOT))}`);
console.log(`  E[R] out-of-session  : ${summarise(outS).expR}  90% CI ${JSON.stringify(bootMean(outS, NBOOT))}`);
console.log(`  diff (out - in)      : ${d.mid}  90% CI [${d.lo}, ${d.hi}]`);
console.log(`  P(out worse than in) : ${d.pOutWorse}`);

console.log('\nDIRECTION SPLIT');
console.table({
  'IN  LONG': summarise(inS.filter(s => s.signal === 'LONG')),
  'IN  SHORT': summarise(inS.filter(s => s.signal === 'SHORT')),
  'OUT LONG': summarise(outS.filter(s => s.signal === 'LONG')),
  'OUT SHORT': summarise(outS.filter(s => s.signal === 'SHORT')),
});
