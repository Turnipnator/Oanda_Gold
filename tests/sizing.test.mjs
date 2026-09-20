/**
 * Generated property tests for position sizing — risk_manager.calculatePositionSize.
 *
 * Two defects prompted these, both found by reading rather than by a failure:
 *
 *  1. NaN UNITS. `NaN === 0` is false and Math.floor/max/min all propagate NaN,
 *     so an undefined entry or stop produced a NaN size that passed
 *     `if (positionSize === 0)` at all three call sites, passed canOpenTrade
 *     (every comparison against NaN is false, so the heat check said "allowed"),
 *     and reached oanda_client.placeMarketOrder as `units.toString()` — the
 *     literal string "NaN" in the order payload. Never observed in the logs:
 *     latent, not realised.
 *
 *  2. THE MINIMUM OVERRODE THE RISK BUDGET. Math.max(size, MIN_POSITION_SIZE)
 *     ran AFTER the risk division, so a size the budget could not afford was
 *     inflated to the broker minimum and traded anyway. This one did fire:
 *     25 Jun 2026, `Risk=$438.72, Distance=$32.90, Size=100 units` — $3,290 at
 *     risk against a $438 budget, 7.5x, six such trades that fortnight.
 *
 * Properties, not examples, because the failure is a whole region of the input
 * space (any stop wide enough that the budget buys fewer than MIN units), not a
 * particular number someone would think to write down.
 *
 * Run: npm run test:sizing
 */
import fc from 'fast-check';
import RiskManager from '../src/risk_manager.js';
import OandaClient from '../src/oanda_client.js';
import Config from '../src/config.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, risk: () => {}, trade: () => {} };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`));
const section = name => console.log(`\n${name}`);

// A property holds when fast-check cannot falsify it; report the counterexample.
const report = (name, e) =>
  check(name, false, String(e.message ?? e).split('\n').slice(0, 3).join(' | ').slice(0, 220));

const prop = (name, arbitraries, predicate) => {
  try {
    fc.assert(fc.property(...arbitraries, predicate), { numRuns: 500 });
    check(name, true);
  } catch (e) { report(name, e); }
};

// Async predicates need asyncProperty and an awaited assert; handed to the sync
// form, fast-check sees a returned Promise and fails the property outright.
const propAsync = async (name, arbitraries, predicate) => {
  try {
    await fc.assert(fc.asyncProperty(...arbitraries, predicate), { numRuns: 200 });
    check(name, true);
  } catch (e) { report(name, e); }
};

function manager(balance, lossFactor = 1.0) {
  const rm = new RiskManager(silent, null);
  rm.currentBalance = balance;
  // Quote -> account currency. Live is ~0.754 (USD loss -> GBP); tests drive
  // the whole plausible range, and 1.0 is the pre-conversion behaviour.
  rm.homeLossFactor = lossFactor;
  rm.homeFactorAt = Date.now();
  return rm;
}

// Config statics are read at call time, so a test can drive MIN/MAX through the
// whole range the VPS might be set to. Restored at the end.
const savedMin = Config.MIN_POSITION_SIZE;
const savedMax = Config.MAX_POSITION_SIZE;
const withLimits = (min, max, fn) => {
  Config.MIN_POSITION_SIZE = min;
  Config.MAX_POSITION_SIZE = max;
  try { return fn(); } finally { Config.MIN_POSITION_SIZE = savedMin; Config.MAX_POSITION_SIZE = savedMax; }
};

// Gold-ish inputs: price, the stop distance the strategy caps at $2-$20 today
// (deliberately generated wider, to cover a config change), and the account.
const price = fc.double({ min: 500, max: 5000, noNaN: true });
const distance = fc.double({ min: 0.25, max: 150, noNaN: true });
const balance = fc.double({ min: 100, max: 500000, noNaN: true });
const riskPct = fc.double({ min: 0.001, max: 0.05, noNaN: true });
const minSize = fc.integer({ min: 1, max: 500 });
const nonFinite = fc.constantFrom(NaN, Infinity, -Infinity, undefined, null, 'x');
// Quote -> account currency. Live USD->GBP loss factor is ~0.754; generated wide
// enough to cover a different account currency or a different instrument.
const fxFactor = fc.double({ min: 0.3, max: 3, noNaN: true });

// The stop is passed as a PRICE, so the distance the code sees is
// |p - (p - d)|, which floating point does not always return as d exactly
// (500 - 0.25000000000000006 rounds to 499.75). Oracles must use the distance
// the function actually received, or they fail on arithmetic rather than logic.
const seenDistance = (p, d) => Math.abs(p - (p - d));

section('sizing never exceeds the risk budget');

prop('a sized trade never risks more than the budget, IN ACCOUNT CURRENCY',
  [price, distance, balance, riskPct, minSize, fxFactor],
  (p, d, bal, pct, min, fx) => withLimits(min, 50000, () => {
    const size = manager(bal, fx).calculatePositionSize(p, p - d, pct);
    if (size === 0) return true;                       // refused: nothing at risk
    // size * d is a QUOTE-currency loss; the budget is the account currency.
    // Comparing them unconverted is the bug this property now states away.
    return size * seenDistance(p, d) * fx <= bal * pct + 1e-9;
  }));

