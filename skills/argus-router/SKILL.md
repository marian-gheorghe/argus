---
name: argus-router
description: |
  Argus dispatcher skill: opens gates at phase boundaries, awaits human
  decision via the Telegram bridge, applies the outcome (approved →
  proceed; rejected → re-architect with comment; deferred →
  speculative-continue branch). Runs at OMC's Stop hook on phase ends.
triggers:
  - phase-boundary
  - gate-open
  - gate-await
  - speculative-continue
source: argus
---

# argus-router — OMC dispatcher skill (gate state machine)

This skill is the OMC-side half of the Argus gate contract. The other half
is the `telegram-bridge` daemon, which renders gate notifications to a phone
and writes back the operator's decision. Together they let an unattended
agent run pause itself at phase boundaries, page a human, and resume on tap.

## When this skill runs

OMC invokes the controller at every **phase boundary** — never per commit
(per design §4.7 commits inside a phase are autonomous). A typical greenfield
run with three phases fires three gates:

1. After the **architect** finishes the PRD → **PRD gate**
2. After the **builder** finishes implementation → **code-review gate**
3. After integration tests pass → **final-integration gate**

OMC's Stop hook is the trigger. The hook sees that a phase has just ended
(workers idle, branch state clean) and routes through `argus-router` instead
of immediately advancing.

## What the controller does

```
   OMC Stop hook
        │
        ▼
  argus-router.openGate()
   • write $OMC_STATE_DIR/gates/<gate-id>.pending.json   (durable contract)
   • emit clawhip `gate.pending`                          (real-time path)
        │
        ▼
  argus-router.awaitDecision()
   • poll <gate-id>.decision.json every 30s
   • deadline = pending.timeout_at  (default: now + 8h)
        │
   ┌────┴────┬────────────┬────────────┐
   ▼         ▼            ▼            ▼
approved   rejected     deferred     timeout
   │         │            │            │
   │         │            │            └─ emit `gate.timeout` (severity=page),
   │         │            │               return `{decision: "timeout"}`. OMC
   │         │            │               typically holds the run, sleeps the
   │         │            │               poll, retries.
   │         │            │
   │         │            └─ createSpeculativeBranch(): branch
   │         │               `speculative/<run-id>/<gate-id>` from HEAD.
   │         │               OMC continues on it. On later approve →
   │         │               promote; on later reject → preserve, never merge.
   │         │
   │         └─ run-architect-with-comment: prompt is "Human rejected the
   │            previous plan. Reason: \"<comment>\". Revise."
   │
   └─ proceed: hand control back to OMC; next phase begins.
```

## Gate types

The skill is type-agnostic — the orchestrator decides which type to fire and
the controller just writes the JSON. The bridge renders all three the same
way (full-context message + three buttons), but the type field lets the
operator orient at a glance, drives clawhip routing, and shapes what OMC
does on each outcome:

| Type                 | Fires when                             | Approve → next phase | Reject → re-arch | Defer → speculative |
|----------------------|----------------------------------------|----------------------|------------------|---------------------|
| `PRD`                | Architect finished plan/spec           | Builder begins       | Architect re-runs | Builders proceed on speculative branch |
| `code-review`        | Builder finished implementation         | Integration begins   | Builder re-runs (or architect, for plan-level rejection) | Integration runs on speculative branch |
| `final-integration`  | Integration tests + smoke pass          | Run completes        | Builder re-runs targeting the cited test failure | Run paused; speculative branch held for review |

## File contract (design §4.3)

Both files live under `$OMC_STATE_DIR/gates/`:

```
gates/
├── PRD-run_2026-05-03-payment-a3f9c2.pending.json    ← OMC writes (this skill)
└── PRD-run_2026-05-03-payment-a3f9c2.decision.json   ← bridge writes (telegram-bridge)
```

`<gate-id>` shape: `<type>-<run_id>-<6 hex chars>`. The 6 hex chars are
random per call so re-opening a phase (e.g. after a rejection-then-redo
loop) produces a fresh file rather than colliding with the previous round.
The bridge's outbound queue dedupes by `event_id` — reusing a `gate_id`
would silently drop the new notification.

### `<gate-id>.pending.json` (this skill writes)

