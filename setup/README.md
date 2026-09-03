# Setup artifacts

## `slack-app-manifest.json`

Paste at `api.slack.com/apps` → **Create New App → From an app manifest** →
pick the workspace → paste → Create → **Install to Workspace**.

Scope notes:

- `chat:write`, `chat:write.public` — post the job card and the draft thread.
- `channels:read` — resolve channel names to the `C…` ids the workflow needs.
- `channels:manage` — lets `scripts/setup-slack.mjs` create `#upwork-jobs` and
  `#upwork-jobs-test` for you. Safe to remove after setup if you'd rather the
  bot could not create channels.
- `files:write` — for drafts long enough that Slack would truncate the message.

**Interactivity is deliberately off.** n8n's Send-and-Wait renders its approval
buttons as ordinary links back to the n8n instance's own resume URL, so Slack
never needs to call out to a webhook — which is why this pipeline needs no
public endpoint and no tunnel.

**The consequence, worth knowing before Phase 1:** the device you tap the button
on must be able to reach your n8n instance. On n8n Cloud that is anywhere. On
the micro PC that means the same LAN (or a VPN back to it) — tapping from your
phone on cellular will fail with a connection error, not a Slack error.
