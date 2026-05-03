# Phase C — Hardening for Marathon Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if executing in this session) to implement this plan task-by-task.

**Prerequisites:** Phase B merged to `main`, gates working end-to-end with Telegram + GitHub PR paths, ≥48h continuous bridge uptime.

**Goal:** Trust the system to run for 72+ hours unattended with a real workload, on either Mac or a Hetzner VPS. Add cost enforcement, a watchdog, automated recovery for the six failure modes from design §8, multi-day knowledge accumulation discipline, and a fully-provisioned VPS profile.

**Architecture:** Three new daemons / hooks alongside existing ones. (1) **Cost tracker** as a `PostToolUse` hook that atomically updates a sqlite-backed accumulator and emits clawhip events at threshold crossings. (2) **Watchdog** as a Bun service with modular health checks, systemd-watchdog protocol on Linux, and a dead-man's-switch path that bypasses clawhip via OMC's native callback. (3) **Recovery automation**: ralph cap + fake-completion guard + tmux stale-detect + provider fallback, all implemented as OMC skills/hooks rather than scattered shell. **VPS** moves to **Ansible** (declarative, idempotent, reusable for disaster recovery rebuilds) instead of bash. **`/learner` cadence** is enforced by the dispatcher skill at every phase boundary, with a trigger-collision skill-merge classifier.

**Tech Stack additions over Phase B:** Ansible 2.x, `chokidar` (better cross-platform fs watcher), better-sqlite3 (already present), dot-prop or similar for atomic JSON writes, Linux systemd watchdog protocol (sd_notify on VPS).

