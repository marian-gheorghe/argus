# Argus Plans Index

Design + four-phase implementation plans, all written 2026-05-03.

## Read in this order

1. **[Argus design doc](./2026-05-03-argus-design.md)** — the validated architecture (815 lines). Read first; plans below assume this context.
2. **[Phase A — Single-runtime baseline](./2026-05-03-phase-a-baseline.md)** — install OMC + clawhip on Mac with Discord INFO routing; run an unattended greenfield smoke test. ~12 tasks, 1-2 days.
3. **[Phase B — Gate model + Telegram bridge](./2026-05-03-phase-b-gates-and-telegram.md)** — first-class Bun/TS Telegram bridge with sqlite durable queue, gate state machine, GitHub PR gates. ~16 tasks, 3-5 days.
4. **[Phase C — Hardening for marathon](./2026-05-03-phase-c-hardening.md)** — cost tracker, watchdog, recovery matrix automation, Ansible-based VPS provisioning, `/learner` discipline. ~20+ tasks, 4-6 days.
5. **[Phase D — Production rollout](./2026-05-03-phase-d-production.md)** — first real workloads + iterate. Operational, not implementation-heavy. Open-ended.

## Phase boundaries

Each phase merges to `main` on a PASS verdict before the next phase starts. Phase plans assume the previous phase is on `main` and stable.

```
main ─────────────────────────────────────────────────►
   │                                                       
   ├─ phase-a/baseline ─► merge ─►                        
   │                                                       
   │     ├─ phase-b/gates ─► merge ─►                     
   │                                                       
   │           ├─ phase-c/hardening ─► merge ─►           
   │                                                       
   │                 ├─ phase-d/<various> ─► ongoing      
```

## Robustness invariants (apply to all phases)

These are the standards "robust long-term" means in this project:

- **Bun + TypeScript strict + zod for any service.** No untyped JSON shuffling.
- **sqlite for any state that must survive restart.** No JSON files for queues or accumulators.
- **Atomic writes for any file consumed by a poller.** Write `.tmp`, fsync, rename.
- **Tests required for any business logic.** Skipping tests on "trivial" code is how it stops being trivial.
- **Structured logs (pino, JSON to stdout) for any daemon.** No printf debugging in production.
- **Idempotent install + provisioning everywhere.** Bash with checks, or Ansible.
- **One escalation path per failure mode + one redundant path for CRITICAL.** Either-but-not-both is a single point of failure.
- **No hardcoded user paths.** `$HOME`, `$OMC_STATE_DIR`, env vars only.

If any task in any phase appears to violate one of these invariants, that's a smell — call it out before implementing.

## Skills referenced across plans

- `@superpowers:test-driven-development`
- `@superpowers:verification-before-completion`
- `@superpowers:systematic-debugging`
- `@superpowers:executing-plans`
- `@superpowers:subagent-driven-development`
- `@superpowers:finishing-a-development-branch`
- `@superpowers:using-git-worktrees`
