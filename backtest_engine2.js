#!/usr/bin/env node
/**
 * Multi-strategy faithful backtest: EMA Trend vs Triple Confirmation vs Breakout+ADX.
 * Drives each REAL strategy class for ENTRIES (H1-close subset). Two exit modes:
 *   BT_EXITMODE=native  -> each strategy's own exit
 *      ema_trend : ATR stop + BE(30%) + pre-BE $1.50 trail + post-BE ATR trail, TP 2R
 *      triple    : fixed SL (STOP_LOSS_PIPS, S/R-adjusted) + staged TP 60%@1.5R / 40%@2.5R + BE after TP1
 *      breakout  : fixed SL (BREAKOUT_STOP_LOSS_PIPS) + trailing-only (act $3.50, trail $1.50), no TP
 *   BT_EXITMODE=common  -> ALL strategies use the EMA-Trend ATR management (isolate ENTRY edge)
 * Management simulated on M5, pessimistic (adverse before favourable; SL wins same-bar ties).
 * Env: BT_STRAT=ema_trend|triple|breakout  BT_SP  BT_FROM/BT_TO  BT_HOURMIN/MAX  BT_LABEL  BT_SPREAD
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
import TripleConfirmationStrategy from './src/strategy.js';
import BreakoutADXStrategy from './src/breakout_adx_strategy.js';

const SP = process.env.BT_SP;
const STRAT = process.env.BT_STRAT || 'ema_trend';
const EXITMODE = process.env.BT_EXITMODE || 'native';
const SPREAD = parseFloat(process.env.BT_SPREAD || '0.30');
const COOLDOWN_MS = parseFloat(process.env.BT_COOLDOWN_H || '2') * 3600e3;
const MAXHOLD_MS = parseFloat(process.env.BT_MAXHOLD_H || '120') * 3600e3;
const HOURMIN = process.env.BT_HOURMIN ? parseInt(process.env.BT_HOURMIN) : null;
const HOURMAX = process.env.BT_HOURMAX ? parseInt(process.env.BT_HOURMAX) : null;
const FROM = process.env.BT_FROM || '2024-08-01T00:00:00Z';
const TO = process.env.BT_TO || '2026-07-02T00:00:00Z';
const LABEL = process.env.BT_LABEL || 'run';
const WIN = 250;

const silent = { info(){}, error(){}, warn(){}, debug(){}, strategy(){} };
const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
const H4 = JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t = M5.map(c => Date.parse(c.time));
const H1D = H1.map(c => ({ ...c, time: new Date(c.time) }));   // breakout needs Date .time

const ta = new TechnicalAnalysis(silent);
const emaStrat = new EmaTrendStrategy(silent, ta); emaStrat.saveState = () => {};
const tripleStrat = new TripleConfirmationStrategy(silent, ta);
const bkStrat = new BreakoutADXStrategy(silent, ta); bkStrat.saveState = () => {};

const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);
const preTrail = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS);   // $1.50
const preAct = Config.pipsToPrice(Config.TRAILING_ACTIVATION_PIPS);        // $2.00
const bkAct = Config.pipsToPrice(Config.BREAKOUT_TRAILING_ACTIVATION_PIPS);// $3.50
const bkTrail = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS);    // $1.50

function m5After(t){ let lo=0,hi=M5t.length; while(lo<hi){const m=(lo+hi)>>1; if(M5t[m]<=t)lo=m+1; else hi=m;} return lo; }

// ---- exit simulators (return {R, exit, holdMs}) ----
function simEMA(isLong, entry, entryMs, atr, slDist) {
  const tpDist = slDist * 2.0, beTrig = 0.3 * tpDist;
  const postTrail = Math.max(minSL, Math.min(maxSL, atr * Config.EMA_TREND_TRAIL_ATR_MULT));
  let sl = isLong ? entry-slDist : entry+slDist; const tp = isLong ? entry+tpDist : entry-tpDist; let be=false;
  for (let i=m5After(entryMs); i<M5.length; i++){ const b=M5[i], bt=M5t[i];
    if (bt-entryMs>MAXHOLD_MS){ const p=isLong?b.open-entry:entry-b.open; return {R:p/slDist,exit:'TIME',holdMs:bt-entryMs}; }
    if (isLong?b.low<=sl:b.high>=sl){ const p=isLong?sl-entry:entry-sl; return {R:p/slDist,exit:p>=0?'TRAIL+':'STOP',holdMs:bt-entryMs}; }
    if (isLong?b.high>=tp:b.low<=tp) return {R:2.0,exit:'TP',holdMs:bt-entryMs};
    const fav=isLong?b.high:b.low, best=isLong?fav-entry:entry-fav;
    if(!be&&best>=beTrig){be=true; if(isLong?entry>sl:entry<sl)sl=entry;}
    if(be||best>=preAct){const td=be?postTrail:preTrail; const n=isLong?fav-td:fav+td; if(isLong?n>sl:n<sl)sl=n;}
  }
  const last=M5[M5.length-1]; const p=isLong?last.close-entry:entry-last.close; return {R:p/slDist,exit:'OPEN',holdMs:M5t[M5.length-1]-entryMs};
}
function simStaged(isLong, entry, entryMs, slDist, tp1R, tp1Frac, tp2R) {
  let sl=isLong?entry-slDist:entry+slDist;
  const tp1=isLong?entry+tp1R*slDist:entry-tp1R*slDist, tp2=isLong?entry+tp2R*slDist:entry-tp2R*slDist;
  let banked=0, remFrac=1, tp1hit=false;
  for (let i=m5After(entryMs); i<M5.length; i++){ const b=M5[i], bt=M5t[i];
    if (bt-entryMs>MAXHOLD_MS){ const p=isLong?b.open-entry:entry-b.open; return {R:banked+remFrac*(p/slDist),exit:'TIME',holdMs:bt-entryMs}; }
    if (isLong?b.low<=sl:b.high>=sl){ const p=isLong?sl-entry:entry-sl; return {R:banked+remFrac*(p/slDist),exit:tp1hit?'BErem':'STOP',holdMs:bt-entryMs}; }
    if (!tp1hit && (isLong?b.high>=tp1:b.low<=tp1)){ banked+=tp1Frac*tp1R; remFrac-=tp1Frac; tp1hit=true; sl=entry; }
    if (tp1hit && (isLong?b.high>=tp2:b.low<=tp2)){ banked+=remFrac*tp2R; return {R:banked,exit:'TP2',holdMs:bt-entryMs}; }
  }
  const last=M5[M5.length-1]; const p=isLong?last.close-entry:entry-last.close; return {R:banked+remFrac*(p/slDist),exit:'OPEN',holdMs:M5t[M5.length-1]-entryMs};
}
function simTrailOnly(isLong, entry, entryMs, slDist, actDist, trailDist) {
  let sl=isLong?entry-slDist:entry+slDist;
  for (let i=m5After(entryMs); i<M5.length; i++){ const b=M5[i], bt=M5t[i];
    if (bt-entryMs>MAXHOLD_MS){ const p=isLong?b.open-entry:entry-b.open; return {R:p/slDist,exit:'TIME',holdMs:bt-entryMs}; }
    if (isLong?b.low<=sl:b.high>=sl){ const p=isLong?sl-entry:entry-sl; return {R:p/slDist,exit:p>=0?'TRAIL+':'STOP',holdMs:bt-entryMs}; }
    const fav=isLong?b.high:b.low, best=isLong?fav-entry:entry-fav;
    if(best>=actDist){ const n=isLong?fav-trailDist:fav+trailDist; if(isLong?n>sl:n<sl)sl=n; }
  }
  const last=M5[M5.length-1]; const p=isLong?last.close-entry:entry-last.close; return {R:p/slDist,exit:'OPEN',holdMs:M5t[M5.length-1]-entryMs};
}

function atrOf(win){ const a=ta.calculateATR(win,14); return a[a.length-1] || 18; }

function run() {
  const trades=[]; let cooldownUntil=0;
  const fromMs=Date.parse(FROM), toMs=Date.parse(TO);
  for (let i=WIN; i<H1.length; i++){
    const bar=H1[i]; const bt=Date.parse(bar.time);
    // NOTE: breakout is stateful — must call its evaluateSetup EVERY bar to keep channel state,
    // even during cooldown; but we only OPEN when free. Feed it regardless, gate the entry.
    const win=H1.slice(i-WIN+1,i+1);
    let res=null, atr=null, entry=bar.close, isLong, slDist, sim;
    if (STRAT==='breakout') {
      const winD=H1D.slice(i-WIN+1,i+1);
      const analysis={indicators: ta.getLatestIndicators(win)};
      res=bkStrat.evaluateSetup(analysis, winD, null);   // ENABLE_MTF=false → direct signal
    }
    if (bt<fromMs||bt>toMs) continue;
    if (bt<cooldownUntil) continue;
    if (HOURMIN!==null){ const h=new Date(bt).getUTCHours(); if(h<HOURMIN||h>=HOURMAX) continue; }
    if (STRAT==='ema_trend'){
      const htf=H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140);
      const analysis={indicators: ta.getLatestIndicators(win)};
      emaStrat.lastSignalCandleTime=null;
      res=emaStrat.evaluateSetup(analysis, win, htf);
      if(res.signal){ atr=emaStrat.lastATR; }
    } else if (STRAT==='triple'){
      let analysis; try{ analysis=ta.analyze(win); }catch{ continue; }
      res=tripleStrat.evaluateSetup(analysis);
      if(res.signal){ atr=atrOf(win); res._levels=tripleStrat.calculateEntryLevels(analysis, res.signal); }
    } else if (STRAT==='breakout'){
      if(res && res.signal){ atr=atrOf(win); res._levels=bkStrat.calculateEntryLevels({indicators:ta.getLatestIndicators(win)}, res.signal); }
    }
    if (!res || !res.signal) continue;
    isLong = res.signal==='LONG';
    atr = atr || atrOf(win);
    if (EXITMODE==='common'){
      slDist=Math.max(minSL, Math.min(maxSL, atr*1.5));
      sim=simEMA(isLong, entry, bt+3600e3, atr, slDist);
    } else { // native
      if (STRAT==='ema_trend'){ slDist=Math.max(minSL,Math.min(maxSL,atr*1.5)); sim=simEMA(isLong,entry,bt+3600e3,atr,slDist); }
      else if (STRAT==='triple'){ slDist=Math.abs(entry-res._levels.stopLoss); sim=simStaged(isLong,entry,bt+3600e3,slDist,1.5,0.6,2.5); }
      else { slDist=Math.abs(entry-res._levels.stopLoss); sim=simTrailOnly(isLong,entry,bt+3600e3,slDist,bkAct,bkTrail); }
    }
    sim.R -= SPREAD/slDist;
    trades.push({time:bar.time,signal:res.signal,atr:+atr.toFixed(2),slDist:+slDist.toFixed(2),R:sim.R,exit:sim.exit,holdH:sim.holdMs/3600e3});
    cooldownUntil=bt+3600e3+sim.holdMs+COOLDOWN_MS;
  }
  return trades;
}

function stats(tr){
  const n=tr.length, Rs=tr.map(t=>t.R);
  const W=Rs.filter(r=>r>0.02), L=Rs.filter(r=>r<-0.02);
  const sum=Rs.reduce((a,b)=>a+b,0), gw=W.reduce((a,b)=>a+b,0), gl=-L.reduce((a,b)=>a+b,0);
  let peak=0,cum=0,dd=0; for(const r of Rs){cum+=r;peak=Math.max(peak,cum);dd=Math.max(dd,peak-cum);}
  const L_=tr.filter(t=>t.signal==='LONG'), S_=tr.filter(t=>t.signal==='SHORT');
  return {label:LABEL,strat:STRAT,exit:EXITMODE,n,expR:+(sum/n||0).toFixed(4),sumR:+sum.toFixed(2),wr:+(100*W.length/n||0).toFixed(1),
    nW:W.length,nL:L.length,avgW:+(gw/W.length||0).toFixed(3),avgL:+(-gl/L.length||0).toFixed(3),pf:+(gl?gw/gl:99).toFixed(2),ddR:+dd.toFixed(1),
    nLong:L_.length,nShort:S_.length};
}
const tr=run();
if(process.env.BT_DUMP) fs.writeFileSync(`${SP}/t2_${LABEL}.json`, JSON.stringify(tr));
console.log(JSON.stringify(stats(tr)));
