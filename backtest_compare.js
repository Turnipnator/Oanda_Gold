import { execFileSync } from 'child_process';
const SP = process.argv[2];
const ENGINE = 'backtest_engine2.js';
const BASE = {
  BT_SP: SP, ALLOW_SHORT:'true', RSI_PERIOD:'14',
  // Triple (standard EMAs 20/50 + RSI ranges + S/R patterns)
  EMA_FAST:'20', EMA_SLOW:'50', RSI_BULLISH_MIN:'40', RSI_BULLISH_MAX:'70', RSI_BEARISH_MIN:'30', RSI_BEARISH_MAX:'60',
  MIN_EMA_SEPARATION_PIPS:'1000', MIN_CONFIDENCE:'70',
  STOP_LOSS_PIPS:'350', TAKE_PROFIT_RR:'1.0', ENABLE_STAGED_TP:'true', TAKE_PROFIT_1_RR:'1.5', TAKE_PROFIT_2_RR:'2.5',
  // EMA Trend
  EMA_TREND_FAST:'3', EMA_TREND_MEDIUM:'8', EMA_TREND_SLOW:'21', EMA_TREND_ATR_PERIOD:'14',
  EMA_TREND_ADX_MIN:'25', EMA_TREND_ATR_SL_MULT:'1.5', EMA_TREND_MIN_SL:'200', EMA_TREND_MAX_SL:'4000',
  EMA_TREND_TP_RR:'2.0', EMA_TREND_PULLBACK_PCT:'0.3', EMA_TREND_RSI_SELL_MIN:'35', EMA_TREND_RSI_OB:'85',
  EMA_TREND_RSI_OS:'15', EMA_TREND_RSI_BUY_MAX:'60', EMA_TREND_BE_TRIGGER_PCT:'0.3',
  EMA_TREND_LEG_FILTER_ENFORCE:'true', EMA_TREND_LEG_FILTER_THRESHOLD:'2.0', EMA_TREND_TRAIL_ATR_MULT:'1.5',
  // Breakout (candle-close only)
  ENABLE_MTF:'false', ENABLE_TREND_CONTINUATION:'false', BREAKOUT_LOOKBACK:'10',
  BREAKOUT_STOP_LOSS_PIPS:'300', BREAKOUT_TRAILING_ACTIVATION_PIPS:'350',
  TRAILING_ACTIVATION_PIPS:'200', TRAILING_STOP_DISTANCE_PIPS:'150',
};
const WINS = { FULL:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'},
  TRAIN:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2025-10-31T00:00:00Z'},
  TEST:{BT_FROM:'2025-11-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'} };
function runOne(strat, exit, win){
  const env={...process.env,...BASE,BT_STRAT:strat,BT_EXITMODE:exit,...win,BT_LABEL:`${strat}_${exit}`};
  return JSON.parse(execFileSync('node',[ENGINE],{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').pop());
}
const cell = s => `${(''+s.expR).padStart(7)} PF${(''+s.pf).padStart(5)} n${String(s.n).padStart(3)} WR${String(s.wr).padStart(4)}`;
for (const exit of ['native','common']) {
  console.log('\n'+'='.repeat(118));
  console.log(`EXIT = ${exit.toUpperCase()}    (expR / PF / n / WR% per window)`);
  console.log('='.repeat(118));
  console.log('strategy'.padEnd(20), 'FULL 24mo'.padStart(30), 'TRAIN 15mo'.padStart(30), 'TEST 8mo'.padStart(30));
  console.log('-'.repeat(118));
  for (const strat of ['ema_trend','triple','breakout']) {
    const f=runOne(strat,exit,WINS.FULL), tr=runOne(strat,exit,WINS.TRAIN), te=runOne(strat,exit,WINS.TEST);
    const rob = (tr.expR>0&&te.expR>0)?'  ROBUST✓':(f.expR>0?'  full+':'  neg');
    console.log(strat.padEnd(20), cell(f).padStart(30), cell(tr).padStart(30), cell(te).padStart(30), rob,
      `L/S ${f.nLong}/${f.nShort}`);
  }
}
