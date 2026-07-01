#!/usr/bin/env node
/**
 * Faithful EMA Trend backtest engine.
 * ENTRIES: real EmaTrendStrategy.evaluateSetup + real TechnicalAnalysis (same indicator lib).
 * MANAGEMENT: replicated from index.js — SL=clamp(ATR*1.5,min,max); TP=TP_RR*SL;
 *   BE at BE_PCT*TP (monotonic, move-to-entry only if it tightens); pre-BE trail $1.50 armed
 *   at $2 profit; post-BE trail=clamp(ATR*TRAIL_MULT,min,max). Simulated on M5, pessimistic
 *   (adverse extreme resolved before that bar's favourable tighten; SL wins same-bar TP ties).
 *
 * Config knobs come from process.env (Config statics). Extra knobs via env BT_* :
 *   BT_SP=<scratchdir>  BT_FROM / BT_TO (ISO, filter H1 entries)
 *   BT_EXIT = live | tp_only | trail_only | partial1R   (default live)
 *   BT_SPREAD = per-unit cost $ applied to every entry (default 0.30)
 *   BT_COOLDOWN_H (default 2)   BT_MAXHOLD_H (default 120)
 *   BT_NOHTF=1  -> ignore HTF filter (pass null)
 *   BT_VOLMIN / BT_VOLMAX  -> only enter if ATR in [min,max]
 *   BT_HOURMIN / BT_HOURMAX -> only enter if UTC hour in [min,max)
 *   BT_LABEL=<name>
 * Prints one JSON result line to stdout (everything else to stderr).
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';

const SP = process.env.BT_SP;
const EXIT = process.env.BT_EXIT || 'live';
const SPREAD = parseFloat(process.env.BT_SPREAD || '0.30');
const COOLDOWN_MS = parseFloat(process.env.BT_COOLDOWN_H || '2') * 3600e3;
const MAXHOLD_MS = parseFloat(process.env.BT_MAXHOLD_H || '120') * 3600e3;
const NOHTF = process.env.BT_NOHTF === '1';
const VOLMIN = process.env.BT_VOLMIN ? parseFloat(process.env.BT_VOLMIN) : null;
const VOLMAX = process.env.BT_VOLMAX ? parseFloat(process.env.BT_VOLMAX) : null;
const HOURMIN = process.env.BT_HOURMIN ? parseInt(process.env.BT_HOURMIN) : null;
const HOURMAX = process.env.BT_HOURMAX ? parseInt(process.env.BT_HOURMAX) : null;
const FROM = process.env.BT_FROM || '2024-08-01T00:00:00Z';
const TO = process.env.BT_TO || '2026-07-02T00:00:00Z';
const LABEL = process.env.BT_LABEL || 'run';
const WIN = 250;

const silent = { info(){}, error(){}, warn(){}, debug(){} };
const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
const H4 = JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t = M5.map(c => Date.parse(c.time));

const ta = new TechnicalAnalysis(silent);
const strat = new EmaTrendStrategy(silent, ta);
strat.saveState = () => {};   // no disk writes

const preTrail = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS);   // $1.50
const preAct = Config.pipsToPrice(Config.TRAILING_ACTIVATION_PIPS);        // $2.00
const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);

// first M5 index with time > t
function m5After(t) { let lo=0,hi=M5t.length; while(lo<hi){const m=(lo+hi)>>1; if(M5t[m]<=t)lo=m+1; else hi=m;} return lo; }

// simulate management from entry; returns {R, exit, holdMs}
function manage(isLong, entry, slDist, atr, entryMs, tpRR) {
  const tpDist = slDist * tpRR;
  const beTrig = Config.EMA_TREND_BE_TRIGGER_PCT * tpDist;
  const postTrail = Math.max(minSL, Math.min(maxSL, atr * Config.EMA_TREND_TRAIL_ATR_MULT));
  let sl = isLong ? entry - slDist : entry + slDist;
  const tp = isLong ? entry + tpDist : entry - tpDist;
  let be = false, banked = 0, bankFrac = 0;
  const t0 = entryMs;
  let i = m5After(t0);
  for (; i < M5.length; i++) {
    const b = M5[i]; const bt = M5t[i];
    if (bt - t0 > MAXHOLD_MS) { const px=b.open; const per=(isLong?px-entry:entry-px); return fin(per, banked, bankFrac, 'TIME', bt-t0); }
    const hi = b.high, lo = b.low;
    const hitSL = isLong ? lo <= sl : hi >= sl;
    const hitTP = (EXIT!=='trail_only') && (isLong ? hi >= tp : lo <= tp);
    if (hitSL) { const per=(isLong?sl-entry:entry-sl); return fin(per, banked, bankFrac, per>=0?'TRAIL+':'STOP', bt-t0); }
    if (hitTP) {
      if (EXIT==='partial1R' && bankFrac===0) { /* handled below via 1R partial before TP */ }
      const per = tpDist; return fin(per, banked, bankFrac, 'TP', bt-t0);
    }
    // partial: bank half at +1R then continue trailing the rest
    if (EXIT==='partial1R' && bankFrac===0) {
      const oneR = isLong ? entry+slDist : entry-slDist;
      if (isLong ? hi>=oneR : lo<=oneR) { banked += 1.0*0.5; bankFrac=0.5; }
    }
    const fav = isLong ? hi : lo;
    const best = isLong ? fav-entry : entry-fav;
    if (EXIT==='tp_only') continue;   // no BE / no trail
    if (!be && best >= beTrig) { be=true; if (isLong?entry>sl:entry<sl) sl=entry; }
    if (be || best >= preAct) {
      const td = be ? postTrail : preTrail;
      const nsl = isLong ? fav-td : fav+td;
      if (isLong ? nsl>sl : nsl<sl) sl=nsl;
    }
  }
  const last = M5[M5.length-1]; const per=(isLong?last.close-entry:entry-last.close);
  return fin(per, banked, bankFrac, 'OPEN', M5t[M5.length-1]-t0);
  function fin(per, banked, bankFrac, exit, holdMs) {
    // per is per-unit $ move of the runner portion; banked is in R (already *frac)
    const runnerFrac = 1 - bankFrac;
    const R = banked + (per/slDist)*runnerFrac;
    return { R, exit, holdMs };
  }
}

