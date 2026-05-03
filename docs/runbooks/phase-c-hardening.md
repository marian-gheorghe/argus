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
- [x] Task 3.1: Ralph iteration cap + fake-completion guard
- [x] Task 3.2: tmux stale-detect → auto-restart with checkpoint replay
- [x] Task 3.3: Provider-outage fallback (API ↔ Max20)
- [x] Task 3.4: Crash budget enforcement
- [x] Task 3.5: Recovery integration smoke (chaos suite)

### Block 4 — VPS Provisioning (Ansible)
- [x] Task 4.1: Ansible inventory + host bootstrap role
- [x] Task 4.2: argus_stack role
- [x] Task 4.3: cutover playbook
- [x] Task 4.4: nginx + Let's Encrypt

### Block 5 — Knowledge Accumulation Discipline
- [x] Task 5.1: /learner per-phase trigger
- [x] Task 5.2: Skill-scope classifier + collision check
- [x] Task 5.3: Notepad 500-line cap + summarizer

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

### 2026-05-03 — Block 3: Recovery matrix automation (Tasks 3.1, 3.2, 3.3, 3.4, 3.5)

Implemented across nine commits on `phase-c/hardening`:

1. `phase-c: bootstrap recovery Bun project + manifest store with atomic locking`
2. `phase-c: ralph iteration cap + fake-completion guard (Stop hooks)`
3. `phase-c: tmux stale-detect restart with checkpoint replay`
4. `phase-c: provider-outage credential fallback`
5. `phase-c: crash budget enforcement (3 strikes -> halt)`
6. `phase-c: argus-recovery CLI + HTTP serve + main entry`
7. `phase-c: section_recovery install + Stop hook registration + clawhip routes`
8. `phase-c: chaos suite runbook (6 scenarios per design 8a-f)`
9. `phase-c: phase-c runbook entry for Block 3` (this commit)

#### What landed

- `scripts/recovery/` — full Bun TS project mirroring
  `scripts/cost-tracker/` + `scripts/watchdog/` layout. Strict TS,
  biome, bun:test, pino + zod deps. Committed `bun.lock` for
  reproducibility (.gitignore negation).
- `src/manifest.ts` — `ManifestStore` with atomic JSON writes
  (tmp + fsync + rename, mode 0600) and cross-process locking via a
  sidecar `manifest.lock` file (O_EXCL + spin-wait up to 2s with 10ms
  intervals). Lock is unlinked on every exit path including throws.
  zod schema uses `passthrough()` for forward-compat with newer
  builds; required fields surface corruption on read rather than
  silently defaulting. Manifest path:
  `$OMC_STATE_DIR/runs/<run_id>/manifest.json`.
- `src/emit.ts` — `RecoveryEmitter` interface + `MockEmitter` (test)
  + `ClawhipEmitter` (production, shells out to `clawhip send` via
  injectable SpawnFn). Mirrors cost-tracker's emit pattern. Each
  event carries deterministic `event_id = "<event>:<run_id>"` for
  defense-in-depth dedup at clawhip's outbound queue.
- `src/ralph-cap.ts` — Stop-hook entry. Increments
  `manifest.ralph_iterations[task_id]`; on EXACT crossing of
  MAX_ITERATIONS (default 30) emits `agent.loop-exhausted` WARN and
  sets `next_prompt_prepend`; on EXACT 2*MAX crossing emits PAGE.
  Counter is incremented BEFORE the emit so a clawhip outage doesn't
  risk double-counting on retry.
- `src/fake-completion-guard.ts` — Stop-hook entry. Reads agent
  transcript from stdin, regex-detects `<promise>DONE</promise>`
  (case-insensitive, whitespace-tolerant), checks
  `manifest.last_verify_pass_at` against a 5-min freshness window.
  Stale or missing => emits `agent.fake-completion` WARN and stamps
  `next_prompt_prepend`. Manifest update happens BEFORE the emit so
  the corrective injection survives a clawhip outage.
