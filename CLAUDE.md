> **Common Patterns**: See `~/trading-bot-skill.md` for deployment, Docker, Telegram, and strategy patterns shared across all trading bots.

---

# Gold Trading Bot - Claude Project Guide

## 🎯 Project Overview

This is an automated gold (XAU/USD) trading bot built on **proven, battle-tested strategies** that have survived real market conditions. We're not chasing fancy indicators or complex algorithms - we're using what actually works in the wild.

**Core Philosophy**: Trade with the trend, manage risk ruthlessly, and let winners run while cutting losers fast.

---

## 📊 Recommended Exchange & API

### **Oanda - The Professional's Choice**

**Why Oanda?**
- **Paper Trading**: Free practice accounts with real market data
- **Robust API**: RESTful v20 API with streaming prices
- **Excellent XAU/USD spreads**: Competitive pricing on gold
- **Proven reliability**: Used by professional traders globally
- **JavaScript-friendly**: Excellent Node.js libraries available

**API Access**:
- Practice Account: `https://api-fxpractice.oanda.com`
- Live Account: `https://api-fxtrade.oanda.com`
- Documentation: `https://developer.oanda.com/rest-live-v20/introduction/`

**Getting Started**:
1. Sign up at oanda.com
2. Get your practice account API token
3. Install oanda-v20 npm package: `npm install @oanda/v20`

---

## 🏆 The Core Strategy - "Triple Confirmation Trend Follower"

This strategy has been profitable in gold markets for years because it waits for **three confirmations** before entering a trade. Gold is a trending market - we ride those trends.

### Strategy Components:

#### 1. **Trend Filter** (20 & 50 EMA)
```javascript
// Use the 20 and 50 period Exponential Moving Averages on 4-hour chart
// BULLISH: Price above 20 EMA, and 20 EMA above 50 EMA
// BEARISH: Price below 20 EMA, and 20 EMA below 50 EMA
// NEUTRAL: Don't trade when EMAs are tangled
```

**Why it works**: Gold trends strongly. Following the trend is 80% of the game.

#### 2. **Momentum Confirmation** (RSI 14)
```javascript
// RSI on 14 periods
// BULLISH: RSI between 40-70 (uptrend momentum)
// BEARISH: RSI between 30-60 (downtrend momentum)
// AVOID: RSI > 75 (overbought) or RSI < 25 (oversold)
```

**Why it works**: Filters out exhausted moves. We want momentum, not extremes.

#### 3. **Entry Trigger** (Support/Resistance + Candlestick Pattern)
```javascript
// Wait for price to pull back to support (in uptrend) or resistance (in downtrend)
// THEN wait for bullish/bearish engulfing candle or hammer/shooting star
// This is our entry signal
```

**Why it works**: Getting a good entry price is the difference between profit and loss.

### Trade Rules:

**LONG Entry (Buying Gold)**:
1. 20 EMA > 50 EMA (trend is up)
2. Price is above 20 EMA
3. RSI between 40-70
4. Price pulls back to support level or 20 EMA
5. Bullish engulfing candle or hammer forms
6. Enter on close of confirmation candle

**SHORT Entry (Selling Gold)**:
1. 20 EMA < 50 EMA (trend is down)
2. Price is below 20 EMA
3. RSI between 30-60
4. Price bounces to resistance level or 20 EMA
5. Bearish engulfing candle or shooting star forms
6. Enter on close of confirmation candle

**Stop Loss**:
- LONG: Below the recent swing low (typically 20-40 pips below entry)
- SHORT: Above the recent swing high (typically 20-40 pips above entry)

**Take Profit**:
- Target 1: 1.5x risk (60% of position)
- Target 2: 2.5x risk (40% of position)
- Move stop to breakeven after Target 1 hit

**Risk Per Trade**: 1-2% of account maximum

---

## 🔍 Technical Analysis Capabilities

### Prompt Templates for Claude Code:

#### **Support & Resistance Analysis**
```
"Analyze the XAU/USD 4-hour chart for the last 30 days. Identify the three most significant support and resistance levels based on:
1. Price rejection points (wicks)
2. Consolidation zones
3. Round number levels
Provide the exact price levels and explain why they're significant."
```

