/**
 * Shared log/message formatting helpers.
 */

/**
 * Format a strategy confidence value for display.
 *
 * The strategies disagree on scale: EMA Trend clamps to a 0-1 fraction while
 * Breakout + ADX returns whole percents (80). Printing either one raw next to a
 * literal '%' is wrong for one of them - an EMA Trend signal logged as "0.8%"
 * when it meant 80%. Values at or below 1 are treated as fractions; anything
 * larger is already a percentage.
 *
 * @param {number} value  0-1 fraction or 0-100 percentage
 * @returns {string}      e.g. "95%", or "n/a" for a non-finite input
 */
export function formatConfidence(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const pct = value <= 1 ? value * 100 : value;
  return `${pct.toFixed(0)}%`;
}
