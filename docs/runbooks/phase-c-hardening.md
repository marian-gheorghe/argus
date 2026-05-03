# Phase C Hardening — Runbook

Living log of the Phase C install on macOS (and later Linux/VPS). Append
findings as you go; do NOT delete history. Future-you (and the chaos suite +
72h dry run) reads this.

## Environment

- macOS version: <fill in>
- Bun version: <fill in> (must be on PATH; install-mac.sh's section_bun handles it)
- jq version: <fill in> (required by section_cost_tracker for settings.json edits)
- OMC version: <fill in>
- clawhip version: <fill in>

## Status

### Block 1 — Cost Tracker
- [x] Task 1.1: Cost tracker hook (sqlite-backed accumulator) — TDD
- [x] Task 1.2: Threshold-event emission + clawhip wiring
- [x] Task 1.3: Hook registration + Max20 no-op mode

### Block 2 — Watchdog
- [x] Task 2.1: Watchdog as a Bun service (modular checks) — TDD
- [x] Task 2.2: Linux systemd-watchdog integration
- [x] Task 2.3: launchd plist (Mac) + smoke test

### Block 3 — Recovery Matrix Automation
- [ ] Task 3.1: Ralph iteration cap + fake-completion guard
- [ ] Task 3.2: tmux stale-detect → auto-restart with checkpoint replay
- [ ] Task 3.3: Provider-outage fallback (API ↔ Max20)
- [ ] Task 3.4: Crash budget enforcement
- [ ] Task 3.5: Recovery integration smoke (chaos suite)

### Block 4 — VPS Provisioning (Ansible)
- [ ] Task 4.1: Ansible inventory + host bootstrap role
- [ ] Task 4.2: argus_stack role
- [ ] Task 4.3: cutover playbook
- [ ] Task 4.4: nginx + Let's Encrypt

### Block 5 — Knowledge Accumulation Discipline
- [ ] Task 5.1: /learner per-phase trigger
- [ ] Task 5.2: Skill-scope classifier + collision check
- [ ] Task 5.3: Notepad 500-line cap + summarizer

### Block 6 — Smoke + Verdict
- [ ] Task 6.1: First small migration run on a test repo
- [ ] Task 6.2: 72h continuous-run dry test
- [ ] Task 6.3: Phase C verdict + merge

## Findings (chronological)

### 2026-05-03 — Block 1: Cost tracker (Tasks 1.1, 1.2, 1.3)

Implemented across five commits on `phase-c/hardening`:

1. `phase-c: bootstrap cost-tracker Bun project + pricing + policy schemas`
2. `phase-c: cost accumulator with atomic transactions + tests`
3. `phase-c: threshold detection + emit (warn/page/kill) + idempotency`
4. `phase-c: cost-tracker PostToolUse hook + install script integration`
5. `phase-c: phase-c runbook scaffold + Block 1 entry` (this commit)

#### What landed

- `scripts/cost-tracker/` — full Bun TS project mirroring
  `scripts/telegram-bridge/` layout. Strict TS, biome, bun:test, pino + zod
  deps. Committed `bun.lock` for reproducibility (.gitignore negation).
- `src/pricing.ts` + `src/toml.ts` — load EUR-per-million-token rates from
  TOML; the small in-house TOML parser handles flat sections + scalar values
  with no parser dep. Pricing rates are converted to EUR/token at load time
  so `costFor` is a pure multiplication.
- `src/policy.ts` — load billing mode + ceiling + threshold ratios + tier
  routing from `~/.claude/omc/argus/policy.toml`. zod validates the
  `[default]` section's `billing ∈ {max20, api}` enum.
- `src/accumulator.ts` — bun:sqlite WAL accumulator. One row per run_id with
  raw token counts per `(tier, token_type)` cell + three threshold-emitted
  flags. Every `add` is a `BEGIN IMMEDIATE` transaction so concurrent calls
  serialise. spent_eur is recomputed from raw tokens × current pricing on
  every add — never delta-added — so a mid-run pricing edit is honoured on
  the next hook fire. `markEmitted(level)` returns whether the flag was
  previously 0; the caller uses that to gate the actual emit (exactly-once
  semantics across hook restarts).
- `src/thresholds.ts` — pure `evaluate(spent, ceiling, ratios)` returning
  the highest crossed level. Defensive on ceiling<=0 and negative spend.
- `src/emit.ts` — `ClawhipEmitter` shells out via injectable SpawnFn. Event
  severity mapping: warn→warn, page→page, kill→critical. Each emit gets a
  deterministic `event_id = "<event>:<run_id>"` so clawhip's outbound queue
  dedups defensively past the in-process idempotency.
- `src/hook.ts` — entrypoint. Reads stdin JSON, validates via zod, resolves
  `OMC_CURRENT_RUN_ID` from env, maps model name to tier, accumulates
  tokens, evaluates thresholds, emits each newly-crossed level (so a single
  big call that jumps 0%→120% emits warn + page + kill in order). For page
  also calls `omc pause`; for kill also calls `omc cancel`. **All external
  calls are individually try/catched, and the entire body is fenced by an
  outer try/catch that returns 0 on any throw.** A hook crash NEVER blocks
  the agent.
- `scripts/install-mac.sh` — new `section_cost_tracker` wired between
  `section_hook_bridge` and `section_bridge`. Generates policy.toml +
  pricing.toml (atomic-write + chmod 600 + timestamped backup), generates
  the bash wrapper at `~/.argus/cost-tracker-hook.sh`, and idempotently
  registers a PostToolUse hook entry in `~/.claude/settings.json` via jq.
- `config/policy.toml.example`, `config/pricing.toml.example` — committed.

#### Key design notes

- **Concurrency in the accumulator**: bun:sqlite WAL + `BEGIN IMMEDIATE`
  serialises read-modify-write per run row. Multiple `add` calls in flight
  on the same run resolve to a deterministic final spent_eur.
- **Idempotent emission**: belt-and-braces across two layers. (1)
  `Accumulator.markEmitted` is the in-process guard; it returns false on
  any second flip attempt and the caller skips the emit. (2)
  `event_id = "<event>:<run_id>"` lets clawhip's outbound queue dedup any
  re-emission that slips past (1) due to e.g. a hook process restart
  between the markEmitted and the emit RPC.
- **Model→tier mapping**: regex-substring match on the model name string.
  haiku / sonnet / opus are non-overlapping in Anthropic's namespace. An
  unknown model name (future Anthropic releases, or a non-Claude model
  routed via OMC) defaults to `sonnet` — the safe middle-of-road tier so
  we don't under-charge a future opus equivalent or over-charge a future
  haiku equivalent. The default fires a stderr warn.
- **Pricing recomputation**: `spent_eur` is regenerated from raw token
  counts × current pricing on every `add` call, not delta-summed.
  Rationale: an operator can edit `~/.argus/pricing.toml` mid-run when
  Anthropic publishes new prices, and we want the budget enforcement to
  reflect the rates they just told us about.
- **Crash-resistance**: enforced top-to-bottom in `runHook`. Every external
  call (Policy.load, Pricing.load, JSON.parse, sqlite open, emit, omc
  pause, omc cancel) has its own try/catch that logs and continues. The
  entire body is fenced by an outer try/catch that exits 0 on any throw.
  Test `internal accumulator throw: exit 0 with stderr` exercises this by
  passing a directory as the dbPath, which sqlite cannot open as a file.

#### Verification

Run from `scripts/cost-tracker/`:

- `bun install` — 45 packages, lockfile committed
- `bun run typecheck` — clean (`tsc --noEmit`)
- `bun test` — 64 pass / 0 fail / 161 expect() calls across 6 files
- `bun run lint` — clean (biome)
- `bash -n scripts/install-mac.sh` — clean

CLI smoke (from repo root, with all paths pointing to /nonexistent so
the hook hits the missing-policy branch):

```
$ echo '{"hook_event_name":"PostToolUse","tool_response":{"usage":{"input_tokens":100,"output_tokens":50},"model":"claude-sonnet-4-7"}}' \
    | ARGUS_POLICY_PATH=/nonexistent ARGUS_PRICING_PATH=/nonexistent ARGUS_COST_DB=/tmp/argus-cli-smoke.sqlite \
      bun run scripts/cost-tracker/src/hook.ts
cost-tracker: policy load failed: Policy.load: cannot read /nonexistent: ENOENT: no such file or directory, open '/nonexistent'
$ echo $?
0
```

Exit 0 even with a missing policy file. Hook crash-resistance verified.

#### Deferred / open items

- **Live verification of cost.warn/page/kill end-to-end** is deferred to
  Block 6's Task 6.1 (first small migration run on a test repo). Per Task
  1.3: "submit a small `omc team` run in api mode with a tight ceiling
  (--ceiling=0.50) — it should cost.kill at ~€0.55 and cancel". This needs
  an actual API-keyed OMC run, which Phase B's smoke didn't cover; it's
  the natural place to verify in Block 6.
- **clawhip route for cost.warn/cost.page/cost.kill** must be added to
  `config/clawhip.toml.example` and rendered into the live config in a
  follow-up. The hook today emits the events; whether they reach Discord/
  Telegram depends on clawhip routing. The Phase B example file already
  has a TODO comment ("Phase C will add: cost.warn → discord, cost.page/
  cost.kill → bridge…"); this is the trigger to do that as a Block 1
  follow-up before the Block 6 smoke.
- **`omc pause` and `omc cancel` are best-effort**: today the spec assumes
  these subcommands exist on OMC. If a future OMC release renames them,
  the hook still exits 0 and only the auto-pause/cancel side effect is
  lost — not the cost.* event. That degrades gracefully.

### 2026-05-03 — Block 2: Watchdog (Tasks 2.1, 2.2, 2.3)

Implemented across seven commits on `phase-c/hardening`:

1. `phase-c: bootstrap watchdog Bun project + Check interface + platform abstraction`
2. `phase-c: clawhip + bridge + omc-wait health checks (TDD)`
3. `phase-c: pending-replies expiry check (Phase B issue 3 followup)`
4. `phase-c: escalation policy + OMC native callback dead-man's-switch`
5. `phase-c: runner loop + sd_notify hook + main entry`
6. `phase-c: watchdog launchd plist + section_watchdog install`
7. `phase-c: runbook entry for Block 2 (watchdog)` (this commit)

#### What landed

- `scripts/watchdog/` — full Bun TS project mirroring the cost-tracker /
  telegram-bridge layout. Strict TS, biome, bun:test, pino + zod deps.
  Committed `bun.lock` for reproducibility (.gitignore negation).
- `src/check.ts` — minimal `Check` interface (`name`, `check(): Promise<{healthy,detail}>`,
  `restart(): Promise<{ok,detail}>`). Implementations MUST NOT throw —
  failures are reported via the result shape.
- `src/platform.ts` — Platform detection (`darwin` / `linux`),
  `ServiceManager` interface, `LaunchdManager` (`launchctl kickstart -k
  gui/<uid>/<label>`), `SystemdManager` (`systemctl --user restart
  <label>`), and `makeServiceManager` factory. Spawn is dependency-
  injected via `SpawnFn` so tests never shell out.
- `src/checks/clawhip.ts`, `src/checks/bridge.ts` — HTTP probes against
  `http://127.0.0.1:25294/status` (clawhip) and `http://127.0.0.1:9501/health`
  (bridge). AbortController-based timeout (default 5s); non-200, network
  throw, and abort all collapse to `healthy:false`. A narrow `FetchFn`
  type sidesteps Bun's `typeof fetch` requiring a `preconnect` member.
- `src/checks/omc-wait.ts` — pgrep-based liveness (`pgrep -f "omc wait"`).
  Exit 0 healthy; exit 1 = "not running" (unhealthy); exit ≥2 carries the
  stderr in the detail. Document the `pgrep -f` false-positive risk
  (`cat omc wait.log` would also match) — acceptable in practice for the
  watchdog's controlled environment.
- `src/checks/pending-replies.ts` — Phase B Issue 3 followup. Connects
  to the bridge's sqlite at `$HOME/.argus/state/bridge-queue.sqlite`,
  ensures the `pending_replies` schema (CREATE TABLE IF NOT EXISTS so
  the bridge's DDL always wins), DELETEs rows older than 7200s. Always
  returns `healthy:true` — its purpose is the side effect, not the
  health signal. Restart is a no-op. **The DELETE + DDL are duplicated
  from `scripts/telegram-bridge/src/queue.ts` to avoid a cross-package
  dependency on the bridge module — flagged as Phase C+ cleanup
  (extract `argus-sqlite-types` shared package).**
- `src/escalation.ts` — `DeadMan` interface; `OMCNativeCallbackDeadMan`
  shells out to `omc emit --tier critical --event <check>.dead-man
  --message ... --payload-json ...` (bypassing clawhip — independent
  path, since clawhip might be the dead daemon we're escalating about);
  `MockDeadMan` for tests. `Escalator` class implements the policy:
  counter < threshold → throttled; ≥ threshold + within cooldown →
  throttled; ≥ threshold + outside cooldown → restart; restart fail
  or throw → emit dead-man. Cooldown stamps the attempt regardless of
  outcome so a permanently broken service doesn't get kickstart-spammed.
  Dead-man emit failure is logged at FATAL but never propagated.
- `src/runner.ts` — `Runner` class with the tick loop. Per-check
  failure counters; resets on healthy; resets on `action="restarted"`.
  Per-check exceptions are caught and folded into `{healthy:false}` so
  one buggy check cannot crash the loop. `sdNotify()` is called once
  per tick — the loop-completed semantic — so systemd's WatchdogSec
  can KILL+restart this process if it stops ticking.
- `src/index.ts` — main entrypoint. `build()` wires production deps
  from env (`BRIDGE_QUEUE_DB_PATH`, `WATCHDOG_INTERVAL_MS` /
  `_THRESHOLD` / `_RESTART_COOLDOWN_MS` /
  `_PENDING_REPLIES_OLDER_THAN_SECS`, `LOG_LEVEL`). `makeSdNotify()`
  returns no-op on Mac; on Linux (when `$NOTIFY_SOCKET` is set) shells
  out to `systemd-notify WATCHDOG=1`; falls back to no-op silently if
  `systemd-notify` is missing. Main wraps it with SIGTERM/SIGINT
  handling and clean exit.
- `launchd/com.argus.watchdog.plist` — template with `__WATCHDOG_DIR__`,
  `__BUN_BIN__`, `__USER_PATH__`, `__HOME__`, `__OMC_STATE_DIR__`
  placeholders. RunAtLoad + KeepAlive=true; launchd is the meta-watchdog.
- `scripts/watchdog/run.sh` — thin launchd wrapper. Lighter than the
  bridge's: no secrets to source. Resolves bun via BUN_BIN /
  $HOME/.bun/bin/bun / PATH. Bash strict-mode.
- `scripts/install-mac.sh` — new `section_watchdog()` registered between
  `section_bridge` and `section_launchd`, with the same atomic-write +
  plutil-lint + residual-placeholder check pattern used by neighbours.

#### Key design notes

- **Modular Check interface**: every probe is a class implementing
  `{name, check(), restart()}`. Concrete checks compose with a
  ServiceManager (launchctl on Mac / systemctl on Linux) so cross-OS
  reuse is trivial. The Runner only sees the interface — adding a new
  check (e.g. `cloudflared`) is a single new file + one line in
  `index.ts`'s `checks` array.
- **Dead-man's-switch independence**: when clawhip is the unhealthy
  daemon being escalated, we cannot route the alert THROUGH clawhip.
  `OMCNativeCallbackDeadMan` shells out to `omc emit` directly, which
  writes to OMC's own native callback bridge (Discord/Telegram via
  `~/.claude/omc/native-callback.toml` — independent of clawhip's
  webhook router). If THAT's also down, there's no further escalation;
  the watchdog logs the failure and continues so a future tick can try
  again once anything heals.
- **Cooldown is per-check, not global**: `Escalator.lastRestartAt` is a
  `Map<checkName, timestamp>` — a clawhip restart attempt at t=0 does
  not block a bridge restart attempt at t=10s. This is correct
  isolation: each daemon has independent failure modes.
- **Counter semantics**: counter increments on every unhealthy tick;
  resets on a healthy tick OR on `escalation.action === "restarted"`
  (we trust the restart took effect; the next failure starts a fresh
  consecutive-failure run). This means a flapping check (alternating
  healthy / unhealthy) never escalates because the counter never reaches
  threshold — by design. Sustained outages are what we want to escalate.
- **Crash-resistance**: The runner catches per-check exceptions inside
  `runOneCheck` (folds to `healthy:false`); catches escalator throws in
  the tick loop (logs and continues); catches sdNotify throws (logs);
  catches tick throws inside the run loop (last-resort log + continue).
  If the whole process dies anyway, launchd KeepAlive=true respawns it.
- **systemd watchdog protocol**: `makeSdNotify()` is a callable returned
  from boot; the Runner calls it once per successful tick. The Linux
  systemd unit (Block 4) will set `Type=notify`, `WatchdogSec=60`, and
  `Restart=on-watchdog`. If the watchdog stops ticking, systemd kills
  and restarts it — proper hardware-watchdog semantic.
- **pending-replies expiry inside the watchdog (not the bridge)**: the
  bridge's `OutboundQueue.expirePendingReplies()` was implemented in
  Phase B but never invoked from production code. Putting the call in
  the watchdog rather than adding a periodic timer in the bridge keeps
  the bridge focused on its single-consumer dispatch responsibility,
  and means a bridge that's stuck behind a long Telegram API call
  doesn't also delay the expiry pass.

#### Verification

Run from `scripts/watchdog/`:

- `bun install` — 45 packages, lockfile committed
- `bun run typecheck` — clean (`tsc --noEmit`)
- `bun test` — 60 pass / 0 fail / 137 expect() calls across 7 files
  - 8 platform tests
  - 9 clawhip-check tests, 9 bridge-check tests, 8 omc-wait-check tests
  - 8 pending-replies-check tests
  - 14 escalation tests (Escalator + MockDeadMan + OMCNativeCallbackDeadMan)
  - 10 runner tests
- `bun run lint` — clean (biome)
- `bash -n scripts/install-mac.sh` — clean
- `bash -n scripts/watchdog/run.sh` — clean
- Rendered plist passes `plutil -lint` with zero residual `__TOKEN__`
  placeholders.

CLI smoke (interval_ms=50ms, no live services on the worktree machine):

```
$ WATCHDOG_INTERVAL_MS=50 LOG_LEVEL=info NODE_ENV=production bun run src/index.ts
{"msg":"argus-watchdog booting","checks":["clawhip","bridge","omc-wait","pending-replies"]}
{"msg":"check unhealthy","check":"clawhip","failures":1,"detail":"GET http://127.0.0.1:25294/status threw: Unable to connect..."}
{"msg":"escalation decision","check":"clawhip","action":"throttled","detail":"failures=1 < threshold=2"}
... (failure 2 → restart attempt → launchctl exit=113 (no service registered)
                → dead-man fallback → omc not on PATH → FATAL log) ...
$ kill -TERM <pid>
{"msg":"shutting down","signal":"SIGTERM"}
{"msg":"watchdog runner stopping (signal aborted)"}
{"msg":"clean exit"}
exit=0
```

Behavior matches design: checks fire, counters reach threshold, restart
attempts hit launchctl (no live services on this dev box, so they fail
with exit=113 — expected), dead-man fallback attempts `omc emit`
(absent here, so logs FATAL — also expected), and SIGTERM produces a
clean exit code 0. Per-check counter increment + per-check cooldown
behavior all verified in the live log stream.

#### Chaos scenarios documented

Block 2 spec calls out two manual chaos tests for Task 2.3. These will
be exercised against the live Mac stack in Block 6 (Smoke). For now,
documented expectations:

1. **Clawhip kill recovery**:
   - Inject: `pkill -9 clawhip`
   - Expected detection: within 60-90s (2 ticks × 30s + restart latency).
   - Expected response: watchdog calls `launchctl kickstart -k
     gui/<uid>/com.argus.clawhip`, KeepAlive in clawhip's plist
     respawns it, next tick finds it healthy, counter resets.
   - Verify by tailing `~/.argus/logs/watchdog.out.log` for the
     `escalate: restart succeeded` line.

2. **Clawhip dead-man** (binary missing or service unregistered):
   - Inject: `mv $(command -v clawhip) /tmp/clawhip.bak` and unload the
     plist (`launchctl bootout gui/<uid>/com.argus.clawhip`).
   - Expected detection: same 60-90s window.
   - Expected response: launchctl kickstart fails (exit=113), the
     escalator falls through to `omc emit --tier critical --event
     clawhip.dead-man --message ...`, OMC's native callback delivers
     to the configured CRITICAL Telegram channel.
   - Verify by checking the Telegram CRITICAL chat for the
     `clawhip.dead-man` message.
   - Recovery: `mv /tmp/clawhip.bak $(which-was-bin) && launchctl
     bootstrap gui/<uid> ~/Library/LaunchAgents/com.argus.clawhip.plist`.

#### Deferred / open items

- **systemd unit (Linux)** is Block 4 work. The runner's `sdNotify`
  hook is wired and tested; the unit definition with `Type=notify` +
  `WatchdogSec=60` + `Restart=on-watchdog` will be added then.
- **clawhip route for `*.dead-man` events** — the dead-man path emits
  via OMC's native callback (independent of clawhip), so this is not
  blocking. But for completeness, when clawhip is healthy and a non-
  clawhip check escalates (e.g. `bridge.dead-man` or `omc-wait.dead-man`),
  it would be useful to ALSO route those through clawhip's normal
  CRITICAL channel for redundancy. Phase C+ cleanup.
- **SQL duplication between bridge and watchdog** for `pending_replies`.
  Tracked in `src/checks/pending-replies.ts` header comment as a Phase
  C+ extract-shared-package task.
- **Live chaos verification (kill clawhip / move binary)** is deferred
  to Block 6 (Smoke), where it's run against the full live stack. The
  CLI smoke above only validates the watchdog's wiring; full
  verification needs an actually-running clawhip + bridge to bounce.
