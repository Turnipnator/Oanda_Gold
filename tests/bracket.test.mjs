/**
 * Regression tests for post-fill bracket verification.
 *
 * The bug: after a market order filled, the bot recalculated SL and TP from the actual fill
 * price and pushed them with two independent modifyTrade() calls, each swallowing failure into
 * a warning. Under bracket exit those two resting orders are the entire exit strategy, so a
 * failure left the trade running on levels computed from the pre-fill analysis price — or, if
 * only one leg landed, on a mismatched bracket. Oanda also rejects modifications inside an
 * HTTP 2xx body, so "did not throw" never meant "applied".
 *
 * Run: npm run test:bracket
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import OandaClient from '../src/oanda_client.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// src/index.js instantiates and starts the bot at module scope, so it cannot be imported in a
// test. Pull ensureBracket out of the source instead — this tests the shipped code, and fails
// loudly if the method is renamed or moved.
function loadEnsureBracket() {
  const src = fs.readFileSync(path.join(ROOT, 'src/index.js'), 'utf8');
  const start = src.indexOf('  async ensureBracket(tradeId, intendedSL, intendedTP) {');
  if (start < 0) throw new Error('ensureBracket() not found in src/index.js — was it renamed?');
  const open = src.indexOf('{', start);
  let depth = 0, end = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) { end = i; break; }
  }
  const body = src.slice(open + 1, end);
  const logger = { info: () => {}, warn: () => {}, error: () => {} };
  return new Function('logger', `return async function ensureBracket(tradeId, intendedSL, intendedTP) {${body}};`)(logger);
}

const ensureBracket = loadEnsureBracket();
const silent = { info: () => {}, warn: () => {}, error: () => {} };

let pass = 0, fail = 0;
const check = (name, cond, detail = '') => cond
  ? (pass++, console.log(`  ok   ${name}`))
  : (fail++, console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`));
const section = name => console.log(`\n${name}`);

/** A trade as getTrade() returns it. Protective orders rest in state PENDING. */
const trade = (sl, tp, state = 'OPEN', slState = 'PENDING', tpState = 'PENDING') => ({
  tradeId: '1', state, stopLoss: sl, takeProfit: tp,
  stopLossState: sl === null ? null : slState,
  takeProfitState: tp === null ? null : tpState
});

/** Fake client: `reads` feeds getTrade in order, `modifies` feeds modifyTrade (Error = fails). */
function fakeClient({ reads = [], modifies = [] }) {
  const calls = { reads: 0, modify: [] };
  const step = (list, i) => list[Math.min(i, list.length - 1)];
  return {
    calls,
    async getTrade() {
      const r = step(reads, calls.reads++);
      if (r instanceof Error) throw r;
      return r;
    },
    async modifyTrade(id, sl, tp) {
      calls.modify.push({ sl, tp });
      const r = step(modifies, calls.modify.length - 1);
      if (r instanceof Error) throw r;
      return { success: true };
    }
  };
}
const run = (client, sl = 4060, tp = 4140) => ensureBracket.call({ client }, '1', sl, tp);

// ── ensureBracket ────────────────────────────────────────────────────────────────────────
section('ensureBracket: bracket already correct');
{
  const c = fakeClient({ reads: [trade(4060, 4140)] });
  const r = await run(c);
  check('verified', r.verified === true);
  check('sends no pointless modification', c.calls.modify.length === 0);
}

section('ensureBracket: stale levels are repaired in ONE atomic request');
{
  const c = fakeClient({ reads: [trade(4058, 4136), trade(4060, 4140)], modifies: [{}] });
  const r = await run(c);
  check('verified', r.verified === true);
  check('exactly one modification', c.calls.modify.length === 1, `got ${c.calls.modify.length}`);
  check('both legs in the same request', c.calls.modify[0].sl === 4060 && c.calls.modify[0].tp === 4140,
    JSON.stringify(c.calls.modify[0]));
  check('returns broker values, not requested ones', r.stopLoss === 4060 && r.takeProfit === 4140);
}
{
  const c = fakeClient({ reads: [trade(4060, 4136), trade(4060, 4140)], modifies: [{}] });
  await run(c);
  check('a correct leg is left alone', c.calls.modify[0].sl === null && c.calls.modify[0].tp === 4140,
    JSON.stringify(c.calls.modify[0]));
}

section('ensureBracket: failures');
{
  const c = fakeClient({
    reads: [trade(4058, 4136), trade(4058, 4136), trade(4060, 4140)],
    modifies: [new Error('Modification rejected by Oanda - stopLoss: STOP_LOSS_ON_FILL_LOSS'), {}]
  });
  const r = await run(c);
  check('a rejected modification is retried', c.calls.modify.length === 2);
  check('recovery verifies', r.verified === true);
}
{
  const c = fakeClient({ reads: [trade(4058, 4136)], modifies: [new Error('Request failed after 3 attempts: 503')] });
  const r = await run(c);
  check('persistent failure is not silent', r.verified === false);
  check('reports what the broker HOLDS, not what we wanted', r.stopLoss === 4058, `got ${r.stopLoss}`);
  check('surfaces the broker reason', /503/.test(r.reason), r.reason);
  check('bounded retries', c.calls.modify.length === 3, `got ${c.calls.modify.length}`);
}
{
  const c = fakeClient({ reads: [new Error('503 unavailable')] });
  const r = await run(c);
  check('an unreadable trade returns unverified rather than throwing', r.verified === false);
}

