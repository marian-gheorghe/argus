/**
 * /learner cadence — Stop-hook entry (design §9.1).
 *
 * At every phase boundary, queue `/learner` to fire on the next agent
 * prompt by setting `manifest.next_prompt_prepend = "/learner"`. The
 * dispatcher / OMC submit-hook reads + clears this field when it
 * builds the next user message.
 *
 * Trigger criteria — we transitioned phases iff:
 *   1. OMC_CURRENT_RUN_ID is set (we're inside an active run)
 *   2. OMC_CURRENT_PHASE is set (the dispatcher tagged this stop with
 *      its current phase)
 *   3. manifest.phase != OMC_CURRENT_PHASE (prior stop was at a
 *      different phase, including "no phase yet")
 *
 * Idempotency:
 * - If `next_prompt_prepend` is already `/learner`, leave it.
 * - If `next_prompt_prepend` is set to something *other* than
 *   `/learner`, do NOT overwrite it. The dispatcher gets first claim
 *   on the field; we'll catch the next boundary instead. This keeps
 *   the contract one-writer-wins-but-explicit.
 *
 * Crash resistance: Stop hooks must never block the agent. Any
 * internal error is caught and exits 0; the failure is written to
 * stderr (which launchd captures to the log file) for postmortem.
 */

import { ManifestStore } from "./manifest.ts";

export interface LearnerCadenceOpts {
  env: Record<string, string | undefined>;
  stateDir: string;
  stderr: (msg: string) => void;
  now: () => Date;
}

export async function runLearnerCadence(opts: LearnerCadenceOpts): Promise<number> {
  try {
    const run_id = opts.env.OMC_CURRENT_RUN_ID;
    const currentPhase = opts.env.OMC_CURRENT_PHASE;
    if (!run_id || !currentPhase) {
      // No run / no phase tag -> nothing to do.
      return 0;
    }
    const store = new ManifestStore(opts.stateDir);
    const existing = store.read(run_id);
    if (existing === null) {
      // Manifest hasn't been seeded yet — recovery owns the seed.
      return 0;
    }
    if (existing.phase === currentPhase) {
      // Same phase, no transition.
      return 0;
    }

    // Transition detected: bump phase + queue /learner (idempotent).
    store.update(run_id, (m) => {
      const next = { ...m, phase: currentPhase };
      next.phase_boundary_seen_at = opts.now().toISOString();
      const queued = m.next_prompt_prepend;
      if (queued === undefined || queued === "" || queued.startsWith("/learner")) {
        next.next_prompt_prepend = "/learner";
      }
      // else: a different prompt is already queued — leave it; we'll
      // catch the next boundary.
      return next;
    });

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.stderr(`learner-cadence: internal error (suppressed): ${msg}\n`);
    return 0;
  }
}
