/**
 * Reconcile the strategy tracker against Oanda, trade by trade.
 *
 * The tracker (tracker_data.json) is what every win-rate, PF and R figure is computed from, but it
 * is the bot's own record — it has been wrong before (notional P&L before the Jun 3 backfill, R
 * understated by the FX rate before Aug 19). Oanda's closed-trade list is the source of truth.
 * This lines the two up and reports every disagreement ("break") with a one-line cause.
 *
 * The tracker stores no Oanda trade ID, so trades are matched on direction + units + the nearest
 * Oanda open time within MATCH_WINDOW_MS of the tracker's entryTime.
 *
 *   node scripts/reconcile.mjs --tracker tracker.json --closed closed.json [--open open.json] [--json]
 *
 * closed.json = GET /v3/accounts/{id}/trades?state=CLOSED&instrument=XAU_USD&count=500
 * open.json   = GET /v3/accounts/{id}/openTrades
 * Exit code: 0 = clean, 1 = at least one break, 2 = bad input.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

export const TOL = {
  MATCH_WINDOW_MS: 10 * 60 * 1000, // tracker entryTime is stamped ~1-2s after the fill
  PRICE: 0.011,                    // gold prices are 2dp; allow float noise
  PNL: 0.011,                      // account currency
  EXIT_LAG_MS: 3 * 60 * 1000,      // position monitor polls every 60s, so the tracker's exitTime lags Oanda's by up to ~60-90s
  GAP_USD: 2.0,                    // stop filled this far past its level = a gap, not normal slippage
};

const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
const dir = (units) => (units > 0 ? 'LONG' : 'SHORT');
const fmt = (n, dp = 2) => (Number.isFinite(n) ? n.toFixed(dp) : 'n/a');

/** Which dependent order closed the trade, in the tracker's exitReason vocabulary. */
export function oandaExitReason(t) {
  if (t.takeProfitOrder?.state === 'FILLED') return 'TAKE_PROFIT_ORDER';
  if (t.stopLossOrder?.state === 'FILLED') return 'STOP_LOSS_ORDER';
  if (t.trailingStopLossOrder?.state === 'FILLED') return 'TRAILING_STOP_LOSS_ORDER';
  return 'MARKET_ORDER'; // closed by the bot, by hand, or margin closeout
}

function normaliseOanda(t) {
  const units = num(t.initialUnits);
  return {
    id: t.id,
    signal: dir(units),
    units: Math.abs(units),
    entryPrice: num(t.price),
    openTime: Date.parse(t.openTime),
    closeTime: t.closeTime ? Date.parse(t.closeTime) : NaN,
    exitPrice: num(t.averageClosePrice),
    realizedPL: num(t.realizedPL),
    financing: num(t.financing) || 0,
    stopPrice: num(t.stopLossOrder?.price),
    exitReason: t.state === 'CLOSED' ? oandaExitReason(t) : null,
    partial: (t.closingTransactionIDs?.length || 0) > 1,
  };
}

function trackerTrades(tracker) {
  const out = [];
  for (const s of Object.values(tracker.strategies || {})) {
    for (const t of s.trades || []) if (t.isLive) out.push({ ...t, _state: 'closed' });
    for (const t of s.openPositions || []) if (t.isLive) out.push({ ...t, _state: 'open' });
  }
  return out.sort((a, b) => Date.parse(a.entryTime) - Date.parse(b.entryTime));
}

/** Greedy nearest-open-time match on direction + units. Each Oanda trade is used at most once. */
export function matchTrades(tracked, oanda) {
  const used = new Set();
  const pairs = [];
  const trackerOnly = [];
  for (const t of tracked) {
    const at = Date.parse(t.entryTime);
    let best = null;
    for (const o of oanda) {
      if (used.has(o.id) || o.signal !== t.signal || o.units !== Math.abs(num(t.size))) continue;
      const dt = Math.abs(o.openTime - at);
      if (dt <= TOL.MATCH_WINDOW_MS && (!best || dt < best.dt)) best = { o, dt };
    }
    if (best) { used.add(best.o.id); pairs.push({ t, o: best.o }); } else trackerOnly.push(t);
  }
  return { pairs, trackerOnly, oandaOnly: oanda.filter((o) => !used.has(o.id)) };
}