**Out of scope for Phase C** (deferred to Phase D):
- Submitting a real production workload (that's Phase D).
- Web dashboard, multi-user support, semantic skill search (explicitly excluded from v1 per design §11.3).

**Skills referenced:** `@superpowers:test-driven-development`, `@superpowers:verification-before-completion`, `@superpowers:systematic-debugging`.

---

## Pre-flight

- [ ] Phase B merged, runbook PASS verdict.
- [ ] Fresh worktree: `git worktree add .worktrees/phase-c-hardening -b phase-c/hardening` from main.
- [ ] You have a Hetzner Cloud account with API token (we'll provision a CX32 to test cutover).
- [ ] Local Ansible installed: `brew install ansible` (or `pipx install ansible-core`).

---

## Block 1 — Cost Tracker

### Task 1.1: Cost tracker hook (sqlite-backed accumulator) — TDD

**Why:** Per-run cost enforcement only matters in API mode, but the *infrastructure* must work even when Max20 is active (so the hook is always loaded but no-ops in Max20 mode). Atomic, race-safe, restart-safe = sqlite, not JSON.

**Files:**
- Create: `scripts/cost-tracker/package.json`, `tsconfig.json` (Bun TS project, mirror bridge structure)
- Create: `scripts/cost-tracker/src/accumulator.ts`
- Create: `scripts/cost-tracker/src/pricing.ts`
- Create: `scripts/cost-tracker/src/hook.ts` (entry point Claude Code calls as a `PostToolUse` hook)
- Create: `scripts/cost-tracker/tests/*.test.ts`

**Steps (TDD):**

1. **Tests:**
   - `Accumulator.add(run_id, tier, input_tokens, cached_input_tokens, output_tokens)` updates the row atomically.
   - Concurrent `add` calls don't lose updates (test by spawning 10 promises).
   - `getRun(run_id)` returns the running totals.
   - `crossesThreshold` returns the next un-emitted threshold (`warn` / `page` / `kill`) and marks it emitted (idempotent).
   - Pricing table is loaded from TOML via `Pricing.load(path)`; lookups by tier + token-type return €/token rates with sensible 6-decimal precision.
   - Hook's stdin handler validates the `PostToolUse` payload, extracts token counts, calls `accumulator.add`, exits 0 even on errors (a hook crash must NEVER block the agent).

2. **Implement** the accumulator on sqlite with a single `runs(run_id, ceiling_eur, spent_eur, by_tier_haiku, by_tier_sonnet, by_tier_opus, warn_emitted, page_emitted, kill_emitted, ...)` table. Use `BEGIN IMMEDIATE` transactions for the read-modify-write of the accumulator row.

3. **Pricing.toml** committed at `config/pricing.toml.example` with placeholder values; real values get sed-substituted at install time, OR loaded directly (no secrets in pricing — it's public). Key fields per tier:

```toml
[claude-haiku]
input_eur_per_million = 0.80
cached_input_eur_per_million = 0.10
output_eur_per_million = 4.00

[claude-sonnet]
input_eur_per_million = 3.00
cached_input_eur_per_million = 0.30
output_eur_per_million = 15.00

[claude-opus]
input_eur_per_million = 15.00
cached_input_eur_per_million = 1.50
output_eur_per_million = 75.00
```

4. **Tests pass. Commit.**

### Task 1.2: Threshold-event emission + clawhip wiring

**Why:** When the accumulator crosses 75% / 100% / 110%, it must (a) emit a clawhip event, (b) at 100% trigger `omc pause <run-id>`, (c) at 110% trigger `omc cancel <run-id>`. Triggering must be one-shot — `crossesThreshold` is idempotent.

**Steps:**

1. Test: a sequence of `add` calls that crosses each threshold once produces exactly one `cost.warn`, one `cost.page`, one `cost.kill` event (mocked via injected emitter).
2. Implement: at-end-of-`add`, check `crossesThreshold`; on result, call injected `emit(event, payload)` and (for page/kill) `pauseRun(run_id)` / `cancelRun(run_id)`.
3. The wire-up: `emit` is `clawhip send`; `pauseRun` / `cancelRun` are `omc pause` / `omc cancel`.
4. **Commit.**

### Task 1.3: Hook registration + Max20 no-op mode

**Files:** modify Phase A's hook bridge install. Add `cost-tracker` `PostToolUse` hook to `~/.claude/settings.json` alongside clawhip's own hooks. Hook reads `~/.claude/omc/argus/policy.toml` `[default] billing` value; if `max20`, hook returns immediately.

Verify by submitting a small `omc team` run in api mode with a tight ceiling (`--ceiling=0.50`) — it should `cost.kill` at ~€0.55 and cancel.

**Commit.**

---

## Block 2 — Watchdog

### Task 2.1: Watchdog as a Bun service (modular checks) — TDD

**Why:** A shell script can't be unit-tested cleanly. Bun + TS gives us testable check classes and a uniform retry/escalation pattern. Reuse the same project layout as the bridge.

**Files:**
- Create: `scripts/watchdog/` Bun project (mirror of `scripts/telegram-bridge/` structure)
- Create: `scripts/watchdog/src/check.ts` (interface)
- Create: `scripts/watchdog/src/checks/{clawhip,omc-wait,bridge}.ts`
- Create: `scripts/watchdog/src/escalation.ts` (handles restart + dead-man emission)
- Create: `scripts/watchdog/src/run.ts` (loop)
- Create: `scripts/watchdog/tests/*`

**Check interface:**

```ts
export interface Check {
  readonly name: string;
  check(): Promise<{ healthy: boolean; detail: string }>;
  restart(): Promise<{ ok: boolean; detail: string }>;
}
```

Each concrete check (`ClawhipCheck`, `OmcWaitCheck`, `BridgeCheck`) implements `check()` and `restart()`. Tests inject mock implementations.

**Run loop logic:**
- For each check: `check()`. If unhealthy, increment a per-check failure counter; on count ≥ 2 → `restart()`; on restart fail → escalation.
- Between check ticks: 30s.

**Tests:**
- Healthy check resets the counter to 0.
- 2 unhealthy → triggers restart exactly once.
- Restart success resets counter; restart fail triggers `escalate`.
- `escalate` calls `omc emit --tier critical --event clawhip.dead-man --message ...` (mocked).

**Implement. Tests pass. Commit.**

### Task 2.2: Linux systemd-watchdog integration

**Why:** On Linux (the VPS), systemd can ping the watchdog process itself — if the watchdog crashes, systemd restarts it. The watchdog uses `sd_notify(WATCHDOG=1)` to signal liveness back to systemd.

**Steps:**
1. Add `import { sdNotify } from "..."` (Bun has this via FFI to libsystemd — or shell out to `systemd-notify`).
2. In the run loop, every 15s send `WATCHDOG=1`.
3. systemd unit (created in Block 4) sets `WatchdogSec=60` and `Restart=on-watchdog`.

**Commit.**

### Task 2.3: launchd plist (Mac) + smoke test

Mirror Phase A's launchd template; runs the watchdog as `bun run scripts/watchdog/src/run.ts`. Use `StartInterval=300` if you want it on a timer, or `KeepAlive=true` if you want it always-on (recommended — keeps the failure detection latency low).

Manual chaos test:
- Kill clawhip with `pkill -9 clawhip`. Wait. Verify watchdog restarts it within 60-90s.
- Move `/usr/local/bin/clawhip` aside. Wait. Verify dead-man critical fires to Telegram.

Document chaos outcomes in runbook.

**Commit.**

---

## Block 3 — Recovery Matrix Automation

### Task 3.1: Ralph iteration cap + fake-completion guard

**Why:** OMC's `ralph` mode supports a `max_iter` cap; pin it to 30 in `policy.toml`. Add a `Stop`-hook guard that checks "did we just emit `<promise>DONE</promise>` without a `team-verify` pass within 5 min?" — if yes, treat as `agent.fake-completion` WARN and re-prompt. (Per design §8.4.)

**Files:**
- Modify: dispatcher skill (`skills/argus-router/SKILL.md` + lib)
- Add tests for the guard

**Steps (TDD):**
1. Test: hook input with a "DONE" claim and recent verify-pass log → returns "ok, stop".
2. Test: hook input with a "DONE" claim but no recent verify pass → returns a re-prompt + emits `agent.fake-completion`.
3. Implement, integrate.
4. **Commit.**

### Task 3.2: tmux stale-detect → auto-restart with checkpoint replay

**Why:** Per design §8.1.b, on stale → ONE auto-restart attempt with state replay from `runs/<run-id>/checkpoints/`.

**Files:** add `scripts/recovery/tmux-restart.ts` (called by clawhip's `tmux.stale` event handler — registered as a webhook route).

**Steps:**
1. Test: stale event arrives → script identifies the run from session name → finds latest checkpoint → restores `notepad.md` + `project-memory.json` to live paths → re-launches tmux session via `omc team --resume <run-id>`.
2. Tracks "restart attempted" in `manifest.json` so a second stale within 1h escalates to PAGE instead of restarting again.
3. **Commit.**

### Task 3.3: Provider-outage fallback (API ↔ Max20)

**Why:** Per design §7.5. Single hook that toggles the active credentials env var.

**Steps:**
1. Implement `scripts/recovery/provider-fallback.ts` that:
   - Detects `provider.outage` clawhip events.
   - Switches credentials in `~/.claude/settings.json` (or via env-var override export).
   - Emits `provider.fallback-engaged` WARN.
   - After 2h continuous outage in both modes, escalates to PAGE.
2. Tests: with mocked `clawhip status` and mocked credential file, verify each branch.
3. **Commit.**

### Task 3.4: Crash budget enforcement

**Why:** Per design §8.2. A counter in `runs/<run-id>/manifest.json` increments on (a) tmux auto-restart, (b) clawhip restart by watchdog, (c) verifier disagreement at 6th rejection. At 3 → halt with CRITICAL.

**Files:** small TS module imported by the recovery scripts, exposed via a CLI: `bun run argus-budget bump <run-id> <reason>`.

**Tests:**
- 1st bump → no escalation, returns count=1.
- 3rd bump → emits CRITICAL `crash-budget-exhausted`, calls `omc cancel <run-id>`.

**Commit.**

### Task 3.5: Recovery integration smoke (chaos suite)

**Why:** Each recovery is testable in isolation but they have to compose. Build a chaos suite as a runnable doc.

**Files:** `docs/runbooks/chaos-suite.md` listing 6 scenarios mirrored to design §8 modes (a-f). Each scenario lists: command to inject the failure, expected detection time, expected auto-response, expected escalation if auto-response fails.

Run all 6 manually against your live Mac stack. Document outcomes. Any deviation → fix the underlying bug, re-run.

**Commit.**

---

## Block 4 — VPS Provisioning (Ansible)

### Task 4.1: Ansible inventory + host bootstrap role

**Why:** A *declarative* provisioning is reproducible. If the VPS dies and you provision a new one, you re-run the same playbook and get an identical environment. Bash scripts for this kind of work decay; Ansible doesn't.

**Files:**
- Create: `ansible/inventory.yml` (defines `argus_vps` group, with placeholder `ansible_host`)
- Create: `ansible/playbooks/00-bootstrap.yml`
- Create: `ansible/roles/common/`
- Create: `ansible/roles/hardening/`

**`00-bootstrap.yml`:** runs as `root` on first boot, creates user `argus`, adds SSH key, disables password auth, enables UFW with `22/tcp` from Tailscale CIDR + `25294/tcp` from anywhere with HMAC-verified GitHub source IPs, enables fail2ban, enables `unattended-upgrades` on the security tier.

**`hardening` role:** sysctl tweaks (disable IP forwarding, enable SYN cookies), audit log to journal, disable unused services (snapd if present, etc.), set `systemctl --user` enabled for the `argus` user.

**Test on a throwaway Hetzner VPS (provision, run, destroy).** Document outcomes in runbook.

**Commit.**

### Task 4.2: `argus_stack` role — install OMC + clawhip + bridge + watchdog + cost tracker

**Why:** Translates Phase A/B/C install steps to Ansible tasks, idempotently.

**Files:** `ansible/roles/argus_stack/tasks/{main,brew_equivalent,omc,clawhip,bridge,watchdog,cost_tracker,services}.yml`.

Key differences from Mac:
- `apt` not `brew`.
- systemd units (committed in `systemd/` per Phase A design) not launchd plists.
- No `cloudflared` (use direct public IP + nginx + Let's Encrypt for the GitHub webhook + Telegram webhook ingress).
- Bun installed via official Linux installer.

**Each task uses an Ansible handler to restart the relevant service when its config changes** — proper idempotent reconfiguration on subsequent runs.

**Tests:** `molecule` (Ansible's testing framework) with a Docker container as ephemeral target. Validates `services` come up healthy after `argus_stack` runs.

**Commit.**

### Task 4.3: `cutover` playbook — migrate state from Mac to VPS

**Why:** Per design §10.3. Single Ansible playbook that orchestrates: stop Mac daemons → rsync four state dirs → start VPS daemons → verify health.

The playbook expects `mac_host` and `vps_host` ansible variables and uses `delegate_to` to run commands on each side from a control machine (your laptop).

**Steps:**
1. Author the playbook with sensible idempotency (running it twice should not corrupt state).
2. Run a **dry cutover**: provision a fresh CX32 with `argus_stack`, run cutover from Mac → VPS, verify all daemons healthy on VPS, run a smoke `omc team` from VPS, see Discord events flow. Then **revert** (stop VPS daemons, leave Mac as primary).
3. Document the dry-cutover wall-clock + any rough edges.

**Commit.**

### Task 4.4: nginx reverse proxy + Let's Encrypt on VPS

**Why:** Direct exposure of clawhip's port 25294 + bridge's port 9501 with TLS termination. nginx + certbot is the boring, reliable choice.

**Files:** `ansible/roles/nginx/`, with config templates per service. Auto-renew via certbot's systemd timer.

**Verify:** GitHub webhook deliveries succeed against `https://argus.<your-domain>/clawhip/github`. Telegram webhook against `https://argus.<your-domain>/telegram`. Both have HMAC verification middleware on top of TLS — defense in depth.

**Commit.**

---

## Block 5 — Knowledge Accumulation Discipline

### Task 5.1: `/learner` per-phase trigger

**Why:** Per design §9.1. Dispatcher skill's `Stop` hook checks "did this stop end a phase?" → if yes, append `/learner` to the next prompt automatically.

**Implementation:** small change in `skills/argus-router/lib/gate-controller.ts` — after gate approval, set a flag in `manifest.json` `next_prompt_prepend = "/learner"`; OMC's submit-hook reads + clears it.

Tests: phase-end transition with no `/learner` queued → it gets queued. Phase-end with `/learner` already in queue → no double-queue.

**Commit.**

### Task 5.2: Skill-scope classifier + collision-check post-processor

**Why:** Per design §9.2 + §9.5.

**Files:** `scripts/learner-postprocess/` Bun TS.

**Steps:**
1. Test: a `/learner` output with project-specific anchors (file paths, `@our-org/...` imports) → classifier returns `project`.
2. Test: an output with no anchors → returns `project` (safe default).
3. Test: an output with anchors removed → returns `user`.
4. After classification, runs trigger-collision check: Levenshtein distance + keyword overlap against existing skills. On collision → prepends `<!-- collision: candidate-merge with X -->` to the new skill file, emits WARN.

**Commit.**

### Task 5.3: Notepad 500-line cap + summarizer

**Why:** Per design §9.6.

**Files:** modify dispatcher's `PostToolUse` hook. When `notepad.md` exceeds 500 lines, invoke a Claude Haiku call (cheap) to compress to a structured summary, write the summary back, archive the old notepad to `runs/<run-id>/notepads/archive/<timestamp>.md`.

Tests: the summarizer is a pure function (input notepad string → output summary string + archive contents); test with golden examples.

**Commit.**

---

## Block 6 — Phase C Smoke + Verdict

### Task 6.1: First small migration run on a test repo

**Why:** Phase B's smoke was greenfield only. Phase C must exercise C-flow (harness as task zero, shadow comparison, fan-out auto-merge). Pick a *low-stakes* migration on a test repo: e.g., "rename all `oldFoo` to `newFoo` across our test repo and any consumers; make sure tests still pass."

Capture in runbook:
- Did harness gate (0a, 0b) work?
- Did first-batch eyes-on gate (gate 2) work?
- Did fan-out auto-merge (no human gate) work as expected, with harness validation gating each batch?
- Did `cost.warn`/`cost.page` fire if you set a tight ceiling?
- Did `/learner` produce useful skills at phase boundaries?
- Did the recovery matrix have any reason to fire? (Inject a chaos failure mid-run if not.)

### Task 6.2: 72h continuous-run dry test

**Why:** Trust building. Run *something* (a long-running synthetic task — e.g., `ralph: keep producing improvements to <small project> for 72h, with hourly digests`) and watch the system go for three days. This is the test that validates: log files don't bloat, sqlite queues don't unbounded-grow, daemons don't leak memory, OMC team mode doesn't cumulatively drift.

### Task 6.3: Phase C verdict + merge

Mirror Phase A/B verdict pattern. PASS-WITH-CAVEATS is fine if the 72h dry-run uncovered minor issues with concrete fixes. FAIL on anything where the system became silent (failure to alert is THE failure mode we built clawhip + watchdog to prevent).

---

## Phase C definition of done

- [ ] Cost tracker hook deployed; threshold events fire correctly under synthetic load.
- [ ] Watchdog running with chaos-tested restart and dead-man paths.
- [ ] All 6 recovery-matrix scenarios (design §8 a-f) tested with documented outcomes.
- [ ] First small migration run completed end-to-end (harness, gates, fan-out, auto-merge).
- [ ] 72h continuous-run dry test completed without silent failures.
- [ ] VPS provisioning playbook tested on a throwaway Hetzner CX32; cutover dry-run completed.
- [ ] `/learner` cadence active; at least one cross-run skill compounded.
- [ ] Notepad summarizer triggered + verified.
- [ ] Runbook 'Phase C Verdict' filled.
