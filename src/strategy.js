/**
 * Triple Confirmation Trend Follower Strategy
 *
 * Entry Rules:
 * 1. Trend Filter: 20 EMA vs 50 EMA alignment + price position
 * 2. Momentum: RSI in valid range (40-70 for longs, 30-60 for shorts)
 * 3. Entry Trigger: Candlestick pattern near support/resistance
 *
 * As per CLAUDE.md - proven strategy for gold markets
 */
import Config from './config.js';

class TripleConfirmationStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = 'Triple Confirmation Trend Follower';
  }

  /**
   * Evaluate if there's a valid trade setup
   * Returns: { signal: 'LONG' | 'SHORT' | null, reason: string, confidence: number }
   */
  evaluateSetup(analysis) {
    this.logger.strategy('Evaluating trade setup...');

    // Check Confirmation #1: Trend Filter
    if (analysis.trend === 'NEUTRAL') {
      return {
        signal: null,
        reason: 'No clear trend - EMAs tangled',
        confidence: 0
      };
    }

    // Check Confirmation #2: RSI (Momentum)
    if (!analysis.rsiValid) {
      const rsi = analysis.indicators.rsi.toFixed(2);
      return {
        signal: null,
        reason: `RSI ${rsi} outside valid range for ${analysis.trend} trend`,
        confidence: 0
      };
    }

    // Check Confirmation #3: Entry Trigger (Pattern + Level)
    const setupType = this.identifyEntryTrigger(analysis);
    if (!setupType) {
      return {
        signal: null,
        reason: 'No entry trigger - waiting for pattern at key level',
        confidence: 0
      };
    }

    // All confirmations met - calculate confidence score
    const confidence = this.calculateConfidence(analysis);

    this.logger.strategy('✅ Triple Confirmation met!', {
      trend: analysis.trend,
      rsi: analysis.indicators.rsi.toFixed(2),
      pattern: analysis.pattern,
      setupType
    });

    return {
      signal: analysis.trend === 'BULLISH' ? 'LONG' : 'SHORT',
      reason: setupType,
      confidence,
      analysis
    };
  }

  /**
   * Identify entry trigger
   * Returns: description of setup type or null
   */
  identifyEntryTrigger(analysis) {
    const { trend, pattern, atSupport, atResistance, indicators } = analysis;

    // LONG setups
    if (trend === 'BULLISH') {
      // Pattern at support level
      if (atSupport && (pattern === 'BULLISH_ENGULFING' || pattern === 'HAMMER')) {
        return `${pattern} at support ($${analysis.nearestSupport.toFixed(2)})`;
      }

      // Pattern at EMA bounce
      const nearEMA = Math.abs(indicators.price - indicators.emaFast) / indicators.price < 0.002;
      if (nearEMA && (pattern === 'BULLISH_ENGULFING' || pattern === 'HAMMER')) {
        return `${pattern} at EMA${Config.EMA_FAST} bounce`;
      }

      // Simple pullback to support without specific pattern
      if (atSupport) {
        return `Pullback to support ($${analysis.nearestSupport.toFixed(2)})`;
      }

      // Pullback to EMA
      if (nearEMA) {
        return `Pullback to EMA${Config.EMA_FAST}`;
      }
    }

    // SHORT setups
    if (trend === 'BEARISH') {
      // Pattern at resistance level
      if (atResistance && (pattern === 'BEARISH_ENGULFING' || pattern === 'SHOOTING_STAR')) {
        return `${pattern} at resistance ($${analysis.nearestResistance.toFixed(2)})`;
      }

      // Pattern at EMA rejection
      const nearEMA = Math.abs(indicators.price - indicators.emaFast) / indicators.price < 0.002;
      if (nearEMA && (pattern === 'BEARISH_ENGULFING' || pattern === 'SHOOTING_STAR')) {
        return `${pattern} at EMA${Config.EMA_FAST} rejection`;
      }

      // Simple bounce to resistance
      if (atResistance) {
        return `Bounce to resistance ($${analysis.nearestResistance.toFixed(2)})`;
      }

      // Bounce to EMA
      if (nearEMA) {
        return `Bounce to EMA${Config.EMA_FAST}`;
      }
    }

    return null;
  }

  /**
   * Calculate confidence score (0-100)
   * Higher score = stronger setup
   */
  calculateConfidence(analysis) {
    let score = 0;

    // Base score for having all three confirmations
    score += 40;

    // Bonus for candlestick pattern
    if (analysis.pattern) {
      if (analysis.pattern === 'BULLISH_ENGULFING' || analysis.pattern === 'BEARISH_ENGULFING') {
        score += 20; // Engulfing patterns are strong
      } else {
        score += 15; // Hammer/Shooting star
      }
    }

    // Bonus for being at key level
    if (analysis.atSupport || analysis.atResistance) {
      score += 15;
    }

    // Bonus for RSI being in middle of range (not at extremes)
    const { rsi } = analysis.indicators;
    if (analysis.trend === 'BULLISH' && rsi >= 50 && rsi <= 65) {
      score += 10; // Sweet spot for bullish momentum
    } else if (analysis.trend === 'BEARISH' && rsi >= 35 && rsi <= 50) {
      score += 10; // Sweet spot for bearish momentum
    }

    // Bonus for strong trend (EMAs well separated)
    const emaSpread = Math.abs(analysis.indicators.emaFast - analysis.indicators.emaSlow) / analysis.indicators.price;
    if (emaSpread > 0.01) {
      score += 10; // EMAs separated by >1%
    } else if (emaSpread > 0.005) {
      score += 5; // EMAs separated by >0.5%
    }

    return Math.min(score, 100);
  }

  /**
   * Calculate entry price, stop loss, and take profits
   */
  calculateEntryLevels(analysis, signal) {
    const currentPrice = analysis.indicators.price;
    const isLong = signal === 'LONG';

    // Entry: Current market price
    let entryPrice = currentPrice;

    // Stop Loss: Based on strategy rules (20-40 pips)
    let stopLoss;
    const stopPips = Config.STOP_LOSS_PIPS;
    const stopDistance = Config.pipsToPrice(stopPips);

    if (isLong) {
      // Long: Stop below entry (simple fixed distance)
      stopLoss = entryPrice - stopDistance;

      // Optional: Widen slightly if support is very close (within 10 pips)
      if (analysis.nearestSupport && analysis.nearestSupport < currentPrice) {
        const distanceToSupport = currentPrice - analysis.nearestSupport;
        if (distanceToSupport < Config.pipsToPrice(10)) {
          // Support is very close, place stop below it
          stopLoss = analysis.nearestSupport - Config.pipsToPrice(5);
        }
      }
    } else {
      // Short: Stop above entry (simple fixed distance)
      stopLoss = entryPrice + stopDistance;

      // Optional: Widen slightly if resistance is very close (within 10 pips)
      if (analysis.nearestResistance && analysis.nearestResistance > currentPrice) {
        const distanceToResistance = analysis.nearestResistance - currentPrice;
        if (distanceToResistance < Config.pipsToPrice(10)) {
          // Resistance is very close, place stop above it
          stopLoss = analysis.nearestResistance + Config.pipsToPrice(5);
        }
      }
    }

    // Calculate risk distance
    const riskDistance = Math.abs(entryPrice - stopLoss);
    const riskPips = Config.priceToPips(riskDistance);

    // Take Profit targets
    const tp1Distance = riskDistance * Config.TAKE_PROFIT_1_RR;
    const tp2Distance = riskDistance * Config.TAKE_PROFIT_2_RR;

    const takeProfit1 = isLong ? entryPrice + tp1Distance : entryPrice - tp1Distance;
    const takeProfit2 = isLong ? entryPrice + tp2Distance : entryPrice - tp2Distance;

    this.logger.strategy('Entry levels calculated', {
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
      riskDistance,
      riskPips
    };
  }

  /**
   * Get strategy description
   */
  getDescription() {
    return `
      ${this.name}

      Confirmation #1: Trend Filter (EMA ${Config.EMA_FAST}/${Config.EMA_SLOW})
      Confirmation #2: Momentum (RSI ${Config.RSI_PERIOD})
      Confirmation #3: Entry Trigger (Pattern + Level)

      Risk/Reward: ${Config.TAKE_PROFIT_1_RR}R / ${Config.TAKE_PROFIT_2_RR}R
      Stop Loss: ${Config.STOP_LOSS_PIPS} pips
    `.trim();
  }
}

export default TripleConfirmationStrategy;
