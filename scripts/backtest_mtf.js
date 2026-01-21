/**
 * Multi-Timeframe Backtest: H4-only vs H4+H1
 *
 * Compares:
 * 1. Current strategy: H4 breakout entry
 * 2. MTF strategy: H4 for direction, H1 for entry timing
 */
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config();

// Config
const API_KEY = process.env.OANDA_API_KEY;
const ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID;
const HOSTNAME = 'https://api-fxpractice.oanda.com';
const INSTRUMENT = 'XAU_USD';

// Strategy parameters
const BREAKOUT_LOOKBACK = 20;
const ADX_MIN = 20;
const STOP_LOSS_PIPS = 350;  // $3.50
const TRAILING_PIPS = 150;   // $1.50
const RISK_PERCENT = 0.005;  // 0.5%
const INITIAL_BALANCE = 100000;

// H1 refinement parameters
const H1_EMA_PERIOD = 20;
const H1_PULLBACK_PIPS = 100;  // Wait for $1.00 pullback on H1
const H1_MAX_WAIT_CANDLES = 8; // Max 8 H1 candles (8 hours) to wait for entry

/**
 * Fetch candles from Oanda
 */
async function fetchCandles(granularity, count = 500) {
  const url = `${HOSTNAME}/v3/instruments/${INSTRUMENT}/candles?count=${count}&granularity=${granularity}&price=M`;

  const response = await axios.get(url, {
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    }
  });

  return response.data.candles
    .filter(c => c.complete)
    .map(c => ({
      time: new Date(c.time),
      open: parseFloat(c.mid.o),
      high: parseFloat(c.mid.h),
      low: parseFloat(c.mid.l),
      close: parseFloat(c.mid.c),
      volume: parseInt(c.volume)
    }));
}

/**
 * Calculate EMA
 */
function calculateEMA(prices, period) {
  const k = 2 / (period + 1);
  const ema = [prices[0]];

  for (let i = 1; i < prices.length; i++) {
    ema.push(prices[i] * k + ema[i - 1] * (1 - k));
  }

  return ema;
}

/**
 * Calculate ADX
 */
function calculateADX(candles, period = 14) {
  if (candles.length < period * 2) return null;

  const tr = [];
  const plusDM = [];
  const minusDM = [];

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high;
    const low = candles[i].low;
    const prevHigh = candles[i - 1].high;
    const prevLow = candles[i - 1].low;
    const prevClose = candles[i - 1].close;

    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

    const upMove = high - prevHigh;
    const downMove = prevLow - low;

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Smoothed averages
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0);
  let plusDI = plusDM.slice(0, period).reduce((a, b) => a + b, 0);
  let minusDI = minusDM.slice(0, period).reduce((a, b) => a + b, 0);

  const dx = [];

  for (let i = period; i < tr.length; i++) {
    atr = atr - atr / period + tr[i];
    plusDI = plusDI - plusDI / period + plusDM[i];
    minusDI = minusDI - minusDI / period + minusDM[i];

    const plusDIVal = (plusDI / atr) * 100;
    const minusDIVal = (minusDI / atr) * 100;
    const dxVal = Math.abs(plusDIVal - minusDIVal) / (plusDIVal + minusDIVal) * 100;

    dx.push(dxVal);
  }

  if (dx.length < period) return null;

  let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;

  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period;
  }

  return adx;
}

/**
 * Calculate Donchian Channel
 */
function calculateDonchian(candles, lookback) {
  if (candles.length < lookback) return null;

  const lookbackCandles = candles.slice(-lookback);
  return {
    high: Math.max(...lookbackCandles.map(c => c.high)),
    low: Math.min(...lookbackCandles.map(c => c.low))
  };
}

/**
 * Simulate trailing stop
 */
