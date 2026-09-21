#!/usr/bin/env node
/**
 * News-exposure study: what do scheduled US releases (NFP, CPI, FOMC) cost the bracket
 * regime, and does a calendar filter help?
 *
 * Motivated by Sep 4 2026: a verified $20 stop filled $28 past its level when NFP gapped
 * gold $45 in one 5-second bar (−2.40R). Every prior replay filled stops AT level on
 * mid-price M5 candles, so gap cost has never been charged.
 *
 * METHOD — same signal-level design as research_session_filter.js (every H1 bar evaluated
 * independently with the real EmaTrendStrategy, 15-min fill delay, measured spreads,
 * month-block bootstrap). Three managed outcomes per signal:
 *   mid  : M5 mid-price bracket, stop fills at level              (= all earlier replays)
 *   gap  : as mid, but inside ±10 min of a release the position is managed on S5 BID/ASK
 *          bars: a LONG stop fills at the first bid print at or through it (bar open if
 *          the bar opens through, else pessimistic bar low), a SHORT stop on the ask;
 *          a TP that is gapped through fills at the better price.
 *   flat : as gap, but the position is closed NF_FLAT_MIN before the release at the
 *          then-current bid/ask.
 * Entry-block variants drop signals filled within PRE hours before / POST minutes after
 * a release. (2 h / 0 min was pre-registered in research_notes Part 7; the rest is
 * sensitivity, not selection.)
 *
 * Inputs (scratchpad): H1.json H4.json M5.json (mid) + events.json (calendar with S5 BA).
 * Env: SP=<dir> NF_DELAY_MIN=15 NF_SPREAD=0.59 NF_SPREAD_OOS=0.69 NF_FLAT_MIN=5
 *      NF_OPTIMISTIC=1 (fill at stop level when a bar straddles it) NF_BOOT=2000
 */
import fs from 'fs';
import Config from './src/config.js';
import TechnicalAnalysis from './src/technical_analysis.js';
import EmaTrendStrategy from './src/ema_trend_strategy.js';

const SP = process.env.SP;
const DELAY_MIN = parseFloat(process.env.NF_DELAY_MIN || '15');
const SPREAD = parseFloat(process.env.NF_SPREAD || '0.59');
const SPREAD_OOS = parseFloat(process.env.NF_SPREAD_OOS || '0.69');
const NBOOT = parseInt(process.env.NF_BOOT || '2000');
const MAXHOLD_MS = parseFloat(process.env.NF_MAXHOLD_H || '120') * 3600e3;
const FLAT_MIN = parseFloat(process.env.NF_FLAT_MIN || '5');
const PESSIMISTIC = process.env.NF_OPTIMISTIC !== '1';
const S5_PRE = 10 * 60e3, S5_POST = 10 * 60e3;
const WIN = 250;

const silent = { info() {}, error() {}, warn() {}, debug() {} };
const H1 = JSON.parse(fs.readFileSync(`${SP}/H1.json`));
const H4 = JSON.parse(fs.readFileSync(`${SP}/H4.json`));
const M5 = JSON.parse(fs.readFileSync(`${SP}/M5.json`));
const M5t = M5.map(c => Date.parse(c.time));
const EV = JSON.parse(fs.readFileSync(`${SP}/events.json`))
  .filter(e => e.s5.length > 0)
  .map(e => ({ ...e, T: Date.parse(e.utc), s5: e.s5.map(b => ({ ...b, t: Date.parse(b.t) })) }))
  .sort((a, b) => a.T - b.T);

const ta = new TechnicalAnalysis(silent);
const strat = new EmaTrendStrategy(silent, ta);
strat.saveState = () => {};
const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);

const ukFmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour: 'numeric', hour12: false });
const ukHour = ms => parseInt(ukFmt.format(new Date(ms)));
function m5After(t) {
  let lo = 0, hi = M5t.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (M5t[m] <= t) lo = m + 1; else hi = m; }
  return lo;
}

