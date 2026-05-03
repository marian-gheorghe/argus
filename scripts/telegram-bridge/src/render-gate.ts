import type { ClawhipWebhookEvent } from "./schemas.ts";
import type { InlineKeyboard } from "./telegram.ts";

/**
 * Rich gate-card renderer per design §4.4.
 *
 * Returns a Telegram-ready `{chat_id, text, keyboard}` for a `gate.pending`
 * event, or `null` if any required field is missing/invalid (in which case
 * the caller — the dispatcher — parks the row).
 *
 * The text body is markdown so callers must `parse_mode: "Markdown"` when
 * sending. Truncation: if `summary` exceeds `SUMMARY_MAX`, the body is
 * cut at that bound and a `…(truncated)` suffix is appended. Phase B uses
 * a simple character truncation; Phase C may upgrade to markdown-aware
 * truncation if it surfaces operationally (TODO).
 */

const SUMMARY_MAX = 1500;
const TRUNCATE_SUFFIX = " …(truncated)";

interface RenderedGateMessage {
  chat_id: number;
  text: string;
  keyboard: InlineKeyboard;
}

/**
 * Console-warn helper. We intentionally do NOT take a logger as a dep — this
 * keeps the renderer pure and trivially testable. The dispatcher's "render
 * returned null" log carries the event_id; this extra `warn` is supplemental.
 */
function warn(field: string, gate_id: string): void {
  // Use console.warn rather than pino so the renderer stays a pure module.
  console.warn(
    `renderGateMessage: skipping gate ${gate_id || "(unknown)"} — missing/invalid ${field}`,
  );
}

export function renderGateMessage(
  event: ClawhipWebhookEvent,
  chat_id_gates: number,
): RenderedGateMessage | null {
  const gate_id = typeof event.gate_id === "string" ? event.gate_id : "";
  if (!gate_id) {
    warn("gate_id", gate_id);
    return null;
  }

  const summary = typeof event.summary === "string" ? event.summary : "";
  if (!summary) {
    warn("summary", gate_id);
    return null;
  }

  const artifactPath = typeof event.artifact_path === "string" ? event.artifact_path : "";
  if (!artifactPath) {
    warn("artifact_path", gate_id);
    return null;
  }

  const timeoutAtRaw = typeof event.timeout_at === "string" ? event.timeout_at : "";
  if (!timeoutAtRaw) {
    warn("timeout_at", gate_id);
    return null;
  }
  const timeoutAt = new Date(timeoutAtRaw);
  if (Number.isNaN(timeoutAt.getTime())) {
    warn("timeout_at (unparseable)", gate_id);
    return null;
  }

  // key_decisions is optional but, when present, must be string[].
  let keyDecisions: string[] = [];
  if (event.key_decisions !== undefined) {
    if (!Array.isArray(event.key_decisions)) {
      warn("key_decisions (not an array)", gate_id);
      return null;
    }
    keyDecisions = event.key_decisions;
  }

  // Header: title from event.message (e.g. "Gate 1 — PRD approval"), run id
  // in inline-code so Telegram renders it monospace.
  const runId = typeof event.run_id === "string" ? event.run_id : "(unknown)";
  const title = event.message;

  const summaryBody =
    summary.length > SUMMARY_MAX ? summary.slice(0, SUMMARY_MAX) + TRUNCATE_SUFFIX : summary;

  const lines: string[] = [];
  lines.push(`🚪 *${title}* (run \`${runId}\`)`);
  lines.push("");
  lines.push("*Summary:*");
  lines.push(`  ${summaryBody}`);
  if (keyDecisions.length > 0) {
    lines.push("");
    lines.push("*Key decisions:*");
    for (const d of keyDecisions) lines.push(`  • ${d}`);
  }
  lines.push("");
  lines.push(`*Artifact:* \`${artifactPath}\``);
  const diffLine =
    typeof event.diff_url === "string" && event.diff_url.length > 0 ? event.diff_url : "(none)";
  lines.push(`*Diff:* ${diffLine}`);
  lines.push("");
  lines.push(`*Times out at:* ${formatTimeout(timeoutAt)}`);

  const text = lines.join("\n");

  const keyboard: InlineKeyboard = {
    inline_keyboard: [
      [
        { text: "✅ Approve", callback_data: `${gate_id}:approve` },
        { text: "❌ Reject + comment", callback_data: `${gate_id}:reject` },
        { text: "⏸ Defer 4h", callback_data: `${gate_id}:defer` },
      ],
    ],
  };

  return { chat_id: chat_id_gates, text, keyboard };
}

/**
 * Format the `timeout_at` line: `YYYY-MM-DD HH:MM UTC (in 7h 58m)` or
 * `EXPIRED` if in the past. Pure UTC formatting — no locale, no DST.
 */
function formatTimeout(t: Date): string {
  const now = Date.now();
  const target = t.getTime();
  if (target <= now) return "EXPIRED";

  const yyyy = t.getUTCFullYear();
  const mm = String(t.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(t.getUTCDate()).padStart(2, "0");
  const HH = String(t.getUTCHours()).padStart(2, "0");
  const MM = String(t.getUTCMinutes()).padStart(2, "0");

  const deltaSecs = Math.floor((target - now) / 1000);
  const hours = Math.floor(deltaSecs / 3600);
  const mins = Math.floor((deltaSecs % 3600) / 60);

  return `${yyyy}-${mm}-${dd} ${HH}:${MM} UTC (in ${hours}h ${mins}m)`;
}
