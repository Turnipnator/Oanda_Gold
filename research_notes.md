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