/** Bracket management. mode: 'mid' | 'gap' | 'flat'. */
function manage(isLong, entry, slDist, entryMs, mode) {
  const tpDist = slDist * Config.EMA_TREND_TP_RR;
  const sl = isLong ? entry - slDist : entry + slDist;
  const tp = isLong ? entry + tpDist : entry - tpDist;
  let mfe = 0, mae = 0;
  const crossed = [];
  const done = (R, exit, t, extra = {}) =>
    ({ R, exit, holdH: (t - entryMs) / 3600e3, mfe, mae, crossed, exitMs: t, ...extra });
  let ev = mode === 'mid' ? EV.length : EV.findIndex(e => e.T + S5_POST > entryMs);
  if (ev < 0) ev = EV.length;
  let i = m5After(entryMs);
  while (i < M5.length) {
    const bt = M5t[i];
    if (ev < EV.length && bt >= EV[ev].T - S5_PRE) {
      const e = EV[ev++];
      const tag = `${e.kind} ${e.day}`;
      crossed.push(tag);
      const wStart = Math.max(entryMs, e.T - S5_PRE);
      const flatAt = e.T - FLAT_MIN * 60e3;
      for (const b of e.s5) {
        if (b.t < wStart) continue;
        if (mode === 'flat' && b.t >= flatAt) {
          const per = isLong ? b.bo - entry : entry - b.ao;
          return done(per / slDist, 'FLAT', b.t, { flatEvent: tag });
        }
        const fav = isLong ? b.bh - entry : entry - b.al;
        const adv = isLong ? entry - b.bl : b.ah - entry;
        if (fav > mfe) mfe = fav;
        if (adv > mae) mae = adv;
        if (isLong) {
          if (b.bl <= sl) {
            const fill = b.bo <= sl ? b.bo : (PESSIMISTIC ? b.bl : sl);
            return done((fill - entry) / slDist, 'STOP', b.t, { slip: sl - fill, slipEvent: tag });
          }
          if (b.bh >= tp) {
            const fill = b.bo >= tp ? b.bo : tp;
            return done((fill - entry) / slDist, 'TP', b.t, { slip: tp - fill, slipEvent: tag });
          }
        } else {
          if (b.ah >= sl) {
            const fill = b.ao >= sl ? b.ao : (PESSIMISTIC ? b.ah : sl);
            return done((entry - fill) / slDist, 'STOP', b.t, { slip: fill - sl, slipEvent: tag });
          }
          if (b.al <= tp) {
            const fill = b.ao <= tp ? b.ao : tp;
            return done((entry - fill) / slDist, 'TP', b.t, { slip: fill - tp, slipEvent: tag });
          }
        }
      }
      i = m5After(e.T + S5_POST - 1);
      continue;
    }
    const b = M5[i];
    if (bt - entryMs > MAXHOLD_MS) {
      const per = isLong ? b.open - entry : entry - b.open;
      return done(per / slDist, 'TIME', bt);
    }
    const fav = isLong ? b.high - entry : entry - b.low;
    const adv = isLong ? entry - b.low : b.high - entry;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
    const hitSL = isLong ? b.low <= sl : b.high >= sl;
    const hitTP = isLong ? b.high >= tp : b.low <= tp;
    if (hitSL) return done(-1, 'STOP', bt);
    if (hitTP) return done(Config.EMA_TREND_TP_RR, 'TP', bt);
    i++;
  }
  const last = M5[M5.length - 1];
  const per = isLong ? last.close - entry : entry - last.close;
  return done(per / slDist, 'OPEN', M5t[M5.length - 1]);
}

