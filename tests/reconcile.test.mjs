/**
 * reconcile() — tracker vs Oanda, trade by trade. Pins down the matching rule (direction + units +
 * nearest open time) and that each kind of disagreement lands as a break or an explained note.
 *
 *   npm run test:reconcile
 */
import assert from 'assert';
import { reconcile, oandaExitReason } from '../scripts/reconcile.mjs';

const T0 = Date.parse('2026-09-17T18:08:48Z');
const iso = (ms) => new Date(ms).toISOString();

function trk(over = {}) {
  return {
    signal: 'LONG', size: 21, entryPrice: 4363.06, stopLoss: 4343.06, exitPrice: 4342.94,
    entryTime: iso(T0 + 1500), exitTime: iso(T0 + 82 * 60e3 + 22e3), pnl: -319.49,
    pnlSource: 'broker', exitReason: 'STOP_LOSS_ORDER', regime: 'bracket-jul10', isLive: true, ...over,
  };
}
function oa(over = {}) {
  return {
    id: '1484', price: '4363.060', openTime: iso(T0), initialUnits: '21.0', state: 'CLOSED',
    realizedPL: '-319.4900', financing: '0.0000', closeTime: iso(T0 + 82 * 60e3), averageClosePrice: '4342.940',
    closingTransactionIDs: ['1491'],
    stopLossOrder: { price: '4343.060', state: 'FILLED' }, takeProfitOrder: { price: '4403.060', state: 'CANCELLED' },
    ...over,
  };
}
const tracker = (trades, open = []) => ({ strategies: { 'EMA Trend': { trades, openPositions: open } } });
const fields = (r) => r.rows.flatMap((x) => x.breaks.map((b) => b.field));
const noteFields = (r) => r.rows.flatMap((x) => x.notes.map((n) => n.field));

let passed = 0;
const test = (name, fn) => { fn(); passed++; console.log(`  ✓ ${name}`); };

test('clean pair: matched, no breaks', () => {
  const r = reconcile(tracker([trk()]), [oa()]);
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.breakCount, 0);
});

test('P&L mismatch with pnlSource=notional is a break that says backfill', () => {
  const r = reconcile(tracker([trk({ pnl: -422.52, pnlSource: 'notional' })]), [oa()]);
  assert.deepStrictEqual(fields(r), ['pnl']);
  assert.match(r.rows[0].breaks[0].cause, /backfill pnl from Oanda/);
});

test('exit reason disagreement is a break', () => {
  const r = reconcile(tracker([trk({ exitReason: 'TAKE_PROFIT_ORDER' })]), [oa()]);
  assert.deepStrictEqual(fields(r), ['exitReason']);
});

test('bracket-era stop mismatch is a break; pre-bracket is a note', () => {
  const moved = oa({ stopLossOrder: { price: '4344.000', state: 'FILLED' }, averageClosePrice: '4342.940' });
  assert.deepStrictEqual(fields(reconcile(tracker([trk()]), [moved])), ['stopLoss']);
  const pre = reconcile(tracker([trk({ regime: undefined })]), [moved]);
  assert.strictEqual(pre.breakCount, 0);
  assert.deepStrictEqual(noteFields(pre), ['stopMoved']);
});

test('backfilled trade with an edit-time exitTime is a break with the backfill cause', () => {
  const r = reconcile(tracker([trk({ exitTime: iso(T0 + 13 * 86400e3), pnlSource: 'broker(backfill)' })]), [oa()]);
  assert.deepStrictEqual(fields(r), ['exitTime']);
  assert.match(r.rows[0].breaks[0].cause, /manual backfill/);
});

test('normal 60-s monitor lag on exitTime is not a break', () => {
  const r = reconcile(tracker([trk({ exitTime: iso(T0 + 82 * 60e3 + 90e3) })]), [oa()]);
  assert.strictEqual(r.breakCount, 0);
});

test('financing and a gapped stop are notes, not breaks', () => {
  const gapped = oa({ averageClosePrice: '4315.000', realizedPL: '-1000.0000', financing: '-9.0000' });
  const r = reconcile(tracker([trk({ exitPrice: 4315.0, pnl: -1000 })]), [gapped]);
  assert.strictEqual(r.breakCount, 0);
  assert.deepStrictEqual(noteFields(r).sort(), ['financing', 'stopGap']);
  assert.strictEqual(r.totals.financing, -9);
});

test('units or direction disagreement does not match: tracker-only AND Oanda-only', () => {
  const r = reconcile(tracker([trk({ size: 57 })]), [oa()]);
  assert.strictEqual(r.matched, 0);
  assert.strictEqual(r.trackerOnly.length, 1);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.breakCount, 2);
});

test('Oanda trades older than the first tracker trade are pre-history, not breaks', () => {
  const old = oa({ id: '600', openTime: iso(T0 - 90 * 86400e3), closeTime: iso(T0 - 90 * 86400e3 + 60e3) });
  const r = reconcile(tracker([trk()]), [old, oa()]);
  assert.strictEqual(r.preHistory, 1);
  assert.strictEqual(r.breakCount, 0);
});

test('Oanda trade after tracking began but absent from the tracker is a break', () => {
  const later = oa({ id: '1500', openTime: iso(T0 + 3 * 86400e3), closeTime: iso(T0 + 3 * 86400e3 + 60e3) });
  const r = reconcile(tracker([trk()]), [oa(), later]);
  assert.strictEqual(r.missing.length, 1);
  assert.strictEqual(r.missing[0].id, '1500');
});

test('nearest open time wins when two same-size trades are in the window', () => {
  const near = oa({ id: 'near', openTime: iso(T0) });
  const far = oa({ id: 'far', openTime: iso(T0 + 5 * 60e3) });
  const r = reconcile(tracker([trk()]), [far, near]);
  assert.strictEqual(r.rows[0].o.id, 'near');
});

test('open position matches an Oanda open trade and skips exit checks', () => {
  const openO = oa({ id: '1600', state: 'OPEN', closeTime: undefined, averageClosePrice: undefined, realizedPL: '0' });
  const r = reconcile(tracker([], [trk({ exitPrice: null, exitTime: null, pnl: null })]), [], [openO]);
  assert.strictEqual(r.matched, 1);
  assert.strictEqual(r.breakCount, 0);
  assert.deepStrictEqual(r.openOnBroker, ['1600']);
});

test('oandaExitReason maps the filled dependent order', () => {
  assert.strictEqual(oandaExitReason({ takeProfitOrder: { state: 'FILLED' } }), 'TAKE_PROFIT_ORDER');
  assert.strictEqual(oandaExitReason({ trailingStopLossOrder: { state: 'FILLED' } }), 'TRAILING_STOP_LOSS_ORDER');
  assert.strictEqual(oandaExitReason({ stopLossOrder: { state: 'CANCELLED' } }), 'MARKET_ORDER');
});

console.log(`reconcile: ${passed} tests passed`);
