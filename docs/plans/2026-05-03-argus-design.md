# Argus — Long-Horizon Agentic Engineering Team Design

| | |
|---|---|
| **Date** | 2026-05-03 |
| **Status** | Design validated; pre-implementation |
| **Owner** | Marian Gheorghe |
| **Repo** | `~/work/projects/argus` |

## Executive Summary

Argus is a thin wrapper around two upstream tools — **OMC** (`oh-my-claude-sisyphus`) and **clawhip** — plus ~5 small custom-glue components. It enables a single human to direct an autonomous engineering team that runs for hours, days, or weeks on **greenfield builds (A)** and **large migrations (C)**, with phone-friendly checkpoint approvals, three-tier escalation via Telegram + Discord, and a recovery matrix tuned for marathon operation.

The design deliberately excludes OmX (superseded by OMC) and OmO (duplicates OMC's orchestrator and adds a second runtime to babysit). Multi-provider failover, AST-aware refactors, and cross-model second-opinion review — the OmO features that genuinely matter — are absorbed as small OMC skills/hooks instead.

The system targets **2 human gates per greenfield run** and **4-5 gates per migration run**, each ~30 sec on phone, with full agent autonomy between gates.

---

## 1. Architecture Overview

```
                        Human (phone / laptop)
                         │
                         │  submit:    omc team "build X"   (terminal)
                         │  intervene: /pause /resume /cancel  (Telegram)
                         │  approve:   inline buttons           (Telegram)
                         ▼
       ┌─────────────────────────────────────────────────┐
       │  OMC (Claude Code)        — workflow + agents    │
       │  • team-plan → exec → verify → fix              │
       │  • tier-routed agents (Haiku/Sonnet/Opus)       │
       │  • ralph persistence (max 30 iter)              │
       │  • $OMC_STATE_DIR=$HOME/.claude/omc             │
       │  • omc wait daemon (rate-limit auto-resume)     │
       └────┬────────────────────────────────────┬───────┘
            │ git commits, tmux activity         │ stop callback
            ▼                                    ▼
       ┌────────────────────┐         ┌──────────────────────┐
       │  clawhip (daemon)  │         │  OMC native Telegram │
       │  • git source      │         │  callback (redundant │
       │  • github source   │         │  emission for CRIT)  │
       │  • tmux source     │         └────────┬─────────────┘
       │  • routes by tier  │                  │
       └────┬───────────────┘                  │
            │                                  │
            ├── INFO/WARN ──► Discord channel  │
            │                                  │
            └── PAGE/CRIT ──► Telegram bridge ─┴─► Telegram bot
                              (~30-line script)     (per-tier chats)
                                                       ▲
       ┌──────────────────┐                            │
       │  Watchdog cron   │ ──► dead-man's-switch ─────┘
       │  (every 5 min)   │     via OMC native callback
       └──────────────────┘     (independent path)
```

### Three load-bearing principles

1. **One orchestrator, one daemon.** No OmO, no OmX. Reduces failure surface for marathon runs.
2. **Two emission paths for CRITICAL events.** clawhip + OMC native callback both emit; Telegram receives twice. Either path failing leaves the other working.
3. **All state portable.** `$OMC_STATE_DIR=$HOME/.claude/omc`, no hardcoded paths. Mac → Hetzner cutover = `rsync` + start daemons.

---

## 2. Components & Responsibilities

Five components, each with a narrow charter. Argus only builds the last three; OMC and clawhip are upstream.

### 2.1 OMC (`oh-my-claude-sisyphus`) — *upstream, configured by Argus*

- Owns the entire engineering loop: plan → exec → verify → fix.
- Manages tier-routed agents (Haiku/Sonnet/Opus) and skill injection.
- Runs `team` mode with tmux + git worktrees per worker.
- Hooks: `SessionStart` (state re-hydrate), `PreCompact` (notepad flush), `Stop` (persistent-mode + native callback emission).
- Daemons: `omc wait` (rate-limit auto-resume).
- State root: `$OMC_STATE_DIR = $HOME/.claude/omc` (centralized, worktree-independent).

### 2.2 clawhip — *upstream, configured by Argus*

- Event sources: `git` (commit/branch poll), `github` (webhook receiver), `tmux` (keyword + stale-minutes).
- Routes events to sinks via `[[routes]]` config (glob match on event name + filter on repo/worktree).
- Sinks: Discord bot/webhook (built-in), generic webhook (used for the Telegram bridge).
- Native hook bridge: receives `SessionStart`/`PreToolUse`/`Stop` payloads from OMC via `clawhip native hook --provider claude-code`.

### 2.3 Telegram bridge — *Argus, ~30 lines, `scripts/telegram-bridge.ts`*

- HTTP receiver listening on `127.0.0.1:9501` (clawhip routes PAGE/CRIT events here as generic webhooks).
- Maps event severity → target chat (`#argus-page`, `#argus-critical`, `#argus-gates`).
- Calls Telegram Bot API to post messages with inline approve/reject/defer buttons for gate events.
- Bot callback URL receives button taps, writes approval to `$OMC_STATE_DIR/gates/<gate-id>.decision.json` which OMC polls.

### 2.4 Watchdog cron — *Argus, `scripts/watchdog.sh`*

- Runs every 5 min via launchd (Mac) / systemd timer (VPS).
- Three checks: (a) `clawhip status` health, (b) `omc wait` daemon alive, (c) Telegram bridge port responding.
- On 2 consecutive failures of any check: attempt restart, then emit dead-man's-switch CRITICAL via OMC native callback (independent path, doesn't rely on clawhip).

