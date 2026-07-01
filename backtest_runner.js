#!/usr/bin/env node
/**
 * Sweep runner: spawns engine.js with an explicit env object per variant (no shell quoting).
 * Prints grouped tables. Usage: node runner.js <scratchdir> [group]
 *   group: entry | exit | regime | direction | walkforward | all (default all)
 */
import { execFileSync } from 'child_process';
const SP = process.argv[2];
const GROUP = process.argv[3] || 'all';
const ENGINE = 'backtest_engine.js';

// Baseline = LIVE VPS config (Jul 1 2026)
const BASE = {
  BT_SP: SP,
  STRATEGY_TYPE: 'ema_trend', ALLOW_SHORT: 'true',
  EMA_TREND_FAST: '3', EMA_TREND_MEDIUM: '8', EMA_TREND_SLOW: '21', EMA_TREND_ATR_PERIOD: '14',
  EMA_TREND_ADX_MIN: '25', EMA_TREND_ATR_SL_MULT: '1.5', EMA_TREND_MIN_SL: '200', EMA_TREND_MAX_SL: '4000',
  EMA_TREND_TP_RR: '2.0', EMA_TREND_PULLBACK_PCT: '0.3',
  EMA_TREND_RSI_SELL_MIN: '35', EMA_TREND_RSI_OB: '85', EMA_TREND_RSI_OS: '15', EMA_TREND_RSI_BUY_MAX: '60',
  EMA_TREND_BE_TRIGGER_PCT: '0.3', EMA_TREND_LEG_FILTER_ENFORCE: 'true', EMA_TREND_LEG_FILTER_THRESHOLD: '2.0',
  EMA_TREND_TRAIL_ATR_MULT: '1.5', EMA_TREND_LEG_FILTER_LOOKBACK: '6', RSI_PERIOD: '14',
  TRAILING_ACTIVATION_PIPS: '200', TRAILING_STOP_DISTANCE_PIPS: '150',
};