function simulateTrailingExit(entryPrice, isLong, candles, slPips, trailPips) {
  const slDistance = slPips * 0.01;
  const trailDistance = trailPips * 0.01;

  let stopLoss = isLong ? entryPrice - slDistance : entryPrice + slDistance;
  let bestPrice = entryPrice;

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i];

    // Check if stop loss hit
    if (isLong) {
      if (candle.low <= stopLoss) {
        return { exitPrice: stopLoss, exitIndex: i, reason: 'SL' };
      }
      // Update trailing
      if (candle.high > bestPrice) {
        bestPrice = candle.high;
        const newStop = bestPrice - trailDistance;
        if (newStop > stopLoss) {
          stopLoss = newStop;
        }
      }
    } else {
      if (candle.high >= stopLoss) {
        return { exitPrice: stopLoss, exitIndex: i, reason: 'SL' };
      }
      // Update trailing
      if (candle.low < bestPrice) {
        bestPrice = candle.low;
        const newStop = bestPrice + trailDistance;
        if (newStop < stopLoss) {
          stopLoss = newStop;
        }
      }
    }
  }

  // Still open - use last close
  return { exitPrice: candles[candles.length - 1].close, exitIndex: candles.length - 1, reason: 'OPEN' };
}

/**
 * Strategy 1: H4-only (current)
 */
function runH4OnlyStrategy(h4Candles) {
  const trades = [];
  let balance = INITIAL_BALANCE;
  let maxDrawdown = 0;
  let peakBalance = INITIAL_BALANCE;

  let prevHigh = null;
  let prevLow = null;

  for (let i = BREAKOUT_LOOKBACK + 14; i < h4Candles.length - 50; i++) {
    const lookbackCandles = h4Candles.slice(i - BREAKOUT_LOOKBACK, i);
    const currentCandle = h4Candles[i];

    const channel = calculateDonchian(lookbackCandles, BREAKOUT_LOOKBACK);
    const adx = calculateADX(h4Candles.slice(0, i + 1));

    if (!channel || adx === null) continue;

    // First iteration - just store values
    if (prevHigh === null) {
      prevHigh = channel.high;
      prevLow = channel.low;
      continue;
    }

    const price = currentCandle.close;
    const isBullish = currentCandle.close > currentCandle.open;
    const isBearish = currentCandle.close < currentCandle.open;

    let signal = null;

    // Check breakout
    if (price > prevHigh && adx >= ADX_MIN && isBullish) {
      signal = 'LONG';
    } else if (price < prevLow && adx >= ADX_MIN && isBearish) {
      signal = 'SHORT';
    }

    prevHigh = channel.high;
    prevLow = channel.low;

    if (signal) {
      const entryPrice = price;
      const isLong = signal === 'LONG';

      // Simulate exit with trailing
      const futureCandles = h4Candles.slice(i + 1);
      const exit = simulateTrailingExit(entryPrice, isLong, futureCandles, STOP_LOSS_PIPS, TRAILING_PIPS);

      // Calculate P&L
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

      // Skip ahead to avoid overlapping trades
      i += exit.exitIndex;
    }
  }

  return { trades, finalBalance: balance, maxDrawdown };
}

/**
 * Strategy 2: H4+H1 Multi-Timeframe
 * - H4 determines breakout direction
 * - H1 finds pullback entry for better price
 */