Schema (`lib/gate-types.ts::GatePending`):

```json
{
  "gate_id":        "PRD-run_2026-05-03-payment-a3f9c2",
  "run_id":         "run_2026-05-03-payment",
  "type":           "PRD",
  "title":          "Phase 1 PRD — Stripe payment service",
  "summary":        "Three endpoints. Postgres for persistence, Redis for idempotency.",
  "key_decisions":  ["Stripe SDK v15", "24h Redis TTL", "Webhook retry 3x"],
  "artifact_path":  "/Users/.../argus-2026-05-03-payment/prd.md",
  "diff_url":       "https://github.com/.../pull/42",
  "created_at":     "2026-05-03T07:00:00Z",
  "timeout_at":     "2026-05-03T15:00:00Z"
}
```

Atomic write: `tmp + fsync + rename`, mode `0o600`. Same pattern the bridge
uses for `<gate-id>.decision.json`. On crash mid-write, either the old file
(unlikely — we don't overwrite) or the new file is visible, never a
half-written intermediate.

### `<gate-id>.decision.json` (bridge writes, this skill reads)

Schema (`lib/gate-types.ts::GateDecision`):

```json
{
  "gate_id":            "PRD-run_2026-05-03-payment-a3f9c2",
  "run_id":             "run_2026-05-03-payment",
  "decision":           "approved",
  "comment":            "ship it",
  "decided_at":         "2026-05-03T07:08:43Z",
  "decided_by_chat_id": 1234567890
}
```

`comment` is required for `rejected` (the architect-feedback channel) and
optional for `approved` / `deferred`.

## Dual-emission (design §1)

The controller writes the pending file AND emits a clawhip `gate.pending`
event. Both paths reach the bridge:

- **File path** (durable): bridge's chokidar watcher sees the new file and
  enqueues. Survives clawhip restart, network partition, anything that
  doesn't take down the local filesystem.
- **clawhip path** (real-time): clawhip POSTs to the bridge's
  `/webhook/gate` HTTP endpoint. Faster, doesn't depend on chokidar's
  polling cadence.

Either path losing the event leaves the other working — the bridge's
queue dedupes by `event_id` (`gate.pending:<gate_id>`) so seeing the same
gate via both paths is idempotent.

## Reject + comment flow (design §4.5)

When the operator taps `❌ Reject + comment`, the bridge prompts them in
Telegram for a one-line reason, then writes `<gate-id>.decision.json` with
`decision: "rejected"` and the comment.

This skill returns the `GateDecision` to OMC. OMC's orchestrator is then
expected to inject the comment into the architect's next-iteration prompt
as:

> Human rejected the previous plan. Reason: "<comment>". Revise the plan
> addressing this.

The architect re-runs, produces a new artifact, the orchestrator fires a
new gate (new `gate_id` — fresh short-sha), and the loop continues until
approval. Phase B does not store rejection comments durably across full
process restarts — the comment is in `decision.json` until the orchestrator
ingests it. (Phase C cleanup: persist rejection history per run for postmortem.)

## Defer + speculative-continue flow (design §4.6)

When the operator taps `⏸ Defer 4h`, the bridge writes `decision: "deferred"`
and bumps the gate's effective deadline by 4h. This skill calls
`createSpeculativeBranch({run_id, gate_id})` to make
`speculative/<run-id>/<gate-id>` from HEAD, and OMC continues on that
branch (workers stay on their per-worker branches; the speculative branch
is the integration target).

If the gate is later approved → orchestrator promotes the speculative
branch to the run's main branch. If later rejected → branch preserved
(forensic value) but never merged. Second defer of the same gate is a
mandatory PAGE per design §4.6 — the orchestrator should not allow a
third speculative round.

`createSpeculativeBranch` is idempotent: a re-entry (e.g. retry after
crash) finds the existing branch and returns `{created: false}` rather
than failing.

## Escalation on timeout

After `timeout_at` elapses with no decision file, the controller emits
`gate.timeout` (severity `page` per design §5) and returns
`{decision: "timeout"}`. OMC's expected response:

1. Hold the run in a `gate-timed-out` state (don't proceed, don't kill).
2. The clawhip `gate.timeout` route → `/webhook/page` triggers a Telegram
   PAGE message in `#argus-page`.
3. Orchestrator may re-fire the gate after the operator acknowledges, or
   `argus-router` may be invoked again with the same artifact (which
   produces a new `gate_id` — that's correct; the old file remains as
   audit evidence).

## How OMC invokes this skill

The skill ships with two artifacts:

- `lib/gate-controller.ts` — the actual implementation. Bun TS module,
  `import { GateController } from "./lib/gate-controller.ts"`. OMC's hook
  script imports it directly.
- `SKILL.md` (this file) — context for the OMC instance reasoning about
  *whether* to fire a gate. The hook reads this to know what gate types
  exist, what each outcome means, and where the file contract lives.

Production usage from an OMC Stop hook:

```ts
import { GateController } from "argus-router/lib/gate-controller.ts";

const ctrl = new GateController();
const outcome = await ctrl.fireGate({
  type: "PRD",
  run_id: process.env.OMC_RUN_ID!,
  title: `Phase 1 PRD — ${runManifest.title}`,
  summary: runManifest.summary,
  key_decisions: runManifest.key_decisions,
  artifact_path: `${process.env.OMC_STATE_DIR}/${runManifest.id}/prd.md`,
  diff_url: runManifest.diff_url,
  // clawhipEmit is left undefined → shells out to `clawhip send`.
});

switch (outcome.decision) {
  case "approved":
    return { proceed: true };
  case "rejected":
    return { proceed: false, reroute: "architect", comment: outcome.comment };
  case "deferred":
    await ctrl.createSpeculativeBranch({
      run_id: outcome.run_id,
      gate_id: outcome.gate_id,
    });
    return { proceed: true, on_branch: `speculative/${outcome.run_id}/${outcome.gate_id}` };
  case "timeout":
    return { proceed: false, reroute: "hold", reason: "gate-timed-out" };
}
```

The exhaustive switch is part of the contract: `GateDecisionOrTimeout` is a
discriminated union so TypeScript flags any new decision variant the
orchestrator hasn't handled yet.

## Limitations (Phase B)

- **No cost ceiling integration.** The 8h default timeout assumes humans
  who can answer within a workday. Phase C will plumb cost ceilings so a
  long-deferred gate caps spend on speculative branches.
- **No watchdog on the controller itself.** If the OMC process crashes
  mid-poll, no restart logic relaunches `awaitDecision`. The pending +
  decision files remain on disk (durable contract), but a human must
  re-invoke. Phase C: file-watcher-based recovery on OMC startup.
- **No automatic recovery from a re-fired gate.** If a timed-out gate is
  re-fired, the *new* file gets a new `gate_id`; the orchestrator must
  decide whether to GC the old `pending.json` or keep it for audit.
- **Rejection comments not persisted.** The comment lives in
  `decision.json` until the orchestrator reads it. Lost-on-restart in the
  worst case. Phase C cleanup: persistent rejection history per run.
- **clawhip emit failures are swallowed.** If `clawhip send` returns
  non-zero, the controller logs and continues — the file-watcher path
  picks up the gate. Operators won't see anything in Telegram if BOTH
  paths fail; that's a Phase C monitoring gap (we'll instrument
  emit-failure rates and alert when both paths are degraded).

## References

- Design: `docs/plans/2026-05-03-argus-design.md` §1 (dual-emission), §4.3
  (file contract), §4.5 (reject), §4.6 (defer/speculative-continue), §4.7
  (where commits go), §5 (severity tiers).
- Phase B plan: `docs/plans/2026-05-03-phase-b-gates-and-telegram.md`
  Task 14.
- Bridge schemas: `scripts/telegram-bridge/src/schemas.ts` (canonical;
  this skill duplicates `GatePending`/`GateDecision` for now — Phase C
  cleanup unifies into a shared `argus-schemas` package).
- Bridge file watcher: `scripts/telegram-bridge/src/gate-watcher.ts` —
  the consumer of `<gate-id>.pending.json` files.
- Bridge callback handler: `scripts/telegram-bridge/src/handle-callback.ts`
  — the producer of `<gate-id>.decision.json` files.
