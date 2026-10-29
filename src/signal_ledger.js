/**
 * Signal ledger — Phase 0 of the Learning Enhancement Module (LEARNING_ENHANCEMENT.md).
 *
 * One JSON line per trend-aligned H1 candle the live strategy evaluated, whether it traded
 * or not: the features known at signal time, taken (0/1), and why it was skipped. Outcomes
 * are NOT computed here — scripts/label_signals.mjs labels them offline, after the fact, so
 * nothing in this file can ever see the future or influence an order.
 *
 * Observational only. Every method swallows its own errors: a ledger fault must never stop
 * a scan or an entry.
 */
import fs from 'fs';

export const LEDGER_SCHEMA = 1;

/** Dedup key: the scan re-evaluates the same completed candle every 15 min. */
export const ledgerKey = (candidate) => `${candidate.candleTime}|${candidate.direction}`;

/**
 * Build the row written to disk. Pure, so tests can pin the format.
 * @param {Object} candidate - features from EmaTrendStrategy.evaluateSetup (setup.candidate)
 * @param {Object} result - { skipReason: string|null, tradeId?, fillPrice?, detail? }
 * @param {Object} context - { loggedAt: Date, regime, hourUK, weekdayUK }
 */
export function buildLedgerRow(candidate, result, context) {
  return {
    schema: LEDGER_SCHEMA,
    loggedAt: context.loggedAt.toISOString(),
    regime: context.regime ?? null,
    hourUK: context.hourUK ?? null,
    weekdayUK: context.weekdayUK ?? null,
    ...candidate,
    taken: result.skipReason ? 0 : 1,
    skipReason: result.skipReason || null,
    skipDetail: result.detail || null,
    tradeId: result.tradeId || null,
    fillPrice: result.fillPrice ?? null,
  };
}

export default class SignalLedger {
  constructor(file, logger) {
    this.file = file;
    this.logger = logger;
    this.seen = new Set();
    this._loadSeenKeys();
  }

  /** Re-seed the dedup set from the tail of the file so a restart doesn't re-log the current candle. */
  _loadSeenKeys() {
    try {
      if (!fs.existsSync(this.file)) return;
      const lines = fs.readFileSync(this.file, 'utf8').trim().split('\n').slice(-200);
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if (row.candleTime && row.direction) this.seen.add(ledgerKey(row));
        } catch { /* a torn last line from a crash; ignore it */ }
      }
    } catch (error) {
      this.logger.warn(`Signal ledger: could not read ${this.file}: ${error.message}`);
    }
  }

  /**
   * Append one row per candidate candle. Later calls for the same candle are ignored, except
   * that a fill always gets written (it is the one outcome we can't afford to drop).
   * @returns {boolean} whether a row was written
   */
  record(candidate, result, context) {
    try {
      if (!candidate) return false;
      const key = ledgerKey(candidate);
      if (this.seen.has(key) && result.skipReason) return false;
      fs.appendFileSync(this.file, JSON.stringify(buildLedgerRow(candidate, result, context)) + '\n');
      this.seen.add(key);
      if (this.seen.size > 1000) this.seen = new Set([...this.seen].slice(-500));
      return true;
    } catch (error) {
      this.logger.warn(`Signal ledger write failed (trading unaffected): ${error.message}`);
      return false;
    }
  }
}