function runOne(label, over) {
  const env = { ...process.env, ...BASE, ...over, BT_LABEL: label };
  const out = execFileSync('node', [ENGINE], { env, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
  return JSON.parse(out.trim().split('\n').pop());
}

function table(title, rows) {
  console.log('\n' + '='.repeat(112));
  console.log(title);
  console.log('='.repeat(112));
  console.log(['variant'.padEnd(26),'n'.padStart(4),'expR'.padStart(7),'sumR'.padStart(7),'WR%'.padStart(6),
    'PF'.padStart(6),'avgW'.padStart(7),'avgL'.padStart(7),'ddR'.padStart(6),'L/S'.padStart(8),'expL/expS'.padStart(14)].join(' '));
  console.log('-'.repeat(112));
  for (const [label, s] of rows) {
    console.log([label.padEnd(26), String(s.n).padStart(4), (''+s.expR).padStart(7), (''+s.sumR).padStart(7),
      (''+s.wr).padStart(6), (''+s.pf).padStart(6), (''+s.avgW).padStart(7), (''+s.avgL).padStart(7),
      (''+s.ddR).padStart(6), `${s.nLong}/${s.nShort}`.padStart(8), `${s.expLong}/${s.expShort}`.padStart(14)].join(' '));
  }
}

const groups = {
  direction: () => table('DIRECTION (full config, 24mo)', [
    ['baseline both', runOne('base', {})],
    ['long-only', runOne('longonly', { ALLOW_SHORT: 'false' })],
    ['no-HTF gate (both)', runOne('nohtf', { BT_NOHTF: '1' })],
    ['no-HTF long-only', runOne('nohtf_long', { BT_NOHTF:'1', ALLOW_SHORT:'false' })],
  ]),
  entry: () => {
    const rows = [['baseline', runOne('base', {})]];
    for (const v of ['20','30','35','40']) rows.push([`ADX_MIN ${v}`, runOne('adx'+v, { EMA_TREND_ADX_MIN: v })]);
    for (const v of ['30','40','45']) rows.push([`RSI_SELL_MIN ${v}`, runOne('rsi'+v, { EMA_TREND_RSI_SELL_MIN: v })]);
    for (const v of ['0.15','0.5','1.0']) rows.push([`PULLBACK ${v}%`, runOne('pb'+v, { EMA_TREND_PULLBACK_PCT: v })]);
    for (const v of ['1.5','2.5']) rows.push([`LEG_THRESH ${v}`, runOne('leg'+v, { EMA_TREND_LEG_FILTER_THRESHOLD: v })]);
    rows.push(['leg filter OFF', runOne('legoff', { EMA_TREND_LEG_FILTER_ENFORCE: 'false' })]);
    table('ENTRY FILTERS (full config, 24mo)', rows);
  },
  stop: () => {
    const rows = [['baseline', runOne('base', {})]];
    for (const v of ['1.0','2.0','2.5']) rows.push([`ATR_SL_MULT ${v}`, runOne('slm'+v, { EMA_TREND_ATR_SL_MULT: v })]);
    for (const v of ['800','2000','6000']) rows.push([`MAX_SL $${(+v/100).toFixed(0)}`, runOne('max'+v, { EMA_TREND_MAX_SL: v })]);
    table('STOP SIZING (full config, 24mo)', rows);
  },
  exit: () => {
    const rows = [['baseline (BE+trail)', runOne('base', {})]];
    for (const v of ['1.0','1.5','3.0']) rows.push([`TP_RR ${v}`, runOne('tp'+v, { EMA_TREND_TP_RR: v })]);
    rows.push(['trail_only (no TP)', runOne('trailonly', { BT_EXIT: 'trail_only' })]);
    rows.push(['tp_only 2R (no trail)', runOne('tponly', { BT_EXIT: 'tp_only' })]);
    rows.push(['partial 1R + trail', runOne('partial', { BT_EXIT: 'partial1R' })]);
    for (const v of ['200','300','400']) rows.push([`pre-BE trail $${(+v/100).toFixed(1)}`, runOne('pt'+v, { TRAILING_STOP_DISTANCE_PIPS: v })]);
    for (const v of ['0.5','0.7']) rows.push([`BE_TRIGGER ${v}`, runOne('be'+v, { EMA_TREND_BE_TRIGGER_PCT: v })]);
    table('EXIT MECHANICS (full config, 24mo)', rows);
  },
  regime: () => {
    const rows = [['baseline', runOne('base', {})]];
    for (const [lo,hi] of [['0','15'],['15','30'],['30','99']]) rows.push([`ATR $${lo}-${hi}`, runOne('vol'+lo, { BT_VOLMIN:lo, BT_VOLMAX:hi })]);
    rows.push(['session 07-21 UTC', runOne('sess', { BT_HOURMIN:'7', BT_HOURMAX:'21' })]);
    rows.push(['session 00-08 (Asian)', runOne('asia', { BT_HOURMIN:'0', BT_HOURMAX:'8' })]);
    table('REGIME FILTERS (full config, 24mo)', rows);
  },
  walkforward: () => {
    const TRAIN = { BT_FROM:'2024-08-01T00:00:00Z', BT_TO:'2025-10-31T00:00:00Z' };
    const TEST  = { BT_FROM:'2025-11-01T00:00:00Z', BT_TO:'2026-07-02T00:00:00Z' };
    const rows = [];
    rows.push(['baseline TRAIN', runOne('b_tr', TRAIN)]);
    rows.push(['baseline TEST',  runOne('b_te', TEST)]);
    table('WALK-FORWARD baseline (train 2024-08..2025-10 / test 2025-11..2026-07)', rows);
  },
};

const order = GROUP === 'all' ? ['direction','entry','stop','exit','regime','walkforward'] : [GROUP];
for (const g of order) { if (groups[g]) groups[g](); }
