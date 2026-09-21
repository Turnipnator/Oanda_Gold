#!/usr/bin/env node
/**
 * Part 11 — the one lever Part 10 pointed at and did not pull: CAPACITY.
 *
 * Part 10 found raising the RSI band fails because extra signals crowd out better ones under a
 * one-position limit. The mirror question was never asked: how much does the ONE-POSITION LIMIT
 * ITSELF cost, at the CURRENT entry quality? Raising capacity adds trades WITHOUT lowering the
 * entry bar -- the opposite of widening a filter.
 *
 * Sweeps concurrent positions x cooldown on the LIVE band (LONG<=60, SHORT>=45).
 *
 * PRE-REGISTERED before looking (12 cells => snooping risk is real):
 *   A change is interesting ONLY IF (1) sumR improves, (2) ret/DD does NOT degrade, and
 *   (3) BOTH hold in the TEST half. Anything else is reported as a fitted cell.
 * ALSO PRE-REGISTERED: concurrent gold positions are ~1.0 correlated -- N positions is closer to
 * one N-sized position than to N independent bets. Any DD improvement is therefore suspect and
 * £-risk scales linearly with N even where R-drawdown does not.
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
const SP=process.env.TP_SP,DELAY=15,SPREAD=0.30,MAXHOLD=120*3600e3,WIN=250,KTP=2.0;
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
    if(bt-ms>MAXHOLD)return{R:(isLong?b.open-entry:entry-b.open)/sl,exitMs:bt};
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
  sigs.push({t:fill,month:bar.time.slice(0,7),signal:res.signal,R:r.R-SPREAD/sl,exit:r.exitMs});
}
sigs.sort((a,b)=>a.t-b.t);
const months=[...new Set(sigs.map(s=>s.month))].sort(),split=months[Math.floor(months.length/2)];
const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
function book(maxPos,coolH){
  // Faithful to live: TRADE_COOLDOWN_HOURS runs from trade CLOSE, not entry. Generalised to
  // N positions as: after ANY trade closes, no new entry for coolH. Entry also needs a free slot.
  const open=[]; let freeAt=0; const taken=[]; let peak=0, peakR=0;
  for(const s of sigs){
    while(open.length&&open[0]<=s.t){ freeAt=Math.max(freeAt,open[0]+coolH*3600e3); open.shift(); }
    if(s.t<freeAt)continue;
    if(open.length>=maxPos)continue;
    taken.push(s); open.push(s.exit); open.sort((a,b)=>a-b);
    if(open.length>peak)peak=open.length;
  }
  taken.peak=peak;
  return taken;
}
/** Peak SIMULTANEOUS open risk in R -- the number that matters when positions are ~1.0 correlated. */
function peakOpen(tr){
  const ev=[]; for(const s of tr){ev.push([s.t,1]);ev.push([s.exit,-1]);}
  ev.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);
  let c=0,mx=0; for(const [,d] of ev){c+=d; if(c>mx)mx=c;} return mx;
}
/** DD on a mark-to-market-at-close equity curve, ordered by EXIT (concurrent risk is real). */
function dd(tr){const o=[...tr].sort((a,b)=>a.exit-b.exit);let eq=0,pk=0,mx=0;for(const s of o){eq+=s.R;if(eq>pk)pk=eq;if(pk-eq>mx)mx=pk-eq;}return mx;}
console.log(`\n=== Part 11: CAPACITY SWEEP (live RSI band, 26.7 months, ${sigs.length} eligible signals) ===`);
console.log(' pos  cool |  trades  /mo  | E[R]    sumR   PF   maxDD  ret/DD | TEST sumR  TEST E[R] | concurrent | verdict');
const base=book(1,2), baseSum=base.reduce((a,s)=>a+s.R,0), baseRD=baseSum/dd(base);
const baseTe=base.filter(s=>s.month>=split), baseTeSum=baseTe.reduce((a,s)=>a+s.R,0);
for(const pos of [1,2,3]) for(const cool of [0,1,2,4]){
  const tr=book(pos,cool); if(!tr.length)continue;
  const R=tr.map(s=>s.R),W=R.filter(r=>r>0),gw=W.reduce((a,b)=>a+b,0),gl=-R.filter(r=>r<=0).reduce((a,b)=>a+b,0);
  const sum=R.reduce((a,b)=>a+b,0),D=dd(tr),rd=sum/D;
  const te=tr.filter(s=>s.month>=split),teSum=te.reduce((a,s)=>a+s.R,0);
  const live=(pos===1&&cool===2);
  let v=live?'(LIVE)':'';
  if(!live){ const c1=sum>baseSum,c2=rd>=baseRD*0.95,c3=teSum>baseTeSum;
    v = (c1&&c2&&c3)?'PASSES all 3' : (c1&&!c2)?'sumR up, ret/DD worse' : (c1&&!c3)?'train-only' : 'no gain'; }
  console.log(` ${pos}    ${cool}h  |   ${String(tr.length).padStart(4)}  ${(tr.length/26.7).toFixed(1).padStart(4)}  | ${sum/tr.length>=0?'+':''}${(sum/tr.length).toFixed(3)} ${sum>=0?'+':''}${sum.toFixed(1).padStart(6)} ${(gl?gw/gl:99).toFixed(2).padStart(5)} ${D.toFixed(1).padStart(6)} ${rd.toFixed(2).padStart(6)}  | ${teSum.toFixed(1).padStart(6)}     ${mean(te.map(s=>s.R))>=0?'+':''}${mean(te.map(s=>s.R)).toFixed(3)} | peak ${peakOpen(tr)}R | ${v}`);
}
console.log(`\n=== WHAT THE 1-POSITION LIMIT COSTS AT CURRENT ENTRY QUALITY ===`);
const taken1=new Set(book(1,2).map(s=>s.t)), all=book(99,0);
const missed=all.filter(s=>!taken1.has(s.t));
console.log(`  eligible signals: ${sigs.length};  taken at 1-pos/2h: ${taken1.size};  never taken: ${missed.length}`);
console.log(`  missed set: E[R] ${mean(missed.map(s=>s.R))>=0?'+':''}${mean(missed.map(s=>s.R)).toFixed(3)}, sumR ${missed.reduce((a,s)=>a+s.R,0).toFixed(1)}`);
console.log(`  taken set : E[R] ${mean(book(1,2).map(s=>s.R)).toFixed(3)}`);
console.log(`\n  (Concurrent gold positions are ~1.0 correlated: 2 open longs = one 2x long, and`);
console.log(`   GBP risk scales linearly with N even where R-drawdown appears not to.)`);