- `src/tmux-restart.ts` — invoked by clawhip's `tmux.stale` route.
  Parses `run_id` from session_name (`<run_id>-leader`), restores
  latest checkpoint files (notepad.md, project-memory.json, plans/)
  into `runs/<run_id>/`, then re-launches tmux with
  `omc team --resume <run_id>`. One-shot: marks
  `tmux_restart_attempted` in the manifest BEFORE spawning tmux to
  prevent infinite retries on partial-success spawn failures. Second
  stale within the run emits `tmux.restart-exhausted` PAGE.
- `src/provider-fallback.ts` — invoked by clawhip's `provider.outage`
  route. Reads `~/.argus/secrets.env` for credential availability
  (CLAUDE_CODE_OAUTH_TOKEN for Max20, ANTHROPIC_API_KEY for API).
  Toggles between modes; persists to manifest AND
  `$stateDir/provider-override.env`. Anti-flap: 60s window via
  `provider_mode_switched_at` passthrough field. After `pageAfterMs`
  (2h default) of continuous outage emits `provider.outage-prolonged`
  PAGE.
- `src/crash-budget.ts` — `runCrashBudgetBump`: increments
  `manifest.crash_count`; at threshold (3) emits
  `crash-budget-exhausted` CRITICAL and shells out via injected
  `cancelRun` (production: `omc cancel <run_id>`). Idempotent: bumps
  4, 5, ... still increment but don't re-emit/re-cancel. Auto-creates
  manifest if missing.
- `src/cli.ts` — single binary, dual entry. CLI subcommands
  (`ralph-cap`, `fake-completion`, `tmux-restart --session <name>`,
  `provider-fallback`, `budget bump <run_id> <reason>`); HTTP serve
  mode (`serve --port 9601`) with POST routes
  (`/tmux-restart`, `/provider-fallback`, `/budget/bump`,
  `/ralph-cap`, `/fake-completion`) + GET `/healthz`. Path-routing
  checks known paths BEFORE method validation so unknown paths
  return 404 (not 405).
- `scripts/recovery/run.sh` — thin launchd wrapper resolving bun
  binary + exec'ing `argus-recovery serve`. ARGUS_RECOVERY_PORT env
  override (default 9601).
- `launchd/com.argus.recovery.plist` — KeepAlive=true,
  RunAtLoad=true. Env: ARGUS_RECOVERY_PORT=9601,
  RALPH_MAX_ITERATIONS=30, FAKE_COMPLETION_FRESHNESS_MS=300000,
  PROVIDER_PAGE_AFTER_MS=7200000 (2h), CRASH_BUDGET_THRESHOLD=3.
- `scripts/install-mac.sh` — new `section_recovery` slotted between
  `section_watchdog` and `section_launchd`. Renders the launchd plist
  (atomic-write + plutil-lint), generates Stop-hook wrapper at
  `~/.argus/recovery-stop-hook.sh` (calls argus-recovery ralph-cap
  then fake-completion in sequence; both exit 0 always),
  idempotently registers the wrapper as a Stop hook in
  `~/.claude/settings.json` via jq.
- `config/clawhip.toml.example` — new routes for `tmux.stale` and
  `provider.outage` to `http://127.0.0.1:9601`. Recovery WARN events
  route to Discord; PAGE events to bridge `/webhook/page`;
  CRITICAL (`crash-budget-exhausted`) to bridge `/webhook/critical`.
- `docs/runbooks/chaos-suite.md` — six scenarios mirroring design §8
  modes (a-f) plus a composite crash-budget scenario. Each lists
  failure description, inject command, expected detection window,
  expected auto-response, expected escalation, manual cleanup. Pass/
  fail criteria + operator log table at the foot.

#### Key design notes

