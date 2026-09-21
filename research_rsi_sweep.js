#!/usr/bin/env node
/**
 * Part 10 Q5 — the RSI band is the binding gate. Is widening it worth anything?
 *
 * Funnel (Part 10): of 12,920 market-open H1 bars, EMA alignment blocks 56.3%; of the 5,651
 * that survive, the RSI band blocks 4,948 = 87.6%. It is BY FAR the biggest lever left.
 *
 * METHOD: one wide-open pass (RSI_OS=0, BUY_MAX=100, SELL_MIN=0, RSI_OB=100) captures every
 * signal the rest of the logic would allow, tagged with its RSI. Any narrower band is then
 * reproduced EXACTLY by post-hoc filtering -- one strategy pass instead of a 20-run grid, and
 * every band is scored on the identical resolved trade set.
 *
 * PRE-REGISTERED before looking (the Aug-12 RSI finding died out of sample -- 92% bull-TRAIN):
 *   A widening is interesting ONLY IF all three hold:
 *     (1) E[R] does not degrade materially (>= live E[R] - 0.05R)
 *     (2) sumR improves
 *     (3) the sign of the improvement SURVIVES in the TEST half (walk-forward, months split 50/50)
 *   Anything failing (3) is a train-set artifact and is reported as such.
 *
 * Env: TP_SP=<dir> TP_DELAY_MIN=15 TP_SPREAD=0.30
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
const SP=process.env.TP_SP, DELAY=parseFloat(process.env.TP_DELAY_MIN||'15'), SPREAD=parseFloat(process.env.TP_SPREAD||'0.30');
const MAXHOLD=120*3600e3, WIN=250, KTP=2.0;
const silent={info(){},error(){},warn(){},debug(){}};
const H1=JSON.parse(fs.readFileSync(`${SP}/H1.json`)),H4=JSON.parse(fs.readFileSync(`${SP}/H4.json`)),M5=JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t=M5.map(c=>Date.parse(c.time));
const ta=new TechnicalAnalysis(silent),strat=new EmaTrendStrategy(silent,ta); strat.saveState=()=>{};
const minSL=Config.pipsToPrice(Config.EMA_TREND_MIN_SL),maxSL=Config.pipsToPrice(Config.EMA_TREND_MAX_SL);
const ukFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'numeric',hour12:false});
function m5After(t){let lo=0,hi=M5t.length;while(lo<hi){const m=(lo+hi)>>1;if(M5t[m]<=t)lo=m+1;else hi=m;}return lo;}
function resolve(isLong,entry,sl,ms){
  const slP=isLong?entry-sl:entry+sl, tp=isLong?entry+KTP*sl:entry-KTP*sl;
  for(let i=m5After(ms);i<M5.length;i++){
    const b=M5[i],bt=M5t[i];
    if(bt-ms>MAXHOLD){const p=(isLong?b.open-entry:entry-b.open)/sl;return{R:p,ex:'TIME'};}
    const hS=isLong?b.low<=slP:b.high>=slP, hT=isLong?b.high>=tp:b.low<=tp;
    if(hS)return{R:-1,ex:'STOP'}; if(hT)return{R:KTP,ex:'TP'};
  }
  const l=M5[M5.length-1];return{R:(isLong?l.close-entry:entry-l.close)/sl,ex:'OPEN'};
}
const sigs=[];
for(let i=WIN;i<H1.length;i++){
  const bar=H1[i],bt=Date.parse(bar.time),win=H1.slice(i-WIN+1,i+1);
  const htf=H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140);
  let a;try{a={indicators:ta.getLatestIndicators(win)};}catch{continue;}
  strat.lastSignalCandleTime=null;
  const res=strat.evaluateSetup(a,win,htf);
  if(!res.signal)continue;
  const isLong=res.signal==='LONG', sl=Math.max(minSL,Math.min(maxSL,strat.lastATR*Config.EMA_TREND_ATR_SL_MULT));
  const fill=bt+3600e3+DELAY*60e3, k=m5After(fill-1); if(k>=M5.length)continue;
  const entry=M5[k].open, hour=parseInt(ukFmt.format(new Date(fill)));
  if(!(hour>=Config.TRADING_START_HOUR&&hour<Config.TRADING_END_HOUR))continue;
  const r=resolve(isLong,entry,sl,fill);
  sigs.push({time:bar.time,month:bar.time.slice(0,7),signal:res.signal,rsi:a.indicators.rsi,R:r.R-SPREAD/sl,ex:r.ex});
}
const months=[...new Set(sigs.map(s=>s.month))].sort();
const split=months[Math.floor(months.length/2)];
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:NaN;
function band(buyMax,sellMin){
  return sigs.filter(s=>s.signal==='LONG'?(s.rsi<=buyMax):(s.rsi>=sellMin));
}
function stat(set){
  if(!set.length)return{n:0};
  const R=set.map(s=>s.R),W=R.filter(r=>r>0),L=R.filter(r=>r<=0);
  const gw=W.reduce((a,b)=>a+b,0),gl=-L.reduce((a,b)=>a+b,0);
  return{n:set.length,expR:mean(R),sumR:R.reduce((a,b)=>a+b,0),wr:100*W.length/set.length,pf:gl?gw/gl:99};
}
console.log(`\n=== RSI BAND SWEEP (wide-open pass, post-hoc filtered) ===`);
console.log(`wide-open in-session signals: ${sigs.length}   months ${months[0]} -> ${months[months.length-1]}`);
console.log(`walk-forward split at ${split}  (TRAIN < ${split} <= TEST)\n`);
const live=stat(band(60,45));
console.log(`LIVE band (LONG<=60, SHORT>=45): n=${live.n}  E[R] ${live.expR.toFixed(3)}  sumR ${live.sumR.toFixed(1)}  WR ${live.wr.toFixed(1)}%  PF ${live.pf.toFixed(2)}\n`);
console.log(' LONG cap  SHORT floor |   n   E[R]    sumR    WR%   PF  | TRAIN E[R]  TEST E[R]  | verdict');
const grid=[[60,45],[65,45],[70,45],[75,45],[100,45],[60,40],[60,35],[60,30],[65,40],[70,35],[100,0]];
for(const [bm,sm] of grid){
  const set=band(bm,sm), s=stat(set);
  const tr=stat(set.filter(x=>x.month<split)), te=stat(set.filter(x=>x.month>=split));
  const c1=s.expR>=live.expR-0.05, c2=s.sumR>live.sumR, c3=(s.sumR-live.sumR>0)&&(te.expR>=live.expR-0.05);
  let v='-';
  if(bm===60&&sm===45)v='(live)';
  else if(c1&&c2&&c3)v='PASSES all 3';
  else if(c2&&!c3)v='train-only artifact';
  else if(!c1)v='E[R] degrades';
  else v='no sumR gain';
  console.log(` ${String(bm).padStart(4)}      ${String(sm).padStart(4)}       | ${String(s.n).padStart(3)}  ${s.expR>=0?'+':''}${s.expR.toFixed(3)}  ${s.sumR>=0?'+':''}${s.sumR.toFixed(1).padStart(6)}  ${s.wr.toFixed(1).padStart(5)} ${s.pf.toFixed(2).padStart(5)} |   ${tr.expR>=0?'+':''}${tr.expR.toFixed(3)}     ${te.expR>=0?'+':''}${te.expR.toFixed(3)}   | ${v}`);
}
console.log(`\n=== WHERE DO THE BLOCKED LONGS LIVE? (RSI of wide-open LONG signals) ===`);
const longs=sigs.filter(s=>s.signal==='LONG').sort((a,b)=>a.rsi-b.rsi);
for(const [lo,hi] of [[0,50],[50,60],[60,65],[65,70],[70,75],[75,100]]){
  const b=longs.filter(s=>s.rsi>lo&&s.rsi<=hi);
  if(b.length) console.log(`  RSI ${String(lo).padStart(3)}-${String(hi).padStart(3)}: n=${String(b.length).padStart(3)}  E[R] ${mean(b.map(s=>s.R))>=0?'+':''}${mean(b.map(s=>s.R)).toFixed(3)}  sumR ${b.reduce((a,s)=>a+s.R,0).toFixed(1)}  ${lo>=60?'<- currently BLOCKED':''}`);
}
fs.writeFileSync(`${SP}/rsi_sweep.json`,JSON.stringify(sigs));
