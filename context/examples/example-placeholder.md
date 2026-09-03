<!-- PLACEHOLDER. Replace with a real proposal that got a reply. -->

You mentioned the Airtable base is already the source of truth and the problem
is the manual copy into QuickBooks every Friday. That is the part worth
automating first, and it is a small job.

I would build it in n8n: a scheduled trigger reads the new Airtable rows, maps
them to QuickBooks invoice objects, and posts them through the QuickBooks API.
Two things matter more than the happy path — idempotency, so a re-run cannot
double-invoice, and a Slack message on any failure so a silent break does not
cost you a week. I would also log every synced row so you can reconcile.

I have spent 25 years building systems where the reconciliation step is the one
that actually matters, most recently running engineering as a CTO.

One question before I quote: are the QuickBooks customers already matched to
Airtable records by ID, or does the mapping need to be built too? That answer
changes the estimate more than anything else in the posting.
