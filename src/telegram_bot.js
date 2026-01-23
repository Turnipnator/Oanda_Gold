/**
 * Telegram Bot Integration for Gold Trading Bot
 * Provides remote control and monitoring via Telegram
 * Replicates Binance bot command structure exactly
 */
import TelegramBot from 'node-telegram-bot-api';
import Config from './config.js';

class GoldTelegramBot {
  constructor(logger, tradingBot = null) {
    this.logger = logger;
    this.tradingBot = tradingBot;
    this.authorizedUsers = Config.getTelegramUsers();
    this.bot = null;

    // Statistics
    this.startTime = new Date();
    this.notificationsSent = 0;
    this.commandsExecuted = 0;

    if (this.authorizedUsers.length === 0) {
      this.logger.warn('No authorized Telegram users configured');
    } else {
      this.logger.info(`Telegram bot initialized with ${this.authorizedUsers.length} authorized users`);
    }
  }

  /**
   * Check if user is authorized
   */
  isAuthorized(userId) {
    return this.authorizedUsers.includes(userId);
  }

  /**
   * Start the Telegram bot
   */
  async start() {
    try {
      this.bot = new TelegramBot(Config.TELEGRAM_BOT_TOKEN, {
        polling: {
          interval: 2000,           // Poll every 2 seconds between requests
          params: { timeout: 30 }   // Tell Telegram to hold connection for up to 30s waiting for updates
        },
        request: {
          timeout: 40000            // HTTP timeout MUST be longer than polling timeout (30s + 10s buffer)
        }
      });

      // Register command handlers
      this.bot.onText(/\/start/, (msg) => this.handleStart(msg));
      this.bot.onText(/\/status/, (msg) => this.handleStatus(msg));
      this.bot.onText(/\/positions/, (msg) => this.handlePositions(msg));
      this.bot.onText(/\/pnl/, (msg) => this.handlePnL(msg));
      this.bot.onText(/\/profit/, (msg) => this.handlePnL(msg)); // Alias
      this.bot.onText(/\/balance/, (msg) => this.handleBalance(msg));
      this.bot.onText(/\/compare/, (msg) => this.handleCompare(msg));
      this.bot.onText(/\/stop/, (msg) => this.handleStop(msg));
      this.bot.onText(/\/resume/, (msg) => this.handleResume(msg));
      this.bot.onText(/\/emergency/, (msg) => this.handleEmergency(msg));
      this.bot.onText(/\/help/, (msg) => this.handleHelp(msg));

      // Handle callback queries (button presses)
      this.bot.on('callback_query', (query) => this.handleCallback(query));

      // Error handling - CRITICAL: Don't let Telegram errors crash the main bot
      this.bot.on('polling_error', (error) => {
        // Log the error but don't throw - we want the bot to keep running
        this.logger.warn(`Telegram polling error (non-fatal): ${error.message}`);

        // If it's a network error, it will auto-retry - no action needed
        if (error.code === 'EFATAL' || error.code === 'ETELEGRAM') {
          this.logger.warn('Telegram connection issue - will auto-reconnect');
        }
      });

      // Catch any unhandled errors from the Telegram bot
      this.bot.on('error', (error) => {
        this.logger.error(`Telegram bot error: ${error.message}`);
        // Don't throw - keep main bot running
      });

      // Catch webhook errors
      this.bot.on('webhook_error', (error) => {
        this.logger.error(`Telegram webhook error: ${error.message}`);
      });

      this.logger.info('✅ Telegram bot started successfully!');

      // Send startup notification
      await this.sendNotification(
        '🤖 *Gold Trading Bot Started*\n\n' +
        'Bot is now running and monitoring XAU/USD.\n' +
        'Use /help to see available commands.'
      );

      return true;
    } catch (error) {
      this.logger.error(`Failed to start Telegram bot: ${error.message}`);
      throw error;
    }
  }

  /**
   * Stop the Telegram bot
   */
  async stop() {
    try {
      if (this.bot) {
        await this.sendNotification('🛑 *Gold Trading Bot Stopped*\n\nBot has shut down.');
        await this.bot.stopPolling();
        this.logger.info('Telegram bot stopped');
      }
    } catch (error) {
      this.logger.error(`Error stopping Telegram bot: ${error.message}`);
    }
  }

