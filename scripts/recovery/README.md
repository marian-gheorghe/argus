# Argus Recovery

Recovery matrix automation for design §8 failure modes. Implements:

- **3.1 Ralph 30-iter cap + fake-completion guard** — Stop hooks for OMC.
- **3.2 tmux stale-detect → checkpoint replay** — one-shot auto-restart on `tmux.stale`.
- **3.3 Provider-outage fallback** — toggles API ↔ Max20 credentials on `provider.outage`.
- **3.4 Crash budget enforcement** — 3 strikes per run, halt with CRITICAL.
- **3.5 Chaos suite runbook** — see `docs/runbooks/chaos-suite.md`.

- **Runtime:** Bun
- **Lang:** TypeScript (strict)
- **Storage:** atomic JSON at `$OMC_STATE_DIR/runs/<run_id>/manifest.json` with sidecar `.lock` file
- **Validation:** zod
- **Logging:** pino (JSON in prod, pretty in dev)
- **Tests:** `bun test`

## Entrypoints

`argus-recovery` is a single CLI with sub-commands. It also exposes an HTTP
mode (`argus-recovery serve --port 9601`) for clawhip webhook routes.

```
argus-recovery ralph-cap
argus-recovery fake-completion
argus-recovery tmux-restart
argus-recovery provider-fallback
argus-recovery budget bump <run_id> <reason>
argus-recovery serve --port 9601
```

The Stop-hook wrapper at `~/.argus/recovery-stop-hook.sh` calls `ralph-cap`
then `fake-completion`. The HTTP server is registered as a launchd agent
(`com.argus.recovery`) and clawhip routes `tmux.stale` /
`provider.outage` to `http://127.0.0.1:9601/<subcommand>`.

## Develop

```
bun install
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
```

## Manifest schema

`manifest.json` is the per-run state file. It tracks crash count, ralph
iteration counts per task, tmux restart attempts, provider mode, and a
`next_prompt_prepend` field used by `/learner` cadence (Block 5). All
writes are atomic (tmp + fsync + rename, mode 0600); concurrent updates
serialise via a sidecar `.lock` file (open with O_EXCL, spin-wait up to
2s with 10ms intervals, then either acquire or throw). For higher-
contention scenarios, sqlite advisory locking would be a drop-in
replacement.