### 2.5 Dispatcher skill — *Argus, `skills/argus-router/SKILL.md`*

- Project-scoped OMC skill that fires on submit.
- Reads `$OMC_STATE_DIR/argus/policy.toml` for the cost ceiling, billing mode, gate count, and concurrency profile per submit.
- Tags the run with a run-id (timestamp + git short hash + slug) and registers it with clawhip via `clawhip session started`.

---

## 3. Use Cases & Flow

### 3.1 Greenfield (A) — `A3 + agent-at-gate-1`

```
[Human@laptop]                          [Argus]
─────────────────                       ─────────────────────────────
omc team "build payment service"  ───►  dispatcher skill assigns run-id
                                        OMC architect (Opus) drafts PRD
                                        ↓
                                        Gate 1: PRD approval
                                        clawhip emits gate.pending → Telegram
[Human@phone]
─────────────────
✅ Approve  ◄────────────────────────── Telegram inline button
                                        ↓
                                        OMC team mode spins up 3 workers:
                                          • backend  (Sonnet, worktree)
                                          • frontend (Sonnet, worktree)
                                          • infra    (Sonnet, worktree)
                                        ralph loop until verifier passes
                                        ↓
                                        Workers integrate, push PR
                                        clawhip detects PR via github source
                                        ↓
                                        Gate 2: pre-merge PR review
[Human@phone, GitHub mobile]
─────────────────
✅ Approve PR ──────────────────────►   clawhip detects approval
                                        OMC merges, closes run
                                        Telegram: "✅ run-<id> done"
                                        /learner fires (per-phase boundary)
```

**2 gates total**, ~30 sec human time per gate. Bulk of work (build phase) is fully autonomous.

### 3.2 Migration (C) — `C3 + harness as task zero`

Same shape, with **Phase 0** prepended for harness setup:

1. **Gate 0a** — harness PRD approval (Telegram). What gets shadow-compared? What counts as divergence?
2. **Gate 0b** — harness PR review (GitHub PR for the harness itself, validated against current code with 0 divergence baseline).
3. **Gate 1** — migration PRD approval (Telegram). Patterns, batch order, edge cases.
4. **Gate 2** — first-batch PR review (GitHub PR for first batch only — eyes-on, deliberate).
5. **Fan-out batches: NO human gate.** Each batch opens its own PR, **auto-merges if shadow-harness shows zero divergence**. Human paged ONLY if harness flags any difference.
6. **Gate 3** — final integration PR (GitHub PR, sanity-check after fan-out).

**4-5 gates total** over 3-5 days. Fan-out (the bulk) is truly autonomous; harness gates each batch mechanically.

---

## 4. Gate Model & Telegram UX

### 4.1 Gate state machine

```
              ┌──────────┐
              │ pending  │ ← created by orchestrator at phase boundary
              └────┬─────┘
                   │ Telegram message sent
                   │ 8h countdown starts
                   ▼
        ┌─────────────────────┐
        │  awaiting-decision  │
        └──┬─────┬─────┬──────┘
           │     │     │
     tap ✅│  tap❌│  tap⏸ │  no tap @ 8h
           │     │     │     │
           ▼     ▼     ▼     ▼
       approved rejected deferred timeout
                  │       │       │
                  │       │       ▼
                  │       │   PAGE → escalate
                  │       │   (waits for SSH continue)
                  │       │
                  │       ▼
                  │   speculative-continue
                  │   (work proceeds on isolated branch
                  │    until decision returns; if rejected,
                  │    branch discarded)
                  ▼
              re-architect
              (rejection comment piped to architect agent)
```

### 4.2 Gate types

| Gate type | Approval channel | Auto-approve possible? |
|---|---|---|
| `PRD` (planning artifact) | Telegram inline buttons | No — humans must read the plan |
| `code-review` (PR) | GitHub PR review | **Yes**, if harness passes AND `auto_merge_on_clean_harness=true` AND it's a fan-out batch |
| `final-integration` (PR) | GitHub PR review | No — final sanity-check is always human |

### 4.3 Gate file contract

Gates live as files under `$OMC_STATE_DIR/gates/`:

- `<gate-id>.pending.json` — written by OMC orchestrator. Contains: title, summary (3-5 lines), key-decisions list, artifact path, diff link, created-at timestamp, timeout (default 8h, overridable per gate).
- `<gate-id>.decision.json` — written by Telegram bridge when human taps a button. Contains: decision (`approved`/`rejected`/`deferred`), comment (optional), decided-at, decided-by chat-id.

