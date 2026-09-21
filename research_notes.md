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

---

## PART 2 — Cross-strategy comparison (Jul 1 2026): EMA Trend vs Triple Confirmation vs Breakout+ADX
Same 24mo, faithful multi-strategy engine (`backtest_engine2.js` drives each REAL strategy class). Native exit = each strategy's own; Common exit = EMA-Trend ATR mgmt (isolates ENTRY edge). Walk-forward train/test.

### The unifying insight [HIGH]
- **COMMON-exit (tight ATR mgmt on all three) is negative-to-breakeven for EVERY strategy:** EMA −0.032, Triple −0.005, Breakout −0.009. → No strategy's ENTRIES have a standalone edge under tight management. The edge lives in the EXIT + regime, not the entry signal.
- Trailing-only ("let winners run") rescues BREAKOUT entries (momentum → sustained moves) but NOT EMA pullback entries (fade → reverse; tested separately). Exit must match entry character.

### Native-exit head-to-head (+ session filter where it helps)
| Contender | expR | PF | maxDD | WR | trades/mo | robust | profile |
|---|---|---|---|---|---|---|---|
| **EMA BALANCED (deployed)** | +0.117 | **2.23** | **2R** | 87% | 3.3 | ✓ | high-WR grind, tiny DD |
| Triple native + session | +0.035 | 1.06 | 18.7R | 43% | 5.6 | ✗ (train −) | breakeven, deep DD |
| Breakout native + session | +0.114 | 1.18 | 20.3R | 43% | 6.2 | ✓ | trend-ride (session HURTS it) |
| Breakout native (24h) | +0.133 | 1.21 | 12R | 43% | 9.8 | ✓ | best raw return, deep DD |

### Verdict [confidence noted]
- **Triple Confirmation: RULE OUT.** Breakeven at best (native full +0.035 PF1.06; common −0.005), not robust (train negative), 18R DD. No reason to switch. [HIGH]
- **EMA BALANCED: best RISK-ADJUSTED (expR/DD = 0.058 vs breakout 0.011 — ~5× better).** Tiny 2R DD, 87% WR, robust. Stays the primary. [HIGH]
- **Breakout native (trailing-only): highest RAW return (~£13.5k vs £4k) & robust, BUT** (a) 12-20R drawdowns, 43% WR (long losing streaks); (b) FIDELITY CAVEAT [LOW-MED trust]: this is the RAW candle-close version (ENABLE_MTF=false, no realtime/momentum/fakeout filters) — i.e. it OMITS exactly the realtime whipsaws that made the LIVE breakout strategy fail (33% live WR → abandoned for EMA Trend). The backtest likely FLATTERS it. Do NOT switch on this number alone.
- Session filter is EMA-Trend-specific (liquidity-sensitive pullbacks); it HURTS breakout (which rides Asian-session momentum too).

### CONCLUSION (Part 2)
Keep EMA BALANCED as primary (best risk-adjusted, deployed). Triple ruled out. Breakout-trailing is an intriguing higher-return/higher-DD trend sleeve worth a *separate* faithful study (with the live realtime/MTF machinery, not the raw version) IF more return is wanted and the drawdown is acceptable — not a drop-in switch. Biggest scientific takeaway: entry choice barely matters under tight mgmt; EXIT+regime is the edge.

---

## PART 3 — Breakout-trailing sleeve deep study (Jul 1 2026). Scripts: `backtest_engine2.js` + bk_study/dump2/stress (scratchpad).

### Robustness [HIGH] — the edge is NOT curve-fit
Native trailing-only, swept walk-forward: ROBUST✓ (positive train AND test) across lookback 5/10/15/20/25, trail $1–2.5, activation $2–7. Tighter = better in-sample (lookback 5 +0.25R; stop $2 +0.30R) BUT tight stops are exactly where realtime whipsaws bite → discount them. The LIVE $5.50 stop backtests NEGATIVE.

