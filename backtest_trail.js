#!/usr/bin/env node
/**
 * Backtest: loosening the pre-breakeven trail, on top of the wide (1.5*ATR, $40-cap) stop.
 *
 * Re-simulates ALL 29 trades bar-by-bar on M1 (no "keep recorded" shortcut — the trail is what
 * determines a winner's exit, so winners MUST be re-simmed). Faithful to live management:
 *   SL = clamp(ATR*1.5, $2, maxSL);  TP = 2*SL;  BE snaps stop->entry at 30% of TP (monotonic);
 *   pre-BE: once profit >= activation ($2), trail at PRE_TRAIL;  post-BE: trail ATR*1.5 clamped to SL.
 * Stop checks pessimistic (adverse extreme before that bar's favourable extreme tightens the trail).
 *
 * Two validation rows guard fidelity:
 *   V-tight = live config ($8 stop, $1.50 trail, real stops forced) -> must reproduce -£642
 *   V-wide  = $40 stop, $1.50 trail, 100u                          -> must reproduce C's +£4,590
 * If both hold, the trail sweep below is trustworthy. Looser trails are LESS intrabar-sensitive,
 * so fidelity improves as PRE_TRAIL grows.
 */
import axios from 'axios';
import fs from 'fs';

const HOST = 'https://api-fxpractice.oanda.com';
const KEY = process.env.OANDA_API_KEY;
const H = { Authorization: `Bearer ${KEY}` };
const INSTRUMENT = 'XAU_USD';
const RISK_USD = 447.60, FX = 0.745, TP_RR = 2.0, BE_PCT = 0.30, PRE_ACT = 2.0, TRAIL_ATR_MULT = 1.5;
const SCRATCH_USD = 100;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function candles(from, to, granularity) {
  const url = `${HOST}/v3/instruments/${INSTRUMENT}/candles`;
  for (let a = 0; a < 4; a++) {
    try {
      const res = await axios.get(url, { headers: H, params: { from, to, granularity, price: 'M' } });
      return (res.data.candles || []).filter(c => c.complete).map(c => ({ t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c }));
    } catch (e) { if (a === 3) throw e; await sleep(500 * (a + 1)); }
  }
}
const parseATR = (r) => { const m = r && r.match(/ATR \$([0-9.]+)/); return m ? +m[1] : null; };

// returns per-unit price P&L + exit label
function sim(isLong, entry, bars, atr, slDist, preTrail) {
  const tpDist = slDist * TP_RR, beTrigger = BE_PCT * tpDist;
  let sl = isLong ? entry - slDist : entry + slDist;
  const tp = isLong ? entry + tpDist : entry - tpDist;
  let be = false;
  for (const b of bars) {
    if (isLong ? b.l <= sl : b.h >= sl) { const p = isLong ? sl - entry : entry - sl; return { perUnit: p, exit: p >= 0 ? 'TRAIL+' : 'STOP' }; }
    if (isLong ? b.h >= tp : b.l <= tp) return { perUnit: tpDist, exit: 'TP' };
    const fav = isLong ? b.h : b.l, best = isLong ? fav - entry : entry - fav;
    if (!be && best >= beTrigger) { be = true; if (isLong ? entry > sl : entry < sl) sl = entry; }
    if (be || best >= PRE_ACT) {
      const td = be ? Math.max(2, Math.min(slDist, atr * TRAIL_ATR_MULT)) : preTrail;
      const nsl = isLong ? fav - td : fav + td;
      if (isLong ? nsl > sl : nsl < sl) sl = nsl;
    }
  }
  const last = bars[bars.length - 1];
  return { perUnit: isLong ? last.c - entry : entry - last.c, exit: 'OPEN(eod)' };
}

