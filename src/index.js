/**
 * Gold Trading Bot - Main Entry Point
 * Automated XAU/USD trading using Triple Confirmation Strategy on Oanda
 */
import cron from 'node-cron';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Config from './config.js';
import logger from './logger.js';
import OandaClient from './oanda_client.js';
import TechnicalAnalysis from './technical_analysis.js';
import TripleConfirmationStrategy from './strategy.js';
import BreakoutADXStrategy from './breakout_adx_strategy.js';
import RiskManager from './risk_manager.js';
import GoldTelegramBot from './telegram_bot.js';
import StrategyTracker from './strategy_tracker.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Position data file path - use /app/data in Docker, ./data locally
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const POSITIONS_FILE = path.join(DATA_DIR, 'active_positions.json');
const COOLDOWN_FILE = path.join(DATA_DIR, 'trade_cooldown.json');

class GoldTradingBot {
  constructor() {
    this.isRunning = false;
    this.startTime = null;
    this.logger = logger;

    // Initialize components
    this.client = new OandaClient(logger);
    this.ta = new TechnicalAnalysis(logger);

    // Initialize BOTH strategies for comparison
    this.tripleStrategy = new TripleConfirmationStrategy(logger, this.ta);
    this.breakoutStrategy = new BreakoutADXStrategy(logger, this.ta);

    // Determine which strategy trades live (from config)
    // Options: 'breakout_adx' (default/recommended) or 'triple_confirmation'
    const liveStrategyName = Config.STRATEGY_TYPE === 'triple_confirmation'
      ? 'Triple Confirmation'
      : 'Breakout + ADX';

    this.liveStrategy = Config.STRATEGY_TYPE === 'triple_confirmation'
      ? this.tripleStrategy
      : this.breakoutStrategy;

    // Initialize strategy tracker
    this.tracker = new StrategyTracker();
    this.tracker.registerStrategy('Breakout + ADX', liveStrategyName === 'Breakout + ADX');
    this.tracker.registerStrategy('Triple Confirmation', liveStrategyName === 'Triple Confirmation');

    logger.info(`🟢 LIVE Strategy: ${liveStrategyName}`);
    logger.info(`📝 HYPOTHETICAL Strategy: ${liveStrategyName === 'Breakout + ADX' ? 'Triple Confirmation' : 'Breakout + ADX'}`);

    this.riskManager = new RiskManager(logger, this.client);

    // Telegram bot (optional)
    this.telegramBot = null;

    // Track active positions
    this.activePositions = new Map();

    // Load persisted positions on startup
    this.loadPositions();

    // Track last API error notification (to avoid spam)
    this.lastApiErrorNotification = null;

    // Watchdog: track last successful activity to detect hangs
    this.lastActivityTime = Date.now();

    // Trade cooldown: track when last trade closed to prevent rapid re-entries
    this.lastTradeCloseTime = null;

    // Load persisted cooldown on startup
    this.loadCooldown();

    logger.info(`🤖 ${Config.BOT_NAME} initialized`);
  }

  /**
   * Check if trade cooldown is active (prevents rapid re-entries after losses)
   * @returns {Object} { active: boolean, remainingMinutes: number }
   */
  checkTradeCooldown() {
    if (!this.lastTradeCloseTime || Config.TRADE_COOLDOWN_HOURS <= 0) {
      return { active: false, remainingMinutes: 0 };
    }

    const cooldownMs = Config.TRADE_COOLDOWN_HOURS * 60 * 60 * 1000;
    const elapsed = Date.now() - this.lastTradeCloseTime;
    const remaining = cooldownMs - elapsed;

    if (remaining <= 0) {
      return { active: false, remainingMinutes: 0 };
    }

    return {
      active: true,
      remainingMinutes: Math.ceil(remaining / 60000)
    };
  }