OMC polls `gates/` directory once every 30 sec (cheap) for new `.decision.json` files matching its open gates. File-based contract means no socket/IPC; either side can be restarted without losing the gate.

### 4.4 Telegram message format (PRD gate, "Standard" verbosity)

```
🚪 Gate 1 — PRD approval (run argus-2026-05-03-payment)

Summary:
  Stripe-based payment service. Postgres for persistence, Redis for
  idempotency keys. Three endpoints: create-intent, webhook-stripe,
  refund. Auth via existing JWT middleware. Deploy to Fly.io.

Key decisions:
  • Stripe SDK v15 (latest stable)
  • Idempotency: 24h TTL in Redis
  • Webhook retry: 3 attempts, exponential backoff
  • Test strategy: stubbed Stripe SDK in unit tests, live key in CI

Artifact: $OMC_STATE_DIR/argus-2026-05-03-payment/prd.md
Diff:     (none — gate 1, no code yet)

Times out at: 2026-05-04 07:30 (in 7h 58m)

[ ✅ Approve ]  [ ❌ Reject + comment ]  [ ⏸ Defer 4h ]
```

### 4.5 Reject flow

Tap `❌` → Telegram bot opens reply prompt ("What's wrong with this plan?"). Human types one line, sends. Bridge writes `<gate-id>.decision.json` with `decision: "rejected", comment: "..."`. OMC's architect re-runs with the rejection comment injected as: `Human rejected the previous plan. Reason: "<comment>". Revise the plan addressing this.`

### 4.6 Defer flow (speculative-continue)

Tap `⏸ Defer 4h` → bridge writes deferral, OMC marks gate as `deferred-speculative`. Workers proceed on a branch named `speculative/<run-id>/<gate-id>`. If human eventually approves, branch promotes to the run's main branch. If rejected, branch is preserved for forensic review but never merged. Defer extends timeout by 4h; second defer = mandatory PAGE.

### 4.7 Where commits go (no human gates here)

Inside each phase, agents commit autonomously to **per-worker branches** (OMC team mode default). Many commits per phase, full autonomy, no human review. clawhip emits INFO-level events for these commits. Gates only happen at **phase boundaries** — never per commit.

---

## 5. Escalation & Observability

### 5.1 Channel topology

**Discord** (`server: argus-runs`):
- `#runs-info` — every commit, agent transition, gate passed, hourly digest. No notification.
- `#runs-warn` — degraded events. Posted with `<@user>` mention. **Batched 11pm-7am into a single 7am digest** (per `7e:B`).

**Telegram** (one bot, three chats):
- `#argus-page` — gate timeouts, all-workers-stuck, irrecoverable agent crash, cost ceiling 100%, provider outage > 2h. Always real-time.
- `#argus-critical` — harness regression (C), dead-man's-switch, cost-kill (110%), host reboot. Always real-time. **Dual-emission**: clawhip bridge AND OMC native callback both post here.
- `#argus-gates` — gate approval messages with inline buttons.

### 5.2 Event-to-tier matrix

| Tier | Event family | Examples |
|---|---|---|
| INFO | `git.*`, `agent.{started,finished}`, `gate.{approved,passed}`, phase transitions, hourly digest | routine traffic |
| WARN | `agent.failed` (1 worker, others healthy), `omc.rate-limit-pause` (>30min), `harness.flake` (re-run passed), `cost.warn` (75%), `agent.loop-exhausted` (1st time on a task) | degraded but progressing |
| PAGE | `gate.timeout`, `agents.all-stuck`, `agent.crash-budget-exhausted` (3rd crash), `cost.page` (100%), `provider.outage` (>2h), `agent.loop-exhausted` (2nd time, same task) | stop-the-line |
| CRITICAL | `harness.regression` (C divergence), `cost.kill` (110%), `clawhip.dead-man`, `host.rebooted`, `omc.wait-stalled` (>2h queued) | dual-emit, voice-call equivalent |

### 5.3 clawhip routing config (excerpt)

```toml
[[routes]]
event = "agent.failed"
filter = { worker_count = "1+remaining" }
sink = "discord"
channel = "<runs-warn-id>"
mention = "<@marian>"

[[routes]]
event = "gate.timeout"
sink = "webhook"
url = "http://127.0.0.1:9501/page"   # Telegram bridge

[[routes]]
event = "harness.regression"
sink = "webhook"
url = "http://127.0.0.1:9501/critical"
# OMC native callback also fires for this event — redundancy is intentional

[dispatch]
routine_batch_window_secs = 5
ci_batch_window_secs = 60
quiet_hours_local_for_warn = "23:00-07:00"
```

### 5.4 Watchdog cron

`scripts/watchdog.sh`, runs every 5 min:

1. `curl -sf http://127.0.0.1:25294/status` (clawhip health) — fail twice → `systemctl restart clawhip` / `launchctl kickstart`
2. `pgrep -f "omc wait"` — fail twice → restart
3. `curl -sf http://127.0.0.1:9501/health` (Telegram bridge) — fail twice → restart
4. **If any restart fails:** emit dead-man via OMC native callback directly: `omc emit --tier critical --event clawhip.dead-man --message "..."`. This path doesn't go through clawhip, so it works even if clawhip itself is the problem.

