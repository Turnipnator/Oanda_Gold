/**
 * EMA Trend-Following Strategy
 *
 * Ported from IG Gold backtest (PF=1.73, 47% win rate over 59 days).
 * Replaces breakout detection with EMA alignment + pullback entries.
 *
 * Entry Rules:
 * - LONG: EMA3 > EMA8 > EMA21 (bullish alignment)
 *         + Price within 0.3% of EMA3 (pullback, not extended)
 *         + RSI between 15 and 60
 *         + ADX > 30 AND rising
 *         + HTF (H4) EMAs aligned bullish
 *
 * - SHORT: EMA3 < EMA8 < EMA21 (bearish alignment)
 *          + Price within 0.3% of EMA3
 *          + RSI between 40 and 85
 *          + ADX > 30 AND rising
 *          + HTF aligned bearish
 *          + Only if ALLOW_SHORT=true
 *
 * Stops: ATR-based (ATR × 1.5, capped $2-$8)
 * Take Profit: Stop × 2.0 (2:1 R:R)
 * Breakeven: At 70% of TP distance, move SL to entry
 * Trailing: After breakeven, trail at ATR × 1.5
 */
import Config from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const STATE_FILE = path.join(DATA_DIR, 'ema_trend_state.json');

class EmaTrendStrategy {
  constructor(logger, technicalAnalysis) {
    this.logger = logger;
    this.ta = technicalAnalysis;
    this.name = `EMA Trend (${Config.EMA_TREND_FAST}/${Config.EMA_TREND_MEDIUM}/${Config.EMA_TREND_SLOW})`;

    // State persisted across restarts
    this.lastSignal = null;
    this.lastSignalCandleTime = null;
    this.lastATR = null;

    this.loadState();
  }