### Diversification [HIGH] — genuine, but doesn't improve efficiency
Monthly-return correlation with EMA BALANCED = **−0.02** (uncorrelated; worst months don't coincide). Combined portfolio (R-units, 1.0 = EMA per-trade risk):
| portfolio | totalR | maxDD | ret/DD |
|---|---|---|---|
| EMA only | 8.9 | 2.0 | **4.34** |
| EMA + 0.25× BK | 16.4 | 4.2 | 3.86 |
| EMA + 0.5× BK | 23.9 | 6.9 | 3.45 |
| EMA + 1.0× BK | 38.9 | 13.0 | 3.00 |
| BK only | 30.1 | 12.1 | 2.49 |
A sleeve ~doubles return but ~doubles DD; risk-adjusted quality falls (BK's standalone 2.49 drags the blend). Diversification shaves ~1R off DD vs naive-sum, not enough to win on efficiency.

### FATAL FLAW [HIGH] — the edge lives entirely inside transaction costs
Entry-cost stress (breakout is 226 trades w/ tiny per-trade edge):
| cost/trade | FULL expR | verdict |
|---|---|---|
| $0.30 (idealized) | +0.133 | robust |
| **$0.75** | **−0.017** | edge GONE |
| $1.00 | −0.100 | negative |
| $1.50 | −0.267 | deeply negative |
Live breakout ran ~$1.30–1.50 spread + realtime-entry slippage → squarely negative. **This is exactly why live breakout failed (33% WR) and was abandoned.** Contrast — EMA BALANCED cost sensitivity: $0.75→+0.083, $1.00→+0.064, breaks even only ~$2.00. EMA is ~3× more cost-robust (76 trades, bigger stops, higher per-trade edge).

### CONCLUSION (Part 3) — DO NOT run the breakout sleeve
The backtest edge is an artifact of idealized costs. It is robust across *parameters* but NOT across the one variable that actually sank it live — cost/fills. Beautiful diversification profile (−0.02 corr), but the edge isn't real net of realistic transaction costs. This retroactively validates abandoning breakout and choosing EMA Trend. **Final: EMA BALANCED stays the sole strategy.** Return-boosting should come from honest sizing / letting the proven edge compound, not from adding a cost-fragile sleeve.

---

## PART 4 — Silver (XAG_USD) instrument-expansion replay (Aug 12 2026). Scripts: `backtest_engine.js` + fetch2/calib/run_silver/wf/boot (scratchpad).

### Question
[[frequency-by-design-silver-next]] approved ONE lever for growing the validation sample: run the *same* EMA Trend strategy on XAG_USD, paper, own `CONFIG_REGIME` — gated on a 24-month replay first. Does silver carry the same entry edge as gold under the live `bracket-jul10` exit regime?

### Sub-questions
1. Do gold's ATR-derived stop caps ($2–$20) transfer to silver? (Prior: no.)
2. Is silver's proportionally wider spread fatal?
3. Does the session filter (the single biggest gold lever) work on silver?
4. Would silver actually accelerate sample accumulation?

### Competing hypotheses
- **H1** Edge is in the *strategy* (EMA pullback structure) → should transfer to any trending instrument.
- **H2** Edge is in the *instrument* (gold's specific session/trend microstructure) → will NOT transfer.
- **H3** Edge transfers but is eaten by silver's wider relative spread → recoverable by re-tuning stops.

### Method
Real `EmaTrendStrategy.evaluateSetup` + real `TechnicalAnalysis` (identical gating to live), `BT_EXIT=tp_only` (= bracket regime: stop + resting 2R TP, no BE, no trail). 24mo H1 entries / M5 management, pessimistic tie-breaking. Gold run over the *identical* window as a control.
**Stop-cap calibration:** gold's $20 max cap binds on 43.4% of bars; silver caps set to bind at the same rate → `MIN_SL=13` ($0.13), `MAX_SL=39` ($0.39). Spreads measured live: XAG $0.0320, XAU $0.4100.

### Evidence

Instrument character [HIGH]:
| | median ATR/price | live spread | spread as % | spread ÷ typical stop |
|---|---|---|---|---|
| Gold | 0.322% | $0.410 | 0.0093% | ~2.3% |
| Silver | 0.580% (1.8×) | $0.032 | 0.0490% (5.3×) | ~8.2% (~3× worse) |

Head-to-head, bracket exit, 24mo [HIGH]:
| run | n | E[R] | PF | WR% | sumR | ddR |
|---|---|---|---|---|---|---|
| GOLD 24/7 | 110 | +0.143 | 1.23 | 39.1 | +15.7 | 15.1 |
| **GOLD session 7-21** | **72** | **+0.304** | **1.53** | **44.4** | **+21.9** | 7.5 |
| SILV 24/7 | 100 | −0.177 | 0.77 | 31.0 | −17.7 | 23.7 |
| **SILV session 7-21** | **65** | **−0.184** | **0.76** | **30.8** | **−11.9** | 18.4 |
| SILV + 2× spread | 65 | −0.290 | 0.66 | 30.8 | −18.9 | 22.8 |
| SILV + **zero** spread | 65 | −0.077 | 0.89 | 30.8 | −5.0 | 14.0 |
| SILV wide cap $0.80 | 61 | −0.059 | 0.92 | 34.4 | −3.6 | 17.2 |
| SILV tight cap $0.25 | 66 | −0.134 | 0.82 | 33.3 | −8.9 | 15.9 |

Walk-forward [HIGH]:
| inst | FULL | TRAIN (24-08→25-11) | TEST (25-11→26-08) |
|---|---|---|---|
| GOLD | +0.304 / PF 1.53 | +0.207 / PF 1.34 | +0.431 / PF 1.82 |
| SILV | −0.184 / PF 0.76 | **−0.442 / PF 0.49** | **+0.118 / PF 1.18** |

Bootstrap 20k resamples [HIGH]: GOLD E[R] +0.304, 95% CI **[−0.030, +0.636]**; SILV E[R] −0.184, 95% CI **[−0.504, +0.229]**. Both straddle zero; silver's mass sits negative.

### Findings
1. **H2 is supported; H1 and H3 are rejected.** [HIGH] Silver is negative in every configuration tested. At **zero spread** it is still −0.077R / PF 0.89 — so this is *not* a transaction-cost problem, and re-tuning stops does not rescue it (best variant, wide cap, is still −0.059R).
2. **Silver's TP-hit rate is 30.8%, below the ~33.3% a 2R bracket needs to break even.** [HIGH] Gold clears it at 44.4%. That single number is the whole story: 45 stops / 20 TPs vs gold's 40/32.
3. **The session filter does nothing for silver** [HIGH] — gold +0.143→+0.304 (PF 1.23→1.53), silver −0.177→−0.184. The mechanism that makes gold work is absent, which is direct evidence the edge is instrument-specific, not strategy-generic.
4. **Silver's sign flips between train and test** (−0.44 → +0.12) while gold is positive in both halves. [HIGH] By the repo's own walk-forward criterion (Part 1: trustworthy only if positive in BOTH), silver fails and gold passes.
5. **It would not even solve the frequency problem.** [HIGH] Silver yields 65 in-session trades/24mo = **2.7/month**, essentially identical to gold's 3.0/month. The premise of the silver plan — meaningfully faster sample growth — is false regardless of edge.
6. Harness validated [HIGH]: the gold control reproduces the prior 24mo study exactly (n=72, PF ~1.5).

### Self-critique
- *What would disprove this?* A silver-native parameter set (different EMAs/RSI/pullback) might have edge — but that is a **new strategy search on a new instrument**, not the approved "same strategy, second instrument" lever, and would be textbook data-snooping to fit now.
- *Simpler explanation?* Silver ran $26.60→$119.34 with violent regime shifts; a pullback-continuation strategy is structurally poor in whipsaw. That IS the explanation, and it is not fixable with stop tuning.
- *Snooping check:* silver params were calibrated by a mechanical cap-binding match to gold, chosen BEFORE seeing results; the sensitivity runs bracket that choice on both sides.
- Gap [MED]: mid-price candles, no per-bar spread widening; silver spreads widen more than gold's in stress, so the true silver result is likely *worse*, not better.

### CONCLUSION (Part 4) — DO NOT run the silver sleeve
The edge is in **gold**, not in the EMA Trend rule set. Silver fails on entry quality (30.8% TP rate vs 33.3% breakeven), fails walk-forward stability, is unhelped by the session filter, and would not accelerate sample growth anyway. The one approved lever for widening the validation sample is now closed by evidence. **Sample must be earned in time on gold: ~3 trades/month, 17 more to reach 20 bracket-era trades.**

### Next steps
- Close the silver expansion item. No code changes needed (`TRADING_SYMBOL` plumbing stays unused).
- Remaining open question, unchanged: the RSI-60 cap under bracket exit (prior verdict is trail-era and possibly stale) — study at ~10 bracket trades, deploy decision at 20.

---

## PART 5 — RSI_BUY_MAX cap re-test under the bracket regime (Aug 12 2026). Scripts: `backtest_engine.js` + rsi_sweep/rsi_wf/rsi_incr/rsi_cost (scratchpad).

### Question
`EMA_TREND_RSI_BUY_MAX=60` was established as the risk-adjusted optimum — but that test predates the Jul 10 2026 bracket-exit switch. Under a trail, entering an extended move gives profit back on the retrace; under a resting 2R TP, a vertical move is the *fastest* path to target. **Has the verdict gone stale?**

### Competing hypotheses
- **H1 (stale)** The cap was compensating for the trail; under bracket it costs money and should rise.
- **H2 (durable)** High-RSI entries are genuinely worse regardless of exit; 60 stays optimal.
- **H3 (artifact)** Any gain from raising it is a bull-market artifact — the added longs only work because 2024-25 trended up.

### Evidence

Sweep, 24mo gold, session 7-21, both exit regimes [HIGH]:
| cap | BRACKET E[R] / PF / ddR / n | TRAIL E[R] / PF / ddR / n |
|---|---|---|
| 55 | +0.421 / 1.79 / 5.2 / 29 | +0.060 / 1.38 / 1.5 / 32 |
| **60 (live)** | **+0.304 / 1.53 / 7.5 / 72** | **+0.132 / 2.46 / 2.2 / 81** |
| 65 | +0.301 / 1.53 / 7.4 / 115 | +0.077 / 1.58 / 3.9 / 142 |
| 70 | +0.273 / 1.47 / 8.3 / 145 | +0.034 / 1.24 / 6.4 / 178 |
| 75 | +0.358 / 1.65 / 9.3 / 160 | +0.053 / 1.45 / 5.3 / 203 |
| 80 | **+0.371 / 1.68 / 8.2 / 167** | +0.053 / 1.46 / 5.4 / 210 |
| 85 | +0.363 / 1.66 / 8.2 / 168 | +0.048 / 1.40 / 5.4 / 211 |

**The two regimes disagree, and H1 is confirmed on its narrow claim [HIGH].** Under TRAIL, 60 is a sharp peak and raising to 70 collapses edge (0.132→0.034) and triples DD (2.2→6.4) — exactly reproducing the original finding. Under BRACKET, 60 is *not* a peak, DD is near-flat across the whole range (7.5→8.2), and total return nearly triples (sumR 21.9 → 62.0). **The "half the edge, 2× drawdown" rationale is trail-specific and does not survive the regime change.**

Sanity check [HIGH]: `E[short]` is invariant at +0.473 across every cap in the bracket runs — the lever touches only longs, as intended.

Walk-forward, bracket [HIGH]:
| cap | TRAIN E[R]/PF | TEST E[R]/PF |
|---|---|---|
| 60 | +0.207 / 1.34 | **+0.431 / 1.82** |
| 65 | +0.263 / 1.45 | +0.354 / 1.64 |
| 70 | +0.324 / 1.57 | +0.200 / 1.33 |
| 75 | +0.448 / 1.86 | +0.217 / 1.36 |
| 80 | +0.464 / 1.90 | +0.225 / 1.38 |

**H3 is largely confirmed [HIGH].** The full-period peak at 75–80 lives in TRAIN (the 2024-08→2025-11 bull run). In TEST — which includes the 2026 downtrend — high caps degrade to ~0.22 while cap 60 *improves* to 0.431. Cap 60 is the only setting whose out-of-sample result beats its in-sample result.

Incremental analysis — the trades each cap increase unlocks [HIGH]:
| increment | n | E[R] | sumR | 95% CI |
|---|---|---|---|---|
| 60→65 added | 64 | +0.331 | +21.2 | [0.003, 0.702] ✅ |
| …TRAIN | 35 | +0.422 | +14.8 | incl 0 |
| …TEST | 29 | +0.221 | +6.4 | incl 0 |
| 65→70 added | 42 | +0.184 | +7.7 | incl 0 |
| …TEST | 17 | **−0.315** | −5.4 | incl 0 |
| 70→80 added | 35 | +0.858 | +30.0 | [0.428, 1.288] ✅ |
| …TRAIN | 23 | **+1.187** | +27.3 | ✅ |
| …TEST | 12 | +0.229 | +2.7 | incl 0 |
| **60→80 added (total)** | **117** | **+0.432** | **+50.5** | ✅ |
| …TRAIN | 71 | +0.655 | +46.5 | ✅ |
| …**TEST** | **46** | **+0.088** | **+4.0** | **incl 0** |

The headline "+50R from raising the cap" is **92% earned in TRAIN**. Out of sample the same 46 added trades produce +4.0R — indistinguishable from noise. The spectacular 70→80 increment (E[R] 1.187) is 23 bull-run trades.

Displacement cost [MED]: raising 60→80 *loses* 22 trades cap-60 would have taken (E[R] +0.472, sumR +10.4) — cooldown/single-position sequencing means new longs crowd out good later entries. Raising the cap is not purely additive.

Full-set bootstrap, 20k resamples [HIGH]: cap 60 E[R] +0.304, CI **[−0.029, +0.636] — includes zero**; cap 65 [0.013, 0.586] ✅; cap 80 [0.173, 0.622] ✅. Note the CIs tighten mainly because n rises, not because per-trade edge improves.

Cost robustness [HIGH] — hypothesis that added high-RSI entries are slippage-fragile is **rejected**:
| cost/trade | cap 60 | cap 65 | cap 80 |
|---|---|---|---|
| $0.41 | +0.304 | +0.301 | +0.371 |
| $2.00 | +0.188 | +0.186 | +0.255 |
| $4.00 | +0.044 | +0.042 | +0.110 |
All degrade gracefully and cap 80 leads at every level — unlike the breakout sleeve (Part 3), which died at $0.75.

### Self-critique
- *What would disprove the "keep 60" call?* A TEST-period increment with a CI excluding zero. It doesn't have one.
- *Snooping:* this is the same 24 months used to select BALANCED originally, so all of these numbers are partially in-sample at the config level. TEST is the only quasi-honest window and it is 9 months / ~30–65 trades.
- *Simpler explanation for cap 60's strong TEST?* Small n (31). Its own CI includes zero. **"Cap 60 is best" is NOT established — only "raising it is not established either."**
- Gap [MED]: no fill-delay model. Live entries lag the H1 close by up to 15 min ([[entry-edge-unproven]]), which cost gold roughly half its E[R]; high-RSI momentum entries plausibly suffer more. Untested.

### CONCLUSION (Part 5) — keep 60, but for a *different reason* than before
The old rationale is dead: **"raising the cap halves edge and doubles drawdown" was a property of the trailing exit, not of high-RSI entries.** Under bracket, drawdown is flat across the whole 55–85 range and total return rises sharply. H1 was right about the mechanism.

But H3 defeats the trade: the gain is 92% concentrated in the bull TRAIN window and vanishes out of sample (+4.0R over 46 added trades, CI includes zero). Cap 65 is the most defensible alternative (increment positive in both halves, DD unchanged, +58% sumR) — but not at a level that justifies **resetting `CONFIG_REGIME` and zeroing the 3-trade bracket sample**, which is the real price of any change today.

**Decision: no change now.** Keep `EMA_TREND_RSI_BUY_MAX=60`, understanding it is now held on *insufficient evidence to move*, not on demonstrated optimality.

### Next steps
- Re-run this at 20 bracket-era trades, when live data can arbitrate between cap 60 and 65 independently of the 2024-25 bull run.
- If ever changed, 65 is the candidate — not 75–80 (bull-fit).
- Worth building: a fill-delay model in `backtest_engine.js` (entry at H1 close + 15 min) — it is the largest unmodelled term and bears directly on high-RSI entries.

---

## Part 6 — Is the session filter throwing away good trades in strong trends? (Aug 21 2026)

### Question
Two live setups (Aug 10, Aug 21 2026) passed every filter overnight, were skipped by
`TRADING_START_HOUR=8`, and appeared to be 2R winners. Prompted the worry that the session
filter and the RSI cap fight each other in a bull run: the rally holds RSI above 60 during
London/NY, so the only time RSI falls back into band is the Asian session — precisely when
the bot is switched off. Two anecdotes are not a distribution; this replays 24.7 months.

### Hypotheses
- **H1** — Session filter destroys edge in strong uptrends; overnight is where the good
  pullbacks live when RSI is elevated during the day.
- **H2** — Out-of-session signals are genuinely worse (thin liquidity, unreliable follow-through);
  the two recent misses are survivorship — missed *losers* are invisible.
- **H3** — Neither: "hour" is a proxy for something else (low overnight ATR → tighter ATR stop →
  stopped by ordinary noise). The lever would then be a volatility floor, not the clock.

### Method
New `research_session_filter.js`. Every H1 bar evaluated **independently** with the real
`EmaTrendStrategy` (dedup reset, no cooldown, no overlap suppression) — the only way to compare
the two sets fairly, since under a sequential run they are drawn from different cooldown-shifted
timelines. Exits replicate the live bracket regime exactly (stop or resting 2R TP, no BE, no
trail), M5 resolution, stop wins same-bar ties. Significance via **month-block bootstrap**
because overlapping signals are serially correlated.

Two realism terms added, both biasing *against* the out-of-session set so they had to be modelled:
- **Fill delay** — the 15-min scan latency flagged as the largest unmodelled term at the end of
  Part 5. Now built (`SF_DELAY_MIN`): entry taken at the M5 price actually available 15 min after
  the H1 close, not at the close itself.
- **Spread** — *measured*, not assumed, from 4 months of Oanda bid/ask M15: in-session median
  **$0.59**, out-of-session **$0.69**. Only $0.10 wider — much less than guessed.

**Engine validation [HIGH]:** the replay reproduces both live counterfactuals to the cent —
Aug 10 entry $4333.11 and Aug 21 entry $4510.77 match the live logs exactly.

### Evidence

Headline, realistic costs (15-min delay, measured spreads), n=215 signals:

| | n | E[R] | WR | PF | TP rate |
|---|---|---|---|---|---|
| **IN 08–22** | 116 | **+0.252** | 43.1% | 1.43 | 43.1% |
| **OUT 22–08** | 99 | **−0.174** | 29.3% | 0.77 | 29.3% |

Month-block bootstrap (2000 resamples): diff (out − in) = **−0.411, 90% CI [−0.785, −0.052]**,
excludes zero. **P(out worse than in) = 0.972.** [HIGH]
Idealised (no delay, flat $0.30) gives a larger gap: −0.524, CI [−0.886, −0.177], P=0.99.

**H1 is REFUTED, and the sign is backwards from the hypothesis [HIGH].** By trailing-10-day-return
tercile (regime from past data only, terciles rather than a hand-picked "strong trend" cutoff):

| regime tercile | range | IN E[R] | OUT E[R] |
|---|---|---|---|
| T1 weakest | −14.4%..−0.2% | +0.008 | −0.086 |
| T2 middle | −0.1%..+3.2% | +0.381 | −0.213 |
| **T3 strongest** | **+3.2%..+10.8%** | **+0.414** | **−0.206** |

Out-of-session is *worst* exactly where H1 predicted it would be best.

**H3 is REFUTED [HIGH].** The ATR confound is real but does not explain the gap. Out-of-session
signals do fire in much lower volatility (median ATR $8.22 vs $13.77 in-session). But reweighting
the out-of-session set to the in-session ATR mix leaves E[R] at **−0.174** — unchanged — leaving a
residual session gap of −0.426. The effect persists within both volatility groups (low-ATR:
+0.376 vs −0.163; high-ATR: +0.170 vs −0.187).

**Wick sub-hypothesis REFUTED [MED]:** if overnight stops were noise-wicks on sound setups, those
trades would show *higher* MFE before stopping. They show lower — median MFE 0.35R out-of-session
vs 0.46R in-session. They did not get wicked out of good trades; they never worked.

**The 02:00 pocket is not real [HIGH].** 02:00 UK is the only positive out-of-session hour
(+0.56, n=13) — and both live counterfactuals fired at 02:00, which is what made the pattern
feel meaningful. Permutation test shuffling hour labels within the out-of-session set:
**P(best of 9 hours ≥ +0.56 by chance) = 0.336.** Coincidence.

**Survivorship confirmed — this is what the eye was doing [HIGH]:** 4.5 setups/month are skipped
overnight, of which 29% would have hit the 2R TP. So **~1.2 "missed winners" per month is the
expected rate** — seeing 2 in 11 days is entirely normal — against **~2.8 missed losers per month
that are never noticed**.

**The Aug 10 miss was not a miss [HIGH].** With the 15-min fill delay modelled, its entry moves
$4333.11 → $4344.51 and the trade becomes a **−1.03R stop**, not a 2R win. It was a coin-flip, as
the 32-cent margin in the original note implied. Aug 21 survives the delay (+1.97R). Across all
signals, **9% flip sign on a 15-minute delay** (12 in-session, 7 out) — a useful calibration on how
much any single hand-checked counterfactual is worth.

Realistic sequential portfolio (2h cooldown, no overlap) — the practical cost:

| | trades | sumR | E[R] | WR | PF | maxDD | /month |
|---|---|---|---|---|---|---|---|
| **With session filter** | 74 | **+15.9** | +0.215 | 42% | **1.35** | **5.2R** | 3.0 |
| Without (24h trading) | 113 | +7.8 | +0.069 | 37% | 1.11 | **13.8R** | 4.6 |

Removing the filter costs **−8.0R over 24.7 months (~−£2,500)** and **2.7× the drawdown**. The
drawdown term is the stronger argument: 13.8R ≈ £4,300 would be hard to sit through.

### Self-critique
- *What would disprove this?* A walk-forward block with a positive gap. **There is one.** By
  6-month block the gap is −0.517, −0.487, −0.830, then **+0.112 in 2026-02..2026-08** — the most
  recent period, and the one being lived through. It survives dropping its top 2 trades (+0.166),
  so it is not outlier-driven; but n=27 and +0.166 is comfortably inside noise. Read as *the recent
  block fails to confirm the filter*, not as *the filter has stopped working*. [MED]
- *Conditional, not uniform [MED]:* the out-of-session penalty concentrates in **ADX 25–35**
  (−0.524 vs +0.181 in-session). At ADX < 25 there is no session difference at all (+0.192 vs
  +0.222). Unexplained; possibly the mid-ADX band is where thin overnight books produce false
  trend confirmation. Worth a look, not actionable at these n.
- *Snooping:* the 08–22 window was itself selected on overlapping data (Part 4/BALANCED), so this
  is partly in-sample at the config level. It is a *confirmation* of an existing choice, not an
  independent discovery — weaker evidence than the CI suggests.
- *Simpler explanation?* Checked and rejected: ADX mix (matched), ATR mix (reweighted), spread
  (measured), fill timing (modelled).
- *Gap:* mid-price candles cannot show overnight slippage or gapping through a stop, so the
  out-of-session set is if anything still flattered.

### CONCLUSION (Part 6) — keep the session filter; the premise was wrong
The worry that prompted this was backwards. Out-of-session signals are worse in general
(−0.41R, CI excludes zero), and **worst of all in strong uptrends** — the exact regime where they
were suspected of being best. The two vivid recent misses are the visible tail of a distribution
whose losses are invisible; one of the two isn't even a winner once execution latency is modelled.

**Decision: no change.** `TRADING_START_HOUR=8` / `TRADING_END_HOUR=22` stand, and no
`CONFIG_REGIME` bump — the bracket-era count survives.

### Next steps
- The **2026-02+ block is the one thing to watch**: if the next two 6-month blocks also fail to
  show a negative gap, that becomes a genuine regime signal rather than noise. Re-run then.
- The fill-delay model requested at the end of Part 5 now exists (`SF_DELAY_MIN`) and should be
  folded back into `backtest_engine.js` — it moved in-session E[R] from +0.376 to +0.252 and its
  90% CI now touches zero, consistent with [[entry-edge-unproven]].
- Do **not** treat single hand-checked counterfactuals as evidence again: 9% of them flip sign on
  a 15-minute fill delay.

## Part 7 — Post-mortem: Sep 4 2026 NFP gap through the stop (−2.40R, −£791). (Sep 4 2026)

### Question
Trade 1474 (LONG $4469.88, 22u, stop $4449.88, TP $4509.88) lost £791.34 — 2.4× the ~£330 its
stop should have cost. Bot fault, entry fault, or a structural exposure the bracket regime created?

### Competing hypotheses
- H1 — A scheduled release (US NFP, 12:30 UTC / 13:30 UK) gapped the market through the resting stop.
- H2 — Bracket/stop fault: stop missing, mis-set, or not resting at Oanda.
- H3 — Entry quality: leg 1.94× ATR (just under the 2.0 block), ADX 46 → a bad trade regardless of news.
- H4 — Oanda practice fills gaps more harshly than live would.

### Evidence
- **Oanda transactions** 1473–1482: market order 22u, fill $4469.88 (spread $0.55, halfSpreadCost £4.47);
  on-fill SL/TP at the *signal*-price levels (4457.97 / 4517.97) replaced 251 ms later by fill-based
  SL **1480 @ 4449.88** and TP 1478 @ 4509.88. `ensureBracket` logged "verified on attempt 2" — that is
  the normal path (attempt 1 reads the on-fill levels, writes the correction; attempt 2 re-reads and
  confirms). No `attempt n/3 failed` warn.
- **Exit** 1481: `ORDER_FILL reason=STOP_LOSS_ORDER orderID=1480` at 12:30:07.24 UTC, price 4421.85 =
  bid; ask 4431.85 (**spread $10.00**); closeout bid/ask 4412.25/4441.45 ($29). halfSpreadCost £81.56.
- **S5 bid**: 12:29:55 c 4469.47 → 12:30:00 o 4469.33 l 4465.64 c 4467.16 (vol 30) → **12:30:05 o 4421.85**
  l 4410.89 (vol 20) → 12:30:10 l 4390.76 (vol 278). The first bid printed after the release IS the fill
  price. Gap 4467.16 → 4421.85 = **$45.31**; the stop was jumped by **$28.03**.
- **Follow-through**: M1 12:30 low 4386.25; H1 12:00 low 4376.18, H1 13:00 low 4365.57 (−$105 from entry
  inside 90 min). A real repricing, not a spike that reverted.
- **Calendar**: FXStreet Sep 4 09:49 and 11:03 UTC both flag "US Nonfarm Payrolls at 12:30 GMT", 50/50
  Sept hike odds, "outsized moves" expected. Sep 4 is the first Friday of the month.
- **Trade path**: 195 monitor samples over 3h16m, MFE +$95.75 (+0.22R), MAE −$94.95 (−0.22R), +$24.14 at
  12:29:59. Flat. Never approached TP (day high $4490.90 vs TP $4509.88).
- **History**: 27 prior `STOP_LOSS_ORDER` exits in the tracker all filled AT or better than the stop level
  (the "better" ones are trail-tightened stops, pre-Jul-10). **First gap-through-stop in 40 trades.**
- **Exposure shift**: all-time median hold 0.3 h. Bracket-era holds: 3.3 h, 5.7 h, 6.5 h, 10.9 h, 68 h
  (≈94 h open in total). Only 3 trades ever straddled an NFP slot; two were Mar 26/27 trail-era 2-week shorts.
- **Code**: `grep -riE 'nfp|calendar|news.?filter|high.?impact' src/` → nothing. No calendar awareness exists.

### Loss decomposition (GBP/USD 1.335 from broker pnl ÷ pnlNotional)

| Component | USD | GBP | R |
|---|---|---|---|
| Stop at its level (22u × $20) | 440.00 | 329.5 | −1.00 |
| Gap past the stop (22u × $28.03) | 616.66 | 461.8 | −1.40 |
| **Total** | **1056.66** | **791.34** | **−2.40** |

Of the $28.03, roughly $5 is the widened half-spread and ~$23 pure gap. Intended risk 0.5% of
balance; realised 0.91%.

### Confidence
- **H1 HIGH** — timestamp to the second, S5 volume/spread signature, calendar confirmation.
- **H2 RULED OUT (HIGH)** — Oanda's own records show SL 1480 resting at 4449.88 and the fill citing it.
- **H3 MEDIUM as a contributor, not the cause** — the entry was late in the leg and went nowhere (MFE
  0.22R), but a perfect entry would still have been open at 12:30 unless it had reached TP, which price
  never came within $19 of. The calendar set both the outcome and its size.
- **H4 LOW / unknowable** — live Oanda also executes stops at market; $10–40 NFP gaps on gold are routine.
  No data to say practice was harsher. Gap.

### Self-critique
- *Disprove H1?* A gap at any other minute, or no release. Neither.
- *Simpler explanation?* None.
- *Survivorship / base rate:* "1 in 40" flatters the old regime, which had near-zero exposure at 18-min
  holds. ≈94 h open across two months containing 2 NFPs, 2 CPIs and 1 FOMC makes one hit close to the
  expected rate, not bad luck. Expect a recurrence every ~5–10 bracket trades if holds stay hours-to-days.
- *The replay cannot see this.* Part 6 already noted "mid-price candles cannot show gapping through a
  stop". Every replay E[R] figure (+0.15R, [[entry-edge-unproven]]) assumes stops fill at level. A −1.4R
  gap once every ~8 trades ≈ −0.17R/trade — the whole modelled edge.
- *Symmetry:* a favourable gap fills the TP better than 2R, so the expected gap contribution is ~0 in
  price terms. But it raises variance, and the −1.4R tail is exactly what 0.5%-per-trade sizing does not
  budget for.

### CONCLUSION (Part 7)
The bot did nothing wrong. The stop was real, verified, and honoured at the first tradeable price after a
$45 NFP gap. The loss is 1.0R of stop plus 1.4R of gap. What changed is structural: the Jul-10 bracket
regime turned 18-minute trades into multi-hour trades, and multi-hour trades inside 08–22 UK sit across
NFP (13:30 UK), CPI (13:30 UK) and FOMC (19:00 UK) with no calendar awareness anywhere in the code.
This is the first bill for that exposure, and the bracket edge evidence has never priced it.

**Decision: no change today.** One event, and the Part-6 rule stands (a single counterfactual is not
evidence). Bracket-era tally is now n=5, 3W/2L, +2.64R, net +£751, PF 1.68.

### Next steps (research, not deploy)
1. Build the high-impact US release list for the 24.7-month replay window (NFP, CPI, FOMC — ~50 events,
   all public and deterministic) and re-run `backtest_engine.js` with (a) no entry within 2 h before a
   release and (b) (a) + flatten 5 min before. Report E[R], PF, DD, and how many replay trades were open
   across a release. Deploy only on that, never on Sep 4 alone.
2. Measure real gap slippage at each event with S5 bid/ask (practice keeps ~6 months) — the replay's
   mid-candle stop fills are flattered.
3. Sizing: keep 0.5%, but treat worst-case as ≈2.5R ≈ 1.2% until (1) is answered.

## Part 8 — Scheduled-release exposure and the calendar filter (Sep 4 2026). Script: `research_news_filter.js` (repo) + events/slippage/shocks (scratchpad).

### Question
Part 7 recommended testing a calendar filter after the Sep 4 NFP gap. Decomposed:
- **Q1** How often is a bracket trade open across NFP/CPI/FOMC, and what happens to it?
- **Q2** What has gap-through-stop actually cost over 25.7 months once stops fill on real S5
  bid/ask at releases instead of at level (which every earlier replay assumed)?
- **Q3** Does (a) blocking entries within 2 h before a release or (b) flattening 5 min before
  improve E[R], PF or drawdown? (2 h / 5 min were pre-registered in Part 7.)
- **Q4** How much of gold's shock risk does a 3-event calendar even cover?

### Competing hypotheses
- **H1** Releases are a net cost: gap-through-stop is frequent enough that the replay's edge is
  materially overstated and a calendar filter recovers it. (Part 7's back-of-envelope: −0.17R/trade.)
- **H2** Releases are roughly neutral-to-positive for a 2:1 bracket: a shock larger than both
  distances reaches the TP as often as the stop, paying +2R against −(1+slip)R, so exposed trades
  are not worse and flattening throws TPs away.
- **H3** Sep 4 is a *2026* phenomenon: release moves have outgrown the $20 stop cap this year, so
  the 25-month average understates forward risk whatever the filter test says.

### Method
- **Calendar**: BLS Employment Situation + CPI archives and the Fed FOMC calendar, Jul 2024–Sep 2026,
  ET→UTC DST-aware. 66 events, each **verified** against Oanda S5 volume at the release minute
  (1.4–14.5× the prior 5 min, every one). One dropped: NFP Apr 3 2026 = Good Friday, market closed. n=65.
- **S5 bid/ask** fetched ±10 min around each event (practice holds S5 back to at least Sep 2024).
- **`research_news_filter.js`**: the Part 6 engine (real `EmaTrendStrategy`, independent H1 evaluation,
  15-min fill delay, measured $0.59/$0.69 spreads, month-block bootstrap) with three managed outcomes per
  signal — **mid** (stop at level = all earlier replays), **gap** (inside ±10 min of a release the position
  is managed on S5 bid/ask; a stop fills at the bar open if the bar opens through it, else pessimistically
  at the bar extreme; a gapped TP fills at the better price), **flat** (closed 5 min before at bid/ask).
  Entry-block grid pre {1,2,4} h × post {0,30,60} min. Sequential one-position portfolio with the 2 h
  cooldown for drawdown.
- **Engine validation [HIGH]**: the replay reproduces Sep 4 — entry $4470.15 (live $4469.88), slip
  $28.30 (live $28.03), −2.44R (live −2.40R).
- **Slippage table**: for every event and side, a stop $10/$20/$30 from the last pre-release price —
  hit within 5 min? how far past level?
- **Shock scan**: M5 episodes with 5-min range > 0.6 % of price or open-gap > 0.2 %, matched ±15 min
  to the calendar.

### Evidence

**Q1 — exposure.** 9 of 121 in-session signals (7 %) were open across a release: 6 NFP, 3 CPI, 0 FOMC.
Replay median hold 6.9 h, 67 % over 3 h — the same shape as the five live bracket trades (3–68 h), so
exposure is not understated. Three of the 9 are one Jul 2 2026 episode signalled at consecutive hours
(signal-level overlap) → 7 distinct episodes.

| in-session | n | E[R] | WR | PF | TP rate | worst |
|---|---|---|---|---|---|---|
| exposed, mid | 9 | +1.29 | 78 % | 6.65 | 78 % | −1.03 |
| exposed, gap | 9 | **+1.14** | 78 % | 3.94 | 78 % | −2.44 |
| exposed, flat 5 min | 9 | **+0.05** | 56 % | 1.47 | 0 % | −0.49 |
| unexposed | 112 | +0.22 | 42 % | 1.36 | 42 % | −1.07 |

7 TP / 2 STOP. Four of the seven TPs were filled *by* the release move. The 60-s release move went
WITH the position in 7 of 9 (all nine were LONG in a bull market — see critique).

**Q2 — gap cost.** gap − mid = **−0.011R/trade** (90 % CI [−0.037, 0]); −1.42R over 25.7 months,
**all of it Sep 4**. 2024: 0. 2025: 0. Exactly one stop in the whole replay filled inside a release
window. Sequential portfolio: mid 18.8R / DD 5.2R → gap 17.3R / DD 5.2R; PF 1.41 → 1.37.

**Q3 — the filters.**

| sequential, in-session, 2 h cooldown | n | sumR | E[R] | PF | maxDD | worst |
|---|---|---|---|---|---|---|
| gap (baseline) | 77 | 17.3 | +0.225 | 1.37 | 5.2 | −2.44 |
| flat 5 min before | 77 | **13.4** | +0.174 | 1.30 | **6.4** | −1.07 |
| gap + block 2 h | 77 | 17.3 | +0.225 | 1.37 | 5.2 | −2.44 |
| flat + block 2 h | 77 | 13.4 | +0.174 | 1.30 | 6.4 | −1.07 |

- **Flatten**: −0.078R/trade paired (CI [−0.183, +0.01], P(worse) = 0.92); −1.09R per exposed trade;
  the 7 TPs become +0.05R scratches. Walk-forward: worse in **4 of 5** six-month blocks.
- **Block 2 h**: removes **3 signals in 25 months**, net **+2.9R** (1 stop, 2 TPs — the Jul 2 episode).
  Removed-set E[R] +0.96, CI [−1.06, +1.97]. Sequential identical (those signals weren't taken anyway).
  No pre/post cell in the grid removes a negative set.
- **Combined**: −0.071R/trade, P(worse) = 0.88.

**Q4a — slippage regime (measured, $20 stop, pessimistic within-bar fill).**

| period | sides | hit ≤5 min | median slip | mean | max | P(slip > $5) |
|---|---|---|---|---|---|---|
| 2024 | 28 | 0 % | – | – | – | – |
| 2025 | 60 | 8 % | $1.3 | $3.5 | $12.2 | 20 % |
| 2026 | 42 | 26 % | $9.4 | $11.2 | $27.6 | 73 % |
| since Feb 2026 | 36 | **31 %** | $9.4 | $11.2 | $27.6 | 73 % |

60-s release move, median: 2024 $8.9, 2025 $9.3, **2026 $32.0**; P(move > $20): 0 % / 3 % / **52 %**.
Optimistic within-bar fills erase all slippage except Sep 4 (bar opened through the stop), so the
pessimistic figures are an upper bound — but the Sep 4 type is model-independent.

**Q4b — coverage.** 393 shock episodes in 25.7 months; **26 (7 %) on the calendar**. 2026 alone: 281
episodes (2024: 15), 12 on calendar, **152 in-session and off-calendar**. The largest moves are not
scheduled: Jan 29 2026 15:25 UK $214 range, Mar 23 11:05 $140, Feb 12 16:10 $102. Off-calendar
in-session shocks peak 14–15 UK (64 of 189).

### Confidence
- **H2 supported [MED]**: flatten negative at P = 0.92 and 4/5 blocks; block removes winners. Sign is
  robust; magnitude rests on 7 distinct episodes.
- **H1 rejected [HIGH on the 25-month record]**: one gap-through-stop in 121 in-session signals; the
  replay edge was overstated by 0.01R, not 0.17R.
- **H3 supported [HIGH]**: measured from S5, not modelled. Release moves exceed the cap half the time in 2026.
- "Exposed trades are *better*" — [LOW]: all nine were LONG in a bull market with gold-positive prints.
  What is HIGH is only that they are not worse.

### Self-critique
- *Disprove H2?* Releases leaning AGAINST positions, or slips large enough to flip the asymmetry. At
  the 2026 median slip ($9.4 = 0.47R) a coin-flip release pays 0.5×2 − 0.5×1.47 = +0.27R; it turns
  negative only if P(against) > 58 %. Observed 2 of 9.
- *Survivorship:* exposed trades are trades that survived hours, i.e. trending ones — but that is the
  exact population a flatten rule acts on, so it is the right comparison.
- *Snooping:* 2 h / 5 min were pre-registered; the grid was sensitivity and no cell helped, so nothing
  was selected.
- *Part 7's −0.17R/trade was wrong.* It assumed a −1.4R gap every ~8 trades; the record shows one in
  121. It was a same-day estimate written under the loss — the recency error Part 6 warns about, now
  committed by the author of Part 6. Recorded.
- *Coverage:* three event types only; the shock scan answers that — a calendar cannot address 93 % of
  large moves, and "flatten before every shock" is not implementable because they are unscheduled.
- *Live vs practice fills:* still unknowable [LOW]. Gap model double-counts ~$0.30 half-spread inside
  windows; negligible.
- *Forward cost:* P(exposed) 7–11 % × P($20 stop reached | exposed, 2026) 0.31 × E[slip | hit] 0.56R
  ≈ 0.01–0.02R/trade. Small beside a +0.25R edge; the tail (−2.4R) is real and sizing must budget it.

### CONCLUSION (Part 8) — calendar filter REJECTED, both variants
Flattening 5 min before a release is the worst configuration tested: for a 2:1 bracket a release is a
volatility injection that reaches the TP at least as often as the stop, and the replay's exposed trades
hit TP 7 of 9. Blocking entries 2 h before removes 3 signals in 25 months, net +2.9R. Gap-through-stop
has cost −0.011R/trade over 25.7 months, all of it on Sep 4.

What IS real: since Feb 2026 release moves exceed the $20 cap half the time and a $20 stop hit inside
a release slips a median $9; and 2026 gold produces 19× the 5-minute shock episodes of 2024, 93 % of
them unscheduled. The Sep 4 loss is the price of a $20 stop in a market whose shocks routinely exceed
$30 — a volatility-regime and sizing fact, not a calendar fact.

**Decision: no calendar filter, no flatten rule, no CONFIG_REGIME bump.** Keep 0.5 % risk; budget the
tail at ~2.5R ≈ 1.2 % of balance. Bracket-era count continues.

### Next steps
- Do **not** reopen this on the next gap loss. Reopen only if exposed trades reach n ≥ 20 with negative E[R].
- The open question is the **2026 volatility regime**: 281 shock episodes vs 15 in 2024, most unscheduled.
  The $20 cap was set at ATR ~$25 ([[ema-stop-cap-widened]]); whether it should scale with a shock
  measure is a *risk-budget* study, not exit tuning ([[exit-config-not-the-lever]]). Not urgent: the
  sequential DD under real gap fills is unchanged at 5.2R.
- `research_news_filter.js` carries the S5-at-release management; fold it into `backtest_engine.js` if
  that engine is revived.

---

## Why live trades fell 9 → 2 → 2, and what the MTF layer actually costs (2026-09-20)

**Question.** Live executions dropped from 9 (2 Jul–29 Jul) to 2 (29 Jul–23 Aug) to 2
(23 Aug–19 Sep). The prompting hypothesis was that the MTF entry layer was arming signals
and then dropping them (fake-pullback rejections, 8-candle timeouts), so the ask was to
replay those rejected setups and price the layer.

**That premise is wrong. — HIGH confidence.**
Every `ENABLE_MTF` / `pendingMTF` / `isMTFEntry` reference is in `breakout_adx_strategy.js`;
`ema_trend_strategy.js` has none. The live strategy is EMA Trend (`🟢 Strategy: EMA Trend`
on every executed trade). Breakout + ADX runs as the HYPOTHETICAL/realtime-MTF shadow, and
every MTF event in the logs belongs to it — confirmed against the broker: `MTF Entry Found!`
on 24, 25, 31 Aug and 1 Sep produced NO trades on those dates (broker trade list: 09-04 then
09-17). **The MTF layer cannot be costing the live book anything, because it is not in the
live path.** Replaying its rejections would price a shadow strategy's entry timing.

**It is also not a conversion problem. — HIGH confidence.**
`LIVE (EMA Trend):` prints only ever say "No setup" (2523/2523, 2376/2376, 2533/2533), so a
live setup goes almost straight to execution; cooldown blocks are 6/3/7 per period and
"Trade blocked" is 0. Signals ≈ executions. The drop is in SIGNALS, not in what happens to
them.

**What tightened, per ~2,500 scans per period (Jul / Aug / Sep). — MEDIUM-HIGH.**

| gate | Jul | Aug | Sep |
|---|---|---|---|
| leg filter ("chasing exhausted move") | 60 | 240 | 297 |
| RSI outside band | 1554 | 2244 | 2438 |
| pullback proximity | 231 | 303 | 237 |
| EMA alignment but filtered | 1872 | 1642 | 1446 |
| ADX declining | 1280 | 1194 | 1046 |
| executed | 9 | 2 | 2 |

The ADX gates and pullback proximity are flat-to-easing; the two that tightened are the
**leg filter (5x)** and the **RSI band (+57%)**. Both are "this move has already run"
filters, and gold ran ~$3.6k → $4.4k over the window. Consistent story: a pullback-entry
strategy refusing to chase a runaway trend, BY DESIGN. The leg filter has been enforced
since `48cd738` (2026-06-01), so it is not a July code change — the market moved, not the
config.

**Self-critique.** Counts are per scan-cycle, not per opportunity, and one line can list
several filters, so these are pressure indicators, not an opportunity ledger. A simpler
explanation I cannot yet exclude: fewer genuine EMA-aligned trends occurred, and the filter
counts are incidental. Distinguishing the two needs the replay below, not more log counting.

**Confidence: HIGH** that MTF is not in the live path (code + broker record agree).
**MEDIUM** that leg filter + RSI band are the binding constraint on live entries.
**LOW** on whether that gating costs or saves money — unmeasured, which is the open question.

**Next action — the replay, retargeted.** Population: leg-filter-blocked LONG/SHORT setups
(cleanest: each logs `legATR=Nx in-direction` with the scan price), deduped to one episode
per H1 bar. Counterfactual: enter at the blocked scan price, stop $20, TP $40 — the live
bracket is pinned at the `EMA_TREND_MAX_SL` cap (every executed trade logs
`Distance=$20.00`) with `EMA_TREND_TP_RR=2.0` and breakeven/trailing disabled. Resolve on
M15 candles, stop-before-target within a bar (conservative). Report mean R and the
distribution, not just the sum. Expect n ≈ 30–60 episodes: enough to see a large effect,
not enough to settle a small one — pre-register that before looking.

### Result — leg-filter replay, run 2026-09-20

**Population.** 95 leg-filter-blocked episodes (78 LONG / 17 SHORT), 10 Jun – 20 Sep,
legATR 2.04–4.68, deduped to one per H1 bar per direction from 377 raw block lines.
**45 of the 95 occurred with the market SHUT** — the bot scans through the weekend and
re-reports the same block — leaving 47 replayable (3 unresolved at the data edge).

⚠️ This invalidates the "leg-filter blocks grew 5x, 106 in one day" figure quoted earlier:
that day was Sat/Sun 19–20 Sep with gold closed. September's 53 episodes are 5 real ones.
**Never count a gate from scan lines without checking the market was open.**

**Method.** Entry at the blocked scan price, stop $20, TP $40 (the live bracket:
`EMA_TREND_MAX_SL` cap, `EMA_TREND_TP_RR=2.0`, BE/trailing off), resolved on M15 mids,
stop taken first when one bar spans both. Pre-registered rule: costly if mean ≥ +0.2R with
t > 2, protective if ≤ −0.2R with t > 2, else inconclusive.

| | n | mean R | t |
|---|---|---|---|
| blocked, per episode | 47 | +0.213 | +0.98 |
| blocked, per episode, $0.40 entry cost | 47 | +0.149 | +0.69 |
| **blocked, per independent CLUSTER** | **21** | **+0.031** | **+0.11** |
| allowed (executed), replay window | 17 | −0.003 | −0.01 |
| allowed (executed), bracket-exit era only | 5 | −0.076 | −0.08 |

**Clustering is the whole story.** Consecutive hourly blocks during ONE trend are the same
opportunity counted repeatedly (max cluster 8 episodes). Averaging within a cluster first —
12h/same-direction linkage — takes the apparent +0.21R down to **+0.03R**. The naive figure
was correlated resampling of a handful of trends, which is the data-snooping trap §4 asks
about, and it was there.

**Verdict: INCONCLUSIVE, leaning "the filter costs nothing measurable". — MEDIUM.**
Blocked opportunities returned ≈ +0.03R; the trades the filter allowed returned ≈ −0.08R
to −0.003R. Neither is distinguishable from zero, nor from the other. What the filter
demonstrably does is cut trade COUNT, not expectancy.

**Power.** sd 1.34 across 21 clusters ⇒ SE 0.29 ⇒ only an effect of ~±0.6R per opportunity
would have been detectable. A real ±0.2R edge, either way, is invisible at this n. Do not
read the sign of +0.03R as a finding.

**Ruled out.** (a) MTF costing live trades — it is not in the live path at all. (b) A July
config change — the leg filter has been enforced since 2026-06-01. (c) A conversion problem
— live signals become trades ~1:1.

**Open.** Whether the RSI band (1554 → 2244 → 2438 raw, weekend-contaminated, needs the
same market-open filter) is the binding constraint; and whether the strategy's problem is
gating at all rather than the −$11,218 lifetime P&L on 84 trades.

**Next.** Re-run this replay after ~40 more independent clusters, or on the RSI-band
population which is larger. Do NOT tune the leg filter on this result.

### Result — RSI-band replay, run 2026-09-20

**Population.** 3,426 RSI-block scans → 856 episodes (one per H1 bar per direction; 495
SHORT / 361 LONG) → **642 replayable** (the rest market-shut). Bands seen: 15-60 (long),
45-85 / 40-85 / 35-85 (short) — the short band was re-tuned during the window.
Same method as the leg-filter replay: entry at the blocked scan price, stop $20, TP $40,
M15, stop-first. An RSI block means EMA alignment AND the ADX filters already passed
(`ema_trend_strategy.js:165-181`), so this is an upper bound on the gate's own population —
the pullback and HTF gates are evaluated after it and never ran on these.

**The answer depends entirely on how a cluster is summarised, and that IS the finding.**

| linkage | clusters | FIRST of cluster | cluster AVERAGE |
|---|---|---|---|
| 2h | 113 | +0.035R (t +0.26) | −0.327R (t −3.44) |
| 4h | 83 | −0.024R (t −0.16) | −0.493R (t −5.51) |
| 12h | 51 | +0.118R (t +0.57) | −0.421R (t −4.30) |
| 24h | 43 | +0.186R (t +0.82) | −0.400R (t −3.80) |
| 48h | 40 | +0.200R (t +0.85) | −0.374R (t −3.37) |

Stable across every window, so neither figure is a linkage artefact. Per episode (no
clustering) it is +0.014R, n=642 — the correlated-sample trap again.

⚠️ **Pre-registration was imperfect and I am not going to hide behind it.** I registered
"mean R per cluster" WITHOUT specifying average-of-cluster vs first-of-cluster. Average
says PROTECTIVE (−0.42R, t −4.3). First says INCONCLUSIVE (+0.12R, t +0.57). The choice
between them was reasoned AFTER seeing both, which is exactly what pre-registration exists
to prevent, so it is recorded as a judgement call, not a result.

**The decision-relevant metric is FIRST-of-cluster**, because with one position at a time
and `TRADE_COOLDOWN_HOURS=2` the bot could only ever have taken the first setup in a blocked
regime. The later ones in the same regime were never available to it.

**Verdict: INCONCLUSIVE on what the gate costs. — MEDIUM.** On the trades the bot could
actually have taken, blocked setups returned ≈ +0.12R against ≈ −0.003R for the trades it
did take (n=17). Neither is distinguishable from zero. Power: sd 1.46 over 51 clusters ⇒
SE 0.20 ⇒ only a ~±0.4R effect was detectable.

**What IS solid (t ≈ −4, every linkage): setups AFTER the first in a blocked regime lose
about 0.4R each.** The RSI band is insurance against re-entering an already-extended move.
That is a real property — it just mostly duplicates protection the position limit and the
2h cooldown already provide, which is why it does not show up in the tradeable counterfactual.

**Next.** Do not tune the RSI band on this. The two gate replays now agree on the same
answer — leg filter +0.03R (n=21), RSI band +0.12R (n=51), both inconclusive — so gating is
probably NOT where this strategy's −$11,218 over 84 trades comes from. The next question is
the strategy's own expectancy, not which setups it declines.

---

## Part 9 — Is gold's up/down asymmetry real, and does 1R:1R capture it? (Sep 21 2026). Script: `research_barrier_race.js` (repo) + race/speed (scratchpad).

### Question
Prompted by a discretionary trader (long-only, reportedly successful) who observes that **gold's
up-moves run quickly in trend while down-moves "bleed" slowly**, and trades it by entering on a
pullback with overhead **resistance as the take-profit** and a symmetric stop — i.e. **1R:1R**.
Decomposed:
- **Q1** Is the *speed* claim true? Does +X get reached faster than −X?
- **Q2** Is there a *directional* edge, i.e. P(+X before −X) > 50%?
- **Q3** If yes to Q2, does it survive de-trending — or is it just gold's bull run?
- **Q4** What win rate must a 1R:1R long clear to beat the live 2R bracket?

### Competing hypotheses
- **H1 Drift asymmetry (real edge).** Gold genuinely drifts up faster than down; P(up first) > 50%
  structurally, and 1R:1R monetises it.
- **H2 Bull-market artifact.** Gold ran ~$2,600 → ~$4,400 over the sample. In a +69% market
  everything long looks fast. The pattern is drift that we cannot assume forward.
- **H3 Variance asymmetry (illusion).** Up-moves are merely *faster* (higher realised vol), not
  more *likely*. At symmetric barriers this nets to **exactly zero** — same coin flip, resolved
  sooner, while paying spread more often per unit time. **Speed is only edge if it is drift.**
- **H4 Inverted.** Gold carries the equity-like negative-skew pattern (grind up, spike down), so
  the observation is backwards and *down* is the fast direction.

### Method
Deliberately **strategy-free**: every H1 close over 26.7 months (Jul 2024 – Sep 2026, 13,050 sample
points, 157,931 M5 bars) is raced independently. This tests the **market**, not any entry rule —
which is the point, since the claim made was about gold itself. Barriers in three modes, to be sure
the result is not an artifact of barrier scaling: **atr** (1.5×ATR(14) clamped $2–$20 = the live stop
formula), **fix** ($20 = the live cap), **pct** (0.5% = scale-free; $20 is 0.77% at $2,600 but 0.45%
at $4,400, so a flat dollar barrier silently narrows as gold rises).
Resolution M5. Bars spanning both barriers are reported separately and resolved three ways
(up / down / excluded) — a conclusion only counts if it survives all three; ambiguity was ≤0.3%
throughout, so it never mattered. Speed measured in **M5 bars (market time)**, so weekends do not
count. Significance by **month-block bootstrap** (27 blocks, 2,000 draws) because overlapping
windows are serially correlated.
**De-trending**: multiplicative deflator `D_t = exp(-mu*t)`, mu = mean M5 log return, applied
identically to O/H/L/C so intrabar structure is preserved exactly. In-sample by construction — it is
a **diagnostic** ("is this drift?"), never a tradable rule.

### Findings

**Q1 — the speed claim is BACKWARDS. Confidence HIGH.**
Conditional-on-winning medians said down was faster in all 3 modes × all 3 regimes. Because that
statistic is selection-prone, it was re-run as **independent first-touch** (time to reach +0.5%
ignoring −0.5%, and vice versa):

| | median to +0.5% | median to −0.5% | never touched (up / down) |
|---|---|---|---|
| Raw | 108 bars (9.0h) | **96 bars (8.0h)** | 12.1% / 22.4% |
| De-trended | 107 bars (8.9h) | **97 bars (8.1h)** | 16.1% / 18.6% |

Down is faster by ~1 hour, **raw and de-trended, in every cut**. Gold grinds up and spikes down —
the equity-like negative-skew pattern (**H4**), not the claimed one. Note the raw never-touched
column: the up barrier is *reached more often* (12.1% vs 22.4% missed) — that is the bull market —
but when both are reached, down still gets there first. Reachability was drift; speed was not, and
speed favours the short side.

**Q2/Q3 — the directional edge is real in raw data and is 100% drift. Confidence HIGH.**

| Mode | raw P(up first) | 90% CI | de-trended | 90% CI |
|---|---|---|---|---|
| atr (live formula) | 52.8% | [50.7, 55.1] | **51.0%** | [48.4, 53.6] |
| fix $20 | 53.7% | [50.8, 56.8] | **51.2%** | [48.1, 54.3] |
| pct 0.5% | 53.3% | [51.0, 55.8] | **50.9%** | [48.5, 53.3] |

Raw CIs exclude 50% in all three modes. De-trended CIs **include 50% in all three**. The deflator
removed **41.7%/yr** — that is the entire effect. By regime (trailing 5-day return, terciles, past
data only) the raw edge is concentrated where drift is: DOWN 49.0–49.3%, FLAT 54.1–55.8%,
UP 55.3–56.1%. **H2 confirmed, H1 rejected.**

**Cost kills what little remains:**

| spread | raw P(up) → E[R] | de-trended P(up) → E[R] |
|---|---|---|
| $0.00 | 53.35% → +0.067R | 50.92% → +0.018R |
| $0.30 (realistic) | 53.00% → +0.060R | **50.41% → +0.008R** |
| $0.50 | 52.77% → +0.055R | **50.01% → +0.000R** |

**Q4 — the bar. Confidence HIGH (arithmetic).**
1R:1R breaks even at 50% (~51% after spread). To *match* the live 2R bracket — 2R reached ~41%
⇒ E[R] +0.23R gross, +0.15R after the modelled 15-min fill delay — a 1R:1R long needs
**p = 61.5% (gross) / 57.5% (delay-adjusted)**. Unconditionally it delivers 50.4% de-trended.
Even the single most favourable cut in the whole study — raw, fixed $20, UP-regime tercile —
is **56.1%**, still short of the bar, and that number is drift-assisted.

### Self-critique
- *What would disprove this?* A de-trended P(up first) whose CI excluded 50%. It did not, in any mode.
- *Simpler explanation?* Yes, and it won: the bull market (H2).
- *Snooping?* Regime terciles are descriptive, classified from past data only; no threshold was
  hand-picked. Three barrier modes and three ambiguity resolutions were reported, not selected.
- **Main limitation, stated plainly:** this is the **unconditional baseline**. It refutes the
  *mechanism* (speed) and the *structural* claim (drift-free edge). It does **not** refute his
  *entry*. A conditional rule could in principle lift 50.4% → 57.5%+, and nothing here rules that
  out — it only sets the bar at a ~7pp lift from entry timing alone, which is a very large ask.
- De-trend + `atr` mode mixes raw-price ATR with deflated barriers; immaterial (deflator is slowly
  varying and ATR is local), and `pct` mode — immune to this — gives the same answer.

### CONCLUSION
**Most supported: H2 (bull-market artifact) + H4 (speed is inverted).** Gold's up-bias over the last
26.7 months is entirely its 41.7%/yr uptrend. Strip that out and a symmetric 1R:1R long is a coin
flip that goes to exactly zero expectancy at a $0.50 spread. And the *stated reason* for the trade —
up-moves being quick — is the opposite of what gold does; down is the fast direction, raw and
de-trended, in every cut.

**Ruled out: H1 (structural drift edge)** — de-trended CIs include 50% in all three barrier modes.
**H3 (pure variance illusion)** is only partly right: there IS a speed asymmetry, but it points down.

**The honest framing for a long-only 1R:1R trader:** the approach is not edgeless — it earns
**+0.060R/trade** as long as gold keeps rising at ~40%/yr. But that is a **levered directional bet
on the gold trend, not a structural edge**, and it is ~2.5× worse than the bot's existing 2R bracket
(+0.15R) even *with* the bull market helping. When the trend stops, it goes to zero, not to a smaller
positive number.

**Do NOT switch the bot to 1R:1R.** This is independent confirmation of
`payoff-asymmetry-structural` from a completely different angle: widening R multiple beats tightening
it, and the 2R bracket's ~41% reach rate has a 7.7pp cushion over its 33.3% break-even where 1R:1R
has ~0.4pp over its 50%.

### Next
- **Test 2 (cheap, not yet run):** re-resolve the existing EMA Trend signal set at 1R:1R vs 2R on
  identical entries, month-block bootstrap. Part 9 tests the market; Test 2 tests *our* entries, and
  is the one that could still change a live config. Prediction from the above: 2R wins clearly.
- **Test 3 (needs his rule pinned down):** his actual entry is pullback-to-support with *resistance
  as the TP* — so his R is **structure-derived, not ATR-derived**, which also means his R varies
  trade to trade and his "1R:1R" is only symmetric in price, not in probability. Worth testing only
  if Test 2 is surprising.
- Do not read Part 9 as "his results are fake". It says his *explanation* is wrong and his *structural*
  edge is zero; it cannot see his execution, and he is trading a market that has genuinely paid longs.

---

## Part 9b — Test 2: does 1R:1R beat the live 2R bracket on OUR OWN entries? (Sep 21 2026). Script: `research_tp_sweep.js` (repo).

### Question
Part 9 tested the **market** and found gold's up-bias is entirely drift. This tests **our entries**:
take the real `EmaTrendStrategy` signal set over the same 26.7 months and re-resolve every signal at
eight TP multiples (0.75R → 4R). Pre-registered prediction in Part 9: *"2R wins clearly."*

### Method — paired, and that is the whole point
Every k shares the **same signal, same entry price, same stop**; only the resting target moves, and a
single M5 walk resolves all k simultaneously. This is why it can see what
`exit-config-not-the-lever` could not: that study compared *sequential portfolio runs*, where
poll-timing noise (±£1,500) swamped the config effect. Here the entries are literally the same rows,
so the noise cancels and inference is on the **paired difference**.
Fidelity inherited from `research_session_filter.js`: H4 HTF must be closed by bar time (no future
leak), 15-min scan-latency fill delay with entry at the price actually available, $0.30 spread
charged in R, M5 resolution, pessimistic when a bar spans both barriers.
**233 signals, 124 in-session** (Jul 2024 – Sep 2026, 27 months).

Two inference routes, because they fail differently:
- **Month-block bootstrap** on the paired mean difference (4,000 draws).
- **Month-level paired sign test** (unit = calendar month, n=27). Robust to the clustering below and
  to fat tails, which the mean is not.

**Clustering, stated up front:** dedup is deliberately reset so every H1 bar is evaluated
independently (same as Part 6). The 124 in-session signals are therefore **not** 124 independent
trades — they cluster into **90 episodes at >2h separation, 81 at >6h, 70 at >24h** (e.g. 2026-01-19
fires 4 consecutive bars). Live dedup + 2h cooldown + 1-position limit would take one of each. Both
inference routes use the **calendar month** as the unit, so this does not corrupt them — but raw
n=124 overstates independence and must not be quoted as a trade count.

**Intrabar ambiguity was ZERO at every k** — no M5 bar ever spanned both barriers (would need a
$35–$100 range in 5 minutes). The planned pessimistic/optimistic sensitivity is therefore vacuous:
the optimistic run is bit-identical. One less thing to worry about.

### Findings — in-session, live config (n=124 signals / 27 months)

| TP | E[R] | sumR | WR% | PF | TP-hit% | med hold | R/day | £/trade |
|---|---|---|---|---|---|---|---|---|
| 0.75R | +0.023 | +2.9 | 59.7 | 1.06 | 59.7 | 2.5h | +0.223 | +£10 |
| **1.0R** | **+0.108** | +13.4 | 56.5 | 1.24 | 56.5 | 3.3h | +0.797 | **+£47** |
| 1.25R | +0.176 | +21.9 | 53.2 | 1.37 | 53.2 | 4.3h | +0.996 | +£76 |
| 1.5R | +0.249 | +30.9 | 50.8 | 1.50 | 50.8 | 5.1h | +1.176 | +£108 |
| **2.0R (live)** | **+0.285** | +35.4 | 43.5 | 1.50 | 43.5 | 6.9h | +0.990 | **+£124** |
| 2.5R | +0.277 | +34.4 | 37.1 | 1.43 | 37.1 | 10.3h | +0.649 | +£120 |
| 3.0R | +0.269 | +33.4 | 32.3 | 1.39 | 32.3 | 13.4h | +0.482 | +£117 |
| 4.0R | +0.441 | +54.7 | 29.8 | 1.62 | 29.0 | 15.6h | +0.679 | +£191 |

**Month-level paired sign test vs 2R — the headline. Confidence HIGH.**

| TP | months beating 2R | two-sided p | |
|---|---|---|---|
| 0.75R | 7/27 | **0.0192** | significantly worse |
| **1.0R** | **7/27** | **0.0192** | **significantly worse** |
| 1.25R | 6/27 | **0.0059** | significantly worse |
| 1.5R | 4/27 | **0.0003** | significantly worse |
| 2.5R | 14/27 | 1.00 | indistinguishable |
| 3.0R | 13/27 | 1.00 | indistinguishable |
| 4.0R | 12/27 | 0.70 | indistinguishable |

**Every target below 2R is significantly worse, month after month. Nothing at or above 2R is
distinguishable from 2R.** The bootstrap agrees directionally but is weaker (1R vs 2R: −0.180R,
90% CI [−0.367, +0.032], P(worse)=92.4%) — the mean is noisier than the sign under fat tails, which
is exactly why both were run. Note 1.5R carries the *most* significant p (0.0003) despite an E[R]
close to 2R: the sign test measures **consistency**, not magnitude.

**The turnover steelman fails too.** A faster target frees capital sooner, so 1R was given the
benefit of an R-per-day metric: **1R = +0.797 R/day vs 2R = +0.990**. 1R is worse *per unit time as
well as per trade*. (And throughput does not bind anyway — at ~3 trades/month the bot is
signal-starved, not time-starved; see [[frequency-by-design-silver-next]].)

**Longs only, 1R:1R → WR 55.8%**, against the 57.5–61.5% bar Part 9 set. Falls short, as predicted.
**Shorts beat longs again** at 2R (+0.325 vs +0.273 E[R], n=29 vs 95) — third independent
confirmation of [[entry-edge-unproven]] and [[direction-keep-both-ways]], and a direct strike against
the long-only premise.

**The 4R temptation — real mechanically, not actionable. Confidence MEDIUM.**
Not an outlier artifact: 36 of 124 reach 4R, top trade is only 7% of sumR, trimmed means hold
(+0.441 raw → +0.388 dropping 3 best and 3 worst). Transition from 2R: of **54** trades that hit the
2R TP, **36 keep running to 4R** (+2R each) and **18 give it back** (mean −0.95R) ⇒ net
**+0.152R/trade**. But it is **not significant (12/27 months, p=0.70)** and the exposure cost is real:
median hold 6.9h → 15.6h, holds >24h 15% → 35%, holds **>72h 0% → 9%**. Part 8 and
[[nfp-gap-through-stop]] put the tail risk precisely in that overnight/weekend/release exposure.
Buying +0.15R of unproven edge with 2.3× the time-at-risk is not a good trade on this evidence.

### Self-critique
- *What would disprove this?* 1R beating 2R in a majority of months. It won 7 of 27.
- *Level discrepancy, flagged not hidden:* 2R here shows E[R] +0.285 where
  [[entry-edge-unproven]] recorded ~+0.15R (PF matches exactly at 1.50; n and window differ —
  26.7mo/124 vs 24mo/72, and leg-filter enforcement may differ). **The paired design makes this
  irrelevant to the conclusion**: any level-calibration difference cancels in a within-signal
  comparison. It does mean the absolute £/trade column should be read as indicative, not forecast.
- *Snooping?* The k grid was fixed before running; the prediction ("2R wins clearly") was
  pre-registered in Part 9. No threshold was tuned to the answer.
- *Clustering* handled by month-level units in both inference routes; raw n=124 is not a trade count.

### CONCLUSION
**Prediction confirmed. 1R:1R is significantly worse than the live 2R bracket on our own entries:
E[R] +0.108 vs +0.285 (2.6× worse), £47 vs £124 per trade, p = 0.019 by month-level sign test — and
worse per unit time as well.**

**⛔ No config change. Keep `EMA_TREND_TP_RR=2.0`.** The live setting sits at the lower edge of a flat
plateau (2R/2.5R/3R/4R all statistically indistinguishable) with a cliff immediately below it. That
is a good place to be: the downside of being slightly wrong about the plateau is nil, while
everything beneath 2R is measurably worse.

Together with Part 9: the friend's geometry loses **on the market** (drift-free edge ≈ 0.000R) **and**
on our entries (−0.18R vs 2R). The two tests are independent and agree.

### Next
- Nothing actionable. Do **not** chase 4R — revisit only if live holds and gap exposure are ever
  re-examined together, and only with a pre-registered test.
- Test 3 (his actual entry rule) is now low value: both the market test and the entry test point the
  same way, and his R is structure-derived so his "1R:1R" is not even probability-symmetric.

---

## Part 10 — "The bot rarely trades but the chart keeps moving." Is the strategy mis-specified? (Sep 21 2026). Scripts: `research_funnel.js`, `research_rsi_sweep.js`, `research_rsi_portfolio.js`.

### Question
User observation: gold visibly oscillates but the bot takes ~3 trades/month. Is that correct
discipline, or is the entry/exit mis-specified? Decomposed: (Q1) where does the funnel lose
candidates — from DATA, not log lines; (Q2) how much of the time is gold actually trending by our
own definition; (Q3) is the movement even capturable at a $20 stop; (Q4) is the RSI band the binding
constraint (left open by the Sep-20 note); (Q5) does widening it pay.

### Competing hypotheses
- **H1 Correct discipline** — gold is ranging, a trend bot should sit out.
- **H2 Mis-specified entry** — the trend is there and our gates are too tight.
- **H3 Wrong strategy for the regime** — gold mostly ranges, needs a second sleeve not looser gates.
- **H4 Not capturable** — movement is real but small vs a $20 stop + spread.

### Q1 — the funnel, built from candle data. Confidence HIGH.
Oanda emits no candles when the market is shut, so the weekend contamination that invalidated the
Sep-20 log counts **cannot occur** here. 12,920 market-open H1 bars, 61% in-session:

| gate (sequential — strategy returns on first failure) | blocked | % of bars |
|---|---|---|
| EMAs not aligned | 7,269 | 56.3% |
| **RSI outside band** | **4,948** | **38.3%** |
| HTF disagrees | 174 | 1.3% |
| leg filter | 154 | 1.2% |
| ADX too low / declining | 140 | 1.1% |
| no pullback | 2 | 0.0% |
| **SIGNAL** | **233** | **1.80%** |

**This corrects the Sep-20 log-based read.** Leg filter and ADX are *not* the binding gates (1.2% and
1.1%). EMA alignment removes 56.3%; of the 5,651 bars that survive it, **the RSI band removes 4,948 =
87.6%**. Q4 is answered: **the RSI band is decisively the binding constraint.**

### Q2/Q3 — regime and capturability. Confidence HIGH.
ADX median **25.2** (p25 18.9, p75 34.1). Only **29.2%** of market-open bars are ADX<20.
**Gold is trending ~71% of the time by our own definition — so H1 is largely WRONG.** The bot is not
idle because the market is ranging.
Median H1 ATR $12.05; median H1 bar range $10.47. 12h swing amplitude: **$32.98 ranging / $46.82
trending**. A $20 stop with a 1:1 target needs a **$40 round trip**, and only **39.5%** of ranging 12h
windows even span it (2R needs $60). **H4 holds for the ranging third specifically**: in those
periods the movement the eye sees is genuinely too small for our stop geometry.

### Q5 — does widening the RSI band pay? Confidence MEDIUM. **Answer: NO, on tradeable evidence.**
Method: one wide-open pass (RSI_OS=0, BUY_MAX=100, SELL_MIN=0, RSI_OB=100) captures every signal the
rest of the logic allows, tagged with RSI; any band is reproduced exactly by post-hoc filtering.
15-min fill delay + $0.30 spread modelled — **this fills the gap Part 5 explicitly flagged as "the
largest unmodelled term", which bears directly on high-RSI entries.**

**Signal-level it looks compelling** — and is misleading. Blocked LONG buckets are all positive
(RSI 60-65 E[R] +0.348 n=138; 65-70 +0.285 n=101; **70-75 +0.880 n=60**; 75-100 +0.779 n=20), and
regime-bucketed the blocked longs are positive in *every* tercile — **+0.654 in DOWN/FLAT, where the
currently-allowed RSI<=60 longs LOSE (-0.209)**. Only 51% of blocked sumR comes from STRONG UP, i.e.
roughly proportional to its share of observations, not concentrated. That is the strongest evidence
yet against Part 5's H3 "pure bull artifact".

**Then displacement kills it.** Part 5 measured this and my signal-level sweep ignored it. Replayed
as a SEQUENTIAL BOOK (greedy, one position, 2h cooldown = what the bot does):

| cap/floor | trades | /mo | E[R] | sumR | PF | maxDD | ret/DD | TEST E[R] |
|---|---|---|---|---|---|---|---|---|
| **60/45 (live)** | 79 | **3.0** | **+0.232** | +18.3 | 1.39 | **5.1R** | 3.57 | +0.127 |
| 65/45 | 121 | 4.5 | +0.169 | +20.4 | 1.27 | 8.3R | 2.46 | +0.131 |
| 70/45 | 155 | 5.8 | +0.140 | +21.7 | 1.22 | 8.7R | 2.49 | +0.078 |
| 75/45 | 170 | 6.4 | +0.214 | +36.3 | 1.36 | 8.8R | 4.15 | +0.113 |
| 85/45 & 100/45 | 176 | 6.6 | +0.223 | +39.2 | 1.37 | 10.8R | 3.63 | +0.147 |

**Signal-level sumR 180.6 collapses to 39.2 once one-position-at-a-time is enforced — 4.6x.**
Displacement 60→75: **24 cap-60 trades lost (E[R] +0.603) to unlock 115 new ones (E[R] +0.282)**,
net +18.0R ≈ £7,800 over 26.7 months. You crowd out your *best* entries to buy more mediocre ones —
exactly Part 5's finding, reproduced independently.

**Why this is a NO:** live cap 60 has the **highest per-trade E[R] of any setting**; maxDD roughly
doubles (5.1 → 8.8–10.8R); ret/DD is **worse at 65 and 70** and only better at 75 — a non-monotone
response that smells of fitting, not signal; and TEST E[R] is flat across the whole range
(+0.127/+0.131/+0.078/+0.113/+0.147), i.e. no out-of-sample discrimination at all.
The sequential book also reproduces live frequency exactly at cap 60 (**3.0/month vs ~3 observed**),
which validates the simulation.

### Self-critique
- *I initially over-read the signal-level sweep in-session and had to walk it back.* The lesson is
  Part 5's and it repeated: **a signal-level sumR is not a tradeable number.** Record it as such.
- *My first walk-forward check claimed "both halves are bull" from endpoints (+42% / +35%).* That is
  **wrong** — it masks a real ~-17% drawdown inside the TEST half (Feb 2026 ~$4,900 → Jul 2026
  ~$4,050). Part 5's "TEST includes the 2026 downtrend" is the more careful description.
- *Remaining gap:* the greedy book takes the FIRST eligible signal; live dedup may pick differently.
  Direction of bias unknown, likely small.
- *What would change the verdict:* a cap-65+ setting that raised E[R] **and** ret/DD **and** held in
  TEST. Nothing did.

### CONCLUSION
**The bot's ~3 trades/month is by design, and the design is sound. H1 is wrong (gold trends 71% of
the time), H2 is wrong (the gates aren't mis-tuned — widening them measurably lowers per-trade edge),
H4 is right for the ranging third only.** The single binding gate is the RSI band, and the tradeable
replay says leave it alone.

**No config change. Keep `EMA_TREND_RSI_BUY_MAX=60`, `RSI_SELL_MIN=45`, `TP_RR=2.0`.**
Part 5's decision stands, now with its own flagged gap (fill delay) filled — that gap turned out to
favour *widening*, while displacement favours *holding*, and displacement is the larger term.
Combined with Part 9b (exits already sit on a plateau with a cliff below), **there is no entry or
exit lever here worth pulling.**

**The honest bottom line for the frequency complaint:** the movement is real, the bot is right to
decline most of it, and the strategy's problem is not gating — it is that the per-trade edge is
modest (~+0.23R tradeable) and the sample is small. More trades at lower edge does not fix that.

### Next
- Part 5's pre-registered gate stands: **re-run at 20 bracket-era trades** (currently 6). Do not
  re-open the RSI band before then; two independent studies now say hold.
- If frequency is ever genuinely needed, the evidence points to a **separate validated sleeve**, not
  a looser gate — but [[silver-sleeve-rejected]] closed the last such lever, and nothing here
  nominates a new one.

---

## Part 11 — Capacity: does the one-position limit cost us? And is ~3 trades/mo at PF 1.39 the ceiling? (Sep 21 2026). Script: `research_capacity.js`.

### Question
User challenge: "3 trades a month, roughly a coin toss W/L — is that the best we can do?"
Part 10 showed extra signals crowd each other out under a one-position limit. The mirror question was
never asked: **what does the limit itself cost at CURRENT entry quality?** Raising capacity adds
trades *without* lowering the entry bar — the opposite of the RSI widening that just failed.

### Framing correction (HIGH confidence, arithmetic)
"Coin toss" conflates win rate with expectancy. At 2R, break-even is **33.3%**; the backtest's
**43.5%** is the design, not a failure. A literal 50% at 2R would be PF 2.0. Judge PF and E[R].

### Method
Sweep concurrent positions × cooldown on the LIVE band. Pre-registered: interesting only if sumR
improves AND ret/DD does not degrade AND both hold in TEST. Also pre-registered: **concurrent gold
positions are ~1.0 correlated**, so N positions ≈ one N-sized position; £ risk scales linearly with N
even where R-drawdown does not.

⚠️ **First run was wrong and was discarded**: it ran the cooldown from ENTRY. Live runs it from
**CLOSE**. That mis-specified the baseline row, which every comparison hangs off. Corrected version
reproduces Part 10's live figures exactly (79 trades, +18.3R, PF 1.39, ret/DD 3.57) — sim validated.

### Findings

| pos | cool | trades | /mo | E[R] | sumR | PF | maxDD | ret/DD | TEST sumR | peak risk |
|---|---|---|---|---|---|---|---|---|---|---|
| **1** | **2h (LIVE)** | 79 | **3.0** | **+0.232** | **+18.3** | 1.39 | **5.1R** | **3.57** | **5.3** | **1R** |
| 1 | 0h / 1h / 4h | 77–81 | 3.0 | +0.186…+0.201 | +14.3…+16.3 | 1.31–1.33 | 5.1–6.5 | 2.34–3.18 | 1.4–3.3 | 1R |
| 2 | 0–4h | 101–105 | 3.9 | +0.226…+0.243 | +22.8…+24.7 | 1.38–1.41 | 7.6–9.6 | 2.48–3.25 | −0.8…1.2 | 2R |
| 3 | 0–4h | 112–116 | 4.2 | +0.291…+0.318 | +32.6…+35.6 | 1.51–1.56 | 8.2–9.2 | 3.55–4.36 | 4.1–7.1 | 3R |

**The live 2h cooldown is the best of the four at pos=1** — an incidental validation of a setting
that was tuned on much thinner evidence.

**pos=3 passes the pre-registered criteria but FAILS the outlier-robust test. — HIGH confidence.**
- The 2→3 increment is **10 trades at E[R] 1.079**, of which the **top 3 are all exactly 1.99R and
  supply 6.0R of 10.8R = 55%**.
- **Month-level paired sign test vs live: 3pos/2h beats live in 10/16 months, p=0.454. 2pos: 8/16,
  p=1.000.** Neither is significant.
- pos=2 being *worse* than both pos=1 and pos=3 is mechanically implausible and marks the whole grid
  as noise-dominated.
- Trimmed means do rise (0.212 → 0.229 → 0.309), so a real gradient may exist — but it is not
  separable from noise at this n, and the sum-based criteria I pre-registered were outlier-sensitive.
  **The sign test is the one to believe** (same reasoning as Part 9b).

**What the limit actually costs:** of 124 eligible in-session signals, 79 are taken and **45 never
are**; the missed set runs **E[R] +0.379 vs +0.232 for the taken set**. Real, but it is a selection
effect with a mechanism: signals arriving while a position is open are disproportionately
*continuation* signals inside an ongoing move. Capturing them requires holding correlated exposure.

**£ reality at 0.5% risk (~£433/R):**
| | trades/mo | expected | worst-case simultaneous |
|---|---|---|---|
| LIVE 1-pos | 3.0 | **£297/mo** | £433 |
| 3-pos | 4.2 | £577/mo | **£1,299** |

3-pos roughly doubles expected return and **triples** worst-case simultaneous loss. Since the
positions are ~1.0 correlated, one adverse gap hits all three at once — Sep 4's NFP print was −2.40R
on a *single* position ([[nfp-gap-through-stop]]); three concurrent would have been ≈ −7R.

### CONCLUSION — no change, and the convergence is itself the answer
**Keep `MAX_CONCURRENT_POSITIONS=1`, `TRADE_COOLDOWN_HOURS=2`.**

Eleven independent levers have now been tested: TP multiple (9b), 1R:1R (9/9b), RSI band (5/10),
session filter (6), leg filter (Sep-20), calendar (8), silver (4), trail variants
([[exit-config-not-the-lever]]), direction (9b), cooldown and capacity (11). **Every one returns
"no change" or "not significant."** That convergence is the finding: the binding constraint is not a
parameter, it is the strategy's own edge. **E[R] ≈ +0.23R at ~3 trades/month is what this strategy
is.** The config is at or near its optimum and that is now demonstrated from many angles, not assumed.

**The honest number: ~£297/month expected ≈ 4.1%/yr on the £87k balance** — against CLAUDE.md's
stated goal of **3–8% per MONTH**. That goal was never achievable for an edge this size; the gap is
10–20×. Worth stating plainly rather than leaving as an implicit disappointment.

**The only lever that scales returns without new edge is risk per trade** (0.5% → 1.0% ≈ doubles
expected return and drawdown together). It is **gated on the edge being real live**, which it is not
yet: backtest says +0.232R, live EMA Trend all-time is **−£1,300 over 41 trades**, bracket era is
**+£432 over 6**. Raising risk before the edge is confirmed would amplify an unproven signal.

### Next
- Nothing parametric left to test. Do not re-open any of the eleven without new live data.
- The live question is unchanged and is now the ONLY one that matters: **get to 20 bracket-era
  trades** (currently 6) and see whether live PF converges toward the backtest's 1.39 or toward the
  pre-bracket 0.72. At ~3/month that is ~Feb 2027.
- If the answer at n=20 is "edge confirmed", the decision is a risk-sizing one, not a strategy one.
  If it is "no edge", no parameter in this file will fix that and the strategy should be replaced.

---

## Part 12 — Broad strategy search under the bracket exit, with multiple-testing control (Sep 21 2026). Script: `research_strategy_search.js`.

### Question
User: "How many other strategies can we test? I don't want to leave any stone unturned." Genuinely new
ground because Part 2's cross-strategy comparison ran under the TRAIL regime, which Part 5 proved
invalidates trail-era exit conclusions; and Part 1's Q6 named **mean-reversion** but never tested it.

### Method
**Outcome matrix**: precompute, for every H1 bar × each direction, the R of a trade opened there under
the exact live bracket (fill at close+15min, stop clamp(1.5×ATR,$2,$20), resting 2R TP, no BE/trail,
M5 resolution, $0.30 spread, 120h cap). Stop sizing is ATR-based and strategy-independent, which is
what makes this valid — every strategy is then just a SELECTOR over (bar, direction), so 71 configs
cost nothing. All indicators causal; sequential book (1 position, 2h cooldown from close, session filter).

**71 configs, universe FIXED BEFORE RUNNING**: MA cross (4), Donchian (3), MACD (1), RSI-revert (3),
RSI-momentum (2), Bollinger-revert (2), Bollinger-break (1), ATR vol-break (3), Momentum/ROC (3),
revert-to-SMA (2), incumbent (1) — each × 3 regime overlays (none / ADX>20 / ADX<20).

**Snooping controls** (the real risk here, not compute): statistic is **R per month** (frequency-aware,
unlike mean-R-per-trade which flatters rare lucky runs); walk-forward TRAIN/TEST; **White's Reality
Check** — month-block bootstrap of the distribution of the MAXIMUM statistic across the whole universe
under the null; plus risk-adjustment and cost-stress, both added after I noticed the raw ranking was
unfair (see self-critique).

### Findings

**Raw R/month makes 18 of 71 look better than the incumbent, 11 in both halves.** Top: Momentum 24b
+ADX>20 (+1.94 R/mo), Donchian 40 (+1.80), Donchian 20 (+1.78), MACD (+1.51). Incumbent: +0.68.

**But they trade 12–25×/month against the incumbent's 2.9 — so they deploy 4–8× the risk.** Every top
config has a *lower* per-trade edge (E[R] +0.05…+0.17 vs incumbent **+0.232**) and a lower PF
(1.08–1.28 vs **1.39**). They win on volume, not on edge.

**Risk-adjusted (R/month ÷ maxDD), the incumbent ranks 2nd of 71:**

| rank | config | R/mo | maxDD | R/mo÷DD |
|---|---|---|---|---|
| 1 | Donchian 40 | +1.80 | 13.4R | **0.1349** |
| **2** | **EMA Trend (LIVE)** | **+0.68** | **5.1R** | **0.1324** |
| 4 | Donchian 20 | +1.78 | 13.7R | 0.1298 |
| 6 | MACD 12/26/9 | +1.51 | 13.1R | 0.1156 |
| 7 | Momentum 24b +ADX>20 | +1.94 | 19.9R | 0.0977 |

**Cost stress kills most of the field. — HIGH confidence.**

| config | $0.30 | $0.60 | $1.00 | $2.00 |
|---|---|---|---|---|
| Momentum 24b +ADX>20 | +1.94 | +1.55 | +1.04 | **−0.26** |
| Donchian 20 | +1.78 | +1.43 | +0.96 | **−0.21** |
| MACD 12/26/9 | +1.51 | +1.21 | +0.81 | **−0.19** |
| Momentum 24b | +1.49 | +1.04 | +0.46 | **−1.01** |
| Donchian 40 | +1.80 | +1.54 | +1.20 | +0.34 |
| **EMA Trend (LIVE)** | +0.68 | +0.61 | +0.53 | **+0.32** |

The incumbent keeps 47% of its edge at $2.00; the high-frequency challengers go negative. Thin edge ×
high turnover is exactly the profile that dies on costs — same failure mode as the Part 3 breakout sleeve.

**WHITE'S REALITY CHECK: p = 0.360. — HIGH confidence.**
Under the null that no config has edge, the best of 71 would still average **~1.71 R/month by chance**
and exceed 3.03 R/month 5% of the time. Observed best is 1.94. **Nothing in the search is significant
once multiple testing is accounted for.** The "18 of 71 beat the incumbent" headline is what a
71-config search produces from noise.

**The one survivor is the one we have live evidence against.** Donchian 40 survives every filter:
best risk-adjusted (by 1.9%, a tie), survives $2.00 costs, beats in both halves. But Donchian =
**the Breakout + ADX family this bot already ran live and abandoned**: backtest promised 65% WR /
+£9,901; live delivered **53 trades, 17W/36L, −£8,253** (Mar 15 reconciliation), with 48% of trades
stopped out inside 30 seconds. Part 2 flagged exactly this: the candle-close backtest "OMITS the
realtime whipsaws that made the LIVE breakout strategy fail... the backtest likely FLATTERS it."
**We have a direct, expensive, out-of-sample refutation of the only config that passed.**

And on the numbers it is not a better edge anyway: same risk-adjusted ratio, 2.6× the return, 2.6× the
drawdown. **Donchian 40 ≈ the incumbent levered up** — which is the risk-sizing lever from Part 11,
available without changing strategy at all, and gated on the same live proof.

### Self-critique
- *My first ranking was unfair and I caught it mid-run:* R/month rewards deploying more risk. DD and
  cost stress were added for that reason. Without them the search would have "found" four winners.
- *Common exit, not native exits.* Every entry is scored under the EMA bracket. Breakout families
  classically want a trailing exit, and Part 2 found trailing rescues breakout entries — so Donchian
  may be *understated* here. That path is not unexplored though: Part 3 studied the breakout-trailing
  sleeve deeply and it was rejected, and live killed it.
- *One instrument, one macro regime (26.7mo gold bull), ~27 monthly blocks.* This search cannot detect
  a modest edge, and its null distribution is correspondingly wide. Absence of a winner here is not
  proof no strategy exists.
- *Not covered, honestly:* multi-timeframe combinations, sub-H1 timeframes, cross-asset signals
  (DXY, real yields), ML/regime classification, options/vol structures. Those are different projects,
  not parameter choices.

### CONCLUSION
**No change. The stone is turned: 71 pre-registered configs across 11 strategy families, and nothing
beats the incumbent once multiple testing, risk-adjustment and costs are applied.**

The incumbent is 2nd of 71 risk-adjusted, has the **highest per-trade edge of any config tested**
(+0.232R), the **highest PF** (1.39), and is the **most cost-robust**. It was not obviously
beatable — which, after 12 research parts, is a real result rather than a null one.

This also independently reproduces Part 2's deepest finding under the NEW exit regime: entry choice
barely matters; nothing here has standalone entry edge worth switching for.

### Next
- Unchanged and now doubly-supported: **get to 20 bracket-era trades**, then decide on *risk sizing*,
  not strategy. Donchian 40 shows the shape of "more return" — it is leverage, not alpha, and you can
  buy leverage far more cheaply by raising risk on a strategy whose edge is already the best measured.
- Do NOT re-open the breakout family on a backtest number again. It has now been rejected three times
  (live 2026, Part 2 fidelity caveat, Part 12 live-refutation) and each backtest flattered it.
