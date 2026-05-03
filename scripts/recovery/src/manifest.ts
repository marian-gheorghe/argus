/**
 * Per-run manifest store for Argus recovery module.
 *
 * **DUPLICATION TODO (Phase C+):**  This file has a slim duplicate at
 * `scripts/knowledge/src/manifest.ts`. Both modules read/write the same
 * `manifest.json`. We ship them side-by-side in Phase C; the cleanup
 * task is to extract the schema + store into a shared `argus-state`
 * package (workspace dep). Until then: keep both files in sync — any
 * field added here MUST be added to knowledge's manifest.ts too (and
 * vice versa) so that round-tripping a manifest written by one module
 * does not silently drop fields owned by the other.
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
 * `$OMC_STATE_DIR/runs/<run_id>/manifest.json`. Tracks crash budget,
 * ralph iteration counters, tmux restart attempts, provider mode, and
 * the optional `next_prompt_prepend` field shared with the dispatcher
 * skill for /learner cadence (Block 5).
 *
 * `passthrough()` lets the manifest carry forward fields written by a
 * newer build without losing them on round-trip — important during
 * staged rollouts.
 */
export const RunManifest = z
  .object({
    run_id: z.string(),
    started_at: z.string().datetime(),
    state: z.enum(["running", "paused", "completed", "failed", "paused-by-reboot"]),
    phase: z.string().optional(),
    crash_count: z.number().int().nonnegative().default(0),
    last_verify_pass_at: z.string().datetime().optional(),
    // task_id -> count (ralph iterations within the current phase)
    ralph_iterations: z.record(z.string(), z.number().int().nonnegative()).default({}),
    // session_names that have already exhausted their one auto-restart
    tmux_restart_attempted: z.array(z.string()).default([]),
    provider_mode: z.enum(["max20", "api"]).default("max20"),
    provider_outage_started_at: z.string().datetime().nullable().default(null),
    // /learner cadence — set by recovery hooks, consumed by OMC's submit hook
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
 * - **Atomic writes** via tmp-file + fsync + rename(2). The temp file
 *   carries the writer pid so concurrent writers don't collide on the
 *   same temp name. Mode 0600 on both tmp and final file.
 * - **Cross-process locking** via a sidecar `manifest.lock` file.
 *   `update()` opens it with O_EXCL ("wx") to acquire; on EEXIST,
 *   spin-waits up to 2s (10ms intervals) before throwing. The lock
 *   is unlinked on every exit path including throws.
 *
 * For higher-contention scenarios, sqlite advisory locking would be a
 * cleaner replacement. We use the file-lock pattern here because it
 * needs no extra deps and works identically on Linux/macOS.
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
    // Validate before write so we never persist a corrupt shape.
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

  /**
   * Read-modify-write under a sidecar file lock. The callback receives a
   * deeply-immutable manifest snapshot; it must return the new manifest.
   */
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
      // Release: close the descriptor, then unlink. unlink-while-open is
      // safe on POSIX. On any throw above, both calls still execute.
      try {
        closeSync(lockFd);
      } catch {
        // already closed somehow — proceed to unlink
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // already gone — fine
      }
    }
  }

  private acquireLock(lockPath: string): number {
    const deadline = Date.now() + this.lockMaxWaitMs;
    for (;;) {
      try {
        // O_EXCL | O_CREAT — fails if file exists.
        return openSync(lockPath, "wx", 0o600);
      } catch (e) {
        if (!isEEXIST(e)) throw e;
        if (Date.now() >= deadline) {
          throw new Error(
            `ManifestStore.update: failed to acquire lock at ${lockPath} within ${this.lockMaxWaitMs}ms`,
          );
        }
        // Busy-wait. Synchronous spin keeps the cross-process semantic
        // simple; for our 5-concurrent worst case this completes in <50ms.
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
