# Proposal rules

These are derived from Dave's own submitted proposals, not invented. Three real
ones sit in `context/examples/` as style anchors (kept out of git — they are
sales assets and they name clients).

## Pick the shape from the posting

Dave writes in three distinct modes, and the posting decides which:

**A. The posting asks specific questions, or is long and detailed.**
Answer them in order, with the client's own numbering and headings. Long is
correct here — 600-900 words. This is the highest-effort mode and it is what
detailed, well-funded postings deserve. Open with one observation that proves
you read it, then work through their structure.

**B. The posting describes a concrete build.**
Lead with a one-line statement of what you are, then "Here's how I'd approach
your workflow:" and a staged plan — 4-6 stages, each one line, in delivery
order. Then a "Relevant example:" paragraph naming something comparable you
actually built. Then one credibility line. Then an explicit budget or rate
statement. 300-450 words.

**C. The posting is a short open-ended advisory ask.**
Four or five sentences. Who you are, what you'd help with, an invitation to a
30-minute call. Nothing more — padding a vague post makes it look like a
template. 60-120 words.

When in doubt between B and C, choose B.

## Always

- **Open with something that could only have been written after reading the
  posting.** Name their tool, their constraint, the thing they said they don't
  want. Never open with a credential or a greeting.
- **Be concrete about approach.** Stages, order, what happens first. "I'd build
  it in n8n" is worth less than "invoice ingestion → payment-status sync via
  webhooks → Sheets as the tracking layer".
- **Name the failure modes you'd guard against** — idempotency, partial states,
  error alerting. This is the single strongest differentiator against bidders
  who have only built demos.
- **Cite one real comparable thing built.** If nothing is directly comparable,
  cite the strongest real work as evidence of reliability.
- **State a rate or budget position explicitly**, and push back when the posted
  range is below what the scope warrants. Say that plainly rather than padding.
- **Close with one clear next step** — usually a short call, or a specific
  question whose answer changes the estimate.

## Never

- Never invent experience, client names, metrics, outcomes or certifications.
  If `context/profile.md` does not support a claim, leave the claim out.
- **Never leave a bracketed placeholder in the text.** A `[describe a specific
  engagement]` has gone out to a real client before. If a fact is missing, write
  around it or omit the section.
- No markdown headers or bold — Upwork renders plain text.
- No em-dash-heavy corporate voice, no lists of adjectives, no hedging.
- Never promise a timeline or price the posting doesn't support.

## Banned openers

The draft eval fails on any of these:

- "I hope this message finds you well"
- "I am excited to submit my proposal"
- "I came across your job posting"
- "I am the perfect fit for this role"
- "With over X years of experience"
- "Dear Hiring Manager"
- "I have carefully read your requirements"
- "Greetings"

## Rate note

After the proposal, output a one-line internal note (not part of the proposal)
suggesting a rate or range and the reasoning. Dave's recent hourly proposals
have been $85/hr; fixed bids have ranged $195-$7,500 by scope. Weigh his own
pricing pattern above the client's spend history — the client's numbers tell you
whether they can pay, not what he charges.
