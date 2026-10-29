# Learning Enhancement Module

## Status and precedence
- This module is ADDITIVE. It does not replace any rule above it in CLAUDE.md.
- If anything here conflicts with an existing rule, the existing rule wins.
  Stop, describe the conflict to me, and wait for my decision.
- Current phase is set in section 5. Only the human (me) changes the phase.

## 1. Purpose
Reduce losing trades by learning which signals tend to win after costs, and
skipping the ones that don't. The bot's existing strategy still decides WHAT to
trade and in which direction. The learning layer only estimates whether a
specific signal is likely to win, so it can filter.

## 2. Data capture (Phase 0, do this first)
- Every signal considered must be logged, including skipped ones, with:
  features known at signal time, taken (0/1), skip_reason, and outcome after costs.
- Features must be knowable at signal time. Never use data from after the signal.
- If a feature is missing from the ledger, report it. Do not invent values.

## 3. The learning model
- Label: win = 1 if net P&L after fees and slippage > 0, otherwise 0.
- Model: keep it simple (shallow gradient-boosted trees or logistic regression).
  Do not add complexity without evidence it helps out-of-sample.
- Retrain on a rolling window. Never shuffle data randomly across time.
- Output per signal: p_win, the estimated probability of a winning trade.

## 4. Testing, mandatory before any promotion
- Walk-forward testing only (train on past, test on the next unseen period).
- Compare against the unfiltered baseline on the SAME out-of-sample period.
- Minimum 200 out-of-sample trades that the filter would have taken. Fewer means
  the result is inconclusive; say so.
- Report net-of-cost results, the number of trades, and the confidence level.

## 5. Phases (only I can move between phases)
- Phase 0: data capture only. No model, no effect on trading.
- Phase 1: SHADOW MODE. Train and score signals, log p_win and what the filter
  WOULD have done. The live bot's trading is unchanged.
- Phase 2: FILTER, with approval. Requires: Phase 1 shows a clear out-of-sample
  improvement over at least 200 trades, and I approve in this chat.
  Use a conservative threshold (start at 0.6 or higher).
- Phase 3: Not authorised. Any further automation needs a separate discussion.

Current phase: 0

## 6. Hard limits
- Never move to Phase 2 without my explicit approval in this chat.
- Never deploy a model that has not been tested out-of-sample.
- Never retrain and redeploy automatically. Retraining produces a candidate
  for review, not a live change.
- If the filter's out-of-sample result is worse than or equal to baseline, say so
  clearly and recommend against promotion.

## 7. Reporting
Add a learning section to each daily review:
- Phase, model version and training window
- Signals scored, and how many the filter would have skipped
- Out-of-sample comparison (filtered vs baseline), with trade counts
- Drift warnings: is the model's hit rate on recent data far from its test result?
- Limitations: sample size, regime changes, any suspected look-ahead bias

## 8. Stop conditions
Pause the learning layer and report to me if:
- The filter's live shadow results diverge sharply from its test results
- Feature values look out of range or missing for many signals
- Any error appears in the training or scoring pipeline
