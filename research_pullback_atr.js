#!/usr/bin/env node
/**
 * Part 20 — (A) EMA Trend with an ATR-normalised pullback gate on 8 other markets;
 *           (B) independent check of the wider gold stop: 1.5×ATR vs gold's effective capped multiple k, paired.
 * Rules pre-registered in research_notes.md Part 20 (commit b0bd884) before running. Data = Part 19 cache.
 *
 * Engine identical to research_multi_market.js except the pullback gate: each bar sets
 * EMA_TREND_PULLBACK_PCT so that the strategy's own test reads |price − EMA3| ≤ 0.85 × ATR(14).
 *
 * Usage: node research_pullback_atr.js <cacheDir>
 * Env:   MM_BOOT=4000
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
const FROM = '2024-10-01T00:00:00Z', TO = '2026-10-28T00:00:00Z';
const SPLIT = Date.parse('2025-10-01T00:00:00Z');
const NBOOT = parseInt(process.env.MM_BOOT || '4000');
const CAP_MS = 120 * 3600e3;
const COOLDOWN_MS = 2 * 3600e3;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

const MARKETS = [
  ['XAU_USD', 'Gold (ref)'], ['XAG_USD', 'Silver'], ['US30_USD', 'US indices'], ['SPX500_USD', 'US indices'],
  ['NAS100_USD', 'US indices'], ['WTICO_USD', 'Oil'], ['EUR_USD', 'EUR'], ['GBP_USD', 'GBP'], ['USD_JPY', 'JPY'],
];
const OOS = MARKETS.filter(([m]) => m !== 'XAU_USD');
const CLUSTERS = [...new Set(OOS.map(([, c]) => c))];
const GATE_ATR = 0.85;

// ---------- data ----------
const m1File = inst => inst === 'XAU_USD' ? `${DIR}/XAU_M1_BA.json` : `${DIR}/${inst}_M1_BA.json`;
const h4File = inst => inst === 'XAU_USD' ? `${DIR}/XAU_H4_mid.json` : `${DIR}/${inst}_H4_mid.json`;
async function getJSON(u) {
  for (let a = 0; ; a++) {
    try {
      const j = await (await fetch(u, { headers: { Authorization: `Bearer ${process.env.OANDA_API_KEY}` } })).json();
      if (j.candles) return j;
      throw new Error(JSON.stringify(j).slice(0, 200));
    } catch (e) { if (a === 4) throw e; await new Promise(r => setTimeout(r, 1000 * (a + 1))); }
  }
}
async function fetchM1(inst) {
  if (fs.existsSync(m1File(inst))) return;
  const rows = [];
  let cursor = FROM;
  for (;;) {
    const j = await getJSON(`https://api-fxpractice.oanda.com/v3/instruments/${inst}/candles?granularity=M1&price=BA&count=5000&from=${encodeURIComponent(cursor)}`);
    const cs = j.candles.filter(c => c.complete && c.time < TO);
    for (const c of cs) {
      const t = Date.parse(c.time);
      if (rows.length && t <= rows[rows.length - 1][0]) continue;
      rows.push([t, +c.bid.o, +c.bid.h, +c.bid.l, +c.bid.c, +c.ask.o, +c.ask.h, +c.ask.l, +c.ask.c]);
    }
    if (j.candles.length < 5000 || !cs.length || j.candles[j.candles.length - 1].time >= TO) break;
    cursor = new Date(rows[rows.length - 1][0] + 60e3).toISOString();
  }
  fs.writeFileSync(m1File(inst), JSON.stringify(rows));
  process.stderr.write(`  ${inst}: ${rows.length} M1 bars\n`);
}
async function fetchH4(inst) {
  if (fs.existsSync(h4File(inst))) return;
  const j = await getJSON(`https://api-fxpractice.oanda.com/v3/instruments/${inst}/candles?granularity=H4&price=M&count=5000&from=${encodeURIComponent('2024-06-01T00:00:00Z')}`);
  const out = j.candles.filter(c => c.complete && c.time < TO).map(c => ({ time: c.time, open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c, complete: true, t: Date.parse(c.time) }));
  fs.writeFileSync(h4File(inst), JSON.stringify(out));
}

const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hourCycle: 'h23' });
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));

// ---------- one market: every signal, resolved under each stop/spread variant ----------
function runMarket(inst, gate, k = null) {
  const rows = JSON.parse(fs.readFileSync(m1File(inst)));
  const H4 = JSON.parse(fs.readFileSync(h4File(inst)));
  const bars = rows.map(r => ({ t: r[0], bo: r[1], bh: r[2], bl: r[3], bc: r[4], ao: r[5], ah: r[6], al: r[7], ac: r[8] }));
  const mid = bars.map(b => { const o = (b.bo + b.ao) / 2, h = (b.bh + b.ah) / 2, l = (b.bl + b.al) / 2, c = (b.bc + b.ac) / 2;
    return { t: b.t, bo: o, bh: h, bl: l, bc: c, ao: o, ah: h, al: l, ac: c }; });
  const H1 = []; let cur = null;
  for (const b of mid) {
    const k = Math.floor(b.t / 3600e3) * 3600e3;
    if (!cur || cur.t !== k) { if (cur) H1.push(cur); cur = { t: k, open: b.bo, high: b.bh, low: b.bl, close: b.bc }; }
    else { cur.high = Math.max(cur.high, b.bh); cur.low = Math.min(cur.low, b.bl); cur.close = b.bc; }
  }
  H1.push(cur);
  for (const c of H1) { c.time = new Date(c.t).toISOString(); c.complete = true; }

  const ta = new TechnicalAnalysis(silent);
  const strat = new EmaTrendStrategy(silent, ta);
  strat.saveState = () => {};
  const sigs = [];
  let h = 0;
  for (let i = 250; i < H1.length; i++) {
    const closeMs = H1[i].t + 3600e3;
    while (h < H4.length && H4[h].t + 4 * 3600e3 <= closeMs) h++;
    const fillMs = closeMs + 15 * 60e3;
    const win = H1.slice(i - 249, i + 1);
    let analysis;
    try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
    if (gate === 'atr') {
      const atrNow = ta.calculateATR(win, 14).at(-1), emaNow = ta.calculateEMA(win, 3).at(-1);
      if (!atrNow || !emaNow) continue;
      Config.EMA_TREND_PULLBACK_PCT = 100 * GATE_ATR * atrNow / emaNow;
    } else Config.EMA_TREND_PULLBACK_PCT = 0.3;
    strat.lastSignalCandleTime = null;
    const res = strat.evaluateSetup(analysis, win, H4.slice(Math.max(0, h - 140), h));
    if (!res.signal) continue;
    const start = firstBarAtOrAfter(bars, fillMs);
    if (start >= bars.length || bars[start].t - fillMs > 6 * 3600e3) continue;   // market closed for hours: no realistic fill
    const atr = strat.lastATR;
    const sl = 1.5 * atr;
    const o = simulateBracket(bars, start, res.signal, sl, 2, CAP_MS);
    const z = simulateBracket(mid, start, res.signal, sl, 2, CAP_MS);
    const ok = k ? simulateBracket(bars, start, res.signal, k * atr, 2, CAP_MS) : null;
    if (!o || !z || (k && !ok)) continue;
    const s = { t: fillMs, month: new Date(fillMs).toISOString().slice(0, 7), inSession: (hr => hr >= 8 && hr < 22)(ukHour(fillMs)),
      dir: res.signal, atr, Rk: ok ? ok.r : null, R: o.r, Rz: z.r, exitMs: o.exitTime, hold: (o.exitTime - bars[start].t) / 3600e3,
      spreadFrac: (bars[start].ao - bars[start].bo) / sl, pullATR: 0.003 * H1[i].close / atr };
    if (inst === 'XAU_USD') {
      const slc = Math.max(2, Math.min(20, sl));
      const oc = simulateBracket(bars, start, res.signal, slc, 2, CAP_MS);
      if (!oc) continue;
      Object.assign(s, { Rc: oc.r, exitMsC: oc.exitTime });
    }
    sigs.push(s);
  }
  const months = (Date.parse(TO) - Date.parse(H1[250].time)) / (30.44 * 86400e3);
  return { sigs, months };
}

function portfolio(sigs, { session = true, exitKey = 'exitMs' } = {}) {
  const taken = []; let free = 0;
  for (const s of sigs) {
    if (session && !s.inSession) continue;
    if (s.t < free) continue;
    taken.push(s); free = s[exitKey] + COOLDOWN_MS;
  }
  return taken;
}

// ---------- stats ----------
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const med = a => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] ?? NaN; };
const pf = a => { const w = a.filter(x => x > 0).reduce((x, y) => x + y, 0), l = -a.filter(x => x < 0).reduce((x, y) => x + y, 0); return l ? w / l : Infinity; };
const f = x => (x >= 0 ? '+' : '') + x.toFixed(3);
function boot(trades, key = 'R') {
  const months = [...new Set(trades.map(s => s.month))];
  const by = Object.fromEntries(months.map(m => [m, trades.filter(s => s.month === m).map(s => s[key])]));
  const d = [];
  for (let b = 0; b < NBOOT; b++) {
    let s = 0, n = 0;
    for (let j = 0; j < months.length; j++) for (const x of by[months[(Math.random() * months.length) | 0]]) { s += x; n++; }
    if (n) d.push(s / n);
  }
  d.sort((x, y) => x - y);
  return { lo: d[Math.floor(0.025 * d.length)], hi: d[Math.floor(0.975 * d.length)] };
}

// ---------- main ----------
// (B) k from gold only, live gate, recent half
const goldLive = runMarket('XAU_USD', 'pct');
const recentGold = goldLive.sigs.filter(s => s.t >= SPLIT && s.inSession);
const k = med(recentGold.map(s => Math.max(2, Math.min(20, 1.5 * s.atr)) / s.atr));
console.log(`(B) k = ${k.toFixed(3)}  (median capped-stop/ATR over ${recentGold.length} recent in-session gold signals, live gate)\n`);

const res = {};
for (const [m, cluster] of MARKETS) {
  const { sigs, months } = runMarket(m, 'atr', k);
  res[m] = { cluster, sigs, months, port: portfolio(sigs), port24: portfolio(sigs, { session: false }) };
  if (m === 'XAU_USD') res[m].portC = portfolio(sigs, { exitKey: 'exitMsC' });
}

console.log('(A) PER MARKET — ATR pullback gate 0.85×ATR (portfolio: 08–22 UK, one position, 2h cooldown, stop 1.5×ATR, 2R)');
console.log(' market       n   /mo   E[R]    95% CI              WR%   PF    yr1 / recent E[R]   zero-spr  24h E[R] (n)   spread/stop');
for (const [m] of MARKETS) {
  const r = res[m], P = r.port, R = P.map(s => s.R), b = boot(P);
  const y1 = P.filter(s => s.t < SPLIT).map(s => s.R), y2 = P.filter(s => s.t >= SPLIT).map(s => s.R);
  console.log(` ${m.padEnd(11)} ${String(P.length).padStart(3)}  ${(P.length / r.months).toFixed(1).padStart(4)}  ${f(mean(R))}  [${f(b.lo)}, ${f(b.hi)}]  ${(100 * R.filter(x => x > 0).length / R.length).toFixed(0).padStart(4)}  ${pf(R).toFixed(2).padStart(4)}   ${f(mean(y1))} / ${f(mean(y2))}    ${f(mean(P.map(s => s.Rz)))}   ${f(mean(r.port24.map(s => s.R)))} (${r.port24.length})   ${med(P.map(s => s.spreadFrac)).toFixed(3).padStart(6)}`);
}
{
  const P = res.XAU_USD.portC.map(s => ({ ...s, R: s.Rc })), b = boot(P);
  console.log(` XAU_USD (ATR gate) with live $2–$20 clamp: n ${P.length}, E[R] ${f(mean(P.map(s => s.R)))} [${f(b.lo)}, ${f(b.hi)}]`);
}
console.log('\nCLUSTERS (out-of-sample)');
const clusterE = {};
for (const c of CLUSTERS) {
  const P = OOS.filter(([, x]) => x === c).flatMap(([m]) => res[m].port);
  clusterE[c] = mean(P.map(s => s.R));
  const b = boot(P);
  console.log(` ${c.padEnd(11)} n ${String(P.length).padStart(3)}  E[R] ${f(clusterE[c])}  [${f(b.lo)}, ${f(b.hi)}]`);
}
const pooled = OOS.flatMap(([m]) => res[m].port);
const pb = boot(pooled), pz = boot(pooled, 'Rz');
const y1 = pooled.filter(s => s.t < SPLIT), y2 = pooled.filter(s => s.t >= SPLIT);
console.log(`\nPOOLED out-of-sample: n ${pooled.length} (${(pooled.length / res.EUR_USD.months).toFixed(1)}/mo), E[R] ${f(mean(pooled.map(s => s.R)))} [${f(pb.lo)}, ${f(pb.hi)}], WR ${(100 * pooled.filter(s => s.R > 0).length / pooled.length).toFixed(0)}%, PF ${pf(pooled.map(s => s.R)).toFixed(2)}`);
console.log(`   halves: yr1 n ${y1.length} ${f(mean(y1.map(s => s.R)))} / recent n ${y2.length} ${f(mean(y2.map(s => s.R)))}   zero spread ${f(mean(pooled.map(s => s.Rz)))} [${f(pz.lo)}, ${f(pz.hi)}]`);
const nPos = CLUSTERS.filter(c => clusterE[c] > 0).length;
const a = pb.lo > 0, bOK = nPos >= 4, cOK = mean(y1.map(s => s.R)) > 0 && mean(y2.map(s => s.R)) > 0;
console.log(`(A) PRE-REGISTERED VERDICT: a(CI>0)=${a} b(clusters>0: ${nPos}/6 ≥4)=${bOK} c(both halves>0)=${cOK}  → ${a && bOK && cOK ? 'PASS' : 'FAIL'}`);

// (B) paired stop width, all in-session signals
const diffRows = sigs => sigs.filter(s => s.inSession).map(s => ({ month: s.month, t: s.t, d: s.R - s.Rk }));
console.log(`\n(B) PAIRED STOP WIDTH — 1.5×ATR minus ${k.toFixed(2)}×ATR, per signal, all in-session signals (ATR gate)`);
const cl = {};
for (const [m, c] of OOS) { (cl[c] ||= []).push(...diffRows(res[m].sigs)); }
const bClusters = {};
for (const c of CLUSTERS) {
  const D = cl[c], b = boot(D, 'd'); bClusters[c] = mean(D.map(x => x.d));
  console.log(` ${c.padEnd(11)} n ${String(D.length).padStart(4)}  diff ${f(bClusters[c])}  [${f(b.lo)}, ${f(b.hi)}]`);
}
const allD = Object.values(cl).flat(), bb = boot(allD, 'd');
const bPos = CLUSTERS.filter(c => bClusters[c] > 0).length;
console.log(` POOLED      n ${allD.length}  diff ${f(mean(allD.map(x => x.d)))}  [${f(bb.lo)}, ${f(bb.hi)}]   halves ${f(mean(allD.filter(x => x.t < SPLIT).map(x => x.d)))} / ${f(mean(allD.filter(x => x.t >= SPLIT).map(x => x.d)))}`);
const goldD = diffRows(res.XAU_USD.sigs), gb = boot(goldD, 'd');
console.log(` gold (in-sample, reported only) n ${goldD.length}  diff ${f(mean(goldD.map(x => x.d)))}  [${f(gb.lo)}, ${f(gb.hi)}]`);
// same paired test under the Part 19 gate (reported only)
const p19 = OOS.flatMap(([m]) => diffRows(runMarket(m, 'pct', k).sigs)), b19 = boot(p19, 'd');
console.log(` pooled under Part-19 gate (reported only) n ${p19.length}  diff ${f(mean(p19.map(x => x.d)))}  [${f(b19.lo)}, ${f(b19.hi)}]`);
console.log(`(B) PRE-REGISTERED VERDICT: CI>0=${bb.lo > 0}  clusters>0 ${bPos}/6 ≥4=${bPos >= 4}  → ${bb.lo > 0 && bPos >= 4 ? 'PASS' : 'FAIL'}`);