- **Manifest lock mechanism**: O_EXCL on a sidecar `manifest.lock`
  file with a 2s spin-wait. Chosen over sqlite advisory locks for
  zero extra deps and identical Linux/macOS semantics. The file-lock
  pattern works because every recovery script's `update()` is a
  short read-modify-write on a single JSON; for higher-contention
  scenarios a sqlite-backed lock (or actual sqlite-stored manifest)
  would be a drop-in replacement. The lock-removal path uses
  try/catch on both the close AND the unlink so a partial lock
  state never wedges the run permanently.
- **CLI vs HTTP rationale**: clawhip's webhook sink is HTTP-only,
  but OMC's Stop hook is exec-only. We could (a) build a separate
  HTTP receiver, (b) extend the bridge with recovery routes, or (c)
  give argus-recovery dual entry. We picked (c) because it keeps
  recovery's concerns in one binary and avoids bloating the bridge
  with cross-cutting failure-handling. Bun.serve makes the HTTP path
  trivial — no separate framework. The Stop-hook wrapper still uses
  the CLI path because it's lower latency than going through HTTP
  for a hook that fires on every agent message-end.
- **Manifest schema decisions**: passthrough() lets newer builds
  add fields (e.g., `provider_mode_switched_at`, used for anti-flap)
  without losing them on round-trip through an older recovery
  binary. Required fields (run_id, started_at, state) surface
  corruption on read — better to fail loudly than to silently
  default-construct a manifest that loses the actual state. Counter
  fields (crash_count, ralph_iterations) all default to zero/empty
  via z.default() so a partially-bootstrapped manifest from before
  Block 3 still validates.
- **Idempotent threshold semantics**: every recovery script that
  emits at a threshold (ralph-cap at 30/60, crash-budget at 3) only
  fires on the EXACT crossing. ralph-cap at count=31 stays silent;
  crash-budget at count=4 stays silent. The counters still
  increment so the post-halt strike trail remains visible, but the
  emission and the side effect (omc cancel, prompt prepend) only
  happen once per run.
- **Persistence-before-emit pattern**: every script that mutates
  manifest state does the manifest write BEFORE the clawhip emit. A
  clawhip outage during recovery's own emit path must not lose the
  corrective state change — the next agent turn / next fallback
  evaluation needs to see the persisted decision. This means an
  emit failure logs to stderr but doesn't roll back. Defense in
  depth: the next manifest read picks up where the failed emit left
  off.
