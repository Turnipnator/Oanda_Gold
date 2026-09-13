/**
 * formatConfidence() — the one helper every "Confidence:" log line and Telegram message goes
 * through. The strategies disagree on scale (EMA Trend 0-1, Breakout + ADX 0-100); this pins
 * down that both print as a whole-number percentage and that junk prints as "n/a".
 *
 *   npm run test:format
 */
import assert from 'assert';
import { formatConfidence } from '../src/format.js';

const cases = [
  [0.95, '95%', 'EMA Trend fraction'],
  [0.9500000000000001, '95%', 'float noise in a fraction'],
  [0.8, '80%', 'fraction'],
  [1, '100%', 'exactly 1 is a fraction'],
  [80, '80%', 'Breakout + ADX whole percent'],
  [100, '100%', 'whole percent at the top'],
  [0, '0%', 'zero'],
  [NaN, 'n/a', 'NaN'],
  [Infinity, 'n/a', 'Infinity'],
  [undefined, 'n/a', 'undefined'],
  ['0.9', 'n/a', 'string is not a number'],
];

let passed = 0;
for (const [input, expected, label] of cases) {
  const got = formatConfidence(input);
  assert.strictEqual(got, expected, `${label}: formatConfidence(${String(input)}) = ${got}, expected ${expected}`);
  passed++;
}
console.log(`format.test: ${passed}/${cases.length} assertions passed`);