function run() {
  const trades = [];
  let cooldownUntil = 0;
  const dbg = { sigL:0, sigS:0, takenL:0, takenS:0, cdSkip:0 };
  const fromMs = Date.parse(FROM), toMs = Date.parse(TO);
  for (let i = WIN; i < H1.length; i++) {
    const bar = H1[i]; const bt = Date.parse(bar.time);
    if (bt < fromMs || bt > toMs) continue;
    if (bt < cooldownUntil) {
      if (process.env.BT_DEBUG) { // still evaluate to see if a signal was skipped by cooldown
        const win2 = H1.slice(i-WIN+1, i+1); let a2; try{a2={indicators:ta.getLatestIndicators(win2)};}catch{continue;}
        strat.lastSignalCandleTime=null; const r2=strat.evaluateSetup(a2, win2, NOHTF?null:H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140));
        if (r2.signal) dbg.cdSkip++;
      }
      continue;
    }
    if (HOURMIN!==null) { const h=new Date(bt).getUTCHours(); if (h<HOURMIN || h>=HOURMAX) continue; }
    const win = H1.slice(i-WIN+1, i+1);
    // HTF: only H4 candles that have CLOSED by bar time (time+4h <= bt) — avoid using the
    // in-progress H4 candle (its OHLC contains future price → lookahead).
    const htf = NOHTF ? null : H4.filter(c => Date.parse(c.time) + 4*3600e3 <= bt).slice(-140);
    let analysis;
    try { analysis = {indicators: ta.getLatestIndicators(win)}; } catch { continue; }
    // reset per-bar dedup so evaluateSetup never short-circuits on stale candle time
    strat.lastSignalCandleTime = null;
    const res = strat.evaluateSetup(analysis, win, htf);
    if (process.env.BT_DEBUG) { const r=res.reason||''; let k='sig:'+res.signal; if(!res.signal){ k = r.includes('not aligned')?'not-aligned': r.includes('RSI')?'RSI': r.includes('filtered')?'ADX': r.includes('pullback')||r.includes('bounce')?'pullback': r.includes('HTF')?'HTF': r.includes('Leg')?'leg': r.includes('not confirming')?'wrong-side': r.includes('disabled')?'short-disabled':'other'; } dbg.fn=dbg.fn||{}; dbg.fn[k]=(dbg.fn[k]||0)+1; }
    if (!res.signal) continue;
    if (res.signal==='LONG') dbg.sigL++; else dbg.sigS++;
    const atr = strat.lastATR;
    if (VOLMIN!==null && atr < VOLMIN) continue;
    if (VOLMAX!==null && atr > VOLMAX) continue;
    const isLong = res.signal === 'LONG';
    let slDist = Math.max(minSL, Math.min(maxSL, atr * Config.EMA_TREND_ATR_SL_MULT));
    const entry = bar.close + (isLong ? SPREAD : -SPREAD)*0 + (isLong? SPREAD: SPREAD)*0; // spread applied to per-unit below
    const tpRR = Config.EMA_TREND_TP_RR;
    const entryMs = bt + 3600e3;   // H1 close = candle start + 1h (fill moment)
    const m = manage(isLong, bar.close, slDist, atr, entryMs, tpRR);
    // apply spread as a flat per-unit cost => reduce R by SPREAD/slDist
    m.R -= SPREAD / slDist;
    trades.push({ time: bar.time, signal: res.signal, atr, slDist, R: m.R, exit: m.exit, holdH: m.holdMs/3600e3, adx: adxOf(analysis, win), rsi: analysis.indicators.rsi });
    if (res.signal==='LONG') dbg.takenL++; else dbg.takenS++;
    cooldownUntil = entryMs + m.holdMs + COOLDOWN_MS;   // block overlap + cooldown after exit
  }
  if (process.env.BT_DEBUG) console.error('DEBUG', JSON.stringify(dbg));
  return trades;
}
function adxOf(analysis, win){ return analysis.indicators.adx; }