function runH4H1Strategy(h4Candles, h1Candles) {
  const trades = [];
  let balance = INITIAL_BALANCE;
  let maxDrawdown = 0;
  let peakBalance = INITIAL_BALANCE;

  let prevHigh = null;
  let prevLow = null;

  // Calculate H1 EMA for all candles
  const h1Closes = h1Candles.map(c => c.close);
  const h1EMA = calculateEMA(h1Closes, H1_EMA_PERIOD);

  for (let i = BREAKOUT_LOOKBACK + 14; i < h4Candles.length - 50; i++) {
    const lookbackCandles = h4Candles.slice(i - BREAKOUT_LOOKBACK, i);
    const currentH4 = h4Candles[i];

    const channel = calculateDonchian(lookbackCandles, BREAKOUT_LOOKBACK);
    const adx = calculateADX(h4Candles.slice(0, i + 1));

    if (!channel || adx === null) continue;

    if (prevHigh === null) {
      prevHigh = channel.high;
      prevLow = channel.low;
      continue;
    }

    const price = currentH4.close;
    const isBullish = currentH4.close > currentH4.open;
    const isBearish = currentH4.close < currentH4.open;

    let h4Signal = null;

    // H4 breakout signal (direction only)
    if (price > prevHigh && adx >= ADX_MIN && isBullish) {
      h4Signal = 'LONG';
    } else if (price < prevLow && adx >= ADX_MIN && isBearish) {
      h4Signal = 'SHORT';
    }

    prevHigh = channel.high;
    prevLow = channel.low;

    if (h4Signal) {
      // Find corresponding H1 candles
      const h4Time = currentH4.time.getTime();
      const h1StartIndex = h1Candles.findIndex(c => c.time.getTime() >= h4Time);

      if (h1StartIndex === -1) continue;

      // Look for pullback entry on H1
      let entryPrice = null;
      let entryH1Index = null;
      const isLong = h4Signal === 'LONG';
      const breakoutPrice = price;
      const pullbackTarget = isLong
        ? breakoutPrice - (H1_PULLBACK_PIPS * 0.01)
        : breakoutPrice + (H1_PULLBACK_PIPS * 0.01);

      // Wait for pullback to H1 EMA or pullback target
      for (let j = h1StartIndex; j < Math.min(h1StartIndex + H1_MAX_WAIT_CANDLES, h1Candles.length); j++) {
        const h1Candle = h1Candles[j];
        const ema = h1EMA[j];

        if (isLong) {
          // For LONG: wait for price to pull back to EMA or pullback level, then show bullish candle
          if (h1Candle.low <= Math.max(ema, pullbackTarget)) {
            // Check if this or next candle is bullish (confirmation)
            if (h1Candle.close > h1Candle.open) {
              entryPrice = h1Candle.close;
              entryH1Index = j;
              break;
            }
          }
        } else {
          // For SHORT: wait for price to pull back to EMA or pullback level, then show bearish candle
          if (h1Candle.high >= Math.min(ema, pullbackTarget)) {
            if (h1Candle.close < h1Candle.open) {
              entryPrice = h1Candle.close;
              entryH1Index = j;
              break;
            }
          }
        }
      }

      // If no pullback found, enter at breakout price (fallback to H4 behavior)
      if (entryPrice === null) {
        entryPrice = breakoutPrice;
        entryH1Index = h1StartIndex;
      }

      // Simulate exit using H1 candles for more precision
      const futureH1 = h1Candles.slice(entryH1Index + 1);
      const exit = simulateTrailingExit(entryPrice, isLong, futureH1, STOP_LOSS_PIPS, TRAILING_PIPS);

      // Calculate P&L
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
        time: currentH4.time,
        signal: h4Signal,
        entry: entryPrice,
        h4Price: breakoutPrice,
        improvement: isLong ? breakoutPrice - entryPrice : entryPrice - breakoutPrice,
        exit: exit.exitPrice,
        pnl,
        reason: exit.reason,
        balance
      });

      // Skip ahead
      i += Math.ceil(exit.exitIndex / 4); // Convert H1 bars to H4 bars
    }
  }

  return { trades, finalBalance: balance, maxDrawdown };
}

/**
 * Print results
 */
function printResults(name, result) {
  const { trades, finalBalance, maxDrawdown } = result;

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const winRate = trades.length > 0 ? (wins.length / trades.length * 100).toFixed(1) : 0;
  const totalPnL = finalBalance - INITIAL_BALANCE;
  const avgWin = wins.length > 0 ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 0;

  console.log(`\n${'='.repeat(60)}`);
  console.log(`${name}`);
  console.log('='.repeat(60));
  console.log(`Total Trades:    ${trades.length}`);
  console.log(`Wins/Losses:     ${wins.length}/${losses.length}`);
  console.log(`Win Rate:        ${winRate}%`);
  console.log(`Total P&L:       £${totalPnL.toFixed(2)}`);
  console.log(`Final Balance:   £${finalBalance.toFixed(2)}`);
  console.log(`Max Drawdown:    £${maxDrawdown.toFixed(2)}`);
  console.log(`Avg Win:         £${avgWin.toFixed(2)}`);
  console.log(`Avg Loss:        £${avgLoss.toFixed(2)}`);
  console.log(`Profit Factor:   ${profitFactor.toFixed(2)}`);
  console.log(`Return:          ${((totalPnL / INITIAL_BALANCE) * 100).toFixed(1)}%`);

  // Show entry improvement for MTF strategy
  if (trades.length > 0 && trades[0].improvement !== undefined) {
    const avgImprovement = trades.reduce((a, t) => a + t.improvement, 0) / trades.length;
    console.log(`Avg Entry Improvement: $${avgImprovement.toFixed(2)}`);
  }
}

