/**
 * Oanda API Client Wrapper
 * Handles all communication with Oanda v20 REST API
 */
import axios from 'axios';
import Config from './config.js';

class OandaClient {
  constructor(logger) {
    this.logger = logger;
    this.apiKey = Config.OANDA_API_KEY;
    this.accountId = Config.OANDA_ACCOUNT_ID;
    this.hostname = Config.getOandaHostname();

    // Rate limiting
    this.requestQueue = [];
    this.requestsThisSecond = 0;
    this.lastRequestTime = Date.now();

    this.logger.info(`Oanda client initialized: ${this.hostname}`);
  }

  /**
   * Make authenticated request to Oanda API with rate limiting
   */
  async makeRequest(method, endpoint, data = null) {
    // Simple rate limiting
    const now = Date.now();
    if (now - this.lastRequestTime < 1000) {
      this.requestsThisSecond++;
      if (this.requestsThisSecond >= Config.OANDA_MAX_REQUESTS_PER_SECOND) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        this.requestsThisSecond = 0;
      }
    } else {
      this.requestsThisSecond = 0;
      this.lastRequestTime = now;
    }

    const config = {
      method,
      url: `${this.hostname}${endpoint}`,
      headers: {
        'Authorization': `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
        'Accept-Datetime-Format': 'RFC3339'
      },
      timeout: 30000 // 30 second timeout to prevent hanging forever
    };

    if (data) {
      config.data = data;
    }

    let lastError;
    for (let attempt = 1; attempt <= Config.RETRY_ATTEMPTS; attempt++) {
      try {
        const response = await axios(config);
        return response.data;
      } catch (error) {
        lastError = error;
        const errorMsg = error.response?.data?.errorMessage || error.message;
        this.logger.warn(`Request failed (attempt ${attempt}/${Config.RETRY_ATTEMPTS}): ${errorMsg}`);

        if (attempt < Config.RETRY_ATTEMPTS) {
          await new Promise(resolve => setTimeout(resolve, Config.RETRY_DELAY_MS * attempt));
        }
      }
    }

    throw new Error(`Request failed after ${Config.RETRY_ATTEMPTS} attempts: ${lastError.message}`);
  }

  /**
   * Get account summary
   */
  async getAccountSummary() {
    try {
      const data = await this.makeRequest('GET', `/v3/accounts/${this.accountId}/summary`);
      return data.account;
    } catch (error) {
      this.logger.error(`Failed to get account summary: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get account balance
   */
  async getBalance() {
    try {
      const account = await this.getAccountSummary();
      return {
        balance: parseFloat(account.balance),
        nav: parseFloat(account.NAV),
        unrealizedPL: parseFloat(account.unrealizedPL),
        pl: parseFloat(account.pl),
        marginUsed: parseFloat(account.marginUsed || 0),
        marginAvailable: parseFloat(account.marginAvailable),
        currency: account.currency
      };
    } catch (error) {
      this.logger.error(`Failed to get balance: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get current price for an instrument
   */
  async getPrice(instrument = Config.TRADING_SYMBOL) {
    try {
      const data = await this.makeRequest('GET', `/v3/accounts/${this.accountId}/pricing?instruments=${instrument}`);
      const pricing = data.prices[0];

      return {
        instrument: pricing.instrument,
        bid: parseFloat(pricing.bids[0].price),
        ask: parseFloat(pricing.asks[0].price),
        mid: (parseFloat(pricing.bids[0].price) + parseFloat(pricing.asks[0].price)) / 2,
        spread: parseFloat(pricing.asks[0].price) - parseFloat(pricing.bids[0].price),
        time: pricing.time
      };
    } catch (error) {
      this.logger.error(`Failed to get price for ${instrument}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get historical candles
   * @param {string} instrument - Instrument name (e.g., XAU_USD)
   * @param {string} granularity - Candle granularity (e.g., H4 for 4-hour)
   * @param {number} count - Number of candles to retrieve (max 5000)
   */
  async getCandles(instrument = Config.TRADING_SYMBOL, granularity = Config.TIMEFRAME, count = 200) {
    try {
      const endpoint = `/v3/instruments/${instrument}/candles?count=${count}&granularity=${granularity}&price=M`;
      const data = await this.makeRequest('GET', endpoint);

      return data.candles.map(candle => ({
        time: new Date(candle.time),
        open: parseFloat(candle.mid.o),
        high: parseFloat(candle.mid.h),
        low: parseFloat(candle.mid.l),
        close: parseFloat(candle.mid.c),
        volume: parseInt(candle.volume),
        complete: candle.complete
      }));
    } catch (error) {
      this.logger.error(`Failed to get candles: ${error.message}`);
      throw error;
    }
  }

  /**
   * Place a market order
   */
  async placeMarketOrder(instrument, units, stopLoss, takeProfit = null) {
    try {
      const orderSpec = {
        order: {
          type: 'MARKET',
          instrument,
          units: units.toString(),
          timeInForce: 'FOK', // Fill or Kill
          positionFill: 'DEFAULT'
        }
      };

      // Add stop loss
      if (stopLoss) {
        orderSpec.order.stopLossOnFill = {
          price: stopLoss.toFixed(2),
          timeInForce: 'GTC'
        };
      }

      // Add take profit (optional)
      if (takeProfit) {
        orderSpec.order.takeProfitOnFill = {
          price: takeProfit.toFixed(2),
          timeInForce: 'GTC'
        };
      }

      const data = await this.makeRequest('POST', `/v3/accounts/${this.accountId}/orders`, orderSpec);

      if (data.orderFillTransaction) {
        const fill = data.orderFillTransaction;
        return {
          success: true,
          orderId: fill.id,
          tradeId: fill.tradeOpened?.tradeID || fill.tradeReduced?.tradeID,
          instrument: fill.instrument,
          units: parseInt(fill.units),
          price: parseFloat(fill.price),
          time: fill.time,
          pl: parseFloat(fill.pl || 0),
          reason: fill.reason
        };
      } else if (data.orderCancelTransaction) {
        const cancel = data.orderCancelTransaction;
        return {
          success: false,
          reason: cancel.reason,
          rejectReason: data.orderRejectTransaction?.rejectReason
        };
      }

      throw new Error('Unexpected order response');
    } catch (error) {
      this.logger.error(`Failed to place market order: ${error.message}`);
      throw error;
    }
  }

  /**
   * Close a position
   */
  async closePosition(instrument, units = 'ALL') {
    try {
      const longOrShort = units > 0 ? 'long' : 'short';
      const endpoint = `/v3/accounts/${this.accountId}/positions/${instrument}/close`;

      const data = await this.makeRequest('PUT', endpoint, {
        [`${longOrShort}Units`]: units === 'ALL' ? 'ALL' : Math.abs(units).toString()
      });

      if (data.longOrderFillTransaction || data.shortOrderFillTransaction) {
        const fill = data.longOrderFillTransaction || data.shortOrderFillTransaction;
        return {
          success: true,
          orderId: fill.id,
          instrument: fill.instrument,
          units: parseInt(fill.units),
          price: parseFloat(fill.price),
          pl: parseFloat(fill.pl || 0),
          time: fill.time
        };
      }

      return { success: false, reason: 'No fill transaction' };
    } catch (error) {
      this.logger.error(`Failed to close position: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all open positions
   */
  async getOpenPositions() {
    try {
      const data = await this.makeRequest('GET', `/v3/accounts/${this.accountId}/openPositions`);

      return data.positions.map(pos => {
        const isLong = pos.long.units !== '0';
        const side = isLong ? pos.long : pos.short;

        return {
          instrument: pos.instrument,
          units: parseInt(side.units),
          averagePrice: parseFloat(side.averagePrice),
          unrealizedPL: parseFloat(side.unrealizedPL || 0),
          pl: parseFloat(pos.pl || 0)
        };
      });
    } catch (error) {
      this.logger.error(`Failed to get open positions: ${error.message}`);
      throw error;
    }
  }

  /**
   * Get all open trades (with stop loss / take profit info)
   */
  async getOpenTrades() {
    try {
      const data = await this.makeRequest('GET', `/v3/accounts/${this.accountId}/openTrades`);

      return data.trades.map(trade => ({
        tradeId: trade.id,
        instrument: trade.instrument,
        units: parseInt(trade.currentUnits),
        price: parseFloat(trade.price),
        unrealizedPL: parseFloat(trade.unrealizedPL || 0),
        openTime: new Date(trade.openTime),
        stopLoss: trade.stopLossOrder ? parseFloat(trade.stopLossOrder.price) : null,
        takeProfit: trade.takeProfitOrder ? parseFloat(trade.takeProfitOrder.price) : null
      }));
    } catch (error) {
      this.logger.error(`Failed to get open trades: ${error.message}`);
      throw error;
    }
  }

  /**
   * Modify trade (update stop loss / take profit)
   */
  async modifyTrade(tradeId, stopLoss = null, takeProfit = null) {
    try {
      const updates = {};

      if (stopLoss !== null) {
        updates.stopLoss = {
          price: stopLoss.toFixed(2),
          timeInForce: 'GTC'
        };
      }

      if (takeProfit !== null) {
        updates.takeProfit = {
          price: takeProfit.toFixed(2),
          timeInForce: 'GTC'
        };
      }

      const data = await this.makeRequest('PUT', `/v3/accounts/${this.accountId}/trades/${tradeId}/orders`, updates);

      return {
        success: true,
        tradeId,
        stopLoss: data.stopLossOrderTransaction?.price,
        takeProfit: data.takeProfitOrderTransaction?.price
      };
    } catch (error) {
      this.logger.error(`Failed to modify trade ${tradeId}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Test connection to Oanda API
   */
  async testConnection() {
    try {
      this.logger.info('Testing Oanda API connection...');
      const account = await this.getAccountSummary();
      const balance = await this.getBalance();
      const price = await this.getPrice();

      this.logger.info('✅ Connection successful!');
      this.logger.info(`Account ID: ${account.id}`);
      this.logger.info(`Currency: ${account.currency}`);
      this.logger.info(`Balance: ${balance.balance.toFixed(2)} ${account.currency}`);
      this.logger.info(`NAV: ${balance.nav.toFixed(2)} ${account.currency}`);
      this.logger.info(`${Config.TRADING_SYMBOL} Price: ${price.bid.toFixed(2)} / ${price.ask.toFixed(2)}`);

      return true;
    } catch (error) {
      this.logger.error(`❌ Connection test failed: ${error.message}`);
      return false;
    }
  }
}

export default OandaClient;
