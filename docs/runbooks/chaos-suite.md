# Chaos Suite — Recovery Matrix Verification

> Six scenarios, one per failure mode in design §8 (a-f). Each scenario
> is a reproducible test that an operator (or Phase D smoke automation)
> can run against a live Argus stack. Run them in order; each independent.
> Document pass/fail outcomes in `docs/runbooks/phase-c-hardening.md`.

**Pre-conditions for every scenario:**
- A live `omc team` run is in progress (any small workload — a 3-task
  rename refactor on a sandbox repo is enough).
- `clawhip`, `argus-watchdog`, `argus-recovery`, `telegram-bridge` are
  all running and healthy: `launchctl list | grep com.argus.` shows
  PID > 0 for each.
- You're tailing the relevant log files in separate terminals:
  ```
  tail -F ~/.argus/logs/recovery.{out,err}.log
  tail -F ~/.argus/logs/watchdog.{out,err}.log
  tail -F ~/.argus/logs/bridge.{out,err}.log
  ```
- You can see the Discord `#runs-info` channel and the Telegram CRITICAL
  chat the bridge fans out to.

**Conventions:**
- `<RUN>` = the active run id from `omc list` or
  `cat $OMC_STATE_DIR/runs/*/manifest.json | jq .run_id`.
- Cleanup steps are in the "Recovery" subsection. Always run them — a
  half-cleaned chaos test poisons the next one.

---

## Scenario A — Mode (a): Agent stuck in a ralph loop

**Failure mode:** an agent re-prompts itself >30 times on the same task
without progress.

**Inject:**
```bash
# Pre-set the iteration counter very close to the cap so the next Stop
# hook will cross the threshold:
RUN=$(omc list | head -1 | awk '{print $1}')
TASK="task-1"
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.ralph_iterations = m.ralph_iterations || {};
  m.ralph_iterations[process.argv[2]] = 29;
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN" "$TASK"
# Now wait for the next Stop hook fire — it'll bump 29 → 30 → emit.
```

**Expected detection:** within 1 Stop-hook firing (which is one
agent-message-end). On a typical workload this is <60s.

**Expected auto-response:**
1. `~/.argus/logs/recovery.err.log` shows
   `ralph-cap: ...` debug line.
2. clawhip emits `agent.loop-exhausted` WARN → routed to Discord
   `#runs-info`.
3. The next agent prompt is prefixed with the directive
   `"Your task has hit the ralph iteration cap. Stop, summarize..."`
   (visible in the agent's transcript via `omc tail <RUN>`).
4. Manifest's `ralph_iterations[task-1]` reads 30.

**Expected escalation:** if the agent ignores the directive and keeps
looping, the counter eventually hits 60 and emits `agent.loop-exhausted`
**page** (Telegram). At that point the operator must intervene
(`omc pause <RUN>` and inspect).

**Recovery / cleanup:**
```bash
# Reset the counter for the next test run
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.ralph_iterations = {};
  delete m.next_prompt_prepend;
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"
```

---

## Scenario B — Mode (b): tmux session goes stale

**Failure mode:** the tmux session driving an agent stops responding —
session exists but is hung.

**Inject:**
```bash
RUN=$(omc list | head -1 | awk '{print $1}')
SESSION="${RUN}-leader"
# Kill it hard; clawhip's tmux.stale detection will fire
tmux kill-session -t "$SESSION"

# OR (more realistic stale, harder to reproduce):
# Send a SIGSTOP to the agent process inside the tmux pane and wait
# for clawhip's stale-detect to fire after 5 min of no output:
# kill -STOP $(pgrep -f "claude --session $RUN")
```

**Expected detection:** clawhip's tmux.stale check (5-min silence
threshold, configurable). Within 5-6 minutes of injection.

**Expected auto-response:**
1. clawhip routes `tmux.stale` → `POST http://127.0.0.1:9601/tmux-restart`
   with `{"session_name": "<RUN>-leader"}` in the body.
2. recovery's tmux-restart handler:
   - Reads manifest, sees no prior attempt.
   - Restores latest checkpoint from
     `runs/<RUN>/checkpoints/<latest>/` to `runs/<RUN>/`.
   - `tmux new-session -d -s <RUN>-leader`.
   - `tmux send-keys ... omc team --resume <RUN>`.
   - Marks `tmux_restart_attempted = ["<RUN>-leader"]` in manifest.
   - Emits `tmux.restart-attempted` INFO → Discord.

