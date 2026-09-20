/**
 * Risk Management System
 * Handles position sizing, portfolio heat, and risk limits
 */
import Config from './config.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Stats file path - use /app/data in Docker, ./data locally
const DATA_DIR = process.env.NODE_ENV === 'production' ? '/app/data' : path.join(__dirname, '..', 'data');
const STATS_FILE = path.join(DATA_DIR, 'trading_stats.json');

class RiskManager {
  // How long a cached FX conversion factor stays usable. Long, because the
  // fallback is worse than a slightly old rate: GBP/USD does not move far
  // enough in a day to matter next to a 25% currency error, and refusing to
  // trade on a stale rate would be a self-inflicted outage.
  static HOME_FACTOR_MAX_AGE_MS = 12 * 60 * 60 * 1000;

  constructor(logger, oandaClient) {
    this.logger = logger;
    this.client = oandaClient;

    // Track daily P&L
    this.dailyPnL = 0;
    this.dailyTrades = 0;
    this.winningTrades = 0;
    this.losingTrades = 0;
    this.lastResetDate = new Date().toDateString();

    // Track all-time stats
    this.totalPnL = 0;
    this.totalTrades = 0;
    this.totalWins = 0;
    this.totalLosses = 0;

    this.initialBalance = Config.INITIAL_BALANCE;
    this.currentBalance = Config.INITIAL_BALANCE;

    // Quote currency -> account currency, for LOSSES. XAU_USD risk is a USD
    // price-notional; the account is GBP. Refreshed beside the balance; 1.0
    // until the first successful fetch, which is what the code did implicitly
    // before this existed (it under-risks, so it is the safe direction).
    this.homeLossFactor = 1.0;
    this.homeFactorAt = 0;

    // Load persisted stats on startup
    this.loadStats();
  }

  /**
   * Save trading stats to file for persistence across restarts
   */
  saveStats() {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }

