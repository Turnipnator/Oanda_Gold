#!/usr/bin/env node
/**
 * Backtest: widening the SHORT RSI band (EMA_TREND_RSI_SELL_MIN) for EMA Trend.
 *
 * Event-driven replay over real H1 candles (H4 for HTF). Imports the PRODUCTION
 * strategy + TA classes, so EMA alignment / ADX-rising / pullback / HTF / leg-filter
 * gating is identical to live. The ONLY thing varied between passes is the lower RSI
 * bound for shorts (RSI_SELL_MIN). Higher bound (RSI_OB=85) and all LONG gating held.
 *
 * Entry: candle-close of the signal bar (the bot's candle-close path).
 * Single position at a time + TRADE_COOLDOWN_HOURS honoured (as live).
 *
 * Exit model (matches documented live behaviour, see memory win-loss-asymmetry):
 *   SL  = clamp(ATR*1.5, $2,$8) from entry  (ATR~$19 so pinned $8)
 *   TP  = 2*SL = $16  (historically never hit)
 *   pre-BE trail $1.50, arms once max favourable excursion >= $2  (this is what
 *        actually exits winners -> small +$1-4 wins, 0 TP fills)
 *   stop only ratchets tighter (monotonic).
 *   Intrabar convention: ADVERSE extreme assumed hit before favourable (conservative;
 *        understates winners). H1 candle replay can't see the intrabar path — so trust
 *        the TRADE COUNTS / win-rate / excursions, treat $ P&L as a conservative proxy.
 */
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

// Pin LIVE config (local .env is stale — would inject TRAILING_STOP_DISTANCE_PIPS=200 etc.).
// dotenv does not override already-set process.env vars, so set BEFORE importing config.
Object.assign(process.env, {
  NODE_ENV: 'backtest', ALLOW_SHORT: 'true',
  EMA_TREND_FAST: '3', EMA_TREND_MEDIUM: '8', EMA_TREND_SLOW: '21',
  EMA_TREND_ATR_PERIOD: '14', EMA_TREND_ATR_SL_MULT: '1.5',
  EMA_TREND_MIN_SL: '200', EMA_TREND_MAX_SL: '800', EMA_TREND_TP_RR: '2.0',
  EMA_TREND_ADX_MIN: '25', EMA_TREND_PULLBACK_PCT: '0.3',
  EMA_TREND_RSI_OB: '85', EMA_TREND_RSI_OS: '15',
  EMA_TREND_RSI_BUY_MAX: '60', EMA_TREND_RSI_SELL_MIN: '40',
  EMA_TREND_LEG_FILTER_ENFORCE: 'true', EMA_TREND_LEG_FILTER_THRESHOLD: '2.0',
  EMA_TREND_LEG_FILTER_LOOKBACK: '6',
  TRAILING_STOP_DISTANCE_PIPS: '150', TRAILING_ACTIVATION_PIPS: '200',
  TRADE_COOLDOWN_HOURS: '2', RSI_PERIOD: '14',
});

const { default: Config } = await import('./src/config.js');
const { default: TechnicalAnalysis } = await import('./src/technical_analysis.js');
const { default: EmaTrendStrategy } = await import('./src/ema_trend_strategy.js');

const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop };

function loadCandles(file) {
  return (JSON.parse(fs.readFileSync(file)).candles || [])
    .filter(c => c.complete)
    .map(c => ({
      time: c.time,
      open: +c.mid.o, high: +c.mid.h, low: +c.mid.l, close: +c.mid.c,
      complete: true,
      t: new Date(c.time).getTime(),
    }));
}

const H1 = loadCandles('/tmp/h1.json');
const H4 = loadCandles('/tmp/h4.json');

const SIM_START = new Date('2026-03-18T00:00:00Z').getTime(); // EMA Trend go-live
const COOLDOWN_MS = Config.TRADE_COOLDOWN_HOURS * 3600 * 1000;
const GBP = 0.737;     // USD->GBP, for comparability with the live GBP tracker
const UNITS = 100;     // live position is floored at MIN_POSITION_SIZE=100u

