# Setup artifacts

## `slack-app-manifest.json`

Paste at `api.slack.com/apps` → **Create New App → From an app manifest** →
pick the workspace → paste → Create → **Install to Workspace**.

Updating an existing app: **App Manifest** in the left sidebar → paste → Save →
then **OAuth & Permissions → Reinstall to Workspace** (Slack does not apply new
scopes until you reinstall).

Scopes and why each is there:

- `chat:write`, `chat:write.public` — post the job card and the draft thread.
- `channels:read` — resolve channel names to the `C…` ids the scripts need.
- `channels:history` — read the posted cards back, which is how the approval
  loop finds which jobs you marked.
- `reactions:read` — **the approval signal.** You react ✅ on a card and the
  next run drafts a proposal for it. This replaces the paused-workflow button
  gate, and needs no public webhook, no interactivity endpoint, and no
  always-on server.
- `files:write` — for a draft long enough that Slack would truncate a plain
  message.

Deliberately absent: `im:write` and `users:read`. Nothing here needs to DM you
or enumerate members.

## A gotcha worth knowing

`scripts/setup-slack.mjs` creates the two channels through the API, which makes
the **bot** their creator and only member — you are not added automatically, so
they will not appear in your sidebar and you get no notification. Join them once
by hand (Cmd+K → `upwork-jobs`), or the cards will pile up unseen.