prop('a sized trade respects both broker limits', [price, distance, balance, riskPct, minSize, fxFactor],
  (p, d, bal, pct, min, fx) => withLimits(min, 50000, () => {
    const size = manager(bal, fx).calculatePositionSize(p, p - d, pct);
    return size === 0 || (size >= min && size <= 50000);
  }));

prop('a factor of 1.0 reproduces the pre-conversion numbers exactly',
  [price, distance, balance, riskPct],
  (p, d, bal, pct) => {
    const size = withLimits(1, 50000, () => manager(bal, 1.0).calculatePositionSize(p, p - d, pct));
    // A refused trade is the min-size rule, covered by its own property above;
    // this one is about conversion being NEUTRAL when no conversion is needed.
    const dd = seenDistance(p, d);
    return size === 0 || size === Math.min(Math.max(Math.floor((bal * pct) / dd), 1), 50000);
  });

prop('a stale or unusable factor falls back to 1.0 rather than to nonsense',
  [price, distance, balance, riskPct, fc.constantFrom(NaN, 0, -1, undefined)],
  (p, d, bal, pct, broken) => {
    const rm = manager(bal, 1.0);
    rm.homeLossFactor = broken;                        // never fetched, or a bad payload
    rm.homeFactorAt = 0;                               // and stale
    const size = withLimits(1, 50000, () => rm.calculatePositionSize(p, p - d, pct));
    const dd = seenDistance(p, d);
    return Number.isInteger(size) && size >= 0
        && (size === 0 || size === Math.min(Math.max(Math.floor((bal * pct) / dd), 1), 50000));
  });

prop('size is always a whole number of units', [price, distance, balance, riskPct],
  (p, d, bal, pct) => {
    const size = manager(bal).calculatePositionSize(p, p - d, pct);
    return Number.isInteger(size) && size >= 0;
  });

prop('a wider stop never buys a bigger position', [price, distance, distance, balance, riskPct],
  (p, d1, d2, bal, pct) => {
    const [near, far] = d1 <= d2 ? [d1, d2] : [d2, d1];
    const rm = manager(bal);
    const a = rm.calculatePositionSize(p, p - near, pct);
    const b = rm.calculatePositionSize(p, p - far, pct);
    return b === 0 || a === 0 || b <= a;
  });

await propAsync('portfolio heat scales with the conversion factor',
  [price, distance, balance, fc.integer({ min: 1, max: 40 })],
  async (p, d, bal, units) => {
    // Metamorphic rather than recomputed: doubling the factor must double the
    // heat. An unconverted heat calculation ignores the factor entirely, which
    // is how it read ~25% low against MAX_PORTFOLIO_RISK.
    const openTrades = [{ price: p, stopLoss: p - d, units }];
    const heatAt = async (fx) => {
      const rm = manager(bal, fx);
      rm.client = { getOpenTrades: async () => openTrades };
      return rm.calculatePortfolioHeat();
    };
    const single = await heatAt(1);
    const double = await heatAt(2);
    return Math.abs(double - 2 * single) <= 1e-9 * Math.max(1, double);
  });

section('garbage in, refusal out');

prop('a non-finite price or stop sizes to exactly 0, never NaN', [price, nonFinite, balance],
  (p, junk, bal) => {
    const rm = manager(bal);
    return rm.calculatePositionSize(junk, p, 0.005) === 0
        && rm.calculatePositionSize(p, junk, 0.005) === 0;
  });

prop('a non-finite balance sizes to exactly 0', [price, distance, nonFinite],
  (p, d, junk) => manager(junk).calculatePositionSize(p, p - d, 0.005) === 0);

await propAsync('canOpenTrade refuses a non-finite trade', [price, distance, balance, nonFinite],
  async (p, d, bal, junk) => {
    const rm = manager(bal);
    rm.calculatePortfolioHeat = async () => 0;
    const bad = await rm.canOpenTrade(p, junk, 10);
    const good = await rm.canOpenTrade(p, p - d, 10);
    // The finite trade may still be refused on its merits (daily loss, portfolio
    // heat on a small balance) — asserting it is always allowed was the property
    // being over-broad. What must hold is that only the garbage one is refused
    // FOR BEING GARBAGE.
    return bad.allowed === false
        && bad.reason === 'NON_FINITE_RISK'
        && good.reason !== 'NON_FINITE_RISK';
  });

section('nothing reaches the broker as "NaN"');

await propAsync('the order payload always carries an integer unit count', [price, distance, balance, riskPct, minSize],
  async (p, d, bal, pct, min) => {
    const size = withLimits(min, 50000, () => manager(bal).calculatePositionSize(p, p - d, pct));
    if (size === 0) return true;                       // the caller returns early on 0
    const client = new OandaClient(silent);
    let sent = null;
    client.makeRequest = async (_m, _u, body) => {
      sent = body;
      return { orderFillTransaction: { id: '1', price: String(p), units: String(size) } };
    };
    await client.placeMarketOrder('XAU_USD', size, p - d, null, null);
    return /^-?\d+$/.test(sent.order.units);           // "NaN" fails this
  });

console.log(`\n${'─'.repeat(60)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