section('ensureBracket: an unprotected position is detectable');
{
  const c = fakeClient({ reads: [trade(null, 4140), trade(4060, 4140)], modifies: [{}] });
  const r = await run(c);
  check('a missing stop is repaired', c.calls.modify[0].sl === 4060 && r.verified === true);
}
{
  const c = fakeClient({ reads: [trade(null, 4140)], modifies: [new Error('boom')] });
  const r = await run(c);
  check('unrepairable → unverified with stopLoss null so the caller can alarm',
    r.verified === false && r.stopLoss === null);
}
{
  // Right price, but the order was cancelled — it protects nothing.
  const c = fakeClient({ reads: [trade(4060, 4140, 'OPEN', 'CANCELLED'), trade(4060, 4140)], modifies: [{}] });
  const r = await run(c);
  check('a non-resting stop counts as absent', c.calls.modify.length === 1 && r.verified === true);
}

section('ensureBracket: edge cases');
{
  const c = fakeClient({ reads: [trade(4060, 4140, 'CLOSED')] });
  const r = await run(c);
  check('an already-closed trade needs no bracket', r.verified === true && c.calls.modify.length === 0);
}
{
  // Every in-loop read is stale and the third write succeeds: only the post-loop read proves it.
  const c = fakeClient({
    reads: [trade(4058, 4136), trade(4058, 4136), trade(4058, 4136), trade(4060, 4140)],
    modifies: [{}, {}, {}]
  });
  check('the final attempt is read back (no false alarm)', (await run(c)).verified === true);
}
{
  const c = fakeClient({ reads: [trade(4060, 9999)] });
  const r = await run(c, 4060, null);
  check('with no intended TP the target leg is ignored', r.verified === true && c.calls.modify.length === 0);
}
{
  const c = fakeClient({ reads: [trade(4060.004, 4140)] });
  check('sub-cent difference is not churned', (await run(c)).verified === true && c.calls.modify.length === 0);
  const c2 = fakeClient({ reads: [trade(4060.05, 4140), trade(4060, 4140)], modifies: [{}] });
  await run(c2);
  check('a real difference is corrected', c2.calls.modify.length === 1);
}

// ── OandaClient ──────────────────────────────────────────────────────────────────────────
function stubClient(response) {
  const c = new OandaClient(silent);
  c.makeRequest = async (_m, _e, body) => { c._body = body; return response; };
  return c;
}

section('modifyTrade: a rejection inside a 2xx response must not read as success');
{
  const c = stubClient({ stopLossOrderRejectTransaction: { rejectReason: 'STOP_LOSS_ON_FILL_LOSS' } });
  let err = null;
  try { await c.modifyTrade('1', 4060, null); } catch (e) { err = e; }
  check('throws', err !== null);
  check('names the broker reason', /STOP_LOSS_ON_FILL_LOSS/.test(err?.message || ''), err?.message);
}
{
  const c = stubClient({
    stopLossOrderTransaction: { price: '4060.00' },
    takeProfitOrderRejectTransaction: { rejectReason: 'TAKE_PROFIT_ON_FILL_LOSS' }
  });
  let err = null;
  try { await c.modifyTrade('1', 4060, 4140); } catch (e) { err = e; }
  check('a half-applied bracket throws', err !== null);
  check('blames only the failed leg', /takeProfit/.test(err?.message) && !/stopLoss:/.test(err?.message), err?.message);
}
{
  const c = stubClient({ lastTransactionID: '999' });
  let err = null;
  try { await c.modifyTrade('1', 4060, null); } catch (e) { err = e; }
  check('a response with no transaction at all throws', /no stopLossOrderTransaction/.test(err?.message || ''));
}

section('modifyTrade: success path and request shape');
{
  const c = stubClient({ stopLossOrderTransaction: { price: '4060.00' }, takeProfitOrderTransaction: { price: '4140.00' } });
  const r = await c.modifyTrade('1', 4060.004, 4139.996);
  check('prices come back as numbers', r.stopLoss === 4060 && r.takeProfit === 4140);
  check('sent to Oanda at 2dp', c._body.stopLoss.price === '4060.00' && c._body.takeProfit.price === '4140.00');
  check('GTC preserved', c._body.stopLoss.timeInForce === 'GTC');
}
{
  const c = stubClient({ stopLossOrderTransaction: { price: '4060.00' } });
  const r = await c.modifyTrade('1', 4060, null);
  check('an SL-only request does not demand a TP transaction', r.success === true && r.takeProfit === null);
  check('and omits takeProfit from the body', c._body.takeProfit === undefined);
}

section('getTrade: normalisation');
{
  const c = new OandaClient(silent);
  c.makeRequest = async () => ({ trade: {
    id: '1450', state: 'OPEN', instrument: 'XAU_USD', currentUnits: '-21', price: '4078.73',
    stopLossOrder: { price: '4098.73', state: 'PENDING' },
    takeProfitOrder: { price: '4038.73', state: 'PENDING' }
  }});
  const t = await c.getTrade('1450');
  check('prices and units parsed', t.stopLoss === 4098.73 && t.takeProfit === 4038.73 && t.units === -21);
  check('order states exposed', t.stopLossState === 'PENDING' && t.takeProfitState === 'PENDING');
}
{
  const c = new OandaClient(silent);
  c.makeRequest = async () => ({ trade: { id: '1', state: 'OPEN', currentUnits: '21', price: '4000' } });
  const t = await c.getTrade('1');
  check('absent protective orders are null', t.stopLoss === null && t.takeProfit === null);
}

console.log(`\n${'─'.repeat(60)}\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
