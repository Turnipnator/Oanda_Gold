/**
 * Enhanced Moving Average Crossover Strategy
 *
 * Entry Rules:
 * - LONG: 10 SMA crosses above 50 SMA
 *         + RSI > 50 (momentum confirmation)
 *         + ADX > 20 (trending market)
 * - SHORT: 10 SMA crosses below 50 SMA
 *          + RSI < 50 (momentum confirmation)
 *          + ADX > 20 (trending market)
 *
 * Exit Rules:
 * - Close position when price closes back through 50 SMA
 *
 * Filters to avoid whipsaws:
 * - RSI must confirm direction (>50 for longs, <50 for shorts)
 * - ADX must be >20 to confirm trending (not ranging) market
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

// Strategy parameters
const SMA_FAST = 10;   // Fast SMA period (was 5)
const SMA_SLOW = 50;   // Slow SMA period (was 20)
const RSI_THRESHOLD = 50;  // RSI level for confirmation
const ADX_MIN = 20;        // Minimum ADX for trending market

class MACrossoverStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = `MA Crossover (${SMA_FAST}/${SMA_SLOW})`;
    this.previousSMAFast = null;
    this.previousSMASlow = null;
    this.lastCandleTime = null;
    this.lastSignal = null;

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
        previousSMAFast: this.previousSMAFast,
        previousSMASlow: this.previousSMASlow,
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

      this.previousSMAFast = state.previousSMAFast || state.previousSMA5;
      this.previousSMASlow = state.previousSMASlow || state.previousSMA20;
      this.lastCandleTime = state.lastCandleTime;
      this.lastSignal = state.lastSignal;

      this.logger.info(`📂 Loaded MA strategy state: SMA${SMA_FAST}=$${this.previousSMAFast?.toFixed(2) || 'null'}, SMA${SMA_SLOW}=$${this.previousSMASlow?.toFixed(2) || 'null'}`);
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
    // Need enough candles for slow SMA
    if (!candles || candles.length < SMA_SLOW) {
      return {
        signal: null,
        reason: 'Insufficient candle data for SMA calculation',
        confidence: 0
      };
    }

    // Get the most recent completed candle time
    const lastCandle = candles[candles.length - 1];
    const currentCandleTime = lastCandle.time.toISOString();

    // Calculate SMAs
    const smaFast = this.calculateSMA(candles, SMA_FAST);
    const smaSlow = this.calculateSMA(candles, SMA_SLOW);

    if (!smaFast || !smaSlow) {
      return {
        signal: null,
        reason: 'Unable to calculate SMAs',
        confidence: 0
      };
    }

    // Get RSI and ADX from analysis
    const rsi = analysis.indicators.rsi;
    const adx = analysis.indicators.adx;
    const currentPrice = analysis.indicators.price;

    // Check if this is a new candle
    const isNewCandle = this.lastCandleTime !== currentCandleTime;

    // First run - just store values
    if (this.previousSMAFast === null || this.previousSMASlow === null) {
      this.previousSMAFast = smaFast;
      this.previousSMASlow = smaSlow;
      this.lastCandleTime = currentCandleTime;
      this.saveState();
      return {
        signal: null,
        reason: `Initializing - need previous SMA values to detect crosses`,
        confidence: 0
      };
    }

    // If same candle as before, don't generate new signals
    if (!isNewCandle) {
      return {
        signal: null,
        reason: `No new candle. ${SMA_FAST} SMA: $${smaFast.toFixed(2)}, ${SMA_SLOW} SMA: $${smaSlow.toFixed(2)}, RSI: ${rsi?.toFixed(1) || 'N/A'}, ADX: ${adx?.toFixed(1) || 'N/A'}`,
        confidence: 0,
        smaFast,
        smaSlow
      };
    }

    let signal = null;
    let reason = '';
    let confidence = 50;
    const filters = [];

    // Log the comparison for debugging
    this.logger.debug(`📊 MA Check: prevFast=${this.previousSMAFast?.toFixed(2)} prevSlow=${this.previousSMASlow?.toFixed(2)} → currFast=${smaFast.toFixed(2)} currSlow=${smaSlow.toFixed(2)}`);

    // Check for crossover
    const bullishCrossover = this.previousSMAFast <= this.previousSMASlow && smaFast > smaSlow;
    const bearishCrossover = this.previousSMAFast >= this.previousSMASlow && smaFast < smaSlow;

    if (bullishCrossover) {
      signal = 'LONG';
      reason = `Bullish crossover: ${SMA_FAST} SMA ($${smaFast.toFixed(2)}) crossed above ${SMA_SLOW} SMA ($${smaSlow.toFixed(2)})`;

      // Apply filters
      if (rsi !== null && rsi <= RSI_THRESHOLD) {
        filters.push(`RSI ${rsi.toFixed(1)} ≤ ${RSI_THRESHOLD} (weak momentum)`);
        signal = null;
      }

      if (adx !== null && adx < ADX_MIN) {
        filters.push(`ADX ${adx.toFixed(1)} < ${ADX_MIN} (ranging market)`);
        signal = null;
      }

      // Adjust confidence based on conditions
      if (signal) {
        if (currentPrice > smaSlow) confidence += 10;
        if (rsi !== null && rsi > 55) confidence += 10;
        if (adx !== null && adx > 25) confidence += 10;
        const separation = smaFast - smaSlow;
        if (separation > 5) confidence += 5;
      }
    }
    else if (bearishCrossover) {
      signal = 'SHORT';
      reason = `Bearish crossover: ${SMA_FAST} SMA ($${smaFast.toFixed(2)}) crossed below ${SMA_SLOW} SMA ($${smaSlow.toFixed(2)})`;

      // Apply filters
      if (rsi !== null && rsi >= RSI_THRESHOLD) {
        filters.push(`RSI ${rsi.toFixed(1)} ≥ ${RSI_THRESHOLD} (weak momentum)`);
        signal = null;
      }

      if (adx !== null && adx < ADX_MIN) {
        filters.push(`ADX ${adx.toFixed(1)} < ${ADX_MIN} (ranging market)`);
        signal = null;
      }

      // Adjust confidence based on conditions
      if (signal) {
        if (currentPrice < smaSlow) confidence += 10;
        if (rsi !== null && rsi < 45) confidence += 10;
        if (adx !== null && adx > 25) confidence += 10;
        const separation = smaSlow - smaFast;
        if (separation > 5) confidence += 5;
      }
    }
    else {
      reason = `No crossover (${SMA_FAST} SMA: $${smaFast.toFixed(2)}, ${SMA_SLOW} SMA: $${smaSlow.toFixed(2)})`;
    }

    // If crossover detected but filtered out
    if ((bullishCrossover || bearishCrossover) && signal === null && filters.length > 0) {
      reason += ` - FILTERED: ${filters.join(', ')}`;
    }

    // Store current values and persist state
    this.previousSMAFast = smaFast;
    this.previousSMASlow = smaSlow;
    this.lastCandleTime = currentCandleTime;
    this.saveState();

    if (signal) {
      this.lastSignal = signal;
      this.logger.strategy(`✅ MA Crossover signal!`, {
        smaFast: smaFast.toFixed(2),
        smaSlow: smaSlow.toFixed(2),
        rsi: rsi?.toFixed(1) || 'N/A',
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
      smaFast,
      smaSlow,
      analysis
    };
  }

  /**
   * Check if position should be exited
   * Exit when price closes back through slow SMA
   */
  shouldExit(position, currentPrice, candles) {
    if (!candles || candles.length < SMA_SLOW) return false;

    const smaSlow = this.calculateSMA(candles, SMA_SLOW);
    if (!smaSlow) return false;

    const isLong = position.signal === 'LONG';

    // Exit LONG when price closes below slow SMA
    if (isLong && currentPrice < smaSlow) {
      this.logger.strategy(`Exit signal: Price ($${currentPrice.toFixed(2)}) closed below ${SMA_SLOW} SMA ($${smaSlow.toFixed(2)})`);
      return true;
    }

    // Exit SHORT when price closes above slow SMA
    if (!isLong && currentPrice > smaSlow) {
      this.logger.strategy(`Exit signal: Price ($${currentPrice.toFixed(2)}) closed above ${SMA_SLOW} SMA ($${smaSlow.toFixed(2)})`);
      return true;
    }

    return false;
  }

  /**
   * Calculate entry levels (stop loss and take profit)
   */
  calculateEntryLevels(analysis, signal, smaSlow) {
    const currentPrice = analysis.indicators.price;
    const isLong = signal === 'LONG';

    const entryPrice = currentPrice;

    // Stop Loss
    const stopPips = Config.STOP_LOSS_PIPS;
    const stopDistance = Config.pipsToPrice(stopPips);
    const stopLoss = isLong ? entryPrice - stopDistance : entryPrice + stopDistance;

    // Take Profits
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

      Entry: ${SMA_FAST} SMA crosses ${SMA_SLOW} SMA
      Filters: RSI ${RSI_THRESHOLD} confirmation, ADX > ${ADX_MIN}
      Exit: Price closes back through ${SMA_SLOW} SMA

      Enhanced trend-following with momentum & trend filters
    `.trim();
  }
}

export default MACrossoverStrategy;