function collect() {
  const sigs = [];
  for (let i = WIN; i < H1.length; i++) {
    const bar = H1[i], bt = Date.parse(bar.time);
    const win = H1.slice(i - WIN + 1, i + 1);
    const htf = H4.filter(c => Date.parse(c.time) + 4 * 3600e3 <= bt).slice(-140);
    let analysis;
    try { analysis = { indicators: ta.getLatestIndicators(win) }; } catch { continue; }
    strat.lastSignalCandleTime = null;
    const res = strat.evaluateSetup(analysis, win, htf);
    if (!res.signal) continue;
    const atr = strat.lastATR;
    const isLong = res.signal === 'LONG';
    const slDist = Math.max(minSL, Math.min(maxSL, atr * Config.EMA_TREND_ATR_SL_MULT));
    const fillMs = bt + 3600e3 + DELAY_MIN * 60e3;
    const k = m5After(fillMs - 1);
    if (k >= M5.length) continue;
    const entry = M5[k].open;
    const hour = ukHour(fillMs);
    const inSession = hour >= Config.TRADING_START_HOUR && hour < Config.TRADING_END_HOUR;
    const cost = (inSession ? SPREAD : SPREAD_OOS) / slDist;
    const out = {};
    for (const mode of ['mid', 'gap', 'flat']) {
      const m = manage(isLong, entry, slDist, fillMs, mode);
      out[mode] = { ...m, R: m.R - cost };
    }
    // Distance to the nearest release before/after the fill, for the entry-block variants.
    const next = EV.find(e => e.T >= fillMs), prev = [...EV].reverse().find(e => e.T < fillMs);
    sigs.push({
      time: bar.time, month: bar.time.slice(0, 7), year: bar.time.slice(0, 4), signal: res.signal,
      hour, inSession, atr, slDist, rsi: analysis.indicators.rsi, adx: analysis.indicators.adx,
      entry, fillMs, out,
      preH: next ? (next.T - fillMs) / 3600e3 : 999, nextKind: next?.kind,
      postMin: prev ? (fillMs - prev.T) / 60e3 : 99999, prevKind: prev?.kind,
      exposedMid: EV.filter(e => e.T > fillMs && e.T < out.mid.exitMs).map(e => `${e.kind} ${e.day}`),
    });
  }
  return sigs;
}

// ---------- stats ----------
const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const R = (s, mode) => s.out[mode].R;
function summarise(a, mode) {
  if (!a.length) return { n: 0 };
  const Rs = a.map(s => R(s, mode));
  const W = Rs.filter(r => r > 0), L = Rs.filter(r => r <= 0);
  const gw = W.reduce((x, y) => x + y, 0), gl = -L.reduce((x, y) => x + y, 0);
  return {
    n: a.length, expR: +mean(Rs).toFixed(3), sumR: +Rs.reduce((x, y) => x + y, 0).toFixed(1),
    wr: +(100 * W.length / a.length).toFixed(1), pf: +(gl ? gw / gl : 99).toFixed(2),
    tp: +(100 * a.filter(s => s.out[mode].exit === 'TP').length / a.length).toFixed(1),
    worst: +Math.min(...Rs).toFixed(2),
  };
}
/** Month-block bootstrap on paired per-signal differences f(s). */
function bootPaired(set, f, nboot = NBOOT) {
  const months = [...new Set(set.map(s => s.month))];
  const by = {}; for (const m of months) by[m] = [];
  for (const s of set) by[s.month].push(f(s));
  const ms = [];
  for (let b = 0; b < nboot; b++) {
    const a = [];
    for (let k = 0; k < months.length; k++) a.push(...by[months[Math.floor(Math.random() * months.length)]]);
    if (a.length) ms.push(mean(a));
  }
  ms.sort((x, y) => x - y);
  const q = p => +ms[Math.floor(p * ms.length)].toFixed(3);
  return { lo: q(0.05), mid: q(0.5), hi: q(0.95), pNeg: +(ms.filter(x => x < 0).length / ms.length).toFixed(3) };
}
/** Sequential one-position-at-a-time portfolio with the live cooldown. */
function sequential(set, mode, block = () => false) {
  const cd = Config.TRADE_COOLDOWN_HOURS * 3600e3;
  let lastExit = -Infinity, eq = 0, peak = 0, dd = 0, n = 0, gw = 0, gl = 0, worst = 0;
  for (const s of [...set].sort((a, b) => a.fillMs - b.fillMs)) {
    if (s.fillMs < lastExit + cd) continue;
    if (block(s)) continue;
    const r = R(s, mode); n++; eq += r; if (r > 0) gw += r; else gl -= r;
    if (r < worst) worst = r;
    if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq;
    lastExit = s.out[mode].exitMs;
  }
  return { n, sumR: +eq.toFixed(1), expR: +(eq / (n || 1)).toFixed(3), pf: +(gl ? gw / gl : 99).toFixed(2), maxDD: +dd.toFixed(1), worst: +worst.toFixed(2) };
}

