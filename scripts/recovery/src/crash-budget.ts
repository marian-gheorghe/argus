import type { RecoveryEmitter } from "./emit.ts";
import { ManifestStore, type RunManifest } from "./manifest.ts";

/**
 * Crash-budget enforcement. Block 3 Task 3.4 — design §8.2.
 *
 * A counter in `manifest.crash_count` increments on every "strike":
 * - tmux auto-restart attempt
 * - clawhip restart by watchdog
 * - 6th verifier disagreement
 * (other recovery scripts or the watchdog can call into this CLI to
 * record their own strikes.)
 *
 * At 3 strikes within a single run → emit
 * `crash-budget-exhausted` CRITICAL and `omc cancel <run_id>`. The
 * threshold trigger is idempotent: bumps 4, 5, ... do NOT re-emit and
 * do NOT re-cancel. The counter still increments so an operator can
 * see the post-halt strike trail.
 *
 * Auto-creates the manifest if missing (the bump might be the first
 * write to the run state — e.g., a clawhip-restart strike before OMC
 * has finished its own setup write).
 */

export interface CrashBudgetDeps {
  stateDir: string;
  emitter: RecoveryEmitter;
  threshold: number;
  cancelRun: (run_id: string) => Promise<void>;
  stderr: (msg: string) => void;
}

export interface BumpArgs {
  run_id: string;
  reason: string;
}

export interface BumpResult {
  count: number;
  escalated: boolean;
}

export async function runCrashBudgetBump(args: BumpArgs & CrashBudgetDeps): Promise<BumpResult> {
  const { run_id, reason, stateDir, emitter, threshold, cancelRun, stderr } = args;

  const store = new ManifestStore(stateDir);
  let current = store.read(run_id);
  if (!current) {
    // Seed a minimal manifest. The bump might be the first state write for
    // this run. Threshold logic still works because crash_count starts at 0
    // and we increment in update().
    current = bootstrapManifest(run_id);
    store.write(run_id, current);
  }

  const updated = store.update(run_id, (m) => ({
    ...m,
    crash_count: m.crash_count + 1,
  }));

  // Idempotent escalation: only fire on the EXACT crossing.
  const escalated = updated.crash_count === threshold;
  if (escalated) {
    try {
      await emitter.emit("crash-budget-exhausted", "critical", {
        run_id,
        reason,
        count: updated.crash_count,
        threshold,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`crash-budget: emit failed: ${msg}\n`);
    }

    try {
      await cancelRun(run_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      stderr(`crash-budget: cancelRun failed: ${msg}\n`);
    }
  }

  return { count: updated.crash_count, escalated };
}

function bootstrapManifest(run_id: string): RunManifest {
  return {
    run_id,
    started_at: new Date().toISOString(),
    state: "running",
    crash_count: 0,
    ralph_iterations: {},
    tmux_restart_attempted: [],
    provider_mode: "max20",
    provider_outage_started_at: null,
  };
}
