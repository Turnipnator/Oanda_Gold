/**
 * Strategy Performance Tracker
 *
 * Tracks and compares performance of multiple strategies:
 * - One strategy trades LIVE
 * - Others track HYPOTHETICALLY
 * - Daily/Weekly/Monthly comparison reports
 */
import logger from './logger.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Data file path - use /app/data in Docker, ./data locally
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const DATA_FILE = path.join(DATA_DIR, 'tracker_data.json');

class StrategyTracker {
  constructor() {
    this.strategies = new Map(); // Map of strategy name -> performance data
    this.liveStrategy = null; // Which strategy is trading live
    this.hypotheticalTrades = new Map(); // Track hypothetical open positions

    // Load persisted data on startup
    this.load();
  }

  /**
   * Save tracker data to file for persistence across restarts
   */
  save() {
    try {
      // Ensure data directory exists
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      // Convert Maps to plain objects for JSON serialization
      const data = {
        liveStrategy: this.liveStrategy,
        strategies: {},
        hypotheticalTrades: {}
      };

      for (const [name, strategyData] of this.strategies) {
        data.strategies[name] = { ...strategyData };
      }

      for (const [id, trade] of this.hypotheticalTrades) {
        data.hypotheticalTrades[id] = trade;
      }

      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
      logger.debug(`💾 Tracker data saved to ${DATA_FILE}`);
    } catch (error) {
      logger.error(`Failed to save tracker data: ${error.message}`);
    }
  }

  /**
   * Load tracker data from file
   */
  load() {
    try {
      if (!fs.existsSync(DATA_FILE)) {
        logger.info('📂 No existing tracker data found, starting fresh');
        return;
      }

      const rawData = fs.readFileSync(DATA_FILE, 'utf8');
      const data = JSON.parse(rawData);

      this.liveStrategy = data.liveStrategy || null;

      // Restore strategies Map
      if (data.strategies) {
        for (const [name, strategyData] of Object.entries(data.strategies)) {
          this.strategies.set(name, strategyData);
        }
      }

      // Restore hypothetical trades Map
      if (data.hypotheticalTrades) {
        for (const [id, trade] of Object.entries(data.hypotheticalTrades)) {
          this.hypotheticalTrades.set(id, trade);
        }
      }

      const totalTrades = Array.from(this.strategies.values()).reduce((sum, s) => sum + s.totalTrades, 0);
      logger.info(`📂 Loaded tracker data: ${this.strategies.size} strategies, ${totalTrades} historical trades`);
    } catch (error) {
      logger.error(`Failed to load tracker data: ${error.message}`);
    }
  }

  /**
   * Register a strategy for tracking
   */
  registerStrategy(name, isLive = false) {
    // Preserve existing data if strategy was already loaded from disk
    const existing = this.strategies.get(name);
    if (existing) {
      existing.isLive = isLive;
      logger.info(`📊 Restored strategy: ${name} ${isLive ? '(LIVE)' : '(HYPOTHETICAL)'} - ${existing.totalTrades} trades, P&L: $${existing.totalPnL.toFixed(2)}`);
    } else {
      this.strategies.set(name, {
        name,
        isLive,
        trades: [],
        totalTrades: 0,
        winningTrades: 0,
        losingTrades: 0,
        totalPnL: 0,
        largestWin: 0,
        largestLoss: 0,
        currentDrawdown: 0,
        maxDrawdown: 0,
        openPositions: []
      });
      logger.info(`📊 Registered strategy: ${name} ${isLive ? '(LIVE)' : '(HYPOTHETICAL)'}`);
    }

    if (isLive) {
      this.liveStrategy = name;
    }

    // Persist changes
    this.save();
  }

  /**
   * Record a trade signal (live or hypothetical)
   */
  recordSignal(strategyName, signal, entryPrice, stopLoss, takeProfit1, takeProfit2, size, reason, confidence) {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) {
      logger.error(`Strategy ${strategyName} not registered`);
      return;
    }

    const trade = {
      id: `${strategyName}_${Date.now()}`,
      strategyName,
      signal,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      size,
      reason,
      confidence,
      entryTime: new Date(),
      exitTime: null,
      exitPrice: null,
      pnl: null,
      status: 'open',
      isLive: strategy.isLive
    };

    strategy.openPositions.push(trade);

    // Store hypothetical trades separately
    if (!strategy.isLive) {
      this.hypotheticalTrades.set(trade.id, trade);
    }

    logger.info(`${strategy.isLive ? '🟢 LIVE' : '📝 HYPOTHETICAL'} ${strategyName}: ${signal} at $${entryPrice.toFixed(2)} (Confidence: ${confidence}%)`);

    // Persist changes
    this.save();

