# Parser fixtures

**Every file here is SYNTHETIC.** They were written to the shape of a Vollna
alert, not captured from one. They exercise the parser's control flow, but they
do not prove the field patterns match Vollna's real template.

**Phase 0 task, before trusting a single score:** save a real Vollna alert
(Gmail → ⋮ → Show original → copy the HTML part) as
`real-01.html`, add a matching expectation to `parse-vollna.test.js`, and retune
`FIELD_PATTERNS` in `src/parse-vollna.js` until it passes. Then delete this
paragraph.
