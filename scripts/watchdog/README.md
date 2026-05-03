# Argus Watchdog

Modular health-check daemon with restart escalation and a dead-man's-switch
that bypasses clawhip when clawhip itself is unhealthy.

- **Runtime:** Bun
- **Lang:** TypeScript (strict)
- **Validation:** zod
- **Logging:** pino (JSON in prod, pretty in dev)
- **Tests:** `bun test`

See `docs/plans/2026-05-03-phase-c-hardening.md` (Block 2) for context.

## What it does

Every `WATCHDOG_INTERVAL_MS` (default 30s):

1. Runs every registered `Check.check()` in parallel.
2. For each unhealthy result, increments a per-check failure counter.
3. When a counter hits `WATCHDOG_THRESHOLD` (default 2 consecutive failures):
   - Calls `Check.restart()` via the platform-appropriate service manager
     (`launchctl kickstart` on macOS / `systemctl --user restart` on Linux).
   - If the restart fails OR another failure arrives within
     `WATCHDOG_RESTART_COOLDOWN_MS`, escalates to a CRITICAL `clawhip.dead-man`
     event emitted via OMC's **native callback path** — never via clawhip,
     because clawhip might be the dead daemon we're escalating about.
4. On Linux, also pings `sd_notify(WATCHDOG=1)` once per healthy iteration so
   systemd's hardware watchdog can KILL+restart this very process if it dies.

The loop catches per-check exceptions so one buggy check can't kill the
watchdog itself — meta-watchdog is launchd / systemd respawning us if we
die outright, but in steady state we should never die.

## Built-in checks

| Check            | Liveness signal                              | Restart action                  |
| ---------------- | -------------------------------------------- | ------------------------------- |
| `clawhip`        | `GET http://127.0.0.1:25294/status` → 200    | service `com.argus.clawhip`     |
| `bridge`         | `GET http://127.0.0.1:9501/health` → 200     | service `com.argus.telegram-bridge` |
| `omc-wait`       | `pgrep -f "omc wait"` exit 0                 | service `com.argus.omc-wait`    |
| `pending-replies`| always healthy (side-effect-only check)      | no-op                           |

The `pending-replies` check addresses **Phase B Issue 3**:
`OutboundQueue.expirePendingReplies` was implemented but never called from
production code. The check connects to the bridge's sqlite at
`$HOME/.argus/state/bridge-queue.sqlite` and deletes pending-reply rows older
than 2h on every tick. See `src/checks/pending-replies.ts` for the inlined SQL
duplication and the Phase C+ cleanup TODO.

## Develop

```
bun install
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
```

## Run locally (against live services)

```
export PATH="$HOME/.bun/bin:$PATH"
bun run src/index.ts
```

The watchdog is designed to be run by launchd (macOS) or systemd (Linux);
running it interactively is for debugging only.
