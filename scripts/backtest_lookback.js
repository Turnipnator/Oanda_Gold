/**
 * Quick Backtest: 5-bar vs 10-bar Lookback Comparison
 * Matches live bot parameters (H1, 550 SL, 150 trail, 350 activation)
 */
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

const API_KEY = process.env.OANDA_API_KEY;
const HOSTNAME = 'https://api-fxpractice.oanda.com';
const INSTRUMENT = 'XAU_USD';

// Match live bot parameters
const ADX_MIN = 20;
const STOP_LOSS_PIPS = 550;      // $5.50
const TRAILING_PIPS = 150;       // $1.50 trail
const TRAILING_ACTIVATION_PIPS = 350;  // $3.50 min profit before trailing
const RISK_PERCENT = 0.015;      // 1.5%
const INITIAL_BALANCE = 100000;

async function fetchCandles(granularity, count = 1000) {
  const url = `${HOSTNAME}/v3/instruments/${INSTRUMENT}/candles?count=${count}&granularity=${granularity}&price=M`;
  const response = await axios.get(url, {
    headers: { 'Authorization': `Bearer ${API_KEY}` }
  });
  return response.data.candles
    .filter(c => c.complete)
    .map(c => ({
      time: new Date(c.time),
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c)
    }));
}

function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return null;
  const tr = [], plusDM = [], minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high, low = candles[i].low;
    const prevHigh = candles[i-1].high, prevLow = candles[i-1].low, prevClose = candles[i-1].close;
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    const upMove = high - prevHigh, downMove = prevLow - low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI = minusDM.slice(0, period).reduce((a, b) => a + b, 0);
  const dx = [];

  for (let i = period; i < tr.length; i++) {
    atr = atr - atr/period + tr[i];
    plusDI = plusDI - plusDI/period + plusDM[i];
    minusDI = minusDI - minusDI/period + minusDM[i];
    const plusDIVal = (plusDI/atr)*100, minusDIVal = (minusDI/atr)*100;
    dx.push(Math.abs(plusDIVal - minusDIVal) / (plusDIVal + minusDIVal) * 100);
  }

  if (dx.length < period) return null;
  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dx.length; i++) adx = (adx * (period-1) + dx[i]) / period;
  return adx;
}

function simulateTrailingExit(entryPrice, isLong, candles, slPips, trailPips, activationPips) {
  const slDistance = slPips * 0.01;
  const trailDistance = trailPips * 0.01;
  const activationDistance = activationPips * 0.01;

  let stopLoss = isLong ? entryPrice - slDistance : entryPrice + slDistance;
  let bestPrice = entryPrice;
  let trailingActive = false;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    if (isLong) {
      if (candle.low <= stopLoss) {
        return { exitPrice: stopLoss, exitIndex: i, reason: trailingActive ? 'TRAIL' : 'SL' };
      }
      if (candle.high > bestPrice) {
        bestPrice = candle.high;
        // Only trail after activation threshold
        if (bestPrice - entryPrice >= activationDistance) {
          trailingActive = true;
          const newStop = bestPrice - trailDistance;
          if (newStop > stopLoss) stopLoss = newStop;
        }
      }
    } else {
      if (candle.high >= stopLoss) {
        return { exitPrice: stopLoss, exitIndex: i, reason: trailingActive ? 'TRAIL' : 'SL' };
      }
      if (candle.low < bestPrice) {
        bestPrice = candle.low;
        if (entryPrice - bestPrice >= activationDistance) {
          trailingActive = true;
          const newStop = bestPrice + trailDistance;
          if (newStop < stopLoss) stopLoss = newStop;
        }
      }
    }
  }
  return { exitPrice: candles[candles.length-1].close, exitIndex: candles.length-1, reason: 'OPEN' };
}

