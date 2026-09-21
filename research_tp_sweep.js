#!/usr/bin/env node
/**
 * TEST 2 / Part 9b — Does 1R:1R beat the live 2R bracket ON OUR OWN ENTRIES?
 *
 * Part 9 tested the MARKET (strategy-free barrier race) and found gold's up-bias is
 * entirely drift. This tests OUR ENTRIES: take the real EmaTrendStrategy signal set and
 * re-resolve every signal at several TP multiples.
 *
 * DESIGN — PAIRED, and that is the whole point. Every k shares the SAME signal, the SAME
 * entry price and the SAME stop; only the resting target moves. A single M5 walk resolves
 * all k at once. This is why it can see differences that `exit-config-not-the-lever` could
 * not: that study compared sequential portfolio runs where poll-timing noise (+/-£1,500)
 * swamped the config effect. Here the entries are literally the same rows, so the noise
 * cancels and the bootstrap is on the PAIRED DIFFERENCE.
 *
 * Fidelity carried over from research_session_filter.js (the good harness):
 *   - H4 HTF must be CLOSED by bar time (no future leak)
 *   - 15-min scan-latency fill delay, entry at the price actually available
 *   - spread charged per trade, converted to R
 *   - M5 resolution, pessimistic when a bar spans both barriers
 *   - month-block bootstrap (serial correlation), not iid SEs
 *
 * Intrabar ambiguity is NOT neutral across k: a bar spanning both barriers needs range
 * >= (1+k)*slDist, so it is commonest at k=1. Pessimistic assignment therefore penalises
 * the low-k variants hardest -> reported per k, and the whole sweep is re-run optimistic
 * as a bound. A conclusion only counts if it survives both.
 *
 * Env: TP_SP=<dir> TP_DELAY_MIN=15 TP_SPREAD=0.30 TP_BOOT=4000 TP_OPT=0|1 TP_MAXHOLD_H=120
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';

const SP = process.env.TP_SP;
const DELAY_MIN = parseFloat(process.env.TP_DELAY_MIN || '15');
const SPREAD = parseFloat(process.env.TP_SPREAD || '0.30');
const NBOOT = parseInt(process.env.TP_BOOT || '4000');
const OPT = process.env.TP_OPT === '1';           // optimistic intrabar (TP wins ties)
const MAXHOLD_MS = parseFloat(process.env.TP_MAXHOLD_H || '120') * 3600e3;
const KS = [0.75, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0, 4.0];
const WIN = 250;

const silent = { info(){}, error(){}, warn(){}, debug(){} };
const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
const H4 = JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t = M5.map(c => Date.parse(c.time));

const ta = new TechnicalAnalysis(silent);
const strat = new EmaTrendStrategy(silent, ta);
strat.saveState = () => {};
const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);

const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone:'Europe/London', hour:'numeric', hour12:false });
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));
function m5After(t){ let lo=0,hi=M5t.length; while(lo<hi){const m=(lo+hi)>>1; if(M5t[m]<=t) lo=m+1; else hi=m;} return lo; }

/** One M5 walk resolves EVERY k simultaneously -> perfectly paired. */
function manageAll(isLong, entry, slDist, entryMs) {
  const sl = isLong ? entry - slDist : entry + slDist;
  const out = {}, ambig = {};
  let pending = [...KS];
  for (let i = m5After(entryMs); i < M5.length; i++) {
    const b = M5[i], bt = M5t[i];
    if (bt - entryMs > MAXHOLD_MS) {
      const per = (isLong ? b.open - entry : entry - b.open) / slDist;
      for (const k of pending) { out[k] = { R: per, exit: 'TIME', holdH:(bt-entryMs)/3600e3 }; }
      return { out, ambig };
    }
    const hitSL = isLong ? b.low <= sl : b.high >= sl;
    const still = [];
    for (const k of pending) {
      const tp = isLong ? entry + k*slDist : entry - k*slDist;
      const hitTP = isLong ? b.high >= tp : b.low <= tp;
      if (hitTP && hitSL)      { ambig[k]=(ambig[k]||0)+1; out[k]={R: OPT? k : -1, exit: OPT?'TP':'STOP', holdH:(bt-entryMs)/3600e3}; }
      else if (hitTP)          { out[k]={R:k,  exit:'TP',   holdH:(bt-entryMs)/3600e3}; }
      else if (hitSL)          { out[k]={R:-1, exit:'STOP', holdH:(bt-entryMs)/3600e3}; }
      else still.push(k);
    }
    pending = still;
    if (!pending.length) return { out, ambig };
  }
  const last = M5[M5.length-1];
  const per = (isLong ? last.close - entry : entry - last.close) / slDist;
  for (const k of pending) out[k] = { R: per, exit:'OPEN', holdH:(M5t[M5t.length-1]-entryMs)/3600e3 };
  return { out, ambig };
}

