#!/usr/bin/env node
/** Part 10 Q5b — TRADEABLE counterfactual for the RSI cap.
 * Part 5 measured "displacement cost": with a 2h cooldown and one position at a time, extra
 * signals crowd out later ones, so raising the cap is NOT purely additive. My signal-level
 * sweep ignored that. This replays each cap as a SEQUENTIAL BOOK -- greedy, first-come, one
 * position, TRADE_COOLDOWN_HOURS=2 after each close -- which is what the bot actually does.
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
const SP=process.env.TP_SP,DELAY=15,SPREAD=0.30,MAXHOLD=120*3600e3,WIN=250,KTP=2.0,COOL=2*3600e3;
const silent={info(){},error(){},warn(){},debug(){}};
const H1=JSON.parse(fs.readFileSync(`${SP}/H1.json`)),H4=JSON.parse(fs.readFileSync(`${SP}/H4.json`)),M5=JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t=M5.map(c=>Date.parse(c.time));
const ta=new TechnicalAnalysis(silent),strat=new EmaTrendStrategy(silent,ta);strat.saveState=()=>{};
const minSL=Config.pipsToPrice(Config.EMA_TREND_MIN_SL),maxSL=Config.pipsToPrice(Config.EMA_TREND_MAX_SL);
const ukFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'numeric',hour12:false});
function m5After(t){let lo=0,hi=M5t.length;while(lo<hi){const m=(lo+hi)>>1;if(M5t[m]<=t)lo=m+1;else hi=m;}return lo;}
function resolve(isLong,entry,sl,ms){
  const slP=isLong?entry-sl:entry+sl,tp=isLong?entry+KTP*sl:entry-KTP*sl;
  for(let i=m5After(ms);i<M5.length;i++){const b=M5[i],bt=M5t[i];
    if(bt-ms>MAXHOLD){return{R:(isLong?b.open-entry:entry-b.open)/sl,exitMs:bt};}
    if(isLong?b.low<=slP:b.high>=slP)return{R:-1,exitMs:bt};
    if(isLong?b.high>=tp:b.low<=tp)return{R:KTP,exitMs:bt};}
  return{R:0,exitMs:M5t[M5t.length-1]};
}
const sigs=[];
for(let i=WIN;i<H1.length;i++){
  const bar=H1[i],bt=Date.parse(bar.time),win=H1.slice(i-WIN+1,i+1);
  const htf=H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140);
  let a;try{a={indicators:ta.getLatestIndicators(win)};}catch{continue;}
  strat.lastSignalCandleTime=null;
  const res=strat.evaluateSetup(a,win,htf); if(!res.signal)continue;
  const isLong=res.signal==='LONG',sl=Math.max(minSL,Math.min(maxSL,strat.lastATR*Config.EMA_TREND_ATR_SL_MULT));
  const fill=bt+3600e3+DELAY*60e3,k=m5After(fill-1); if(k>=M5.length)continue;
  const hour=parseInt(ukFmt.format(new Date(fill)));
  if(!(hour>=Config.TRADING_START_HOUR&&hour<Config.TRADING_END_HOUR))continue;
  const entry=M5[k].open,r=resolve(isLong,entry,sl,fill);
  sigs.push({t:fill,month:bar.time.slice(0,7),signal:res.signal,rsi:a.indicators.rsi,R:r.R-SPREAD/sl,exit:r.exitMs});
}
sigs.sort((a,b)=>a.t-b.t);
function book(bm,sm){
  const el=sigs.filter(s=>s.signal==='LONG'?s.rsi<=bm:s.rsi>=sm);
  let free=0,taken=[];
  for(const s of el){ if(s.t<free)continue; taken.push(s); free=s.exit+COOL; }
  return taken;
}
function dd(tr){let eq=0,pk=0,mx=0;for(const s of tr){eq+=s.R;if(eq>pk)pk=eq;if(pk-eq>mx)mx=pk-eq;}return mx;}
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const months=[...new Set(sigs.map(s=>s.month))].sort(),split=months[Math.floor(months.length/2)];
console.log(`\n=== TRADEABLE BOOK: greedy sequential, 1 position, 2h cooldown (26.7 months) ===`);
console.log(' cap/floor | trades  /mo  | E[R]    sumR    WR%   PF   maxDD | ret/DD | TEST sumR  TEST E[R]');
for(const [bm,sm] of [[60,45],[65,45],[70,45],[75,45],[85,45],[100,45]]){
  const tr=book(bm,sm),te=tr.filter(s=>s.month>=split);
  const R=tr.map(s=>s.R),W=R.filter(r=>r>0),gw=W.reduce((a,b)=>a+b,0),gl=-R.filter(r=>r<=0).reduce((a,b)=>a+b,0);
  const sum=R.reduce((a,b)=>a+b,0),D=dd(tr);
  console.log(`  ${String(bm).padStart(3)}/${String(sm).padStart(3)}   |  ${String(tr.length).padStart(4)}  ${(tr.length/26.7).toFixed(1).padStart(4)}  | ${mean(R)>=0?'+':''}${mean(R).toFixed(3)}  ${sum>=0?'+':''}${sum.toFixed(1).padStart(6)}  ${(100*W.length/tr.length).toFixed(1).padStart(5)} ${(gl?gw/gl:99).toFixed(2).padStart(5)} ${D.toFixed(1).padStart(6)} | ${(sum/D).toFixed(2).padStart(5)}  | ${te.reduce((a,s)=>a+s.R,0).toFixed(1).padStart(6)}     ${mean(te.map(s=>s.R))>=0?'+':''}${mean(te.map(s=>s.R)).toFixed(3)}`);
}
console.log(`\n=== DISPLACEMENT: what raising 60->75 actually swaps ===`);
const a=book(60,45),b=book(75,45);
const ka=new Set(a.map(s=>s.t)),kb=new Set(b.map(s=>s.t));
const lost=a.filter(s=>!kb.has(s.t)),gained=b.filter(s=>!ka.has(s.t));
console.log(`  cap-60 trades DISPLACED by earlier high-RSI entries: ${lost.length}, E[R] ${mean(lost.map(s=>s.R)).toFixed(3)}, sumR ${lost.reduce((x,s)=>x+s.R,0).toFixed(1)}`);
console.log(`  genuinely NEW trades unlocked:                        ${gained.length}, E[R] ${mean(gained.map(s=>s.R)).toFixed(3)}, sumR ${gained.reduce((x,s)=>x+s.R,0).toFixed(1)}`);
console.log(`  net change in sumR: ${(b.reduce((x,s)=>x+s.R,0)-a.reduce((x,s)=>x+s.R,0)).toFixed(1)}R  (=${((b.reduce((x,s)=>x+s.R,0)-a.reduce((x,s)=>x+s.R,0))*433).toFixed(0)} GBP at 433/R)`);
