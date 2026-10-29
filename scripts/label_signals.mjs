/**
 * Label the Phase 0 signal ledger (data/signal_ledger.jsonl) with outcomes after costs.
 *
 * The bot logs every trend-aligned H1 candle it evaluated, traded or not, with the features it
 * knew at that moment. This script adds what happened next, offline, so the live bot never sees
 * the future. Each row is scored on the bracket it would have placed: stop = stopDistance,
 * target = stopDistance × tpRR, entered at the first M1 bar that opens after loggedAt.
 *
 * Fills are on real Oanda M1 bid/ask, so the spread is in the result (Oanda charges no
 * commission on XAU_USD): LONG buys the ask and exits on the bid, SHORT the reverse. A bar
 * touching both levels = stop first. A bar opening through a level fills at that open (gaps).
 * Unresolved after CAP_HOURS = closed at market. Rows still open when the data ends = pending.
 *
 * Taken rows are matched by tradeId to Oanda's closed trades when --closed is given, and use the
 * broker's actual fill and exit prices instead of the simulation (source: 'broker').
 *
 *   OANDA_API_KEY=... node scripts/label_signals.mjs --ledger signal_ledger.jsonl \
 *       [--closed closed.json] [--out labelled.jsonl] [--cache m1.json]
 *
 * closed.json = GET /v3/accounts/{id}/trades?state=CLOSED&instrument=XAU_USD&count=500
 * Label (LEARNING_ENHANCEMENT.md §3): win = 1 if R after costs > 0, else 0.
 */
import fs from 'fs';
import { fileURLToPath } from 'url';

export const CAP_HOURS = 120;
const M1_MS = 60_000;

/**
 * Walk bars from `start` and resolve a bracket. Pure.
 * @param {Array} bars - [{t, bo,bh,bl,bc, ao,ah,al,ac}] ascending, t = bar open ms
 * @returns {{r:number, exitReason:string, entry:number, exit:number, exitTime:number}|null} null = still open
 */
export function simulateBracket(bars, start, direction, stopDistance, rr, capMs = CAP_HOURS * 3600_000) {
  if (start >= bars.length) return null;
  const long = direction === 'LONG';
  const entry = long ? bars[start].ao : bars[start].bo;
  const stop = long ? entry - stopDistance : entry + stopDistance;
  const target = long ? entry + stopDistance * rr : entry - stopDistance * rr;
  const r = (exit) => (long ? exit - entry : entry - exit) / stopDistance;
  const t0 = bars[start].t;

  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    // Exit side: a long is closed by selling (bid), a short by buying (ask).
    const o = long ? b.bo : b.ao, h = long ? b.bh : b.ah, l = long ? b.bl : b.al, c = long ? b.bc : b.ac;
    if (i > start) {
      if (long ? o <= stop : o >= stop) return { r: r(o), exitReason: 'stop_gap', entry, exit: o, exitTime: b.t };
      if (long ? o >= target : o <= target) return { r: r(o), exitReason: 'target_gap', entry, exit: o, exitTime: b.t };
    }
    if (long ? l <= stop : h >= stop) return { r: r(stop), exitReason: 'stop', entry, exit: stop, exitTime: b.t };
    if (long ? h >= target : l <= target) return { r: r(target), exitReason: 'target', entry, exit: target, exitTime: b.t };
    if (b.t - t0 >= capMs) return { r: r(c), exitReason: 'time_cap', entry, exit: c, exitTime: b.t };
  }
  return null;
}

/** Index of the first bar opening at or after `ms` (binary search). */
export function firstBarAtOrAfter(bars, ms) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].t < ms) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** Score one taken row from the broker's own record. R uses the ledger's stopDistance as 1R. */
export function brokerOutcome(row, trade) {
  const entry = Number(trade.price), exit = Number(trade.averageClosePrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || !row.stopDistance) return null;
  const long = row.direction === 'LONG';
  const r = (long ? exit - entry : entry - exit) / row.stopDistance;
  const exitReason = trade.takeProfitOrder?.state === 'FILLED' ? 'target'
    : trade.stopLossOrder?.state === 'FILLED' ? 'stop' : 'market';
  return { r, exitReason, entry, exit, exitTime: Date.parse(trade.closeTime) };
}

export const FEATURES = ['price', 'emaFast', 'emaMedium', 'emaSlow', 'atr', 'adx', 'prevAdx', 'rsi', 'pullbackPct',
  'emaSpreadATR', 'distSlowATR', 'legATR', 'legSize', 'legInDirection', 'candleRangeATR', 'candleBodyATR',
  'candleCloseLoc', 'htfTrend', 'stopDistance', 'tpRR', 'hourUK', 'weekdayUK'];

