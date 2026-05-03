import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { RecoveryEmitter } from "./emit.ts";
import { ManifestStore } from "./manifest.ts";

/**
 * tmux stale-detect → ONE-shot auto-restart with checkpoint replay.
 * Mode (b) refinement of design §8 (tmux session goes stale).
 *
 * Invoked by clawhip's `tmux.stale` event handler. The session_name
 * follows the convention `<run_id>-leader` so we extract the run_id
 * from it.
 *
 * Logic:
 * 1. If `manifest.tmux_restart_attempted` already contains this
 *    session → emit `tmux.restart-exhausted` PAGE and exit 0 (one
 *    auto-restart per run, then escalate).
 * 2. Restore latest checkpoint files (notepad.md, project-memory.json,
 *    plans/) into the live `runs/<run_id>/` directory.
 * 3. Re-launch tmux session with `omc team --resume <run_id>`.
 * 4. Mark the attempt in the manifest BEFORE the spawn so an exception
 *    after launch doesn't risk a second auto-restart loop.
 * 5. Emit `tmux.restart-attempted` INFO (or `tmux.restart-failed` WARN
 *    on spawn error).
 */

export type TmuxRestartSpawn = (cmd: string[]) => Promise<{ exitCode: number; stderr: string }>;

export interface TmuxRestartDeps {
  stateDir: string;
  emitter: RecoveryEmitter;
  spawn: TmuxRestartSpawn;
  sessionName: string;
  stderr: (msg: string) => void;
}

export async function runTmuxRestart(deps: TmuxRestartDeps): Promise<number> {
  try {
    const run_id = parseRunIdFromSession(deps.sessionName);
    if (!run_id) {
      try {
        await deps.emitter.emit("tmux.restart-rejected", "warn", {
          session_name: deps.sessionName,
          reason: "session_name does not match <run_id>-leader convention",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`tmux-restart: emit failed: ${msg}\n`);
      }
      return 0;
    }

    const store = new ManifestStore(deps.stateDir);
    const current = store.read(run_id);
    if (!current) {
      try {
        await deps.emitter.emit("tmux.restart-rejected", "warn", {
          session_name: deps.sessionName,
          run_id,
          reason: "manifest not found — run never registered",
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`tmux-restart: emit failed: ${msg}\n`);
      }
      return 0;
    }

    if (current.tmux_restart_attempted.includes(deps.sessionName)) {
      // Second stale within the run — auto-recovery exhausted.
      try {
        await deps.emitter.emit("tmux.restart-exhausted", "page", {
          session_name: deps.sessionName,
          run_id,
          timestamp: new Date().toISOString(),
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`tmux-restart: emit failed: ${msg}\n`);
      }
      return 0;
    }

    // Restore checkpoint files (best-effort; absence skips replay).
    let replayed = false;
    try {
      replayed = restoreLatestCheckpoint(deps.stateDir, run_id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`tmux-restart: checkpoint restore failed: ${msg}\n`);
    }

    // Mark attempt BEFORE spawning to prevent infinite retries on
    // partial-success spawn failures.
    store.update(run_id, (m) => ({
      ...m,
      tmux_restart_attempted: [...m.tmux_restart_attempted, deps.sessionName],
    }));

    const newSession = await deps.spawn(["tmux", "new-session", "-d", "-s", deps.sessionName]);
    let resumeOk = newSession.exitCode === 0;
    if (resumeOk) {
      const send = await deps.spawn([
        "tmux",
        "send-keys",
        "-t",
        deps.sessionName,
        `omc team --resume ${run_id}`,
        "Enter",
      ]);
      resumeOk = send.exitCode === 0;
      if (!resumeOk) {
        deps.stderr(`tmux-restart: send-keys failed: ${send.stderr}\n`);
      }
    } else {
      deps.stderr(`tmux-restart: tmux new-session failed: ${newSession.stderr}\n`);
    }

    const event = resumeOk ? "tmux.restart-attempted" : "tmux.restart-failed";
    const severity = resumeOk ? "info" : "warn";
    try {
      await deps.emitter.emit(event, severity, {
        session_name: deps.sessionName,
        run_id,
        replayed_checkpoint: replayed,
        timestamp: new Date().toISOString(),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`tmux-restart: emit failed: ${msg}\n`);
    }

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.stderr(`tmux-restart: unexpected error: ${msg}\n`);
    return 0;
  }
}

function parseRunIdFromSession(sessionName: string): string | null {
  const m = /^(.+)-leader$/.exec(sessionName);
  if (!m) return null;
  return m[1] ?? null;
}

function restoreLatestCheckpoint(stateDir: string, run_id: string): boolean {
  const ckptRoot = join(stateDir, "runs", run_id, "checkpoints");
  if (!existsSync(ckptRoot)) return false;
  const entries = readdirSync(ckptRoot)
    .filter((e) => statSync(join(ckptRoot, e)).isDirectory())
    .sort();
  const latest = entries.at(-1);
  if (!latest) return false;
  const src = join(ckptRoot, latest);
  const dst = join(stateDir, "runs", run_id);
  copyTreeIfExists(src, dst, "notepad.md");
  copyTreeIfExists(src, dst, "project-memory.json");
  copyDirIfExists(join(src, "plans"), join(dst, "plans"));
  return true;
}

function copyTreeIfExists(srcDir: string, dstDir: string, name: string): void {
  const srcPath = join(srcDir, name);
  if (!existsSync(srcPath)) return;
  mkdirSync(dstDir, { recursive: true });
  copyFileSync(srcPath, join(dstDir, name));
}

function copyDirIfExists(srcDir: string, dstDir: string): void {
  if (!existsSync(srcDir)) return;
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const sp = join(srcDir, entry);
    const dp = join(dstDir, entry);
    const st = statSync(sp);
    if (st.isDirectory()) {
      copyDirIfExists(sp, dp);
    } else {
      copyFileSync(sp, dp);
    }
  }
}
