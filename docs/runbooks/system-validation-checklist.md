# Argus — System Validation Checklist

The end-to-end validation plan for Argus. Walk this top-to-bottom on a fresh
Mac to take Argus from "code-complete" to "operational." Each step lists the
manual action, the expected outcome, and what to do if it fails.

This consolidates the deferred manual tasks from Phases A, B, and C into one
linear playbook. Allow ~half a day for the full pass on day one. Subsequent
re-runs after rebuilds should take ~1 hour.

---

## Pre-flight

- [ ] You're on macOS (Sequoia/Tahoe), admin user.
- [ ] Homebrew is installed (`brew --version` succeeds).
- [ ] You have a Claude Max20 subscription active.
- [ ] You have admin access to a Discord account.
- [ ] You have admin access to a Telegram account.
- [ ] You own (or can use) a domain name with Cloudflare DNS access (for the Telegram webhook tunnel).
- [ ] You have an Anthropic API key ready (only needed if you'll exercise API mode).
- [ ] The Argus repo is cloned and you're at the latest `main` commit.

```bash
cd ~/work/projects/argus
git status      # clean
git log -1      # at the most recent main commit
```

---

## Block 0 — Fresh-clone bootstrap

Each Bun subproject's `node_modules/` is gitignored. Populate them before tests can run:

```bash
for d in scripts/*/; do (cd "$d" && [[ -f package.json ]] && bun install); done
cd skills/argus-router && bun install && cd -
```

Verify all subprojects are test-clean:

```bash
for d in scripts/{telegram-bridge,cost-tracker,watchdog,recovery,knowledge} skills/argus-router; do
  echo "=== $d ===" && (cd "$d" && bun test 2>&1 | tail -3)
done
```

Expected: 427 tests pass / 0 fail across all six subprojects.

---

## Block A — Phase A operator validation (install + Discord + smoke)

Reference: `docs/plans/2026-05-03-phase-a-baseline.md`. Run the deferred Tasks 6, 10, 11, 12.

### A.1 — Discord webhook (Phase A Task 6)

- [ ] Create a Discord server (or use an existing one). Suggested name: `argus-runs`.
- [ ] Create text channels: `#runs-info` (Phase A), `#runs-warn` (Phase B+).
- [ ] For `#runs-info`: right-click → Edit Channel → Integrations → Webhooks → New Webhook → name `argus-clawhip` → Copy Webhook URL.
- [ ] Create the secrets dir + add the URL:

```bash
mkdir -p ~/.argus && chmod 700 ~/.argus
cat > ~/.argus/secrets.env <<'EOF'
CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO="https://discord.com/api/webhooks/REPLACE_WITH_REAL"
EOF
chmod 600 ~/.argus/secrets.env
```

- [ ] Edit the file to paste the real webhook URL.
- [ ] Smoke-test the webhook directly:

```bash
source ~/.argus/secrets.env
curl -fsS -X POST -H "Content-Type: application/json" \
  -d '{"content":"argus pre-flight from validation playbook"}' \
  "$CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO"
echo
```

Expected: HTTP 204 No Content. Message visible in `#runs-info` within 1 second.

### A.2 — Run install-mac.sh (Phase A Tasks 2, 3, 4, 5, 7, 8 + Phase B Task 2 + Phase C Blocks 1-5)

```bash
cd ~/work/projects/argus
./scripts/install-mac.sh
```

This runs all `section_*` functions in order. Expect ~5 minutes on first run (cargo install clawhip dominates). Re-runs are no-ops (~2 seconds).

After it completes, run the OMC interactive setup:

```bash
omc setup       # log in to your Claude Max20 account in the browser
omc doctor      # all green
```

If `omc doctor` shows anything red, investigate (most likely: tmux missing — re-run install).

### A.3 — Start daemons (Phase A Task 10)

```bash
launchctl load ~/Library/LaunchAgents/com.argus.clawhip.plist
launchctl load ~/Library/LaunchAgents/com.argus.omc-wait.plist
launchctl list | grep com.argus
```

Expected: both labels show with non-`-` PID. If `-`, check `~/.argus/logs/{clawhip,omc-wait}.err.log`.

### A.4 — Phase A smoke test (Phase A Task 11)

Create a throwaway test repo and submit a small directive:

```bash
mkdir -p ~/work/argus-smoke && cd ~/work/argus-smoke
git init -q -b main
echo "# Argus smoke" > README.md && git add . && git commit -q -m init

omc team --billing=max20 "Build a small CLI todo app in TypeScript with add/list/done/delete commands and vitest tests. Single-file is fine."
```

Watch `#runs-info` for `git.commit`, `agent.*`, `session.*` events appearing within 60 seconds.

Walk away for at least 2 hours. Expected end state:
- `git log` in the test repo shows ≥5 commits.
- `npx tsc --noEmit` clean.
- `npx vitest run` shows passing tests.
- Discord channel has full event trail.

If the run produces a working todo app: **Phase A PASS**. Update `docs/runbooks/phase-a-baseline.md` "Findings" section with timing + observations.

If the run hangs or produces broken code: dig into `~/.argus/logs/`, OMC's `.omc/` directory, and the tmux sessions. Most likely cause is OMC config drift; re-run `omc doctor`.

---

## Block B — Phase B operator validation (gates + Telegram)

Reference: `docs/plans/2026-05-03-phase-b-gates-and-telegram.md`. Run the deferred Tasks 1, 11, 15, 16.

### B.1 — Telegram bot creation (Phase B Task 1)

- [ ] Open Telegram, message **@BotFather** → `/newbot` → name `argus-bot` (or your choice) → username ending in `bot`. Copy the token (e.g., `7891234567:AAH...`).
- [ ] Create three private group chats: `argus-gates`, `argus-page`, `argus-critical`. Add the bot to each.
- [ ] For each chat, send `/start` from your account, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find the `chat.id`. Group IDs are negative integers.
- [ ] Set a webhook secret token (random 64 chars):

```bash
WEBHOOK_SECRET=$(openssl rand -hex 32)
echo "TELEGRAM_WEBHOOK_SECRET=\"$WEBHOOK_SECRET\""
```

- [ ] Append to `~/.argus/secrets.env`:

```bash
cat >> ~/.argus/secrets.env <<EOF
TELEGRAM_BOT_TOKEN="REPLACE_WITH_REAL"
TELEGRAM_CHAT_ID_INFO="-1001111111111"
TELEGRAM_CHAT_ID_WARN="-1002222222222"
TELEGRAM_CHAT_ID_PAGE="-1003333333333"
TELEGRAM_CHAT_ID_CRITICAL="-1004444444444"
TELEGRAM_CHAT_ID_GATES="-1005555555555"
TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET"
EOF
chmod 600 ~/.argus/secrets.env
```

- [ ] Edit the file to paste the real bot token + real chat IDs.
- [ ] Verify bot can post:

```bash
source ~/.argus/secrets.env
curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID_GATES}" \
  -d "text=argus pre-flight from validation playbook"
echo
```

Expected: JSON `"ok": true`, message visible in `#argus-gates`.

### B.2 — Cloudflare Tunnel (Phase B Task 11)

```bash
ARGUS_TUNNEL_HOSTNAME=argus-bridge.<your-domain>.com ./scripts/install-cloudflared.sh
```

Follow the interactive prompts: `cloudflared tunnel login` opens a browser, you authorize the domain. The script then creates the tunnel, writes `~/.cloudflared/config.yml`, and appends `ARGUS_TUNNEL_ID=...` to `~/.argus/secrets.env`.

Re-run `./scripts/install-mac.sh` so `section_cloudflared` and `section_bridge` install their plists now that the tunnel exists.

### B.3 — Start the bridge + tunnel + watchdog + recovery daemons

```bash
launchctl load ~/Library/LaunchAgents/com.argus.telegram-bridge.plist
launchctl load ~/Library/LaunchAgents/com.argus.cloudflared.plist
launchctl load ~/Library/LaunchAgents/com.argus.watchdog.plist
launchctl load ~/Library/LaunchAgents/com.argus.recovery.plist
launchctl list | grep com.argus
```

Expected: 6 running daemons (clawhip, omc-wait, telegram-bridge, cloudflared, watchdog, recovery), all with non-`-` PIDs.

Health checks:

```bash
curl -fsS http://127.0.0.1:25294/status   # clawhip
curl -fsS http://127.0.0.1:9501/health    # bridge
curl -fsS http://127.0.0.1:9601/healthz   # recovery
```

All three should return `200 OK` with a JSON status.

### B.4 — Register the Telegram webhook

```bash
source ~/.argus/secrets.env
TUNNEL_URL="https://argus-bridge.<your-domain>.com"

curl -fsS -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=${TUNNEL_URL}/telegram" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
echo
```

Expected: JSON `"ok": true`. Verify with `curl https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo` — `url` should match.

### B.5 — Synthetic gate-flow test (before a real run)

Test BOTH dual-emission paths independently per the Phase B aggregate review's Issue 1.

**Path 1 — file watcher:**

```bash
mkdir -p "$OMC_STATE_DIR/gates"
cat > "$OMC_STATE_DIR/gates/gate-test-fwatch.pending.json" <<EOF
{
  "gate_id": "gate-test-fwatch",
  "run_id": "run-test-fwatch",
  "type": "PRD",
  "title": "Synthetic file-watcher gate",
  "summary": "This gate was written to disk to test the gate-watcher path.",
  "key_decisions": ["test decision 1", "test decision 2"],
  "artifact_path": "/tmp/test-prd.md",
  "created_at": "$(date -u +%FT%TZ)",
  "timeout_at": "$(date -u -v+8H +%FT%TZ 2>/dev/null || date -u -d '+8 hours' +%FT%TZ)"
}
EOF
```

Within ~10 seconds, a gate message should appear in `#argus-gates` Telegram chat.

**Path 2 — clawhip webhook:**

```bash
clawhip send \
  --event gate.pending \
  --severity info \
  --message "Synthetic webhook gate" \
  --webhook-payload '{"event_id":"gate.pending:gate-test-webhook","gate_id":"gate-test-webhook","run_id":"run-test-webhook","summary":"This gate was emitted via clawhip to test the HTTP path.","artifact_path":"/tmp/test-prd-2.md","timeout_at":"2026-12-31T00:00:00Z","key_decisions":["webhook test"]}'
```

Within ~10 seconds, a second gate message should appear in `#argus-gates`.

If either path fails to deliver, inspect `~/.argus/logs/telegram-bridge.{out,err}.log` and the queue: `sqlite3 ~/.argus/state/bridge-queue.sqlite 'SELECT * FROM outbound; SELECT * FROM parking_lot;'`.

**Approve both gates from your phone** (tap ✅ Approve). Verify each produces `<gate-id>.decision.json` in `$OMC_STATE_DIR/gates/`.

### B.6 — Phase B 24h smoke (Phase B Tasks 15, 16)

Submit a longer greenfield directive that will hit the gate model:

```bash
cd ~/work/argus-smoke    # or a new test repo
omc team --billing=max20 "Build a small Express API with /users (CRUD) endpoints, Prisma+SQLite for persistence, vitest tests, and a README. Use a PRD gate at the planning phase, single PR at the end."
```

Walk away. Expected interactions:
- ~30-90 min in: Telegram message in `#argus-gates` with the PRD. Approve from phone.
- ~12-24h later: GitHub PR created. Telegram notifies. Review on GitHub mobile, approve PR.
- Run completes; final Telegram notification.

Capture in `docs/runbooks/phase-b-gates.md` Findings section: gate latency, approval friction, anything that broke.

If smoke passes: **Phase B PASS**.

---

## Block C — Phase C operator validation (cost + watchdog + recovery + knowledge)

Reference: `docs/plans/2026-05-03-phase-c-hardening.md`, `docs/runbooks/chaos-suite.md`. Run the deferred Block 6 tasks.

### C.1 — Cost tracker live test (Block 1 Task 1.3)

Set a tight cost ceiling on a small API run:

```bash
export ANTHROPIC_API_KEY="<your-key>"
cd ~/work/argus-smoke

omc team --billing=api --ceiling=0.50 "Refactor the User model to use a UUID primary key instead of auto-increment integer."
```

Watch `~/.argus/state/cost-tracker.sqlite`:

```bash
sqlite3 ~/.argus/state/cost-tracker.sqlite 'SELECT run_id, ceiling_eur, spent_eur, warn_emitted, page_emitted, kill_emitted FROM runs ORDER BY last_update DESC LIMIT 5;'
```

Expected progression as the run proceeds:
- spent_eur increases.
- At ~€0.375 (75%), `cost.warn` event fires → Discord notification.
- At ~€0.50 (100%), `cost.page` event fires → Telegram notification, OMC pauses.
- At ~€0.55 (110%) IF the run somehow continues past pause, `cost.kill` fires + OMC cancels.

If thresholds don't trigger: check the hook is registered (`grep -A 2 "cost-tracker-hook" ~/.claude/settings.json`), check the model→tier mapping fits the model name being used, check pricing.toml has values for that tier.

If thresholds trigger correctly: **Block 1 PASS**.

### C.2 — Watchdog chaos tests (Block 2 Task 2.3)

For each scenario, you should see auto-recovery in `~/.argus/logs/watchdog.{out,err}.log` and a Discord/Telegram notification.

**Scenario: kill clawhip**

```bash
pkill -9 clawhip
# Wait 60-90s
launchctl list | grep com.argus.clawhip   # PID should be different (restarted)
tail -20 ~/.argus/logs/watchdog.err.log
```

Expected: watchdog detects within 60s, calls `launchctl kickstart`, clawhip respawns. WARN notification in Discord.

**Scenario: orphan the binary (forces dead-man's-switch)**

```bash
sudo mv "$(command -v clawhip)" /tmp/clawhip-orphan
pkill -9 clawhip
# Wait 90s
```

Expected: watchdog cannot restart (binary missing). After 2 consecutive failed restarts within cooldown, dead-man's-switch fires via OMC native callback. CRITICAL notification in Telegram `#argus-critical`.

Restore:

```bash
sudo mv /tmp/clawhip-orphan "$(brew --prefix)/bin/clawhip" 2>/dev/null || \
  sudo mv /tmp/clawhip-orphan ~/.cargo/bin/clawhip
```

**Scenario: kill bridge**

```bash
pkill -9 -f "scripts/telegram-bridge/src/index.ts"
# Wait 60-90s
curl -fsS http://127.0.0.1:9501/health   # should respond again after restart
```

Document outcomes in `docs/runbooks/phase-c-hardening.md`.

If all 6 scenarios from `chaos-suite.md` pass: **Block 2/3 PASS**.

### C.3 — 72h continuous-run dry test (Block 6 Task 6.2)

Submit a long-arc, low-stakes directive:

```bash
cd ~/work/argus-smoke
omc team --billing=max20 "ralph: keep producing improvements to the existing CLI todo app for 72 hours. Add features, refactor, improve tests, write docs. Generate hourly digests."
```

Expectations during 72h:
- Continuous Discord activity (no >2h silence except during rate-limit pauses).
- Cost-tracker writes growing (in API mode) but not hitting ceilings.
- Watchdog ticks logged every 30s; no escalations.
- /learner produces ≥3 new skills under `.omc/skills/` (project) and `~/.omc/skills/` (user).
- Notepad-cap fires at least once if notepad accrues; archived to `runs/<id>/notepads/archive/`.
- No daemon crashes, no log file > 100 MB, no sqlite > 50 MB.

Capture daily snapshots:

```bash
du -sh ~/.argus/logs ~/.argus/state ~/.claude/omc/runs
sqlite3 ~/.argus/state/bridge-queue.sqlite 'SELECT COUNT(*) FROM outbound, parking_lot;'
sqlite3 ~/.argus/state/cost-tracker.sqlite 'SELECT * FROM runs;'
```

If 72h completes without silent failures: **Phase C PASS**.

### C.4 — First migration smoke (Block 6 Task 6.1) — optional

If you want to exercise the C-flow (harness as task zero):

```bash
omc team --billing=max20 "Migration: rename all references to 'oldFoo' to 'newFoo' across this codebase. Keep behavior identical. Build a shadow-comparison harness as task zero (gates 0a + 0b), then a migration PRD (gate 1), then first batch eyes-on (gate 2), then fan-out auto-merge for remaining batches (no human gate unless harness flags), then final integration PR (gate 3)."
```

Expected gates: 0a (Telegram), 0b (GitHub PR for harness), 1 (Telegram), 2 (GitHub PR first batch), 3 (GitHub PR final). Total ~3-5 days.

This is OPTIONAL for "operational" status — the rename refactor is contrived. Save migration validation for an actual real-world need.

---

## Block D — Phase D production rollout

Reference: `docs/plans/2026-05-03-phase-d-production.md`. The first real workload.

After Blocks A, B, C all PASS:

### D.1 — First real workload

- [ ] Choose a workload from the decision matrix in `docs/plans/2026-05-03-phase-d-production.md` Task 1. For first time, prefer a small greenfield (≤1 day) or a tiny migration on a test repo.
- [ ] Write a 1-paragraph problem statement. Save to `~/.claude/omc/runs/argus-first-real.brief.md`.
- [ ] Run the Phase D pre-flight checklist (top of `2026-05-03-phase-d-production.md`).
- [ ] Submit:

```bash
cd <target-repo>
omc team --billing=max20 "$(cat ~/.claude/omc/runs/argus-first-real.brief.md)"
```

- [ ] Babysit the first 30 minutes (Phase D Task 2).
- [ ] Approve gate 1 from phone.
- [ ] Apply intervention discipline (Phase D Task 4 — read-only, no live edits).
- [ ] Approve final PR.
- [ ] Run the Phase D post-run retro (Task 6).

### D.2 — Iterate before workload #2

Per Phase D Task 7: address the highest-friction item from the retro before submitting the next real workload.

### D.3 — Promotion to "Argus operational"

Per Phase D Task 8: after ≥3 real workloads, ≥1 unattended overnight, and confidence in 5/6 promotion criteria, write `docs/runbooks/argus-operational.md` declaring promotion.

---

## VPS migration (optional, post-operational)

Once Argus is operational on Mac and you want to move to Hetzner:

1. Provision a CX32 in the Hetzner Cloud panel; add your SSH key via cloud-init.
2. Edit `ansible/inventory/hosts.yml.example` → copy to `ansible/inventory/hosts.yml`, fill `ansible_host` with the VPS IP.
3. Edit `ansible/inventory/group_vars/argus_vps.yml.example` → copy + fill non-secret values.
4. Edit `ansible/inventory/group_vars/argus_vps.vault.yml.example` → copy, fill secrets, encrypt with `ansible-vault encrypt argus_vps.vault.yml`.
5. Run the bootstrap playbook (root-as):

```bash
cd ansible
ansible-galaxy install -r requirements.yml
ansible-playbook -i inventory/hosts.yml playbooks/00-bootstrap.yml
```

6. Run the stack playbook (argus-as, with vault password):

```bash
ansible-playbook -i inventory/hosts.yml playbooks/10-stack.yml --ask-vault-pass
```

7. Verify health:

```bash
ansible-playbook -i inventory/hosts.yml playbooks/99-verify.yml
```

8. When ready, run the cutover (this stops Mac daemons + rsyncs + starts VPS):

```bash
ansible-playbook -i inventory/hosts.yml playbooks/20-cutover.yml -e argus_cutover_phase=all --ask-vault-pass
```

9. Update Telegram webhook URL to the VPS public domain. Update GitHub webhooks (if any) similarly.

10. Capture cutover wall-clock + any rough edges in `docs/runbooks/phase-c-hardening.md`.

---

## Promotion criteria summary

Argus is **operational** when:

- [ ] Block A PASS (Phase A Discord + smoke).
- [ ] Block B PASS (Phase B Telegram + 24h smoke + dual-path gate test).
- [ ] Block C PASS (Phase C cost + chaos + 72h dry).
- [ ] Block D ≥3 real workloads completed.
- [ ] ≥1 unattended overnight run (sleep through, wake to "done" or "blocked", system was running cleanly).
- [ ] You can articulate the failure modes you no longer worry about.

---

## When something breaks

Apply systematic-debugging discipline:

1. **Stop**. Don't keep typing commands.
2. **Read the error** fully. Don't skim.
3. **Check the runbook** — has this happened in an earlier block?
4. **Form a single hypothesis**, test it, document the result.
5. **If you can't fix it in 15 minutes**, capture state in the runbook and stop. Come back rested. Most "blockers" dissolve after a sleep.

The system has many escape hatches:

- `omc cancel <run-id> --keep-state` — graceful stop, state preserved for forensics.
- `omc pause <run-id>` — stop at next safe boundary; resume later.
- `launchctl unload ~/Library/LaunchAgents/com.argus.*.plist` — full stop.
- `sqlite3 ~/.argus/state/<db> .schema` — inspect any state.
- `tail -f ~/.argus/logs/*.{out,err}.log` — watch what's happening.

When in doubt: stop the run, kill the daemons, sleep on it. The git commits are durable. The state files are recoverable. Nothing is on fire.
