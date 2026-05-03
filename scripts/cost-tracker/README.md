# Argus Cost Tracker

PostToolUse hook + sqlite accumulator + threshold emission for API-billing cost enforcement.

- **Runtime:** Bun
- **Lang:** TypeScript (strict)
- **Storage:** `bun:sqlite` (WAL mode)
- **Validation:** zod
- **Logging:** pino (JSON in prod, pretty in dev)
- **Tests:** `bun test`

See `docs/plans/2026-05-03-phase-c-hardening.md` (Block 1) for context.

## What it does

1. Runs as a Claude Code `PostToolUse` hook.
2. Reads policy at `~/.claude/omc/argus/policy.toml`.
3. In `billing = "max20"` mode (default): no-op, exit 0.
4. In `billing = "api"` mode: parses the hook stdin payload, looks up the model's
   tier and per-token rates from `~/.argus/pricing.toml`, accumulates spend per
   `OMC_CURRENT_RUN_ID` in `~/.argus/state/cost-tracker.sqlite` and emits clawhip
   events at 75% (`cost.warn`) / 100% (`cost.page`) / 110% (`cost.kill`) of the
   per-run ceiling.
5. At `cost.page`, best-effort `omc pause <run-id>`.
   At `cost.kill`, best-effort `omc cancel <run-id>`.
6. Idempotent emission: each threshold fires exactly once per run.

The hook never propagates failures. Any internal error is logged to stderr and
the process exits 0 — a hook crash must never block the agent.

## Develop

```
bun install
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run lint        # biome check
```

## Pricing

`~/.argus/pricing.toml` is generated at install time from
`config/pricing.toml.example`. Values are public list-price placeholders; update
when Anthropic publishes new rates.

The accumulator stores raw token counts per `(run_id, tier, token_type)`; the
`spent_eur` column is recomputed from those counts and the current pricing
table on every `add` call. This means: changing pricing rates retroactively
adjusts all unfinished runs the next time their hook fires — by design, since
we want the budget enforcement to reflect the rates the operator just told us
about.
