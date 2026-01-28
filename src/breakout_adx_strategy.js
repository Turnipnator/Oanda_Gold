/**
 * Breakout + ADX Strategy with Multi-Timeframe (MTF) Support
 *
 * Entry Rules (H4):
 * - LONG: Price breaks ABOVE 20-bar high
 *         + ADX > 20 (trending market confirmation)
 *         + Bullish candle (close > open)
 * - SHORT: Price breaks BELOW 20-bar low
 *          + ADX > 20 (trending market confirmation)
 *          + Bearish candle (close < open)
 *
 * MTF Entry Refinement (H1):
 * - After H4 breakout, wait for H1 pullback to EMA20 or pullback target
 * - Enter on H1 confirmation candle (bullish for longs, bearish for shorts)
 * - Better entry = tighter stop loss = higher win rate
 *
 * Backtest Results (4 months Sep 2025 - Jan 2026):
 * - H4 only: 53 trades, 17% win rate, £34k profit
 * - H4+H1 MTF: 52 trades, 50% win rate, £62k profit
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

// Strategy parameters (now configurable via Config)
const ADX_MIN = 20;            // Minimum ADX for trending market

class BreakoutADXStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = Config.ENABLE_MTF
      ? `Breakout + ADX MTF (H4→${Config.MTF_ENTRY_TIMEFRAME})`
      : `Breakout + ADX (${Config.BREAKOUT_LOOKBACK}-bar)`;
    this.lastCandleTime = null;
    this.lastSignal = null;
    this.previousHigh = null;
    this.previousLow = null;

    // MTF state
    this.pendingSignal = null;  // Stores H4 breakout waiting for H1 entry
    this.pendingSignalTime = null;
    this.pendingBreakoutPrice = null;
    this.h1CandlesChecked = 0;

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
        pendingSignal: this.pendingSignal,
        pendingSignalTime: this.pendingSignalTime,
        pendingBreakoutPrice: this.pendingBreakoutPrice,
        h1CandlesChecked: this.h1CandlesChecked,
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
      this.pendingSignal = state.pendingSignal || null;
      this.pendingSignalTime = state.pendingSignalTime || null;
      this.pendingBreakoutPrice = state.pendingBreakoutPrice || null;
      this.h1CandlesChecked = state.h1CandlesChecked || 0;

      this.logger.info(`📂 Loaded Breakout+ADX state: High=$${this.previousHigh?.toFixed(2) || 'null'}, Low=$${this.previousLow?.toFixed(2) || 'null'}`);
      if (this.pendingSignal) {
        this.logger.info(`📂 Pending ${this.pendingSignal} signal from H4 breakout at $${this.pendingBreakoutPrice?.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.error(`Failed to load Breakout+ADX strategy state: ${error.message}`);
    }
  }

  /**
   * Calculate EMA
   */
  calculateEMA(prices, period) {
    if (prices.length < period) return null;

    const k = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = prices[i] * k + ema * (1 - k);
    }

    return ema;
  }

  /**
   * Calculate Donchian Channel (configurable lookback, default 10-bar)
   * Returns: { high: number, low: number }
   */
  calculateDonchianChannel(candles) {
    const lookback = Config.BREAKOUT_LOOKBACK;
    if (candles.length < lookback) return null;

    // Get the lookback period candles (excluding the current candle)
    const lookbackCandles = candles.slice(-(lookback + 1), -1);

    const channelHigh = Math.max(...lookbackCandles.map(c => c.high));
    const channelLow = Math.min(...lookbackCandles.map(c => c.low));

    return { high: channelHigh, low: channelLow };
  }

  /**
   * Check for H1 entry based on pending H4 signal
   * Returns refined entry or null if still waiting
   */
  evaluateH1Entry(h1Candles) {
    if (!this.pendingSignal || !Config.ENABLE_MTF) {
      return null;
    }

    // Check if we've waited too long
    this.h1CandlesChecked++;
    if (this.h1CandlesChecked > Config.MTF_MAX_WAIT_CANDLES) {
      this.logger.info(`⏰ MTF timeout: No H1 entry found after ${Config.MTF_MAX_WAIT_CANDLES} candles, canceling pending ${this.pendingSignal}`);
      this.clearPendingSignal();
      return null;
    }

    if (!h1Candles || h1Candles.length < Config.MTF_EMA_PERIOD + 5) {
      return null;
    }

    const isLong = this.pendingSignal === 'LONG';
    const breakoutPrice = this.pendingBreakoutPrice;
    const pullbackTarget = isLong
      ? breakoutPrice - (Config.MTF_PULLBACK_PIPS * 0.01)
      : breakoutPrice + (Config.MTF_PULLBACK_PIPS * 0.01);

    // Calculate H1 EMA
    const h1Closes = h1Candles.map(c => c.close);
    const h1EMA = this.calculateEMA(h1Closes, Config.MTF_EMA_PERIOD);

    // Get the most recent H1 candle
    const lastH1 = h1Candles[h1Candles.length - 1];
    const isBullishH1 = lastH1.close > lastH1.open;
    const isBearishH1 = lastH1.close < lastH1.open;

    this.logger.debug(`📊 MTF H1 Check: signal=${this.pendingSignal}, breakout=$${breakoutPrice.toFixed(2)}, pullbackTarget=$${pullbackTarget.toFixed(2)}, EMA=$${h1EMA?.toFixed(2)}, H1 close=$${lastH1.close.toFixed(2)}`);

    let entryFound = false;
    let entryPrice = null;
    let entryReason = '';

    if (isLong) {
      // For LONG: Wait for price to pull back to EMA or pullback target, then bullish candle
      const pullbackLevel = Math.max(h1EMA || 0, pullbackTarget);
      const pricePulledBack = lastH1.low <= pullbackLevel;

      if (pricePulledBack && isBullishH1) {
        entryFound = true;
        entryPrice = lastH1.close;
        const improvement = breakoutPrice - entryPrice;
        entryReason = `H1 pullback entry: Price pulled back to $${lastH1.low.toFixed(2)} (target $${pullbackLevel.toFixed(2)}), bullish confirmation. Entry improvement: $${improvement.toFixed(2)}`;
      }
    } else {
      // For SHORT: Wait for price to pull back to EMA or pullback target, then bearish candle
      const pullbackLevel = Math.min(h1EMA || Infinity, pullbackTarget);
      const pricePulledBack = lastH1.high >= pullbackLevel;

      if (pricePulledBack && isBearishH1) {
        entryFound = true;
        entryPrice = lastH1.close;
        const improvement = entryPrice - breakoutPrice;
        entryReason = `H1 pullback entry: Price pulled back to $${lastH1.high.toFixed(2)} (target $${pullbackLevel.toFixed(2)}), bearish confirmation. Entry improvement: $${improvement.toFixed(2)}`;
      }
    }

    if (entryFound) {
      this.logger.info(`✅ MTF Entry Found! ${this.pendingSignal} @ $${entryPrice.toFixed(2)}`);
      this.logger.info(`   ${entryReason}`);

      const signal = this.pendingSignal;
      this.clearPendingSignal();

      return {
        signal,
        entryPrice,
        reason: entryReason,
        confidence: 80,
        isMTFEntry: true
      };
    }

    this.logger.debug(`⏳ MTF waiting: ${this.pendingSignal} signal pending, H1 candle ${this.h1CandlesChecked}/${Config.MTF_MAX_WAIT_CANDLES}`);
    return null;
  }

  /**
   * Clear pending signal
   */
  clearPendingSignal() {
    this.pendingSignal = null;
    this.pendingSignalTime = null;
    this.pendingBreakoutPrice = null;
    this.h1CandlesChecked = 0;
    this.saveState();
  }

  /**
   * Evaluate if there's a valid trade setup (H4 timeframe)
   * Returns: { signal: 'LONG' | 'SHORT' | null, reason: string, confidence: number }
   */
  evaluateSetup(analysis, candles, h1Candles = null) {
    // First check if we have a pending MTF signal and H1 data
    if (this.pendingSignal && Config.ENABLE_MTF && h1Candles) {
      const h1Entry = this.evaluateH1Entry(h1Candles);
      if (h1Entry) {
        return h1Entry;
      }
      // Still waiting for H1 entry
      return {
        signal: null,
        reason: `Waiting for H1 entry: ${this.pendingSignal} breakout at $${this.pendingBreakoutPrice?.toFixed(2)}, checked ${this.h1CandlesChecked}/${Config.MTF_MAX_WAIT_CANDLES} H1 candles`,
        confidence: 0,
        pendingSignal: this.pendingSignal
      };
    }

    // Need enough candles for Donchian channel
    if (!candles || candles.length < Config.BREAKOUT_LOOKBACK + 1) {
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
      reason = `Bullish breakout: Price $${currentPrice.toFixed(2)} broke above ${Config.BREAKOUT_LOOKBACK}-bar high $${this.previousHigh.toFixed(2)}`;

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

      // FRESHNESS FILTER 1: RSI overbought check
      // Don't buy into an overbought market - the move may be exhausted
      // EXCEPTION: If ADX > 35 (strong trend), trust the momentum and ignore overbought RSI
      const rsi = analysis.indicators.rsi;
      const ADX_OVERRIDE_THRESHOLD = 35;
      const adxOverride = adx !== null && adx > ADX_OVERRIDE_THRESHOLD;
      if (signal && rsi !== null && rsi > Config.BREAKOUT_RSI_MAX_LONG && !adxOverride) {
        filters.push(`RSI ${rsi.toFixed(1)} > ${Config.BREAKOUT_RSI_MAX_LONG} (overbought - move exhausted)`);
        signal = null;
      }
      if (signal && adxOverride && rsi !== null && rsi > Config.BREAKOUT_RSI_MAX_LONG) {
        this.logger.info(`🔥 ADX override: RSI ${rsi.toFixed(1)} is overbought but ADX ${adx.toFixed(1)} > ${ADX_OVERRIDE_THRESHOLD} confirms strong trend - allowing entry`);
      }

      // FRESHNESS FILTER 2: Distance from breakout level
      // Don't enter if price has already moved too far from the breakout level
      const distanceFromBreakout = currentPrice - this.previousHigh;
      const maxDistance = Config.pipsToPrice(Config.BREAKOUT_MAX_DISTANCE_FROM_LEVEL);
      if (signal && distanceFromBreakout > maxDistance) {
        filters.push(`Price $${distanceFromBreakout.toFixed(2)} above breakout level (max $${maxDistance.toFixed(2)})`);
        signal = null;
      }

      // FRESHNESS FILTER 3: Candle position check
      // For longs, price should be in upper portion of candle (not sold off)
      const candleRange = lastCandle.high - lastCandle.low;
      const pricePosition = candleRange > 0 ? (currentPrice - lastCandle.low) / candleRange : 0.5;
      if (signal && pricePosition < Config.BREAKOUT_MIN_CANDLE_POSITION) {
        filters.push(`Price in lower ${((1 - pricePosition) * 100).toFixed(0)}% of candle (move fading)`);
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
      reason = `Bearish breakout: Price $${currentPrice.toFixed(2)} broke below ${Config.BREAKOUT_LOOKBACK}-bar low $${this.previousLow.toFixed(2)}`;

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

      // FRESHNESS FILTER 1: RSI oversold check
      // Don't sell into an oversold market - the move may be exhausted
      // EXCEPTION: If ADX > 35 (strong trend), trust the momentum and ignore oversold RSI
      const rsi = analysis.indicators.rsi;
      const ADX_OVERRIDE_THRESHOLD = 35;
      const adxOverride = adx !== null && adx > ADX_OVERRIDE_THRESHOLD;
      if (signal && rsi !== null && rsi < Config.BREAKOUT_RSI_MIN_SHORT && !adxOverride) {
        filters.push(`RSI ${rsi.toFixed(1)} < ${Config.BREAKOUT_RSI_MIN_SHORT} (oversold - move exhausted)`);
        signal = null;
      }
      if (signal && adxOverride && rsi !== null && rsi < Config.BREAKOUT_RSI_MIN_SHORT) {
        this.logger.info(`🔥 ADX override: RSI ${rsi.toFixed(1)} is oversold but ADX ${adx.toFixed(1)} > ${ADX_OVERRIDE_THRESHOLD} confirms strong trend - allowing entry`);
      }

      // FRESHNESS FILTER 2: Distance from breakout level
      // Don't enter if price has already moved too far from the breakout level
      const distanceFromBreakout = this.previousLow - currentPrice;
      const maxDistance = Config.pipsToPrice(Config.BREAKOUT_MAX_DISTANCE_FROM_LEVEL);
      if (signal && distanceFromBreakout > maxDistance) {
        filters.push(`Price $${distanceFromBreakout.toFixed(2)} below breakout level (max $${maxDistance.toFixed(2)})`);
        signal = null;
      }

      // FRESHNESS FILTER 3: Candle position check
      // For shorts, price should be in lower portion of candle (not bounced)
      const candleRange = lastCandle.high - lastCandle.low;
      const pricePosition = candleRange > 0 ? (currentPrice - lastCandle.low) / candleRange : 0.5;
      if (signal && pricePosition > (1 - Config.BREAKOUT_MIN_CANDLE_POSITION)) {
        filters.push(`Price in upper ${(pricePosition * 100).toFixed(0)}% of candle (move fading)`);
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
      // No breakout - check for trend continuation opportunity
      if (Config.ENABLE_TREND_CONTINUATION && this.lastSignal && adx !== null && adx >= Config.TREND_CONTINUATION_ADX_MIN) {
        // Calculate EMA for pullback detection
        const closes = candles.map(c => c.close);
        const ema = this.calculateEMA(closes, Config.TREND_CONTINUATION_PULLBACK_EMA);

        if (ema) {
          const isLong = this.lastSignal === 'LONG';
          const emaTolerance = 2.0; // Allow $2 tolerance around EMA

          // Check if price pulled back to EMA
          const nearEMA = Math.abs(currentPrice - ema) <= emaTolerance;
          // For longs: price should be bouncing off EMA from above or at EMA with bullish candle
          // For shorts: price should be rejecting from EMA from below or at EMA with bearish candle
          const validPullback = isLong
            ? (nearEMA && isBullishCandle && currentPrice >= ema - emaTolerance)
            : (nearEMA && isBearishCandle && currentPrice <= ema + emaTolerance);

          if (validPullback) {
            signal = this.lastSignal;
            reason = `Trend continuation: ${signal} pullback to EMA${Config.TREND_CONTINUATION_PULLBACK_EMA} ($${ema.toFixed(2)}), ADX ${adx.toFixed(1)} confirms strong trend`;
            confidence = 70; // Slightly lower confidence than fresh breakout

            this.logger.info(`🔄 Trend continuation signal: ${signal} @ $${currentPrice.toFixed(2)} (pullback to EMA${Config.TREND_CONTINUATION_PULLBACK_EMA})`);
          } else {
            reason = `No breakout. Channel: $${channel.low.toFixed(2)} - $${channel.high.toFixed(2)}, Price: $${currentPrice.toFixed(2)}`;
          }
        } else {
          reason = `No breakout. Channel: $${channel.low.toFixed(2)} - $${channel.high.toFixed(2)}, Price: $${currentPrice.toFixed(2)}`;
        }
      } else {
        reason = `No breakout. Channel: $${channel.low.toFixed(2)} - $${channel.high.toFixed(2)}, Price: $${currentPrice.toFixed(2)}`;
      }
    }

    // If breakout detected but filtered out
    if ((bullishBreakout || bearishBreakout) && signal === null && filters.length > 0) {
      reason += ` - FILTERED: ${filters.join(', ')}`;
    }

    // Store current values and persist state
    this.previousHigh = channel.high;
    this.previousLow = channel.low;
    this.lastCandleTime = currentCandleTime;

    // Handle MTF mode
    if (signal && Config.ENABLE_MTF) {
      // Store as pending signal, wait for H1 entry
      this.pendingSignal = signal;
      this.pendingSignalTime = currentCandleTime;
      this.pendingBreakoutPrice = currentPrice;
      this.h1CandlesChecked = 0;
      this.saveState();

      this.logger.info(`🔔 H4 Breakout detected: ${signal} @ $${currentPrice.toFixed(2)}`);
      this.logger.info(`   Waiting for H1 pullback entry (max ${Config.MTF_MAX_WAIT_CANDLES} candles)...`);

      // Check H1 immediately if we have data
      if (h1Candles) {
        const h1Entry = this.evaluateH1Entry(h1Candles);
        if (h1Entry) {
          return h1Entry;
        }
      }

      return {
        signal: null,
        reason: `H4 ${signal} breakout detected, waiting for H1 pullback entry`,
        confidence: 0,
        pendingSignal: signal,
        channelHigh: channel.high,
        channelLow: channel.low
      };
    }

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
   * Now accepts optional entryPrice for MTF refined entries
   */
  calculateEntryLevels(analysis, signal, mtfEntryPrice = null) {
    const entryPrice = mtfEntryPrice || analysis.indicators.price;
    const isLong = signal === 'LONG';

    // Stop Loss - use wider SL for breakout trades to survive post-breakout volatility
    // For LONG: SL below entry, For SHORT: SL above entry (same distance, opposite direction)
    const stopPips = Config.BREAKOUT_STOP_LOSS_PIPS;
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
      riskPips: riskPips.toFixed(1),
      mtfEntry: mtfEntryPrice ? 'YES' : 'NO'
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
    let tpDesc;
    if (Config.TRAILING_ONLY) {
      tpDesc = `Take Profit: NONE (Trail ${Config.TRAILING_STOP_DISTANCE_PIPS} pips only - let winners run!)`;
    } else if (Config.ENABLE_STAGED_TP) {
      tpDesc = `Take Profit: ${Config.TAKE_PROFIT_1_RR}R (60%) / ${Config.TAKE_PROFIT_2_RR}R (40%)`;
    } else {
      tpDesc = `Take Profit: Single ${Config.TAKE_PROFIT_RR}R`;
    }

    let mtfDesc = '';
    if (Config.ENABLE_MTF) {
      mtfDesc = `
      MTF Entry: Wait for ${Config.MTF_ENTRY_TIMEFRAME} pullback to EMA${Config.MTF_EMA_PERIOD}
      Pullback Target: ${Config.MTF_PULLBACK_PIPS} pips ($${(Config.MTF_PULLBACK_PIPS * 0.01).toFixed(2)})
      Max Wait: ${Config.MTF_MAX_WAIT_CANDLES} ${Config.MTF_ENTRY_TIMEFRAME} candles`;
    }

    let trendContDesc = '';
    if (Config.ENABLE_TREND_CONTINUATION) {
      trendContDesc = `
      Trend Continuation: Re-enter on pullback to EMA${Config.TREND_CONTINUATION_PULLBACK_EMA} when ADX > ${Config.TREND_CONTINUATION_ADX_MIN}`;
    }

    const freshnessDesc = `
      Freshness Filters:
      - RSI: Block LONG if > ${Config.BREAKOUT_RSI_MAX_LONG}, SHORT if < ${Config.BREAKOUT_RSI_MIN_SHORT}
      - Max distance from breakout: $${Config.pipsToPrice(Config.BREAKOUT_MAX_DISTANCE_FROM_LEVEL).toFixed(2)}
      - Min candle position: ${(Config.BREAKOUT_MIN_CANDLE_POSITION * 100).toFixed(0)}%`;

    return `
      ${this.name}

      Primary Timeframe: ${Config.TIMEFRAME} (${Config.TIMEFRAME === 'H1' ? '24' : '6'} signals/day)
      Direction: Price breaks ${Config.BREAKOUT_LOOKBACK}-bar high/low (Donchian Channel)
      Filter: ADX > ${ADX_MIN} (trending market)
      Confirmation: Bullish candle for longs, bearish for shorts${mtfDesc}${trendContDesc}${freshnessDesc}
      Stop Loss: ${Config.BREAKOUT_STOP_LOSS_PIPS} pips ($${(Config.BREAKOUT_STOP_LOSS_PIPS * 0.01).toFixed(2)})
      ${tpDesc}
      Order Retry: ${Config.ENABLE_ORDER_RETRY ? 'Enabled' : 'Disabled'}

      ${Config.ENABLE_MTF ? `Multi-timeframe breakout with ${Config.MTF_ENTRY_TIMEFRAME} entry timing` : 'Trend-following breakout with ADX confirmation'}
    `.trim();
  }
}

export default BreakoutADXStrategy;
