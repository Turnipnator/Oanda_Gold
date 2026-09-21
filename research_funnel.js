#!/usr/bin/env node
/**
 * Part 10 Q1-Q4 — where do candidates actually go, and is the movement capturable?
 * Funnel built from CANDLE DATA, not log lines: Oanda emits no candles when the market is
 * shut, so the weekend contamination that invalidated the Sep-20 log counts cannot occur.
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';
const SP = process.env.TP_SP;
const silent={info(){},error(){},warn(){},debug(){}};
const H1=JSON.parse(fs.readFileSync(`${SP}/H1.json`)), H4=JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const ta=new TechnicalAnalysis(silent), strat=new EmaTrendStrategy(silent,ta); strat.saveState=()=>{};
const ukFmt=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'numeric',hour12:false});
const WIN=250;

const reasons={}, adxVals=[], atrVals=[]; let evaluated=0, signals=0, inSess=0;
const rows=[];
for(let i=WIN;i<H1.length;i++){
  const bar=H1[i], bt=Date.parse(bar.time);
  const win=H1.slice(i-WIN+1,i+1);
  const htf=H4.filter(c=>Date.parse(c.time)+4*3600e3<=bt).slice(-140);
  let a; try{ a={indicators:ta.getLatestIndicators(win)}; }catch{ continue; }
  strat.lastSignalCandleTime=null;
  const res=strat.evaluateSetup(a,win,htf);
  evaluated++;
  adxVals.push(a.indicators.adx); atrVals.push(strat.lastATR||NaN);
  const hour=parseInt(ukFmt.format(new Date(bt+3600e3)));
  const sess=hour>=Config.TRADING_START_HOUR&&hour<Config.TRADING_END_HOUR;
  if(sess) inSess++;
  if(res.signal){ signals++; }
  else {
    // normalise the reason string into a gate bucket
    const r=(res.reason||'unknown').toLowerCase();
    let b='other';
    if(r.includes('leg filter'))            b='leg filter (move already ran)';
    else if(r.includes('rsi'))              b='RSI outside band';
    else if(r.includes('not aligned')||r.includes('alignment')) b='EMAs not aligned';
    else if(r.includes('adx'))              b='ADX too low / declining';
    else if(r.includes('pullback'))         b='no pullback to fast EMA';
    else if(r.includes('htf')||r.includes('h4')) b='HTF disagrees';
    else b='other: '+r.slice(0,45);
    reasons[b]=(reasons[b]||0)+1;
  }
  rows.push({t:bar.time,adx:a.indicators.adx,sess,sig:!!res.signal});
}
console.log(`\n=== FUNNEL over ${evaluated} H1 bars (26.7 months, market-open bars only) ===`);
console.log(`  in-session bars: ${inSess} (${(100*inSess/evaluated).toFixed(0)}%)`);
console.log(`  SIGNALS: ${signals} (${(100*signals/evaluated).toFixed(2)}% of bars)\n`);
console.log('  blocked by:');
Object.entries(reasons).sort((a,b)=>b[1]-a[1]).forEach(([k,v])=>
  console.log(`    ${k.padEnd(34)} ${String(v).padStart(6)}  ${(100*v/evaluated).toFixed(1)}%`));

// ---- regime occupancy -----------------------------------------------------
const sorted=[...adxVals].sort((a,b)=>a-b);
const pct=p=>sorted[Math.floor(p*sorted.length)];
const below20=adxVals.filter(x=>x<20).length;
console.log(`\n=== REGIME OCCUPANCY (our own ADX>20 definition of "trending") ===`);
console.log(`  ADX median ${pct(0.5).toFixed(1)}, p25 ${pct(0.25).toFixed(1)}, p75 ${pct(0.75).toFixed(1)}, p90 ${pct(0.9).toFixed(1)}`);
console.log(`  bars with ADX < 20 (RANGING): ${below20} = ${(100*below20/adxVals.length).toFixed(1)}% of all market-open time`);
console.log(`  -> a trend-only bot is structurally idle ~${(100*below20/adxVals.length).toFixed(0)}% of the time BY DESIGN`);

// ---- H4: is the oscillation capturable? -----------------------------------
const atrS=atrVals.filter(x=>isFinite(x)).sort((a,b)=>a-b);
const atrMed=atrS[Math.floor(atrS.length/2)];
console.log(`\n=== H4 TEST: is the movement big enough to trade? ===`);
console.log(`  median H1 ATR(14) = $${atrMed.toFixed(2)}`);
console.log(`  live stop = 1.5xATR capped $20 -> $${Math.min(20,atrMed*1.5).toFixed(2)}; spread ~$0.30`);
// H1 bar range distribution, and swing size in ranging regimes
const rng=H1.slice(WIN).map(c=>c.high-c.low).sort((a,b)=>a-b);
console.log(`  H1 bar range: median $${rng[Math.floor(rng.length/2)].toFixed(2)}, p75 $${rng[Math.floor(0.75*rng.length)].toFixed(2)}, p90 $${rng[Math.floor(0.9*rng.length)].toFixed(2)}`);
// oscillation amplitude: rolling 12h high-low in ranging (ADX<20) windows
const osc=[];
for(let i=WIN+12;i<H1.length;i++){
  const w=H1.slice(i-12,i); const hi=Math.max(...w.map(c=>c.high)), lo=Math.min(...w.map(c=>c.low));
  osc.push({amp:hi-lo, adx:adxVals[i-WIN]});
}
const oR=osc.filter(o=>o.adx<20).map(o=>o.amp).sort((a,b)=>a-b);
const oT=osc.filter(o=>o.adx>=20).map(o=>o.amp).sort((a,b)=>a-b);
console.log(`  12h swing amplitude, RANGING (ADX<20): median $${oR[Math.floor(oR.length/2)].toFixed(2)}, p25 $${oR[Math.floor(0.25*oR.length)].toFixed(2)}`);
console.log(`  12h swing amplitude, TRENDING(ADX>=20): median $${oT[Math.floor(oT.length/2)].toFixed(2)}`);
console.log(`  -> a $20 stop + $20 target needs a $40 round trip. Share of RANGING 12h windows that even span $40: ${(100*oR.filter(x=>x>=40).length/oR.length).toFixed(1)}%`);
fs.writeFileSync(`${SP}/funnel_rows.json`,JSON.stringify(rows));