const ta = new TechnicalAnalysis(logger);

// Pre-index H4 by time for HTF slice
function htfUpTo(tMs) {
  // all complete H4 candles strictly before/at this H1 candle's close
  const out = [];
  for (const c of H4) { if (c.t <= tMs) out.push(c); else break; }
  return out;
}

function clampSL(atr) {
  let d = (atr || 5) * Config.EMA_TREND_ATR_SL_MULT;
  return Math.max(Config.pipsToPrice(Config.EMA_TREND_MIN_SL),
                  Math.min(Config.pipsToPrice(Config.EMA_TREND_MAX_SL), d));
}

const PRE_BE_TRAIL = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS); // $1.50
const TRAIL_ARM = Config.pipsToPrice(Config.TRAILING_ACTIVATION_PIPS);       // $2.00

function runPass(sellMin) {
  Config.EMA_TREND_RSI_SELL_MIN = sellMin;
  const strat = new EmaTrendStrategy(logger, ta);
  strat.saveState = noop;

  let pos = null;
  let lastClose = 0;
  const trades = [];

  for (let i = 60; i < H1.length; i++) {
    const c = H1[i];
    if (c.t < SIM_START) continue;

    // ---- manage open position across THIS candle (adverse-first) ----
    if (pos) {
      const hitAdverse = pos.dir === 'SHORT' ? c.high >= pos.stop : c.low <= pos.stop;
      if (hitAdverse) {
        const exit = pos.stop;
        const pnlUsd = (pos.dir === 'SHORT' ? pos.entry - exit : exit - pos.entry) * UNITS;
        trades.push({ ...pos, exit, exitTime: c.time, pnlUsd, bars: i - pos.i });
        lastClose = c.t;
        pos = null;
      } else {
        // update favourable extreme + ratchet trail
        if (pos.dir === 'SHORT') {
          pos.fav = Math.min(pos.fav, c.low);
          pos.mae = Math.max(pos.mae, c.high);
          const maxProfit = pos.entry - pos.fav;
          if (maxProfit >= TRAIL_ARM) pos.stop = Math.min(pos.stop, pos.fav + PRE_BE_TRAIL);
        } else {
          pos.fav = Math.max(pos.fav, c.high);
          pos.mae = Math.min(pos.mae, c.low);
          const maxProfit = pos.fav - pos.entry;
          if (maxProfit >= TRAIL_ARM) pos.stop = Math.max(pos.stop, pos.fav - PRE_BE_TRAIL);
        }
      }
    }

    // ---- consider new entry (flat + cooldown elapsed) ----
    if (!pos && (lastClose === 0 || c.t - lastClose >= COOLDOWN_MS)) {
      const sub = H1.slice(0, i + 1);
      const rsiArr = ta.calculateRSI(sub, Config.RSI_PERIOD);
      const rsi = rsiArr[rsiArr.length - 1];
      if (rsi == null) continue;
      const analysis = { indicators: { rsi, price: c.close } };
      const htf = htfUpTo(c.t);
      const res = strat.evaluateSetup(analysis, sub, htf);
      if (res.signal) {
        const atrArr = ta.calculateATR(sub, Config.EMA_TREND_ATR_PERIOD);
        const atr = atrArr[atrArr.length - 1];
        const slDist = clampSL(atr);
        pos = {
          dir: res.signal, entry: c.close, entryTime: c.time, i,
          stop: res.signal === 'SHORT' ? c.close + slDist : c.close - slDist,
          slDist, rsi, atr,
          fav: c.close, mae: c.close,
          legATR: res.legATR,
        };
      }
    }
  }

  return trades;
}