    return trade;
  }

  /**
   * Close a trade (live or hypothetical)
   */
  closeTrade(strategyName, tradeId, exitPrice, reason) {
    const strategy = this.strategies.get(strategyName);
    if (!strategy) return;

    const tradeIndex = strategy.openPositions.findIndex(t => t.id === tradeId);
    if (tradeIndex === -1) return;

    const trade = strategy.openPositions[tradeIndex];
    const isLong = trade.signal === 'LONG';

    // Calculate P&L
    const priceDiff = isLong
      ? exitPrice - trade.entryPrice
      : trade.entryPrice - exitPrice;
    const pnl = priceDiff * trade.size;

    // Update trade
    trade.exitTime = new Date();
    trade.exitPrice = exitPrice;
    trade.pnl = pnl;
    trade.status = 'closed';
    trade.exitReason = reason;

    // Move to closed trades
    strategy.openPositions.splice(tradeIndex, 1);
    strategy.trades.push(trade);

    // Update statistics
    strategy.totalTrades++;
    strategy.totalPnL += pnl;

    if (pnl > 0) {
      strategy.winningTrades++;
      if (pnl > strategy.largestWin) strategy.largestWin = pnl;
    } else {
      strategy.losingTrades++;
      if (pnl < strategy.largestLoss) strategy.largestLoss = pnl;
    }

    // Update drawdown
    if (pnl < 0) {
      strategy.currentDrawdown += Math.abs(pnl);
      if (strategy.currentDrawdown > strategy.maxDrawdown) {
        strategy.maxDrawdown = strategy.currentDrawdown;
      }
    } else {
      strategy.currentDrawdown = Math.max(0, strategy.currentDrawdown - pnl);
    }

    // Remove from hypothetical trades
    if (this.hypotheticalTrades.has(tradeId)) {
      this.hypotheticalTrades.delete(tradeId);
    }

    const duration = Math.round((trade.exitTime - trade.entryTime) / 1000 / 60); // minutes
    logger.info(`${strategy.isLive ? '🟢 LIVE' : '📝 HYPOTHETICAL'} ${strategyName}: Closed ${trade.signal} - P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} (${duration}min)`);

    // Persist changes
    this.save();

    return trade;
  }

  /**
   * Get comparison report
   */
  getComparisonReport(period = 'all') {
    const report = {
      period,
      timestamp: new Date(),
      strategies: []
    };

    for (const [name, data] of this.strategies) {
      const winRate = data.totalTrades > 0
        ? (data.winningTrades / data.totalTrades * 100).toFixed(1)
        : '0.0';

      const avgWin = data.winningTrades > 0
        ? data.trades.filter(t => t.pnl > 0).reduce((sum, t) => sum + t.pnl, 0) / data.winningTrades
        : 0;

      const avgLoss = data.losingTrades > 0
        ? data.trades.filter(t => t.pnl < 0).reduce((sum, t) => sum + t.pnl, 0) / data.losingTrades
        : 0;

      const profitFactor = Math.abs(avgLoss) > 0
        ? (avgWin * data.winningTrades) / (Math.abs(avgLoss) * data.losingTrades)
        : 0;

      report.strategies.push({
        name,
        isLive: data.isLive,
        totalTrades: data.totalTrades,
        winningTrades: data.winningTrades,
        losingTrades: data.losingTrades,
        winRate: parseFloat(winRate),
        totalPnL: data.totalPnL,
        avgWin: avgWin,
        avgLoss: avgLoss,
        largestWin: data.largestWin,
        largestLoss: data.largestLoss,
        profitFactor: profitFactor,
        maxDrawdown: data.maxDrawdown,
        openPositions: data.openPositions.length
      });
    }

    // Sort by total P&L
    report.strategies.sort((a, b) => b.totalPnL - a.totalPnL);

    return report;
  }

  /**
   * Format comparison report for display
   */
  formatReport(report) {
    let output = '\n' + '='.repeat(80) + '\n';
    output += `📊 STRATEGY COMPARISON REPORT (${report.period.toUpperCase()})\n`;
    output += `Generated: ${report.timestamp.toLocaleString()}\n`;
    output += '='.repeat(80) + '\n\n';

    for (const strategy of report.strategies) {
      const marker = strategy.isLive ? '🟢 LIVE' : '📝 HYPOTHETICAL';
      const performance = strategy.totalPnL >= 0 ? '✅' : '❌';

      output += `${marker} ${strategy.name} ${performance}\n`;
      output += '-'.repeat(80) + '\n';
      output += `Total Trades: ${strategy.totalTrades} (${strategy.winningTrades}W / ${strategy.losingTrades}L)\n`;
      output += `Win Rate: ${strategy.winRate}%\n`;
      output += `Total P&L: ${strategy.totalPnL >= 0 ? '+' : ''}$${strategy.totalPnL.toFixed(2)}\n`;
      output += `Avg Win: +$${strategy.avgWin.toFixed(2)} | Avg Loss: $${strategy.avgLoss.toFixed(2)}\n`;
      output += `Largest Win: +$${strategy.largestWin.toFixed(2)} | Largest Loss: $${strategy.largestLoss.toFixed(2)}\n`;
      output += `Profit Factor: ${strategy.profitFactor.toFixed(2)}\n`;
      output += `Max Drawdown: $${strategy.maxDrawdown.toFixed(2)}\n`;
      output += `Open Positions: ${strategy.openPositions}\n`;
      output += '\n';
    }

    output += '='.repeat(80) + '\n';

    return output;
  }

  /**
   * Get current hypothetical positions
   */
  getHypotheticalPositions() {
    return Array.from(this.hypotheticalTrades.values());
  }

  /**
   * Export data for analysis
   */
  exportData() {
    const data = {
      liveStrategy: this.liveStrategy,
      strategies: {}
    };

    for (const [name, strategyData] of this.strategies) {
      data.strategies[name] = {
        ...strategyData,
        trades: strategyData.trades
      };
    }

    return data;
  }
}

export default StrategyTracker;
