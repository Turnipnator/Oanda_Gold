/**
 * Drawdown kill switch (risk_manager) and stale-data guard (freshness.js).
 *
 * Both are the "survival" checks: neither has an edge to protect, they exist so
 * a bad run or a frozen feed cannot keep sending orders. The properties that
 * matter are the ones that make them safe to rely on unattended:
 *   - the switch latches, survives a restart, and only an operator re-arms it;
 *   - the peak is REALISED balance, so floating profit cannot ratchet it;
 *   - the guard refuses on anything it cannot positively confirm is fresh.
 *
 * Run: npm run test:killswitch
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import RiskManager from '../src/risk_manager.js';
import Config from '../src/config.js';
import { assessFreshness } from '../src/freshness.js';

const silent = { info: () => {}, warn: () => {}, error: () => {}, risk: () => {}, trade: () => {} };
let pass = 0, fail = 0;
const check = (name, cond, detail = '') => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`));
const section = name => console.log(`\n${name}`);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'killswitch-'));
let fileN = 0;
const freshFile = () => path.join(tmp, `dd${fileN++}.json`);
function manager(file = freshFile()) {
  const rm = new RiskManager(silent, null);
  rm.drawdownFile = file;
  rm.drawdown = { peakBalance: null, peakAt: null, halted: false, haltedAt: null, haltBalance: null };
  rm.loadDrawdown();
  return rm;
}
const savedLimit = Config.MAX_DRAWDOWN_PCT;
Config.MAX_DRAWDOWN_PCT = 0.08;

section('drawdown kill switch');
{
  const rm = manager();
  rm.updateDrawdown(86429.84);
  check('first balance arms the switch at that peak', rm.drawdown.peakBalance === 86429.84 && !rm.drawdown.halted);
  rm.updateDrawdown(90000);
  check('a higher balance ratchets the peak', rm.drawdown.peakBalance === 90000);
  rm.updateDrawdown(82900);                                   // 7.89% down
  check('just under the limit stays armed', !rm.drawdown.halted);
  rm.updateDrawdown(82800);                                   // 8.0% down
  check('at the limit it latches', rm.drawdown.halted && rm.drawdown.haltBalance === 82800);
  check('it queues one alert', /DRAWDOWN KILL SWITCH/.test(rm.pendingDrawdownAlert || ''));
  const verdict = await rm.canOpenTrade(4178.58, 4158.58, 57);
  check('canOpenTrade refuses while halted', !verdict.allowed && /DRAWDOWN_HALT/.test(verdict.reason), verdict.reason);
  rm.updateDrawdown(95000);
  check('recovery does not un-latch it', rm.drawdown.halted);
  check('the peak is frozen while halted', rm.drawdown.peakBalance === 90000);

  const restarted = manager(rm.drawdownFile);
  check('a restart keeps it halted', restarted.drawdown.halted && restarted.drawdown.peakBalance === 90000);

  restarted.realisedBalance = 83000;
  restarted.resetDrawdown();
  check('/ddreset re-arms at the current balance', !restarted.drawdown.halted && restarted.drawdown.peakBalance === 83000);
  check('and that survives a restart', !manager(rm.drawdownFile).drawdown.halted);
}
{
  const rm = manager();
  rm.updateDrawdown(100000);
  rm.updateDrawdown(NaN);
  rm.updateDrawdown(-5);
  rm.updateDrawdown(0);
  check('garbage balances are ignored', rm.drawdown.peakBalance === 100000 && !rm.drawdown.halted);
}
{
  Config.MAX_DRAWDOWN_PCT = 0;
  const rm = manager();
  rm.updateDrawdown(100000);
  rm.updateDrawdown(10000);
  check('MAX_DRAWDOWN_PCT=0 disables it', !rm.drawdown.halted);
  Config.MAX_DRAWDOWN_PCT = 0.08;
}
{
  // NAV includes an open trade's float. A big unrealised gain must not raise the
  // peak, or giving it back would trip the switch on money never banked.
  const rm = manager();
  rm.homeFactorAt = Date.now();
  rm.client = {
    getBalance: async () => ({ balance: 86000, nav: 95000 }),
    getHomeConversionFactors: async () => ({ currency: 'USD', loss: 0.757 }),
  };
  await rm.syncBalance();
  check('the peak tracks realised balance, not NAV', rm.drawdown.peakBalance === 86000, `peak ${rm.drawdown.peakBalance}`);
}

section('stale-data guard');
const now = Date.parse('2026-10-16T10:09:07Z');
const h1 = startIso => ({ time: new Date(startIso), complete: true });
const base = {
  price: { time: '2026-10-16T10:09:05.123456789Z', tradeable: true },   // Oanda's nanosecond timestamps
  candles: [h1('2026-10-16T08:00:00Z'), h1('2026-10-16T09:00:00Z'), { time: new Date('2026-10-16T10:00:00Z'), complete: false }],
  granularity: 'H1', maxPriceAgeSec: 120, maxCandleAgeMin: 75, now,
};
{
  const v = assessFreshness(base);
  check('a live market passes', v.ok && Math.round(v.priceAge) === 2 && Math.round(v.candleAge) === 9, JSON.stringify(v));
  check('the incomplete candle is ignored', v.ok && v.candleAge < 10);
}
check('a price 121s old is refused',
  !assessFreshness({ ...base, price: { ...base.price, time: '2026-10-16T10:07:06Z' } }).ok);
check('a price with no timestamp is refused',
  !assessFreshness({ ...base, price: { tradeable: true } }).ok);
check('tradeable=false is refused',
  !assessFreshness({ ...base, price: { ...base.price, tradeable: false } }).ok);
check('a missing tradeable flag is not by itself a refusal',
  assessFreshness({ ...base, price: { time: base.price.time } }).ok);
check('a last candle that closed 76m ago is refused',
  !assessFreshness({ ...base, candles: [h1('2026-10-16T07:53:00Z')] }).ok);
check('one that closed 59m ago passes (the normal worst case on H1)',
  assessFreshness({ ...base, now: Date.parse('2026-10-16T10:59:00Z'), price: { time: '2026-10-16T10:58:59Z' } }).ok);
check('no completed candle at all is refused',
  !assessFreshness({ ...base, candles: [{ time: new Date('2026-10-16T10:00:00Z'), complete: false }] }).ok);
check('an unknown granularity is refused, not waved through',
  !assessFreshness({ ...base, granularity: 'H7' }).ok);

Config.MAX_DRAWDOWN_PCT = savedLimit;
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'─'.repeat(60)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