### 5.5 Sidecar guarantee

clawhip is push-based via OMC hooks (`SessionStart`/`Stop`/`PostToolUse`). Agents don't know about clawhip — they emit hook payloads as part of normal Claude Code lifecycle, and clawhip parses + routes externally. Agents never spend tokens on "should I notify Discord?"

---

## 6. State & Persistence

All state under `$HOME/.claude/omc/` (via `OMC_STATE_DIR`), with `$HOME/.clawhip/` for clawhip and `$HOME/.argus/` for argus-specific config. No hardcoded user paths — entire state tree `rsync`s cleanly Mac → Hetzner.

### 6.1 State tree

```
$HOME/.claude/omc/                       ← OMC_STATE_DIR
├── runs/
│   └── <run-id>/                        ← per-run, frozen at end
│       ├── manifest.json                  run metadata, phase markers, gate decisions
│       ├── prd.md                         architect's plan (gate 1 artifact)
│       ├── harness.md                     harness PRD (C only, gate 0a)
│       ├── notepad.md                     current-session scratch
│       ├── project-memory.json            durable cross-session memory
│       ├── plans/                         OMC plan documents
│       ├── notepads/<plan>/{learnings,decisions,issues,problems}.md
│       ├── sessions/<sid>/                per-session detail (replay logs)
│       ├── checkpoints/                   per-phase + 30min snapshots
│       ├── cost.json                      live cost tracker (API mode only)
│       └── logs/
├── gates/                               ← OMC ↔ Telegram bridge contract
│   ├── <gate-id>.pending.json
│   └── <gate-id>.decision.json
├── team/
│   └── <team-name>/
│       ├── state/                         leader state
│       └── worktrees/<worker>/            git worktrees (one per worker)
├── skills/                              ← project-scoped skills (per-project repo)
└── argus/
    ├── policy.toml                      ← cost ceiling, billing mode, gate count, concurrency
    ├── runs-index.jsonl                   append-only index of every run started
    └── learnings.jsonl                    cross-run /learner output

$HOME/.omc/skills/                       ← user-scoped skills (cross-project)
$HOME/.clawhip/
├── config.toml                            clawhip routes + sources
├── project.json                           project metadata
└── state/prompt-submit.json               clawhip's own state

$HOME/.argus/
├── telegram-bridge.env                    bot token, chat IDs (gitignored)
├── github-app.pem                         GitHub webhook auth (gitignored)
└── secrets.env                            ANTHROPIC_API_KEY for API mode (gitignored)
```

### 6.2 Run-id scheme

`<YYYY-MM-DD>-<short-slug>-<git-short-hash>` — e.g., `2026-05-03-payment-svc-a3f81c2`.

### 6.3 Checkpoint policy

Two triggers:

1. **Phase transitions** (every gate boundary). OMC orchestrator calls `argus-checkpoint <run-id> <phase>` which `cp -a`s `runs/<run-id>/{notepad.md,project-memory.json,plans/}` into `runs/<run-id>/checkpoints/phase-<n>-<timestamp>/`.
2. **30-min cadence** during long phases. Same script, run via the watchdog cron when `phase-elapsed > 30min`.

Recovery on crash: most recent checkpoint is restored to live paths. Worst-case loss = 30min of progress + whatever wasn't committed to git.

### 6.4 Git as the durable progress backbone

Every commit on every worker branch is durable. State files (`notepad.md`, `project-memory.json`) are recoverable-but-best-effort. **Anything that absolutely must survive any failure mode goes into a git commit.** State files are an optimization to avoid recomputation, not a source of truth.

### 6.5 Cross-machine portability

```bash
rsync -aP marian@mac.tailnet:.claude/omc/ ~/.claude/omc/
rsync -aP marian@mac.tailnet:.omc/         ~/.omc/
rsync -aP marian@mac.tailnet:.clawhip/     ~/.clawhip/
rsync -aP marian@mac.tailnet:.argus/       ~/.argus/
systemctl --user start clawhip telegram-bridge omc-wait watchdog.timer
```

Same Telegram bot, same Discord channels, same routing — config carries over verbatim.

### 6.6 What's NOT persisted

- tmux session state (sessions die on reboot; agents replay from `notepad.md` on next launch).
- in-flight clawhip mpsc queue contents (volatile by design; daemon restart loses ~5sec of unbatched events).
- LLM context windows mid-prompt.

---

## 7. Cost & Rate-Limit Strategy

Two billing modes, picked at submit time. Cost enforcement only active in API mode.

### 7.1 Mode selection

`omc team --billing=max20` (default) or `omc team --billing=api`.

```toml
# $HOME/.claude/omc/argus/policy.toml
[default]
billing = "max20"
api_ceiling_eur = 50
api_ceiling_overridable = true

[tier_thresholds]
warn = 0.75
page = 1.00
kill = 1.10
```