- **Crash-resistance**: every entry function is wrapped in a
  top-level try/catch that returns 0. Hook crashes never block the
  agent. Missing manifest is a silent no-op (don't break the agent
  if OMC hasn't seeded state yet). Malformed stdin is logged but
  doesn't crash. Emit failure is logged but doesn't propagate.

#### Verification

Run from `scripts/recovery/`:

- `bun install` — 45 packages, lockfile committed
- `bun run typecheck` — clean (`tsc --noEmit`)
- `bun test` — 68 pass / 0 fail / 176 expect() calls across 7 files
  - 10 manifest tests (read/write/update/concurrency/cleanup)
  - 10 ralph-cap tests (no run_id / no manifest / threshold / 2x
    threshold / idempotency / emit failure / unexpected throw)
  - 8 fake-completion-guard tests (no claim / fresh verify / stale
    verify / no verify / missing manifest / no run_id / malformed
    stdin / regex variants / emit failure)
  - 7 tmux-restart tests (happy path / second-attempt PAGE /
    bad session name / missing manifest / no checkpoint dir /
    latest-checkpoint selection / tmux failure)
  - 8 provider-fallback tests (max20→api / api→max20 / no fallback
    creds / missing secrets.env / anti-flap / outage-prolonged
    PAGE / missing manifest / no run_id)
  - 8 crash-budget tests (first bump / threshold crossing /
    idempotency / missing manifest auto-create / emit failure /
    cancelRun failure / custom threshold / payload contents)
  - 17 CLI tests (9 dispatch + 8 HTTP routes)
- `bun run lint` — clean (biome)
- `bash -n scripts/install-mac.sh` — clean
- `bash -n scripts/recovery/run.sh` — clean
- Rendered plist passes `plutil -lint` with zero residual `__TOKEN__`
  placeholders.

CLI smoke from repo root:

```
$ echo '{}' | OMC_STATE_DIR=/tmp/argus-cli-smoke OMC_CURRENT_RUN_ID=run-smoke \
    bun run scripts/recovery/src/cli.ts ralph-cap
$ echo $?
0
```

```
$ bun run scripts/recovery/src/cli.ts unknown-cmd
unknown command: unknown-cmd
argus-recovery <command> [args]
...
$ echo $?
2
```

Behavior matches design: missing manifest is a silent no-op (exit 0),
unknown command returns exit 2 with usage. Hook crash-resistance
verified.

#### Deferred / open items

- **Live chaos verification of all six scenarios** is deferred to
  Block 6 (Smoke). The chaos suite runbook
  (`docs/runbooks/chaos-suite.md`) lists each scenario with reproducible
  inject + expected-outcome steps; running them against the live Mac
  stack happens after Block 4 (VPS provisioning) and before Block 6's
  72h dry-run.
- **`argus-recovery serve` is not registered as a watchdog target**
  in Block 2's watchdog config — it's a leaf in the dependency
  graph (recovery doesn't itself require monitoring; if it dies,
  launchd KeepAlive=true respawns it). If the next phase reveals
  silent-failure edge cases for the recovery server itself, add a
  HealthCheck to Block 2.
- **Provider-fallback's outage-resolution detection** is not
  implemented yet. Today, `provider_outage_started_at` is set on
  switch but never cleared automatically. A Phase D extension
  should add a periodic poll (every 5 min) that verifies the
  preferred provider is healthy and clears the outage stamp +
  switches back. Block 3 is the in-the-moment auto-fallback; the
  closing-the-loop probe is out of scope.
- **`tmux-restart` checkpoint discovery** uses a simple lexicographic
  sort on the checkpoint directory names. This requires checkpoint
  names to be sortable timestamps (`<YYYYMMDD>T<HHMMSS>Z` format).
  OMC's checkpoint emitter follows this convention today; if it
  changes, recovery's discovery breaks silently (uses stale
  checkpoint). Phase C+ idea: read a `latest` symlink that OMC
  maintains.

### 2026-05-03 — Block 4: VPS Provisioning (Tasks 4.1, 4.2, 4.3, 4.4)

Implemented across sixteen commits on `phase-c/hardening`:

1. `phase-c: ansible scaffolding (cfg, inventory, vault example, README)`
2. `phase-c: ansible roles common + hardening (UFW, fail2ban, sysctl, unattended-upgrades)`
3. `phase-c: ansible roles argus_user + tailscale`
4. `phase-c: ansible role argus_stack — runtimes (Bun, Node, Rust)`
5. `phase-c: ansible role argus_stack — repo + bun install + cargo install + npm`
6. `phase-c: ansible role argus_stack — secrets + config rendering`
7. `phase-c: systemd unit templates for all 5 daemons`
8. `phase-c: ansible role argus_stack — systemd unit deployment + service start`
9. `phase-c: ansible role argus_stack — Claude Code hooks registration`
10. `phase-c: ansible role nginx + Lets Encrypt certbot`
11. `phase-c: ansible playbook 00-bootstrap (root-as)`
12. `phase-c: ansible playbook 10-stack (argus-as)`
13. `phase-c: ansible playbook 99-verify (health assertions)`
14. `phase-c: ansible playbook 20-cutover (Mac -> VPS rsync + start)`
15. `phase-c: ansible molecule scenario (best-effort smoke)`
16. `phase-c: Block 4 runbook entry + ansible-lint config` (this commit)

#### What landed

- `ansible/` directory tree at the repo root: `ansible.cfg`,
  `requirements.yml` (community.general + ansible.posix), inventory
  examples, group_vars examples (one non-secret + one ansible-vault
  template), `.ansible-lint` profile config, README, eight roles, four
  playbooks, a molecule scenario.
