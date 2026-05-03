/**
 * Per-run manifest store for Argus knowledge module.
 *
 * **DUPLICATION TODO (Phase C+):**  This file is a slim duplicate of
 * `scripts/recovery/src/manifest.ts`. Both modules need atomic JSON
 * read/write + sidecar-lock semantics for the same `manifest.json`
 * file. We ship them side-by-side in Phase C; the cleanup task is to
 * extract the schema + store into a shared `argus-state` package
 * (workspace dep). Until then: keep both files in sync — any field
 * added here MUST be added to recovery's manifest.ts too (and vice
 * versa) so that round-tripping a manifest written by one module does
 * not silently drop fields owned by the other. `passthrough()` on the
 * zod schema forgives forward-compat drift but only at runtime; the
 * compiled types still need parity.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Per-run manifest schema. Lives at
 * `$OMC_STATE_DIR/runs/<run_id>/manifest.json`.
 *
 * Knowledge module exercises:
 * - `phase` — current phase identifier (e.g., "harness", "first-batch").
 * - `next_prompt_prepend` — set to `/learner` at phase boundaries; read
 *   and cleared by OMC's submit-hook.
 * - `phase_boundary_seen_at` — timestamp of the most recent transition
 *   detected by the learner-cadence Stop hook. Helps debugging "did we
 *   actually queue /learner at the boundary?" without grepping logs.
 *
 * Other fields exist for the recovery module's bookkeeping (crash
 * count, ralph iteration counters, tmux restart attempts, provider
 * mode). Knowledge does not modify them but must round-trip them
 * correctly.
 *
 * `passthrough()` lets the manifest carry forward fields written by a
 * newer build without losing them on round-trip.
 */
export const RunManifest = z
  .object({
    run_id: z.string(),
    started_at: z.string().datetime(),
    state: z.enum(["running", "paused", "completed", "failed", "paused-by-reboot"]),
    phase: z.string().optional(),
    crash_count: z.number().int().nonnegative().default(0),
    last_verify_pass_at: z.string().datetime().optional(),
    ralph_iterations: z.record(z.string(), z.number().int().nonnegative()).default({}),
    tmux_restart_attempted: z.array(z.string()).default([]),
    provider_mode: z.enum(["max20", "api"]).default("max20"),
    provider_outage_started_at: z.string().datetime().nullable().default(null),
    next_prompt_prepend: z.string().optional(),
    // Knowledge / Block 5: timestamp of the last detected phase transition.
    phase_boundary_seen_at: z.string().datetime().optional(),
  })
  .passthrough();

export type RunManifest = z.infer<typeof RunManifest>;

/**
 * Atomic JSON store for manifest.json files under
 * `<stateDir>/runs/<run_id>/manifest.json`.
 *
 * Same semantics as `scripts/recovery/src/manifest.ts`: atomic writes
 * via tmp-file + fsync + rename(2), cross-process serialisation via a
 * sidecar `manifest.lock` opened O_EXCL. See the header TODO above.
 */
export class ManifestStore {
  private readonly stateDir: string;
  private readonly lockMaxWaitMs: number;
  private readonly lockSpinMs: number;

  constructor(stateDir: string, opts?: { lockMaxWaitMs?: number; lockSpinMs?: number }) {
    this.stateDir = stateDir;
    this.lockMaxWaitMs = opts?.lockMaxWaitMs ?? 2000;
    this.lockSpinMs = opts?.lockSpinMs ?? 10;
  }

  manifestPath(run_id: string): string {
    return join(this.stateDir, "runs", run_id, "manifest.json");
  }

  lockPath(run_id: string): string {
    return join(this.stateDir, "runs", run_id, "manifest.lock");
  }

  read(run_id: string): RunManifest | null {
    let raw: string;
    try {
      raw = readFileSync(this.manifestPath(run_id), "utf8");
    } catch (e) {
      if (isENOENT(e)) return null;
      throw e;
    }
    const parsed = JSON.parse(raw) as unknown;
    return RunManifest.parse(parsed);
  }

  write(run_id: string, manifest: RunManifest): void {
    const validated = RunManifest.parse(manifest);
    const dir = join(this.stateDir, "runs", run_id);
    mkdirSync(dir, { recursive: true });
    const finalPath = this.manifestPath(run_id);
    const tmpPath = `${finalPath}.tmp.${process.pid}`;
    const fd = openSync(tmpPath, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(validated, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, finalPath);
  }

  update(run_id: string, fn: (m: RunManifest) => RunManifest): RunManifest {
    const lockPath = this.lockPath(run_id);
    const dir = join(this.stateDir, "runs", run_id);
    mkdirSync(dir, { recursive: true });

    const lockFd = this.acquireLock(lockPath);
    try {
      const current = this.read(run_id);
      if (current === null) {
        throw new Error(`ManifestStore.update: manifest for run_id=${run_id} does not exist`);
      }
      const next = fn(current);
      this.write(run_id, next);
      return next;
    } finally {
      try {
        closeSync(lockFd);
      } catch {
        // already closed
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone
      }
    }
  }

  private acquireLock(lockPath: string): number {
    const deadline = Date.now() + this.lockMaxWaitMs;
    for (;;) {
      try {
        return openSync(lockPath, "wx", 0o600);
      } catch (e) {
        if (!isEEXIST(e)) throw e;
        if (Date.now() >= deadline) {
          throw new Error(
            `ManifestStore.update: failed to acquire lock at ${lockPath} within ${this.lockMaxWaitMs}ms`,
          );
        }
        const spinUntil = Date.now() + this.lockSpinMs;
        while (Date.now() < spinUntil) {
          // intentionally empty: short busy-wait
        }
      }
    }
  }
}

function isENOENT(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
}

function isEEXIST(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "EEXIST";
}
