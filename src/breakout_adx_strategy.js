/**
 * Breakout + ADX Strategy with Multi-Timeframe (MTF) Support
 *
 * Entry Rules (Primary Timeframe - configurable via TIMEFRAME env var):
 * - LONG: Price breaks ABOVE N-bar high (Donchian Channel)
 *         + ADX > 20 (trending market confirmation)
 *         + Bullish candle (close > open)
 * - SHORT: Price breaks BELOW N-bar low (Donchian Channel)
 *          + ADX > 20 (trending market confirmation)
 *          + Bearish candle (close < open)
 *
 * MTF Entry Refinement (Entry Timeframe - configurable via MTF_ENTRY_TIMEFRAME):
 * - After primary breakout, wait for entry TF pullback to EMA20 or pullback target
 * - Enter on entry TF confirmation candle (bullish for longs, bearish for shorts)
 * - Better entry = tighter stop loss = higher win rate
 *
 * Common configurations:
 * - H4 primary + H1 entry: Swing trading (6 signals/day max)
 * - H1 primary + M15 entry: Active trading (24 signals/day max)
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
      ? `Breakout + ADX MTF (${Config.TIMEFRAME}→${Config.MTF_ENTRY_TIMEFRAME})`
      : `Breakout + ADX (${Config.BREAKOUT_LOOKBACK}-bar)`;
    this.lastCandleTime = null;
    this.lastSignal = null;
    this.previousHigh = null;
    this.previousLow = null;

    // MTF state
    this.pendingSignal = null;  // Stores primary TF breakout waiting for entry TF confirmation
    this.pendingSignalTime = null;
    this.pendingBreakoutPrice = null;
    this.h1CandlesChecked = 0;

    // Real-time breakout tracking (detects breakouts between candle closes)
    this.realtimeBreakoutDirection = null;  // 'LONG' or 'SHORT'
    this.realtimeBreakoutTime = null;       // When breakout first detected (timestamp)
    this.realtimeBreakoutPrice = null;      // Price at first detection
    this.realtimeBreakoutLevel = null;      // Channel level that was broken

    // Real-time MTF pending signal (waits for pullback after confirmed breakout)
    this.realtimeMTFPending = null;         // 'LONG' or 'SHORT'
    this.realtimeMTFBreakoutPrice = null;   // Price at breakout confirmation
    this.realtimeMTFTime = null;            // When breakout was confirmed
    this.realtimeMTFBestPullback = null;    // Best pullback price seen (lowest for LONG, highest for SHORT)

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
        // Real-time breakout tracking
        realtimeBreakoutDirection: this.realtimeBreakoutDirection,
        realtimeBreakoutTime: this.realtimeBreakoutTime,
        realtimeBreakoutPrice: this.realtimeBreakoutPrice,
        realtimeBreakoutLevel: this.realtimeBreakoutLevel,
        // Real-time MTF pending signal
        realtimeMTFPending: this.realtimeMTFPending,
        realtimeMTFBreakoutPrice: this.realtimeMTFBreakoutPrice,
        realtimeMTFTime: this.realtimeMTFTime,
        realtimeMTFBestPullback: this.realtimeMTFBestPullback,
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
      // Real-time breakout tracking
      this.realtimeBreakoutDirection = state.realtimeBreakoutDirection || null;
      this.realtimeBreakoutTime = state.realtimeBreakoutTime || null;
      this.realtimeBreakoutPrice = state.realtimeBreakoutPrice || null;
      this.realtimeBreakoutLevel = state.realtimeBreakoutLevel || null;

      // Real-time MTF pending signal
      this.realtimeMTFPending = state.realtimeMTFPending || null;
      this.realtimeMTFBreakoutPrice = state.realtimeMTFBreakoutPrice || null;
      this.realtimeMTFTime = state.realtimeMTFTime || null;
      this.realtimeMTFBestPullback = state.realtimeMTFBestPullback || null;

      this.logger.info(`📂 Loaded Breakout+ADX state: High=$${this.previousHigh?.toFixed(2) || 'null'}, Low=$${this.previousLow?.toFixed(2) || 'null'}`);
      if (this.pendingSignal) {
        this.logger.info(`📂 Pending ${this.pendingSignal} signal from candle-based breakout at $${this.pendingBreakoutPrice?.toFixed(2)}`);
      }
      if (this.realtimeMTFPending) {
        this.logger.info(`📂 Pending ${this.realtimeMTFPending} signal from realtime MTF at $${this.realtimeMTFBreakoutPrice?.toFixed(2)}, waiting for pullback`);
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
      // Check we're not chasing - entry should be near or better than breakout price
      const maxOvershoot = 1.00; // Allow $1.00 tolerance past breakout
      const chasingMove = isLong
        ? entryPrice > breakoutPrice + maxOvershoot
        : entryPrice < breakoutPrice - maxOvershoot;

      if (chasingMove) {
        const overshoot = isLong
          ? entryPrice - breakoutPrice
          : breakoutPrice - entryPrice;
        this.logger.info(`❌ MTF Entry rejected - price $${entryPrice.toFixed(2)} is $${overshoot.toFixed(2)} past breakout $${breakoutPrice.toFixed(2)} (chasing move)`);
        // Don't clear pending - next candle might be better
        return null;
      }

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
      // EXCEPTION: If ADX > 40 (very strong trend), bypass candle confirmation
      const CANDLE_ADX_OVERRIDE = 40;
      const candleAdxOverride = adx !== null && adx > CANDLE_ADX_OVERRIDE;
      if (signal && !isBullishCandle && !candleAdxOverride) {
        filters.push(`Bearish candle (need bullish confirmation)`);
        signal = null;
      }
      if (signal && !isBullishCandle && candleAdxOverride) {
        this.logger.info(`🔥 ADX override: Bearish candle but ADX ${adx.toFixed(1)} > ${CANDLE_ADX_OVERRIDE} confirms strong trend - allowing LONG entry`);
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
      // EXCEPTION: If ADX > 40 (very strong trend), bypass candle confirmation
      const CANDLE_ADX_OVERRIDE = 40;
      const candleAdxOverride = adx !== null && adx > CANDLE_ADX_OVERRIDE;
      if (signal && !isBearishCandle && !candleAdxOverride) {
        filters.push(`Bullish candle (need bearish confirmation)`);
        signal = null;
      }
      if (signal && !isBearishCandle && candleAdxOverride) {
        this.logger.info(`🔥 ADX override: Bullish candle but ADX ${adx.toFixed(1)} > ${CANDLE_ADX_OVERRIDE} confirms strong trend - allowing SHORT entry`);
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
   * Clear real-time breakout tracking
   */
  clearRealtimeBreakout() {
    this.realtimeBreakoutDirection = null;
    this.realtimeBreakoutTime = null;
    this.realtimeBreakoutPrice = null;
    this.realtimeBreakoutLevel = null;
    this.saveState();
  }

  /**
   * Clear real-time MTF pending signal
   */
  clearRealtimeMTF() {
    this.realtimeMTFPending = null;
    this.realtimeMTFBreakoutPrice = null;
    this.realtimeMTFTime = null;
    this.realtimeMTFBestPullback = null;
    this.saveState();
  }

  /**
   * Check if there's a pending realtime MTF signal waiting for pullback entry
   * @returns {boolean}
   */
  hasRealtimeMTFPending() {
    return this.realtimeMTFPending !== null;
  }

  /**
   * Check for realtime MTF entry (pullback after confirmed breakout)
   * Called every 30 seconds when there's a pending MTF signal
   *
   * @param {number} currentPrice - Current market price
   * @returns {Object} { signal: 'LONG'|'SHORT'|null, reason, confidence, entryPrice }
   */
  checkRealtimeMTFEntry(currentPrice) {
    if (!this.realtimeMTFPending) {
      return { signal: null, reason: 'No pending MTF signal', confidence: 0 };
    }

    const isLong = this.realtimeMTFPending === 'LONG';
    const breakoutPrice = this.realtimeMTFBreakoutPrice;
    const pullbackTarget = Config.pipsToPrice(Config.MTF_PULLBACK_PIPS);
    const maxWaitMs = Config.MTF_MAX_WAIT_CANDLES * 15 * 60 * 1000; // Convert candles to ms (assuming M15)

    // Check timeout (2 hours default = 8 M15 candles)
    const elapsed = Date.now() - this.realtimeMTFTime;
    if (elapsed > maxWaitMs) {
      this.logger.info(`⏰ Realtime MTF timeout: No pullback entry after ${Math.round(elapsed / 60000)} minutes, canceling ${this.realtimeMTFPending}`);
      this.clearRealtimeMTF();
      return { signal: null, reason: 'MTF timeout - no pullback entry found', confidence: 0 };
    }

    // Track best pullback (lowest for LONG, highest for SHORT)
    if (this.realtimeMTFBestPullback === null) {
      this.realtimeMTFBestPullback = currentPrice;
    } else if (isLong && currentPrice < this.realtimeMTFBestPullback) {
      this.realtimeMTFBestPullback = currentPrice;
    } else if (!isLong && currentPrice > this.realtimeMTFBestPullback) {
      this.realtimeMTFBestPullback = currentPrice;
    }

    // Calculate pullback from breakout price
    const pullbackAmount = isLong
      ? breakoutPrice - this.realtimeMTFBestPullback
      : this.realtimeMTFBestPullback - breakoutPrice;

    // Check if we've had enough pullback
    if (pullbackAmount < pullbackTarget) {
      const remaining = (pullbackTarget - pullbackAmount).toFixed(2);
      return {
        signal: null,
        pending: true,
        reason: `Waiting for pullback: best=$${this.realtimeMTFBestPullback.toFixed(2)}, need $${remaining} more pullback`,
        confidence: 0
      };
    }

    // We've had enough pullback - now check if price is moving back in our direction
    // For LONG: current price should be above best pullback (bouncing up)
    // For SHORT: current price should be below best pullback (falling again)
    const movingFavorably = isLong
      ? currentPrice > this.realtimeMTFBestPullback + 0.50  // $0.50 bounce for LONG
      : currentPrice < this.realtimeMTFBestPullback - 0.50; // $0.50 drop for SHORT

    if (!movingFavorably) {
      return {
        signal: null,
        pending: true,
        reason: `Pullback detected ($${pullbackAmount.toFixed(2)}), waiting for price to move favorably`,
        confidence: 0
      };
    }

    // Entry conditions met - but check we're not chasing the move
    // The whole point of MTF pullback is a BETTER entry than the breakout price
    // If price has run past the breakout, the pullback didn't give us an edge - skip it
    const maxOvershoot = 1.00; // Allow $1.00 tolerance past breakout
    const chasingMove = isLong
      ? currentPrice > breakoutPrice + maxOvershoot
      : currentPrice < breakoutPrice - maxOvershoot;

    if (chasingMove) {
      const overshoot = isLong
        ? currentPrice - breakoutPrice
        : breakoutPrice - currentPrice;
      this.logger.info(`❌ Realtime MTF: Entry rejected - price $${currentPrice.toFixed(2)} is $${overshoot.toFixed(2)} past breakout $${breakoutPrice.toFixed(2)} (chasing move, max $${maxOvershoot.toFixed(2)} overshoot)`);
      // Don't clear pending - price might pull back again for a better entry
      return {
        signal: null,
        pending: true,
        reason: `Entry rejected - chasing move ($${overshoot.toFixed(2)} past breakout, max $${maxOvershoot.toFixed(2)})`,
        confidence: 0
      };
    }

    const improvement = isLong
      ? breakoutPrice - currentPrice
      : currentPrice - breakoutPrice;

    this.logger.info(`✅ Realtime MTF Entry Found! ${this.realtimeMTFPending} @ $${currentPrice.toFixed(2)}`);
    this.logger.info(`   Breakout was at $${breakoutPrice.toFixed(2)}, pullback to $${this.realtimeMTFBestPullback.toFixed(2)}`);
    this.logger.info(`   Entry improvement: $${improvement.toFixed(2)} better than immediate entry`);

    const signal = this.realtimeMTFPending;
    const reason = `Realtime MTF ${signal}: Breakout at $${breakoutPrice.toFixed(2)}, pullback to $${this.realtimeMTFBestPullback.toFixed(2)}, entry at $${currentPrice.toFixed(2)} (improved by $${improvement.toFixed(2)})`;

    // Clear pending signal
    this.clearRealtimeMTF();

    return {
      signal,
      reason,
      confidence: 70, // Slightly higher confidence due to better entry
      entryPrice: currentPrice,
      isRealtimeMTF: true
    };
  }

  /**
   * Check for real-time breakout (called every 30 seconds between candle closes)
   * Detects breakouts as they happen, with 60-second confirmation to filter wicks
   *
   * @param {number} currentPrice - Current market price
   * @param {number} adx - Current ADX value
   * @param {number} rsi - Current RSI value
   * @returns {Object} { signal: 'LONG'|'SHORT'|null, reason, confidence, pending?, isRealtime? }
   */
  checkRealtimeBreakout(currentPrice, adx, rsi) {
    // Need channel values from previous candle close
    if (this.previousHigh === null || this.previousLow === null) {
      return {
        signal: null,
        reason: 'No channel data yet - waiting for candle close',
        confidence: 0
      };
    }

    const now = Date.now();
    const confirmationMs = Config.BREAKOUT_CONFIRMATION_SECONDS * 1000;

    // Check if price is breaking the channel
    const bullishBreakout = currentPrice > this.previousHigh;
    const bearishBreakout = currentPrice < this.previousLow;

    // No breakout - clear any pending tracking
    if (!bullishBreakout && !bearishBreakout) {
      if (this.realtimeBreakoutDirection) {
        this.logger.info(`🔄 Realtime: Price back inside channel ($${this.previousLow.toFixed(2)} - $${this.previousHigh.toFixed(2)}) - wick filtered`);
        this.clearRealtimeBreakout();
      }
      return {
        signal: null,
        reason: `No breakout. Price $${currentPrice.toFixed(2)} inside channel $${this.previousLow.toFixed(2)} - $${this.previousHigh.toFixed(2)}`,
        confidence: 0
      };
    }

    // Determine breakout direction
    const direction = bullishBreakout ? 'LONG' : 'SHORT';
    const breakoutLevel = bullishBreakout ? this.previousHigh : this.previousLow;
    const distanceFromLevel = bullishBreakout
      ? currentPrice - this.previousHigh
      : this.previousLow - currentPrice;

    // First detection of this breakout?
    if (!this.realtimeBreakoutDirection || this.realtimeBreakoutDirection !== direction) {
      // New breakout or direction changed - start tracking
      this.realtimeBreakoutDirection = direction;
      this.realtimeBreakoutTime = now;
      this.realtimeBreakoutPrice = currentPrice;
      this.realtimeBreakoutLevel = breakoutLevel;
      this.saveState();

      this.logger.info(`⚡ Realtime: ${direction} breakout detected! Price $${currentPrice.toFixed(2)} broke ${direction === 'LONG' ? 'above' : 'below'} $${breakoutLevel.toFixed(2)}`);
      this.logger.info(`   Waiting ${Config.BREAKOUT_CONFIRMATION_SECONDS}s for confirmation...`);

      return {
        signal: null,
        pending: true,
        direction,
        reason: `${direction} breakout detected, waiting ${Config.BREAKOUT_CONFIRMATION_SECONDS}s for confirmation`,
        confidence: 0
      };
    }

    // Already tracking this breakout - check if confirmation period elapsed
    const elapsedMs = now - this.realtimeBreakoutTime;
    const elapsedSec = Math.round(elapsedMs / 1000);

    if (elapsedMs < confirmationMs) {
      // Still waiting for confirmation
      const remainingSec = Math.round((confirmationMs - elapsedMs) / 1000);
      return {
        signal: null,
        pending: true,
        direction,
        reason: `${direction} breakout pending confirmation (${remainingSec}s remaining)`,
        confidence: 0
      };
    }

    // Confirmation period elapsed - price held below/above channel
    this.logger.info(`✅ Realtime: ${direction} breakout CONFIRMED after ${elapsedSec}s!`);
    this.logger.info(`   Initial break: $${this.realtimeBreakoutPrice.toFixed(2)}, Current: $${currentPrice.toFixed(2)}`);

    // Apply filters
    const filters = [];

    // MOMENTUM FILTER: Check if price is still moving in breakout direction
    // If price is already reversing during confirmation period, it's a fakeout
    // For LONG: confirmation price should be >= initial break price (not falling back)
    // For SHORT: confirmation price should be <= initial break price (not bouncing)
    const momentumValid = direction === 'LONG'
      ? currentPrice >= this.realtimeBreakoutPrice
      : currentPrice <= this.realtimeBreakoutPrice;

    if (!momentumValid) {
      const diff = direction === 'LONG'
        ? this.realtimeBreakoutPrice - currentPrice
        : currentPrice - this.realtimeBreakoutPrice;
      filters.push(`Momentum fading: Price reversed $${diff.toFixed(2)} during confirmation (fakeout)`);
    }

    // ADX filter
    if (adx !== null && adx < ADX_MIN) {
      filters.push(`ADX ${adx.toFixed(1)} < ${ADX_MIN} (ranging market)`);
    }

    // RSI filter (with ADX override)
    const ADX_OVERRIDE_THRESHOLD = 35;
    const adxOverride = adx !== null && adx > ADX_OVERRIDE_THRESHOLD;

    if (direction === 'LONG' && rsi !== null && rsi > Config.BREAKOUT_RSI_MAX_LONG && !adxOverride) {
      filters.push(`RSI ${rsi.toFixed(1)} > ${Config.BREAKOUT_RSI_MAX_LONG} (overbought)`);
    }
    if (direction === 'SHORT' && rsi !== null && rsi < Config.BREAKOUT_RSI_MIN_SHORT && !adxOverride) {
      filters.push(`RSI ${rsi.toFixed(1)} < ${Config.BREAKOUT_RSI_MIN_SHORT} (oversold)`);
    }

    // Distance filter
    const maxDistance = Config.pipsToPrice(Config.BREAKOUT_MAX_DISTANCE_FROM_LEVEL);
    if (distanceFromLevel > maxDistance) {
      filters.push(`Price $${distanceFromLevel.toFixed(2)} from breakout level (max $${maxDistance.toFixed(2)})`);
    }

    // If any filters failed, reject
    if (filters.length > 0) {
      this.logger.info(`❌ Realtime: Breakout filtered - ${filters.join(', ')}`);
      this.clearRealtimeBreakout();
      return {
        signal: null,
        reason: `${direction} breakout confirmed but filtered: ${filters.join(', ')}`,
        confidence: 0
      };
    }

    // All filters passed - breakout confirmed!
    // Clear breakout tracking (confirmation consumed)
    this.clearRealtimeBreakout();

    // Update lastSignal for trend continuation
    this.lastSignal = direction;

    // If MTF is enabled, store as pending signal and wait for pullback
    if (Config.ENABLE_MTF) {
      this.realtimeMTFPending = direction;
      this.realtimeMTFBreakoutPrice = currentPrice;
      this.realtimeMTFTime = Date.now();
      this.realtimeMTFBestPullback = currentPrice; // Start tracking from current price
      this.saveState();

      this.logger.info(`🔔 Realtime ${direction} breakout CONFIRMED at $${currentPrice.toFixed(2)}`);
      this.logger.info(`   Waiting for pullback of $${Config.pipsToPrice(Config.MTF_PULLBACK_PIPS).toFixed(2)} before entry...`);
      this.logger.info(`   Max wait: ${Config.MTF_MAX_WAIT_CANDLES * 15} minutes (${Config.MTF_MAX_WAIT_CANDLES} M15 candles)`);

      return {
        signal: null,
        pendingMTF: true,
        direction,
        reason: `Realtime ${direction} breakout confirmed, waiting for pullback entry`,
        confidence: 0
      };
    }

    // MTF disabled - generate signal immediately (old behavior)
    let confidence = 60; // Base confidence for realtime breakout
    if (adx !== null && adx > 25) confidence += 10;
    if (adx !== null && adx > 30) confidence += 10;
    if (distanceFromLevel > 2) confidence += 5;

    const reason = `Realtime ${direction} breakout: Price $${currentPrice.toFixed(2)} broke ${direction === 'LONG' ? 'above' : 'below'} $${breakoutLevel.toFixed(2)}, confirmed after ${elapsedSec}s, ADX ${adx?.toFixed(1) || 'N/A'}`;

    this.logger.info(`🎯 Realtime: SIGNAL GENERATED - ${direction} @ $${currentPrice.toFixed(2)}`);

    return {
      signal: direction,
      reason,
      confidence,
      entryPrice: currentPrice,
      isRealtime: true
    };
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