function stats(rows) {
  const net = rows.reduce((s, r) => s + r.gbp, 0);
  const W = rows.filter(r => r.gbp > 0.5), L = rows.filter(r => r.gbp < -0.5);
  const gw = W.reduce((s, r) => s + r.gbp, 0), gl = -L.reduce((s, r) => s + r.gbp, 0);
  let peak = 0, cum = 0, dd = 0;
  for (const r of rows) { cum += r.gbp; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { net, nW: W.length, nL: L.length, nS: rows.length - W.length - L.length, avgW: W.length ? gw / W.length : 0, avgL: L.length ? -gl / L.length : 0, pf: gl ? gw / gl : Infinity, dd };
}

function run(trades, { maxSL, preTrail, riskBased, forceStops }) {
  return trades.map(t => {
    const slDist = Math.max(2, Math.min(maxSL, t.atr * 1.5));
    const units = riskBased ? Math.max(10, Math.floor(RISK_USD / slDist)) : 100;
    if (forceStops && t.isStop) return { gbp: -slDist * units * t.fx, exit: 'STOP(real)', units, slDist, t };
    let r = sim(t.isLong, t.entryPrice, t.m1 || [], t.atr, slDist, preTrail);
    if (r.exit === 'OPEN(eod)') { const perU = t.pnl / (t.size || 100); return { gbp: perU * units, exit: 'kept(open)', units, slDist, t }; } // 2 multi-day March trades
    return { gbp: r.perUnit * units * t.fx, exit: r.exit, units, slDist, t };
  });
}

async function main() {
  const sp = process.argv[2];
  const trades = JSON.parse(fs.readFileSync(sp + '/ema_trades.json', 'utf8'));
  console.log(`Loaded ${trades.length} trades. Fetching M1 for all...\n`);
  for (const t of trades) {
    t.atr = parseATR(t.reason) || 18;
    t.isLong = t.signal === 'LONG';
    t.isStop = (t.pnlNotional || 0) <= -SCRATCH_USD;
    t.fx = (t.pnl && t.pnlNotional) ? (t.pnl / t.pnlNotional) : FX;
    const entry = new Date(t.entryTime), nowSafe = Date.now() - 6 * 60e3;
    const to = new Date(Math.min(entry.getTime() + 12 * 3600e3, nowSafe)).toISOString();
    t.m1 = await candles(t.entryTime, to, 'M1');
    await sleep(100);
  }

  const recorded = trades.reduce((s, t) => s + t.pnl, 0);
  const vTight = stats(run(trades, { maxSL: 8, preTrail: 1.5, riskBased: false, forceStops: true }));
  const vWide = stats(run(trades, { maxSL: 40, preTrail: 1.5, riskBased: false, forceStops: false }));
  console.log(`VALIDATION  V-tight net=£${vTight.net.toFixed(0)} (target -£642)   V-wide net=£${vWide.net.toFixed(0)} (target ~+£4590)\n`);

  const TRAILS = [{ n: '$1.50 (current)', v: 1.5 }, { n: '$3.00', v: 3 }, { n: '$4.00', v: 4 }, { n: '$5.00', v: 5 }, { n: '$6.00', v: 6 }, { n: 'no pre-BE trail', v: 9999 }];
  for (const [label, riskBased] of [['C: $40 stop, KEEP 100u', false], ['B: $40 stop, risk-based units', true]]) {
    console.log('='.repeat(98));
    console.log(label.padEnd(34), 'NET(£)'.padStart(9), 'W/L/scr'.padStart(11), 'avgW'.padStart(8), 'avgL'.padStart(9), 'PF'.padStart(6), 'maxDD'.padStart(8));
    console.log('='.repeat(98));
    for (const tr of TRAILS) {
      const s = stats(run(trades, { maxSL: 40, preTrail: tr.v, riskBased }));
      console.log(('  preTrail ' + tr.n).padEnd(34), ('£' + s.net.toFixed(0)).padStart(9), `${s.nW}/${s.nL}/${s.nS}`.padStart(11), ('£' + s.avgW.toFixed(0)).padStart(8), ('£' + s.avgL.toFixed(0)).padStart(9), s.pf.toFixed(2).padStart(6), ('£' + s.dd.toFixed(0)).padStart(8));
    }
    console.log('');
  }

  // per-trade: under C, how the biggest winners change $1.50 -> $5.00, and any winner that flips to a loss
  console.log('PER-TRADE (C, 100u)  $1.50 vs $5.00 pre-BE trail  [all 29, GBP]');
  console.log('-'.repeat(98));
  const a = run(trades, { maxSL: 40, preTrail: 1.5, riskBased: false });
  const b = run(trades, { maxSL: 40, preTrail: 5, riskBased: false });
  trades.forEach((t, i) => {
    const d = b[i].gbp - a[i].gbp;
    const flag = (a[i].gbp > 0 && b[i].gbp < 0) ? '  <-- FLIPPED TO LOSS' : '';
    console.log(t.entryTime.slice(5, 16), t.signal.padEnd(5), ('$1.50=£' + a[i].gbp.toFixed(0)).padStart(13), a[i].exit.padEnd(11), ('$5=£' + b[i].gbp.toFixed(0)).padStart(11), b[i].exit.padEnd(11), (d >= 0 ? 'Δ+£' + d.toFixed(0) : 'Δ-£' + Math.abs(d).toFixed(0)).padStart(9), flag);
  });
}
main().catch(e => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
