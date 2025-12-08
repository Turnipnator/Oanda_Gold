/**
 * Simple Moving Average Crossover Strategy
 *
 * Entry Rules:
 * - LONG: When 5 SMA crosses above 20 SMA
 * - SHORT: When 5 SMA crosses below 20 SMA
 *
 * Exit Rules:
 * - Close position when price closes back through 20 SMA
 *
 * Classic trend-following strategy - simple and reactive
 */
import Config from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// State file path - use /app/data in Docker, ./data locally
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'ma_strategy_state.json');

class MACrossoverStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = 'MA Crossover (5/20)';
    this.previousSMA5 = null;
    this.previousSMA20 = null;
    this.lastCandleTime = null; // Track last candle to prevent duplicate signals
    this.lastSignal = null; // Track last signal to detect crosses

    // Load persisted state on startup
    this.loadState();
  }

  /**
   * Save strategy state to file for persistence across restarts
   */
  saveState() {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const state = {
        previousSMA5: this.previousSMA5,
        previousSMA20: this.previousSMA20,
        lastCandleTime: this.lastCandleTime,
        lastSignal: this.lastSignal,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
      this.logger.debug(`💾 MA strategy state saved`);
    } catch (error) {
      this.logger.error(`Failed to save MA strategy state: ${error.message}`);
    }
  }

  /**
   * Load strategy state from file
   */
  loadState() {
    try {
      if (!fs.existsSync(STATE_FILE)) {
        this.logger.info('📂 No existing MA strategy state found, starting fresh');
        return;
      }

      const rawData = fs.readFileSync(STATE_FILE, 'utf8');
      const state = JSON.parse(rawData);

      this.previousSMA5 = state.previousSMA5;
      this.previousSMA20 = state.previousSMA20;
      this.lastCandleTime = state.lastCandleTime;
      this.lastSignal = state.lastSignal;

      this.logger.info(`📂 Loaded MA strategy state: SMA5=$${this.previousSMA5?.toFixed(2) || 'null'}, SMA20=$${this.previousSMA20?.toFixed(2) || 'null'}, lastCandle=${this.lastCandleTime || 'null'}`);
    } catch (error) {
      this.logger.error(`Failed to load MA strategy state: ${error.message}`);
    }
  }

  /**
   * Calculate Simple Moving Average
   */
  calculateSMA(candles, period) {
    if (candles.length < period) return null;

    const recentCandles = candles.slice(-period);
    const sum = recentCandles.reduce((total, candle) => total + candle.close, 0);
    return sum / period;
  }

  /**
   * Evaluate if there's a valid trade setup
   * Returns: { signal: 'LONG' | 'SHORT' | null, reason: string, confidence: number }
   */
  evaluateSetup(analysis, candles) {
    // Need at least 20 candles for 20 SMA
    if (!candles || candles.length < 20) {
      return {
        signal: null,
        reason: 'Insufficient candle data for SMA calculation',
        confidence: 0
      };
    }

    // Get the most recent completed candle time
    const lastCandle = candles[candles.length - 1];
    const currentCandleTime = lastCandle.time.toISOString();

    // Calculate SMAs using only completed candles
    const sma5 = this.calculateSMA(candles, 5);
    const sma20 = this.calculateSMA(candles, 20);

    if (!sma5 || !sma20) {
      return {
        signal: null,
        reason: 'Unable to calculate SMAs',
        confidence: 0
      };
    }

    const currentPrice = analysis.indicators.price;

    // Check if this is a new candle (prevents duplicate signals on same candle)
    const isNewCandle = this.lastCandleTime !== currentCandleTime;

    // Detect crossovers (need previous values)
    if (this.previousSMA5 === null || this.previousSMA20 === null) {
      // First run - just store values and save state
      this.previousSMA5 = sma5;
      this.previousSMA20 = sma20;
      this.lastCandleTime = currentCandleTime;
      this.saveState();
      return {
        signal: null,
        reason: 'Initializing - need previous SMA values to detect crosses',
        confidence: 0
      };
    }

    // If same candle as before, don't generate new signals
    if (!isNewCandle) {
      return {
        signal: null,
        reason: `No new candle (last: ${this.lastCandleTime?.substring(0, 16)}). 5 SMA: $${sma5.toFixed(2)}, 20 SMA: $${sma20.toFixed(2)}`,
        confidence: 0,
        sma5,
        sma20
      };
    }

    let signal = null;
    let reason = '';
    let confidence = 50; // Base confidence for crossover signals

    // Log the comparison for debugging
    this.logger.debug(`📊 MA Check: prev5=${this.previousSMA5?.toFixed(2)} prev20=${this.previousSMA20?.toFixed(2)} → curr5=${sma5.toFixed(2)} curr20=${sma20.toFixed(2)}`);

    // Bullish crossover: 5 SMA crosses above 20 SMA
    if (this.previousSMA5 <= this.previousSMA20 && sma5 > sma20) {
      signal = 'LONG';
      reason = `Bullish crossover: 5 SMA ($${sma5.toFixed(2)}) crossed above 20 SMA ($${sma20.toFixed(2)}) [prev: $${this.previousSMA5.toFixed(2)}/$${this.previousSMA20.toFixed(2)}]`;

      // Increase confidence if price is also above 20 SMA
      if (currentPrice > sma20) confidence = 65;

      // Increase confidence if crossover is strong (wide separation)
      const separation = sma5 - sma20;
      if (separation > 5) confidence = 75;
    }
    // Bearish crossover: 5 SMA crosses below 20 SMA
    else if (this.previousSMA5 >= this.previousSMA20 && sma5 < sma20) {
      signal = 'SHORT';
      reason = `Bearish crossover: 5 SMA ($${sma5.toFixed(2)}) crossed below 20 SMA ($${sma20.toFixed(2)}) [prev: $${this.previousSMA5.toFixed(2)}/$${this.previousSMA20.toFixed(2)}]`;

      // Increase confidence if price is also below 20 SMA
      if (currentPrice < sma20) confidence = 65;

      // Increase confidence if crossover is strong (wide separation)
      const separation = sma20 - sma5;
      if (separation > 5) confidence = 75;
    }
    // No crossover
    else {
      reason = `No crossover (5 SMA: $${sma5.toFixed(2)}, 20 SMA: $${sma20.toFixed(2)})`;
    }

    // Store current values for next scan and persist state
    this.previousSMA5 = sma5;
    this.previousSMA20 = sma20;
    this.lastCandleTime = currentCandleTime;
    this.saveState();

    if (signal) {
      this.lastSignal = signal;
      this.logger.strategy(`✅ MA Crossover detected!`, {
        sma5: sma5.toFixed(2),
        sma20: sma20.toFixed(2),
        signal,
        confidence,
        candleTime: currentCandleTime
      });
    }

    return {
      signal,
      reason,
      confidence,
      sma5,
      sma20,
      analysis
    };
  }

  /**
   * Check if position should be exited
   * Exit when price closes back through 20 SMA
   */
  shouldExit(position, currentPrice, candles) {
    if (!candles || candles.length < 20) return false;

    const sma20 = this.calculateSMA(candles, 20);
    if (!sma20) return false;

    const isLong = position.signal === 'LONG';

    // Exit LONG when price closes below 20 SMA
    if (isLong && currentPrice < sma20) {
      this.logger.strategy(`Exit signal: Price ($${currentPrice.toFixed(2)}) closed below 20 SMA ($${sma20.toFixed(2)})`);
      return true;
    }

    // Exit SHORT when price closes above 20 SMA
    if (!isLong && currentPrice > sma20) {
      this.logger.strategy(`Exit signal: Price ($${currentPrice.toFixed(2)}) closed above 20 SMA ($${sma20.toFixed(2)})`);
      return true;
    }

    return false;
  }

  /**
   * Calculate entry levels (stop loss and take profit)
   * Using same risk management as main strategy
   */
  calculateEntryLevels(analysis, signal, sma20) {
    const currentPrice = analysis.indicators.price;
    const isLong = signal === 'LONG';

    // Entry: Current market price
    const entryPrice = currentPrice;

    // Stop Loss: Use same fixed distance as main strategy
    const stopPips = Config.STOP_LOSS_PIPS;
    const stopDistance = Config.pipsToPrice(stopPips);
    const stopLoss = isLong ? entryPrice - stopDistance : entryPrice + stopDistance;

    // Take Profits: Use same R:R ratios as main strategy
    const riskDistance = Math.abs(entryPrice - stopLoss);
    const tp1Distance = riskDistance * Config.TAKE_PROFIT_1_RR;
    const tp2Distance = riskDistance * Config.TAKE_PROFIT_2_RR;

    const takeProfit1 = isLong ? entryPrice + tp1Distance : entryPrice - tp1Distance;
    const takeProfit2 = isLong ? entryPrice + tp2Distance : entryPrice - tp2Distance;

    const riskPips = Config.priceToPips(riskDistance);

    this.logger.strategy('MA Crossover entry levels calculated', {
      entryPrice: entryPrice.toFixed(2),
      stopLoss: stopLoss.toFixed(2),
      takeProfit1: takeProfit1.toFixed(2),
      takeProfit2: takeProfit2.toFixed(2),
      riskPips: riskPips.toFixed(1),
      riskReward1: `1:${Config.TAKE_PROFIT_1_RR}`,
      riskReward2: `1:${Config.TAKE_PROFIT_2_RR}`
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

      Entry: 5 SMA crosses 20 SMA
      Exit: Price closes back through 20 SMA

      Simple trend-following crossover system
    `.trim();
  }
}

export default MACrossoverStrategy;