- `systemd/` directory now populated with five `.service.j2` templates
  mirroring the launchd plists: `clawhip`, `omc-wait`,
  `telegram-bridge`, `watchdog` (Type=notify + WatchdogSec=60 +
  Restart=on-watchdog so the sd_notify path that the Bun runner
  already calls actually means something on Linux), and `recovery`.
  Each unit ships with `NoNewPrivileges`, `ProtectSystem=strict`,
  `ProtectHome=read-only`, `ReadWritePaths` whitelisting only the
  needed dirs, and `PrivateTmp`.
- `.gitignore` extended so only the `*.example` inventory + vault
  files are ever committed; filled `hosts.yml`, `argus_vps.yml`,
  `argus_vps.vault.yml` are excluded.

#### Key design decisions

- **Vault workflow**: example file → operator copies → fills →
  `ansible-vault encrypt`. The `secrets.yml` task asserts vault values
  are non-PLACEHOLDER before any rendering, so an unencrypted-still-
  default vault aborts the play with a clear message rather than
  rendering placeholder secrets into a live `secrets.env`.
- **User systemd units (not system)**: matches the design's "no
  services run as root" rule and matches the Mac launchd model where
  every daemon runs as the operator. `loginctl enable-linger argus`
  in the `argus_user` role keeps user units alive across logout. The
  trade-off — `XDG_RUNTIME_DIR` has to be set explicitly in the
  `become_user: argus` environment for `systemctl --user` to work
  outside an interactive session — is documented in the relevant tasks.
- **Cutover idempotency** comes from three primitives: rsync
  `--delete-after` (state converges, deletions of source files
  propagate after a successful transfer), `launchctl bootout` ignored
  on "No such process" (re-stop is a no-op), and `systemd state:
  started` (already-running unit is a no-op). Phasing via
  `argus_cutover_phase` lets the operator pause between phases for
  spot checks; `phase=all` runs the whole sequence.
- **Trust model**: argus is a service user with **no sudo**. Operators
  use their own login (managed out of band) for sudo work. The README
  documents this; if Phase D needs ops automation, add a separate
  `operator_users` role rather than promoting argus.
- **`creates:` guards everywhere** for slow / network-dependent
  installers: `~/.bun/bin/bun`, `~/.cargo/bin/cargo`, `clawhip` binary,
  `omc` binary, `clawhip plugin install claude-code` artifact. Re-runs
  short-circuit on the first re-evaluation.
- **nginx two-phase issuance**: the role drops in a port-80-only
  bootstrap site before certbot runs, then swaps to the full TLS site
  config (`argus.conf.j2`) once the cert exists. Avoids the classic
  certbot-needs-cert-needs-certbot deadlock. `nginx -t` validates
  every render before reload.
- **Lint hygiene**: `.ansible-lint` waives three cosmetic rules
  (`name[casing]`, `name[play]`, `var-naming[no-role-prefix]`) plus
  `command-instead-of-module` for the `rsync --rsync-path=...` and
  `systemctl is-active` probes that the dedicated modules don't
  cover. Each waiver carries an inline comment explaining why; the
  `basic` profile still passes (`production` per current lint
  output — over-achieving).

#### Verification

- `ansible-playbook --syntax-check` clean for all four playbooks
  (`00-bootstrap.yml`, `10-stack.yml`, `20-cutover.yml`,
  `99-verify.yml`) plus `molecule/default/converge.yml` +
  `molecule/default/verify.yml`.
- `ansible-lint --nocolor playbooks/ roles/` →
  `Passed: 0 failure(s), 0 warning(s) in 42 files processed of 44
  encountered. Profile 'basic' was required, but 'production' profile
  passed.`
