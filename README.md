# Argus

Long-horizon agentic engineering team. Builds and migrates software autonomously
across multi-day arcs while you sleep, on a small set of curated tools.

Named after the hundred-eyed giant from Greek myth who never had all eyes
closed at once — Hera assigned him to watch Io continuously, switching eyes
to sleep, never letting her out of sight. That's the spec.

## Stack

- **OMC** (`oh-my-claude-sisyphus`) — workflow orchestrator on Claude Code.
  Owns plan / build / verify / fix.
- **clawhip** — observability sidecar. Watches git, GitHub, tmux. Routes
  events to Discord (routine) and Telegram (escalations).
- **Custom glue** (in this repo) — Telegram bridge, cost tracker, watchdog,
  recovery automation, knowledge accumulation, dispatcher skill, install
  scripts, launchd plists, systemd units, Ansible playbooks.

No OmX. No OmO. One orchestrator, one observability daemon, one runtime.

## Use cases

- **Greenfield builds** (A): one-paragraph goal → agents emit PRD at gate 1 →
  build → verify → ship.
- **Large migrations** (C): existing repo → harness as task zero (gate 0a) →
  PRD → first batch eyes-on (gate 1) → fan-out → ship.

Two repos, never one. Adaptive concurrency: 1 worker at gates, 2-3 during
build, 1 during verify.

## Status

**Code-complete pending operator system validation.**

Phases A, B, and C are merged on `main` with 427 tests passing across six
Bun TypeScript subprojects + the OMC dispatcher skill. Phase D begins when
the operator (you) walks through the validation checklist and runs the
first real workload.

| Phase | Status | Tests | Reference |
|---|---|---|---|
| **A — Single-runtime baseline** | Code-complete | n/a (install scripts) | [`docs/plans/2026-05-03-phase-a-baseline.md`](docs/plans/2026-05-03-phase-a-baseline.md) |
| **B — Gates + Telegram bridge** | Code-complete | 145 (bridge + skill) | [`docs/plans/2026-05-03-phase-b-gates-and-telegram.md`](docs/plans/2026-05-03-phase-b-gates-and-telegram.md) |
| **C — Hardening (cost / watchdog / recovery / VPS / knowledge)** | Code-complete | 282 | [`docs/plans/2026-05-03-phase-c-hardening.md`](docs/plans/2026-05-03-phase-c-hardening.md) |
| **D — Production rollout** | Operator-validation pending | n/a | [`docs/plans/2026-05-03-phase-d-production.md`](docs/plans/2026-05-03-phase-d-production.md) |

**Start here for system validation:**
[`docs/runbooks/system-validation-checklist.md`](docs/runbooks/system-validation-checklist.md)

## Layout

```
argus/
├── docs/
│   ├── plans/        # design + 4-phase plans + index
│   └── runbooks/     # operational guides + chaos suite + validation playbook
├── config/           # clawhip.toml, policy.toml, pricing.toml (examples)
├── scripts/
│   ├── install-mac.sh      # idempotent Mac install (all phases)
│   ├── install-cloudflared.sh
│   ├── telegram-bridge/    # Bun TS service: clawhip events -> Telegram
│   ├── cost-tracker/       # Bun TS PostToolUse hook: per-run cost ceilings
│   ├── watchdog/           # Bun TS daemon: 30s health checks + dead-man
│   ├── recovery/           # Bun TS CLI+HTTP: ralph cap / fake-completion guard
│   │                       # tmux restart / provider fallback / crash budget
│   └── knowledge/          # Bun TS: /learner cadence / classify scope /
│                           # collision check / notepad summarizer
├── skills/
│   └── argus-router/       # OMC dispatcher skill: gate state machine
├── launchd/                # 6 launchd plist templates (Mac)
├── systemd/                # 5 systemd unit templates (.service.j2 for VPS)
├── ansible/                # VPS provisioning + cutover playbooks (Hetzner)
│   ├── playbooks/          #   00-bootstrap, 10-stack, 20-cutover, 99-verify
│   └── roles/              #   common, hardening, argus_user, tailscale,
│                           #   argus_stack, nginx
└── README.md (this file)
```

## What runs where

**On Mac (Phase A-C development + first operations):**

| Daemon | Purpose | Plist |
|---|---|---|
| `clawhip` | Event router (git/GitHub/tmux → Discord/Telegram) | `com.argus.clawhip` |
| `omc-wait` | OMC rate-limit auto-resume | `com.argus.omc-wait` |
| `telegram-bridge` | Gate UX + tier escalations | `com.argus.telegram-bridge` |
| `cloudflared` | Tunnel for Telegram webhook ingress | `com.argus.cloudflared` |
| `watchdog` | 30s health checks + dead-man | `com.argus.watchdog` |
| `recovery` | HTTP server for tmux-stale + provider-outage handlers | `com.argus.recovery` |

**Hooks under Claude Code (`~/.claude/settings.json`):**

| Hook | Purpose |
|---|---|
| `cost-tracker` (PostToolUse) | Per-token cost accumulation + threshold emission |
| `recovery-stop` (Stop) | ralph-cap + fake-completion-guard |
| `knowledge-stop` (Stop) | /learner per-phase cadence trigger |
| `knowledge-posttool` (PostToolUse) | Notepad 500-line cap + summarize |
| `clawhip native-hook` (Various) | Lifecycle event ingest from OMC into clawhip |

**On Hetzner VPS (Phase C cutover, optional):**

Same daemons as Mac under systemd `--user` units, plus nginx + Let's Encrypt
for public webhook ingress, plus tailscale for SSH.

## Quickstart

If this is a fresh clone and you want to validate everything end-to-end:

```bash
# 1. Bootstrap subproject deps
for d in scripts/*/; do (cd "$d" && [[ -f package.json ]] && bun install); done
cd skills/argus-router && bun install && cd -

# 2. Run all tests
for d in scripts/{telegram-bridge,cost-tracker,watchdog,recovery,knowledge} skills/argus-router; do
  echo "=== $d ===" && (cd "$d" && bun test 2>&1 | tail -3)
done

# 3. Walk the validation playbook
open docs/runbooks/system-validation-checklist.md
```

Expect 427 tests pass / 0 fail.

## Robustness invariants

These hold across all phases (per [`docs/plans/README.md`](docs/plans/README.md)):

- Bun + TypeScript strict + zod for any service.
- sqlite for any state that must survive restart.
- Atomic writes (tmp + fsync + rename) for any file consumed by a poller.
- Tests required for any business logic.
- Structured logs (pino, JSON to stdout) for any daemon.
- Idempotent install + provisioning everywhere (bash + Ansible).
- One escalation path per failure mode + one redundant path for CRITICAL.
- No hardcoded user paths.

## Where to learn more

- [`docs/plans/2026-05-03-argus-design.md`](docs/plans/2026-05-03-argus-design.md) — full architecture (815 lines).
- [`docs/plans/README.md`](docs/plans/README.md) — index of all four phase plans.
- [`docs/runbooks/system-validation-checklist.md`](docs/runbooks/system-validation-checklist.md) — operator playbook.
- [`docs/runbooks/chaos-suite.md`](docs/runbooks/chaos-suite.md) — 6 failure-mode test scenarios.
