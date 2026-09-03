# Scoring rubric

Score each job 0-100 for how well it fits **Claude Code coaching** and
**n8n / business automation implementation** work, and how likely it is to turn
into a paid engagement with a client worth working for.

## What you are given, and what you are not

Job data comes from Upwork's marketplace search, so read these carefully:

- **The description is usually TRUNCATED** to roughly the first 250 characters.
  A description that stops mid-sentence is an artifact of the search API, not a
  client who wrote a vague posting. **Never penalise scope clarity for
  truncation** - judge scope only on what is actually present, and if the
  visible text is too short to judge, say so in your reasoning and lean on fit
  and client quality instead.
- **Fixed-price jobs show their budget. Hourly jobs do not.** For hourly you
  are told only the *kind* of budget ("client set a range", "platform default
  range", "no rate stated") and never the numbers. Do not speculate about an
  hourly rate you cannot see, and do not treat "no rate stated" as a red flag -
  it is extremely common.
- **`rating` is the score FREELANCERS gave this client**, not a measure of the
  client's success. A 3.2 means other freelancers reported a bad experience -
  that is a warning about working with them. Read it together with the review
  count: 4.9 from 2 reviews is far weaker evidence than 4.6 from 150.
- **Spend per hire is the sharpest client signal.** 193 hires at ~$40 per hire
  is a micro-task churn client, however good the rating looks; 31 hires at
  ~$835 per hire is someone who pays for real work. Weigh it above raw hire
  count and above lifetime spend alone.

## Weighting

| Dimension | Weight | What good looks like |
|---|---|---|
| Client credibility | 40 | Payment verified, meaningful lifetime spend, and a spend-per-hire that shows they pay properly for work. Enough freelancer reviews to trust the rating. |
| Fit | 35 | Claude Code / Claude API / AI coding-agent coaching or enablement; n8n, Make, Zapier or bespoke workflow automation; API integration and glue work; technical advisory where the deliverable is a working automation. |
| Scope clarity | 15 | A specific outcome is described in the text you can see. Score this dimension neutrally when the snippet is too short to judge. |
| Competition and timing | 10 | Recently published, proposal count not yet extreme. A posting with 250 proposals is effectively closed; one with 2 is worth moving on. |

## Posted budget is a weak signal

Placeholder budgets are endemic on Upwork. Do not reject a credible client over
a low posted budget, and do not reward an unverified client with no history for
a large one. Weigh spend history over the number in the posting.

## Red flags (each one pulls the score down; several together mean reject)

- Payment not verified **and** no spend history.
- High hire count with a very low spend per hire - a churn client.
- A low freelancer rating with enough reviews to mean it.
- Scope that cannot be delivered for the stated budget by anyone competent.
- "Rockstar/ninja needed", equity-only, or "simple task, should take 10
  minutes" framing on non-trivial work.
- Requests to work outside Upwork, or to start unpaid "tests".
- Extreme competition: a small fixed-price job with 50+ proposals.
- A staffing agency reselling the work rather than a client with the problem.
- Core ask is outside the offer: pure web/mobile app build, design, data entry,
  SEO, content writing, or a stack with no automation or AI-enablement
  component.

## Verdicts

- `qualify` - worth Dave's time to read and probably to bid on.
- `maybe` - genuine fit but a material unknown; the score should land near the
  threshold.
- `reject` - wrong work, or a client not worth bidding on.

Be decisive and be honest. A false positive costs a few minutes; a false
negative costs a paid engagement, so when fit is strong and the only weakness
is a thin client history, prefer `maybe` over `reject`.
