# Research Notes — "Best EMA Trend strategy" search (started Jul 1 2026)

## Question
Find the best achievable version of the gold bot's strategy: minimise losses, maximise winners.
Prompted by EMA Trend going net-negative (−£1,765 / 33 trades, PF 0.71) after 3 big stops incl. a −£1,817 on Jul 1.

## Sub-questions (decompose)
- Q1. Does the EMA Trend *entry* have a real edge over a LONG history (not just 33 live trades)?
- Q2. Which entry params maximise expectancy out-of-sample? (ADX_MIN, RSI band, PULLBACK_PCT, HTF, direction, leg filter)
- Q3. Best stop method (ATR mult / caps) to minimise loss size without killing edge?
- Q4. Best exit (fixed TP vs trail vs partial vs time-stop) given the entries?
- Q5. Does a REGIME filter (volatility / trend-strength / session) separate winners from losers?
- Q6. Is a fundamentally different entry (breakout, MA, mean-revert) better on Oanda H1?

## Competing hypotheses
- H_A: Entries have genuine edge; recent losses = variance + C/sizing misconfig. Fix stops+sizing → profitable. 
- H_B: Entries are ~break-even/negative on Oanda H1 (IG numbers never transferred); no tuning saves it → need different entry.
- H_C: Edge is regime-dependent (works in strong trend, bleeds in chop); a regime gate is the missing piece.

## Method
- Faithful backtest: import REAL `EmaTrendStrategy` + `TechnicalAnalysis` (same `technicalindicators` lib) → identical entry logic.
- H1-close entries (one of two live paths; realtime-30s + MTF-M15 pullback NOT modelled → LIMITATION, flag it).
- Management replicated from index.js: SL=clamp(ATR×1.5,min,max); TP=2×SL; BE at 30% of TP (monotonic); pre-BE $1.50 trail armed at $2; post-BE ATR×1.5 trail clamped to SL bounds. Simulated on M5 candles.
- 24 months H1/H4/M5 cached from Oanda (varied regimes: 2024 chop, 2025 rally, 2026).
- Report expectancy(R), PF, WR, maxDD in R (sizing-neutral). Then £ with honest sizing.
- Guard overfitting: walk-forward train/test split; label confidence HIGH/MED/LOW.

## Baseline live params (VPS, Jul 1 2026)
FAST/MED/SLOW 3/8/21, ATR_PERIOD 14, ATR_SL_MULT 1.5, MIN_SL $2, MAX_SL $40 (C), TP_RR 2.0,
ADX_MIN 25 +rising, PULLBACK 0.3%, RSI long 15-60 / short 35-85, HTF H4, leg filter 2.0× enforced,
BE 30% of TP, pre-BE trail $1.50 @ $2 activation, ALLOW_SHORT true, MTF on (not modelled).

## Findings

### Engine build (Jul 1)
- Faithful engine drives real EmaTrendStrategy + indicators; management replicated on M5. 24mo (2024-08→2026-07).
- Two harness bugs found & fixed (both would have misled): (1) HTF used in-progress H4 candle = lookahead; (2) H1 entry timing replayed the entry candle's own bars. (3) zsh does NOT word-split `$VAR` → all `env $BASE_ENV node` runs silently used config.js DEFAULTS. Now driven by Node runner with explicit env. CONFIDENCE these are fixed: HIGH (baseline now reproduces short-heavy behaviour; funnel sane).
- LIMITATION: H1-close entries only (live also has realtime-30s + MTF-M15 pullback paths → live gets better fills & more trades). Flat $0.30 spread cost. So ABSOLUTE R is conservative/approximate; use for RELATIVE comparison. CONFIDENCE MED on absolute, HIGH on relative ranking.

### 24-month baseline (live config: both dirs, 24h, $40 cap)
- **NET NEGATIVE: expR −0.032, PF 0.80, 199 trades, WR 79%, maxDD 11.5R.** [HIGH]
- Damage is ENTIRELY the short side: 152 shorts @ expShort −0.047; 47 longs @ +0.017. [HIGH]
  → Overturns the live-2026 impression that shorts are the good side. 2026 was a clean downtrend; across a full cycle shorts bleed. H_C (regime-dependent) supported.