#### **Candlestick Pattern Recognition**
```
"Examine the last 20 candlesticks on the XAU/USD 4-hour chart. Identify any:
- Bullish/Bearish engulfing patterns
- Hammer or shooting star candles
- Doji candles at key levels
For each pattern found, provide:
- The exact candle location (timestamp)
- The pattern type
- Whether it aligns with our trend filter (20/50 EMA)
- Risk/reward ratio if we enter"
```

#### **Trend Strength Analysis**
```
"Calculate the following for XAU/USD on 4-hour timeframe:
1. Current position of price relative to 20 EMA and 50 EMA
2. RSI value (14 period)
3. MACD (12, 26, 9) - is it above/below signal line?
4. Are we in a trending or ranging market?
5. Give me a trend strength score (1-10) with explanation"
```

#### **Chart Pattern Recognition**
```
"Analyze XAU/USD daily chart for the last 60 days. Look for:
- Head and Shoulders (bullish or bearish)
- Double tops/bottoms
- Ascending/Descending triangles
- Bull/Bear flags

For any pattern found:
- Draw the pattern with ASCII or describe key points
- Calculate target price based on pattern rules
- Suggest stop loss placement
- Rate the pattern reliability (1-10)"
```

#### **Entry Timing Analysis**
```
"Based on current XAU/USD 4-hour chart:
1. Are we in a trending market? (Check 20/50 EMA alignment)
2. What is the current RSI value? Is momentum healthy?
3. Are we near support/resistance?
4. Has a confirmation candlestick formed?
5. VERDICT: Is this a good entry point? YES/NO and why
6. If YES, provide exact entry price, stop loss, and two take profit targets"
```

---

## 📰 Fundamental Analysis & Sentiment

Gold trades heavily on **macroeconomic factors**. Your bot needs to be aware of these.

### Key Fundamental Drivers:

#### **BULLISH for Gold** (Go Long XAU/USD):
- **High/Rising Inflation**: Gold is inflation hedge
- **Weak US Dollar**: Inverse correlation with gold
- **Geopolitical Instability**: War, political crisis, uncertainty
- **Dovish Fed Policy**: Interest rate cuts, QE announcements
- **Central Bank Gold Buying**: Especially China, Russia, India

#### **BEARISH for Gold** (Go Short XAU/USD):
- **Strong US Dollar**: Gold priced in USD
- **Rising Interest Rates**: Higher yields compete with gold
- **Strong US Economy**: Risk-on sentiment
- **Low Inflation**: Removes inflation hedge need
- **Hawkish Fed Policy**: Rate hikes, tightening

### Prompt Templates for Fundamental Analysis:

#### **News Impact Analysis**
```
"Act as an expert fundamental analyst for gold (XAU/USD). Analyze the following news article and provide:

1. SENTIMENT: Bullish/Bearish/Neutral for gold prices
2. IMPACT SCORE: 1-10 (how much will this move gold?)
3. TIMEFRAME: Immediate / Short-term / Long-term effect
4. TRADING RECOMMENDATION: 
   - Should we enter new positions?
   - Should we exit current positions?
   - Should we tighten stops?
   - Should we do nothing?

News Article:
[PASTE NEWS HERE]

Base your analysis on these rules:
- Bullish factors: Inflation fears, geopolitical crisis, weak dollar, dovish Fed
- Bearish factors: Strong economy, hawkish Fed, strong dollar, reduced uncertainty"
```

#### **Central Bank Analysis**
```
"Analyze the latest Fed/ECB/BOE statement for gold trading implications:

1. What is the central bank's stance on:
   - Interest rates (raising, cutting, holding)
   - Inflation outlook
   - Economic growth forecast

2. GOLD IMPACT:
   - Bullish or Bearish for gold?
   - Confidence level (1-10)
   - Expected price move (small/medium/large)

3. TRADING STRATEGY:
   - Should we adjust our positions?
   - Should we reduce exposure?
   - Should we increase exposure?

Statement:
[PASTE STATEMENT HERE]"
```

#### **Multi-Source Sentiment Score**
```
"Provide a comprehensive gold sentiment score based on:

1. Recent news headlines (last 24 hours)
2. Latest central bank statements
3. USD strength/weakness
4. VIX (fear index) levels
5. Gold ETF flows

OUTPUT:
- OVERALL SENTIMENT SCORE: -10 (very bearish) to +10 (very bullish)
- CONFIDENCE: Low/Medium/High
- KEY DRIVERS: Top 3 factors influencing sentiment
- RECOMMENDATION: Should our bot be biased long, short, or neutral?
- RISK FACTORS: What could invalidate this sentiment?"
```

