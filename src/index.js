/**
 * Gold Trading Bot - Main Entry Point
 * Automated XAU/USD trading using Triple Confirmation Strategy on Oanda
 */
import cron from 'node-cron';
import Config from './config.js';
import logger from './logger.js';
import OandaClient from './oanda_client.js';
import TechnicalAnalysis from './technical_analysis.js';
import TripleConfirmationStrategy from './strategy.js';
import MACrossoverStrategy from './ma_crossover_strategy.js';
import RiskManager from './risk_manager.js';
import GoldTelegramBot from './telegram_bot.js';
import StrategyTracker from './strategy_tracker.js';

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
    this.maStrategy = new MACrossoverStrategy(logger, this.ta);

    // Determine which strategy trades live (from config)
    const liveStrategyName = Config.STRATEGY_TYPE === 'ma_crossover'
      ? 'MA Crossover (5/20)'
      : 'Triple Confirmation';

    this.liveStrategy = Config.STRATEGY_TYPE === 'ma_crossover'
      ? this.maStrategy
      : this.tripleStrategy;

    // Initialize strategy tracker
    this.tracker = new StrategyTracker();
    this.tracker.registerStrategy('Triple Confirmation', liveStrategyName === 'Triple Confirmation');
    this.tracker.registerStrategy('MA Crossover (5/20)', liveStrategyName === 'MA Crossover (5/20)');

    logger.info(`🟢 LIVE Strategy: ${liveStrategyName}`);
    logger.info(`📝 HYPOTHETICAL Strategy: ${liveStrategyName === 'Triple Confirmation' ? 'MA Crossover (5/20)' : 'Triple Confirmation'}`);

    this.riskManager = new RiskManager(logger, this.client);

    // Telegram bot (optional)
    this.telegramBot = null;

    // Track active positions
    this.activePositions = new Map();

    // Track last API error notification (to avoid spam)
    this.lastApiErrorNotification = null;

    logger.info(`🤖 ${Config.BOT_NAME} initialized`);
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

      // Start Telegram bot if enabled
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
      const hypotheticalStrategy = this.liveStrategy === this.tripleStrategy ? this.maStrategy : this.tripleStrategy;
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
            scheduleNextScan();
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
            if (this.isRunning) {
              try {
                await this.monitorPositions();
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
            scheduleNextMonitor();
          }
        }, 60000);
      };

      scheduleNextMonitor();
      logger.info(`✅ Recursive setTimeout initialized for position monitoring`);

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

      // Get historical candles
      const candles = await this.client.getCandles(
        Config.TRADING_SYMBOL,
        Config.TIMEFRAME,
        200
      );

      if (candles.length < 100) {
        logger.warn('Insufficient candle data');
        return;
      }

      // Perform technical analysis
      const analysis = this.ta.analyze(candles);
      this.ta.logAnalysis(analysis);

      // Evaluate BOTH strategies
      const tripleSetup = this.tripleStrategy.evaluateSetup(analysis);
      const maSetup = this.maStrategy.evaluateSetup(analysis, candles);

      logger.info('');
      logger.info('─'.repeat(70));
      logger.info('📊 STRATEGY EVALUATION RESULTS:');
      logger.info('─'.repeat(70));
      logger.info(`🟢 Triple Confirmation: ${tripleSetup.signal || 'NO SIGNAL'} (${tripleSetup.confidence}%) - ${tripleSetup.reason}`);
      logger.info(`📝 MA Crossover (5/20): ${maSetup.signal || 'NO SIGNAL'} (${maSetup.confidence}%) - ${maSetup.reason}`);
      logger.info('─'.repeat(70));
      logger.info('');

      // Determine which setup to use for live trading
      const liveSetup = this.liveStrategy === this.tripleStrategy ? tripleSetup : maSetup;
      const hypotheticalSetup = this.liveStrategy === this.tripleStrategy ? maSetup : tripleSetup;
      const liveStrategyName = this.liveStrategy === this.tripleStrategy ? 'Triple Confirmation' : 'MA Crossover (5/20)';
      const hypotheticalStrategyName = this.liveStrategy === this.tripleStrategy ? 'MA Crossover (5/20)' : 'Triple Confirmation';

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

      // Calculate entry levels for LIVE strategy
      const levels = this.liveStrategy === this.maStrategy
        ? this.liveStrategy.calculateEntryLevels(analysis, liveSetup.signal, maSetup.sma20)
        : this.liveStrategy.calculateEntryLevels(analysis, liveSetup.signal);

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
        const hypotheticalLevels = this.liveStrategy === this.tripleStrategy
          ? this.maStrategy.calculateEntryLevels(analysis, hypotheticalSetup.signal, maSetup.sma20)
          : this.tripleStrategy.calculateEntryLevels(analysis, hypotheticalSetup.signal);

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
      logger.info(`Take Profit 1: $${levels.takeProfit1.toFixed(2)}`);
      logger.info(`Take Profit 2: $${levels.takeProfit2.toFixed(2)}`);
      logger.info('');

      // Place market order with stop loss only
      const order = await this.client.placeMarketOrder(
        Config.TRADING_SYMBOL,
        units,
        levels.stopLoss
      );

      if (!order.success) {
        logger.error(`Order failed: ${order.reason}`);
        if (order.rejectReason) {
          logger.error(`Reject reason: ${order.rejectReason}`);
        }
        return;
      }

      // Note: TP will be managed manually for partial exits
      // We'll close 60% at TP1, then 40% at TP2
      logger.info(`📊 TP1 target: $${levels.takeProfit1.toFixed(2)} (will close 60%)`);
      logger.info(`📊 TP2 target: $${levels.takeProfit2.toFixed(2)} (will close 40%)`);


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
        if (!tracked) continue;

        // Check if TP1 was hit - close 60% and move stop to breakeven
        if (!tracked.tp1Hit) {
          const currentPrice = await this.client.getPrice(trade.instrument);
          const price = currentPrice.mid;

          const isLong = trade.currentUnits > 0;
          const tp1Hit = isLong
            ? price >= tracked.takeProfit1
            : price <= tracked.takeProfit1;

          if (tp1Hit) {
            logger.info(`🎯 TP1 reached for ${trade.tradeId} at $${price.toFixed(2)}`);

            // Close 60% of position
            const closeUnits = Math.floor(Math.abs(trade.currentUnits) * 0.6);

            // For Oanda, we need to specify the REMAINING units as a string with "REDUCE_ONLY"
            // To close 60%, we reduce by that amount
            const unitsToClose = String(closeUnits);

            try {
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
                await this.client.modifyTrade(trade.tradeId, {
                  stopLoss: { price: tracked.entryPrice.toFixed(2) }
                });
                logger.info(`✅ Stop moved to breakeven ($${tracked.entryPrice.toFixed(2)})`);

                // Set TP2 on remaining 40%
                await this.client.modifyTrade(trade.tradeId, {
                  takeProfit: { price: tracked.takeProfit2.toFixed(2) }
                });
                logger.info(`✅ TP2 set at $${tracked.takeProfit2.toFixed(2)} for remaining 40%`);

                tracked.tp1Hit = true;

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

        // Trailing stop logic (only after TP1 is hit)
        if (tracked.tp1Hit && Config.ENABLE_TRAILING_STOP) {
          const currentPrice = await this.client.getPrice(trade.instrument);
          const price = currentPrice.mid;
          const isLong = trade.currentUnits > 0;

          // Update best price if price moved favorably
          const priceMovedFavorably = isLong
            ? price > tracked.bestPrice
            : price < tracked.bestPrice;

          if (priceMovedFavorably) {
            tracked.bestPrice = price;

            // Calculate new trailing stop
            const trailDistance = Config.pipsToPrice(Config.TRAILING_STOP_DISTANCE_PIPS);
            const newStopLoss = isLong
              ? price - trailDistance
              : price + trailDistance;

            // Only update if new stop is better than current stop
            const stopImproved = isLong
              ? newStopLoss > tracked.currentStopLoss
              : newStopLoss < tracked.currentStopLoss;

            if (stopImproved) {
              try {
                await this.client.modifyTrade(trade.tradeId, {
                  stopLoss: { price: newStopLoss.toFixed(2) }
                });

                logger.info(`📈 Trailing stop updated for ${trade.tradeId}: $${newStopLoss.toFixed(2)} (trailing $${trailDistance.toFixed(2)} behind $${price.toFixed(2)})`);

                tracked.currentStopLoss = newStopLoss;
              } catch (error) {
                logger.error(`Failed to update trailing stop: ${error.message}`);
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