- File counts:
  - playbooks: 4 (`00-bootstrap.yml`, `10-stack.yml`,
    `20-cutover.yml`, `99-verify.yml`)
  - roles: 6 (`common`, `hardening`, `argus_user`, `tailscale`,
    `argus_stack`, `nginx`)
  - role tasks files: 14 across the six roles (argus_stack alone has
    8 sub-task files: `main`, `directories`, `runtimes`, `repo`,
    `secrets`, `config`, `services`, `hooks`, `start`)
  - jinja2 templates: 12 (5 systemd unit templates in `systemd/`,
    plus 2 hardening templates, 2 nginx site templates, 1 secrets.env
    template, 2 hook wrapper templates)
  - molecule: 3 yamls in `molecule/default/`

#### Galaxy collections required

```yaml
collections:
  - community.general (>=8.0.0)   # ufw, timezone, json filters
  - ansible.posix    (>=1.5.0)    # authorized_key, synchronize, sysctl
```

`ansible-galaxy collection install -r requirements.yml`.

#### Operator pre-flight checklist

Before running the playbooks against a real Hetzner CX32:

1. **Provision the VPS via Hetzner Cloud Console.** Ubuntu 24.04, CX32,
   SSH key delivered via cloud-init.
2. **DNS A record** for `public_domain` -> the new public IPv4. Wait for
   propagation (5-30 min); certbot's HTTP-01 challenge fails otherwise.
3. **Tailscale auth key** generated in the Tailscale admin console
   (reusable, ephemeral, pre-approved).
4. **Telegram bot token + chat IDs** from Phase B's setup (or fresh
   pair if rebuilding).
5. **Discord webhook URL** for clawhip's `runs-info` channel.
6. **GitHub App PEM** committed to the vault (only required if clawhip's
   GitHub integration is being used; otherwise skip the line and the
   role conditionals will pass over it).
7. **Operator's SSH pubkey** in `inventory/group_vars/argus_vps.yml`.
8. **`ansible-vault encrypt inventory/group_vars/argus_vps.vault.yml`**
   so the secrets are encrypted at rest.

Then:

```bash
cd ansible
ansible-galaxy collection install -r requirements.yml
ansible-playbook playbooks/00-bootstrap.yml -u root --ask-vault-pass
# Switch ansible_user to argus in inventory/hosts.yml
ansible-playbook playbooks/10-stack.yml -u argus --ask-vault-pass
ansible-playbook playbooks/99-verify.yml -u argus --ask-vault-pass
```

#### Known limitations

- **molecule is partial**. docker-in-docker can't reliably run
  `systemctl --user`, tailscale needs `/dev/net/tun`, certbot needs an
  external HTTP-01 endpoint, and `cargo install clawhip` is too slow to
  repeat per-CI-run. So the molecule scenario asserts only the
  docker-safe subset (`common`, `argus_user`, `hardening`). Full stack
  validation requires a real Hetzner VPS dry run — tracked as a Block 6
  follow-up.
- **`tailscale up` is a single-shot decision.** If the authkey expires
  or the operator wants to re-key, the current task only re-runs when
  `tailscale status --json`'s `BackendState != "Running"`. Re-keying
  needs a manual `sudo tailscale logout` first; document at run-time.
- **First run from Hetzner cloud panel**: cloud-init must deliver the
  operator's SSH pubkey at provision time. There's no playbook flow to
  handle "no SSH access yet" — the first connection has to land via
  the Hetzner-provisioned key.
