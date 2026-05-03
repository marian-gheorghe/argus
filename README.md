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
- **Custom glue** (in this repo) — Telegram bridge, watchdog cron, escalation
  router, dispatcher skill, install/boot scripts, systemd units.

No OmX. No OmO. One orchestrator, one observability daemon, one runtime.

## Use cases

- **Greenfield builds** (A): one-paragraph goal → agents emit PRD at gate 1 →
  build → verify → ship.
- **Large migrations** (C): existing repo → harness as task zero (gate 0a) →
  PRD → first batch eyes-on (gate 1) → fan-out → ship.

Two repos, never one. Adaptive concurrency: 1 worker at gates, 2-3 during
build, 1 during verify.

## Status

Pre-implementation. See [`docs/plans/`](docs/plans/) for the design doc.

## Layout

```
argus/
├── docs/
│   ├── plans/        # design docs
│   └── runbooks/     # operational guides
├── config/           # clawhip.toml, omc config, telegram bridge env (examples)
├── scripts/          # install, telegram-bridge, watchdog, boot-status
├── skills/           # custom OMC skills (router, ast-grep wrapper, etc.)
└── systemd/          # systemd unit files for the VPS phase
```
