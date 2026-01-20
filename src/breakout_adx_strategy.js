/**
 * Breakout + ADX Strategy
 *
 * Entry Rules:
 * - LONG: Price breaks ABOVE 20-bar high
 *         + ADX > 20 (trending market confirmation)
 *         + Bullish candle (close > open)
 * - SHORT: Price breaks BELOW 20-bar low
 *          + ADX > 20 (trending market confirmation)
 *          + Bearish candle (close < open)
 *
 * Exit Rules:
 * - Stop Loss: 300 pips ($3.00)
 * - Take Profit: 450 pips ($4.50) = 1.5R
 *
 * Backtest Results (6 weeks Dec 2024 - Jan 2025):
 * - 32 trades, 65% win rate, +£9,901 profit
 * - Max drawdown: £966
 * - Profit factor: 3.42
 */
import Config from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// State file path - use /app/data in Docker, ./data locally
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'breakout_adx_state.json');

// Strategy parameters
const BREAKOUT_LOOKBACK = 20;  // Number of candles for Donchian channel
const ADX_MIN = 20;            // Minimum ADX for trending market

class BreakoutADXStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = `Breakout + ADX (${BREAKOUT_LOOKBACK}-bar)`;
    this.lastCandleTime = null;
    this.lastSignal = null;
    this.previousHigh = null;
    this.previousLow = null;

    // Load persisted state on startup
    this.loadState();
  }

  /**
   * Save strategy state to file for persistence across restarts
   */
  saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const state = {
        lastCandleTime: this.lastCandleTime,
        lastSignal: this.lastSignal,
        previousHigh: this.previousHigh,
        previousLow: this.previousLow,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      this.logger.debug(`💾 Breakout+ADX strategy state saved`);
    } catch (error) {
      this.logger.error(`Failed to save Breakout+ADX strategy state: ${error.message}`);
    }
  }

  /**
   * Load strategy state from file
   */
  loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        this.logger.info('📂 No existing Breakout+ADX strategy state found, starting fresh');
        return;
      }

      const rawData = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(rawData);

      this.lastCandleTime = state.lastCandleTime;
      this.lastSignal = state.lastSignal;
      this.previousHigh = state.previousHigh;
      this.previousLow = state.previousLow;

      this.logger.info(`📂 Loaded Breakout+ADX state: High=$${this.previousHigh?.toFixed(2) || 'null'}, Low=$${this.previousLow?.toFixed(2) || 'null'}`);
    } catch (error) {
      this.logger.error(`Failed to load Breakout+ADX strategy state: ${error.message}`);
    }
  }

  /**
   * Calculate Donchian Channel (20-bar high/low)
   * Returns: { high: number, low: number }
   */
  calculateDonchianChannel(candles) {
    if (candles.length < BREAKOUT_LOOKBACK) return null;

    // Get the lookback period candles (excluding the current candle)
    const lookbackCandles = candles.slice(-(BREAKOUT_LOOKBACK + 1), -1);

    const channelHigh = Math.max(...lookbackCandles.map(c => c.high));
    const channelLow = Math.min(...lookbackCandles.map(c => c.low));

    return { high: channelHigh, low: channelLow };
  }

  /**
   * Evaluate if there's a valid trade setup
   * Returns: { signal: 'LONG' | 'SHORT' | null, reason: string, confidence: number }
   */
  evaluateSetup(analysis, candles) {
    // Need enough candles for Donchian channel
    if (!candles || candles.length < BREAKOUT_LOOKBACK + 1) {
      return {
        signal: null,
        reason: 'Insufficient candle data for Donchian channel calculation',
        confidence: 0
      };
    }

    // Get the most recent completed candle
    const lastCandle = candles[candles.length - 1];
    const currentCandleTime = lastCandle.time.toISOString();
    const currentPrice = lastCandle.close;
    const isBullishCandle = lastCandle.close > lastCandle.open;
    const isBearishCandle = lastCandle.close < lastCandle.open;

    // Calculate Donchian Channel
    const channel = this.calculateDonchianChannel(candles);
    if (!channel) {
      return {
        signal: null,
        reason: 'Unable to calculate Donchian channel',
        confidence: 0
      };
    }

    // Get ADX from analysis
    const adx = analysis.indicators.adx;

    // Check if this is a new candle
    const isNewCandle = this.lastCandleTime !== currentCandleTime;

    // First run - just store values
    if (this.previousHigh === null || this.previousLow === null) {
      this.previousHigh = channel.high;
      this.previousLow = channel.low;
      this.lastCandleTime = currentCandleTime;
      this.saveState();
      return {
        signal: null,
        reason: `Initializing - need previous channel values. Current: High=$${channel.high.toFixed(2)}, Low=$${channel.low.toFixed(2)}`,
        confidence: 0
      };
    }

    // If same candle as before, don't generate new signals
    if (!isNewCandle) {
      return {
        signal: null,
        reason: `No new candle. Channel: $${channel.low.toFixed(2)} - $${channel.high.toFixed(2)}, Price: $${currentPrice.toFixed(2)}, ADX: ${adx?.toFixed(1) || 'N/A'}`,
        confidence: 0,
        channelHigh: channel.high,
        channelLow: channel.low
      };
    }

    let signal = null;
    let reason = '';
    let confidence = 50;
    const filters = [];

    // Log the comparison for debugging
    this.logger.debug(`📊 Breakout Check: prevHigh=${this.previousHigh?.toFixed(2)} prevLow=${this.previousLow?.toFixed(2)} → price=${currentPrice.toFixed(2)}, ADX=${adx?.toFixed(1)}`);

    // Check for breakout above channel high (LONG)
    const bullishBreakout = currentPrice > this.previousHigh;
    // Check for breakout below channel low (SHORT)
    const bearishBreakout = currentPrice < this.previousLow;

    if (bullishBreakout) {
      signal = 'LONG';
      reason = `Bullish breakout: Price $${currentPrice.toFixed(2)} broke above ${BREAKOUT_LOOKBACK}-bar high $${this.previousHigh.toFixed(2)}`;

      // Apply ADX filter
      if (adx !== null && adx < ADX_MIN) {
        filters.push(`ADX ${adx.toFixed(1)} < ${ADX_MIN} (ranging market)`);
        signal = null;
      }

      // Apply bullish candle filter
      if (signal && !isBullishCandle) {
        filters.push(`Bearish candle (need bullish confirmation)`);
        signal = null;
      }

      // Adjust confidence based on conditions
      if (signal) {
        if (adx !== null && adx > 25) confidence += 10;
        if (adx !== null && adx > 30) confidence += 10;
        const breakoutDistance = currentPrice - this.previousHigh;
        if (breakoutDistance > 2) confidence += 5; // Strong breakout
        if (breakoutDistance > 5) confidence += 5; // Very strong breakout
      }
    }
    else if (bearishBreakout) {
      signal = 'SHORT';
      reason = `Bearish breakout: Price $${currentPrice.toFixed(2)} broke below ${BREAKOUT_LOOKBACK}-bar low $${this.previousLow.toFixed(2)}`;

      // Apply ADX filter
      if (adx !== null && adx < ADX_MIN) {
        filters.push(`ADX ${adx.toFixed(1)} < ${ADX_MIN} (ranging market)`);
        signal = null;
      }

      // Apply bearish candle filter
      if (signal && !isBearishCandle) {
        filters.push(`Bullish candle (need bearish confirmation)`);
        signal = null;
      }

      // Adjust confidence based on conditions
      if (signal) {
        if (adx !== null && adx > 25) confidence += 10;
        if (adx !== null && adx > 30) confidence += 10;
        const breakoutDistance = this.previousLow - currentPrice;
        if (breakoutDistance > 2) confidence += 5; // Strong breakout
        if (breakoutDistance > 5) confidence += 5; // Very strong breakout
      }
    }
    else {
      reason = `No breakout. Channel: $${channel.low.toFixed(2)} - $${channel.high.toFixed(2)}, Price: $${currentPrice.toFixed(2)}`;
    }

    // If breakout detected but filtered out
    if ((bullishBreakout || bearishBreakout) && signal === null && filters.length > 0) {
      reason += ` - FILTERED: ${filters.join(', ')}`;
    }

    // Store current values and persist state
    this.previousHigh = channel.high;
    this.previousLow = channel.low;
    this.lastCandleTime = currentCandleTime;
    this.saveState();

    if (signal) {
      this.lastSignal = signal;
      this.logger.strategy(`✅ Breakout+ADX signal!`, {
        channelHigh: channel.high.toFixed(2),
        channelLow: channel.low.toFixed(2),
        price: currentPrice.toFixed(2),
        adx: adx?.toFixed(1) || 'N/A',
        signal,
        confidence,
        candleTime: currentCandleTime
      });
    }

    return {
      signal,
      reason,
      confidence,
      channelHigh: channel.high,
      channelLow: channel.low,
      analysis
    };
  }

  /**
   * Check if position should be exited
   * For this strategy, we rely on stop loss and take profit orders
   * No discretionary exit signals
   */
  shouldExit(position, currentPrice, candles) {
    // This strategy uses fixed SL/TP, no discretionary exits
    return false;
  }

  /**
   * Calculate entry levels (stop loss and take profit)
   */
  calculateEntryLevels(analysis, signal) {
    const currentPrice = analysis.indicators.price;
    const isLong = signal === 'LONG';

    const entryPrice = currentPrice;

    // Stop Loss
    const stopPips = Config.STOP_LOSS_PIPS;
    const stopDistance = Config.pipsToPrice(stopPips);
    const stopLoss = isLong ? entryPrice - stopDistance : entryPrice + stopDistance;

    const riskDistance = Math.abs(entryPrice - stopLoss);
    const riskPips = Config.priceToPips(riskDistance);

    let takeProfit1, takeProfit2;

    if (Config.ENABLE_STAGED_TP) {
      // Staged TP: TP1 at 1.5R (close 60%), TP2 at 2.5R (close 40%)
      const tp1Distance = riskDistance * Config.TAKE_PROFIT_1_RR;
      const tp2Distance = riskDistance * Config.TAKE_PROFIT_2_RR;
      takeProfit1 = isLong ? entryPrice + tp1Distance : entryPrice - tp1Distance;
      takeProfit2 = isLong ? entryPrice + tp2Distance : entryPrice - tp2Distance;
    } else {
      // Single TP: Both set to same target (2.5R)
      const tpDistance = riskDistance * Config.TAKE_PROFIT_RR;
      takeProfit1 = isLong ? entryPrice + tpDistance : entryPrice - tpDistance;
      takeProfit2 = takeProfit1; // Same as TP1 for single TP mode
    }

    this.logger.strategy('Breakout+ADX entry levels calculated', {
      entryPrice: entryPrice.toFixed(2),
      stopLoss: stopLoss.toFixed(2),
      takeProfit1: takeProfit1.toFixed(2),
      takeProfit2: takeProfit2.toFixed(2),
      riskPips: riskPips.toFixed(1)
    });

    return {
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskPips
    };
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return `
      ${this.name}

      Entry: Price breaks ${BREAKOUT_LOOKBACK}-bar high/low (Donchian Channel)
      Filter: ADX > ${ADX_MIN} (trending market)
      Confirmation: Bullish candle for longs, bearish for shorts
      Stop Loss: ${Config.STOP_LOSS_PIPS} pips
      Take Profit: ${Config.TAKE_PROFIT_1_RR}R / ${Config.TAKE_PROFIT_2_RR}R

      Trend-following breakout strategy with ADX confirmation
    `.trim();
  }
}

export default BreakoutADXStrategy;
