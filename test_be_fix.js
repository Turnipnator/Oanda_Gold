#!/usr/bin/env node
/**
 * Deterministic proof of the breakeven-trail bug fix.
 *
 * Scenario (SHORT, entry $100, $8 stop, 2R TP at $84, BE trigger at $4.80 profit):
 *   bar 1: price dips to $97.50 (+$2.50) → pre-BE $0.75 trail locks SL at $98.25 (+$1.75)
 *   bar 2: price dips to $95.00 (+$5.00) → crosses the $4.80 breakeven trigger
 *   bar 3: price rallies back through $100 → trade exits
 *
 * BUGGY  : breakeven resets SL up to entry ($100), wiping the locked $1.75; then the
 *          ~$25 ATR trail can't re-engage. Bar 3 stops at entry → SCRATCH $0.
 * FIXED  : breakeven is monotonic — entry ($100) is not tighter than the locked $98.25,
 *          so the stop is left alone. Bar 3 stops at $98.25 → +$1.75 preserved.
 */

const ENTRY = 100, SL_DIST = 8, TP_DIST = 16;
const BE_TRIGGER = 0.30 * TP_DIST;   // $4.80
const PRE_TRAIL = 0.75;
const ACTIVATION = 2.0;
const ATR = 17;                      // typical H1 gold ATR
const RAW_ATR_TRAIL = ATR * 1.5;     // ~$25 (buggy)
const CAPPED_TRAIL = Math.max(2, Math.min(8, RAW_ATR_TRAIL)); // $8 (fixed)

// SHORT trade. bars = [{h, l}] in chronological order.
const bars = [
  { h: 100.0, l: 97.5 },  // +$2.50 → pre-BE trail engages
  { h: 98.0,  l: 95.0 },  // +$5.00 → crosses breakeven trigger
  { h: 100.5, l: 99.0 },  // rallies back → exit
];

function run(fixed) {
  const atrTrail = fixed ? CAPPED_TRAIL : RAW_ATR_TRAIL;
  let sl = ENTRY + SL_DIST;       // short stop above entry
  let beTriggered = false;
  const log = [];

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    // stop check (short: adverse = high)
    if (b.h >= sl) {
      const pnl = ENTRY - sl;
      log.push(`  bar${i + 1}: STOP hit at $${sl.toFixed(2)} → P&L ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);
      return { pnl, log };
    }
    const fav = b.l;                       // short: favourable = low
    const bestProfit = ENTRY - fav;

    // breakeven
    if (!beTriggered && bestProfit >= BE_TRIGGER) {
      beTriggered = true;
      if (fixed) {
        const beImproves = ENTRY < sl;     // only tighten
        if (beImproves) { sl = ENTRY; log.push(`  bar${i + 1}: BE → SL tightened to entry $${ENTRY}`); }
        else log.push(`  bar${i + 1}: BE reached — SL left at $${sl.toFixed(2)} (entry not tighter; locked profit kept)`);
      } else {
        sl = ENTRY;                        // buggy: unconditional reset
        log.push(`  bar${i + 1}: BE → SL RESET to entry $${ENTRY} (locked profit wiped)`);
      }
    }
    // trail
    const shouldTrail = beTriggered || bestProfit >= ACTIVATION;
    if (shouldTrail) {
      const dist = beTriggered ? atrTrail : PRE_TRAIL;
      const newSL = fav + dist;            // short
      if (newSL < sl) { sl = newSL; log.push(`  bar${i + 1}: trail SL → $${sl.toFixed(2)} (${dist === PRE_TRAIL ? 'pre-BE $0.75' : 'post-BE $' + dist} behind $${fav})`); }
    }
  }
  return { pnl: ENTRY - sl, log };
}

for (const fixed of [false, true]) {
  console.log(`\n${fixed ? 'FIXED ' : 'BUGGY '} (post-BE trail $${(fixed ? CAPPED_TRAIL : RAW_ATR_TRAIL).toFixed(2)}):`);
  const r = run(fixed);
  r.log.forEach(l => console.log(l));
  console.log(`  RESULT: ${r.pnl >= 0 ? '+' : ''}$${r.pnl.toFixed(2)} per unit  ${r.pnl === 0 ? '← SCRATCH (bug)' : '← profit preserved'}`);
}
