/**
 * Technical Analysis Engine
 * Calculates indicators (EMA, RSI, ADX) and identifies patterns
 */
import { EMA, RSI, ADX } from 'technicalindicators';
import Config from './config.js';

class TechnicalAnalysis {
  constructor(logger) {
    this.logger = logger;
  }

  /**
   * Calculate Exponential Moving Average
   */
  calculateEMA(candles, period) {
    const closes = candles.map(c => c.close);
    const emaValues = EMA.calculate({
      period,
      values: closes
    });

    // Pad with nulls to match candles length
    const padding = new Array(candles.length - emaValues.length).fill(null);
    return [...padding, ...emaValues];
  }

  /**
   * Calculate RSI
   */
  calculateRSI(candles, period = Config.RSI_PERIOD) {
    const closes = candles.map(c => c.close);
    const rsiValues = RSI.calculate({
      period,
      values: closes
    });

    // Pad with nulls to match candles length
    const padding = new Array(candles.length - rsiValues.length).fill(null);
    return [...padding, ...rsiValues];
  }

  /**
   * Calculate ADX (Average Directional Index) - measures trend strength
   * ADX > 25 = strong trend (good for trend-following strategies)
   * ADX < 20 = weak trend / ranging market (avoid trend-following)
   */
  calculateADX(candles, period = 14) {
    const highs = candles.map(c => c.high);
    const lows = candles.map(c => c.low);
    const closes = candles.map(c => c.close);

    const adxValues = ADX.calculate({
      period,
      high: highs,
      low: lows,
      close: closes
    });

    // Pad with nulls to match candles length
    const padding = new Array(candles.length - adxValues.length).fill(null);
    return [...padding, ...adxValues];
  }

  /**
   * Get latest indicator values
   */
  getLatestIndicators(candles) {
    const emaFast = this.calculateEMA(candles, Config.EMA_FAST);
    const emaSlow = this.calculateEMA(candles, Config.EMA_SLOW);
    const rsi = this.calculateRSI(candles, Config.RSI_PERIOD);
    const adx = this.calculateADX(candles, 14);

    const lastCandle = candles[candles.length - 1];
    const lastEmaFast = emaFast[emaFast.length - 1];
    const lastEmaSlow = emaSlow[emaSlow.length - 1];
    const lastRSI = rsi[rsi.length - 1];
    const lastADX = adx[adx.length - 1];

    return {
      price: lastCandle.close,
      emaFast: lastEmaFast,
      emaSlow: lastEmaSlow,
      rsi: lastRSI,
      adx: lastADX ? lastADX.adx : null, // ADX returns object with {adx, pdi, mdi}
      pdi: lastADX ? lastADX.pdi : null, // +DI (bullish directional indicator)
      mdi: lastADX ? lastADX.mdi : null, // -DI (bearish directional indicator)
      time: lastCandle.time
    };
  }

  /**
   * Identify trend based on EMA alignment
   * Returns: 'BULLISH', 'BEARISH', or 'NEUTRAL'
   */
  identifyTrend(candles) {
    const indicators = this.getLatestIndicators(candles);
    const { price, emaFast, emaSlow } = indicators;

    // BULLISH: Price > EMA20 AND EMA20 > EMA50
    if (price > emaFast && emaFast > emaSlow) {
      return 'BULLISH';
    }

    // BEARISH: Price < EMA20 AND EMA20 < EMA50
    if (price < emaFast && emaFast < emaSlow) {
      return 'BEARISH';
    }

    // NEUTRAL: EMAs are tangled
    return 'NEUTRAL';
  }

  /**
   * Check if RSI is in valid range for the trend
   */
  isRSIValid(rsi, trend) {
    if (trend === 'BULLISH') {
      return rsi >= Config.RSI_BULLISH_MIN && rsi <= Config.RSI_BULLISH_MAX;
    } else if (trend === 'BEARISH') {
      return rsi >= Config.RSI_BEARISH_MIN && rsi <= Config.RSI_BEARISH_MAX;
    }
    return false;
  }

  /**
   * Identify candlestick patterns
   * Returns: 'BULLISH_ENGULFING', 'BEARISH_ENGULFING', 'HAMMER', 'SHOOTING_STAR', or null
   */
  identifyCandlestickPattern(candles) {
    if (candles.length < 2) return null;

    const current = candles[candles.length - 1];
    const previous = candles[candles.length - 2];

    // Bullish Engulfing: Green candle fully engulfs previous red candle
    if (
      previous.close < previous.open && // Previous was red
      current.close > current.open && // Current is green
      current.open < previous.close && // Opens below previous close
      current.close > previous.open // Closes above previous open
    ) {
      return 'BULLISH_ENGULFING';
    }

    // Bearish Engulfing: Red candle fully engulfs previous green candle
    if (
      previous.close > previous.open && // Previous was green
      current.close < current.open && // Current is red
      current.open > previous.close && // Opens above previous close
      current.close < previous.open // Closes below previous open
    ) {
      return 'BEARISH_ENGULFING';
    }

    // Hammer: Small body at top, long lower wick (bullish)
    const body = Math.abs(current.close - current.open);
    const range = current.high - current.low;
    const lowerWick = Math.min(current.open, current.close) - current.low;
    const upperWick = current.high - Math.max(current.open, current.close);

    if (
      range > 0 &&
      lowerWick > body * 2 && // Lower wick at least 2x body
      upperWick < body * 0.5 && // Small upper wick
      body < range * 0.3 // Small body relative to range
    ) {
      return 'HAMMER';
    }

    // Shooting Star: Small body at bottom, long upper wick (bearish)
    if (
      range > 0 &&
      upperWick > body * 2 && // Upper wick at least 2x body
      lowerWick < body * 0.5 && // Small lower wick
      body < range * 0.3 // Small body relative to range
    ) {
      return 'SHOOTING_STAR';
    }

    return null;
  }

