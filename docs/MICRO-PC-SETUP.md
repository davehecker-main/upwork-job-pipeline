# Running the pipeline on the 24/7 micro PC

The pipeline needs one always-on machine with Claude Code authenticated, because
discovery shells out to `claude -p` and the Upwork MCP token lives in that
machine's credential store. Nothing else about the code changes.

Two routes. **WSL is strongly preferred** — cron, paths, and the shell scripts
all work exactly as they do on the Mac, and everything below is copy-paste.
Native Windows works but needs Task Scheduler and path adjustments.

---

## Route A — WSL (recommended)

### 1. Install WSL, if it isn't there

In PowerShell **as Administrator**:

```powershell
wsl --install -d Ubuntu
```

Reboot if prompted, then open **Ubuntu** from the Start menu and create a user.

### 2. Node and Claude Code

```bash
sudo apt update && sudo apt install -y curl git
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v            # expect v22 or newer; this project needs >=20
npm i -g @anthropic-ai/claude-code
```

### 3. Authenticate Claude Code

```bash
claude
```

Follow the login prompt in the browser it opens. This is the same account you
use on the Mac.

### 4. Connect the Upwork MCP

```bash
claude mcp add --scope user --transport http upwork https://mcp.upwork.com/mcp
claude          # then inside: /mcp -> upwork -> Authenticate
```

Authorize in the browser as the Upwork account you bid from. Confirm with:

```bash
claude mcp list      # upwork should say "✔ Connected"
```

### 5. The repo

```bash
git clone https://github.com/davehecker-main/upwork-job-pipeline.git
cd upwork-job-pipeline
npm install
```

Copy `.env` across from the Mac — it is gitignored, so it does not come with the
clone. Easiest is to open it on the Mac and retype/paste the six values:

```
ANTHROPIC_API_KEY=
UPWORK_ORG_UID=
SLACK_BOT_TOKEN=
SLACK_CHANNEL=
SLACK_TEST_CHANNEL=
```

Then prove all of it works before scheduling anything:

```bash
npm run verify       # real call against Anthropic, Slack and the Upwork MCP
./test.sh            # 82 tests, no network needed
node scripts/poll.mjs   # dry run: discovers and scores, posts nothing
```

`npm run verify` must show the Upwork MCP as connected. If it says "not
authenticated", step 4 did not complete.

### 6. Schedule it

```bash
crontab -e
```

```cron
*/20 * * * * cd ~/upwork-job-pipeline && /usr/bin/node scripts/poll.mjs --post >> /tmp/upwork-poll.log 2>&1
15   * * * * cd ~/upwork-job-pipeline && /usr/bin/node scripts/check-approvals.mjs >> /tmp/upwork-approvals.log 2>&1
```

Use `which node` to confirm the path. Cron gets a minimal environment, so an
absolute path matters.

**WSL caveat that will bite you:** WSL does not run cron on boot by default, and
it shuts down when no session is open. Fix both:

```bash
sudo systemctl enable cron        # if systemd is enabled in your WSL
```

Add to `/etc/wsl.conf`:

```ini
[boot]
systemd=true
command="service cron start"
```

Then from PowerShell, keep WSL alive at boot by adding a Task Scheduler task
running `wsl.exe -d Ubuntu -e true` at startup — that is enough to start the
distro so cron runs.

---

## Route B — Native Windows

Install Node from nodejs.org, then `npm i -g @anthropic-ai/claude-code`, and run
steps 3-5 above in PowerShell (the commands are identical). For scheduling use
**Task Scheduler**: create a task, trigger "daily, repeat every 20 minutes for
1 day", action `node.exe` with arguments `C:\path\to\scripts\poll.mjs --post`
and "Start in" set to the repo directory. Add a second task hourly for
`check-approvals.mjs`. Set both to "Run whether user is logged on or not".

---

## Verifying it is really live

After the first scheduled run fires:

```bash
tail -20 /tmp/upwork-poll.log
```

Expect a search line per query, a count of new jobs, scores, and either posted
cards or "nothing to post". Then check `#upwork-jobs` in Slack.

The failure you should actually expect eventually is the MCP token expiring. It
looks like every search failing at once, and `poll.mjs` exits non-zero saying
so. The fix is to run `claude` interactively on that machine and re-authenticate
with `/mcp`.

## Turning the Mac off

Once the micro PC is running, remove the cron entries on the Mac so the two
hosts do not both post cards. They share no state, so both running means
duplicate cards for the same jobs.