**Expected escalation:** if the session goes stale a *second* time
within the same run, recovery emits `tmux.restart-exhausted` PAGE →
Telegram. No second auto-restart. Operator must investigate
manually.

**Recovery / cleanup:**
```bash
# Reset the attempt list so the next chaos test gets a fresh attempt
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.tmux_restart_attempted = [];
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"
```

---

## Scenario C — Mode (c): clawhip dies

**Failure mode:** clawhip process crashes or is killed.

**Inject:**
```bash
pkill -9 clawhip
```

**Expected detection:** within 60-90s (watchdog's two ticks at 30s + a
small grace window).

**Expected auto-response:**
1. `~/.argus/logs/watchdog.out.log` shows
   `check unhealthy / failures=1 → 2`.
2. Watchdog calls
   `launchctl kickstart -k gui/<uid>/com.argus.clawhip`.
3. clawhip's plist KeepAlive=true respawns it.
4. Next watchdog tick reports healthy; counter resets.
5. (If the cost-tracker hook had cached events queued, they fire on
   the next agent step.)

**Expected escalation:** if `launchctl kickstart` fails (exit ≥1) or
clawhip isn't on PATH (binary moved/uninstalled), watchdog's escalator
runs the dead-man's-switch path: `omc emit --tier critical --event
clawhip.dead-man --message ...`. OMC's native callback writes to the
Telegram CRITICAL channel directly (BYPASSING the dead clawhip).

**Recovery / cleanup:**
```bash
# Verify clawhip is up
launchctl list | grep com.argus.clawhip
curl -fsS http://127.0.0.1:25294/status
```

---

## Scenario D — Mode (d): host reboots

**Failure mode:** the Mac (or Linux VPS) hard-reboots mid-run.

**Inject:** (only do this on a sandbox machine — it's a real reboot)
```bash
sudo reboot
```

**Expected detection:** at boot.

**Expected auto-response:**
1. launchd auto-loads all `~/Library/LaunchAgents/com.argus.*.plist`
   units with `RunAtLoad=true`. clawhip, telegram-bridge, watchdog,
   argus-recovery all come back up.
2. The pre-reboot run's manifest is preserved on disk
   (`$OMC_STATE_DIR/runs/<RUN>/manifest.json`); state.field flips to
   `"paused-by-reboot"` via OMC's own boot hook (separate from
   recovery — this is OMC's responsibility).
3. The operator is notified via the `host.rebooted` event — clawhip
   emits this from a startup-script hook. Routed to Telegram.
4. Operator decides whether to `omc team --resume <RUN>`.

**Expected escalation:** auto-resume is *not* attempted in Phase C.
If the operator doesn't resume within an hour, an
`omc.unattended-after-reboot` PAGE is emitted (Phase C+ — currently
documentation-only).

**Recovery / cleanup:**
```bash
# Manually resume
omc team --resume <RUN>
# Verify daemons
launchctl list | grep com.argus
```

---

## Scenario E — Mode (e): agent claims DONE without evidence

**Failure mode:** an agent emits `<promise>DONE</promise>` without a
recent `team-verify` pass.

**Inject:**
```bash
# Compose a synthetic Stop-hook payload and feed it directly to the
# fake-completion subcommand. This bypasses Claude Code entirely so we
# don't need to provoke the misbehavior in a live agent.
RUN=$(omc list | head -1 | awk '{print $1}')
echo '{"transcript":"<promise>DONE</promise>"}' \
  | OMC_CURRENT_RUN_ID="$RUN" bun run \
    /path/to/argus/scripts/recovery/src/cli.ts fake-completion
```

**Expected detection:** immediate (the regex matches as soon as
fake-completion runs).

**Expected auto-response:**
1. fake-completion checks `manifest.last_verify_pass_at`.
2. If null OR older than 5 min, emits `agent.fake-completion` WARN to
   Discord and stamps `manifest.next_prompt_prepend = "Your DONE claim
   is missing a recent team-verify pass..."`.
