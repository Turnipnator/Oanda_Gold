/**
 * Stale-data guard: is the market data current enough to send an order on?
 *
 * Pure, so it can be tested without a broker. The caller fetches the live price
 * and the last few candles; this decides. Price and candles come from different
 * Oanda endpoints, so either can freeze while the other keeps answering.
 */

const GRANULARITY_MS = {
  M1: 60e3, M5: 300e3, M15: 900e3, M30: 1800e3,
  H1: 3600e3, H2: 7200e3, H4: 14400e3, D: 86400e3,
};

export function granularityMs(granularity) {
  return GRANULARITY_MS[granularity] ?? NaN;
}

/**
 * @param {object} p
 * @param {{time: string, tradeable?: boolean}} p.price  Oanda pricing row (time is RFC3339)
 * @param {{time: Date, complete: boolean}[]} p.candles   oldest first
 * @param {string} p.granularity  e.g. 'H1'
 * @param {number} p.maxPriceAgeSec
 * @param {number} p.maxCandleAgeMin  age of the newest COMPLETED candle's close
 * @param {number} [p.now]
 * @returns {{ok: true, priceAge: number, candleAge: number} | {ok: false, reason: string}}
 */
export function assessFreshness({ price, candles, granularity, maxPriceAgeSec, maxCandleAgeMin, now = Date.now() }) {
  if (price?.tradeable === false) {
    return { ok: false, reason: 'Oanda reports the instrument not tradeable (closed or halted)' };
  }
  const priceAge = (now - Date.parse(price?.time)) / 1000;
  if (!(priceAge <= maxPriceAgeSec)) {
    return {
      ok: false,
      reason: `last price is ${Number.isFinite(priceAge) ? Math.round(priceAge) + 's' : '(no timestamp)'} old ` +
        `(limit ${maxPriceAgeSec}s)`,
    };
  }

  const last = (candles || []).filter(c => c.complete).at(-1);
  const candleEnd = last ? last.time.getTime() + granularityMs(granularity) : NaN;
  const candleAge = (now - candleEnd) / 60000;
  if (!(candleAge <= maxCandleAgeMin)) {
    return {
      ok: false,
      reason: `last completed ${granularity} candle closed ` +
        `${Number.isFinite(candleAge) ? Math.round(candleAge) + 'm' : '(none)'} ago (limit ${maxCandleAgeMin}m)`,
    };
  }
  return { ok: true, priceAge, candleAge };
}
