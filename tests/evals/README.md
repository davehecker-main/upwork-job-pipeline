# Scoring evals

`jobs.jsonl` is the labelled set the scoring prompt is graded against. One JSON
object per line:

```json
{"id":"…","expected":"qualify|reject","job":{…normalized-job fields…},"note":"why"}
```

**The seed set is synthetic.** It was written to cover the rubric's decision
boundaries — strong client / weak fit, weak client / strong fit, placeholder
budgets, scam patterns, adjacent-but-wrong work — so the prompt can be graded
before a single real job has been labelled. It is *not* evidence about real
Upwork traffic.

**Replace it as real data arrives.** Every job that gets a Slack card is a
labelling opportunity: if the score disagreed with your own read, append the job
with the verdict you'd have given. At ~20 real labelled jobs the seed rows have
served their purpose and should be deleted. Keep a `source` field of `real` or
`synthetic` on each row so `run-eval.mjs --real-only` can show you the score on
real data alone.

Grading rules live in `scripts/run-eval.mjs`:
- `qualify` is correct if the score is at or above `SCORE_THRESHOLD`.
- `reject` is correct if it is below.
- `maybe` rows are excluded from accuracy and reported separately — they are the
  boundary cases where either answer is defensible.
- **False negatives are the expensive error** (a missed paying job), so they are
  reported separately and gate the run.
