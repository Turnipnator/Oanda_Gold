import { execFileSync } from 'child_process';
const SP = process.argv[2];
const ENGINE = 'backtest_engine2.js';
const BASE = {
  BT_SP: SP, ALLOW_SHORT:'true', RSI_PERIOD:'14',
  EMA_FAST:'20', EMA_SLOW:'50', RSI_BULLISH_MIN:'40', RSI_BULLISH_MAX:'70', RSI_BEARISH_MIN:'30', RSI_BEARISH_MAX:'60',
  MIN_EMA_SEPARATION_PIPS:'1000', MIN_CONFIDENCE:'70',
  STOP_LOSS_PIPS:'350', ENABLE_STAGED_TP:'true', TAKE_PROFIT_1_RR:'1.5', TAKE_PROFIT_2_RR:'2.5', TAKE_PROFIT_RR:'1.0',
  EMA_TREND_FAST:'3', EMA_TREND_MEDIUM:'8', EMA_TREND_SLOW:'21', EMA_TREND_ATR_PERIOD:'14',
  EMA_TREND_ADX_MIN:'25', EMA_TREND_ATR_SL_MULT:'1.5', EMA_TREND_MIN_SL:'200', EMA_TREND_MAX_SL:'4000',
  EMA_TREND_TP_RR:'2.0', EMA_TREND_PULLBACK_PCT:'0.3', EMA_TREND_RSI_SELL_MIN:'35', EMA_TREND_RSI_OB:'85',
  EMA_TREND_RSI_OS:'15', EMA_TREND_RSI_BUY_MAX:'60', EMA_TREND_BE_TRIGGER_PCT:'0.3',
  EMA_TREND_LEG_FILTER_ENFORCE:'true', EMA_TREND_LEG_FILTER_THRESHOLD:'2.0', EMA_TREND_TRAIL_ATR_MULT:'1.5',
  ENABLE_MTF:'false', ENABLE_TREND_CONTINUATION:'false', BREAKOUT_LOOKBACK:'10',
  BREAKOUT_STOP_LOSS_PIPS:'300', BREAKOUT_TRAILING_ACTIVATION_PIPS:'350',
  TRAILING_ACTIVATION_PIPS:'200', TRAILING_STOP_DISTANCE_PIPS:'150',
};
const SESSION = { BT_HOURMIN:'7', BT_HOURMAX:'21' };
const WINS = { FULL:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'},
  TRAIN:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2025-10-31T00:00:00Z'},
  TEST:{BT_FROM:'2025-11-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'} };
function runOne(over, win){
  const env={...process.env,...BASE,...over,...win,BT_LABEL:'x'};
  return JSON.parse(execFileSync('node',[ENGINE],{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').pop());
}
// contenders: (label, strat, exit, extra overrides)
const C = [
  ['EMA BALANCED (DEPLOYED)', 'ema_trend','common', {...SESSION, EMA_TREND_RSI_SELL_MIN:'45', EMA_TREND_MAX_SL:'2000', EMA_TREND_ADX_MIN:'20'}],
  ['EMA baseline (both,24h)', 'ema_trend','common', {}],
  ['Triple native + session', 'triple','native', SESSION],
  ['Breakout native + session','breakout','native', SESSION],
  ['Breakout native (24h)',    'breakout','native', {}],
];
const G=450;
console.log('CONTENDER'.padEnd(27), 'FULL 24mo (exp/PF/DD/n)'.padStart(26), 'TRAIN'.padStart(20), 'TEST'.padStart(20), '  trades/mo  ~£/24mo');
console.log('-'.repeat(120));
for (const [label, strat, exit, over] of C) {
  const o={...over, BT_STRAT:strat, BT_EXITMODE:exit};
  const f=runOne(o,WINS.FULL), tr=runOne(o,WINS.TRAIN), te=runOne(o,WINS.TEST);
  const rob=(tr.expR>0&&te.expR>0)?'ROBUST✓':'—';
  const c=s=>`${(''+s.expR).padStart(7)}/PF${s.pf}/DD${s.ddR}/n${s.n}`;
  console.log(label.padEnd(27), c(f).padStart(26), `${(''+tr.expR).padStart(7)}/${tr.pf}`.padStart(20), `${(''+te.expR).padStart(7)}/${te.pf}`.padStart(20),
    `  ${(f.n/23).toFixed(1)}      £${Math.round(f.sumR*G)}  ${rob}  WR${f.wr} L/S${f.nLong}/${f.nShort}`);
}