/**
 * Main
 */
async function main() {
  console.log('Fetching candle data from Oanda...');
  console.log(`SL: ${STOP_LOSS_PIPS} pips ($${(STOP_LOSS_PIPS * 0.01).toFixed(2)})`);
  console.log(`Trail: ${TRAILING_PIPS} pips ($${(TRAILING_PIPS * 0.01).toFixed(2)})`);
  console.log(`Risk: ${RISK_PERCENT * 100}% per trade`);
  console.log('');

  try {
    // Fetch data
    const [h4Candles, h1Candles] = await Promise.all([
      fetchCandles('H4', 500),  // ~83 days of H4 data
      fetchCandles('H1', 2000)  // ~83 days of H1 data
    ]);

    console.log(`H4 candles: ${h4Candles.length} (${h4Candles[0].time.toISOString().split('T')[0]} to ${h4Candles[h4Candles.length-1].time.toISOString().split('T')[0]})`);
    console.log(`H1 candles: ${h1Candles.length} (${h1Candles[0].time.toISOString().split('T')[0]} to ${h1Candles[h1Candles.length-1].time.toISOString().split('T')[0]})`);

    // Run backtests
    console.log('\nRunning H4-only backtest...');
    const h4Result = runH4OnlyStrategy(h4Candles);

    console.log('Running H4+H1 MTF backtest...');
    const mtfResult = runH4H1Strategy(h4Candles, h1Candles);

    // Print results
    printResults('STRATEGY 1: H4 ONLY (Current)', h4Result);
    printResults('STRATEGY 2: H4 + H1 MULTI-TIMEFRAME', mtfResult);

    // Comparison
    console.log(`\n${'='.repeat(60)}`);
    console.log('COMPARISON');
    console.log('='.repeat(60));

    const h4PnL = h4Result.finalBalance - INITIAL_BALANCE;
    const mtfPnL = mtfResult.finalBalance - INITIAL_BALANCE;
    const pnlDiff = mtfPnL - h4PnL;

    console.log(`P&L Difference:  £${pnlDiff.toFixed(2)} (${pnlDiff > 0 ? 'MTF better' : 'H4 better'})`);
    console.log(`Trade Count:     H4=${h4Result.trades.length}, MTF=${mtfResult.trades.length}`);

    const h4WinRate = h4Result.trades.length > 0 ? h4Result.trades.filter(t => t.pnl > 0).length / h4Result.trades.length * 100 : 0;
    const mtfWinRate = mtfResult.trades.length > 0 ? mtfResult.trades.filter(t => t.pnl > 0).length / mtfResult.trades.length * 100 : 0;
    console.log(`Win Rate:        H4=${h4WinRate.toFixed(1)}%, MTF=${mtfWinRate.toFixed(1)}%`);
    console.log(`Max Drawdown:    H4=£${h4Result.maxDrawdown.toFixed(2)}, MTF=£${mtfResult.maxDrawdown.toFixed(2)}`);

    console.log(`\n${'='.repeat(60)}`);
    console.log('RECOMMENDATION');
    console.log('='.repeat(60));

    if (mtfPnL > h4PnL && mtfResult.maxDrawdown <= h4Result.maxDrawdown * 1.2) {
      console.log('MTF (H4+H1) strategy shows better results.');
      console.log('Consider implementing the multi-timeframe approach.');
    } else if (h4PnL > mtfPnL) {
      console.log('H4-only strategy performs better in this period.');
      console.log('Keep the current simple approach.');
    } else {
      console.log('Results are similar. Simple H4-only may be preferred for ease.');
    }

  } catch (error) {
    console.error('Backtest failed:', error.message);
    if (error.response) {
      console.error('API Error:', error.response.data);
    }
  }
}

main();
