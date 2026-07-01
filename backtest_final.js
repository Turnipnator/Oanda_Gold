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
const SESSION = { BT_HOURMIN:'7', BT_HOURMAX:'21' };
const WINS = { FULL:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'},
  TRAIN:{BT_FROM:'2024-08-01T00:00:00Z',BT_TO:'2025-10-31T00:00:00Z'},
  TEST:{BT_FROM:'2025-11-01T00:00:00Z',BT_TO:'2026-07-02T00:00:00Z'} };
const FIN = {
  'BALANCED  sess+RSI45+$20+ADX20': {...SESSION, EMA_TREND_RSI_SELL_MIN:'45', EMA_TREND_MAX_SL:'2000', EMA_TREND_ADX_MIN:'20'},
  'LONGBIAS  sess+long+$20+ADX20' : {...SESSION, ALLOW_SHORT:'false', EMA_TREND_MAX_SL:'2000', EMA_TREND_ADX_MIN:'20'},
};
const GBP_PER_R = 450;  // honest 0.5%-risk sizing target
function runOne(over, win, dump){ const env={...process.env,...BASE,...over,...win,BT_LABEL:dump||'f',...(dump?{BT_DUMP:'1'}:{})};
  return JSON.parse(execFileSync('node',[ENGINE],{env,encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n').pop()); }
for (const [name, over] of Object.entries(FIN)) {
  console.log('\n'+'='.repeat(96)); console.log(name); console.log('='.repeat(96));
  for (const [w, win] of Object.entries(WINS)) {
    const s = runOne(over, win);
    const months = w==='FULL'?23:(w==='TRAIN'?15:8);
    console.log(`${w.padEnd(6)} n=${String(s.n).padStart(3)}  expR ${(''+s.expR).padStart(7)}  PF ${(''+s.pf).padStart(5)}  WR ${s.wr}%  sumR ${(''+s.sumR).padStart(6)}  DD ${s.ddR}R  L/S ${s.nLong}/${s.nShort} (expL ${s.expLong}/expS ${s.expShort})  ~£${Math.round(s.sumR*GBP_PER_R)}  ~${(s.n/months).toFixed(1)} trades/mo`);
  }
}
