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
- [ ] Task 2.1: Watchdog as a Bun service (modular checks) — TDD
- [ ] Task 2.2: Linux systemd-watchdog integration
- [ ] Task 2.3: launchd plist (Mac) + smoke test

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