  /**
   * Check if we're within allowed trading hours
   * Avoids Asian session (00:00-08:00 UK) when liquidity is low and wicks are wild
   * @returns {{ allowed: boolean, currentHour: number, reason?: string }}
   */
  checkTradingHours() {
    // Get current hour in UK timezone
    const now = new Date();
    const ukTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }));
    const currentHour = ukTime.getHours();

    const startHour = Config.TRADING_START_HOUR;
    const endHour = Config.TRADING_END_HOUR;

    // Handle normal range (e.g., 08:00-22:00)
    if (startHour < endHour) {
      const allowed = currentHour >= startHour && currentHour < endHour;
      return {
        allowed,
        currentHour,
        reason: allowed ? null : `Outside trading hours (${startHour}:00-${endHour}:00 UK, currently ${currentHour}:00)`
      };
    }

    // Handle overnight range (e.g., 22:00-08:00) - would mean startHour > endHour
    const allowed = currentHour >= startHour || currentHour < endHour;
    return {
      allowed,
      currentHour,
      reason: allowed ? null : `Outside trading hours (${startHour}:00-${endHour}:00 UK, currently ${currentHour}:00)`
    };
  }

  /**
   * Save cooldown timer to file for persistence across restarts
   */
  saveCooldown() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const data = {
        lastTradeCloseTime: this.lastTradeCloseTime,
        savedAt: Date.now()
      };

      fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(data, null, 2));
      logger.debug(`💾 Saved cooldown timer to file`);
    } catch (error) {
      logger.error(`Failed to save cooldown: ${error.message}`);
    }
  }

  /**
   * Load cooldown timer from file
   */
  loadCooldown() {
    try {
      if (!fs.existsSync(COOLDOWN_FILE)) {
        logger.info('📂 No persisted cooldown found');
        return;
      }

      const rawData = fs.readFileSync(COOLDOWN_FILE, 'utf8');
      const data = JSON.parse(rawData);

      if (data.lastTradeCloseTime) {
        this.lastTradeCloseTime = data.lastTradeCloseTime;
        const cooldown = this.checkTradeCooldown();
        if (cooldown.active) {
          logger.info(`📂 Loaded cooldown: ${cooldown.remainingMinutes} minutes remaining`);
        } else {
          logger.info(`📂 Loaded cooldown expired - ready to trade`);
          this.lastTradeCloseTime = null;
        }
      }
    } catch (error) {
      logger.error(`Failed to load cooldown: ${error.message}`);
    }
  }

  /**
   * Save active positions to file for persistence across restarts
   */
  savePositions() {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      // Convert Map to plain object for JSON serialization
      const data = {};
      for (const [tradeId, position] of this.activePositions) {
        data[tradeId] = {
          ...position,
          openTime: position.openTime?.toISOString?.() || position.openTime
        };
      }

      fs.writeFileSync(POSITIONS_FILE, JSON.stringify(data, null, 2));
      logger.debug(`💾 Saved ${this.activePositions.size} active positions to file`);
    } catch (error) {
      logger.error(`Failed to save positions: ${error.message}`);
    }
  }

  /**
   * Load active positions from file
   */
  loadPositions() {
    try {
      if (!fs.existsSync(POSITIONS_FILE)) {
        logger.info('📂 No persisted positions found, starting fresh');
        return;
      }

      const rawData = fs.readFileSync(POSITIONS_FILE, 'utf8');
      const data = JSON.parse(rawData);

      for (const [tradeId, position] of Object.entries(data)) {
        // Restore Date objects
        if (position.openTime) {
          position.openTime = new Date(position.openTime);
        }
        this.activePositions.set(tradeId, position);
      }

      logger.info(`📂 Loaded ${this.activePositions.size} active positions from file`);

      // Log details of loaded positions
      for (const [tradeId, pos] of this.activePositions) {
        logger.info(`   📍 Trade ${tradeId}: ${pos.signal} @ $${pos.entryPrice?.toFixed(2)} | TP1: $${pos.takeProfit1?.toFixed(2)} | TP1 Hit: ${pos.tp1Hit ? 'YES' : 'NO'}`);
      }
    } catch (error) {
      logger.error(`Failed to load positions: ${error.message}`);
    }
  }

  /**
   * Sync persisted positions with actual Oanda trades
   * Removes positions that no longer exist on Oanda and sends closure notifications
   */
  async syncPositionsWithOanda() {
    try {
      const openTrades = await this.client.getOpenTrades();
      const oandaTradeIds = new Set(openTrades.map(t => t.tradeId));

      // Find positions that were closed while bot was down/restarting
      const closedWhileDown = [];
      for (const tradeId of this.activePositions.keys()) {
        if (!oandaTradeIds.has(tradeId)) {
          closedWhileDown.push(tradeId);
        }
      }

      // Process each closed position - fetch details and notify
      for (const tradeId of closedWhileDown) {
        const tracked = this.activePositions.get(tradeId);
        logger.info(`🗑️ Position ${tradeId} was closed while bot was down`);

        try {
          const response = await this.client.makeRequest('GET', `/v3/accounts/${this.client.accountId}/trades/${tradeId}`);
          if (response.trade && response.trade.state === 'CLOSED') {
            const trade = response.trade;
            const entryPrice = parseFloat(trade.price);
            const exitPrice = parseFloat(trade.averageClosePrice || entryPrice);
            const pnl = parseFloat(trade.realizedPL || 0);
            const pnlPct = (pnl / (entryPrice * Math.abs(parseFloat(trade.initialUnits)))) * 100;
            const reason = trade.stopLossOrderID ? 'STOP_LOSS' : (trade.takeProfitOrderID ? 'TAKE_PROFIT' : 'Unknown');

            logger.info(`💰 Closed trade ${tradeId}: ${pnl >= 0 ? '+' : ''}£${pnl.toFixed(2)} (${reason})`);

            // Set cooldown timer to prevent rapid re-entries
            this.lastTradeCloseTime = Date.now();
            this.saveCooldown();
            logger.info(`⏳ Trade cooldown started - next trade in ${Config.TRADE_COOLDOWN_HOURS} hours`);

            // Send Telegram notification if available
            if (this.telegramBot) {
              try {
                await this.telegramBot.notifyTradeClosed(
                  tracked?.symbol || 'XAU_USD',
                  entryPrice,
                  exitPrice,
                  pnl,
                  pnlPct,
                  reason,
                  tracked?.strategyName || 'Unknown'
                );
              } catch (telegramError) {
                logger.warn(`Failed to send closure notification for ${tradeId}: ${telegramError.message}`);
              }
            }

            // Update risk manager
            this.riskManager.recordTrade(pnl);
          }
        } catch (error) {
          logger.warn(`Could not fetch close details for trade ${tradeId}: ${error.message}`);
        }

        this.activePositions.delete(tradeId);
      }

      // Save cleaned up positions
      this.savePositions();
    } catch (error) {
      logger.error(`Failed to sync positions with Oanda: ${error.message}`);
    }
  }

  /**
   * Start the trading bot
   */
  async start() {
    try {
      logger.info('');
      logger.info('═'.repeat(70));
      logger.info('🚀 STARTING GOLD TRADING BOT');
      logger.info('═'.repeat(70));

      // Display configuration
      Config.displayConfig();

      // Validate configuration
      const validation = Config.validate();
      if (!validation.valid) {
        logger.error('Configuration validation failed:');
        validation.errors.forEach(error => logger.error(`  ❌ ${error}`));
        process.exit(1);
      }

      logger.info('✅ Configuration validated');

      // Test Oanda connection
      logger.info('Testing Oanda API connection...');
      const connected = await this.client.testConnection();
      if (!connected) {
        logger.error('Failed to connect to Oanda API');
        process.exit(1);
      }

      // Initialize risk manager with current balance
      await this.riskManager.syncBalance();

      // Start Telegram bot if enabled (must start BEFORE position sync so notifications work)
      if (Config.ENABLE_TELEGRAM) {
        try {
          logger.info('Starting Telegram bot...');
          this.telegramBot = new GoldTelegramBot(logger, this);
          await this.telegramBot.start();
        } catch (error) {
          logger.error(`Failed to start Telegram bot: ${error.message}`);
          logger.warn('⚠️ Trading bot will continue without Telegram notifications');
          this.telegramBot = null; // Disable Telegram if it fails
        }
      }

      // Sync persisted positions with actual Oanda trades
      // Done after Telegram starts so closure notifications can be sent
      await this.syncPositionsWithOanda();

      // Display strategy information
      logger.info('');
      logger.info('═'.repeat(70));
      logger.info('📊 DUAL STRATEGY COMPARISON MODE');
      logger.info('═'.repeat(70));
      logger.info('');
      logger.info('🟢 LIVE STRATEGY (Trading Real Money):');
      logger.info('   ' + this.liveStrategy.name);
      logger.info(this.liveStrategy.getDescription().split('\n').map(l => '   ' + l).join('\n'));
      logger.info('');
      logger.info('📝 HYPOTHETICAL STRATEGY (Tracking Only):');
      const hypotheticalStrategy = this.liveStrategy === this.tripleStrategy ? this.breakoutStrategy : this.tripleStrategy;
      logger.info('   ' + hypotheticalStrategy.name);
      logger.info(hypotheticalStrategy.getDescription().split('\n').map(l => '   ' + l).join('\n'));
      logger.info('');
      logger.info('═'.repeat(70));
      logger.info('');

      // Set running flag
      this.isRunning = true;
      this.startTime = Date.now();

      // Schedule market scans using recursive setTimeout (most reliable)
      const scanIntervalMs = Config.SCAN_INTERVAL_MINUTES * 60 * 1000;
      logger.info(`⏰ Scheduling market scans every ${Config.SCAN_INTERVAL_MINUTES} minutes using recursive setTimeout`);
      logger.info(`📍 Scans will fire every ${scanIntervalMs}ms (${scanIntervalMs / 1000} seconds)`);

      const scheduleNextScan = () => {
        setTimeout(async () => {
          try {
            // Heartbeat log to verify scan is executing
            const now = new Date().toISOString().replace('T', ' ').substring(0, 19);
            logger.info(`⏰ [${now}] Scan timeout fired - isRunning: ${this.isRunning}`);

            if (this.isRunning) {
              try {
                await this.scanMarket();
                this.lastActivityTime = Date.now();
              } catch (error) {
                logger.error(`Market scan failed: ${error.message}`);
                logger.error(`Stack: ${error.stack}`);
                logger.warn(`Will retry in ${Config.SCAN_INTERVAL_MINUTES} minutes`);

                // Notify user if it's an API outage (with safe error handling)
                if (error.message.includes('503') || error.message.includes('failed after')) {
                  if (this.telegramBot) {
                    try {
                      await this.telegramBot.notifyError(`⚠️ API Issue: ${error.message}\n\nBot is still running and will retry automatically.`);
                    } catch (telegramError) {
                      logger.warn(`Failed to send Telegram notification: ${telegramError.message}`);
                    }
                  }
                }
              }
            } else {
              logger.warn(`⏸️ Bot is paused (isRunning: false) - skipping scan`);
            }
          } catch (scanError) {
            // CRITICAL: Catch ANY error
            logger.error(`🚨 CRITICAL: Scan timeout error: ${scanError.message}`);
            logger.error(`Stack: ${scanError.stack}`);
          } finally {
            // ALWAYS schedule the next scan, even if this one failed
            // Use setImmediate to ensure scheduling happens in a fresh event loop tick
            setImmediate(() => scheduleNextScan());
          }
        }, scanIntervalMs);
      };

      scheduleNextScan();
      logger.info(`✅ Recursive setTimeout initialized`);
      logger.info(`🕐 First scan will fire at: ${new Date(Date.now() + scanIntervalMs).toISOString()}`);

      // Run initial scan
      logger.info('Running initial market scan...');
      try {
        await this.scanMarket();
        this.lastActivityTime = Date.now();
      } catch (error) {
        logger.error(`Initial market scan failed: ${error.message}`);
        logger.warn('Bot will continue and retry on next scheduled scan');
      }

      // Schedule daily reset (at midnight UTC)
      cron.schedule('0 0 * * *', async () => {
        try {
          this.riskManager.resetDailyStats();
          logger.info('📅 Daily statistics reset');
        } catch (error) {
          logger.error(`Daily reset failed: ${error.message}`);
        }
      });

      // Monitor existing positions every minute using recursive setTimeout
      logger.info(`⏰ Scheduling position monitoring every 60 seconds using recursive setTimeout`);

      const scheduleNextMonitor = () => {
        setTimeout(async () => {
          try {
            // Heartbeat log every 5 minutes to avoid spam (60s * 5 = 300s intervals)
            const now = Date.now();
            if (!this.lastMonitorLog || now - this.lastMonitorLog >= 300000) {
              logger.info(`⏰ Position monitoring active (checks every 60s)`);
              this.lastMonitorLog = now;
            }

            if (this.isRunning) {
              try {
                await this.monitorPositions();
                this.lastActivityTime = Date.now();
              } catch (error) {
                logger.error(`Position monitoring failed: ${error.message}`);
                logger.error(`Stack: ${error.stack}`);
                logger.warn('Will retry in 1 minute');

                // Notify user if it's an API outage (but only once per hour to avoid spam)
                if ((error.message.includes('503') || error.message.includes('failed after')) &&
                    (!this.lastApiErrorNotification || Date.now() - this.lastApiErrorNotification > 3600000)) {
                  if (this.telegramBot) {
                    try {
                      await this.telegramBot.notifyError(`⚠️ API Issue during position monitoring: ${error.message}\n\nBot is still running.`);
                      this.lastApiErrorNotification = Date.now();
                    } catch (telegramError) {
                      logger.warn(`Failed to send Telegram notification: ${telegramError.message}`);
                    }
                  }
                }
              }
            }
          } catch (monitorError) {
            // CRITICAL: Catch ANY error
            logger.error(`🚨 CRITICAL: Position monitoring timeout error: ${monitorError.message}`);
            logger.error(`Stack: ${monitorError.stack}`);
          } finally {
            // ALWAYS schedule the next monitor, even if this one failed
            // Use setImmediate to ensure scheduling happens in a fresh event loop tick
            setImmediate(() => scheduleNextMonitor());
          }
        }, 60000);
      };

      scheduleNextMonitor();
      logger.info(`✅ Recursive setTimeout initialized for position monitoring`);

      // Real-time price monitoring for breakout detection (every 30 seconds)
      // Catches breakouts as they happen, not just at candle close
      if (Config.STRATEGY_TYPE === 'breakout_adx') {
        logger.info(`⏰ Scheduling real-time breakout checks every ${Config.REALTIME_CHECK_INTERVAL_SECONDS} seconds`);

        const scheduleRealtimeCheck = () => {
          setTimeout(async () => {
            try {
              if (this.isRunning) {
                await this.checkRealtimeBreakout();
                this.lastActivityTime = Date.now();
              }
            } catch (error) {
              logger.error(`Realtime breakout check failed: ${error.message}`);
            } finally {
              setImmediate(() => scheduleRealtimeCheck());
            }
          }, Config.REALTIME_CHECK_INTERVAL_SECONDS * 1000);
        };

        scheduleRealtimeCheck();
        logger.info(`✅ Real-time breakout monitoring initialized (${Config.BREAKOUT_CONFIRMATION_SECONDS}s confirmation delay)`);
      }

      // Watchdog timer - detects if the event loop is frozen/hung
      // Replaces the need for hourly cron restart
      const WATCHDOG_CHECK_INTERVAL = 5 * 60 * 1000;  // Check every 5 minutes
      const WATCHDOG_TIMEOUT = 20 * 60 * 1000;        // Alert if no activity for 20 minutes
      setInterval(() => {
        const timeSinceActivity = Date.now() - this.lastActivityTime;
        if (timeSinceActivity > WATCHDOG_TIMEOUT) {
          logger.error(`🐕 WATCHDOG: No activity for ${Math.round(timeSinceActivity / 60000)} minutes - bot appears frozen!`);
          logger.error(`🐕 WATCHDOG: Last activity was at ${new Date(this.lastActivityTime).toISOString()}`);
          logger.error(`🐕 WATCHDOG: Exiting process - Docker will restart`);
          process.exit(1);
        }
      }, WATCHDOG_CHECK_INTERVAL);
      logger.info(`🐕 Watchdog timer active (exits if no activity for ${WATCHDOG_TIMEOUT / 60000} minutes)`);

      logger.info('');
      logger.info('═'.repeat(70));
      logger.info('✅ BOT IS RUNNING - Press Ctrl+C to stop');
      logger.info('═'.repeat(70));
      logger.info('');

      // Keep process alive
      process.on('SIGINT', async () => {
        await this.shutdown();
      });

      process.on('SIGTERM', async () => {
        await this.shutdown();
      });

    } catch (error) {
      logger.error(`Failed to start bot: ${error.message}`);
      logger.error(error.stack);
      process.exit(1);
    }
  }

  /**
   * Scan market for trade setups
   */
  async scanMarket() {
    try {
      logger.info('🔍 Scanning market for setups...');

      // Get historical candles (H4 - main timeframe)
      const allCandles = await this.client.getCandles(
        Config.TRADING_SYMBOL,
        Config.TIMEFRAME,
        200
      );

      // CRITICAL: Filter out incomplete candles for strategy calculations
      // Using incomplete candles causes SMAs to shift as price moves within the candle,
      // which can trigger false crossover signals
      const candles = allCandles.filter(c => c.complete);

      logger.debug(`📊 H4 Candles: ${allCandles.length} total, ${candles.length} complete`);

      if (candles.length < 100) {
        logger.warn('Insufficient candle data');
        return;
      }

      // Fetch H1 candles for MTF entry timing (if enabled)
      let h1Candles = null;
      if (Config.ENABLE_MTF) {
        const allH1Candles = await this.client.getCandles(
          Config.TRADING_SYMBOL,
          Config.MTF_ENTRY_TIMEFRAME,
          100
        );
        h1Candles = allH1Candles.filter(c => c.complete);
        logger.debug(`📊 H1 Candles: ${allH1Candles.length} total, ${h1Candles.length} complete`);
      }

      // Perform technical analysis (uses completed candles for accurate indicators)
      const analysis = this.ta.analyze(candles);
      this.ta.logAnalysis(analysis);

      // Evaluate BOTH strategies (pass H1 candles to breakout strategy for MTF)
      const tripleSetup = this.tripleStrategy.evaluateSetup(analysis);
      const breakoutSetup = this.breakoutStrategy.evaluateSetup(analysis, candles, h1Candles);

      logger.info('');
      logger.info('─'.repeat(70));
      logger.info('📊 STRATEGY EVALUATION RESULTS:');
      logger.info('─'.repeat(70));
      logger.info(`🟢 Breakout + ADX: ${breakoutSetup.signal || 'NO SIGNAL'} (${breakoutSetup.confidence}%) - ${breakoutSetup.reason}`);
      logger.info(`📝 Triple Confirmation: ${tripleSetup.signal || 'NO SIGNAL'} (${tripleSetup.confidence}%) - ${tripleSetup.reason}`);
      logger.info('─'.repeat(70));
      logger.info('');

      // Determine which setup to use for live trading
      const liveSetup = this.liveStrategy === this.breakoutStrategy ? breakoutSetup : tripleSetup;
      const hypotheticalSetup = this.liveStrategy === this.breakoutStrategy ? tripleSetup : breakoutSetup;
      const liveStrategyName = this.liveStrategy === this.breakoutStrategy ? 'Breakout + ADX' : 'Triple Confirmation';
      const hypotheticalStrategyName = this.liveStrategy === this.breakoutStrategy ? 'Triple Confirmation' : 'Breakout + ADX';

      // Check if live strategy has a signal
      if (!liveSetup.signal) {
        logger.info(`🟢 LIVE (${liveStrategyName}): No setup - ${liveSetup.reason}`);

        // Check hypothetical strategy
        if (hypotheticalSetup.signal) {
          logger.info(`📝 HYPOTHETICAL (${hypotheticalStrategyName}): Would have signaled ${hypotheticalSetup.signal} at ${hypotheticalSetup.confidence}% confidence`);
        }

        return;
      }

      // We have a LIVE signal!
      logger.info('');
      logger.info('🎯 LIVE TRADE SETUP DETECTED!');
      logger.info(`🟢 Strategy: ${liveStrategyName}`);
      logger.info(`Signal: ${liveSetup.signal}`);
      logger.info(`Confidence: ${liveSetup.confidence}%`);
      logger.info(`Reason: ${liveSetup.reason}`);
      logger.info('');

      // Check if we already have a position in this instrument
      const existingTrades = await this.client.getOpenTrades();
      const hasPosition = existingTrades.some(t => t.instrument === Config.TRADING_SYMBOL);

      if (hasPosition) {
        logger.info('❌ Already have open position in XAU_USD - skipping');
        return;
      }

      // Check trade cooldown (prevents rapid re-entries after losses)
      const cooldown = this.checkTradeCooldown();
      if (cooldown.active) {
        logger.info(`⏳ Trade cooldown active - ${cooldown.remainingMinutes} minutes remaining`);
        logger.info(`   Last trade closed at ${new Date(this.lastTradeCloseTime).toISOString()}`);
        logger.info(`   Next trade allowed after ${new Date(this.lastTradeCloseTime + Config.TRADE_COOLDOWN_HOURS * 3600000).toISOString()}`);
        return;
      }

      // Check trading hours (avoid Asian session with low liquidity and wild wicks)
      const tradingHours = this.checkTradingHours();
      if (!tradingHours.allowed) {
        logger.info(`🌙 ${tradingHours.reason}`);
        logger.info(`   Skipping trade entry - will resume at ${Config.TRADING_START_HOUR}:00 UK time`);
        return;
      }

      // Calculate entry levels for LIVE strategy
      // Use MTF entry price if available (better entry from H1 pullback)
      const mtfEntryPrice = liveSetup.isMTFEntry ? liveSetup.entryPrice : null;
      const levels = this.liveStrategy.calculateEntryLevels(analysis, liveSetup.signal, mtfEntryPrice);

      // Calculate position size
      const positionSize = this.riskManager.calculatePositionSize(
        levels.entryPrice,
        levels.stopLoss
      );

      if (positionSize === 0) {
        logger.error('Position size calculation failed');
        return;
      }

      // Adjust units for direction (negative for short)
      const units = liveSetup.signal === 'LONG' ? positionSize : -positionSize;

      // Check risk management
      const canTrade = await this.riskManager.canOpenTrade(
        levels.entryPrice,
        levels.stopLoss,
        Math.abs(units)
      );

      if (!canTrade.allowed) {
        logger.risk(`Trade blocked: ${canTrade.reason}`);
        return;
      }

      // Execute LIVE trade
      await this.executeTrade(liveSetup.signal, units, levels, liveSetup.reason, liveStrategyName, liveSetup.confidence);

      // Record hypothetical trade if other strategy also signaled
      if (hypotheticalSetup.signal) {
        logger.info(`📝 HYPOTHETICAL (${hypotheticalStrategyName}): Would also enter ${hypotheticalSetup.signal} at ${hypotheticalSetup.confidence}% confidence`);

        // Calculate hypothetical entry levels
        const hypotheticalLevels = this.liveStrategy === this.breakoutStrategy
          ? this.tripleStrategy.calculateEntryLevels(analysis, hypotheticalSetup.signal)
          : this.breakoutStrategy.calculateEntryLevels(analysis, hypotheticalSetup.signal);

        // Track hypothetical trade
        this.tracker.recordSignal(
          hypotheticalStrategyName,
          hypotheticalSetup.signal,
          hypotheticalLevels.entryPrice,
          hypotheticalLevels.stopLoss,
          hypotheticalLevels.takeProfit1,
          hypotheticalLevels.takeProfit2,
          Math.abs(units),
          hypotheticalSetup.reason,
          hypotheticalSetup.confidence
        );
      }

    } catch (error) {
      logger.error(`Error scanning market: ${error.message}`);
      if (this.telegramBot) {
        try {
          await this.telegramBot.notifyError(`Market scan error: ${error.message}`);
        } catch (telegramError) {
          logger.warn(`Failed to send Telegram notification: ${telegramError.message}`);
        }
      }
    }
  }

  /**
   * Execute a trade
   */
  async executeTrade(signal, units, levels, reason, strategyName, confidence) {
    try {
      logger.info('');
      logger.info('🎬 EXECUTING LIVE TRADE...');
      logger.info(`🟢 Strategy: ${strategyName}`);
      logger.info(`Side: ${signal}`);
      logger.info(`Confidence: ${confidence}%`);
      logger.info(`Units: ${Math.abs(units)}`);
      logger.info(`Entry: $${levels.entryPrice.toFixed(2)}`);
      logger.info(`Stop Loss: $${levels.stopLoss.toFixed(2)}`);

      if (Config.TRAILING_ONLY) {
        logger.info(`Take Profit: NONE (trailing stop only @ ${Config.TRAILING_STOP_DISTANCE_PIPS} pips)`);
      } else if (Config.ENABLE_STAGED_TP) {
        logger.info(`Take Profit 1: $${levels.takeProfit1.toFixed(2)} (60%)`);
        logger.info(`Take Profit 2: $${levels.takeProfit2.toFixed(2)} (40%)`);
      } else {
        logger.info(`Take Profit: $${levels.takeProfit1.toFixed(2)} (single TP @ ${Config.TAKE_PROFIT_RR}R)`);
      }
      logger.info('');

      // Place market order
      // - TRAILING_ONLY: No TP, just SL (trailing will manage exit)
      // - STAGED_TP: No TP on order, managed manually
      // - Otherwise: Single TP on order
      let takeProfit = null;
      if (!Config.TRAILING_ONLY && !Config.ENABLE_STAGED_TP) {
        takeProfit = levels.takeProfit1;
      }

      // Calculate price bound for slippage protection
      // LONG: max fill = entry + slippage, SHORT: min fill = entry - slippage
      const isLongOrder = signal === 'LONG';
      const slippageAmount = Config.pipsToPrice(Config.MAX_SLIPPAGE_PIPS);
      const priceBound = isLongOrder
        ? levels.entryPrice + slippageAmount
        : levels.entryPrice - slippageAmount;
      logger.info(`🛡️ Max fill price: $${priceBound.toFixed(2)} (max slippage: $${slippageAmount.toFixed(2)})`);

      let order = await this.client.placeMarketOrder(
        Config.TRADING_SYMBOL,
        units,
        levels.stopLoss,
        takeProfit,
        priceBound
      );

      // Order retry logic - handle common failures
      if (!order.success && Config.ENABLE_ORDER_RETRY) {
        const retriableErrors = ['STOP_LOSS_ON_FILL_LOSS', 'STOP_LOSS_ON_FILL_GTD_TIMESTAMP_IN_PAST'];

        if (retriableErrors.some(err => order.reason?.includes(err) || order.rejectReason?.includes(err))) {
          logger.warn(`⚠️ Order failed with ${order.reason} - retrying with wider SL...`);

          // Widen the stop loss
          const widenAmount = Config.pipsToPrice(Config.ORDER_RETRY_WIDEN_SL_PIPS);
          const isLong = signal === 'LONG';
          const newStopLoss = isLong
            ? levels.stopLoss - widenAmount
            : levels.stopLoss + widenAmount;

          logger.info(`🔧 Widening SL from $${levels.stopLoss.toFixed(2)} to $${newStopLoss.toFixed(2)} (+$${widenAmount.toFixed(2)})`);

          // Retry with wider stop loss
          order = await this.client.placeMarketOrder(
            Config.TRADING_SYMBOL,
            units,
            newStopLoss,
            takeProfit,
            priceBound
          );

          if (order.success) {
            logger.info(`✅ Retry successful with wider SL!`);
            levels.stopLoss = newStopLoss; // Update levels for tracking
          } else {
            // Second retry: try without SL, add it after fill
            logger.warn(`⚠️ Retry with wider SL failed - trying without SL...`);

            order = await this.client.placeMarketOrder(
              Config.TRADING_SYMBOL,
              units,
              null,  // No stop loss
              null,  // No take profit
              priceBound  // Still protect against slippage
            );

            if (order.success) {
              logger.info(`✅ Order filled without SL - adding SL now...`);
              try {
                // Calculate SL based on actual fill price
                const fillBasedSL = isLong
                  ? order.price - Config.pipsToPrice(Config.BREAKOUT_STOP_LOSS_PIPS + Config.ORDER_RETRY_WIDEN_SL_PIPS)
                  : order.price + Config.pipsToPrice(Config.BREAKOUT_STOP_LOSS_PIPS + Config.ORDER_RETRY_WIDEN_SL_PIPS);

                await this.client.modifyTrade(order.tradeId, fillBasedSL, null);
                levels.stopLoss = fillBasedSL;
                logger.info(`✅ SL added at $${fillBasedSL.toFixed(2)}`);
              } catch (slError) {
                logger.error(`❌ Failed to add SL after fill: ${slError.message}`);
                // Continue anyway - position is open, monitor will handle it
              }
            }
          }
        }
      }

      if (!order.success) {
        logger.error(`Order failed: ${order.reason}`);
        if (order.rejectReason) {
          logger.error(`Reject reason: ${order.rejectReason}`);
        }
        return;
      }

      // Recalculate SL based on actual fill price (not theoretical entry price)
      // The calculated SL may be wrong if fill price differs from analysis price
      // Breakout trades use wider SL to survive post-breakout volatility
      const isLong = signal === 'LONG';
      const isBreakoutTrade = strategyName?.includes('Breakout');
      const stopPips = isBreakoutTrade ? Config.BREAKOUT_STOP_LOSS_PIPS : Config.STOP_LOSS_PIPS;
      const stopDistance = Config.pipsToPrice(stopPips);
      const correctStopLoss = isLong
        ? order.price - stopDistance
        : order.price + stopDistance;

      if (Math.abs(correctStopLoss - levels.stopLoss) > 0.01) {
        logger.info(`🔧 Adjusting SL from $${levels.stopLoss.toFixed(2)} to $${correctStopLoss.toFixed(2)} (based on fill price $${order.price.toFixed(2)})`);
        try {
          await this.client.modifyTrade(order.tradeId, correctStopLoss, null);
          levels.stopLoss = correctStopLoss;
        } catch (slError) {
          logger.warn(`Failed to adjust SL: ${slError.message} - keeping original SL`);
        }
      }

      if (Config.TRAILING_ONLY) {
        logger.info(`📊 NO fixed TP - Trailing stop at ${Config.TRAILING_STOP_DISTANCE_PIPS} pips ($${(Config.TRAILING_STOP_DISTANCE_PIPS * 0.01).toFixed(2)}) will manage exit`);
        logger.info(`🎯 Let winners run! Trail follows price, locks in profit as it moves.`);
      } else if (Config.ENABLE_STAGED_TP) {
        logger.info(`📊 TP1 target: $${levels.takeProfit1.toFixed(2)} (will close 60%)`);
        logger.info(`📊 TP2 target: $${levels.takeProfit2.toFixed(2)} (will close 40%)`);
      } else {
        logger.info(`📊 TP set at $${levels.takeProfit1.toFixed(2)} (Oanda will close automatically)`);
      }

      logger.info('');
      logger.info('✅ TRADE OPENED SUCCESSFULLY!');
      logger.info(`Order ID: ${order.orderId}`);
      logger.info(`Trade ID: ${order.tradeId}`);
      logger.info(`Fill Price: $${order.price.toFixed(2)}`);
      logger.info('');

      // Track position
      this.activePositions.set(order.tradeId, {
        tradeId: order.tradeId,
        symbol: Config.TRADING_SYMBOL,
        signal,
        strategyName,
        entryPrice: order.price,
        units: order.units,
        stopLoss: levels.stopLoss,
        takeProfit1: levels.takeProfit1,
        takeProfit2: levels.takeProfit2,
        reason,
        openTime: new Date(),
        tp1Hit: false,
        bestPrice: order.price, // Track best price for trailing stops
        currentStopLoss: levels.stopLoss
      });

      // Persist position to file
      this.savePositions();

      // Record in strategy tracker
      this.tracker.recordSignal(
        strategyName,
        signal,
        order.price,
        levels.stopLoss,
        levels.takeProfit1,
        levels.takeProfit2,
        Math.abs(order.units),
        reason,
        confidence
      );

      // Notify via Telegram
      if (this.telegramBot) {
        try {
          await this.telegramBot.notifyTradeOpened(
            Config.TRADING_SYMBOL,
            signal,
            order.price,
            Math.abs(order.units),
            levels.stopLoss,
            levels.takeProfit1,
            reason,
            strategyName,
            confidence
          );
        } catch (telegramError) {
          logger.warn(`Failed to send trade notification: ${telegramError.message}`);
        }
      }

    } catch (error) {
      logger.error(`Failed to execute trade: ${error.message}`);
      if (this.telegramBot) {
        try {
          await this.telegramBot.notifyError(`Trade execution failed: ${error.message}`);
        } catch (telegramError) {
          logger.warn(`Failed to send Telegram notification: ${telegramError.message}`);
        }
      }
    }
  }

  /**
   * Monitor existing positions
   */
  async monitorPositions() {
    try {
      const openTrades = await this.client.getOpenTrades();

      for (const trade of openTrades) {
        const tracked = this.activePositions.get(trade.tradeId);
        if (!tracked) {
          logger.warn(`⚠️ Trade ${trade.tradeId} not in activePositions (keys: [${Array.from(this.activePositions.keys()).join(', ')}])`);
          continue;
        }

        logger.info(`📍 Monitoring trade ${trade.tradeId}: ${trade.units} units @ $${trade.price.toFixed(2)}, P&L: $${trade.unrealizedPL.toFixed(2)}`);

        // Staged TP logic - only runs when ENABLE_STAGED_TP is true
        // When single TP mode is used, Oanda handles TP automatically
        if (Config.ENABLE_STAGED_TP && !tracked.tp1Hit) {
          const currentPrice = await this.client.getPrice(trade.instrument);
          const price = currentPrice.mid;

          const isLong = trade.units > 0;
          const tp1Hit = isLong
            ? price >= tracked.takeProfit1
            : price <= tracked.takeProfit1;

          logger.info(`   TP1 Check: price=$${price.toFixed(2)}, TP1=$${tracked.takeProfit1?.toFixed(2)}, isLong=${isLong}, tp1Hit=${tp1Hit}`);

          if (tp1Hit) {
            logger.info(`🎯 TP1 reached for ${trade.tradeId} at $${price.toFixed(2)}`);

            // Close 60% of position
            const closeUnits = Math.floor(Math.abs(trade.units) * 0.6);

            // For Oanda, units must be a string - try integer format first
            // Oanda shows units as "159.0" but accepts integer strings for close
            const unitsToClose = String(closeUnits);

            logger.info(`📊 Attempting to close ${unitsToClose} units (60% of ${Math.abs(trade.units)})`);

            try {
              // Validate units before sending
              if (closeUnits <= 0 || isNaN(closeUnits)) {
                logger.error(`Invalid closeUnits calculated: ${closeUnits} from units: ${trade.units}`);
                continue;
              }

              // Use Oanda's trade close endpoint for partial close
              const response = await this.client.makeRequest('PUT',
                `/v3/accounts/${this.client.accountId}/trades/${trade.tradeId}/close`,
                { units: unitsToClose }
              );

              const partialClose = {
                success: response.orderFillTransaction ? true : false,
                pl: response.orderFillTransaction?.pl || 0
              };

              if (partialClose.success) {
                const pnl = parseFloat(partialClose.pl || 0);
                logger.info(`✅ Closed 60% (${closeUnits} units) - Banked: $${pnl.toFixed(2)}`);

                // Move stop to breakeven on remaining 40%
                await this.client.modifyTrade(trade.tradeId, tracked.entryPrice, null);
                logger.info(`✅ Stop moved to breakeven ($${tracked.entryPrice.toFixed(2)})`);

                // Set TP2 on remaining 40%
                await this.client.modifyTrade(trade.tradeId, null, tracked.takeProfit2);
                logger.info(`✅ TP2 set at $${tracked.takeProfit2.toFixed(2)} for remaining 40%`);

                tracked.tp1Hit = true;

                // Persist updated position state
                this.savePositions();

                if (this.telegramBot) {
                  try {
                    // Escape underscores in symbol for Markdown
                    const symbolEscaped = trade.instrument.replace(/_/g, '\\_');

                    await this.telegramBot.sendNotification(
                      `🎯 *TP1 Hit - 60% Closed!*\n\n` +
                      `${symbolEscaped}\n` +
                      `Closed: ${closeUnits} units\n` +
                      `Banked: $${pnl.toFixed(2)}\n\n` +
                      `Remaining 40%:\n` +
                      `Stop: Breakeven ($${tracked.entryPrice.toFixed(2)})\n` +
                      `TP2: $${tracked.takeProfit2.toFixed(2)}`
                    );
                  } catch (telegramError) {
                    logger.warn(`Failed to send TP1 notification: ${telegramError.message}`);
                  }
                }
              }
            } catch (error) {
              logger.error(`Failed to close 60% at TP1: ${error.message}`);
            }
          }
        }

        // Trailing stop logic - activates when price has moved enough in our favor:
        // 1. After TP1 is hit (staged TP mode), OR
        // 2. After price moves by TRAILING_ACTIVATION_PIPS in our favor
        // This prevents trailing from triggering too early and closing at breakeven
        if (Config.ENABLE_TRAILING_STOP) {
          const currentPrice = await this.client.getPrice(trade.instrument);
          const price = currentPrice.mid;
          const isLong = trade.units > 0;
          const trailDistance = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS);

          // Calculate how much price has moved in our favor
          const profitMove = isLong
            ? price - tracked.entryPrice
            : tracked.entryPrice - price;

          // Activate trailing when:
          // - TP1 already hit (staged TP mode), OR
          // - Price moved in our favor by activation threshold
          // Breakout trades use wider activation ($3.50) to let the move establish
          const isBreakoutTrade = tracked.strategyName?.includes('Breakout');
          const activationPips = isBreakoutTrade ? Config.BREAKOUT_TRAILING_ACTIVATION_PIPS : Config.TRAILING_ACTIVATION_PIPS;
          const activationDistance = Config.pipsToPrice(activationPips);
          const shouldTrail = tracked.tp1Hit || profitMove >= activationDistance;

          if (shouldTrail) {
            // Update best price if price moved favorably
            const priceMovedFavorably = isLong
              ? price > tracked.bestPrice
              : price < tracked.bestPrice;

            if (priceMovedFavorably) {
              tracked.bestPrice = price;

              // Calculate new trailing stop
              const newStopLoss = isLong
                ? price - trailDistance
                : price + trailDistance;

              // Only update if new stop is better than current stop
              const stopImproved = isLong
                ? newStopLoss > tracked.currentStopLoss
                : newStopLoss < tracked.currentStopLoss;

              if (stopImproved) {
                try {
                  await this.client.modifyTrade(trade.tradeId, newStopLoss, null);

                  const profitLocked = isLong
                    ? newStopLoss - tracked.entryPrice
                    : tracked.entryPrice - newStopLoss;

                  if (profitLocked > 0) {
                    logger.info(`📈 Trailing stop: ${trade.tradeId} @ $${newStopLoss.toFixed(2)} (locks in $${profitLocked.toFixed(2)} profit per unit)`);
                  } else {
                    logger.info(`📈 Trailing stop: ${trade.tradeId} @ $${newStopLoss.toFixed(2)} (trailing $${trailDistance.toFixed(2)} behind $${price.toFixed(2)})`);
                  }

                  tracked.currentStopLoss = newStopLoss;

                  // Persist updated position state
                  this.savePositions();
                } catch (error) {
                  logger.error(`Failed to update trailing stop: ${error.message}`);
                }
              }
            }
          }
        }
      }

      // Check for closed positions
      const closedTrades = Array.from(this.activePositions.keys()).filter(
        tradeId => !openTrades.some(t => t.tradeId === tradeId)
      );

      for (const tradeId of closedTrades) {
        const tracked = this.activePositions.get(tradeId);
        this.activePositions.delete(tradeId);

        // Persist removal
        this.savePositions();

        logger.info(`Trade ${tradeId} was closed`);

        // Fetch close details from transaction history
        try {
          const response = await this.client.makeRequest('GET', `/v3/accounts/${this.client.accountId}/trades/${tradeId}`);
          if (response.trade && response.trade.state === 'CLOSED') {
            const trade = response.trade;
            const entryPrice = parseFloat(trade.price);
            const exitPrice = parseFloat(trade.averageClosePrice || entryPrice);
            const pnl = parseFloat(trade.realizedPL || 0);
            const pnlPct = (pnl / (entryPrice * Math.abs(parseFloat(trade.initialUnits)))) * 100;

            const reason = trade.closeReason || 'Unknown';

            logger.info(`💰 P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)`);
            logger.info(`Reason: ${reason}`);

            // Set cooldown timer to prevent rapid re-entries
            this.lastTradeCloseTime = Date.now();
            this.saveCooldown();
            logger.info(`⏳ Trade cooldown started - next trade in ${Config.TRADE_COOLDOWN_HOURS} hours`);

            // Notify via Telegram
            if (this.telegramBot) {
              try {
                await this.telegramBot.notifyTradeClosed(
                  tracked.symbol,
                  entryPrice,
                  exitPrice,
                  pnl,
                  pnlPct,
                  reason,
                  tracked.strategyName
                );
              } catch (telegramError) {
                logger.warn(`Failed to send trade closed notification: ${telegramError.message}`);
              }
            }

            // Update risk manager
            this.riskManager.recordTrade(pnl);

            // Update strategy tracker
            this.tracker.closeTrade(tracked.strategyName, `LIVE_${trade.id}`, exitPrice, reason);
          }
        } catch (error) {
          logger.warn(`Could not fetch close details for trade ${tradeId}: ${error.message}`);
        }
      }

    } catch (error) {
      logger.error(`Error monitoring positions: ${error.message}`);
    }
  }

  /**
   * Check for real-time breakouts (runs every 30 seconds)
   * Detects breakouts as they happen, not just at candle close
   * With MTF enabled, waits for pullback before entering
   */
  async checkRealtimeBreakout() {
    try {
      logger.debug('🔍 Realtime check starting...');

      // Only check if using breakout strategy
      if (Config.STRATEGY_TYPE !== 'breakout_adx') {
        logger.debug('🔍 Realtime check skipped - not breakout_adx strategy');
        return;
      }

      // Check if we already have a position
      const existingTrades = await this.client.getOpenTrades();
      const hasPosition = existingTrades.some(t => t.instrument === Config.TRADING_SYMBOL);
      if (hasPosition) {
        logger.debug('🔍 Realtime check skipped - already have position');
        // Clear any pending MTF signal if we have a position
        if (this.breakoutStrategy.hasRealtimeMTFPending()) {
          this.breakoutStrategy.clearRealtimeMTF();
        }
        return;
      }

      // Check trade cooldown (prevents rapid re-entries after losses)
      const cooldown = this.checkTradeCooldown();
      if (cooldown.active) {
        logger.debug(`🔍 Realtime check skipped - cooldown active (${cooldown.remainingMinutes}m remaining)`);
        return;
      }

      // Check trading hours (avoid Asian session with low liquidity and wild wicks)
      const tradingHours = this.checkTradingHours();
      if (!tradingHours.allowed) {
        logger.debug(`🔍 Realtime check skipped - ${tradingHours.reason}`);
        return;
      }

      // Check if there's a pending candle-based MTF signal (don't interfere)
      if (this.breakoutStrategy.pendingSignal) {
        logger.debug('🔍 Realtime check skipped - pending candle-based MTF signal');
        return;
      }

      // Fetch current price
      const priceData = await this.client.getPrice(Config.TRADING_SYMBOL);
      const currentPrice = priceData.mid;
      logger.debug(`🔍 Realtime: Price=$${currentPrice.toFixed(2)}`);

      // Check if there's a pending realtime MTF signal waiting for pullback
      if (this.breakoutStrategy.hasRealtimeMTFPending()) {
        const mtfResult = this.breakoutStrategy.checkRealtimeMTFEntry(currentPrice);

        if (mtfResult.pending) {
          // Log pending status periodically (not every check to reduce noise)
          if (!this.lastRealtimeMTFLog || Date.now() - this.lastRealtimeMTFLog >= 30000) {
            logger.info(`⏳ Realtime MTF: ${mtfResult.reason}`);
            this.lastRealtimeMTFLog = Date.now();
          }
          return;
        }

        if (mtfResult.signal) {
          // MTF pullback entry found!
          logger.info('');
          logger.info('🎯 REALTIME MTF PULLBACK ENTRY!');
          logger.info(`Signal: ${mtfResult.signal}`);
          logger.info(`Entry: $${mtfResult.entryPrice.toFixed(2)}`);
          logger.info(`Confidence: ${mtfResult.confidence}%`);
          logger.info(`Reason: ${mtfResult.reason}`);
          logger.info('');

          // Fetch candles for indicator calculation
          const candles = await this.client.getCandles(Config.TRADING_SYMBOL, Config.TIMEFRAME, 60);
          const completeCandles = candles.filter(c => c.complete);
          const analysis = this.ta.analyze(completeCandles);

          // Calculate entry levels
          const levels = this.breakoutStrategy.calculateEntryLevels(analysis, mtfResult.signal, mtfResult.entryPrice);

          // Calculate position size
          const positionSize = this.riskManager.calculatePositionSize(levels.entryPrice, levels.stopLoss);

          if (positionSize === 0) {
            logger.error('Position size calculation failed');
            return;
          }

          // Adjust units for direction
          const units = mtfResult.signal === 'LONG' ? positionSize : -positionSize;

          // Check risk management
          const canTrade = await this.riskManager.canOpenTrade(levels.entryPrice, levels.stopLoss, Math.abs(units));

          if (!canTrade.allowed) {
            logger.risk(`Trade blocked: ${canTrade.reason}`);
            return;
          }

          // Execute trade
          await this.executeTrade(
            mtfResult.signal,
            units,
            levels,
            mtfResult.reason,
            'Breakout + ADX (Realtime MTF)',
            mtfResult.confidence
          );
          return;
        }

        // MTF signal was cleared (timeout or other reason) - continue to check for new breakouts
      }

      // Fetch recent candles for indicator calculation (need ~50 for ADX/RSI)
      const candles = await this.client.getCandles(Config.TRADING_SYMBOL, Config.TIMEFRAME, 60);
      const completeCandles = candles.filter(c => c.complete);

      if (completeCandles.length < 50) {
        logger.debug('🔍 Realtime check skipped - insufficient candles');
        return;
      }

      // Calculate indicators
      const analysis = this.ta.analyze(completeCandles);
      const adx = analysis.indicators.adx;
      const rsi = analysis.indicators.rsi;
      logger.debug(`🔍 Realtime: ADX=${adx?.toFixed(1)}, RSI=${rsi?.toFixed(1)}, Channel=$${this.breakoutStrategy.previousLow?.toFixed(2)}-$${this.breakoutStrategy.previousHigh?.toFixed(2)}`);

      // Check for real-time breakout
      const result = this.breakoutStrategy.checkRealtimeBreakout(currentPrice, adx, rsi);
      logger.debug(`🔍 Realtime result: signal=${result.signal}, pending=${result.pending}, pendingMTF=${result.pendingMTF}, reason=${result.reason?.substring(0, 50)}...`);

      if (result.pending) {
        // Log pending status periodically (not every check to reduce noise)
        if (!this.lastRealtimeLog || Date.now() - this.lastRealtimeLog >= 30000) {
          logger.info(`⏳ Realtime: ${result.reason}`);
          this.lastRealtimeLog = Date.now();
        }
        return;
      }

      if (result.pendingMTF) {
        // Breakout confirmed, now waiting for MTF pullback
        logger.info(`⏳ Realtime: ${result.reason}`);
        return;
      }

      if (!result.signal) {
        // No breakout - nothing to do
        return;
      }

      // We have a confirmed real-time breakout signal (MTF disabled)
      logger.info('');
      logger.info('🎯 REAL-TIME BREAKOUT SIGNAL!');
      logger.info(`Signal: ${result.signal}`);
      logger.info(`Entry: $${result.entryPrice.toFixed(2)}`);
      logger.info(`Confidence: ${result.confidence}%`);
      logger.info(`Reason: ${result.reason}`);
      logger.info('');

      // Calculate entry levels
      const levels = this.breakoutStrategy.calculateEntryLevels(analysis, result.signal, result.entryPrice);

      // Calculate position size
      const positionSize = this.riskManager.calculatePositionSize(levels.entryPrice, levels.stopLoss);

      if (positionSize === 0) {
        logger.error('Position size calculation failed');
        return;
      }

      // Adjust units for direction
      const units = result.signal === 'LONG' ? positionSize : -positionSize;

      // Check risk management
      const canTrade = await this.riskManager.canOpenTrade(levels.entryPrice, levels.stopLoss, Math.abs(units));

      if (!canTrade.allowed) {
        logger.risk(`Trade blocked: ${canTrade.reason}`);
        return;
      }

      // Execute trade
      await this.executeTrade(
        result.signal,
        units,
        levels,
        result.reason,
        'Breakout + ADX (Realtime)',
        result.confidence
      );

    } catch (error) {
      logger.error(`Error in realtime breakout check: ${error.message}`);
    }
  }

  /**
   * Graceful shutdown
   */
  async shutdown() {
    logger.info('');
    logger.info('🛑 Shutting down bot...');

    this.isRunning = false;

    try {
      // Stop Telegram bot
      if (this.telegramBot) {
        await this.telegramBot.stop();
      }

      // Display final summary
      const summary = await this.riskManager.getPortfolioSummary();
      if (summary) {
        logger.info('');
        logger.info('📊 FINAL SUMMARY');
        logger.info('─'.repeat(60));
        logger.info(`Balance: $${summary.balance.toFixed(2)}`);
        logger.info(`Total P&L: $${summary.totalPnL.toFixed(2)} (${summary.totalPnLPct >= 0 ? '+' : ''}${summary.totalPnLPct.toFixed(2)}%)`);
        logger.info(`Daily P&L: $${summary.dailyPnL.toFixed(2)}`);
        logger.info(`Total Trades: ${summary.totalTrades}`);
        logger.info(`Win Rate: ${summary.winRate.toFixed(1)}%`);
        logger.info(`Open Positions: ${summary.openPositions}`);
        logger.info('─'.repeat(60));
      }

      logger.info('');
      logger.info('✅ Bot stopped cleanly');
      process.exit(0);
    } catch (error) {
      logger.error(`Error during shutdown: ${error.message}`);
      process.exit(1);
    }
  }
}

// Global error handlers to prevent crashes
process.on('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Promise Rejection: ${reason}`);
  logger.warn('Bot will continue running despite the error');
  // Don't exit - keep the bot running
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.message}`);
  logger.error(error.stack);
  logger.warn('Bot will attempt to continue running');
  // Don't exit immediately - give it a chance to recover
});

// Start the bot
const bot = new GoldTradingBot();
bot.start().catch(error => {
  logger.error(`Fatal error during startup: ${error.message}`);
  logger.error(error.stack);
  process.exit(1);
});

export default GoldTradingBot;
