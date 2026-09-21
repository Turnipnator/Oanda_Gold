#!/usr/bin/env node
/**
 * Part 12 — broad strategy search under the BRACKET exit, with multiple-testing control.
 *
 * WHY THIS IS NEW GROUND: Part 2 (Jul 1) compared entries under a COMMON exit and found none had
 * standalone edge (EMA -0.032, Triple -0.005, Breakout -0.009). But that was the TRAIL regime, and
 * Part 5 proved trail-era exit conclusions do not survive the Jul-10 bracket switch. Part 1's Q6
 * ("is a fundamentally different entry -- breakout, MA, MEAN-REVERT -- better?") was never answered
 * for mean-reversion at all.
 *
 * ARCHITECTURE: precompute an OUTCOME MATRIX once -- for every H1 bar i and each direction, the R a
 * trade opened there returns under the exact live bracket (fill at close+15min, stop
 * clamp(1.5*ATR,$2,$20), resting 2R TP, no BE/trail, M5 resolution, $0.30 spread, 120h cap).
 * Every strategy is then just a SELECTOR over (bar, direction) pairs, so 200+ configs cost nothing.
 * Stop distance is ATR-based and strategy-independent, which is what makes this valid.
 *
 * THE REAL DANGER IS SNOOPING, NOT COMPUTE. With ~26.7 months of ONE instrument in ONE macro regime,
 * testing 200 configs guarantees some look excellent by chance. Controls, all pre-registered:
 *   1. The universe below is FIXED BEFORE RUNNING. No config is added after seeing results.
 *   2. Statistic = R per month (accounts for frequency; mean-R-per-trade flatters rare lucky runs).
 *   3. Walk-forward TRAIN/TEST split; sign must survive.
 *   4. WHITE'S REALITY CHECK on month blocks: bootstrap the distribution of the MAXIMUM statistic
 *      across the whole universe under the null. A winner must beat that, not just beat zero.
 *   5. Report how many configs beat the incumbent vs how many you'd EXPECT to by chance.
 * Every indicator uses data up to and including bar i only; entry is bar i close + 15 min.
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
const SP=process.env.TP_SP,DELAY=15,SPREAD=0.30,MAXHOLD=120*3600e3,KTP=2.0,COOL=2*3600e3,WIN=250;
const silent={info(){},error(){},warn(){},debug(){}};
const H1=JSON.parse(fs.readFileSync(`${SP}/H1.json`)),H4=JSON.parse(fs.readFileSync(`${SP}/H4.json`)),M5=JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t=M5.map(c=>Date.parse(c.time)), N=H1.length;
const ukFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'numeric',hour12:false});
function m5After(t){let lo=0,hi=M5t.length;while(lo<hi){const m=(lo+hi)>>1;if(M5t[m]<=t)lo=m+1;else hi=m;}return lo;}

// ---------- indicators (causal: bar i uses bars <= i) ----------
const C=H1.map(c=>c.close),Hi=H1.map(c=>c.high),Lo=H1.map(c=>c.low),O=H1.map(c=>c.open);
function ema(src,p){const k=2/(p+1),o=new Array(src.length).fill(null);let e=src[0];o[0]=e;
  for(let i=1;i<src.length;i++){e=src[i]*k+e*(1-k);o[i]=e;}return o;}
function sma(src,p){const o=new Array(src.length).fill(null);let s=0;
  for(let i=0;i<src.length;i++){s+=src[i];if(i>=p)s-=src[i-p];if(i>=p-1)o[i]=s/p;}return o;}
function stdev(src,p){const o=new Array(src.length).fill(null);
  for(let i=p-1;i<src.length;i++){const w=src.slice(i-p+1,i+1),m=w.reduce((a,b)=>a+b,0)/p;
    o[i]=Math.sqrt(w.reduce((a,b)=>a+(b-m)**2,0)/p);}return o;}
const ATR=(()=>{const o=new Array(N).fill(null);let a=null;
  for(let i=1;i<N;i++){const tr=Math.max(Hi[i]-Lo[i],Math.abs(Hi[i]-C[i-1]),Math.abs(Lo[i]-C[i-1]));
    a=a===null?tr:(a*13+tr)/14;if(i>=14)o[i]=a;}return o;})();
const RSI=(()=>{const o=new Array(N).fill(null);let g=0,l=0;
  for(let i=1;i<N;i++){const d=C[i]-C[i-1];const up=d>0?d:0,dn=d<0?-d:0;
    if(i<=14){g+=up/14;l+=dn/14;} else {g=(g*13+up)/14;l=(l*13+dn)/14;}
    if(i>=14)o[i]=l===0?100:100-100/(1+g/l);}return o;})();
const ADX=(()=>{const o=new Array(N).fill(null);let tr=0,pd=0,nd=0,adx=null;
  for(let i=1;i<N;i++){const u=Hi[i]-Hi[i-1],d=Lo[i-1]-Lo[i];
    const p=(u>d&&u>0)?u:0,n=(d>u&&d>0)?d:0;
    const t=Math.max(Hi[i]-Lo[i],Math.abs(Hi[i]-C[i-1]),Math.abs(Lo[i]-C[i-1]));
    if(i<=14){tr+=t;pd+=p;nd+=n;} else {tr=tr-tr/14+t;pd=pd-pd/14+p;nd=nd-nd/14+n;}
    if(i>=14&&tr>0){const dip=100*pd/tr,dim=100*nd/tr,dx=100*Math.abs(dip-dim)/(dip+dim||1);
      adx=adx===null?dx:(adx*13+dx)/14;o[i]=adx;}}return o;})();
const e12=ema(C,12),e26=ema(C,26);
const MACD=C.map((_,i)=>e12[i]-e26[i]); const MSIG=ema(MACD,9);
const bb20=sma(C,20),bs20=stdev(C,20);

// ---------- outcome matrix ----------
function resolveAt(i,isLong){
  const sl=Math.max(2,Math.min(20,(ATR[i]||0)*1.5)); if(!(sl>0))return null;
  const fill=Date.parse(H1[i].time)+3600e3+DELAY*60e3, k=m5After(fill-1);
  if(k>=M5.length)return null;
  const entry=M5[k].open, slP=isLong?entry-sl:entry+sl, tp=isLong?entry+KTP*sl:entry-KTP*sl;
  const cost=SPREAD/sl;
  for(let j=k;j<M5.length;j++){const b=M5[j],bt=M5t[j];
    if(bt-fill>MAXHOLD)return{R:(isLong?b.open-entry:entry-b.open)/sl-cost,exit:bt,t:fill,sl};
    if(isLong?b.low<=slP:b.high>=slP)return{R:-1-cost,exit:bt,t:fill,sl};
    if(isLong?b.high>=tp:b.low<=tp)return{R:KTP-cost,exit:bt,t:fill,sl};}
  return null;
}
process.stderr.write('building outcome matrix... ');
const OUT={L:new Array(N).fill(null),S:new Array(N).fill(null)};
for(let i=WIN;i<N;i++){OUT.L[i]=resolveAt(i,true);OUT.S[i]=resolveAt(i,false);}
process.stderr.write('done\n');
const inSess=i=>{const h=parseInt(ukFmt.format(new Date(Date.parse(H1[i].time)+3600e3+DELAY*60e3)));
  return h>=8&&h<22;};

// ---------- PRE-REGISTERED UNIVERSE (fixed before running) ----------
const FAM={};
FAM['MAcross']=[[5,20],[10,50],[20,50],[50,200]].map(([f,s])=>({name:`MAcross ${f}/${s}`,fn:(()=>{const a=ema(C,f),b=ema(C,s);
  return i=>(a[i]>b[i]&&a[i-1]<=b[i-1])?'L':(a[i]<b[i]&&a[i-1]>=b[i-1])?'S':null;})()}));
FAM['Donchian']=[10,20,40].map(n=>({name:`Donchian ${n}`,fn:i=>{
  if(i<n+1)return null;const hh=Math.max(...Hi.slice(i-n,i)),ll=Math.min(...Lo.slice(i-n,i));
  return C[i]>hh?'L':C[i]<ll?'S':null;}}));
FAM['MACD']=[{name:'MACD 12/26/9',fn:i=>(MACD[i]>MSIG[i]&&MACD[i-1]<=MSIG[i-1])?'L':(MACD[i]<MSIG[i]&&MACD[i-1]>=MSIG[i-1])?'S':null}];
FAM['RSIrevert']=[[20,80],[25,75],[30,70]].map(([lo,hi])=>({name:`RSI revert ${lo}/${hi}`,
  fn:i=>RSI[i]==null?null:(RSI[i]<lo&&RSI[i-1]>=lo)?'L':(RSI[i]>hi&&RSI[i-1]<=hi)?'S':null}));
FAM['RSImomentum']=[[20,80],[30,70]].map(([lo,hi])=>({name:`RSI momo ${lo}/${hi}`,
  fn:i=>RSI[i]==null?null:(RSI[i]>hi&&RSI[i-1]<=hi)?'L':(RSI[i]<lo&&RSI[i-1]>=lo)?'S':null}));
FAM['BBrevert']=[[20,2.0],[20,2.5]].map(([p,k])=>({name:`BB revert ${p}/${k}`,fn:i=>{
  if(bb20[i]==null)return null;const u=bb20[i]+k*bs20[i],l=bb20[i]-k*bs20[i];
  return(C[i]<l&&C[i-1]>=bb20[i-1]-k*bs20[i-1])?'L':(C[i]>u&&C[i-1]<=bb20[i-1]+k*bs20[i-1])?'S':null;}}));
FAM['BBbreak']=[[20,2.0]].map(([p,k])=>({name:`BB break ${p}/${k}`,fn:i=>{
  if(bb20[i]==null)return null;const u=bb20[i]+k*bs20[i],l=bb20[i]-k*bs20[i];
  return(C[i]>u&&C[i-1]<=bb20[i-1]+k*bs20[i-1])?'L':(C[i]<l&&C[i-1]>=bb20[i-1]-k*bs20[i-1])?'S':null;}}));
FAM['VolBreak']=[1.0,1.5,2.0].map(k=>({name:`VolBreak ${k}xATR`,fn:i=>ATR[i]==null?null:
  (C[i]-O[i]>k*ATR[i])?'L':(O[i]-C[i]>k*ATR[i])?'S':null}));
FAM['Momentum']=[6,12,24].map(n=>({name:`Momentum ${n}b`,fn:i=>i<n?null:
  (C[i]/C[i-n]-1>0.01)?'L':(C[i]/C[i-n]-1<-0.01)?'S':null}));
FAM['MeanRevSMA']=[20,50].map(n=>{const s=sma(C,n);return{name:`Revert to SMA${n}`,fn:i=>s[i]==null||ATR[i]==null?null:
  (C[i]<s[i]-1.5*ATR[i])?'L':(C[i]>s[i]+1.5*ATR[i])?'S':null};});

// incumbent, from the REAL class
const ta=new TechnicalAnalysis(silent),strat=new EmaTrendStrategy(silent,ta);strat.saveState=()=>{};
const emaSig=new Array(N).fill(null);
for(let i=WIN;i<N;i++){const bt=Date.parse(H1[i].time);
  const htf=H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140);
  let a;try{a={indicators:ta.getLatestIndicators(H1.slice(i-WIN+1,i+1))};}catch{continue;}
  strat.lastSignalCandleTime=null;
  const r=strat.evaluateSetup(a,H1.slice(i-WIN+1,i+1),htf);
  if(r.signal)emaSig[i]=r.signal==='LONG'?'L':'S';}
FAM['INCUMBENT']=[{name:'EMA Trend (LIVE)',fn:i=>emaSig[i]}];

// overlays: regime gate x session
const OVERLAY=[
  {tag:'',        ok:i=>true},
  {tag:' +ADX>20',ok:i=>ADX[i]!=null&&ADX[i]>20},
  {tag:' +ADX<20',ok:i=>ADX[i]!=null&&ADX[i]<20},
];

// ---------- evaluate: sequential book, 1 pos, 2h cooldown from CLOSE, session filter ----------
function evaluate(sel,ok){
  const picks=[];
  for(let i=WIN;i<N;i++){const d=sel(i);if(!d)continue;if(!ok(i))continue;if(!inSess(i))continue;
    const o=d==='L'?OUT.L[i]:OUT.S[i];if(!o)continue;picks.push({...o,month:H1[i].time.slice(0,7)});}
  picks.sort((a,b)=>a.t-b.t);
  let free=0;const tk=[];
  for(const p of picks){if(p.t<free)continue;tk.push(p);free=p.exit+COOL;}
  return tk;
}
const months=[...new Set(H1.slice(WIN).map(c=>c.time.slice(0,7)))].sort();
const NM=months.length, split=months[Math.floor(NM/2)];
const sum=a=>a.reduce((x,y)=>x+y,0);
function stat(tk){
  if(tk.length<10)return null;
  const R=tk.map(t=>t.R),W=R.filter(r=>r>0);
  const gl=-sum(R.filter(r=>r<=0)),gw=sum(W);
  const tr=tk.filter(t=>t.month<split),te=tk.filter(t=>t.month>=split);
  let eq=0,pk=0,mx=0;for(const t of tk){eq+=t.R;if(eq>pk)pk=eq;if(pk-eq>mx)mx=pk-eq;}
  return{n:tk.length,perMo:sum(R)/NM,expR:sum(R)/tk.length,sumR:sum(R),dd:mx,rdd:sum(R)/(mx||1),
    wr:100*W.length/tk.length,pf:gl?gw/gl:99,
    trPerMo:sum(tr.map(t=>t.R))/(NM/2),tePerMo:sum(te.map(t=>t.R))/(NM/2),tk};
}
const results=[];
for(const [fam,list] of Object.entries(FAM))
  for(const s of list)
    for(const ov of OVERLAY){
      const st=stat(evaluate(s.fn,ov.ok));
      if(st)results.push({fam,name:s.name+ov.tag,...st});
    }
results.sort((a,b)=>b.perMo-a.perMo);
const inc=results.find(r=>r.fam==='INCUMBENT'&&r.name==='EMA Trend (LIVE)');
console.log(`\n=== PART 12: STRATEGY SEARCH — ${results.length} configs, ${NM} months, bracket exit ===`);
console.log(`INCUMBENT EMA Trend (LIVE): ${inc.perMo.toFixed(3)} R/month, n=${inc.n}, PF ${inc.pf.toFixed(2)}, TEST ${inc.tePerMo.toFixed(3)} R/mo\n`);
console.log('rank  config                               n   /mo   R/mo   E[R]   PF   maxDD  R/mo\u00f7DD  TEST');
results.slice(0,12).forEach((r,i)=>console.log(
  ` ${String(i+1).padStart(3)}  ${r.name.padEnd(34)} ${String(r.n).padStart(4)} ${(r.n/NM).toFixed(1).padStart(5)} ${r.perMo>=0?'+':''}${r.perMo.toFixed(2)} ${r.expR>=0?'+':''}${r.expR.toFixed(3)} ${r.pf.toFixed(2).padStart(5)} ${r.dd.toFixed(1).padStart(6)} ${(r.perMo/r.dd).toFixed(4).padStart(8)}  ${r.tePerMo>=0?'+':''}${r.tePerMo.toFixed(2)}`));
console.log('  --- incumbent for reference ---');
console.log(`      ${inc.name.padEnd(34)} ${String(inc.n).padStart(4)} ${(inc.n/NM).toFixed(1).padStart(5)} ${inc.perMo.toFixed(2)} +${inc.expR.toFixed(3)} ${inc.pf.toFixed(2).padStart(5)} ${inc.dd.toFixed(1).padStart(6)} ${(inc.perMo/inc.dd).toFixed(4).padStart(8)}  +${inc.tePerMo.toFixed(2)}`);

console.log('\n=== RISK-ADJUSTED RANKING (R per month PER UNIT of max drawdown) ===');
const byRdd=[...results].sort((a,b)=>(b.perMo/b.dd)-(a.perMo/a.dd));
console.log('rank  config                               R/mo  maxDD  R/mo\u00f7DD');
byRdd.slice(0,8).forEach((r,i)=>console.log(` ${String(i+1).padStart(3)}  ${r.name.padEnd(34)} ${r.perMo>=0?'+':''}${r.perMo.toFixed(2)} ${r.dd.toFixed(1).padStart(6)} ${(r.perMo/r.dd).toFixed(4).padStart(8)}`));
console.log(`  incumbent rank on this measure: ${byRdd.findIndex(r=>r.name==='EMA Trend (LIVE)')+1} of ${byRdd.length}`);

console.log('\n=== COST SENSITIVITY (spread per trade; thin-edge/high-frequency dies first) ===');
console.log('  config                             $0.30   $0.60   $1.00   $2.00');
for(const r of [...results.slice(0,6),inc]){
  const row=[0.30,0.60,1.00,2.00].map(sp=>{
    const adj=r.tk.map(t=>t.R-(sp-0.30)/t.sl);
    return (sum(adj)/NM);
  });
  console.log(`  ${r.name.padEnd(34)} ${row.map(v=>(v>=0?'+':'')+v.toFixed(2)).map(v=>v.padStart(6)).join('  ')}`);
}
const beat=results.filter(r=>r.perMo>inc.perMo);
console.log(`\nconfigs beating the incumbent: ${beat.length}/${results.length} (${(100*beat.length/results.length).toFixed(0)}%)`);
const beatBoth=beat.filter(r=>r.tePerMo>inc.tePerMo&&r.trPerMo>inc.trPerMo);
console.log(`...that ALSO beat it in BOTH train and test: ${beatBoth.length}  -> ${beatBoth.map(r=>r.name).join(', ')||'NONE'}`);

// ---------- White's Reality Check (month-block bootstrap of the MAX statistic) ----------
const byMonth={};for(const m of months)byMonth[m]=[];
for(const r of results)r.mm=months.map(m=>sum(r.tk.filter(t=>t.month===m).map(t=>t.R)));
const NB=2000,maxNull=[];
for(let b=0;b<NB;b++){
  const idx=Array.from({length:NM},()=>Math.floor(Math.random()*NM));
  let mx=-1e9;
  for(const r of results){let s=0;for(const j of idx)s+=r.mm[j];
    const v=s/NM-r.perMo; if(v>mx)mx=v;}       // centred: null = no strategy has edge
  maxNull.push(mx);
}
maxNull.sort((a,b)=>a-b);
const best=results[0];
const p=maxNull.filter(v=>v>=best.perMo).length/NB;
console.log(`\n=== WHITE'S REALITY CHECK (2000 month-block resamples, ${results.length} configs) ===`);
console.log(`  best config: ${best.name}  ${best.perMo.toFixed(3)} R/month`);
console.log(`  null distribution of the MAX statistic: 90th pct ${maxNull[Math.floor(0.9*NB)].toFixed(3)}, 95th ${maxNull[Math.floor(0.95*NB)].toFixed(3)}, 99th ${maxNull[Math.floor(0.99*NB)].toFixed(3)}`);
console.log(`  data-snooping-adjusted p-value = ${p.toFixed(3)}  -> ${p<0.05?'SIGNIFICANT after correction':'NOT significant once multiple testing is accounted for'}`);
console.log(`\n  (Under the null that NO config has edge, the best of ${results.length} would still average`);
console.log(`   ~${maxNull[Math.floor(0.5*NB)].toFixed(3)} R/month by chance alone, and exceed ${maxNull[Math.floor(0.95*NB)].toFixed(3)} R/month 5% of the time.)`);
fs.writeFileSync(`${SP}/search_results.json`,JSON.stringify(results.map(({tk,mm,...r})=>r)));