function stats(trades) {
  const w = trades.filter(t => t.pnlUsd > 0);
  const l = trades.filter(t => t.pnlUsd <= 0);
  const sum = a => a.reduce((s, t) => s + t.pnlUsd, 0);
  const net = sum(trades);
  const pf = sum(l) !== 0 ? sum(w) / Math.abs(sum(l)) : Infinity;
  return {
    n: trades.length, w: w.length, l: l.length,
    wr: trades.length ? 100 * w.length / trades.length : 0,
    avgW: w.length ? sum(w) / w.length : 0,
    avgL: l.length ? sum(l) / l.length : 0,
    pf, net, netGbp: net * GBP,
  };
}

// MFE/MAE quality of SHORT entries: how far did each run in favour vs against, in $/unit
function excursion(trades) {
  const shorts = trades.filter(t => t.dir === 'SHORT');
  const favs = shorts.map(t => t.entry - t.fav);   // best $ in favour
  const advs = shorts.map(t => t.mae - t.entry);   // worst $ against
  const med = a => { if (!a.length) return 0; const s=[...a].sort((x,y)=>x-y); return s[Math.floor(s.length/2)]; };
  return {
    medFav: med(favs), medAdv: med(advs),
    reached8: favs.filter(f => f >= 8).length,
    reached16: favs.filter(f => f >= 16).length,
  };
}

const VARIANTS = [40, 35, 30, 25, 20, 15, 0];
console.log(`Replay ${new Date(SIM_START).toISOString().slice(0,10)} → ${H1[H1.length-1].time.slice(0,10)}  |  ${H1.length} H1 candles  |  cooldown ${Config.TRADE_COOLDOWN_HOURS}h  |  ${UNITS}u flat`);
console.log(`Leg filter: ENFORCE=${Config.EMA_TREND_LEG_FILTER_ENFORCE} @ ${Config.EMA_TREND_LEG_FILTER_THRESHOLD}x  |  SL pinned $${Config.pipsToPrice(Config.EMA_TREND_MAX_SL)}  |  pre-BE trail $${PRE_BE_TRAIL} arms@ $${TRAIL_ARM}`);
console.log('');
console.log('RSI_SELL_MIN |  all trades  (S/L) |  WR%  | avgW$ | avgL$ |   PF  | net$    | net£    || SHORTS only');
console.log('-------------|--------------------|-------|-------|-------|-------|---------|---------||----------------------------------');

const baseline = {};
for (const sm of VARIANTS) {
  const trades = runPass(sm);
  const sh = trades.filter(t => t.dir === 'SHORT');
  const lo = trades.filter(t => t.dir === 'LONG');
  const all = stats(trades);
  const sst = stats(sh);
  const ex = excursion(trades);
  const tag = sm === 40 ? ' (live)' : '';
  console.log(
    `${String(sm).padStart(8)}${tag.padEnd(7)}| ${String(all.n).padStart(3)} (${sh.length}S/${lo.length}L)`.padEnd(33) +
    `| ${all.wr.toFixed(0).padStart(4)}% | ${all.avgW.toFixed(0).padStart(5)} | ${all.avgL.toFixed(0).padStart(5)} | ${all.pf.toFixed(2).padStart(5)} | ${all.net.toFixed(0).padStart(7)} | ${all.netGbp.toFixed(0).padStart(7)} || ` +
    `${sh.length}S ${sst.wr.toFixed(0)}%WR PF ${sst.pf.toFixed(2)} net$ ${sst.net.toFixed(0)} | medFav $${ex.medFav.toFixed(1)} medAdv $${ex.medAdv.toFixed(1)} | +$8:${ex.reached8} +$16:${ex.reached16}`
  );
  if (sm === 40) Object.assign(baseline, { all, sh: sst });
}

console.log('');
console.log('Notes: medFav/medAdv = median best-favourable / worst-adverse excursion of SHORT entries ($/unit).');
console.log('       +$8 / +$16 = how many SHORT entries ever reached that far in favour (TP is $16).');
console.log('       net$ is a CONSERVATIVE proxy (intrabar adverse-first); trust counts/WR/excursions over absolute $.');