// ---------- run ----------
const sigs = collect();
fs.writeFileSync(`${SP}/signals_news_${PESSIMISTIC ? 'pess' : 'opt'}.json`, JSON.stringify(sigs));
const IN = sigs.filter(s => s.inSession);
console.log(`\n=== NEWS-EXPOSURE STUDY [${PESSIMISTIC ? 'pessimistic' : 'optimistic'} S5 fills] ===`);
console.log(`window ${H1[0].time.slice(0, 10)} → ${H1[H1.length - 1].time.slice(0, 10)}  events ${EV.length}  delay ${DELAY_MIN}min  spread $${SPREAD}`);
console.log(`signals ${sigs.length}, in-session ${IN.length}\n`);

console.log('1. HEADLINE (in-session signals, three fill models)');
console.table({ 'mid (all earlier replays)': summarise(IN, 'mid'), 'gap (S5 bid/ask at releases)': summarise(IN, 'gap'), [`flat ${FLAT_MIN}min before`]: summarise(IN, 'flat') });

const exposed = IN.filter(s => s.out.gap.crossed.length > 0);
console.log(`\n2. EXPOSURE: ${exposed.length} of ${IN.length} in-session trades were open through ≥1 release (${(100 * exposed.length / IN.length).toFixed(0)}%)`);
const byKind = {};
for (const s of exposed) for (const c of s.out.gap.crossed) { const k = c.split(' ')[0]; byKind[k] = (byKind[k] || 0) + 1; }
console.log('   crossings by kind:', byKind);
console.table({ 'exposed: mid': summarise(exposed, 'mid'), 'exposed: gap': summarise(exposed, 'gap'), 'exposed: flat': summarise(exposed, 'flat'), 'unexposed': summarise(IN.filter(s => !s.out.gap.crossed.length), 'mid') });
const slipped = exposed.filter(s => s.out.gap.slipEvent && s.out.gap.exit === 'STOP');
const tpGap = exposed.filter(s => s.out.gap.slipEvent && s.out.gap.exit === 'TP');
console.log(`   stops filled inside a release window: ${slipped.length}; TPs filled inside a release window: ${tpGap.length}`);
if (slipped.length) {
  const sl = slipped.map(s => s.out.gap.slip);
  console.log(`   stop slippage $: mean ${mean(sl).toFixed(2)}, median ${sl.sort((a, b) => a - b)[Math.floor(sl.length / 2)].toFixed(2)}, max ${Math.max(...sl).toFixed(2)}; in R: mean ${mean(slipped.map(s => s.out.gap.slip / s.slDist)).toFixed(2)}`);
  console.log('   worst 8:');
  for (const s of [...slipped].sort((a, b) => a.out.gap.R - b.out.gap.R).slice(0, 8))
    console.log(`     ${s.time.slice(0, 16)} ${s.signal} entry ${s.entry.toFixed(2)} sl$${s.slDist.toFixed(1)} ${s.out.gap.slipEvent} slip $${s.out.gap.slip.toFixed(2)} R ${s.out.gap.R.toFixed(2)} (mid ${s.out.mid.R.toFixed(2)})`);
}
if (tpGap.length) console.log(`   TP gap bonus $: mean ${mean(tpGap.map(s => s.out.gap.slip)).toFixed(2)}, max ${Math.max(...tpGap.map(s => s.out.gap.slip)).toFixed(2)}`);