### Single-lever sweeps [MED — one-at-a-time, pre walk-forward]
- SESSION: **07-21 UTC → expR +0.022, PF 1.18, DD 4.8** (best single lever). Asian 00-08 → PF 0.55. Mechanistic (liquidity) + matches old breakout-era lesson. [HIGH rationale]
- DIRECTION: long-only +0.017 PF 1.15; RSI_SELL_MIN 45 (stricter shorts) +0.025 PF 1.18 (shorts flip +0.042).
- STOP: MAX_SL $20 (−0.012, PF 0.93) and ATR_SL_MULT 1.0 (−0.009, PF 0.96) both BEAT the $40 (C) cap (−0.032). $8 cap = worst (WR 67%, DD 19.8 — whipsaws confirmed). Sweet spot ~$20.
- EXIT: hard-TP-no-trail = disaster (WR 30%, −0.123). BE+trail essential. Loosening pre-BE trail to $4 helps modestly (−0.011). BE_TRIGGER/TP_RR ~no effect. → confirms exit is near-optimal; small gains only.
- ADX_MIN 20 slightly better than 25/30; PULLBACK/leg filter minor.

### Walk-forward (TRAIN 2024-08..2025-10 bull / TEST 2025-11..2026-07 incl 2026 downtrend)
Robust = positive in BOTH windows (not just full). Distrust big TEST numbers on tiny n.
- baseline: TRAIN −0.080 / TEST +0.038 → NOT robust (its +full was a mirage; negative in the 15mo train).
- session-only: TRAIN −0.015 → not enough alone.
- **BALANCED sess+RSI45+$20+ADX20: FULL +0.117 PF2.23 n76 / TRAIN +0.088 PF1.99 / TEST +0.159 PF2.40. DD 2R. Robust ✓** Keeps shorts (TEST expShort +0.185 — quality shorts work in the downtrend). ~3.3 trades/mo. ~£3,987/24mo @£450/R.
- LONGBIAS sess+long+$20+ADX20: FULL +0.135 PF3.29 n53 / TRAIN +0.124 / TEST +0.146. DD 1.1R. Robust ✓ but 0 shorts → starves in downtrends, ignores the short edge the live bot actually captured.

## CONCLUSION
**Most-supported (H_C confirmed): the edge is real but REGIME-GATED. Three robust levers flip PF 0.80 → 2.2:**
1. SESSION filter (skip Asian 00-08 UK) — biggest, most defensible lever (liquidity; matches old breakout-era lesson). `TRADING_START_HOUR=8, TRADING_END_HOUR=22`.
2. Tighten stop cap $40→$20 (`EMA_TREND_MAX_SL=2000`) — beats both $8 (whipsaw, WR 67%) and $40 (tail). Partially reverts "C".
3. Quality shorts: `EMA_TREND_RSI_SELL_MIN=45` (not 35) — keeps shorts but skips exhausted-oversold ones (the exact profile of the big losers). REVERSES the Jun 8 40→35 change (that optimised frequency, not quality).
   + `EMA_TREND_ADX_MIN=20` (25→20) for more trades. Keep ALLOW_SHORT=true (balanced beats long-only in £ & adaptivity).

**Ruled out:** exit tuning (hard-TP-no-trail = 30% WR disaster; BE/trail near-optimal — matches [[payoff-asymmetry-structural]]); pullback%/leg-threshold (minor); long-only (robust but starves in downtrend). The $40 "C" cap is net worse than $20 over a full cycle.

**Open questions / confidence:** TEST n=27 (balanced) — MED sample. Engine models H1-close only (no MTF/realtime fills) → absolute £ approximate, relative ranking HIGH. 4 knobs stacked, but each individually supported AND combo holds out-of-sample. Session filter alone is the safe minimum if we want just one change.

**Next actions:** (1) deploy BALANCED as .env change (paper) — user green-light; (2) after ~15-20 trades, validate live vs backtest; (3) revisit honest sizing before real money (unchanged concern).