3. The next agent prompt fires with that directive prepended (visible
   in the agent's transcript).

**Expected escalation:** none auto. If the agent emits another fake
DONE on the next turn, the prompt-prepend persists and a second WARN
fires. Operator review is the back-stop.

**Recovery / cleanup:**
```bash
# Clear the next_prompt_prepend so subsequent tests aren't polluted
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  delete m.next_prompt_prepend;
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"

# Optionally simulate a verify-pass to test the "fresh verify-pass
# bypasses the guard" path:
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.last_verify_pass_at = new Date().toISOString();
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"
# Re-run the fake-completion subcommand: should NOT emit.
```

---

## Scenario F — Mode (f): provider outage (Anthropic API or Max20)

**Failure mode:** Anthropic's API returns sustained 5xx errors, OR the
Max20 OAuth token refresh stalls.

**Inject:**
```bash
# Simulate by emitting the clawhip event directly. The real-world
# provider.outage event gets emitted by clawhip's outbound layer when
# it sees a rolling 5xx rate above threshold; we don't have a
# reliable way to provoke that on demand without mocking the network.
RUN=$(omc list | head -1 | awk '{print $1}')
clawhip send --event provider.outage --severity warn --stdin-json \
  <<< "{\"run_id\":\"$RUN\",\"detail\":\"chaos-test\"}"
```

**Expected detection:** immediate (clawhip routes the event to
`http://127.0.0.1:9601/provider-fallback`).

**Expected auto-response:**
1. recovery's provider-fallback reads `~/.argus/secrets.env`.
2. If currently API and Max20 token present → switches to Max20.
3. If currently Max20 and API key present → switches to API.
4. Writes `$OMC_STATE_DIR/provider-override.env` with
   `ARGUS_PROVIDER=<new-mode>`.
5. Stamps `manifest.provider_outage_started_at` to now (if unset).
6. Emits `provider.fallback-engaged` WARN → Discord.

**Expected escalation:**
- If neither fallback credential is available → `provider.fallback-
  unavailable` PAGE → Telegram. Run will likely cost.kill or block on
  next API call.
- If the outage persists for >2h (manifest.provider_outage_started_at
  stays set), the next provider.outage event triggers a
  `provider.outage-prolonged` PAGE → Telegram.
- 60s anti-flap window prevents oscillation between modes if multiple
  outage events arrive in quick succession.

**Recovery / cleanup:**
```bash
# Clear outage state
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.provider_outage_started_at = null;
  delete m.provider_mode_switched_at;
  // restore original mode
  m.provider_mode = "max20"; // or "api" depending on your install
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"

# Remove the override file so OMC reads default credentials again
rm -f "$OMC_STATE_DIR/provider-override.env"
```

---

## Composite — crash budget exhaustion

Not a separate design §8 mode but the cross-cutting halt mechanism. To
verify:

```bash
RUN=$(omc list | head -1 | awk '{print $1}')
bun run scripts/recovery/src/cli.ts budget bump "$RUN" "chaos-1"  # count=1
bun run scripts/recovery/src/cli.ts budget bump "$RUN" "chaos-2"  # count=2
bun run scripts/recovery/src/cli.ts budget bump "$RUN" "chaos-3"  # count=3 → CRITICAL + omc cancel
```

**Expected:** at the third bump, `crash-budget-exhausted` CRITICAL
fires to Telegram and `omc cancel <RUN>` is invoked. Bumps 4, 5, ...
do NOT re-emit (the threshold trigger is idempotent). The counter
keeps incrementing so the post-halt strike trail is preserved.

**Recovery / cleanup:**
```bash
# Manifest is now in a halted state. Either delete it (if testing on a
# disposable run) or:
node -e '
  const fs = require("fs");
  const path = process.env.OMC_STATE_DIR + "/runs/" + process.argv[1] + "/manifest.json";
  const m = JSON.parse(fs.readFileSync(path, "utf8"));
  m.crash_count = 0;
  fs.writeFileSync(path, JSON.stringify(m, null, 2));
' "$RUN"
```

---

## Pass criteria

A scenario PASSES if all "Expected ..." outcomes happen within the
documented detection window AND the recovery actions leave the run in
a state where it CAN be resumed (or, for Mode E and Composite, in a
state where the operator can intervene with full visibility into what
just happened).

A scenario FAILS if:
- The auto-response doesn't fire within 2× the detection window.
- The escalation doesn't fire when the auto-response is supposed to
  fail (this is the silent-failure mode we built clawhip + watchdog +
  recovery to prevent).
- A recovery script crashes (non-zero exit) and the agent state is
  left corrupt.

For each FAIL: file an issue with the failing scenario tag, the log
excerpts from `~/.argus/logs/`, and the manifest snapshot. Then re-run
the scenario after the fix.

## Operator log

Use this section to record outcomes after each chaos run.

| Date | Scenario | Outcome | Notes |
| --- | --- | --- | --- |
| YYYY-MM-DD | A — ralph cap | PASS / FAIL | ... |
| ... | ... | ... | ... |
