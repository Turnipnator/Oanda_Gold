/**
 * Phase 0 signal ledger (src/signal_ledger.js) and its offline labeller (scripts/label_signals.mjs).
 *
 * The ledger is training data for a future filter, so the properties that matter are:
 *   - one row per candle, no matter how many scans re-evaluate it, but a fill is never dropped;
 *   - a write fault never reaches the trading path;
 *   - the labeller pays the spread, takes the stop when a bar touches both levels, honours gaps,
 *     and leaves a row pending rather than guess when the data runs out;
 *   - every trend-aligned candle the strategy evaluates carries a full feature snapshot.
 *
 * Run: npm run test:ledger
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import SignalLedger, { buildLedgerRow } from '../src/signal_ledger.js';
import { simulateBracket, firstBarAtOrAfter, brokerOutcome, labelLedger, summarise, FEATURES } from '../scripts/label_signals.mjs';
import EmaTrendStrategy from '../src/ema_trend_strategy.js';
import TechnicalAnalysis from '../src/technical_analysis.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`));
const section = name => console.log(`\n${name}`);
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
const ctx = { loggedAt: new Date('2026-10-28T14:01:00Z'), regime: 'test', hourUK: 14, weekdayUK: 'Wed' };
const cand = (time = '2026-10-28T13:00:00.000000000Z', direction = 'LONG') => ({ candleTime: time, direction, stopDistance: 10, tpRR: 2 });
const readRows = f => fs.readFileSync(f, 'utf8').trim().split('\n').map(l => JSON.parse(l));

section('ledger writes');
{
  const f = path.join(tmp, 'a.jsonl');
  const led = new SignalLedger(f, silent);
  check('first sighting is written', led.record(cand(), { skipReason: 'rsi_band' }, ctx));
  check('same candle on the next scan is not', !led.record(cand(), { skipReason: 'rsi_band' }, ctx));
  check('opposite direction is a separate row', led.record(cand(undefined, 'SHORT'), { skipReason: 'adx_low' }, ctx));
  check('a fill on a seen candle is still written', led.record(cand(), { skipReason: null, tradeId: '1528', fillPrice: 4049.02 }, ctx));
  const rows = readRows(f);
  check('three rows on disk', rows.length === 3, `got ${rows.length}`);
  check('fill row is taken=1 with trade id', rows[2].taken === 1 && rows[2].tradeId === '1528' && rows[2].skipReason === null);
  check('skip row is taken=0 with reason', rows[0].taken === 0 && rows[0].skipReason === 'rsi_band');
  check('no candidate = no row', !led.record(null, { skipReason: 'x' }, ctx));

  fs.appendFileSync(f, '{"candleTime":"torn');
  const led2 = new SignalLedger(f, silent);
  check('restart re-seeds dedup and survives a torn last line', !led2.record(cand(), { skipReason: 'rsi_band' }, ctx));
}
{
  const bad = new SignalLedger(path.join(tmp, 'no-such-dir', 'x.jsonl'), silent);
  let threw = false, wrote;
  try { wrote = bad.record(cand(), { skipReason: 'rsi_band' }, ctx); } catch { threw = true; }
  check('write failure is swallowed, never thrown', !threw && wrote === false);
}
{
  const row = buildLedgerRow({ ...cand(), rsi: 55 }, { skipReason: 'cooldown', detail: '30m remaining' }, ctx);
  check('row carries schema, context and features', row.schema === 1 && row.hourUK === 14 && row.rsi === 55 && row.skipDetail === '30m remaining');
}

section('labeller: bracket simulation');
// bar helper: mid prices with a fixed $0.40 spread (bid = mid - 0.2, ask = mid + 0.2)
const bar = (i, o, h, l, c) => ({ t: i * 60_000, bo: o - 0.2, bh: h - 0.2, bl: l - 0.2, bc: c - 0.2, ao: o + 0.2, ah: h + 0.2, al: l + 0.2, ac: c + 0.2 });
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 125, 99, 120)];
  const r = simulateBracket(bars, 0, 'LONG', 10, 2);
  check('long buys the ask', near(r.entry, 100.2));
  check('long target hit = +2R', r.exitReason === 'target' && near(r.r, 2));
}
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 85, 90)];
  const r = simulateBracket(bars, 0, 'LONG', 10, 2);
  check('long stop hit = -1R', r.exitReason === 'stop' && near(r.r, -1));
}
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 130, 80, 100)];
  check('bar touching both levels = stop first', simulateBracket(bars, 0, 'LONG', 10, 2).exitReason === 'stop');
}
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 80, 81, 79, 80)];
  const r = simulateBracket(bars, 0, 'LONG', 10, 2);
  check('gap through the stop fills at the open (worse than -1R)', r.exitReason === 'stop_gap' && r.r < -1.9);
}
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 75, 80)];
  const r = simulateBracket(bars, 0, 'SHORT', 10, 2);
  check('short sells the bid and wins on a drop', near(r.entry, 99.8) && r.exitReason === 'target' && near(r.r, 2));
}
{
  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 99, 100)];
  check('unresolved at end of data = pending (null)', simulateBracket(bars, 0, 'LONG', 10, 2) === null);
  const capped = simulateBracket(bars, 0, 'LONG', 10, 2, 60_000);
  check('time cap closes at market on the bid', capped.exitReason === 'time_cap' && near(capped.exit, 99.8));
}
{
  const bars = [0, 1, 2, 3].map(i => bar(i, 100, 100, 100, 100));
  check('entry bar is the first to open at/after loggedAt', firstBarAtOrAfter(bars, 61_000) === 2 && firstBarAtOrAfter(bars, 60_000) === 1);
}

section('labeller: rows');
{
  const trade = { id: '1528', price: '4049.02', averageClosePrice: '4032.72', closeTime: '2026-10-28T18:07:00Z', stopLossOrder: { state: 'FILLED' } };
  const o = brokerOutcome({ direction: 'LONG', stopDistance: 16.28 }, trade);
  check('broker outcome for Oct 28 = -1.00R stop', o.exitReason === 'stop' && near(o.r, -1.0012, 1e-3));

  const bars = [bar(0, 100, 100, 100, 100), bar(1, 100, 101, 85, 90), bar(2, 100, 101, 99, 100)];
  const rows = [
    { loggedAt: new Date(0).toISOString(), direction: 'LONG', stopDistance: 10, tpRR: 2, taken: 0, skipReason: 'rsi_band' },
    { loggedAt: new Date(0).toISOString(), direction: 'LONG', stopDistance: 16.28, tpRR: 2, taken: 1, tradeId: '1528', skipReason: null },
    { loggedAt: new Date(120_000).toISOString(), direction: 'LONG', stopDistance: 10, tpRR: 2, taken: 0, skipReason: 'session' },
  ];
  const out = labelLedger(rows, bars, new Map([['1528', trade]]));
  check('skipped row simulated, label 0 on a loss', out[0].labelSource === 'simulated' && out[0].label === 0);
  check('taken row uses the broker record', out[1].labelSource === 'broker' && out[1].label === 0);
  check('row past the data stays pending', out[2].labelStatus === 'pending' && out[2].label === null);
  const report = summarise(out);
  check('summary reports missing features', /MISSING FEATURES/.test(report) && report.includes('rsi='));
}

section('strategy attaches a candidate to aligned candles');
{
  const ta = new TechnicalAnalysis(silent);
  // steady uptrend with a pullback on the last bar so the EMAs align bullish
  const candles = [];
  let p = 4000;
  for (let i = 0; i < 120; i++) {
    const o = p; p += i % 5 === 4 ? -3 : 4;
    candles.push({ time: `t${i}`, open: o, high: Math.max(o, p) + 1, low: Math.min(o, p) - 1, close: p, complete: true });
  }
  const strat = new EmaTrendStrategy(silent, ta);
  strat.saveState = () => {};
  strat.lastSignalCandleTime = null;
  const res = strat.evaluateSetup({ indicators: { rsi: 90 } }, candles, null);
  check('aligned candle has a LONG candidate', res.candidate?.direction === 'LONG', JSON.stringify(res.reason));
  check('rejection carries a machine-readable skipReason', typeof res.skipReason === 'string' && res.skipReason.length > 0, String(res.skipReason));
  const strategyFeatures = FEATURES.filter(f => !['hourUK', 'weekdayUK', 'htfTrend'].includes(f));
  const missing = strategyFeatures.filter(f => res.candidate?.[f] === null || res.candidate?.[f] === undefined);
  check('every strategy feature populated', missing.length === 0, missing.join(','));

  const flat = candles.map((c, i) => ({ ...c, open: 4000 + (i % 2), close: 4000 + ((i + 1) % 2), high: 4002, low: 3998 }));
  const res2 = new EmaTrendStrategy(silent, ta);
  res2.saveState = () => {};
  res2.lastSignalCandleTime = null;
  check('no alignment = no candidate', !res2.evaluateSetup({ indicators: { rsi: 50 } }, flat, null).candidate);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