#### **Economic Calendar Impact**
```
"We have the following economic events coming this week:
[PASTE ECONOMIC CALENDAR]

For each high-impact event (NFP, CPI, FOMC, etc.):
1. Expected impact on gold: Bullish/Bearish/Unclear
2. Volatility expectation: Low/Medium/High
3. Trading recommendation:
   - Should we avoid trading before the event?
   - Should we close positions before the event?
   - Should we reduce position sizes?
   - Are there any opportunities?

Provide a day-by-day trading plan for the week."
```

---

## ⚖️ Risk Management - The Real Secret to Longevity

**Listen up**: This is why I'm still in business after 20+ years. Not because I'm always right - because I manage risk like my life depends on it.

### Core Risk Management Rules:

#### 1. **Position Sizing Calculator**
```javascript
// Never risk more than 1-2% of account per trade
// Position size = (Account Size × Risk %) / (Entry Price - Stop Loss)

// Example:
// Account: $10,000
// Risk per trade: 1.5% = $150
// Entry: $2050
// Stop Loss: $2030
// Distance: $20
// Position Size: $150 / $20 = 7.5 units = 7,500 units (in Oanda terms)
```

### Prompt Template for Position Sizing:
```
"Calculate my position size for this gold trade:

Account Size: $10,000
Risk Per Trade: 1.5%
Entry Price: $2050
Stop Loss: $2030
Currency: USD

Provide:
1. Risk amount in dollars
2. Distance to stop loss in pips/points
3. Correct position size
4. Position size in Oanda units (1 unit = $1 of gold)
5. Risk/Reward ratio if Take Profit is at $2088"
```

#### 2. **Trade Management Decision Support**
```
"I'm in a long gold position with the following details:

Entry: $2050
Stop Loss: $2030
Current Price: $2045
Time in trade: 6 hours
Account: $10,000
Position Size: 7500 units

The price has moved against me slightly. Help me decide:
1. Is this normal market noise or a structural break?
2. Should I:
   a) Hold and trust my stop loss
   b) Exit now to minimize loss
   c) Tighten my stop loss
3. What does the current chart structure look like?
4. Are there any fundamental news that justify this move?
5. Emotional check: Am I feeling FUD? Help me be objective."
```

#### 3. **Drawdown & Portfolio Health Check**
```
"Analyze my trading performance for the last 30 days:

Total Trades: 25
Winning Trades: 16 (64% win rate)
Losing Trades: 9 (36%)
Largest Win: $450
Largest Loss: $180
Average Win: $280
Average Loss: $140
Current Drawdown: -$320 (3.2% of account)

Questions:
1. Is this a healthy trading profile?
2. Is my risk/reward ratio good enough?
3. Should I be concerned about the current drawdown?
4. Should I reduce position sizes temporarily?
5. What's my profit factor? (Total Wins / Total Losses)
6. Am I over-trading?"
```

#### 4. **Scenario Analysis & Stress Testing**
```
"Scenario: Geopolitical crisis erupts - Russia/Ukraine escalation

Current portfolio:
- 2 long gold positions (from $2045 and $2060)
- Total exposure: 15,000 units
- Account size: $10,000

Questions:
1. How might this scenario affect gold prices?
2. Should I:
   a) Add to positions (crisis = gold rally)?
   b) Take partial profits now?
   c) Tighten stops?
   d) Do nothing?
3. What's my maximum risk if both positions hit stop?
4. Should I hedge with any correlating instruments?
5. What's my game plan for different outcomes?"
```

---

## 🎨 Strategy Development & Backtesting

### Prompt Templates:

#### **Complete Strategy Development**
```
"Develop a complete swing trading strategy for gold (XAU/USD) with these parameters:

Timeframe: 4-hour chart
Indicators:
- 20 & 50 EMA (trend filter)
- RSI 14 (momentum)
- Support/Resistance levels (entry zones)

Requirements:
1. Define EXACT entry rules (be specific - no discretion)
2. Define EXACT exit rules (stop loss and take profit)
3. Define position sizing rules
4. Define conditions when we DON'T trade
5. Include a trade example with chart description
6. List common mistakes traders make with this strategy
7. How do we handle:
   - Choppy/ranging markets
   - Major news events
   - Losing streaks
   - Winning streaks

Make this strategy so clear a robot can execute it with zero discretion."
```

