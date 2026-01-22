/**
 * Configuration Management for Gold Trading Bot
 * Loads and validates all configuration from environment variables
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

class Config {
  // Oanda API Configuration
  static OANDA_API_KEY = process.env.OANDA_API_KEY || '';
  static OANDA_ACCOUNT_ID = process.env.OANDA_ACCOUNT_ID || '';

  // Trading Mode
  static TRADING_MODE = process.env.TRADING_MODE || 'practice'; // practice or live

  // Get Oanda API hostname based on mode
  static getOandaHostname() {
    return this.TRADING_MODE === 'live'
      ? 'https://api-fxtrade.oanda.com'
      : 'https://api-fxpractice.oanda.com';
  }

  static getOandaStreamHostname() {
    return this.TRADING_MODE === 'live'
      ? 'https://stream-fxtrade.oanda.com'
      : 'https://stream-fxpractice.oanda.com';
  }

  // Risk Management
  static MAX_RISK_PER_TRADE = parseFloat(process.env.MAX_RISK_PER_TRADE || '0.015');
  static MAX_PORTFOLIO_RISK = parseFloat(process.env.MAX_PORTFOLIO_RISK || '0.05');
  static INITIAL_BALANCE = parseFloat(process.env.INITIAL_BALANCE || '10000');

  // Daily Targets
  static TARGET_DAILY_PROFIT = parseFloat(process.env.TARGET_DAILY_PROFIT || '100');
  static MAX_DAILY_LOSS = parseFloat(process.env.MAX_DAILY_LOSS || '150');

  // Trading Instrument
  static TRADING_SYMBOL = process.env.TRADING_SYMBOL || 'XAU_USD';

  // Triple Confirmation Strategy Parameters
  static EMA_FAST = parseInt(process.env.EMA_FAST || '20');
  static EMA_SLOW = parseInt(process.env.EMA_SLOW || '50');
  static TIMEFRAME = process.env.TIMEFRAME || 'H4'; // 4-hour candles

  // RSI Configuration
  static RSI_PERIOD = parseInt(process.env.RSI_PERIOD || '14');
  static RSI_BULLISH_MIN = parseFloat(process.env.RSI_BULLISH_MIN || '40');
  static RSI_BULLISH_MAX = parseFloat(process.env.RSI_BULLISH_MAX || '70');
  static RSI_BEARISH_MIN = parseFloat(process.env.RSI_BEARISH_MIN || '30');
  static RSI_BEARISH_MAX = parseFloat(process.env.RSI_BEARISH_MAX || '60');

  // Strategy Filters (to avoid choppy/ranging markets)
  static MIN_EMA_SEPARATION_PIPS = parseFloat(process.env.MIN_EMA_SEPARATION_PIPS || '1000'); // $10.00 minimum EMA separation
  static MIN_CONFIDENCE = parseFloat(process.env.MIN_CONFIDENCE || '70'); // Skip setups below 70% confidence

  // Strategy Selection
  static STRATEGY_TYPE = process.env.STRATEGY_TYPE || 'breakout_adx'; // 'breakout_adx' (recommended) or 'triple_confirmation'

  // Multi-Timeframe (MTF) Settings
  // Uses H4 for direction, H1 for entry timing (better entries, higher win rate)
  static ENABLE_MTF = process.env.ENABLE_MTF !== 'false'; // true by default
  static MTF_ENTRY_TIMEFRAME = process.env.MTF_ENTRY_TIMEFRAME || 'H1'; // Entry timing timeframe
  static MTF_PULLBACK_PIPS = parseFloat(process.env.MTF_PULLBACK_PIPS || '100'); // Wait for $1.00 pullback
  static MTF_MAX_WAIT_CANDLES = parseInt(process.env.MTF_MAX_WAIT_CANDLES || '8'); // Max H1 candles to wait (8 hours)
  static MTF_EMA_PERIOD = parseInt(process.env.MTF_EMA_PERIOD || '20'); // EMA period on entry timeframe

  // Bot Identification
  static BOT_NAME = process.env.BOT_NAME || 'Gold Bot'; // Used for logging and notifications

  // Entry & Exit Rules
  // For gold: 1 pip = $0.01, so 350 pips = $3.50 stop loss
  // Increased from 200 to 350 on Jan 21 2026 - 200 was too tight for live spreads
  static STOP_LOSS_PIPS = parseFloat(process.env.STOP_LOSS_PIPS || '350');

  // Take Profit Mode:
  // TRAILING_ONLY=true: No fixed TP, let winners run with trailing stop (aggressive, for trends)
  // TRAILING_ONLY=false: Use fixed TP (safer, more predictable)
  static TRAILING_ONLY = process.env.TRAILING_ONLY === 'true'; // true = no TP, trail only
  static TAKE_PROFIT_RR = parseFloat(process.env.TAKE_PROFIT_RR || '2.5'); // Only used if TRAILING_ONLY=false
  static ENABLE_STAGED_TP = process.env.ENABLE_STAGED_TP === 'true'; // false = single TP (if not trailing only)
  static TAKE_PROFIT_1_RR = parseFloat(process.env.TAKE_PROFIT_1_RR || '1.5'); // Only used if ENABLE_STAGED_TP=true
  static TAKE_PROFIT_2_RR = parseFloat(process.env.TAKE_PROFIT_2_RR || '2.5'); // Only used if ENABLE_STAGED_TP=true
  static MOVE_STOP_TO_BE = process.env.MOVE_STOP_TO_BE !== 'false';

  // Trailing Stop
  static ENABLE_TRAILING_STOP = process.env.ENABLE_TRAILING_STOP !== 'false';
  static TRAILING_STOP_DISTANCE_PIPS = parseFloat(process.env.TRAILING_STOP_DISTANCE_PIPS || '150'); // $1.50 trail distance
  static TRAILING_ACTIVATION_PIPS = parseFloat(process.env.TRAILING_ACTIVATION_PIPS || '200'); // $2.00 profit before trailing activates

  // Position Sizing (Oanda uses units: 1 unit = $1 worth of gold)
  static MIN_POSITION_SIZE = parseInt(process.env.MIN_POSITION_SIZE || '100');
  static MAX_POSITION_SIZE = parseInt(process.env.MAX_POSITION_SIZE || '50000');

  // Logging
  static LOG_LEVEL = process.env.LOG_LEVEL || 'info';
  static LOG_TO_FILE = process.env.LOG_TO_FILE !== 'false';
  static LOG_FILE_PATH = process.env.LOG_FILE_PATH || join(__dirname, '../logs/gold_bot.log');

  // Telegram Configuration
  static ENABLE_TELEGRAM = process.env.ENABLE_TELEGRAM === 'true';
  static TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
  static TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

  // Parse Telegram user IDs (supports multiple users)
  static getTelegramUsers() {
    if (!this.TELEGRAM_CHAT_ID) return [];
    try {
      return this.TELEGRAM_CHAT_ID.split(',')
        .map(id => id.trim())
        .filter(id => id)
        .map(id => parseInt(id));
    } catch (error) {
      console.error('Error parsing Telegram chat IDs:', error);
      return [];
    }
  }

  // Trading Schedule
  static TRADING_START_HOUR = parseInt(process.env.TRADING_START_HOUR || '0');
  static TRADING_END_HOUR = parseInt(process.env.TRADING_END_HOUR || '23');
  static AVOID_MAJOR_NEWS = process.env.AVOID_MAJOR_NEWS === 'true';

  // Analysis Settings
  static SCAN_INTERVAL_MINUTES = parseInt(process.env.SCAN_INTERVAL_MINUTES || '15');

  // Database
  static DATABASE_PATH = process.env.DATABASE_PATH || join(__dirname, '../data/trades.db');

  // API Rate Limiting
  static OANDA_MAX_REQUESTS_PER_SECOND = parseInt(process.env.OANDA_MAX_REQUESTS_PER_SECOND || '100');
  static RETRY_ATTEMPTS = parseInt(process.env.RETRY_ATTEMPTS || '3');
  static RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '1000');

  // Paper Trading Simulation
  static SIMULATE_SLIPPAGE = process.env.SIMULATE_SLIPPAGE === 'true';
  static SLIPPAGE_PIPS = parseFloat(process.env.SLIPPAGE_PIPS || '0.5');
  static SIMULATE_SPREAD = process.env.SIMULATE_SPREAD === 'true';

  /**
   * Validate configuration
   * @returns {Object} { valid: boolean, errors: string[] }
   */
  static validate() {
    const errors = [];

    // Check API credentials
    if (!this.OANDA_API_KEY) {
      errors.push('OANDA_API_KEY is required');
    }

    if (!this.OANDA_ACCOUNT_ID) {
      errors.push('OANDA_ACCOUNT_ID is required');
    }

    // Validate risk parameters
    if (this.MAX_RISK_PER_TRADE > 0.05) {
      errors.push('MAX_RISK_PER_TRADE should not exceed 5% (0.05)');
    }

    if (this.MAX_PORTFOLIO_RISK > 0.25) {
      errors.push('MAX_PORTFOLIO_RISK should not exceed 25% (0.25)');
    }

    // Validate EMA periods
    if (this.EMA_FAST >= this.EMA_SLOW) {
      errors.push('EMA_FAST must be less than EMA_SLOW');
    }

    // Validate RSI ranges
    if (this.RSI_BULLISH_MIN >= this.RSI_BULLISH_MAX) {
      errors.push('RSI_BULLISH_MIN must be less than RSI_BULLISH_MAX');
    }

    if (this.RSI_BEARISH_MIN >= this.RSI_BEARISH_MAX) {
      errors.push('RSI_BEARISH_MIN must be less than RSI_BEARISH_MAX');
    }

    // Validate Telegram configuration if enabled
    if (this.ENABLE_TELEGRAM) {
      if (!this.TELEGRAM_BOT_TOKEN) {
        errors.push('TELEGRAM_BOT_TOKEN is required when ENABLE_TELEGRAM=true');
      }
      if (!this.TELEGRAM_CHAT_ID) {
        errors.push('TELEGRAM_CHAT_ID is required when ENABLE_TELEGRAM=true');
      }
    }

    // Validate position sizing
    if (this.MIN_POSITION_SIZE < 1) {
      errors.push('MIN_POSITION_SIZE must be at least 1 unit');
    }

    if (this.MAX_POSITION_SIZE < this.MIN_POSITION_SIZE) {
      errors.push('MAX_POSITION_SIZE must be greater than MIN_POSITION_SIZE');
    }

    return {
      valid: errors.length === 0,
      errors
    };
  }

  /**
   * Display current configuration (safe - no secrets)
   */
  static displayConfig() {
    const mode = this.TRADING_MODE.toUpperCase();
    const modeEmoji = mode === 'LIVE' ? '🔴' : '📄';

    console.log('\n' + '='.repeat(60));
    console.log(`${this.BOT_NAME.toUpperCase()} CONFIGURATION`);
    console.log('='.repeat(60));
    console.log(`🤖 Bot Name: ${this.BOT_NAME}`);
    console.log(`📊 Strategy: ${this.STRATEGY_TYPE}`);
    console.log(`${modeEmoji} Trading Mode: ${mode}`);
    console.log(`💰 Initial Balance: $${this.INITIAL_BALANCE.toLocaleString()}`);
    console.log(`🎯 Target Daily Profit: $${this.TARGET_DAILY_PROFIT.toLocaleString()}`);
    console.log(`🛑 Max Daily Loss: $${this.MAX_DAILY_LOSS.toLocaleString()}`);
    console.log(`\n📊 Trading Instrument: ${this.TRADING_SYMBOL}`);
    console.log(`⏰ Timeframe: ${this.TIMEFRAME}`);
    console.log(`🔄 Scan Interval: ${this.SCAN_INTERVAL_MINUTES} minutes`);
    console.log(`\n📈 Strategy: Triple Confirmation Trend Follower`);
    console.log(`  - EMA Fast/Slow: ${this.EMA_FAST}/${this.EMA_SLOW}`);
    console.log(`  - RSI Period: ${this.RSI_PERIOD}`);
    console.log(`  - Bullish RSI Range: ${this.RSI_BULLISH_MIN}-${this.RSI_BULLISH_MAX}`);
    console.log(`  - Bearish RSI Range: ${this.RSI_BEARISH_MIN}-${this.RSI_BEARISH_MAX}`);
    console.log(`\n🔍 Entry Filters (Anti-Chop):`);
    console.log(`  - Min EMA Separation: ${this.MIN_EMA_SEPARATION_PIPS} pips ($${this.pipsToPrice(this.MIN_EMA_SEPARATION_PIPS).toFixed(2)})`);
    console.log(`  - Min Confidence: ${this.MIN_CONFIDENCE}%`);
    console.log(`\n⚖️ Risk Management:`);
    console.log(`  - Max Risk Per Trade: ${(this.MAX_RISK_PER_TRADE * 100).toFixed(1)}%`);
    console.log(`  - Max Portfolio Risk: ${(this.MAX_PORTFOLIO_RISK * 100).toFixed(1)}%`);
    console.log(`  - Stop Loss: ${this.STOP_LOSS_PIPS} pips`);
    console.log(`  - Take Profit Targets: ${this.TAKE_PROFIT_1_RR}R / ${this.TAKE_PROFIT_2_RR}R`);
    console.log(`  - Trailing Stop: ${this.ENABLE_TRAILING_STOP ? '✅ Enabled' : '❌ Disabled'} (${this.TRAILING_STOP_DISTANCE_PIPS} pips)`);
    console.log(`\n📱 Telegram: ${this.ENABLE_TELEGRAM ? '✅ Enabled' : '❌ Disabled'}`);
    console.log(`📝 Logging: ${this.LOG_LEVEL.toUpperCase()}`);
    console.log(`🌐 Oanda API: ${this.getOandaHostname()}`);
    console.log('='.repeat(60) + '\n');
  }

  /**
   * Convert pips to price for XAU_USD
   * Gold is typically quoted to 2 decimal places
   * 1 pip = 0.01 for XAU_USD
   */
  static pipsToPrice(pips) {
    return pips * 0.01;
  }

  /**
   * Convert price to pips for XAU_USD
   */
  static priceToPips(price) {
    return price / 0.01;
  }
}

export default Config;