/** Compare one matched pair. Returns breaks (disagree, affect stats) and notes (explained, expected). */
export function comparePair({ t, o }) {
  const breaks = [];
  const notes = [];
  const add = (list, field, tracker, broker, cause) => list.push({ field, tracker, broker, cause });
  const isOpen = t._state === 'open';

  if (Math.abs(num(t.entryPrice) - o.entryPrice) > TOL.PRICE) {
    add(breaks, 'entryPrice', t.entryPrice, o.entryPrice,
      `Tracker recorded the signal/quoted price instead of the fill because entryPrice was never updated after the fill — R and P&L-per-unit are off by $${fmt(Math.abs(num(t.entryPrice) - o.entryPrice))}.`);
  }

  // The tracker's stopLoss is the fill-based initial stop. Oanda's stopLossOrder is the LAST one on
  // the trade, so in the trail/BE era (before bracket-jul10) a difference is expected and not a break.
  const bracket = String(t.regime || '').startsWith('bracket');
  if (Number.isFinite(o.stopPrice) && Math.abs(num(t.stopLoss) - o.stopPrice) > TOL.PRICE) {
    if (bracket) {
      add(breaks, 'stopLoss', t.stopLoss, o.stopPrice,
        'Oanda\'s stop differs from the tracker\'s in the bracket era, where the stop never moves — the bracket was not set where the bot thinks, or the tracker kept the signal-based stop; check the fill\'s `Bracket verified` log line.');
    } else {
      add(notes, 'stopMoved', t.stopLoss, o.stopPrice,
        'Oanda\'s final stop differs from the tracker\'s initial stop because the pre-bracket trail/BE moved it — expected.');
    }
  }

  if (isOpen) return { breaks, notes };

  if (Math.abs(num(t.exitPrice) - o.exitPrice) > TOL.PRICE) {
    add(breaks, 'exitPrice', t.exitPrice, o.exitPrice,
      'Tracker exitPrice differs from Oanda\'s averageClosePrice because the tracker took a quoted price at detection instead of the fill — R stats use the wrong exit.');
  }

  const pnl = num(t.pnl);
  if (Math.abs(pnl - o.realizedPL) > TOL.PNL) {
    const cause = t.pnlSource === 'broker'
      ? `Tracker stored a broker P&L that does not match Oanda's realizedPL (Δ ${fmt(pnl - o.realizedPL)}) although pnlSource=broker — trace the closing transaction(s)${o.partial ? '; Oanda closed this in several pieces' : ''}.`
      : `Tracker stored price-notional P&L (pnlSource=${t.pnlSource || 'unset'}) because broker realizedPL was not captured at close — backfill pnl from Oanda (Δ ${fmt(pnl - o.realizedPL)}).`;
    add(breaks, 'pnl', pnl, o.realizedPL, cause);
  }

  if (t.exitReason && t.exitReason !== o.exitReason) {
    add(breaks, 'exitReason', t.exitReason, o.exitReason,
      `Tracker labelled the exit ${t.exitReason} but Oanda filled a ${o.exitReason} — TP-rate and stop-rate counts are wrong for this trade.`);
  }

  const lag = Date.parse(t.exitTime) - o.closeTime;
  if (Number.isFinite(lag) && (lag < -5000 || lag > TOL.EXIT_LAG_MS)) {
    const off = Math.abs(lag) >= 86400000 ? `${(Math.abs(lag) / 86400000).toFixed(1)}d` : `${Math.round(Math.abs(lag) / 1000)}s`;
    const cause = String(t.pnlSource || '').includes('backfill')
      ? `Tracker exitTime is ${off} after Oanda's close because the trade was inserted by a manual backfill that stamped the edit time, not the close — P&L is right, hold-time is wrong; set exitTime to Oanda's closeTime.`
      : `Tracker exitTime is ${off} ${lag > 0 ? 'after' : 'before'} Oanda's close, outside the 60-s monitor's normal lag — the close was detected late (bot down across the close?) or matched to the wrong trade; hold-time stats are off.`;
    add(breaks, 'exitTime', t.exitTime, new Date(o.closeTime).toISOString(), cause);
  }

  // Explained, not breaks — reported so the totals line reads correctly.
  if (o.financing !== 0) {
    add(notes, 'financing', 0, o.financing,
      `Oanda booked ${fmt(o.financing)} overnight financing (${o.financing < 0 ? 'cost' : 'credit'}) that the tracker leaves out because realizedPL excludes it — not a tracker error.`);
  }
  if (o.exitReason === 'STOP_LOSS_ORDER' && Number.isFinite(o.stopPrice)) {
    const past = (o.signal === 'LONG' ? 1 : -1) * (o.stopPrice - o.exitPrice);
    if (past > TOL.GAP_USD) {
      add(notes, 'stopGap', o.stopPrice, o.exitPrice,
        `Stop filled $${fmt(past)} past its level because price gapped through it — check the clock against NFP/CPI/FOMC; not a tracker error.`);
    }
  }
  return { breaks, notes };
}