#### **Backtesting Request**
```
"Backtest the Triple Confirmation Trend Follower strategy on gold:

Historical Data: January 1, 2024 to October 31, 2024
Timeframe: 4-hour candles
Initial Capital: $10,000
Risk Per Trade: 1.5%

Strategy Rules:
[PASTE FULL STRATEGY RULES]

Provide simulated results:
1. Total number of trades
2. Winning trades / Losing trades
3. Win rate %
4. Average win / Average loss
5. Largest win / Largest loss
6. Maximum drawdown (%)
7. Profit factor (Gross Profit / Gross Loss)
8. Final account balance
9. Return on Investment %
10. Sharpe Ratio (if possible)
11. Best performing months
12. Worst performing months
13. Strategy weaknesses identified
14. Recommended improvements

Be realistic - include slippage and spread costs."
```

#### **Strategy Optimization**
```
"I've been running this gold strategy for 3 months with these results:
[PASTE RESULTS]

Help me optimize:
1. Which parameter is hurting performance most?
2. Should I adjust:
   - EMA periods (currently 20/50)?
   - RSI levels (currently 40-70 for longs)?
   - Stop loss distance?
   - Take profit targets?
3. Are there obvious improvements I'm missing?
4. Should I add any filters to avoid bad trades?
5. Provide 3 specific, actionable improvements to test"
```

---

## 🏗️ Implementation Architecture

### Recommended Tech Stack:

```javascript
// Core Dependencies
{
  "@oanda/v20": "^3.0.25",        // Oanda API client
  "technicalindicators": "^3.1.0", // RSI, EMA, MACD calculations
  "node-cron": "^3.0.2",           // Schedule chart analysis
  "winston": "^3.8.2",             // Logging
  "dotenv": "^16.0.3",             // Environment variables
  "axios": "^1.4.0",               // HTTP requests for news API
  "mongodb": "^5.6.0"              // Trade history storage
}
```

### File Structure:
```
gold-trading-bot/
├── config/
│   ├── strategy.config.js       // Strategy parameters
│   └── risk.config.js           // Risk management settings
├── src/
│   ├── analysis/
│   │   ├── technical.js         // Technical indicator calculations
│   │   ├── patterns.js          // Candlestick pattern recognition
│   │   └── sentiment.js         // News sentiment analysis
│   ├── trading/
│   │   ├── oanda-client.js      // Oanda API wrapper
│   │   ├── position-sizer.js    // Position size calculator
│   │   └── trade-manager.js     // Trade execution & management
│   ├── strategy/
│   │   └── triple-confirmation.js // Main strategy logic
│   └── utils/
│       ├── logger.js            // Winston logger setup
│       └── database.js          // MongoDB connection
├── tests/
│   └── backtest.js              // Backtesting engine
├── .env                         // API keys and config
├── CLAUDE.md                    // This file
└── index.js                     // Main entry point
```

---

## 🚀 Quick Start Commands

### 1. **Analyze Current Market**
```
"Give me the current market analysis for XAU/USD:
- 4-hour timeframe
- Check 20/50 EMA alignment
- Current RSI value
- Nearby support/resistance
- Should we be looking for long or short setups right now?"
```

### 2. **Check for Trade Setups**
```
"Scan XAU/USD 4-hour chart for our Triple Confirmation setups:
- Is trend filter aligned? (20 EMA vs 50 EMA)
- Is RSI in our range?
- Any bullish/bearish candlestick patterns near support/resistance?
- If a setup exists, provide entry, stop loss, and target prices"
```

### 3. **Risk Check Before Trading**
```
"Before I execute this trade, check:
- How many open positions do I currently have?
- What's my total exposure?
- If this trade hits stop loss, what % of account do I lose?
- Am I risking more than 5% total across all positions?
- Risk management verdict: PROCEED or WAIT"
```

### 4. **Daily Market Brief**
```
"Give me my daily gold trading brief:
1. Major news events today that affect gold
2. Current trend status (uptrend/downtrend/sideways)
3. Key levels to watch
4. Any active trade setups?
5. Recommended action: TRADE ACTIVELY / WAIT / STAY OUT"
```

