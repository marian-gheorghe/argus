import { z } from "zod";

// Severity tiers: matches clawhip's tiered routing model.
export const Severity = z.enum(["info", "warn", "page", "critical"]);
export type Severity = z.infer<typeof Severity>;

/**
 * Payload clawhip POSTs to the bridge's /webhook/* endpoints.
 * Permissive (.passthrough()) so future clawhip-side fields don't break the bridge.
 * `event_id` is required and non-empty: it is the dedup key for the outbound queue.
 */
export const ClawhipWebhookEvent = z
  .object({
    event_id: z.string().min(1),
    event: z.string().min(1),
    severity: Severity,
    message: z.string(),
    run_id: z.string().optional(),
    gate_id: z.string().optional(),
    summary: z.string().optional(),
    key_decisions: z.array(z.string()).optional(),
    artifact_path: z.string().optional(),
    diff_url: z.string().url().optional(),
    timeout_at: z.string().datetime().optional(),
  })
  .passthrough();
export type ClawhipWebhookEvent = z.infer<typeof ClawhipWebhookEvent>;

/**
 * Telegram callback update — the POST body Telegram sends when an inline-keyboard
 * button is tapped. We encode `<gate-id>:approve|reject|defer` in `data`.
 */
export const TelegramCallbackPayload = z.object({
  callback_query: z.object({
    id: z.string(),
    from: z.object({
      id: z.number(),
      username: z.string().optional(),
    }),
    message: z.object({
      chat: z.object({ id: z.number() }),
      message_id: z.number(),
    }),
    data: z.string(),
  }),
});
export type TelegramCallbackPayload = z.infer<typeof TelegramCallbackPayload>;

/**
 * `<gate-id>.pending.json` — written by OMC dispatcher when a gate is opened,
 * consumed by the bridge's gate file watcher.
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