export function reconcile(tracker, closedRaw, openRaw = []) {
  const oanda = [...closedRaw, ...openRaw].map(normaliseOanda);
  const tracked = trackerTrades(tracker);
  const { pairs, trackerOnly, oandaOnly } = matchTrades(tracked, oanda);
  const firstTracked = tracked.length ? Math.min(...tracked.map((t) => Date.parse(t.entryTime))) : Infinity;

  const rows = pairs.map((p) => ({ ...p, ...comparePair(p) }));
  const openIds = new Set(openRaw.map((t) => t.id));
  const missing = oandaOnly.filter((o) => o.openTime >= firstTracked - TOL.MATCH_WINDOW_MS);
  const preHistory = oandaOnly.length - missing.length;

  const closedPairs = pairs.filter((p) => p.t._state === 'closed');
  const totals = {
    trackerPnl: closedPairs.reduce((s, p) => s + num(p.t.pnl), 0),
    oandaPnl: closedPairs.reduce((s, p) => s + p.o.realizedPL, 0),
    financing: closedPairs.reduce((s, p) => s + p.o.financing, 0),
  };

  const breakCount = rows.reduce((s, r) => s + r.breaks.length, 0) + trackerOnly.length + missing.length;
  return {
    matched: pairs.length, rows, trackerOnly, missing, preHistory, totals, breakCount,
    openOnBroker: [...openIds], openInTracker: tracked.filter((t) => t._state === 'open').length,
  };
}

function label(t, o) {
  const when = String(t?.entryTime || new Date(o.openTime).toISOString()).slice(0, 16).replace('T', ' ');
  return `${o ? `#${o.id}` : '(no Oanda id)'} ${t?.signal || o.signal} ${when}Z`;
}

export function toMarkdown(r) {
  const L = [];
  L.push(`**Matched ${r.matched}** tracker↔Oanda trades · **${r.breakCount} break(s)** · ${r.preHistory} Oanda trades pre-date the tracker (expected, not checked)`);
  L.push('');
  const d = r.totals.trackerPnl - r.totals.oandaPnl;
  L.push(`Closed P&L — tracker ${fmt(r.totals.trackerPnl)} · Oanda realizedPL ${fmt(r.totals.oandaPnl)} · Δ ${fmt(d)} · financing ${fmt(r.totals.financing)} (Oanda net ${fmt(r.totals.oandaPnl + r.totals.financing)})`);
  L.push(`Open — tracker ${r.openInTracker} · Oanda ${r.openOnBroker.length}${r.openOnBroker.length ? ` (${r.openOnBroker.join(', ')})` : ''}`);

  const breakRows = r.rows.filter((x) => x.breaks.length);
  if (breakRows.length || r.trackerOnly.length || r.missing.length) {
    L.push('', '### Breaks', '', '| Trade | Field | Tracker | Oanda | Cause |', '|---|---|---|---|---|');
    for (const x of breakRows) for (const b of x.breaks) L.push(`| ${label(x.t, x.o)} | ${b.field} | ${b.tracker} | ${b.broker} | ${b.cause} |`);
    for (const t of r.trackerOnly) L.push(`| ${label(t)} | — | ${t.size}u @ ${t.entryPrice} | none | Tracker has a live trade Oanda never filled (phantom) or units/direction disagree — trace by hand. |`);
    for (const o of r.missing) L.push(`| ${label(null, o)} | — | none | ${o.units}u @ ${o.entryPrice}, P&L ${fmt(o.realizedPL)} | Oanda has a trade the tracker never recorded — manual trade, or the bot lost it across a restart; stats are missing it. |`);
  }

  // Trail/BE stop moves are routine for every pre-bracket trade — one count line, not a row each.
  const moved = r.rows.filter((x) => x.notes.some((n) => n.field === 'stopMoved')).length;
  const noteRows = r.rows.map((x) => ({ ...x, notes: x.notes.filter((n) => n.field !== 'stopMoved') })).filter((x) => x.notes.length);
  if (noteRows.length || moved) {
    L.push('', '### Explained differences (not breaks)', '');
    if (moved) L.push(`${moved} pre-bracket trade(s) closed on a stop the trail/BE had moved from the tracker's initial stop — expected.`, '');
    if (noteRows.length) {
      L.push('| Trade | Field | Tracker | Oanda | Cause |', '|---|---|---|---|---|');
      for (const x of noteRows) for (const n of x.notes) L.push(`| ${label(x.t, x.o)} | ${n.field} | ${n.tracker} | ${n.broker} | ${n.cause} |`);
    }
  }
  return L.join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
  const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
  try {
    const tracker = read(opt('--tracker'));
    const closed = read(opt('--closed'));
    const open = opt('--open') ? read(opt('--open')) : { trades: [] };
    if (!Array.isArray(closed.trades)) throw new Error(`--closed has no trades array: ${JSON.stringify(closed).slice(0, 200)}`);
    const r = reconcile(tracker, closed.trades, open.trades || []);
    console.log(args.includes('--json') ? JSON.stringify(r, null, 2) : toMarkdown(r));
    process.exit(r.breakCount ? 1 : 0);
  } catch (e) {
    console.error(`reconcile: ${e.message}`);
    process.exit(2);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
