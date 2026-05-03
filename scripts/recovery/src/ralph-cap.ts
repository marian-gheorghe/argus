import type { RecoveryEmitter } from "./emit.ts";
import { ManifestStore } from "./manifest.ts";

/**
 * Ralph 30-iter cap. Mode (a) of design §8 (agent stuck in a loop).
 *
 * Stop hook entrypoint. Increments per-task ralph counter; on the
 * MAX_ITERATIONS-th iteration emits `agent.loop-exhausted` WARN and
 * sets `manifest.next_prompt_prepend` to a stop-summarize-architect
 * directive. On the 2*MAX-th iteration emits PAGE so a human gets
 * woken up.
 *
 * Exit 0 ALWAYS — a hook crash MUST never block the agent.
 */

export interface RalphCapDeps {
  env: Record<string, string | undefined>;
  stateDir: string;
  emitter: RecoveryEmitter;
  maxIterations: number;
  stderr: (msg: string) => void;
}

const PROMPT_PREPEND_WARN =
  "Your task has hit the ralph iteration cap. Stop, summarize what you've " +
  "learned in your notepad, and request architect review before continuing.";

export async function runRalphCap(deps: RalphCapDeps): Promise<number> {
  try {
    const run_id = deps.env.OMC_CURRENT_RUN_ID;
    const task_id = deps.env.OMC_TASK_ID;
    if (!run_id || !task_id) return 0;

    const store = new ManifestStore(deps.stateDir);
    const current = store.read(run_id);
    if (!current) {
      // No manifest seeded yet — silent no-op so we don't break the agent
      // on an early-phase Stop firing before OMC has stamped the manifest.
      return 0;
    }

    const updated = store.update(run_id, (m) => {
      const prev = m.ralph_iterations[task_id] ?? 0;
      const next = prev + 1;
      const newIters = { ...m.ralph_iterations, [task_id]: next };
      // Threshold side-effects: only set the prompt prepend on the EXACT
      // crossing. We emit elsewhere (after the write) so a failed emit
      // doesn't roll back the counter — that would risk infinite re-emits
      // on retry.
      let nextPrompt = m.next_prompt_prepend;
      if (next === deps.maxIterations || next === deps.maxIterations * 2) {
        nextPrompt = PROMPT_PREPEND_WARN;
      }
      return { ...m, ralph_iterations: newIters, next_prompt_prepend: nextPrompt };
    });

    const count = updated.ralph_iterations[task_id] ?? 0;
    if (count === deps.maxIterations || count === deps.maxIterations * 2) {
      const severity = count === deps.maxIterations * 2 ? "page" : "warn";
      try {
        await deps.emitter.emit("agent.loop-exhausted", severity, {
          run_id,
          task_id,
          iteration: count,
          max_iterations: deps.maxIterations,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`ralph-cap: emit failed: ${msg}\n`);
      }
    }

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`ralph-cap: unexpected error: ${msg}\n`);
    return 0;
  }
}
