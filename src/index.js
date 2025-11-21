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
import RiskManager from './risk_manager.js';
import GoldTelegramBot from './telegram_bot.js';

class GoldTradingBot {
  constructor() {
    this.isRunning = false;
    this.startTime = null;
    this.logger = logger;

    // Initialize components
    this.client = new OandaClient(logger);
    this.ta = new TechnicalAnalysis(logger);
    this.strategy = new TripleConfirmationStrategy(logger, this.ta);
    this.riskManager = new RiskManager(logger, this.client);

    // Telegram bot (optional)
    this.telegramBot = null;

    // Track active positions
    this.activePositions = new Map();

    logger.info('🤖 Gold Trading Bot initialized');
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
        logger.info('Starting Telegram bot...');
        this.telegramBot = new GoldTelegramBot(logger, this);
        await this.telegramBot.start();
      }

      // Display strategy information
      logger.info('');
      logger.info('📊 Strategy: ' + this.strategy.name);
      logger.info(this.strategy.getDescription());
      logger.info('');

      // Set running flag
      this.isRunning = true;
      this.startTime = Date.now();

      // Schedule market scans
      const scanInterval = `*/${Config.SCAN_INTERVAL_MINUTES} * * * *`;
      logger.info(`⏰ Scheduling market scans every ${Config.SCAN_INTERVAL_MINUTES} minutes`);

      cron.schedule(scanInterval, async () => {
        if (this.isRunning) {
          await this.scanMarket();
        }
      });

      // Run initial scan
      logger.info('Running initial market scan...');
      await this.scanMarket();

      // Schedule daily reset (at midnight UTC)
      cron.schedule('0 0 * * *', async () => {
        this.riskManager.resetDailyStats();
        logger.info('📅 Daily statistics reset');
      });

      // Monitor existing positions every minute
      cron.schedule('* * * * *', async () => {
        if (this.isRunning) {
          await this.monitorPositions();
        }
      });

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

      // Evaluate strategy
      const setup = this.strategy.evaluateSetup(analysis);

      if (!setup.signal) {
        logger.info(`No setup: ${setup.reason}`);
        return;
      }

      // We have a signal!
      logger.info('');
      logger.info('🎯 TRADE SETUP DETECTED!');
      logger.info(`Signal: ${setup.signal}`);
      logger.info(`Confidence: ${setup.confidence}%`);
      logger.info(`Reason: ${setup.reason}`);
      logger.info('');

      // Check if we already have a position in this instrument
      const existingTrades = await this.client.getOpenTrades();
      const hasPosition = existingTrades.some(t => t.instrument === Config.TRADING_SYMBOL);

      if (hasPosition) {
        logger.info('❌ Already have open position in XAU_USD - skipping');
        return;
      }

      // Calculate entry levels
      const levels = this.strategy.calculateEntryLevels(analysis, setup.signal);

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
      const units = setup.signal === 'LONG' ? positionSize : -positionSize;

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

      // Execute trade
      await this.executeTrade(setup.signal, units, levels, setup.reason);

    } catch (error) {
      logger.error(`Error scanning market: ${error.message}`);
      if (this.telegramBot) {
        await this.telegramBot.notifyError(`Market scan error: ${error.message}`);
      }
    }
  }

  /**
   * Execute a trade
   */
  async executeTrade(signal, units, levels, reason) {
    try {
      logger.info('');
      logger.info('🎬 EXECUTING TRADE...');
      logger.info(`Side: ${signal}`);
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
        signal,
        entryPrice: order.price,
        units: order.units,
        stopLoss: levels.stopLoss,
        takeProfit1: levels.takeProfit1,
        takeProfit2: levels.takeProfit2,
        reason,
        openTime: new Date(),
        tp1Hit: false
      });

      // Notify via Telegram
      if (this.telegramBot) {
        await this.telegramBot.notifyTradeOpened(
          Config.TRADING_SYMBOL,
          signal,
          order.price,
          Math.abs(order.units),
          levels.stopLoss,
          levels.takeProfit1,
          reason
        );
      }

    } catch (error) {
      logger.error(`Failed to execute trade: ${error.message}`);
      if (this.telegramBot) {
        await this.telegramBot.notifyError(`Trade execution failed: ${error.message}`);
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
            const closeUnitsWithSign = isLong ? -closeUnits : closeUnits;

            try {
              const partialClose = await this.client.placeMarketOrder(
                trade.instrument,
                closeUnitsWithSign,
                null // No stop loss on closing order
              );

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
                  await this.telegramBot.sendNotification(
                    `🎯 *TP1 Hit - 60% Closed!*\n\n` +
                    `${trade.instrument}\n` +
                    `Closed: ${closeUnits} units\n` +
                    `Banked: \\$${pnl.toFixed(2)}\n\n` +
                    `Remaining 40%:\n` +
                    `Stop: Breakeven (\\$${tracked.entryPrice.toFixed(2)})\n` +
                    `TP2: \\$${tracked.takeProfit2.toFixed(2)}`
                  );
                }
              }
            } catch (error) {
              logger.error(`Failed to close 60% at TP1: ${error.message}`);
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
              await this.telegramBot.notifyTradeClosed(
                tracked.symbol,
                entryPrice,
                exitPrice,
                pnl,
                pnlPct,
                reason
              );
            }

            // Update risk manager
            this.riskManager.recordClosedTrade({
              entryPrice,
              exitPrice,
              size: Math.abs(parseFloat(trade.initialUnits)),
              pnl,
              winningTrade: pnl > 0
            });
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

// Start the bot
const bot = new GoldTradingBot();
bot.start().catch(error => {
  logger.error(`Fatal error: ${error.message}`);
  process.exit(1);
});

export default GoldTradingBot;