function stats(tr) {
  const n = tr.length;
  const Rs = tr.map(t=>t.R);
  const W = Rs.filter(r=>r>0.02), L = Rs.filter(r=>r<-0.02);
  const sum = Rs.reduce((a,b)=>a+b,0);
  const gw = W.reduce((a,b)=>a+b,0), gl = -L.reduce((a,b)=>a+b,0);
  let peak=0,cum=0,dd=0; for(const r of Rs){cum+=r;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);}
  const longs=tr.filter(t=>t.signal==='LONG'), shorts=tr.filter(t=>t.signal==='SHORT');
  return { label:LABEL, exit:EXIT, n, expR:+(sum/n||0).toFixed(4), sumR:+sum.toFixed(2), wr:+(100*W.length/n||0).toFixed(1),
    nW:W.length, nL:L.length, avgW:+(gw/W.length||0).toFixed(3), avgL:+(-gl/L.length||0).toFixed(3),
    pf:+(gl?gw/gl:99).toFixed(2), ddR:+dd.toFixed(1), nLong:longs.length, nShort:shorts.length,
    expLong:+(longs.reduce((a,b)=>a+b.R,0)/(longs.length||1)).toFixed(3), expShort:+(shorts.reduce((a,b)=>a+b.R,0)/(shorts.length||1)).toFixed(3) };
}

const tr = run();
if (process.env.BT_DUMP) fs.writeFileSync(`${SP}/trades_${LABEL}.json`, JSON.stringify(tr));
console.log(JSON.stringify(stats(tr)));