  /**
   * Handle /start command
   */
  async handleStart(msg) {
    const userId = msg.from.id;

    if (!this.isAuthorized(userId)) {
      await this.bot.sendMessage(
        msg.chat.id,
        '⛔ Unauthorized access. Your user ID has been logged.'
      );
      this.logger.warn(`Unauthorized access attempt from user ${userId}`);
      return;
    }

    const welcomeMessage =
      '🤖 *Gold Trading Bot Control Panel*\n\n' +
      'Welcome! You can now control and monitor your XAU/USD trading bot.\n\n' +
      '*Available Commands:*\n' +
      '/status - Bot status and summary\n' +
      '/positions - View open positions\n' +
      '/pnl - Profit & Loss report\n' +
      '/balance - Account balance\n' +
      '/stop - Stop trading gracefully\n' +
      '/resume - Resume trading\n' +
      '/emergency - Emergency stop (close all)\n' +
      '/help - Show all commands\n\n' +
      '📊 Real-time trade notifications enabled!';

    await this.bot.sendMessage(msg.chat.id, welcomeMessage, { parse_mode: 'Markdown' });
    this.commandsExecuted++;
  }

  /**
   * Handle /status command
   */
  async handleStatus(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    try {
      if (!this.tradingBot) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ Trading bot not connected');
        return;
      }

      const summary = await this.tradingBot.riskManager.getPortfolioSummary();
      if (!summary) {
        await this.bot.sendMessage(msg.chat.id, '❌ Failed to get portfolio summary');
        return;
      }

      const statusEmoji = this.tradingBot.isRunning ? '✅' : '⏸️';
      const statusText = this.tradingBot.isRunning ? 'RUNNING' : 'STOPPED';
      const modeEmoji = Config.TRADING_MODE === 'live' ? '🔴' : '📄';
      const modeText = Config.TRADING_MODE === 'live' ? 'LIVE' : 'PRACTICE';

      const runtime = Date.now() - this.tradingBot.startTime;
      const hours = Math.floor(runtime / 3600000);
      const minutes = Math.floor((runtime % 3600000) / 60000);

      const profitProgress = (summary.dailyPnL / Config.TARGET_DAILY_PROFIT) * 100;
      const lossProgress = summary.dailyPnL < 0
        ? Math.abs(summary.dailyPnL / Config.MAX_DAILY_LOSS) * 100
        : 0;

      const message =
        `${statusEmoji} *BOT STATUS: ${statusText}* ${modeEmoji} *${modeText}*\n\n` +
        `*Account Summary:*\n` +
        `💰 Balance: $${summary.balance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n` +
        `📈 Total P&L: $${summary.totalPnL.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})} (${summary.totalPnLPct >= 0 ? '+' : ''}${summary.totalPnLPct.toFixed(2)}%)\n` +
        `📊 Daily P&L: $${summary.dailyPnL.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n\n` +
        `*Risk Metrics:*\n` +
        `🔥 Portfolio Heat: ${(summary.portfolioHeat * 100).toFixed(1)}%\n` +
        `📍 Open Positions: ${summary.openPositions}\n` +
        `⏱️ Runtime: ${hours}h ${minutes}m\n\n` +
        `*Performance:*\n` +
        `✅ Winning Trades: ${summary.winningTrades}\n` +
        `❌ Losing Trades: ${summary.losingTrades}\n` +
        `📊 Win Rate: ${summary.winRate.toFixed(1)}%\n` +
        `🎯 Total Trades: ${summary.totalTrades}\n\n` +
        `*Daily Targets:*\n` +
        `🎯 Profit: $${summary.dailyPnL.toFixed(2)} / $${Config.TARGET_DAILY_PROFIT.toFixed(2)} (${profitProgress.toFixed(0)}%)\n` +
        `🛡️ Loss Limit: ${lossProgress.toFixed(0)}% used`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
      this.commandsExecuted++;
    } catch (error) {
      this.logger.error(`Error in /status command: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle /positions command
   */
  async handlePositions(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    try {
      if (!this.tradingBot) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ Trading bot not connected');
        return;
      }

      const trades = await this.tradingBot.client.getOpenTrades();

      if (trades.length === 0) {
        await this.bot.sendMessage(msg.chat.id, '📭 No open positions');
        return;
      }

      let message = '📊 *OPEN POSITIONS*\n\n';

      for (let i = 0; i < trades.length; i++) {
        const trade = trades[i];
        const pnlEmoji = trade.unrealizedPL > 0 ? '🟢' : trade.unrealizedPL < 0 ? '🔴' : '⚪';
        const side = trade.units > 0 ? 'LONG' : 'SHORT';
        const pnlPct = ((trade.unrealizedPL / (Math.abs(trade.units) * trade.price)) * 100);

        message +=
          `*${i + 1}. ${trade.instrument} ${side}*\n` +
          `Entry: $${trade.price.toFixed(2)}\n` +
          `Size: ${Math.abs(trade.units)} units\n` +
          `${pnlEmoji} P&L: $${trade.unrealizedPL.toFixed(2)} (${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%)\n`;

        if (trade.stopLoss) {
          message += `Stop: $${trade.stopLoss.toFixed(2)}\n`;
        }
        if (trade.takeProfit) {
          message += `Target: $${trade.takeProfit.toFixed(2)}\n`;
        }

        message += '\n';
      }

      const totalUnrealized = trades.reduce((sum, t) => sum + t.unrealizedPL, 0);
      message += `*Total Unrealized P&L:* $${totalUnrealized.toFixed(2)}`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
      this.commandsExecuted++;
    } catch (error) {
      this.logger.error(`Error in /positions command: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle /pnl command
   */
  async handlePnL(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '📅 Daily', callback_data: 'pnl_daily' },
          { text: '🏆 All Time', callback_data: 'pnl_alltime' }
        ]
      ]
    };