---

## ⚠️ Trading Psychology & Common Mistakes

### What Keeps Traders Profitable:

1. **Follow Your Rules**: The strategy works. You breaking rules doesn't.
2. **Accept Losses**: 40% loss rate is NORMAL and ACCEPTABLE with proper R:R
3. **Don't Revenge Trade**: Lost $200? Don't try to make it back in one trade.
4. **Trust Your Stops**: They're there for a reason. Don't move them.
5. **Scale In Slowly**: Start with 0.5% risk while learning. Increase as confidence grows.

### Red Flags to Watch For:

```
"Review my last 10 trades and check for these red flags:
1. Am I moving stop losses away from price (bad)?
2. Am I exiting winners too early out of fear?
3. Am I holding losers too long hoping they turn?
4. Am I over-trading (>5 trades per day)?
5. Am I trading outside my defined strategy rules?
6. Give me a psychological health score (1-10) and advice"
```

---

## 📊 Performance Tracking

### Weekly Review Prompt:
```
"Analyze my week of gold trading:

Trades This Week: 8
Wins: 5
Losses: 3
Largest Win: $380
Largest Loss: $150
Starting Balance: $10,000
Ending Balance: $10,620

Provide:
1. Win rate this week
2. Average R:R ratio
3. Profit factor
4. Were there any strategy violations?
5. Best trade of the week (why?)
6. Worst trade of the week (what went wrong?)
7. Key lessons learned
8. Adjustments recommended for next week
9. Overall performance grade (A-F)"
```

---

## 🎯 Success Metrics (What "Good" Looks Like)

After 6 months of live trading, here's what success looks like:

