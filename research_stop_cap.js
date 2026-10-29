#!/usr/bin/env node
/**
 * Part 18 — Is the $20 stop cap hurting EMA Trend under the bracket exit?
 * Rules pre-registered in research_notes.md Part 18 before this was run.
 *
 * Signals come from the real EmaTrendStrategy with live env values (H1, Oanda H4 HTF). The cap
 * never touches a signal gate, so one signal set is resolved under every cap: a paired test.
 * Fills/exits on M1 bid/ask via the Phase 0 labeller's simulateBracket.
 *
 * Usage: node research_stop_cap.js <cacheDir>   (needs XAU_M1_BA.json + XAU_H4_mid.json from research_m15_trend.js)
 * Env:   SC_BOOT=4000
 */
import fs from 'fs';

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
const SPLIT = Date.parse('2025-10-01T00:00:00Z');
const NBOOT = parseInt(process.env.SC_BOOT || '4000');
const CAPS = [20, 30, 40, 100];
const CAP_MS = 120 * 3600e3;
const COOLDOWN_MS = 2 * 3600e3;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const rows = JSON.parse(fs.readFileSync(`${DIR}/XAU_M1_BA.json`));
const H4 = JSON.parse(fs.readFileSync(`${DIR}/XAU_H4_mid.json`));
const bars = rows.map(r => ({ t: r[0], bo: r[1], bh: r[2], bl: r[3], bc: r[4], ao: r[5], ah: r[6], al: r[7], ac: r[8] }));
function aggregateH1() {
  const out = []; let cur = null;
  for (const r of rows) {
    const b = Math.floor(r[0] / 3600e3) * 3600e3;
    const mo = (r[1] + r[5]) / 2, mh = (r[2] + r[6]) / 2, ml = (r[3] + r[7]) / 2, mc = (r[4] + r[8]) / 2;
    if (!cur || cur.t !== b) { if (cur) out.push(cur); cur = { t: b, open: mo, high: mh, low: ml, close: mc }; }
    else { cur.high = Math.max(cur.high, mh); cur.low = Math.min(cur.low, ml); cur.close = mc; }
  }
  out.push(cur);
  return out.map(c => ({ ...c, time: new Date(c.t).toISOString(), complete: true }));
}
const H1 = aggregateH1();
const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' });
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));

// ---------- one signal set ----------
const ta = new TechnicalAnalysis(silent);
const strat = new EmaTrendStrategy(silent, ta);
strat.saveState = () => {};
const sigs = [];
let h = 0;
for (let i = 250; i < H1.length; i++) {
  const closeMs = H1[i].t + 3600e3;
  while (h < H4.length && H4[h].t + 4 * 3600e3 <= closeMs) h++;
  const fillMs = closeMs + 15 * 60e3;
  const hr = ukHour(fillMs);
  if (hr < 8 || hr >= 22) continue;
  const win = H1.slice(i - 249, i + 1);
  let analysis;
  try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
  strat.lastSignalCandleTime = null;
  const res = strat.evaluateSetup(analysis, win, H4.slice(Math.max(0, h - 140), h));
  if (!res.signal) continue;
  const start = firstBarAtOrAfter(bars, fillMs);
  const per = {};
  let ok = true;
  for (const cap of CAPS) {
    const sl = Math.max(2, Math.min(cap, strat.lastATR * 1.5));
    const o = simulateBracket(bars, start, res.signal, sl, 2, CAP_MS);
    if (!o) { ok = false; break; }
    per[cap] = { R: o.r, sl, exitMs: o.exitTime, hold: (o.exitTime - bars[start].t) / 3600e3, ex: o.exitReason };
  }
  if (!ok) continue;
  sigs.push({ t: fillMs, month: new Date(fillMs).toISOString().slice(0, 7), dir: res.signal, atr: strat.lastATR, per });
}

// ---------- stats ----------
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
function pairedBoot(set, cap) {
  const months = [...new Set(set.map(s => s.month))];
  const by = Object.fromEntries(months.map(m => [m, set.filter(s => s.month === m)]));
  const d = [];
  for (let b = 0; b < NBOOT; b++) {
    let s = 0, n = 0;
    for (let j = 0; j < months.length; j++) for (const x of by[months[(Math.random() * months.length) | 0]]) { s += x.per[cap].R - x.per[20].R; n++; }
    if (n) d.push(s / n);
  }
  d.sort((x, y) => x - y);
  return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.floor(0.975 * d.length)] };
}
function portfolio(set, cap) {
  const taken = []; let free = 0;
  for (const s of set) { if (s.t < free) continue; taken.push(s); free = s.per[cap].exitMs + COOLDOWN_MS; }
  return taken;
}

const halves = { 'YEAR 1  Oct24-Sep25': sigs.filter(s => s.t < SPLIT), 'RECENT  Oct25-Oct26': sigs.filter(s => s.t >= SPLIT) };
const verdict = {};
console.log(`signals ${sigs.length} in-session  [${new Date(sigs[0].t).toISOString().slice(0, 10)} → ${new Date(sigs[sigs.length - 1].t).toISOString().slice(0, 10)}]`);
for (const [label, set] of Object.entries(halves)) {
  console.log(`\n=== ${label}: ${set.length} signals, median ATR $${med(set.map(s => s.atr)).toFixed(2)}, $20 cap binds on ${set.filter(s => s.atr * 1.5 > 20).length} ===`);
  console.log(' cap    E[R]    WR%  medHold  >24h  worst    paired diff vs $20 [95% CI]     portfolio n  E[R]');
  for (const cap of CAPS) {
    const R = set.map(s => s.per[cap].R);
    const b = cap === 20 ? null : pairedBoot(set, cap);
    const diff = cap === 20 ? 0 : mean(set.map(s => s.per[cap].R - s.per[20].R));
    const port = portfolio(set, cap);
    const pE = mean(port.map(s => s.per[cap].R));
    console.log(` $${String(cap).padEnd(4)} ${f(mean(R))}  ${(100 * R.filter(r => r > 0).length / R.length).toFixed(0).padStart(4)}  ${med(set.map(s => s.per[cap].hold)).toFixed(1).padStart(6)}h  ${(100 * set.filter(s => s.per[cap].hold > 24).length / set.length).toFixed(0).padStart(3)}%  ${Math.min(...R).toFixed(2).padStart(5)}   ` +
      (b ? `${f(diff)} [${f(b.lo)}, ${f(b.hi)}]${b.lo > 0 ? ' *' : '  '}` : '      (baseline)              ') + `       ${String(port.length).padStart(3)}  ${f(pE)}`);
    verdict[cap] = verdict[cap] || {};
    if (label.startsWith('RECENT')) Object.assign(verdict[cap], { a: b && b.lo > 0, b: mean(R) > 0, dPort: pE });
    else verdict[cap].c = diff >= -0.05;
  }
}
console.log('\nPRE-REGISTERED VERDICT');
for (const cap of CAPS.slice(1)) {
  const v = verdict[cap];
  const d = v.dPort > verdict[20].dPort;
  console.log(` $${cap}: a(CI>0)=${v.a} b(E[R]>0)=${v.b} c(yr1 ok)=${v.c} d(portfolio>base)=${d}  → ${v.a && v.b && v.c && d ? 'PASS' : 'FAIL'}`);
}
fs.writeFileSync(`${DIR}/stop_cap_signals.json`, JSON.stringify(sigs));