Override at submit: `omc team --billing=api --ceiling=200 "..."`.

### 7.2 Max20 mode (default)

- Subscription = ~$200/mo Max20 plan, no per-token cost.
- Hits 5h rate-limit windows under heavy load.
- `omc wait` daemon is **mandatory** — handles waiting through resets. Watchdog cron checks it.
- During wait windows, clawhip emits `omc.rate-limit-pause` (INFO if <30min, WARN if >30min). After 2h continuous wait → PAGE.
- No cost ceiling logic active. `cost.json` not written.

### 7.3 API mode

Cost-tracker hook (`PostToolUse`) reads token usage from each Claude API response, accumulates to `runs/<run-id>/cost.json`:

```json
{
  "ceiling_eur": 50,
  "spent_eur": 12.47,
  "by_tier": { "haiku": 0.81, "sonnet": 7.32, "opus": 4.34 },
  "by_phase": { "plan": 1.20, "build": 9.41, "verify": 1.86 },
  "warn_emitted": false,
  "page_emitted": false,
  "kill_emitted": false,
  "last_update": "2026-05-03T22:14:38Z"
}
```

After each accumulation, hook checks ratio against thresholds:
- 75% → `cost.warn` (idempotent)
- 100% → `cost.page` + `omc pause <run-id>` (halts pending decision)
- 110% → `cost.kill` + `omc cancel <run-id>` (force-stop, state preserved)

### 7.4 Tier-routing strategy

OMC's tier-routed agents pinned in `policy.toml` so future OMC versions can't silently change defaults:

| Task class | Default tier | Rationale |
|---|---|---|
| Codebase exploration, grep, file listing | `executor-low` (Haiku) | bulk reads, cheap |
| Routine code edits | `executor` (Sonnet) | the workhorse |
| PRD writing, architecture decisions | `architect` (Opus) | front-loaded one-time cost |
| Verification / critic / code review | `code-reviewer` (Opus) | catches drift, worth the spend |
| `team-verify` 7-check enforcement | `executor` (Sonnet) | mostly mechanical |
| `/learner` skill extraction | `executor-low` (Haiku) | extraction is structured, cheap |

Realistic burn estimate on typical A+C work: **€10-25/day** in API mode.

### 7.5 Provider outage fallback

```toml
[fallback]
enabled = true
api_to_max20_after_minutes = 30
max20_to_api_after_minutes = 30
emit_warn_on_switch = true
```

Switch is a hook that toggles the active credential env. clawhip emits `provider.fallback-engaged` WARN. After 2h of continuous outage in BOTH modes, PAGE.

---

## 8. Failure Recovery

### 8.1 Recovery matrix

| # | Failure mode | Detection | Auto-response | Escalation if auto-response fails |
|---|---|---|---|---|
| **a** | Single agent stuck in ralph loop | iteration counter ≥ 30 | emit `agent.loop-exhausted` (WARN), inject "stop, summarize, request architect review" prompt | 2nd loop-exhausted on same task in same phase → PAGE; architect re-plans |
| **b** | tmux session dies (worker crash, OOM) | clawhip `tmux.stale-minutes ≥ 20` | watchdog cron tries ONE auto-restart with state replay from `runs/<run-id>/checkpoints/` | restart fails OR session goes stale again within 1h → PAGE |
| **c** | clawhip daemon dies | watchdog `curl /status` fails twice | `systemctl restart clawhip` (or `launchctl kickstart`) | restart fails → CRITICAL via OMC native callback (independent path) |
| **d** | Host reboots | systemd-wide; daemons restart, but in-flight tmux runs do NOT auto-resume | nothing — by design | every active run at reboot time gets a CRITICAL "host rebooted, run X paused, manual `omc resume` required" |
| **e** | Verifier-executor permanent disagreement | rejection counter on a single task | 3 rejections → escalate to architect for re-plan; rejection comment piped to architect prompt | 6 rejections → PAGE ("plan is wrong, need human") |
| **f** | Provider outage (Anthropic 503s) | OMC retry exhaustion + outage classifier | inline fallback per §7.5 | 2h continuous outage in both modes → PAGE |

### 8.2 Crash budget

A crash counter lives in `runs/<run-id>/manifest.json`. Increments on (b) auto-restart, (c) clawhip restart, (e) verifier-executor disagreement at 6-rejection threshold. **At 3 total crashes within a single run, halt the entire run with a CRITICAL event.**

### 8.3 Resume-on-reboot

Default policy: **pause and require manual `omc resume <run-id>`**. Watchdog cron at boot:

1. Scans `runs/*/manifest.json` for `state: "running"` at last write.
2. For each, sets `state: "paused-by-reboot"`.
3. Emits CRITICAL "host rebooted, N runs paused" via OMC native callback.
4. Does NOT auto-restart anything.

### 8.4 Verifier bypass guard

OMC's ralph verifier already enforces 5-min freshness on `team-verify` evidence. Argus adds a second guard against the OmO-style fake `<promise>DONE</promise>` bypass: the dispatcher skill's `Stop` hook validates that any "completion" claim coincides with an actual `team-verify` pass within the last 5 min. If no pass, the "completion" is treated as `agent.fake-completion` WARN and the agent is re-prompted.