- **Win Rate**: 55-65% (we're not trying to be right all the time)
- **Profit Factor**: >1.5 (making $1.50+ for every $1 lost)
- **Maximum Drawdown**: <15% (if you hit 20%, stop and review)
- **Average R:R**: >1.5:1 (winners bigger than losers)
- **Monthly Return**: 3-8% (steady beats spectacular)
- **Trades Per Week**: 2-5 (quality over quantity)

**Remember**: Professional traders aim for consistent, moderate returns. Anyone promising 50%+ monthly is lying or gambling.

---

## 🔧 Oanda-Specific Implementation Notes

### Account Setup:
```javascript
// Practice account for testing
const PRACTICE_ACCOUNT = {
  hostname: 'api-fxpractice.oanda.com',
  token: process.env.OANDA_PRACTICE_TOKEN,
  accountID: process.env.OANDA_PRACTICE_ACCOUNT_ID
};

// When ready for live (after 3+ months of profitable paper trading)
const LIVE_ACCOUNT = {
  hostname: 'api-fxtrade.oanda.com',
  token: process.env.OANDA_LIVE_TOKEN,
  accountID: process.env.OANDA_LIVE_ACCOUNT_ID
};
```

### XAU/USD Specifics:
- **Instrument**: `XAU_USD`
- **Minimum Trade Size**: 1 unit ($1 worth of gold)
- **Typical Spread**: 0.5-1.5 pips (depends on volatility)
- **Leverage**: Up to 50:1 (but we use max 10:1 for safety)
- **Trading Hours**: 24/5 (closed weekends like forex)

### Price Precision:
```javascript
// Gold prices use 2 decimal places
// Example: 2050.50 (not 2050.5034)
// Always round prices: parseFloat(price.toFixed(2))
```

---

## 🎓 Learning Path

### Week 1-2: Paper Trading Setup
- Set up Oanda practice account
- Implement basic technical analysis
- Manual trade execution (you approve each trade)
- Goal: Understand strategy mechanics

### Week 3-4: Semi-Automation
- Bot identifies setups
- You review and approve manually
- Start logging all trades
- Goal: Build confidence in strategy

### Week 5-8: Full Automation (Paper)
- Bot trades automatically on practice account
- Monitor performance daily
- Fine-tune parameters
- Goal: 60%+ win rate with 1.5+ profit factor

### Week 9-12: Live Trading (Small Size)
- Switch to live with 0.5% risk per trade
- Scale up slowly as confidence grows
- Keep manual override capability
- Goal: Prove consistency with real money

---

## 📞 When to Ask Claude for Help

### Good Uses of AI:
- Analyzing current chart setups
- Calculating position sizes
- Identifying patterns you might miss
- Sentiment analysis from news
- Performance reviews and optimization
- Emotional decision support ("Am I being rational?")

### Bad Uses of AI:
- "Should I trade right now?" → Use your strategy rules
- "Give me a hot tip" → No shortcuts
- "I lost 5 trades, what should I do?" → Stick to risk management
- "Predict where gold goes next" → Nobody knows

---

## 🟢 Current Active Strategy: Breakout + ADX MTF

The bot currently runs a **Breakout + ADX Multi-Timeframe** strategy, which outperformed Triple Confirmation in backtests.

### Strategy Architecture
```
Breakout + ADX MTF Strategy (H1 → M15)
├── TRADING HOURS: 08:00-22:00 UK time (skips Asian session)
├── Direction (H1): Price breaks 10-bar high/low (Donchian Channel)
├── ADX Filter: > 20 (confirms trending market)
├── Candle Filter: Bullish candle for longs, bearish for shorts
├── MTF Entry (M15): Wait for pullback to EMA20 or $0.50 pullback
├── Max Wait: 8 M15 candles (2 hours) before canceling signal
├── REAL-TIME MONITORING: Price checked every 30s, 60s confirmation
├── MOMENTUM FILTER: Confirmation price must be >= breakout price (prevents fakeouts)
├── Stop Loss: 550 pips ($5.50) - recalculated on actual fill price
├── Take Profit: NONE - trailing stop only (let winners run!)
├── Trailing Activation: 350 pips ($3.50) min profit before trailing
├── Trailing Stop: 150 pips ($1.50) - follows price, locks in profit
└── Trade Cooldown: 4 hours after any trade closes
```

### Key Filters Explained

**Trading Hours Filter**: Only trades 08:00-22:00 UK time. Asian session (00:00-08:00) has low liquidity and wild wicks that cause instant stop-outs.

**Momentum Filter**: After detecting a breakout, waits 60s for confirmation. If the confirmation price is worse than the initial breakout price (e.g., LONG breakout at $4787 but price falls to $4785 during confirmation), it's classified as a fakeout and skipped.

**Trade Cooldown**: After any trade closes (win or lose), no new entries for 4 hours. Prevents rapid re-entry losses when price bounces around a breakout level.

### Recent Improvements (2026)

| Date | Fix | Problem Solved |
|------|-----|----------------|
| Feb 2 | Momentum filter | Fakeouts where price reverses during 60s confirmation |
| Feb 2 | Trading hours filter | Asian session stop-outs in seconds |
| Jan 30 | 10-bar lookback | Too many false breakouts with 5-bar channel |
| Jan 30 | Real-time detection | Missing breakouts that happen within candles |
| Jan 30 | Trade cooldown | 4 losses in 15 minutes from same level |
| Jan 22 | Trailing activation | Trailing started at $0 profit, now requires $3.50 |
| Jan 21 | MTF entries | Better entry prices by waiting for pullbacks |

---

## ⚡ Final Words of Wisdom

**This isn't get-rich-quick. This is get-rich-slow-and-actually-keep-it.**

The strategy works because it's boring, consistent, and respects risk. Most traders fail because they:
1. Over-leverage (risking 10%+ per trade)
2. Don't follow their rules (discretionary nonsense)
3. Don't manage emotions (revenge trading, FOMO)
4. Give up after a few losses (it's a marathon, not a sprint)

You've got the edge with automation and Claude's analytical capabilities. Use it wisely.

**Start small. Trade the strategy. Review performance. Adjust. Repeat.**

That's how you stay in business for 20+ years.

---

## 📚 Additional Resources

- **Oanda API Docs**: https://developer.oanda.com/
- **Technical Analysis Library**: https://www.npmjs.com/package/technicalindicators
- **Gold Market News**: Kitco.com, GoldPrice.org
- **Economic Calendar**: ForexFactory.com, Investing.com

---

**Version**: 2.0
**Last Updated**: February 2026
**Maintained By**: Claude + Paul (The Gold Trading Team)

---

*"The goal is not to be right all the time. The goal is to make more when you're right than you lose when you're wrong. Simple as that."*
- Always remember I am in UK timezone, so next scan of 14:15 isn't applicable to me