    await this.bot.sendMessage(
      msg.chat.id,
      '📊 *Select Time Period:*',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
    this.commandsExecuted++;
  }

  /**
   * Handle /balance command
   */
  async handleBalance(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    try {
      if (!this.tradingBot) {
        await this.bot.sendMessage(msg.chat.id, '⚠️ Trading bot not connected');
        return;
      }

      const balance = await this.tradingBot.client.getBalance();
      const summary = await this.tradingBot.riskManager.getPortfolioSummary();

      const message =
        '💰 *ACCOUNT BALANCE*\n\n' +
        `*${balance.currency} Balance:*\n` +
        `Balance: $${balance.balance.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n` +
        `NAV: $${balance.nav.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n` +
        `Unrealized P&L: $${balance.unrealizedPL.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n\n` +
        `*Margin:*\n` +
        `Used: $${balance.marginUsed.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n` +
        `Available: $${balance.marginAvailable.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}\n\n` +
        `*Portfolio:*\n` +
        `Total Value: $${summary.portfolioValue.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;

      await this.bot.sendMessage(msg.chat.id, message, { parse_mode: 'Markdown' });
      this.commandsExecuted++;
    } catch (error) {
      this.logger.error(`Error in /balance command: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle /stop command
   */
  async handleStop(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Yes, Stop', callback_data: 'stop_confirm' },
          { text: '❌ Cancel', callback_data: 'stop_cancel' }
        ]
      ]
    };