### 8.5 Out of scope for v1

- Network partition between Mac/VPS and Anthropic API for >24h.
- Disk full on host (alerts but does not auto-prune).
- Telegram global outage (Discord WARN traffic still flows; absence-of-event is the signal via hourly heartbeats).

---

## 9. Knowledge Accumulation

### 9.1 `/learner` cadence

`/learner` fires automatically at every phase boundary — i.e., after each gate clears. Dispatcher skill's `Stop` hook checks: "did this Stop end a phase?" → if yes, append `learner` to the next prompt. Secondary trigger: end-of-run, scoped to whole run.

### 9.2 Two-tier skill scoping

| Scope | Path | Contents | Bleed across projects? |
|---|---|---|---|
| **Project** | `<project-repo>/.omc/skills/` | repo-specific patterns: codebase conventions, model names, library versions | No — committed to project repo |
| **User** | `$HOME/.omc/skills/` | truly-generic patterns: TDD discipline, common error fixes, framework-agnostic | Yes — applied across every Argus run |

`/learner`'s output classifier decides scope per pattern; ambiguous defaults to project scope (safe; promotable later).

### 9.3 What gets captured

1. **Patterns** (positive) — "When you see X, do Y."
2. **Anti-patterns** (negative) — "Avoid X because Y."
3. **Decisions** — durable architectural calls written to `runs/<run-id>/notepads/<plan>/decisions.md`. Not promoted to skills.
4. **Issues / problems** — observed-but-unresolved snags. Periodic `/learner` review may promote these to anti-patterns.

### 9.4 Cross-run knowledge index

`$HOME/.claude/omc/argus/learnings.jsonl` — append-only. Every `/learner` invocation appends one line:

```json
{
  "run_id": "2026-05-03-payment-svc-a3f81c2",
  "phase": "build",
  "scope": "user",
  "skill_path": "$HOME/.omc/skills/handle-stripe-webhook-retry/SKILL.md",
  "trigger_summary": "stripe webhook signature verification",
  "extracted_at": "2026-05-04T08:14:21Z"
}
```

Dispatcher reads index at submit time, hints architect: "previous learnings for this trigger exist at <path>; consider reusing them."

### 9.5 Anti-bloat

1. **Trigger collision check at write time** — when `/learner` writes a new skill, dispatcher post-processor checks for existing skills with overlapping triggers. If found → emit WARN, write the new skill anyway, tag it `<!-- collision: candidate-merge with X -->`.
2. **Quarterly skill audit** (manual): `omc team "audit skill library, propose merges/deletes for skills with trigger overlap or low usage"`. Outputs report; human reviews + bulk-applies.

Audit cadence is **manual, not automatic** — auto-pruning skills you might still need is exactly the kind of thing that goes wrong at 4am.

### 9.6 Notepad hygiene

`PreCompact` hook flushes `notepad.md` to `project-memory.json` before context wipes. Argus adds: **`notepad.md` MUST stay under 500 lines**. Above that, dispatcher's `PostToolUse` hook calls `learner-summarize-notepad`, which compresses to a structured summary and resets.

---

## 10. Infra & Portability

### 10.1 Mac-now (Phase 1)

**Required brew packages:**
```
brew install tmux node@20 cloudflared cargo
brew install --cask tailscale
```

**OMC + clawhip install:**
```
npm i -g oh-my-claude-sisyphus@latest
omc setup
cargo install clawhip
clawhip setup --bot-token ... --default-channel ... --daemon-base-url http://127.0.0.1:25294
```

**Daemons via `launchd`** — four plists in `~/Library/LaunchAgents/`, generated by `scripts/install-mac.sh`:

| Plist | What it runs | KeepAlive |
|---|---|---|
| `com.argus.clawhip.plist` | `clawhip serve` | true |
| `com.argus.omc-wait.plist` | `omc wait --start` | true |
| `com.argus.telegram-bridge.plist` | `bun run scripts/telegram-bridge.ts` | true |
| `com.argus.watchdog.plist` | `scripts/watchdog.sh` | StartInterval=300 |

**Sleep prevention** — `caffeinate -dimsu` wraps the master tmux session. Dispatcher skill's submit hook auto-prepends it on Mac.

**GitHub webhook ingress** — Cloudflare Tunnel (free, persistent URL):
```bash
cloudflared tunnel create argus-clawhip
cloudflared tunnel route dns argus-clawhip argus-webhooks.<your-domain>.com
cloudflared tunnel run --url http://127.0.0.1:25294 argus-clawhip
```

**Remote attach** — Tailscale on Mac. SSH from phone (Termius/Blink) to `mac.tailnet.ts.net`, `tmux a -t <run-id>` to observe live agent panes.

### 10.2 Hetzner-later (Phase 2)

**Target:** CX32 (€7.59/mo, 4 vCPU, 8GB RAM, 80GB SSD). CX22 too tight for team mode + daemons + tmux scrollback.

