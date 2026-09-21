#!/usr/bin/env node
/**
 * Backtest: risk-based sizing + wider (uncapped-ish) ATR stop vs the live $8-cap / 100u floor.
 *
 * Question: the live stop is clamp(ATR*1.5, $2, $8). With gold ATR now ~$25, the $8 cap puts
 * the stop INSIDE one bar's noise, so correct trades get whipsawed out. Does letting the stop be
 * the designed 1.5*ATR AND sizing risk-based (so a wide stop doesn't balloon the loss) help?
 *
 * Method (hybrid, deliberately conservative on the upside):
 *   - Baseline A = the real recorded outcomes (ground truth, units=100 floor). No model.
 *   - Wide-stop variants: WINNERS are kept at their recorded per-unit result (a wider stop can't
 *     turn a profit-trailed winner into a loss; it could only let it run FURTHER — so this UNDER-
 *     states the variant). Real $8-stop LOSERS are re-simulated on M1: does price reach entry +/-
 *     (1.5*ATR) before the trade resolves? If not, simulate the live trail/BE/TP management to see
 *     where it exits. Per-unit result * the variant's risk-based unit count.
 *
 * The only modeled claim is "would a ~$28-40 stop have survived where the $8 stop died" — a coarse,
 * spread-insensitive question M1 mid candles answer reliably. Winner upside is NOT modeled.
 */
import axios from 'axios';
import fs from 'fs';

const HOST = 'https://api-fxpractice.oanda.com';
const KEY = process.env.OANDA_API_KEY;
const H = { Authorization: `Bearer ${KEY}` };
const INSTRUMENT = 'XAU_USD';
const RISK_USD = 447.60;        // balance * 0.005, per live logs
const FX = 0.745;               // GBP per USD (from records pnl/pnlNotional)
const TP_RR = 2.0;              // EMA_TREND_TP_RR
const BE_PCT = 0.30;            // EMA_TREND_BE_TRIGGER_PCT
const PRE_ACT = 2.0;            // pre-BE trail activation ($)
const PRE_TRAIL = 1.50;         // pre-BE trail distance ($)
const TRAIL_ATR_MULT = 1.5;     // post-BE trail = ATR*1.5, clamped to SL bounds
const SCRATCH_USD = 100;        // |pnlNotional| below this = scratch (trail/BE exit, not a stop)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function candles(from, to, granularity) {
  const url = `${HOST}/v3/instruments/${INSTRUMENT}/candles`;
  const params = { from, to, granularity, price: 'M' };
  for (let a = 0; a < 4; a++) {
    try {
      const res = await axios.get(url, { headers: H, params });
      return (res.data.candles || []).filter(c => c.complete).map(c => ({
        t: c.time, o: +c.mid.o, h: +c.mid.h, l: +c.mid.l, c: +c.mid.c }));
    } catch (e) { if (a === 3) throw e; await sleep(500 * (a + 1)); }
  }
}

function parseATR(reason) {
  const m = reason && reason.match(/ATR \$([0-9.]+)/);
  return m ? +m[1] : null;
}

// Simulate the live management with a given SL distance. Returns { perUnit, exit }.
function simulate(isLong, entry, bars, atr, slDist) {
  const tpDist = slDist * TP_RR;
  const beTrigger = BE_PCT * tpDist;
  const postCapHi = slDist;            // post-BE trail clamped to the SL bound (live behaviour)
  const postCapLo = 2.0;
  let sl = isLong ? entry - slDist : entry + slDist;
  const tp = isLong ? entry + tpDist : entry - tpDist;
  let be = false;
  for (const b of bars) {
    // pessimistic: adverse extreme checked first, with SL as of bar start
    if (isLong ? b.l <= sl : b.h >= sl) {
      const pnl = isLong ? sl - entry : entry - sl;
      return { perUnit: pnl, exit: pnl >= 0 ? 'TRAIL+' : 'STOP' };
    }
    if (isLong ? b.h >= tp : b.l <= tp) return { perUnit: tpDist, exit: 'TP' };
    const fav = isLong ? b.h : b.l;
    const best = isLong ? fav - entry : entry - fav;
    if (!be && best >= beTrigger) { be = true; const imp = isLong ? entry > sl : entry < sl; if (imp) sl = entry; }
    if (be || best >= PRE_ACT) {
      const td = be ? Math.max(postCapLo, Math.min(postCapHi, atr * TRAIL_ATR_MULT)) : PRE_TRAIL;
      const nsl = isLong ? fav - td : fav + td;
      if (isLong ? nsl > sl : nsl < sl) sl = nsl;
    }
  }
  const last = bars[bars.length - 1];
  const pnl = isLong ? last.c - entry : entry - last.c;
  return { perUnit: pnl, exit: 'OPEN(eod)' };
}

const VARIANTS = [
  { name: 'B: risk-based + $40 cap', maxSL: 40, minPos: 10, riskBased: true },
  { name: 'C: $40 cap, KEEP 100u',   maxSL: 40, minPos: 100, riskBased: false },
];

function sizing(v, slDist) {
  if (!v.riskBased) return 100;
  return Math.max(v.minPos, Math.floor(RISK_USD / slDist));
}