function runBacktest(candles, lookback) {
  const trades = [];
  let balance = INITIAL_BALANCE;
  let maxDrawdown = 0, peakBalance = INITIAL_BALANCE;
  let prevHigh = null, prevLow = null;

  for (let i = lookback + 14; i < candles.length - 100; i++) {
    const lookbackCandles = candles.slice(i - lookback, i);
    const currentCandle = candles[i];

    const high = Math.max(...lookbackCandles.map(c => c.high));
    const low = Math.min(...lookbackCandles.map(c => c.low));
    const adx = calculateADX(candles.slice(0, i + 1));

    if (adx === null) continue;

    if (prevHigh === null) {
      prevHigh = high;
      prevLow = low;
      continue;
    }

    const price = currentCandle.close;
    const isBullish = currentCandle.close > currentCandle.open;
    const isBearish = currentCandle.close < currentCandle.open;

    let signal = null;
    if (price > prevHigh && adx >= ADX_MIN && isBullish) signal = 'LONG';
    else if (price < prevLow && adx >= ADX_MIN && isBearish) signal = 'SHORT';

    prevHigh = high;
    prevLow = low;

    if (signal) {
      const entryPrice = price;
      const isLong = signal === 'LONG';
      const futureCandles = candles.slice(i + 1);
      const exit = simulateTrailingExit(entryPrice, isLong, futureCandles, STOP_LOSS_PIPS, TRAILING_PIPS, TRAILING_ACTIVATION_PIPS);

      const riskAmount = balance * RISK_PERCENT;
      const slDistance = STOP_LOSS_PIPS * 0.01;
      const units = riskAmount / slDistance;
      const priceDiff = isLong ? exit.exitPrice - entryPrice : entryPrice - exit.exitPrice;
      const pnl = priceDiff * units;

      balance += pnl;
      if (balance > peakBalance) peakBalance = balance;
      const drawdown = peakBalance - balance;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;

      trades.push({
        time: currentCandle.time,
        signal,
        entry: entryPrice,
        exit: exit.exitPrice,
        pnl,
        reason: exit.reason,
        balance
      });

      i += exit.exitIndex;
    }
  }

  return { trades, finalBalance: balance, maxDrawdown };
}

function printResults(name, result) {
  const { trades, finalBalance, maxDrawdown } = result;
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0;
  const totalPnL = finalBalance - INITIAL_BALANCE;
  const slHits = trades.filter(t => t.reason === 'SL').length;
  const trailHits = trades.filter(t => t.reason === 'TRAIL').length;

  console.log(`\n${'='.repeat(50)}`);
  console.log(name);
  console.log('='.repeat(50));
  console.log(`Trades:      ${trades.length} (${wins.length}W / ${losses.length}L)`);
  console.log(`Win Rate:    ${winRate}%`);
  console.log(`P&L:         £${totalPnL.toFixed(2)}`);
  console.log(`Max DD:      £${maxDrawdown.toFixed(2)}`);
  console.log(`Exits:       ${slHits} SL hits, ${trailHits} trail exits`);
}

async function main() {
  console.log('Fetching H1 candle data...');
  console.log(`Parameters: SL=${STOP_LOSS_PIPS} pips, Trail=${TRAILING_PIPS} pips, Activation=${TRAILING_ACTIVATION_PIPS} pips\n`);

  try {
    const candles = await fetchCandles('H1', 1000);
    console.log(`H1 candles: ${candles.length} (${candles[0].time.toISOString().split('T')[0]} to ${candles[candles.length-1].time.toISOString().split('T')[0]})`);

    // Run both lookback periods
    console.log('\nRunning 5-bar lookback...');
    const result5 = runBacktest(candles, 5);

    console.log('Running 10-bar lookback...');
    const result10 = runBacktest(candles, 10);

    printResults('5-BAR LOOKBACK (Current)', result5);
    printResults('10-BAR LOOKBACK (Alternative)', result10);

    // Comparison
    console.log(`\n${'='.repeat(50)}`);
    console.log('COMPARISON');
    console.log('='.repeat(50));

    const pnl5 = result5.finalBalance - INITIAL_BALANCE;
    const pnl10 = result10.finalBalance - INITIAL_BALANCE;
    const winRate5 = result5.trades.length > 0 ? result5.trades.filter(t => t.pnl > 0).length / result5.trades.length * 100 : 0;
    const winRate10 = result10.trades.length > 0 ? result10.trades.filter(t => t.pnl > 0).length / result10.trades.length * 100 : 0;

    console.log(`P&L:        5-bar £${pnl5.toFixed(0)} vs 10-bar £${pnl10.toFixed(0)}`);
    console.log(`Win Rate:   5-bar ${winRate5.toFixed(1)}% vs 10-bar ${winRate10.toFixed(1)}%`);
    console.log(`Trades:     5-bar ${result5.trades.length} vs 10-bar ${result10.trades.length}`);
    console.log(`Max DD:     5-bar £${result5.maxDrawdown.toFixed(0)} vs 10-bar £${result10.maxDrawdown.toFixed(0)}`);

    console.log(`\n${'='.repeat(50)}`);
    console.log('RECOMMENDATION');
    console.log('='.repeat(50));

    if (winRate10 > winRate5 + 5) {
      console.log('10-bar lookback has notably better win rate.');
      console.log('Consider switching to BREAKOUT_LOOKBACK=10');
    } else if (winRate5 > winRate10 + 5) {
      console.log('5-bar lookback has notably better win rate.');
      console.log('Keep BREAKOUT_LOOKBACK=5');
    } else {
      console.log('Win rates are similar.');
      console.log(`${result10.trades.length < result5.trades.length ? '10-bar has fewer (higher quality?) signals' : '5-bar generates more opportunities'}`);
    }

  } catch (error) {
    console.error('Backtest failed:', error.message);
  }
}

main();