    await this.bot.sendMessage(
      msg.chat.id,
      '⚠️ *STOP TRADING BOT?*\n\n' +
      'This will:\n' +
      '• Stop opening new positions\n' +
      '• Keep existing positions open\n' +
      '• Continue monitoring for exits\n\n' +
      'Confirm?',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle /resume command
   */
  async handleResume(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    try {
      if (this.tradingBot && !this.tradingBot.isRunning) {
        this.tradingBot.isRunning = true;
        await this.bot.sendMessage(msg.chat.id, '✅ *Bot resumed!* Trading will continue.', { parse_mode: 'Markdown' });
        await this.sendNotification('🟢 *Bot Resumed*\nTrading operations continuing.');
      } else {
        await this.bot.sendMessage(msg.chat.id, 'ℹ️ Bot is already running');
      }
    } catch (error) {
      this.logger.error(`Error in /resume command: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, `❌ Error: ${error.message}`);
    }
  }

  /**
   * Handle /emergency command
   */
  async handleEmergency(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    const keyboard = {
      inline_keyboard: [
        [{ text: '🚨 CONFIRM EMERGENCY STOP', callback_data: 'emergency_confirm' }],
        [{ text: '❌ Cancel', callback_data: 'emergency_cancel' }]
      ]
    };

    await this.bot.sendMessage(
      msg.chat.id,
      '🚨 *EMERGENCY STOP*\n\n' +
      '⚠️ WARNING: This will:\n' +
      '• Close ALL open positions immediately\n' +
      '• Stop the trading bot\n' +
      '• Exit at market prices\n\n' +
      '*Use only in emergencies!*\n\n' +
      'Are you absolutely sure?',
      { parse_mode: 'Markdown', reply_markup: keyboard }
    );
  }

  /**
   * Handle /compare command - Compare strategies
   */
  async handleCompare(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    try {
      if (!this.tradingBot || !this.tradingBot.tracker) {
        await this.bot.sendMessage(msg.chat.id, '❌ Strategy tracker not available');
        return;
      }

      const report = this.tradingBot.tracker.getComparisonReport('all');

      if (!report || report.strategies.length < 2) {
        await this.bot.sendMessage(msg.chat.id, '📊 Not enough data yet for comparison');
        return;
      }

      const [strategy1, strategy2] = report.strategies;

      const compareText =
        '📊 *STRATEGY COMPARISON*\n\n' +
        `🟢 *${strategy1.name}* ${strategy1.isLive ? '(LIVE)' : '(HYPOTHETICAL)'}\n` +
        `Trades: ${strategy1.totalTrades} (${strategy1.winRate.toFixed(1)}% win rate)\n` +
        `Total P&L: ${strategy1.totalPnL >= 0 ? '+' : ''}$${strategy1.totalPnL.toFixed(2)}\n` +
        `Profit Factor: ${strategy1.profitFactor.toFixed(2)}\n` +
        `Avg Win: +$${strategy1.avgWin.toFixed(2)} | Avg Loss: $${strategy1.avgLoss.toFixed(2)}\n\n` +
        `📝 *${strategy2.name}* ${strategy2.isLive ? '(LIVE)' : '(HYPOTHETICAL)'}\n` +
        `Trades: ${strategy2.totalTrades} (${strategy2.winRate.toFixed(1)}% win rate)\n` +
        `Total P&L: ${strategy2.totalPnL >= 0 ? '+' : ''}$${strategy2.totalPnL.toFixed(2)}\n` +
        `Profit Factor: ${strategy2.profitFactor.toFixed(2)}\n` +
        `Avg Win: +$${strategy2.avgWin.toFixed(2)} | Avg Loss: $${strategy2.avgLoss.toFixed(2)}\n\n` +
        `🏆 *Winner*: ${strategy1.totalPnL > strategy2.totalPnL ? strategy1.name : strategy2.name}`;

      await this.bot.sendMessage(msg.chat.id, compareText, { parse_mode: 'Markdown' });
      this.commandsExecuted++;
    } catch (error) {
      this.logger.error(`Error in /compare command: ${error.message}`);
      await this.bot.sendMessage(msg.chat.id, '❌ Error generating comparison report');
    }
  }

  /**
   * Handle /help command
   */
  async handleHelp(msg) {
    if (!this.isAuthorized(msg.from.id)) return;

    const helpText =
      '🤖 *GOLD TRADING BOT COMMANDS*\n\n' +
      '*Monitoring:*\n' +
      '/status - Bot status and summary\n' +
      '/positions - View open positions\n' +
      '/pnl - P&L reports (daily/all-time)\n' +
      '/balance - Account balance\n' +
      '/compare - Compare strategies 📊\n\n' +
      '*Control:*\n' +
      '/stop - Stop trading (keep positions)\n' +
      '/resume - Resume trading\n' +
      '/emergency - Emergency stop (close all)\n\n' +
      '*Other:*\n' +
      '/help - Show this help message\n\n' +
      '*Notifications:*\n' +
      'You\'ll receive automatic notifications for:\n' +
      '• Trades opened/closed\n' +
      '• Daily targets reached\n' +
      '• Important alerts\n\n' +
      '*Security:*\n' +
      'Only authorized users can control this bot.\n' +
      `Your ID: \`${msg.from.id}\``;

    await this.bot.sendMessage(msg.chat.id, helpText, { parse_mode: 'Markdown' });
    this.commandsExecuted++;
  }

  /**
   * Handle callback queries (button presses)
   */
  async handleCallback(query) {
    if (!this.isAuthorized(query.from.id)) return;

    const data = query.data;
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;

    try {
      // P&L callbacks
      if (data.startsWith('pnl_')) {
        await this.handlePnLCallback(query, data.replace('pnl_', ''));
      }
      // Stop callbacks
      else if (data.startsWith('stop_')) {
        await this.handleStopCallback(query, data);
      }
      // Emergency callbacks
      else if (data.startsWith('emergency_')) {
        await this.handleEmergencyCallback(query, data);
      }

      await this.bot.answerCallbackQuery(query.id);
    } catch (error) {
      this.logger.error(`Error handling callback: ${error.message}`);
      await this.bot.answerCallbackQuery(query.id, { text: 'Error occurred' });
    }
  }

  /**
   * Handle P&L callback
   */
  async handlePnLCallback(query, period) {
    const summary = await this.tradingBot.riskManager.getPortfolioSummary();
    let message = '';

    if (period === 'daily') {
      const progress = (summary.dailyPnL / Config.TARGET_DAILY_PROFIT) * 100;
      message =
        '📅 *DAILY P&L REPORT*\n\n' +
        `💰 Today's P&L: $${summary.dailyPnL.toFixed(2)}\n` +
        `📊 Trades Today: ${summary.dailyTrades}\n` +
        `✅ Wins: ${summary.winningTrades}\n` +
        `❌ Losses: ${summary.losingTrades}\n` +
        `📈 Win Rate: ${summary.winRate.toFixed(1)}%\n\n` +
        `🎯 Target Progress: ${progress.toFixed(0)}%\n` +
        `Target: $${Config.TARGET_DAILY_PROFIT.toFixed(2)}\n` +
        `Max Loss: $${Config.MAX_DAILY_LOSS.toFixed(2)}`;
    } else if (period === 'alltime') {
      message =
        '🏆 *ALL TIME P&L REPORT*\n\n' +
        `💰 Total P&L: $${summary.totalPnL.toFixed(2)}\n` +
        `📈 Return: ${summary.totalPnLPct >= 0 ? '+' : ''}${summary.totalPnLPct.toFixed(2)}%\n` +
        `📊 Total Trades: ${summary.totalTrades}\n` +
        `✅ Winning: ${summary.winningTrades}\n` +
        `❌ Losing: ${summary.losingTrades}\n` +
        `📈 Win Rate: ${summary.winRate.toFixed(1)}%\n\n` +
        `💵 Initial: $${summary.initialBalance.toFixed(2)}\n` +
        `💰 Current: $${summary.balance.toFixed(2)}\n` +
        `📊 Portfolio: $${summary.portfolioValue.toFixed(2)}`;
    }

    await this.bot.editMessageText(message, {
      chat_id: query.message.chat.id,
      message_id: query.message.message_id,
      parse_mode: 'Markdown'
    });
  }

  /**
   * Handle stop callback
   */
  async handleStopCallback(query, data) {
    if (data === 'stop_confirm' && this.tradingBot) {
      this.tradingBot.isRunning = false;
      const trades = await this.tradingBot.client.getOpenTrades();

      await this.bot.editMessageText(
        `✅ *Bot Stopped*\n\n` +
        `• New positions: Disabled\n` +
        `• Open positions: ${trades.length} (still monitored)\n` +
        `• Status: PAUSED\n\n` +
        `Use /resume to restart trading`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown'
        }
      );

      await this.sendNotification('⏸️ *Bot Stopped*\nNo new positions will be opened.');
    } else if (data === 'stop_cancel') {
      await this.bot.editMessageText('✅ Stop cancelled - bot still running', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }
  }

  /**
   * Handle emergency callback
   */
  async handleEmergencyCallback(query, data) {
    if (data === 'emergency_confirm' && this.tradingBot) {
      await this.bot.editMessageText('🚨 *EMERGENCY STOP ACTIVATED*\n\nClosing all positions...', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id,
        parse_mode: 'Markdown'
      });

      const trades = await this.tradingBot.client.getOpenTrades();
      let closedCount = 0;

      for (const trade of trades) {
        try {
          await this.tradingBot.client.closePosition(trade.instrument);
          closedCount++;
        } catch (error) {
          this.logger.error(`Failed to close trade ${trade.tradeId}: ${error.message}`);
        }
      }

      this.tradingBot.isRunning = false;

      await this.sendNotification(
        `🚨 *EMERGENCY STOP COMPLETE*\n\n` +
        `Closed ${closedCount} positions\n` +
        `Bot stopped`
      );
    } else if (data === 'emergency_cancel') {
      await this.bot.editMessageText('✅ Emergency stop cancelled', {
        chat_id: query.message.chat.id,
        message_id: query.message.message_id
      });
    }
  }

  /**
   * Send notification to all authorized users
   */
  async sendNotification(message) {
    if (!this.bot) return;

    for (const userId of this.authorizedUsers) {
      try {
        await this.bot.sendMessage(userId, message, { parse_mode: 'Markdown' });
        this.notificationsSent++;
      } catch (error) {
        this.logger.error(`Failed to send notification to ${userId}: ${error.message}`);
      }
    }
  }

  /**
   * Trade opened notification
   */
  async notifyTradeOpened(symbol, side, entryPrice, size, stopLoss, takeProfit, strategy, strategyName, confidence) {
    const riskAmount = Math.abs(entryPrice - stopLoss) * size;
    // Escape underscores for Markdown
    const symbolEscaped = symbol.replace(/_/g, '\\_');
    const strategyDisplay = strategyName || strategy;
    const strategyEscaped = strategyDisplay.replace(/_/g, '\\_');

    const message =
      '🟢 *LIVE TRADE OPENED*\n\n' +
      `🤖 Strategy: ${strategyEscaped}\n` +
      `Symbol: ${symbolEscaped}\n` +
      `Side: ${side}\n` +
      `Confidence: ${confidence}%\n` +
      `Entry: $${entryPrice.toFixed(2)}\n` +
      `Size: ${size} units\n` +
      `Stop Loss: $${stopLoss.toFixed(2)}\n` +
      `Take Profit: $${takeProfit ? takeProfit.toFixed(2) : 'Not set'}\n` +
      `Risk: $${riskAmount.toFixed(2)}`;

    await this.sendNotification(message);
  }

  /**
   * Trade closed notification
   */
  async notifyTradeClosed(symbol, entryPrice, exitPrice, pnl, pnlPct, reason, strategyName) {
    const emoji = pnl >= 0 ? '🎉' : '😔';
    const pnlSign = pnl >= 0 ? '+' : '';
    const pctSign = pnlPct >= 0 ? '+' : '';
    // Escape underscores for Markdown
    const symbolEscaped = symbol.replace(/_/g, '\\_');
    const strategyEscaped = strategyName ? strategyName.replace(/_/g, '\\_') : 'Unknown';

    const message =
      `${emoji} *LIVE TRADE CLOSED*\n\n` +
      `🤖 Strategy: ${strategyEscaped}\n` +
      `Symbol: ${symbolEscaped}\n` +
      `Reason: ${reason}\n` +
      `Entry: $${entryPrice.toFixed(2)}\n` +
      `Exit: $${exitPrice.toFixed(2)}\n` +
      `P&L: ${pnlSign}$${Math.abs(pnl).toFixed(2)} (${pctSign}${pnlPct.toFixed(2)}%)`;

    await this.sendNotification(message);
  }

  /**
   * Daily target met notification
   */
  async notifyDailyTargetMet(dailyPnL) {
    const message =
      '🎯 *DAILY TARGET ACHIEVED!*\n\n' +
      `Today's Profit: $${dailyPnL.toFixed(2)}\n\n` +
      `Excellent work! 🚀`;

    await this.sendNotification(message);
  }

  /**
   * Daily loss limit notification
   */
  async notifyDailyLossLimit(dailyPnL) {
    const message =
      '🛑 *DAILY LOSS LIMIT REACHED*\n\n' +
      `Today's Loss: $${dailyPnL.toFixed(2)}\n\n` +
      `Trading stopped for today.\n` +
      `Will resume tomorrow.`;

    await this.sendNotification(message);
  }

  /**
   * Error notification
   */
  async notifyError(errorMsg) {
    const message = `⚠️ *ERROR*\n\n${errorMsg}`;
    await this.sendNotification(message);
  }
}

export default GoldTelegramBot;