// ---- Part 11b: is the pos=3 advantage real or a handful of trades? ----
console.log(`\n=== IS pos=3 REAL? incremental trades and outlier sensitivity ===`);
const b1=book(1,2), b2=book(2,2), b3=book(3,2);
const k1=new Set(b1.map(s=>s.t)), k2=new Set(b2.map(s=>s.t));
const inc12=b2.filter(s=>!k1.has(s.t)), inc23=b3.filter(s=>!k2.has(s.t));
const sm=a=>a.reduce((x,s)=>x+s.R,0);
console.log(`  1->2 added ${inc12.length} trades: E[R] ${mean(inc12.map(s=>s.R)).toFixed(3)}, sumR ${sm(inc12).toFixed(1)}`);
console.log(`  2->3 added ${inc23.length} trades: E[R] ${mean(inc23.map(s=>s.R)).toFixed(3)}, sumR ${sm(inc23).toFixed(1)}`);
const top=[...inc23].sort((a,b)=>b.R-a.R).slice(0,3);
console.log(`  top 3 of the 2->3 increment: ${top.map(s=>s.R.toFixed(2)+'R').join(', ')} = ${sm(top).toFixed(1)}R of ${sm(inc23).toFixed(1)}R (${(100*sm(top)/sm(inc23)).toFixed(0)}%)`);
for(const [lbl,set] of [['pos1',b1],['pos2',b2],['pos3',b3]]){
  const R=[...set.map(s=>s.R)].sort((a,b)=>a-b);
  const tr=R.slice(3,-3);
  console.log(`  ${lbl}: sumR ${R.reduce((a,b)=>a+b,0).toFixed(1)} -> trimmed(3 each end) mean ${(tr.reduce((a,b)=>a+b,0)/tr.length).toFixed(3)} (raw ${(R.reduce((a,b)=>a+b,0)/R.length).toFixed(3)})`);
}
// month-level paired sign test, robust to outliers (Part 9b method)
function lchoose(n,k){let r=0;for(let i=0;i<k;i++)r+=Math.log(n-i)-Math.log(i+1);return r;}
function binomP(w,n){const m=Math.min(w,n-w);let p=0;for(let k=0;k<=m;k++)p+=Math.exp(lchoose(n,k)-n*Math.LN2);return Math.min(1,2*p);}
console.log(`\n=== MONTH-LEVEL PAIRED SIGN TEST vs LIVE (1pos/2h) -- outlier-robust ===`);
for(const [lbl,set] of [['2pos/2h',b2],['3pos/2h',b3],['3pos/0h',book(3,0)]]){
  const mA={},mB={};
  for(const s of set)(mA[s.month]||=[]).push(s.R);
  for(const s of b1)(mB[s.month]||=[]).push(s.R);
  const ms=[...new Set([...Object.keys(mA),...Object.keys(mB)])];
  let w=0,n=0;
  for(const m of ms){ const a=mA[m]?sm(mA[m].map(R=>({R}))):0, b=mB[m]?sm(mB[m].map(R=>({R}))):0;
    if(a!==b){n++; if(a>b)w++;} }
  console.log(`  ${lbl}: beat live in ${w}/${n} months, two-sided p=${binomP(w,n).toFixed(3)}${binomP(w,n)<0.05?'  <- significant':'  <- NOT significant'}`);
}
console.log(`\n=== GBP reality at 0.5% risk/trade (~GBP433 per 1R) ===`);
for(const [lbl,set,pk] of [['LIVE 1pos',b1,1],['3pos/2h',b3,3]]){
  console.log(`  ${lbl}: ${set.length} trades/26.7mo = ${(set.length/26.7).toFixed(1)}/mo, sumR ${sm(set).toFixed(1)} = GBP${(sm(set)*433).toFixed(0)} total = GBP${(sm(set)*433/26.7).toFixed(0)}/mo; worst-case simultaneous risk ${pk}R = GBP${(pk*433).toFixed(0)}`);
}