      const stats = {
        dailyPnL: this.dailyPnL,
        dailyTrades: this.dailyTrades,
        winningTrades: this.winningTrades,
        losingTrades: this.losingTrades,
        lastResetDate: this.lastResetDate,
        totalPnL: this.totalPnL,
        totalTrades: this.totalTrades,
        totalWins: this.totalWins,
        totalLosses: this.totalLosses,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
      this.logger.debug(`💾 Trading stats saved`);
    } catch (error) {
      this.logger.error(`Failed to save trading stats: ${error.message}`);
    }
  }

  /**
   * Load trading stats from file
   */
  loadStats() {
    try {
      if (!fs.existsSync(STATS_FILE)) {
        this.logger.info('📂 No existing trading stats found, starting fresh');
        return;
      }

      const rawData = fs.readFileSync(STATS_FILE, 'utf8');
      const stats = JSON.parse(rawData);

      // Check if stats are from today
      const today = new Date().toDateString();
      if (stats.lastResetDate === today) {
        // Load daily stats only if same day
        this.dailyPnL = stats.dailyPnL || 0;
        this.dailyTrades = stats.dailyTrades || 0;
        this.winningTrades = stats.winningTrades || 0;
        this.losingTrades = stats.losingTrades || 0;
        this.lastResetDate = stats.lastResetDate;
        this.logger.info(`📂 Loaded daily stats: P&L=$${this.dailyPnL.toFixed(2)}, Trades=${this.dailyTrades}`);
      } else {
        this.logger.info(`📂 Stats from previous day (${stats.lastResetDate}), resetting daily stats`);
        this.lastResetDate = today;
      }

      // Always load all-time stats
      this.totalPnL = stats.totalPnL || 0;
      this.totalTrades = stats.totalTrades || 0;
      this.totalWins = stats.totalWins || 0;
      this.totalLosses = stats.totalLosses || 0;

      this.logger.info(`📂 Loaded all-time stats: P&L=$${this.totalPnL.toFixed(2)}, Trades=${this.totalTrades}, Wins=${this.totalWins}, Losses=${this.totalLosses}`);
    } catch (error) {
      this.logger.error(`Failed to load trading stats: ${error.message}`);
    }
  }

  /**
   * Reset daily statistics (call at start of new day)
   */
  resetDailyStats() {
    const today = new Date().toDateString();
    if (today !== this.lastResetDate) {
      this.logger.info('📅 Resetting daily statistics');
      this.dailyPnL = 0;
      this.dailyTrades = 0;
      this.winningTrades = 0;
      this.losingTrades = 0;
      this.lastResetDate = today;
      this.saveStats(); // Persist the reset
    }
  }

  /**
   * Sync balance from exchange
   */
  async syncBalance() {
    try {
      const balance = await this.client.getBalance();
      this.currentBalance = balance.nav; // Use NAV (includes unrealized P&L)
      this.logger.info(`Balance synced: $${this.currentBalance.toFixed(2)}`);
      await this.refreshHomeConversion();
      return this.currentBalance;
    } catch (error) {
      this.logger.error(`Failed to sync balance: ${error.message}`);
      return this.currentBalance;
    }
  }

  /**
   * Refresh the quote->account conversion factor. Rides the balance sync rather
   * than being fetched per trade, so sizing stays synchronous and its three call
   * sites are untouched.
   */
  async refreshHomeConversion() {
    if (typeof this.client?.getHomeConversionFactors !== 'function') return this.homeLossFactor;
    const factors = await this.client.getHomeConversionFactors();
    if (factors && Number.isFinite(factors.loss) && factors.loss > 0) {
      this.homeLossFactor = factors.loss;
      this.homeFactorAt = Date.now();
      this.logger.info(`FX: 1 ${factors.currency} of loss = ${factors.loss.toFixed(4)} account currency`);
    } else {
      this.logger.warn('Could not refresh the home conversion factor — keeping the last known value');
    }
    return this.homeLossFactor;
  }

  /**
   * The factor to turn a quote-currency loss into an account-currency one.
   *
   * Falls back to 1.0 once the cached value is stale, with a warning. 1.0 is
   * what the code did before conversion existed: it UNDER-states risk, so
   * positions come out smaller, which is the direction to fail in. Failing
   * closed instead would stop the bot trading through a pricing outage.
   */
  homeConversionFactor() {
    const age = Date.now() - this.homeFactorAt;
    if (Number.isFinite(this.homeLossFactor) && this.homeLossFactor > 0 && age <= RiskManager.HOME_FACTOR_MAX_AGE_MS) {
      return this.homeLossFactor;
    }
    this.logger.warn(
      `Home conversion factor is stale (${Math.round(age / 3_600_000)}h old) — sizing at 1.0, ` +
      'which under-states risk in the account currency'
    );
    return 1.0;
  }

  /**
   * Calculate position size based on risk percentage
   * @param {number} entryPrice - Entry price
   * @param {number} stopLoss - Stop loss price
   * @param {number} riskPercent - Risk as decimal (e.g., 0.015 for 1.5%)
   * @returns {number} Position size in units
   */
  calculatePositionSize(entryPrice, stopLoss, riskPercent = Config.MAX_RISK_PER_TRADE) {
    const riskAmount = this.currentBalance * riskPercent;
    const priceDistance = Math.abs(entryPrice - stopLoss);

    // Fail closed on anything that is not a real number. `NaN === 0` is false,
    // and Math.floor/max/min all PROPAGATE NaN, so an undefined price ran the
    // whole way through sizing, past `if (positionSize === 0)` at every call
    // site, past canOpenTrade (NaN > limit is false, so "allowed"), and into
    // oanda_client.placeMarketOrder as `units.toString()` === "NaN".
    // 0 is the failure signal every caller already checks.
    // Validate the ARGUMENTS, not just what they compute to. JavaScript coerces
    // null to 0 in arithmetic, so a missing stopLoss made `entry - null` a
    // perfectly finite number and sized the trade as though the stop sat at
    // price zero — a stop distance of the entire gold price. Number.isFinite
    // rejects null, undefined and strings without coercing any of them.
    if (![entryPrice, stopLoss, this.currentBalance, riskPercent].every(Number.isFinite)
        || !Number.isFinite(riskAmount) || !Number.isFinite(priceDistance)) {
      this.logger.error(
        'Position sizing got a non-finite input — refusing to size: ' +
        `entry=${entryPrice}, stop=${stopLoss}, balance=${this.currentBalance}, risk%=${riskPercent}`
      );
      return 0;
    }

    if (priceDistance === 0) {
      this.logger.error('Price distance to stop loss is zero');
      return 0;
    }

    // The budget is in the ACCOUNT currency; the stop distance is in the
    // instrument's QUOTE currency. Dividing one by the other without converting
    // meant "risk 0.5%" was really 0.36%: a 21-unit trade with a $20 stop loses
    // $420, which is £317 of an £87k account, not the £435 configured. Convert
    // the budget into quote currency first, then it divides by a quote distance.
    const conversion = this.homeConversionFactor();
    const riskInQuoteCurrency = riskAmount / conversion;

    // Position Size = Risk Amount / Distance to Stop Loss
    const riskBasedSize = Math.floor(riskInQuoteCurrency / priceDistance);

    // The broker minimum is a floor on what CAN be traded, not a licence to
    // exceed the risk budget. Applying it after the division silently
    // multiplied the risk: on 25 Jun 2026, with MIN_POSITION_SIZE at 100, the
    // log reads `Risk=$438.72, Distance=$32.90, Size=100 units` — a 13-unit
    // risk-based size inflated to 100, putting $3,290 at risk against a $438
    // budget. 7.5x, and six such trades that fortnight at 5.5-7.5x each.
    // Skip the trade instead — the rule the IG bot uses in the same spot.
    // Dormant at today's config (MIN 10, stop capped at $20, budget ~£435, so
    // the risk-based size never falls below 21): this is the guard for the
    // next time the minimum is raised or the balance falls.
    const minSizeRisk = Config.MIN_POSITION_SIZE * priceDistance;   // quote currency
    if (riskBasedSize < Config.MIN_POSITION_SIZE && minSizeRisk > riskInQuoteCurrency) {
      this.logger.risk('Minimum position size would exceed the risk budget — skipping trade', {
        riskBudget: riskAmount.toFixed(2),
        riskBudgetInQuote: riskInQuoteCurrency.toFixed(2),
        riskAtMinimumSize: (minSizeRisk * conversion).toFixed(2),
        minPositionSize: Config.MIN_POSITION_SIZE,
        priceDistance: priceDistance.toFixed(2)
      });
      return 0;
    }

    // Apply min/max limits
    let positionSize = Math.max(riskBasedSize, Config.MIN_POSITION_SIZE);
    positionSize = Math.min(positionSize, Config.MAX_POSITION_SIZE);

    // Prefix kept verbatim: the sizing history is greppable back to June and
    // that is how the 7.5x over-risk was found.
    this.logger.info(
      `Position sizing: Risk=$${riskAmount.toFixed(2)}, Distance=$${priceDistance.toFixed(2)}, ` +
      `Size=${positionSize} units (fx ${conversion.toFixed(4)}, risk at stop ` +
      `${(positionSize * priceDistance * conversion).toFixed(2)} account ccy)`
    );

    return positionSize;
  }

  /**
   * Calculate portfolio heat (total risk exposure)
   */
  async calculatePortfolioHeat() {
    try {
      const openTrades = await this.client.getOpenTrades();

      let totalRisk = 0;
      for (const trade of openTrades) {
        if (trade.stopLoss) {
          const priceDistance = Math.abs(trade.price - trade.stopLoss);
          const riskAmount = priceDistance * Math.abs(trade.units);
          totalRisk += riskAmount;
        }
      }

      // totalRisk is a QUOTE-currency notional; the balance is the account
      // currency. Unconverted, heat read ~25% low against MAX_PORTFOLIO_RISK.
      const portfolioHeat = (totalRisk * this.homeConversionFactor()) / this.currentBalance;
      return portfolioHeat;
    } catch (error) {
      this.logger.error(`Failed to calculate portfolio heat: ${error.message}`);
      return 0;
    }
  }

  /**
   * Check if we can open a new trade
   */
  async canOpenTrade(entryPrice, stopLoss, positionSize) {
    // Reset daily stats if new day
    this.resetDailyStats();

    // Check daily loss limit
    if (this.dailyPnL <= -Config.MAX_DAILY_LOSS) {
      this.logger.risk('Daily loss limit reached', { dailyPnL: this.dailyPnL });
      return { allowed: false, reason: 'DAILY_LOSS_LIMIT' };
    }

    // Check if daily target already met (optional: stop for the day)
    // Commenting out to allow continued trading even after target met
    // if (this.dailyPnL >= Config.TARGET_DAILY_PROFIT) {
    //   this.logger.info('Daily profit target reached - taking rest of day off');
    //   return { allowed: false, reason: 'DAILY_TARGET_MET' };
    // }

    // Check portfolio heat
    const currentHeat = await this.calculatePortfolioHeat();
    // Converted for the same reason as calculatePortfolioHeat: this is a
    // quote-currency notional being measured against an account-currency
    // balance.
    const newTradeRisk = Math.abs(entryPrice - stopLoss) * positionSize * this.homeConversionFactor();
    const newHeat = (currentHeat * this.currentBalance + newTradeRisk) / this.currentBalance;

    // Defence in depth: every comparison against NaN is false, so a garbage
    // trade sailed through the heat check reporting "allowed". Sizing now
    // refuses non-finite inputs before this point, but a gate that cannot say
    // no to a number it does not understand is not a gate.
    if (![entryPrice, stopLoss, positionSize].every(Number.isFinite)
        || !Number.isFinite(newHeat) || !Number.isFinite(newTradeRisk)) {
      this.logger.risk('Portfolio heat is not a finite number — blocking trade', {
        entryPrice, stopLoss, positionSize, currentHeat, balance: this.currentBalance
      });
      return { allowed: false, reason: 'NON_FINITE_RISK' };
    }

    if (newHeat > Config.MAX_PORTFOLIO_RISK) {
      this.logger.risk('Portfolio heat too high', {
        currentHeat: currentHeat.toFixed(3),
        newHeat: newHeat.toFixed(3),
        maxAllowed: Config.MAX_PORTFOLIO_RISK
      });
      return { allowed: false, reason: 'PORTFOLIO_HEAT_EXCEEDED' };
    }

    return { allowed: true };
  }

  /**
   * Record a trade result
   */
  recordTrade(pnl) {
    this.dailyPnL += pnl;
    this.dailyTrades++;

    this.totalPnL += pnl;
    this.totalTrades++;

    if (pnl > 0) {
      this.winningTrades++;
      this.totalWins++;
    } else if (pnl < 0) {
      this.losingTrades++;
      this.totalLosses++;
    }

    this.logger.trade('Trade recorded', {
      pnl: pnl.toFixed(2),
      dailyPnL: this.dailyPnL.toFixed(2),
      totalPnL: this.totalPnL.toFixed(2)
    });

    // Persist stats after each trade
    this.saveStats();
  }

  /**
   * Get portfolio summary
   */
  async getPortfolioSummary() {
    try {
      await this.syncBalance();
      const openTrades = await this.client.getOpenTrades();
      const portfolioHeat = await this.calculatePortfolioHeat();

      const unrealizedPL = openTrades.reduce((sum, trade) => sum + trade.unrealizedPL, 0);
      const winRate = this.totalTrades > 0 ? (this.totalWins / this.totalTrades) * 100 : 0;

      return {
        balance: this.currentBalance,
        initialBalance: this.initialBalance,
        totalPnL: this.totalPnL,
        totalPnLPct: ((this.currentBalance - this.initialBalance) / this.initialBalance) * 100,
        dailyPnL: this.dailyPnL,
        dailyTrades: this.dailyTrades,
        portfolioHeat: portfolioHeat,
        openPositions: openTrades.length,
        unrealizedPL: unrealizedPL,
        portfolioValue: this.currentBalance + unrealizedPL,
        winningTrades: this.winningTrades,
        losingTrades: this.losingTrades,
        totalTrades: this.totalTrades,
        winRate: winRate
      };
    } catch (error) {
      this.logger.error(`Failed to get portfolio summary: ${error.message}`);
      return null;
    }
  }

  /**
   * Calculate take profit levels
   */
  calculateTakeProfits(entryPrice, stopLoss, isLong) {
    const riskDistance = Math.abs(entryPrice - stopLoss);

    const tp1Distance = riskDistance * Config.TAKE_PROFIT_1_RR;
    const tp2Distance = riskDistance * Config.TAKE_PROFIT_2_RR;

    if (isLong) {
      return {
        tp1: entryPrice + tp1Distance,
        tp2: entryPrice + tp2Distance
      };
    } else {
      return {
        tp1: entryPrice - tp1Distance,
        tp2: entryPrice - tp2Distance
      };
    }
  }
}

export default RiskManager;