  /**
   * Identify support and resistance levels
   * Uses swing highs/lows from recent candles
   */
  identifySupportResistance(candles, lookback = 50) {
    const recentCandles = candles.slice(-lookback);
    const swingHighs = [];
    const swingLows = [];

    // Find swing points (local highs and lows)
    for (let i = 2; i < recentCandles.length - 2; i++) {
      const candle = recentCandles[i];
      const prev1 = recentCandles[i - 1];
      const prev2 = recentCandles[i - 2];
      const next1 = recentCandles[i + 1];
      const next2 = recentCandles[i + 2];

      // Swing High: higher than 2 candles before and after
      if (
        candle.high > prev1.high &&
        candle.high > prev2.high &&
        candle.high > next1.high &&
        candle.high > next2.high
      ) {
        swingHighs.push(candle.high);
      }

      // Swing Low: lower than 2 candles before and after
      if (
        candle.low < prev1.low &&
        candle.low < prev2.low &&
        candle.low < next1.low &&
        candle.low < next2.low
      ) {
        swingLows.push(candle.low);
      }
    }

    // Cluster similar levels (within 0.2% of each other)
    const clusterLevels = (levels, threshold = 0.002) => {
      if (levels.length === 0) return [];

      const sorted = levels.sort((a, b) => a - b);
      const clusters = [];
      let currentCluster = [sorted[0]];

      for (let i = 1; i < sorted.length; i++) {
        const diff = Math.abs(sorted[i] - currentCluster[0]) / currentCluster[0];
        if (diff <= threshold) {
          currentCluster.push(sorted[i]);
        } else {
          const avg = currentCluster.reduce((sum, val) => sum + val, 0) / currentCluster.length;
          clusters.push(avg);
          currentCluster = [sorted[i]];
        }
      }

      // Add last cluster
      if (currentCluster.length > 0) {
        const avg = currentCluster.reduce((sum, val) => sum + val, 0) / currentCluster.length;
        clusters.push(avg);
      }

      return clusters;
    };

    const resistanceLevels = clusterLevels(swingHighs)
      .sort((a, b) => b - a)
      .slice(0, 3); // Top 3 resistance levels

    const supportLevels = clusterLevels(swingLows)
      .sort((a, b) => b - a)
      .slice(0, 3); // Top 3 support levels

    return {
      resistance: resistanceLevels,
      support: supportLevels
    };
  }

  /**
   * Check if price is near support or resistance
   */
  isNearLevel(price, level, threshold = 0.002) {
    const diff = Math.abs(price - level) / level;
    return diff <= threshold; // Within 0.2%
  }

  /**
   * Complete market analysis
   * Returns everything needed for strategy decisions
   */
  analyze(candles) {
    try {
      const indicators = this.getLatestIndicators(candles);
      const trend = this.identifyTrend(candles);
      const pattern = this.identifyCandlestickPattern(candles);
      const levels = this.identifySupportResistance(candles);
      const rsiValid = this.isRSIValid(indicators.rsi, trend);

      // Find nearest support and resistance
      const nearestSupport = levels.support.find(s => s < indicators.price) || null;
      const nearestResistance = levels.resistance.find(r => r > indicators.price) || null;

      const atSupport = nearestSupport ? this.isNearLevel(indicators.price, nearestSupport) : false;
      const atResistance = nearestResistance ? this.isNearLevel(indicators.price, nearestResistance) : false;

      return {
        indicators,
        trend,
        pattern,
        levels,
        nearestSupport,
        nearestResistance,
        atSupport,
        atResistance,
        rsiValid,
        timestamp: new Date()
      };
    } catch (error) {
      this.logger.error(`Analysis error: ${error.message}`);
      throw error;
    }
  }

  /**
   * Log analysis summary
   */
  logAnalysis(analysis) {
    this.logger.info('─'.repeat(60));
    this.logger.info('📊 MARKET ANALYSIS');
    this.logger.info('─'.repeat(60));
    this.logger.info(`Price: $${analysis.indicators.price.toFixed(2)}`);
    this.logger.info(`EMA ${Config.EMA_FAST}: $${analysis.indicators.emaFast.toFixed(2)}`);
    this.logger.info(`EMA ${Config.EMA_SLOW}: $${analysis.indicators.emaSlow.toFixed(2)}`);
    this.logger.info(`RSI: ${analysis.indicators.rsi.toFixed(2)}`);

    // ADX trend strength
    const adx = analysis.indicators.adx;
    const adxStatus = adx === null ? 'N/A' :
      adx >= 25 ? `${adx.toFixed(1)} ✅ TRENDING` :
      adx >= 20 ? `${adx.toFixed(1)} ⚠️ WEAK` :
      `${adx.toFixed(1)} ❌ RANGING`;
    this.logger.info(`ADX: ${adxStatus}`);

    this.logger.info(`Trend: ${analysis.trend}`);
    this.logger.info(`Pattern: ${analysis.pattern || 'None'}`);
    this.logger.info(`RSI Valid: ${analysis.rsiValid ? '✅' : '❌'}`);

    if (analysis.nearestSupport) {
      this.logger.info(`Support: $${analysis.nearestSupport.toFixed(2)} ${analysis.atSupport ? '📍' : ''}`);
    }

    if (analysis.nearestResistance) {
      this.logger.info(`Resistance: $${analysis.nearestResistance.toFixed(2)} ${analysis.atResistance ? '📍' : ''}`);
    }

    this.logger.info('─'.repeat(60));
  }
}

export default TechnicalAnalysis;