  loadState() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        this.lastSignal = data.lastSignal || null;
        this.lastSignalCandleTime = data.lastSignalCandleTime || null;
        this.lastATR = data.lastATR || null;
        this.logger.info(`📂 EMA Trend state loaded: lastSignal=${this.lastSignal}, ATR=${this.lastATR?.toFixed(2)}`);
      }
    } catch (error) {
      this.logger.error(`Failed to load EMA Trend state: ${error.message}`);
    }
  }

  saveState() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify({
        lastSignal: this.lastSignal,
        lastSignalCandleTime: this.lastSignalCandleTime,
        lastATR: this.lastATR,
        savedAt: new Date().toISOString()
      }, null, 2));
    } catch (error) {
      this.logger.error(`Failed to save EMA Trend state: ${error.message}`);
    }
  }

  /**
   * Evaluate market for trade setup.
   * @param {Object} analysis - Result from TechnicalAnalysis.analyze() (uses standard 20/50 EMAs)
   * @param {Array} candles - Primary timeframe candles (H1)
   * @param {Array} htfCandles - Higher timeframe candles (H4) for trend alignment, or null
   * @returns {Object} { signal, reason, confidence } or { signal: null, reason, confidence: 0 }
   */
  evaluateSetup(analysis, candles, htfCandles = null) {
    const completeCandles = candles.filter(c => c.complete);
    if (completeCandles.length < Config.EMA_TREND_SLOW + 10) {
      return { signal: null, reason: 'Insufficient candles for EMA Trend', confidence: 0 };
    }

    // Calculate our own fast EMAs (3/8/21) — different from the standard 20/50
    const emaFast = this.ta.calculateEMA(completeCandles, Config.EMA_TREND_FAST);
    const emaMedium = this.ta.calculateEMA(completeCandles, Config.EMA_TREND_MEDIUM);
    const emaSlow = this.ta.calculateEMA(completeCandles, Config.EMA_TREND_SLOW);
    const atrValues = this.ta.calculateATR(completeCandles, Config.EMA_TREND_ATR_PERIOD);
    const adxValues = this.ta.calculateADX(completeCandles, 14);

    const lastIdx = completeCandles.length - 1;
    const prevIdx = lastIdx - 1;

    const fast = emaFast[lastIdx];
    const medium = emaMedium[lastIdx];
    const slow = emaSlow[lastIdx];
    const atr = atrValues[lastIdx];
    const currentADX = adxValues[lastIdx];
    const prevADX = adxValues[prevIdx];
    const price = completeCandles[lastIdx].close;
    const candleTime = completeCandles[lastIdx].time;

    // Calculate RSI from the standard analysis (already computed)
    const rsi = analysis.indicators.rsi;

    if (fast === null || medium === null || slow === null || atr === null || currentADX === null) {
      return { signal: null, reason: 'Indicators not ready', confidence: 0 };
    }

    const adx = currentADX.adx;
    const prevAdx = prevADX ? prevADX.adx : adx;

    // Store ATR for use in calculateEntryLevels
    this.lastATR = atr;

    // Prevent duplicate signals on the same candle
    if (this.lastSignalCandleTime === candleTime) {
      return {
        signal: null,
        reason: `Already signaled on this candle (${this.lastSignal})`,
        confidence: 0
      };
    }

    // --- FILTERS ---
    const filters = [];

    // 1. ADX trending filter
    if (adx < Config.EMA_TREND_ADX_MIN) {
      filters.push(`ADX ${adx.toFixed(1)} < ${Config.EMA_TREND_ADX_MIN} (ranging)`);
    }

    // 2. ADX rising filter (trend must be strengthening)
    const adxDeclining = adx < prevAdx - 0.5;
    if (adxDeclining) {
      filters.push(`ADX declining (${prevAdx.toFixed(1)} → ${adx.toFixed(1)})`);
    }

    // --- CHECK EMA ALIGNMENT ---
    const bullishEMA = fast > medium && medium > slow;
    const bearishEMA = fast < medium && medium < slow;
    const priceAboveSlow = price > slow;
    const priceBelowSlow = price < slow;

    // Pullback filter: price must be near fast EMA (within X%)
    const pullbackThreshold = Config.EMA_TREND_PULLBACK_PCT / 100;
    const priceDistancePct = (price - fast) / fast;
    const buyPullbackValid = priceDistancePct <= pullbackThreshold;   // Price near/below fast EMA
    const sellPullbackValid = priceDistancePct >= -pullbackThreshold; // Price near/above fast EMA

    let signal = null;
    let reason = '';
    let confidence = 0;

    // --- LONG SETUP ---
    if (bullishEMA && priceAboveSlow) {
      if (filters.length > 0) {
        return {
          signal: null,
          reason: `Bullish EMA alignment but filtered: ${filters.join(', ')}`,
          confidence: 0
        };
      }

      // RSI filter for longs
      if (rsi < Config.EMA_TREND_RSI_OS || rsi > Config.EMA_TREND_RSI_BUY_MAX) {
        return {
          signal: null,
          reason: `Bullish alignment but RSI ${rsi.toFixed(1)} outside ${Config.EMA_TREND_RSI_OS}-${Config.EMA_TREND_RSI_BUY_MAX} range`,
          confidence: 0
        };
      }

      // Pullback filter
      if (!buyPullbackValid) {
        return {
          signal: null,
          reason: `Price too far from EMA${Config.EMA_TREND_FAST} (${(priceDistancePct * 100).toFixed(2)}% > ${Config.EMA_TREND_PULLBACK_PCT}%), wait for pullback`,
          confidence: 0
        };
      }

      // HTF alignment check
      if (htfCandles) {
        const htfTrend = this._getHTFTrend(htfCandles);
        if (htfTrend === 'BEARISH') {
          return {
            signal: null,
            reason: `Bullish H1 but HTF is BEARISH — don't buy against HTF trend`,
            confidence: 0
          };
        }
        if (htfTrend === 'NEUTRAL') {
          // Still allow but reduce confidence
          confidence -= 0.1;
        }
      }

      signal = 'LONG';
      reason = `EMA Trend LONG: ${Config.EMA_TREND_FAST}>${Config.EMA_TREND_MEDIUM}>${Config.EMA_TREND_SLOW} aligned, ` +
               `pullback ${(priceDistancePct * 100).toFixed(2)}%, RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}↑, ` +
               `ATR $${atr.toFixed(2)}`;
      confidence += this._calculateConfidence(adx, rsi, priceDistancePct, htfCandles);
    }
    // --- SHORT SETUP ---
    else if (bearishEMA && priceBelowSlow && Config.ALLOW_SHORT) {
      if (filters.length > 0) {
        return {
          signal: null,
          reason: `Bearish EMA alignment but filtered: ${filters.join(', ')}`,
          confidence: 0
        };
      }

      if (rsi > Config.EMA_TREND_RSI_OB || rsi < Config.EMA_TREND_RSI_SELL_MIN) {
        return {
          signal: null,
          reason: `Bearish alignment but RSI ${rsi.toFixed(1)} outside ${Config.EMA_TREND_RSI_SELL_MIN}-${Config.EMA_TREND_RSI_OB} range`,
          confidence: 0
        };
      }

      if (!sellPullbackValid) {
        return {
          signal: null,
          reason: `Price too far from EMA${Config.EMA_TREND_FAST} (${(priceDistancePct * 100).toFixed(2)}% < -${Config.EMA_TREND_PULLBACK_PCT}%), wait for bounce`,
          confidence: 0
        };
      }

      if (htfCandles) {
        const htfTrend = this._getHTFTrend(htfCandles);
        if (htfTrend === 'BULLISH') {
          return {
            signal: null,
            reason: `Bearish H1 but HTF is BULLISH — don't sell against HTF trend`,
            confidence: 0
          };
        }
      }

      signal = 'SHORT';
      reason = `EMA Trend SHORT: ${Config.EMA_TREND_FAST}<${Config.EMA_TREND_MEDIUM}<${Config.EMA_TREND_SLOW} aligned, ` +
               `pullback ${(priceDistancePct * 100).toFixed(2)}%, RSI ${rsi.toFixed(1)}, ADX ${adx.toFixed(1)}↑, ` +
               `ATR $${atr.toFixed(2)}`;
      confidence += this._calculateConfidence(adx, rsi, priceDistancePct, htfCandles);
    }
    // --- NO SETUP ---
    else {
      let holdReason = '';
      if (!bullishEMA && !bearishEMA) {
        holdReason = `EMAs not aligned (${fast.toFixed(2)}/${medium.toFixed(2)}/${slow.toFixed(2)})`;
      } else if (bearishEMA && !Config.ALLOW_SHORT) {
        holdReason = `Bearish EMA alignment but SHORT disabled`;
      } else {
        holdReason = `Price $${price.toFixed(2)} not confirming EMA trend`;
      }

      return {
        signal: null,
        reason: `${holdReason}, ADX ${adx.toFixed(1)}, ATR $${atr.toFixed(2)}`,
        confidence: 0
      };
    }

    // Record signal state
    this.lastSignal = signal;
    this.lastSignalCandleTime = candleTime;
    this.saveState();

    this.logger.info(`📊 EMA Trend: ${signal} setup detected!`);
    this.logger.info(`   EMA ${Config.EMA_TREND_FAST}=$${fast.toFixed(2)}, EMA ${Config.EMA_TREND_MEDIUM}=$${medium.toFixed(2)}, EMA ${Config.EMA_TREND_SLOW}=$${slow.toFixed(2)}`);
    this.logger.info(`   Price: $${price.toFixed(2)}, pullback: ${(priceDistancePct * 100).toFixed(2)}%`);
    this.logger.info(`   ATR(${Config.EMA_TREND_ATR_PERIOD}): $${atr.toFixed(2)} → SL: $${(atr * Config.EMA_TREND_ATR_SL_MULT).toFixed(2)}, TP: $${(atr * Config.EMA_TREND_ATR_SL_MULT * Config.EMA_TREND_TP_RR).toFixed(2)}`);

    return { signal, reason, confidence: Math.max(0, Math.min(confidence, 1)) };
  }

  /**
   * Calculate entry levels with ATR-based stops.
   * Called by index.js after evaluateSetup returns a signal.
   */
  calculateEntryLevels(analysis, signal, mtfEntryPrice = null) {
    const entryPrice = mtfEntryPrice || analysis.indicators.price;
    const isLong = signal === 'LONG';

    // ATR-based stop distance with min/max caps
    let stopDistance = (this.lastATR || 5.0) * Config.EMA_TREND_ATR_SL_MULT;
    const minSL = Config.pipsToPrice(Config.EMA_TREND_MIN_SL);
    const maxSL = Config.pipsToPrice(Config.EMA_TREND_MAX_SL);
    stopDistance = Math.max(minSL, Math.min(maxSL, stopDistance));

    const tpDistance = stopDistance * Config.EMA_TREND_TP_RR;
    const riskPips = Config.priceToPips(stopDistance);

    const stopLoss = isLong ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit1 = isLong ? entryPrice + tpDistance : entryPrice - tpDistance;
    const takeProfit2 = takeProfit1; // Single TP

    this.logger.info(`[EMA Trend] Entry levels: SL=$${stopLoss.toFixed(2)} (${stopDistance.toFixed(2)}), TP=$${takeProfit1.toFixed(2)} (${tpDistance.toFixed(2)}), R:R=${Config.EMA_TREND_TP_RR}:1`);

    return {
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      riskPips: riskPips.toFixed(1)
    };
  }

  /**
   * Get higher timeframe trend using fast/slow EMAs.
   */
  _getHTFTrend(htfCandles) {
    const completeHTF = htfCandles.filter(c => c.complete);
    if (completeHTF.length < Config.EMA_TREND_SLOW + 5) {
      return 'NEUTRAL';
    }

    const htfFast = this.ta.calculateEMA(completeHTF, Config.EMA_TREND_FAST);
    const htfSlow = this.ta.calculateEMA(completeHTF, Config.EMA_TREND_SLOW);

    const lastFast = htfFast[htfFast.length - 1];
    const lastSlow = htfSlow[htfSlow.length - 1];

    if (lastFast === null || lastSlow === null) return 'NEUTRAL';

    if (lastFast > lastSlow) return 'BULLISH';
    if (lastFast < lastSlow) return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Calculate confidence score (0-1).
   */
  _calculateConfidence(adx, rsi, priceDistancePct, htfCandles) {
    let confidence = 0.5; // Base

    // ADX strength (stronger trend = higher confidence)
    if (adx > 40) confidence += 0.15;
    else if (adx > 35) confidence += 0.1;
    else if (adx > 30) confidence += 0.05;

    // Pullback quality (closer to EMA = better entry)
    const absDist = Math.abs(priceDistancePct);
    if (absDist < 0.001) confidence += 0.1;  // Touching EMA
    else if (absDist < 0.002) confidence += 0.05;

    // HTF alignment
    if (htfCandles) {
      const htfTrend = this._getHTFTrend(htfCandles);
      if (htfTrend === 'BULLISH' || htfTrend === 'BEARISH') {
        confidence += 0.15;
      }
    }

    // RSI in healthy range (not extreme)
    if (rsi > 30 && rsi < 70) confidence += 0.05;

    return confidence;
  }

  /**
   * Strategy description for logging.
   */
  getDescription() {
    return [
      `EMA Trend Strategy (${Config.EMA_TREND_FAST}/${Config.EMA_TREND_MEDIUM}/${Config.EMA_TREND_SLOW})`,
      `Entry: EMA alignment + ${Config.EMA_TREND_PULLBACK_PCT}% pullback to fast EMA`,
      `SL: ATR(${Config.EMA_TREND_ATR_PERIOD}) × ${Config.EMA_TREND_ATR_SL_MULT} (min $${Config.pipsToPrice(Config.EMA_TREND_MIN_SL).toFixed(2)}, max $${Config.pipsToPrice(Config.EMA_TREND_MAX_SL).toFixed(2)})`,
      `TP: ${Config.EMA_TREND_TP_RR}:1 R:R`,
      `Breakeven: At ${(Config.EMA_TREND_BE_TRIGGER_PCT * 100).toFixed(0)}% of TP`,
      `ADX: > ${Config.EMA_TREND_ADX_MIN} + rising`,
      `RSI: ${Config.EMA_TREND_RSI_OS}-${Config.EMA_TREND_RSI_BUY_MAX} (LONG), ${Config.EMA_TREND_RSI_SELL_MIN}-${Config.EMA_TREND_RSI_OB} (SHORT)`,
      `HTF: ${Config.EMA_TREND_HTF} alignment required`,
    ].join('\n');
  }
}

export default EmaTrendStrategy;