function stats(rows) {
  const net = rows.reduce((s, r) => s + r.usd, 0);
  const W = rows.filter(r => r.usd > 0.5), L = rows.filter(r => r.usd < -0.5);
  const gw = W.reduce((s, r) => s + r.usd, 0), gl = -L.reduce((s, r) => s + r.usd, 0);
  let peak = 0, cum = 0, dd = 0;
  for (const r of rows) { cum += r.usd; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return { net, nW: W.length, nL: L.length, nS: rows.length - W.length - L.length,
    avgW: W.length ? gw / W.length : 0, avgL: L.length ? -gl / L.length : 0,
    pf: gl ? gw / gl : Infinity, dd };
}

async function main() {
  const sp = process.argv[2];
  const trades = JSON.parse(fs.readFileSync(sp + '/ema_trades.json', 'utf8'));
  console.log(`Loaded ${trades.length} trades.\n`);

  // attach ATR (parsed from reason, fallback H1 fetch) and M1 bars for real-stop losers
  for (const t of trades) {
    t.atr = parseATR(t.reason);
    t.isLong = t.signal === 'LONG';
    t.usdRec = t.pnlNotional;                       // recorded USD outcome
    t.isStop = (t.usdRec || 0) <= -SCRATCH_USD;     // real $8-stop loss
    if (!t.atr) {
      const h1 = await candles(new Date(new Date(t.entryTime) - 20 * 3600e3).toISOString(), t.entryTime, 'H1');
      if (h1 && h1.length > 14) {
        let trs = []; for (let i = 1; i < h1.length; i++) trs.push(Math.max(h1[i].h - h1[i].l, Math.abs(h1[i].h - h1[i-1].c), Math.abs(h1[i].l - h1[i-1].c)));
        t.atr = trs.slice(-14).reduce((a, b) => a + b, 0) / 14;
      } else t.atr = 18;
      await sleep(120);
    }
    if (t.isStop) {
      const entry = new Date(t.entryTime);
      const nowSafe = Date.now() - 6 * 60e3;
      const to = new Date(Math.min(entry.getTime() + 12 * 3600e3, nowSafe)).toISOString();
      t.m1 = await candles(t.entryTime, to, 'M1');
      await sleep(120);
    }
  }

  // GBP-native: baseline uses recorded GBP pnl; re-simmed losers convert USD price-move with the
  // trade's own GBP/USD ratio (fallback flat FX).
  for (const t of trades) t.fx = (t.pnl && t.pnlNotional) ? (t.pnl / t.pnlNotional) : FX;

  // ---- Baseline A: recorded reality (GBP) ----
  const A = trades.map(t => ({ usd: t.pnl, exit: t.isStop ? 'STOP(real)' : (t.pnl > 0 ? 'win' : 'scr') }));
  const sA = stats(A);

  // ---- Wide-stop variants (GBP) ----
  const out = {};
  for (const v of VARIANTS) {
    const rows = trades.map(t => {
      const slDist = Math.max(2, Math.min(v.maxSL, t.atr * 1.5));
      const units = sizing(v, slDist);
      if (!t.isStop) {                                  // winner/scratch kept at recorded per-unit (GBP)
        const perUnitGbp = t.pnl / (t.size || 100);
        return { usd: perUnitGbp * units, exit: t.pnl > 0 ? 'win(kept)' : 'scr(kept)', slDist, units, t };
      }
      const r = simulate(t.isLong, t.entryPrice, t.m1 || [], t.atr, slDist);   // re-sim loser under wide stop
      return { usd: r.perUnit * units * t.fx, exit: r.exit, slDist, units, t };  // price-move USD → GBP
    });
    out[v.name] = { rows, s: stats(rows) };
  }

  // ---- Report (all GBP) ----
  const g = (u) => '£' + u.toFixed(0);
  console.log('VALIDATION  baseline-A net = ' + g(sA.net) + '  vs tracker recorded (-£642, must match)\n');
  console.log('='.repeat(104));
  console.log('VARIANT'.padEnd(28), 'NET(£)'.padStart(9), 'W/L/scr'.padStart(11), 'avgW'.padStart(8), 'avgL'.padStart(9), 'PF'.padStart(6), 'maxDD(£)'.padStart(10));
  console.log('='.repeat(104));
  const line = (name, s) => console.log(name.padEnd(28), g(s.net).padStart(9), `${s.nW}/${s.nL}/${s.nS}`.padStart(11), g(s.avgW).padStart(8), g(s.avgL).padStart(9), s.pf.toFixed(2).padStart(6), g(s.dd).padStart(10));
  line('A: LIVE ($8 cap, 100u)', sA);
  for (const v of VARIANTS) line(v.name, out[v.name].s);
  console.log('='.repeat(104));

  // per-trade detail for the 7 real stop-outs: did the wide stop survive?
  console.log('\nThe 7 big stop-outs under "B: risk-based + $40 cap"  [entry, ATR, new SL, units, outcome]');
  console.log('-'.repeat(104));
  const B = out['B: risk-based + $40 cap'].rows;
  trades.forEach((t, i) => {
    if (!t.isStop) return;
    const r = B[i];
    console.log(
      t.entryTime.slice(5, 16), t.signal.padEnd(5),
      'ATR $' + t.atr.toFixed(1).padStart(5),
      ' newSL $' + r.slDist.toFixed(1).padStart(4),
      ' ' + String(r.units).padStart(3) + 'u',
      ' live=' + ('£' + t.pnl.toFixed(0)).padStart(6),
      ' →B ' + r.exit.padEnd(10),
      ' = ' + ('£' + r.usd.toFixed(0)).padStart(6),
    );
  });
}
main().catch(e => { console.error('ERR', e.response?.data || e.message); process.exit(1); });
