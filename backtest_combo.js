#!/usr/bin/env node
/**
 * Combined-candidate walk-forward: each config run over FULL / TRAIN / TEST.
 * TRAIN 2024-08..2025-10 (15mo, mostly bull) ; TEST 2025-11..2026-07 (8mo, incl 2026 downtrend).
 * A config is trustworthy only if positive in BOTH train AND test (not just full).
 */
import { execFileSync } from 'child_process';
const SP = process.argv[2];
const ENGINE = 'backtest_engine.js';
const BASE = {
  BT_SP: SP, STRATEGY_TYPE:'ema_trend', ALLOW_SHORT:'true',
  EMA_TREND_FAST:'3', EMA_TREND_MEDIUM:'8', EMA_TREND_SLOW:'21', EMA_TREND_ATR_PERIOD:'14',
  EMA_TREND_ADX_MIN:'25', EMA_TREND_ATR_SL_MULT:'1.5', EMA_TREND_MIN_SL:'200', EMA_TREND_MAX_SL:'4000',
  EMA_TREND_TP_RR:'2.0', EMA_TREND_PULLBACK_PCT:'0.3',
  EMA_TREND_RSI_SELL_MIN:'35', EMA_TREND_RSI_OB:'85', EMA_TREND_RSI_OS:'15', EMA_TREND_RSI_BUY_MAX:'60',
  EMA_TREND_BE_TRIGGER_PCT:'0.3', EMA_TREND_LEG_FILTER_ENFORCE:'true', EMA_TREND_LEG_FILTER_THRESHOLD:'2.0',
  EMA_TREND_TRAIL_ATR_MULT:'1.5', EMA_TREND_LEG_FILTER_LOOKBACK:'6', RSI_PERIOD:'14',
  TRAILING_ACTIVATION_PIPS:'200', TRAILING_STOP_DISTANCE_PIPS:'150',
};
const WIN_FULL = { BT_FROM:'2024-08-01T00:00:00Z', BT_TO:'2026-07-02T00:00:00Z' };
const WIN_TRAIN= { BT_FROM:'2024-08-01T00:00:00Z', BT_TO:'2025-10-31T00:00:00Z' };
const WIN_TEST = { BT_FROM:'2025-11-01T00:00:00Z', BT_TO:'2026-07-02T00:00:00Z' };
const SESSION = { BT_HOURMIN:'7', BT_HOURMAX:'21' };

const CANDS = [
  ['baseline (live: both,24h,$40)', {}],
  ['session only', SESSION],
  ['session + long-only', {...SESSION, ALLOW_SHORT:'false'}],
  ['session + RSI_SELL 45', {...SESSION, EMA_TREND_RSI_SELL_MIN:'45'}],
  ['session + MAX_SL $20', {...SESSION, EMA_TREND_MAX_SL:'2000'}],
  ['session + ATR_SL 1.0', {...SESSION, EMA_TREND_ATR_SL_MULT:'1.0'}],
  ['sess+long+$20', {...SESSION, ALLOW_SHORT:'false', EMA_TREND_MAX_SL:'2000'}],
  ['sess+long+$20+ADX20', {...SESSION, ALLOW_SHORT:'false', EMA_TREND_MAX_SL:'2000', EMA_TREND_ADX_MIN:'20'}],
  ['sess+RSI45+$20', {...SESSION, EMA_TREND_RSI_SELL_MIN:'45', EMA_TREND_MAX_SL:'2000'}],
  ['sess+RSI45+$20+ATR1.0', {...SESSION, EMA_TREND_RSI_SELL_MIN:'45', EMA_TREND_MAX_SL:'2000', EMA_TREND_ATR_SL_MULT:'1.0'}],
];

function runOne(over, win) {
  const env = { ...process.env, ...BASE, ...over, ...win, BT_LABEL:'c' };
  const out = execFileSync('node', [ENGINE], { env, encoding:'utf8', stdio:['ignore','pipe','ignore'] });
  return JSON.parse(out.trim().split('\n').pop());
}
const cell = s => `${(''+s.expR).padStart(7)} ${('PF'+s.pf).padStart(6)} n${String(s.n).padStart(3)}`;
console.log('CONFIG'.padEnd(32), 'FULL 24mo'.padStart(20), 'TRAIN 15mo'.padStart(20), 'TEST 8mo'.padStart(20), '  verdict');
console.log('-'.repeat(108));
for (const [label, over] of CANDS) {
  const f=runOne(over,WIN_FULL), tr=runOne(over,WIN_TRAIN), te=runOne(over,WIN_TEST);
  const robust = (tr.expR>0 && te.expR>0) ? 'ROBUST ✓' : (f.expR>0 ? 'full+ only' : 'neg');
  console.log(label.padEnd(32), cell(f).padStart(20), cell(tr).padStart(20), cell(te).padStart(20), '  '+robust);
}