/** Label every row. Pure apart from its inputs. */
export function labelLedger(rows, bars, closedById = new Map()) {
  return rows.map((row) => {
    let out = null, source = null;
    if (row.taken && row.tradeId && closedById.has(String(row.tradeId))) {
      out = brokerOutcome(row, closedById.get(String(row.tradeId)));
      source = out ? 'broker' : null;
    }
    if (!out && row.stopDistance) {
      const start = firstBarAtOrAfter(bars, Date.parse(row.loggedAt));
      out = simulateBracket(bars, start, row.direction, row.stopDistance, row.tpRR || 2);
      source = out ? 'simulated' : null;
    }
    if (!out) return { ...row, label: null, labelStatus: 'pending' };
    return {
      ...row,
      labelStatus: 'labelled',
      labelSource: source,
      outcomeR: parseFloat(out.r.toFixed(3)),
      exitReason: out.exitReason,
      simEntry: out.entry,
      simExit: out.exit,
      exitTime: new Date(out.exitTime).toISOString(),
      label: out.r > 0 ? 1 : 0,
    };
  });
}

/** Descriptive report only — this is NOT the walk-forward test in LEARNING_ENHANCEMENT.md §4. */
export function summarise(labelled) {
  const lines = [];
  const byReason = new Map();
  for (const r of labelled) {
    const k = r.skipReason || 'TAKEN';
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k).push(r);
  }
  lines.push(`rows ${labelled.length}, labelled ${labelled.filter(r => r.labelStatus === 'labelled').length}, pending ${labelled.filter(r => r.labelStatus === 'pending').length}`);
  lines.push('skipReason              n  labelled  win%   meanR');
  for (const [k, rs] of [...byReason].sort((a, b) => b[1].length - a[1].length)) {
    const l = rs.filter(r => r.labelStatus === 'labelled');
    const win = l.length ? (100 * l.filter(r => r.label === 1).length / l.length).toFixed(0) : '-';
    const mean = l.length ? (l.reduce((s, r) => s + r.outcomeR, 0) / l.length).toFixed(3) : '-';
    lines.push(`${k.padEnd(22)} ${String(rs.length).padStart(3)} ${String(l.length).padStart(9)} ${String(win).padStart(5)} ${String(mean).padStart(7)}`);
  }
  const missing = FEATURES.map(f => [f, labelled.filter(r => r[f] === null || r[f] === undefined).length]).filter(([, n]) => n > 0);
  lines.push(missing.length ? `MISSING FEATURES: ${missing.map(([f, n]) => `${f}=${n}`).join(', ')}` : 'missing features: none');
  return lines.join('\n');
}

async function fetchM1(from, key) {
  const bars = [];
  let cursor = new Date(from).toISOString();
  for (;;) {
    const url = `https://api-fxpractice.oanda.com/v3/instruments/XAU_USD/candles?granularity=M1&price=BA&count=5000&from=${encodeURIComponent(cursor)}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${key}` } });
    const j = await res.json();
    if (!j.candles) throw new Error(`Oanda candles: ${JSON.stringify(j)}`);
    const done = j.candles.filter(c => c.complete).map(c => ({
      t: Date.parse(c.time),
      bo: +c.bid.o, bh: +c.bid.h, bl: +c.bid.l, bc: +c.bid.c,
      ao: +c.ask.o, ah: +c.ask.h, al: +c.ask.l, ac: +c.ask.c,
    }));
    for (const b of done) if (!bars.length || b.t > bars[bars.length - 1].t) bars.push(b);
    if (j.candles.length < 5000 || !done.length) break;
    cursor = new Date(bars[bars.length - 1].t + M1_MS).toISOString();
  }
  return bars;
}

async function main() {
  const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
  const ledgerPath = arg('--ledger');
  if (!ledgerPath) { console.error('usage: --ledger signal_ledger.jsonl [--closed closed.json] [--out f] [--cache f]'); process.exit(2); }
  const rows = fs.readFileSync(ledgerPath, 'utf8').trim().split('\n').filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l)]; } catch { return []; }
  });
  if (!rows.length) { console.log('ledger is empty'); return; }

  const closed = arg('--closed') ? JSON.parse(fs.readFileSync(arg('--closed'), 'utf8')) : { trades: [] };
  const closedById = new Map((closed.trades || []).map(t => [String(t.id), t]));

  const cache = arg('--cache');
  let bars;
  if (cache && fs.existsSync(cache)) {
    bars = JSON.parse(fs.readFileSync(cache, 'utf8'));
  } else {
    if (!process.env.OANDA_API_KEY) { console.error('OANDA_API_KEY not set'); process.exit(2); }
    const from = Math.min(...rows.map(r => Date.parse(r.loggedAt))) - M1_MS;
    bars = await fetchM1(from, process.env.OANDA_API_KEY);
    if (cache) fs.writeFileSync(cache, JSON.stringify(bars));
  }

  const labelled = labelLedger(rows, bars, closedById);
  if (arg('--out')) fs.writeFileSync(arg('--out'), labelled.map(r => JSON.stringify(r)).join('\n') + '\n');
  console.log(summarise(labelled));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