**Provisioning** — `scripts/install-vps.sh`, idempotent, expects fresh Ubuntu 24.04:

```bash
apt-get install -y tmux nodejs cargo ufw fail2ban
# tailscale (official one-liner)
# unattended-upgrades enabled, security tier only
# create non-root user 'argus', SSH key only, no password
# clawhip via cargo, OMC via npm (under user 'argus')
# direct public IP for GitHub webhooks (no Cloudflare Tunnel needed)
# UFW: SSH 22 from tailscale CIDR only, 25294 from anywhere with HMAC verify
```

**systemd units in `systemd/`** (committed to repo):

| Unit | After= | Restart= |
|---|---|---|
| `clawhip.service` | network.target | always |
| `omc-wait.service` | clawhip.service | always |
| `telegram-bridge.service` | network.target | always |
| `watchdog.timer` + `watchdog.service` | — | OnCalendar=*:0/5 |

`User=argus`, `Environment=OMC_STATE_DIR=/home/argus/.claude/omc`. No services run as root.

### 10.3 Cutover (~30 min, one-shot)

```bash
# Mac: stop daemons cleanly
launchctl unload ~/Library/LaunchAgents/com.argus.*.plist
omc cancel --all-active --reason "host migration"

# Hetzner: prep, then sync state from Mac
scripts/install-vps.sh
ssh argus@vps "rsync -aP marian@mac.tailnet:.claude/omc/ ~/.claude/omc/"
ssh argus@vps "rsync -aP marian@mac.tailnet:.omc/ ~/.omc/"
ssh argus@vps "rsync -aP marian@mac.tailnet:.clawhip/ ~/.clawhip/"
ssh argus@vps "rsync -aP marian@mac.tailnet:.argus/ ~/.argus/"

# Update GitHub webhook URLs to direct VPS public IP
# Update Telegram bot's webhook URL (if using webhook, not polling)

# Hetzner: start services
ssh argus@vps "systemctl --user daemon-reload"
ssh argus@vps "systemctl --user enable --now clawhip omc-wait telegram-bridge watchdog.timer"

# Verify
ssh argus@vps "systemctl --user status clawhip omc-wait telegram-bridge"
```

### 10.4 DNS / certs

If using direct public IP on Hetzner with a domain: A record → VPS IP, certbot Let's Encrypt cert, clawhip behind nginx reverse-proxy for TLS termination on GitHub webhook ingress. Optional for v1.

### 10.5 Backups

1. **Push to git** — at every checkpoint, `git -C $HOME/.argus-state-backup commit` of the diff. Local-only.
2. **Hetzner snapshot** — daily volume snapshots (€0.01/GB-month).

---

## 11. Operational UX & Phased Rollout

### 11.1 Day-to-day UX

**At submission (terminal):**
```bash
omc team --billing=max20 "build payment service with Stripe integration..."
omc team --billing=api --ceiling=80 "migrate auth from old to new"
omc team --resume <run-id>
omc team --resume <run-id> --override-policy ceiling=100
```

**Mid-run from Telegram:**

| Chat | Direction | Commands / messages |
|---|---|---|
| `#argus-gates` | bot → human | `🚪 Gate <n> — <title>` with inline buttons |
| `#argus-gates` | human → bot | tap inline buttons; reject opens reply-prompt |
| `#argus-page` | bot → human | `🚨 PAGE — <event>` + `[ /pause ] [ /status ] [ /cancel ]` |
| `#argus-critical` | bot → human | `🚨🚨 CRITICAL — <event>` + run-id + log link |
| any chat | human → bot | `/list` `/status <run-id>` `/pause <run-id>` `/resume <run-id>` `/cancel <run-id>` `/digest` |

`/digest` returns the WARN-tier batch since last digest plus a one-paragraph "what's happened since last digest" summary generated cheaply via Haiku.

**Mid-run from terminal (depth):**
```bash
omc list                              # all runs, status, phase, cost
omc status <run-id>                   # full run detail
omc tail <run-id>                     # follow logs live
tmux a -t <run-id>-leader             # attach to OMC's tmux session
omc pause <run-id>                    # halt at next safe boundary
omc resume <run-id>
omc cancel <run-id> --keep-state      # stop run, preserve checkpoints + worktrees
```

### 11.2 Phased rollout

**Phase A — Single-runtime baseline (1-2 days)**

Goal: prove OMC team mode runs unattended for 8h on a small greenfield task with INFO-only Discord logging.

- Install OMC + clawhip per §10.1.
- Configure `OMC_STATE_DIR`, `omc wait`, basic clawhip routing for `git.commit` + `agent.*` → Discord `#runs-info`.
- Skip Telegram bridge, cost tracker, watchdog. Keep system in your face.
- Submit a small greenfield task ("build a CLI todo app in TypeScript"), supervise, fix breakage as found.

**Phase B — Gate model + Telegram (3-4 days)**

Goal: real autonomy with checkpoint gates and phone-from-bed approvals.