- **No cloudflared on Linux.** Per design §10.2, the Hetzner plan uses
  direct public IP + nginx + Let's Encrypt for ingress; cloudflared is
  Mac-only (Phase B's intermediate). The launchd `com.argus.cloudflared.plist`
  is therefore unmapped on the VPS — that's by design.
- **Live VPS dry run pending**: Per the plan, this should be exercised
  against a real CX32 (provision → run → destroy). Block 6 (smoke /
  72h dry-run) is the natural place to do that. Until then, the
  playbooks are syntax-clean + lint-clean but unverified end-to-end.

#### Deferred / open items

- **Live cutover dry run** (Mac → VPS → revert) per Task 4.3 step 2. The
  playbook's idempotency + reversibility are designed in; verification
  needs an actual Mac + VPS pair. Track in Block 6's smoke phase.
- **GitHub webhook URL update on cutover** is documented in the design
  but not automated by the playbook — deliberate, since it's a one-shot
  change in the GitHub App settings UI. Keep on the operator checklist.
- **Telegram webhook URL update on cutover** likewise — set the bot's
  webhook to `https://<public_domain>/telegram` after start_target.

### 2026-05-03 — Block 5: Knowledge accumulation discipline (Tasks 5.1, 5.2, 5.3)

Implemented across eight commits on `phase-c/hardening`:

1. `phase-c: bootstrap knowledge Bun project + manifest store (duplicated from recovery)`
2. `phase-c: learner cadence Stop hook (sets next_prompt_prepend = /learner at phase boundary)`
3. `phase-c: classify-scope + collision-check pure functions with tests`
4. `phase-c: learner-postprocess orchestrator (route to scope dir + collision flag)`
5. `phase-c: notepad-summarizer + 500-line-cap hook with archive`
6. `phase-c: argus-knowledge CLI + main entry`
7. `phase-c: section_knowledge install + Stop/PostToolUse hook registration + clawhip routes`
8. `phase-c: Block 5 runbook entry` (this commit)

#### Architecture decisions

- **Three small modules under one CLI** (`scripts/knowledge/`,
  Bun TS, mirroring `scripts/recovery/`): `learner-cadence` (Stop
  hook), `learner-postprocess` (operator-invoked orchestrator),
  `notepad-cap` (PostToolUse hook). Single binary
  `argus-knowledge` dispatches.

- **Schema duplication**: `scripts/knowledge/src/manifest.ts` is a
  slim duplicate of `scripts/recovery/src/manifest.ts`. Both files
  carry an explicit DUPLICATION TODO referencing a future shared
  `argus-state` package (workspace dep). For Phase C, both modules
  ship the same `RunManifest` shape with `passthrough()` + the new
  `phase_boundary_seen_at` field. Round-tripping is tested. **Phase
  C+ cleanup task**: extract the schema and store into a shared
  package. Until then, **any field added to one MUST be added to
  the other** so manifests do not silently drop fields owned by the
  unmodified module.

- **classify-scope heuristics** (single-evidence pulls to project):
  - absolute paths starting `/Users/`, `/home/`, `/var/`, `/opt/`
  - scoped npm imports (excluding well-known public scopes
    `@types/`, `@biomejs/`, `@anthropic-ai/`, `@bun/`, etc.)
  - git remote URLs (`git@github.com:...`, `https://github.com/...`)
  - `run-...` ids
  - argus-/omc/clawhip binary names
  - `OMC_*` / `ARGUS_*` / `CLAWHIP_*` env vars
  - default for empty content: `project` (safer fallback prevents
    accidental leakage to the user-global skill set)
  - `reasons[]` documents which signals fired

- **Collision-check similarity**: max of three metrics, each robust
  to a different kind of near-duplication:
  1. char-level Levenshtein-normalised (catches "handle auth
     error" / "handle auth errors")
  2. token-stem Jaccard with 0.5 floor (catches "auth handling" /
     "handle auth")
  3. sorted-stem Levenshtein backstop (catches longer reorderings
     with extra words)

  Threshold `> 0.7`. Stemming strips trailing `-s`, `-es`, `-ing`,
  `-ed`, `-er` for tokens longer than three chars. We deliberately
  did not pull a Porter stemmer — the cheap suffix-strip handles the
  common /learner re-extraction failure mode (same idea, different
  phrasing) and adds zero deps.

- **Summarizer injection**: `notepad-summarizer.ts` takes a
  `summarize: (input: string) => Promise<string>` callback so tests
  never touch a network. The default production summarizer in
  `cli.ts` shells out to `claude --model haiku --no-stream` via
  `Bun.spawn`. If `claude` is unavailable, the cap hook catches
  the error, leaves the notepad untouched, and logs to stderr.

- **Idempotency gate** for the cap hook: the summarizer's output
  always begins with a deterministic `<!-- argus-notepad-summary
  generated=... -->` marker. The cap hook checks the first 1KB of
  any over-cap notepad for the marker before re-summarizing. So a
  notepad whose summary itself happens to exceed the line cap is
  not re-summarized into oblivion.

- **learner-postprocess invocation**: Phase C ships this as
  operator-invoked (`argus-knowledge learner-postprocess
  /path/to/new-skill.md`). Auto-wiring (file-watcher on the skills
  dir, or extending OMC's `/learner` skill itself to call into
  `argus-knowledge`) is a Phase D enhancement. The CLI surfaces
  failures (exit 1) since it's operator-driven; the two hook
  subcommands are crash-resistant (exit 0).

#### Files added/modified

```
scripts/knowledge/
├── package.json
├── tsconfig.json
├── biome.json
├── .gitignore
├── README.md
├── bun.lock
├── run.sh
├── src/
│   ├── cli.ts
│   ├── classify-scope.ts
│   ├── collision-check.ts
│   ├── emit.ts
│   ├── learner-cadence.ts
│   ├── learner-postprocess.ts
│   ├── manifest.ts
│   ├── notepad-cap-hook.ts
│   └── notepad-summarizer.ts
└── tests/
    ├── classify-scope.test.ts
    ├── cli.test.ts
    ├── collision-check.test.ts
    ├── learner-cadence.test.ts
    ├── learner-postprocess.test.ts
    ├── manifest.test.ts
    ├── notepad-cap-hook.test.ts
    └── notepad-summarizer.test.ts

config/clawhip.toml.example  (+2 routes)
docs/runbooks/phase-c-hardening.md  (this entry)
scripts/install-mac.sh  (+section_knowledge, +call in main)
scripts/recovery/src/manifest.ts  (DUPLICATION TODO header,
                                   phase_boundary_seen_at field)
```

#### Verification

- `bun test` (knowledge) → 90 tests, 195 expect() calls, all green.
- `bun run typecheck` (knowledge) → clean.
- `bun run lint` (knowledge) → clean.
- `bun test` (recovery) → still 68 tests green (manifest schema
  addition is round-trip compatible).
- `bash -n scripts/install-mac.sh` → syntax OK.

#### Hook registration

Both hooks land in `~/.claude/settings.json`:

- **Stop**: `bash ~/.argus/knowledge-stop-hook.sh` (calls
  `argus-knowledge learner-cadence`).
- **PostToolUse**: `bash ~/.argus/knowledge-posttool-hook.sh`
  (calls `argus-knowledge notepad-cap`).

Both wrappers `set -uo pipefail` (note: NOT `-e`) and trail `|| true`
on the bun call + always `exit 0`. A failed knowledge module never
blocks the agent.

#### Known limitations / deferred items

- **Schema duplication** (see above) — flagged in code (both
  manifest.ts header docstrings) and in this runbook. Cleanup is a
  Phase C+ extraction task.
- **learner-postprocess auto-trigger** — Phase D. Currently
  operator-invoked.
- **No live `claude --model haiku` smoke** — the default summarizer
  shells out to `claude` but tests use the injected stub. First
  real summary will happen on the first over-cap run during Block 6
  smoke testing.
- **classify-scope is heuristic, not learned** — `reasons[]` is the
  audit trail. If the operator sees a misclassification, they can
  manually move the SKILL.md and add a project-specific anchor (or
  remove an accidental one) to the body.

#### Fresh-worktree setup note

When working from a fresh clone or a freshly-created worktree, each
Bun subproject needs its `node_modules/` populated before its tests
will run. One-liner from the repo root:

```bash
for d in scripts/*/; do (cd "$d" && [[ -f package.json ]] && bun install); done
```

The committed `bun.lock` files in each subproject ensure the install
is deterministic.