console.log('\n3. GAP COST (gap − mid), paired month-block bootstrap, in-session');
console.log('   per-trade all       :', bootPaired(IN, s => R(s, 'gap') - R(s, 'mid')));
console.log('   per-trade exposed   :', bootPaired(exposed, s => R(s, 'gap') - R(s, 'mid')));
console.log('   by year (sum of gap−mid):');
for (const y of ['2024', '2025', '2026']) {
  const a = IN.filter(s => s.year === y), e = exposed.filter(s => s.year === y);
  console.log(`     ${y}: n=${a.length} exposed=${e.length} ΔsumR=${a.reduce((p, s) => p + R(s, 'gap') - R(s, 'mid'), 0).toFixed(2)}  mid E[R]=${summarise(a, 'mid').expR} gap E[R]=${summarise(a, 'gap').expR}`);
}

console.log(`\n4. FLATTEN ${FLAT_MIN} MIN BEFORE (flat − gap), paired bootstrap`);
console.log('   all in-session      :', bootPaired(IN, s => R(s, 'flat') - R(s, 'gap')));
console.log('   exposed only        :', bootPaired(exposed, s => R(s, 'flat') - R(s, 'gap')));
const flatExits = IN.filter(s => s.out.flat.exit === 'FLAT');
console.log(`   trades actually flattened: ${flatExits.length}; their flat R mean ${mean(flatExits.map(s => R(s, 'flat'))).toFixed(3)} vs gap R mean ${mean(flatExits.map(s => R(s, 'gap'))).toFixed(3)}`);
console.log('   what flattened trades would have done under gap:', Object.entries(flatExits.reduce((o, s) => { o[s.out.gap.exit] = (o[s.out.gap.exit] || 0) + 1; return o; }, {})));

console.log('\n5. ENTRY BLOCK GRID (signals dropped if filled within PRE h before / POST min after a release). R under gap model.');
const grid = {};
for (const pre of [1, 2, 4]) for (const post of [0, 30, 60]) {
  const blocked = s => s.preH < pre || s.postMin < post;
  const rem = IN.filter(blocked), kept = IN.filter(s => !blocked(s));
  grid[`pre ${pre}h / post ${post}m`] = { removed: rem.length, removedSumR: summarise(rem, 'gap').sumR ?? 0, removedExpR: summarise(rem, 'gap').expR ?? null, keptN: kept.length, keptExpR: summarise(kept, 'gap').expR, keptPF: summarise(kept, 'gap').pf };
}
console.table(grid);
const rem2 = IN.filter(s => s.preH < 2);
console.log('   pre-registered 2h/0m: removed-set E[R] CI', rem2.length ? bootPaired(rem2, s => R(s, 'gap')) : 'n=0');

console.log('\n6. COMBINED: block 2h + flatten, vs gap baseline (paired)');
const combo = s => (s.preH < 2 ? 0 : R(s, 'flat')) - R(s, 'gap');
console.log('   all in-session      :', bootPaired(IN, combo));

console.log('\n7. SEQUENTIAL PORTFOLIO (in-session, one position, 2h cooldown)');
console.table({
  'mid': sequential(IN, 'mid'),
  'gap': sequential(IN, 'gap'),
  [`flat ${FLAT_MIN}m`]: sequential(IN, 'flat'),
  'gap + block 2h': sequential(IN, 'gap', s => s.preH < 2),
  [`flat + block 2h`]: sequential(IN, 'flat', s => s.preH < 2),
});

console.log('\n8. WALK-FORWARD (6-month blocks, in-session, sumR)');
const blocks = [['2024-07', '2024-12'], ['2025-01', '2025-06'], ['2025-07', '2025-12'], ['2026-01', '2026-06'], ['2026-07', '2026-12']];
const wf = {};
for (const [a, b] of blocks) {
  const set = IN.filter(s => s.month >= a && s.month <= b);
  if (!set.length) continue;
  wf[`${a}..${b}`] = { n: set.length, exposed: set.filter(s => s.out.gap.crossed.length).length,
    mid: summarise(set, 'mid').sumR, gap: summarise(set, 'gap').sumR, flat: summarise(set, 'flat').sumR,
    'flat+block2h': +set.filter(s => s.preH >= 2).reduce((p, s) => p + R(s, 'flat'), 0).toFixed(1) };
}
console.table(wf);
