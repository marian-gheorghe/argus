import type { RecoveryEmitter } from "./emit.ts";
import { ManifestStore } from "./manifest.ts";

/**
 * Fake-completion guard. Mode (e) of design §8 (agent claims DONE
 * without evidence).
 *
 * Stop hook entrypoint. Reads the agent transcript from stdin (the
 * Claude Code Stop hook payload), detects `<promise>DONE</promise>`
 * (or close variants) emitted without a recent `team-verify` pass, and:
 * - emits `agent.fake-completion` WARN
 * - sets `manifest.next_prompt_prepend` so the next OMC submit injects
 *   a "run /team-verify before claiming completion" directive
 *
 * Exit 0 ALWAYS — a hook crash MUST never block the agent.
 */

export interface FakeCompletionGuardDeps {
  env: Record<string, string | undefined>;
  stdin: string;
  stateDir: string;
  emitter: RecoveryEmitter;
  stderr: (msg: string) => void;
  now: () => Date;
  freshnessMs: number;
}

const PROMPT_PREPEND_FAKE =
  "Your DONE claim is missing a recent team-verify pass. Run /team-verify " +
  "before claiming completion.";

// Match <promise>DONE</promise> (case-insensitive, whitespace-tolerant).
// Tight enough to avoid false positives from natural language like
// "I'm done refactoring".
const DONE_CLAIM_RE = /<promise>\s*done\s*<\/promise>/i;

export async function runFakeCompletionGuard(deps: FakeCompletionGuardDeps): Promise<number> {
  try {
    const run_id = deps.env.OMC_CURRENT_RUN_ID;
    if (!run_id) return 0;

    let parsed: unknown;
    try {
      parsed = JSON.parse(deps.stdin);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`fake-completion-guard: stdin JSON parse failed: ${msg}\n`);
      return 0;
    }

    const transcript = extractTranscript(parsed);
    if (!transcript || !DONE_CLAIM_RE.test(transcript)) {
      // No claim — nothing to do.
      return 0;
    }

    const store = new ManifestStore(deps.stateDir);
    const current = store.read(run_id);
    if (!current) {
      // No manifest — silent no-op so we don't break the agent during
      // very-early-phase Stop firings before OMC has stamped state.
      return 0;
    }

    const lastVerify = current.last_verify_pass_at
      ? new Date(current.last_verify_pass_at).getTime()
      : null;
    const nowMs = deps.now().getTime();
    const fresh = lastVerify !== null && nowMs - lastVerify <= deps.freshnessMs;
    if (fresh) {
      // Verified recently — let the DONE through.
      return 0;
    }

    // Stamp the manifest BEFORE attempting to emit so a clawhip outage
    // doesn't lose the prompt-prepend directive — the next agent turn
    // still sees the corrective injection even if the operator missed
    // the alert.
    store.update(run_id, (m) => ({ ...m, next_prompt_prepend: PROMPT_PREPEND_FAKE }));

    try {
      await deps.emitter.emit("agent.fake-completion", "warn", {
        run_id,
        last_verify_pass_at: current.last_verify_pass_at ?? null,
        timestamp: new Date(nowMs).toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`fake-completion-guard: emit failed: ${msg}\n`);
    }

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`fake-completion-guard: unexpected error: ${msg}\n`);
    return 0;
  }
}

function extractTranscript(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = (parsed as { transcript?: unknown }).transcript;
  if (typeof t === "string") return t;
  // Some hook payloads pass the agent message under different field names —
  // try a couple as a defensive secondary path.
  for (const k of ["agent_response", "message", "content"]) {
    const v = (parsed as Record<string, unknown>)[k];
    if (typeof v === "string") return v;
  }
  return null;
}
