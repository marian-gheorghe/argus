/**
 * Gate schemas + decision-or-timeout discriminated union for the OMC dispatcher.
 *
 * These schemas are duplicated from `scripts/telegram-bridge/src/schemas.ts`
 * for Phase B. The bridge owns the canonical contract. A Phase C cleanup task
 * will extract both copies into a shared `argus-schemas` package; for now,
 * keeping them as two parallel files lets each project install + typecheck +
 * test on its own without coupling release cadence.
 *
 * Invariant the duplication MUST preserve: any change to `GatePending` or
 * `GateDecision` here must be mirrored in the bridge schema (and vice-versa).
 * Cross-check: `scripts/telegram-bridge/tests/schemas.test.ts` is the safety
 * net on the bridge side; the controller tests in this package validate that
 * what we write parses cleanly here too.
 */

import { z } from "zod";

/**
 * `<gate-id>.pending.json` — written by OMC dispatcher when a gate is opened,
 * consumed by the bridge's gate file watcher.
 *
 * Mirrors `scripts/telegram-bridge/src/schemas.ts::GatePending`.
 */
export const GatePending = z.object({
  gate_id: z.string(),
  run_id: z.string(),
  type: z.enum(["PRD", "code-review", "final-integration"]),
  title: z.string(),
  summary: z.string(),
  key_decisions: z.array(z.string()).default([]),
  artifact_path: z.string(),
  diff_url: z.string().url().optional(),
  created_at: z.string().datetime(),
  timeout_at: z.string().datetime(),
});
export type GatePending = z.infer<typeof GatePending>;

/**
 * `<gate-id>.decision.json` — written by the bridge when an operator
 * approves/rejects/defers via Telegram, consumed by OMC.
 *
 * Mirrors `scripts/telegram-bridge/src/schemas.ts::GateDecision`.
 */
export const GateDecision = z.object({
  gate_id: z.string(),
  run_id: z.string(),
  decision: z.enum(["approved", "rejected", "deferred"]),
  comment: z.string().optional(),
  decided_at: z.string().datetime(),
  decided_by_chat_id: z.number().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;

/**
 * Result type for `awaitDecision`. Either a parsed `GateDecision` (the file
 * appeared) or a synthetic `{decision: "timeout"}` marker (the wall-clock
 * deadline elapsed first). The dispatcher caller branches on `decision` to
 * pick the next action: proceed, re-architect, speculative-continue, or page.
 *
 * Why a separate `timeout` variant rather than throwing: timeouts are an
 * expected outcome (operator was asleep, on holiday) and the controller wants
 * to emit a `gate.timeout` clawhip event before returning. Callers should
 * handle `timeout` as a recoverable state — typically by paging and waiting.
 */
export type GateDecisionOrTimeout =
  | { decision: "approved"; gate_id: string; run_id: string; comment?: string; decided_at: string }
  | { decision: "rejected"; gate_id: string; run_id: string; comment?: string; decided_at: string }
  | { decision: "deferred"; gate_id: string; run_id: string; comment?: string; decided_at: string }
  | { decision: "timeout"; gate_id: string; run_id: string };

/**
 * `clawhipEmit` payload — what the controller passes either to the injected
 * mock (in tests) or to the real `clawhip send` shellout (in production).
 *
 * Schema is the strict subset of fields the bridge's `ClawhipWebhookEvent`
 * cares about for `gate.pending` / `gate.timeout`. Extra fields go into
 * `payload` and clawhip will pass them through to the bridge under the same
 * `--webhook-payload` JSON.
 */
export interface ClawhipEmitPayload {
  event: string;
  severity: "info" | "warn" | "page" | "critical";
  payload: Record<string, unknown>;
}