- Build Telegram bridge (`scripts/telegram-bridge.ts`).
- Implement gate file contract (`gates/*.{pending,decision}.json`).
- Configure clawhip routes for `gate.pending` → Telegram bridge.
- Implement §4 gate state machine in dispatcher skill.
- Test on a 24h greenfield run with one PRD gate + one PR gate.

**Phase C — Hardening for marathon (4-6 days)**

Goal: trust this thing for 72h+ unattended.

- Cost tracker hook (`scripts/cost-tracker.ts`) + `policy.toml` enforcement.
- Watchdog cron (`scripts/watchdog.sh`) + dead-man's-switch.
- Recovery matrix (§8) implemented end-to-end.
- `/learner` cadence + skill scoping per §9.
- First migration run (small, low-stakes).
- VPS provisioning script + cutover dry-run.

**Phase D — Real workload (open-ended)**

Submit an actual A or C job that you'd otherwise spend a week on. Watch what breaks. Iterate.

### 11.3 v1 explicitly does NOT include

- Web dashboard.
- SMS/voice paging (Telegram-only, dual-emission for CRITICAL).
- Multi-user support (single human, single Telegram chat-id allowlist).
- Semantic search over learnings.jsonl.
- Agent-cost prediction/forecasting (only post-hoc tracking).
- Slack integration (Discord + Telegram only).

---

## 12. Decision Log

The locked-in choices from brainstorming (2026-05-03 session):

| ID | Decision | Choice |
|---|---|---|
| Q1 | Use case shape | A (greenfield) + C (migration) |
| Q2/Q3 | Tool overlap resolution | Drop OmO + OmX. OMC + clawhip + custom glue only |
| Q4 | Autonomy model | B — async checkpointed gates |
| Q5 | Done criteria — greenfield | A3 — goal + emergent spec |
| Q5 | Done criteria — migration | C3 — parallel-run / shadow comparison |
| Q5b | Done artifact author | Agent at gate 1, human approves |
| Q5c | Verification harness | Build as task zero (C only) |
| Q6a | Repo topology | B — two repos, A in repo-new, C in repo-old |
| Q6b | Concurrency | Adaptive: 1 at gates, 3 in build (A), 1→2-3 in migration (C), 1 in verify |
| Q7a | Escalation tier model | B — 3-tier (info / warn / page) |
| Q7c | Gate timeout default | B — 8h |
| Q7d | Page channel | Telegram (OMC native + clawhip-bridge), dual-emission for CRITICAL |
| Q7e | Quiet hours | B — quiet-hours batching for WARN only |
| Q8 | Infra | Mac now → Hetzner CX32 Ubuntu later |
| Q9a | Billing | A primary (Max20), API switchable per-submit |
| Q9b | API ceiling | B — €50 default, configurable |
| Q9c | Ceiling enforcement | C — tiered (75% warn / 100% page / 110% kill) |
| Q10a | Ralph iteration cap | 30 |
| Q10g | Resume on reboot | C — pause + manual continue |
| Q10h | Crash budget | B — 3 crashes → halt |
| Q10i | Checkpoint cadence | B — per-phase + 30min |
| Q11a | Gate UX | Telegram inline buttons (PRD), GitHub PR (code), SSH fallback |
| Q11b | Gate message verbosity | B — Standard (title, summary, key decisions, link) |
| Q11c | Reject flow | A — inline comment piped to architect |
| Q11d | Defer flow | B — speculative-continue on isolated branch |
| Q12a | Submission UX | C — terminal-primary + Telegram for mid-run controls |
| Q12b | Directive granularity | B — per-phase, agent-suggested next phase |
| Q12c | Cross-run knowledge | B — user-scoped sharing for generic patterns |
| Q12d | `/learner` cadence | B — per-phase boundary |

---

## 13. Open Questions for Implementation Time

These are NOT design decisions — they're details to settle when actually building:

- Exact pricing table values in cost tracker (look up at install time).
- HMAC secret rotation cadence for GitHub webhook auth on VPS.
- Quarterly skill-audit prompt template — write when first audit fires.
- Specific Discord/Telegram channel IDs (set during install, not in design).
- Bun vs Node for the Telegram bridge runtime (Bun likely; lower memory, faster startup).
- Whether to add a `nginx` reverse-proxy on VPS or expose `clawhip` directly with TLS (depends on whether HMAC verify is strong enough alone).

---

## Appendix A — Repo Layout

```
argus/
├── README.md
├── .gitignore
├── docs/
│   ├── plans/        # design docs (this file)
│   └── runbooks/     # operational guides (post-implementation)
├── config/           # clawhip.toml.example, omc-config.example.json, telegram-bridge.env.example
├── scripts/          # install-mac.sh, install-vps.sh, telegram-bridge.ts, watchdog.sh, cost-tracker.ts
├── skills/           # custom OMC skills (argus-router, ast-grep, lsp wrapper)
└── systemd/          # systemd unit files for VPS phase
```

Argus is the **meta-project** that orchestrates engineering work on other repos. The repos being built (greenfield A) or migrated (C) live elsewhere; Argus contains the tooling, configs, skills, and runbooks that make the team work.