// ---------------- collect signals ----------------
const sigs = [];
const ambTot = {};
for (let i = WIN; i < H1.length; i++) {
  const bar = H1[i], bt = Date.parse(bar.time);
  const win = H1.slice(i-WIN+1, i+1);
  const htf = H4.filter(c => Date.parse(c.time) + 4*3600e3 <= bt).slice(-140);
  let analysis;
  try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
  strat.lastSignalCandleTime = null;
  const res = strat.evaluateSetup(analysis, win, htf);
  if (!res.signal) continue;

  const isLong = res.signal === 'LONG';
  const slDist = Math.max(minSL, Math.min(maxSL, strat.lastATR * Config.EMA_TREND_ATR_SL_MULT));
  const fillMs = bt + 3600e3 + DELAY_MIN*60e3;
  const kIdx = m5After(fillMs - 1);
  if (kIdx >= M5.length) continue;
  const entry = M5[kIdx].open;

  const hour = ukHour(fillMs);
  const inSession = hour >= Config.TRADING_START_HOUR && hour < Config.TRADING_END_HOUR;
  const { out, ambig } = manageAll(isLong, entry, slDist, fillMs);
  for (const k of Object.keys(ambig)) ambTot[k] = (ambTot[k]||0) + ambig[k];

  const cost = SPREAD / slDist;
  const R = {}, hold = {}, ex = {};
  for (const k of KS) { R[k] = out[k].R - cost; hold[k] = out[k].holdH; ex[k] = out[k].exit; }
  sigs.push({ time: bar.time, month: bar.time.slice(0,7), signal: res.signal, inSession, slDist, R, hold, ex });
}

// ---------------- stats ----------------
const mean = a => a.reduce((x,y)=>x+y,0)/(a.length||1);
const med  = a => { const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
function row(set, k) {
  const R = set.map(s => s.R[k]);
  const W = R.filter(r=>r>0), L = R.filter(r=>r<=0);
  const gw = W.reduce((x,y)=>x+y,0), gl = -L.reduce((x,y)=>x+y,0);
  const h = med(set.map(s=>s.hold[k]));
  return { k, n:set.length, expR:mean(R), sumR:R.reduce((x,y)=>x+y,0),
    wr:100*W.length/set.length, pf: gl? gw/gl : 99,
    tpRate:100*set.filter(s=>s.ex[k]==='TP').length/set.length, medHold:h,
    rPerDay: mean(R)/(h/24) };
}
function table(set, label) {
  console.log(`\n--- ${label}  (n=${set.length}) ---`);
  console.log(' TP(R)   E[R]     sumR    WR%    PF    TP-hit%  medHold  R/day  £/trade');
  for (const k of KS) {
    const r = row(set, k);
    const gbp = r.expR * 433;                       // live risk ~£433 at a $20 stop
    console.log(` ${String(k).padEnd(6)} ${(r.expR>=0?'+':'')}${r.expR.toFixed(3)}  ${(r.sumR>=0?'+':'')}${r.sumR.toFixed(1).padStart(7)}  ${r.wr.toFixed(1).padStart(5)}  ${r.pf.toFixed(2).padStart(5)}  ${r.tpRate.toFixed(1).padStart(6)}  ${r.medHold.toFixed(1).padStart(6)}h  ${(r.rPerDay>=0?'+':'')}${r.rPerDay.toFixed(3)}  ${(gbp>=0?'+':'')}£${gbp.toFixed(0)}`);
  }
}

/** PAIRED month-block bootstrap: resample months, compare k vs kRef WITHIN each draw. */
function pairedBoot(set, k, kRef) {
  const months = [...new Set(set.map(s=>s.month))];
  const by = {}; for (const m of months) by[m]=[];
  for (const s of set) by[s.month].push(s);
  const d = [];
  for (let b=0;b<NBOOT;b++){
    let a=0,c=0,n=0;
    for (let j=0;j<months.length;j++){
      for (const s of by[months[(Math.random()*months.length)|0]]) { a+=s.R[k]; c+=s.R[kRef]; n++; }
    }
    if(n) d.push((a-c)/n);
  }
  d.sort((x,y)=>x-y);
  return { lo:d[Math.floor(0.05*d.length)], mid:d[Math.floor(0.5*d.length)], hi:d[Math.floor(0.95*d.length)],
           pWorse: d.filter(x=>x<0).length/d.length };
}

const inS = sigs.filter(s=>s.inSession);
console.log(`\n================ TEST 2: TP SWEEP (paired) ================`);
console.log(`delay=${DELAY_MIN}min spread=$${SPREAD} intrabar=${OPT?'OPTIMISTIC':'pessimistic'} maxhold=${MAXHOLD_MS/3600e3}h`);
console.log(`signals ${sigs.length} total, ${inS.length} in-session  [${sigs[0].time.slice(0,10)} -> ${sigs[sigs.length-1].time.slice(0,10)}]`);
console.log(`intrabar-ambiguous bars by k: ${KS.map(k=>`${k}:${ambTot[k]||0}`).join('  ')}`);

table(inS, 'IN-SESSION (live config: 08-22 UK)');
table(inS.filter(s=>s.signal==='LONG'),  'IN-SESSION LONGS ONLY');
table(inS.filter(s=>s.signal==='SHORT'), 'IN-SESSION SHORTS ONLY');

console.log(`\n--- PAIRED bootstrap vs live 2R, in-session (${NBOOT} draws, month blocks) ---`);
console.log(' TP(R)   mean diff vs 2R    90% CI              P(worse than 2R)');
for (const k of KS) {
  if (k === 2.0) { console.log(` 2.0    (reference)`); continue; }
  const b = pairedBoot(inS, k, 2.0);
  const sig = (b.lo>0||b.hi<0) ? '  <- CI excludes 0' : '';
  console.log(` ${String(k).padEnd(6)} ${(b.mid>=0?'+':'')}${b.mid.toFixed(3)}R            [${(b.lo>=0?'+':'')}${b.lo.toFixed(3)}, ${(b.hi>=0?'+':'')}${b.hi.toFixed(3)}]      ${(100*b.pWorse).toFixed(1)}%${sig}`);
}
fs.writeFileSync(`${SP}/tp_sweep_${OPT?'opt':'pess'}.json`, JSON.stringify(sigs));
