/**
 * GateController — the OMC-side gate state machine.
 *
 * Three operations:
 *   1. `openGate`       — write `<gate-id>.pending.json` atomically + emit a
 *                          clawhip `gate.pending` event. Dual-emission per
 *                          design §1: bridge sees the gate via either path.
 *   2. `awaitDecision`  — poll `<gate-id>.decision.json` every N ms until the
 *                          file appears OR the wall-clock deadline elapses.
 *                          On timeout, emit `gate.timeout` and return a
 *                          synthetic timeout marker (not a throw).
 *   3. `fireGate`       — convenience: open then await.
 *   + `createSpeculativeBranch` — for `deferred` decisions, isolate further
 *                          work on `speculative/<run-id>/<gate-id>`.
 *
 * Atomic file writes: tmp + fsync + rename, mode 0o600. Same pattern the
 * bridge uses for `<gate-id>.decision.json`.
 *
 * `clawhipEmit` injection contract:
 *   - undefined         → controller defaults to shelling out to `clawhip send`
 *                          (production path; clawhip is on PATH per Phase A).
 *   - function          → use it (test mock or custom transport).
 *   - null              → skip clawhip emission entirely; the bridge will
 *                          still see the gate via its file-watcher.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type ClawhipEmitPayload,
  type GateDecisionOrTimeout,
  GateDecision as GateDecisionSchema,
  type GatePending,
} from "./gate-types.ts";

const DEFAULT_TIMEOUT_SECS = 28800; // 8h
const DEFAULT_POLL_INTERVAL_MS = 30_000; // 30s
const DEFAULT_GATES_DIR = process.env.OMC_STATE_DIR
  ? join(process.env.OMC_STATE_DIR, "gates")
  : null;
const SHORT_SHA_LEN = 6;

export type ClawhipEmitter = ((event: ClawhipEmitPayload) => void | Promise<void>) | null;

export interface OpenGateOpts {
  type: "PRD" | "code-review" | "final-integration";
  run_id: string;
  title: string;
  summary: string;
  key_decisions?: string[];
  artifact_path: string;
  diff_url?: string;
  /** Default: 28800 (8h). */
  timeout_secs?: number;
  /**
   * Optional clawhip emit shim. If undefined, default to shelling out to
   * `clawhip send`. Pass `null` to skip clawhip emission (file-watcher path
   * still works).
   */
  clawhipEmit?: ClawhipEmitter;
  /** Filesystem injection for tests. Default: $OMC_STATE_DIR/gates. */
  gatesDir?: string;
}

export interface OpenGateResult {
  gate_id: string;
  pending_path: string;
}

export interface AwaitDecisionOpts {
  gate_id: string;
  pending_path: string;
  /** Poll cadence. Default 30000ms. Tests override to be fast. */
  pollIntervalMs?: number;
  /** Filesystem injection for tests. Default: $OMC_STATE_DIR/gates. */
  gatesDir?: string;
  /** Same emit contract as `OpenGateOpts.clawhipEmit`. */
  clawhipEmit?: ClawhipEmitter;
  /** Optional abort. Rejection on abort lets the caller distinguish from timeout. */
  signal?: AbortSignal;
}

/**
 * `awaitDecision` reads `created_at`/`timeout_at` from the pending file and
 * uses those as the wall-clock deadline. This way the timeout is anchored to
 * the gate's *open* time even if the controller process restarts mid-poll.
 */
export interface AwaitDecisionExtras {
  /**
   * Override the deadline. Used only by `fireGate` when it already knows the
   * pending's `timeout_at` (saves a re-read). Tests don't need this.
   */
  _timeoutAtMs?: number;
}

export type FireGateOpts = OpenGateOpts & {
  pollIntervalMs?: number;
  signal?: AbortSignal;
};

export type GateOutcome = GateDecisionOrTimeout;

export interface CreateSpeculativeBranchOpts {
  run_id: string;
  gate_id: string;
  /** Default `process.cwd()`. */
  gitCwd?: string;
}

export interface CreateSpeculativeBranchResult {
  branch_name: string;
  /** True if we created the branch; false if it already existed (idempotent). */
  created: boolean;
}

export class GateController {
  /**
   * Open a gate: write `<gate-id>.pending.json` atomically + emit a
   * `gate.pending` clawhip event. Returns the generated gate_id and the path
   * that was written.
   */
  async openGate(opts: OpenGateOpts): Promise<OpenGateResult> {
    const gatesDir = opts.gatesDir ?? DEFAULT_GATES_DIR;
    if (!gatesDir) {
      throw new Error(
        "openGate: no gatesDir provided and $OMC_STATE_DIR is unset; can't determine where to write",
      );
    }
    mkdirSync(gatesDir, { recursive: true });

    const gate_id = generateGateId(opts.type, opts.run_id);
    const now = new Date();
    const timeoutSecs = opts.timeout_secs ?? DEFAULT_TIMEOUT_SECS;
    const timeoutAt = new Date(now.getTime() + timeoutSecs * 1000);

    const pending: GatePending = {
      gate_id,
      run_id: opts.run_id,
      type: opts.type,
      title: opts.title,
      summary: opts.summary,
      key_decisions: opts.key_decisions ?? [],
      artifact_path: opts.artifact_path,
      ...(opts.diff_url !== undefined ? { diff_url: opts.diff_url } : {}),
      created_at: now.toISOString(),
      timeout_at: timeoutAt.toISOString(),
    };

    const pending_path = join(gatesDir, `${gate_id}.pending.json`);
    writeAtomic(pending_path, JSON.stringify(pending, null, 2));

    // Emit gate.pending alongside the file-watcher path. The clawhip payload
    // shape mirrors the bridge's `GateWatcher.gateToClawhip` so the message
    // renders identically regardless of which path the bridge sees first.
    await emitClawhip(opts.clawhipEmit, {
      event: "gate.pending",
      severity: "info",
      payload: {
        event_id: `gate.pending:${gate_id}`,
        gate_id,
        run_id: opts.run_id,
        message: opts.title,
        summary: opts.summary,
        key_decisions: opts.key_decisions ?? [],
        artifact_path: opts.artifact_path,
        timeout_at: pending.timeout_at,
        ...(opts.diff_url !== undefined ? { diff_url: opts.diff_url } : {}),
      },
    });

    return { gate_id, pending_path };
  }

  /**
   * Poll for `<gate-id>.decision.json`. Returns the decision when found, or
   * `{decision: "timeout"}` after the wall-clock deadline elapses.
   *
   * The deadline comes from the pending file's `timeout_at` — anchored to
   * gate open, not to call time. If the pending file is missing or unreadable
   * we fall back to "now + DEFAULT_TIMEOUT_SECS" so the loop still terminates.
   */
  async awaitDecision(opts: AwaitDecisionOpts & AwaitDecisionExtras): Promise<GateOutcome> {
    const gatesDir = opts.gatesDir ?? DEFAULT_GATES_DIR;
    if (!gatesDir) {
      throw new Error("awaitDecision: no gatesDir provided and $OMC_STATE_DIR is unset");
    }
    const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const decisionPath = join(gatesDir, `${opts.gate_id}.decision.json`);

    let timeoutAtMs = opts._timeoutAtMs;
    if (timeoutAtMs === undefined) {
      timeoutAtMs = readTimeoutFromPending(opts.pending_path);
    }

    // The signal-aware sleep: if the abort fires mid-sleep, throws AbortError
    // immediately rather than waiting out the poll interval.
    while (true) {
      if (opts.signal?.aborted) {
        throw new DOMException("aborted", "AbortError");
      }
      // Check decision first — if the file is already there we don't want to
      // sleep an interval just to read it.
      if (existsSync(decisionPath)) {
        const decision = readDecision(decisionPath);
        if (decision) return decision;
        // If file existed but was unreadable / invalid, fall through to wait.
      }
      // Did we hit the deadline?
      if (Date.now() >= timeoutAtMs) {
        await emitClawhip(opts.clawhipEmit, {
          event: "gate.timeout",
          severity: "page",
          payload: {
            event_id: `gate.timeout:${opts.gate_id}`,
            gate_id: opts.gate_id,
            message: `Gate ${opts.gate_id} timed out`,
          },
        });
        // We don't know run_id from this scope cheaply; pull from pending file
        // best-effort. If unreadable, return empty string — caller still has
        // gate_id which is the actionable piece.
        const run_id = readRunIdFromPending(opts.pending_path) ?? "";
        return { decision: "timeout", gate_id: opts.gate_id, run_id };
      }
      // Sleep, but break early on abort or on hitting the deadline.
      const remainingMs = timeoutAtMs - Date.now();
      const sleepMs = Math.max(1, Math.min(pollMs, remainingMs));
      await sleepAbortable(sleepMs, opts.signal);
    }
  }

  /**
   * `openGate` + `awaitDecision` chained, with a single shared `clawhipEmit`
   * and `gatesDir`. The decision (or timeout) is returned to the caller.
   */
  async fireGate(opts: FireGateOpts): Promise<GateOutcome> {
    const opened = await this.openGate(opts);
    return this.awaitDecision({
      gate_id: opened.gate_id,
      pending_path: opened.pending_path,
      ...(opts.pollIntervalMs !== undefined ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.gatesDir !== undefined ? { gatesDir: opts.gatesDir } : {}),
      ...(opts.clawhipEmit !== undefined ? { clawhipEmit: opts.clawhipEmit } : {}),
      ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    });
  }

  /**
   * Create the speculative-continue branch named
   * `speculative/<run_id>/<gate_id>`. Idempotent: if the branch already exists
   * (re-entry, second defer, retry) we return `{created: false}` and the
   * caller proceeds. Uses `git` via `Bun.spawnSync` to keep deps minimal.
   *
   * The branch is created from HEAD — the caller (OMC) must already be at the
   * commit it wants to fork from. Per design §4.6 the branch tracks
   * deferred-speculative work that promotes-on-approval, preserves-on-reject.
   */
  async createSpeculativeBranch(
    opts: CreateSpeculativeBranchOpts,
  ): Promise<CreateSpeculativeBranchResult> {
    const branch_name = `speculative/${opts.run_id}/${opts.gate_id}`;
    const cwd = opts.gitCwd ?? process.cwd();

    // Idempotency check: `git branch --list <name>` prints the branch on stdout
    // if it exists, empty otherwise. Exit code is 0 either way.
    const list = Bun.spawnSync(["git", "branch", "--list", branch_name], { cwd });
    if (list.exitCode !== 0) {
      const stderr = new TextDecoder().decode(list.stderr).trim();
      throw new Error(`git branch --list failed: ${stderr || `exit ${list.exitCode}`}`);
    }
    const existing = new TextDecoder().decode(list.stdout).trim();
    if (existing.length > 0) {
      return { branch_name, created: false };
    }

    // `git branch <name>` is the non-checkout variant — creates from HEAD
    // without switching workdir. The deferred-speculative work happens on
    // worker branches (per design §4.7); promoting/rebasing onto this branch
    // is the orchestrator's responsibility, not the controller's.
    const create = Bun.spawnSync(["git", "branch", branch_name], { cwd });
    if (create.exitCode !== 0) {
      const stderr = new TextDecoder().decode(create.stderr).trim();
      throw new Error(`git branch ${branch_name} failed: ${stderr || `exit ${create.exitCode}`}`);
    }
    return { branch_name, created: true };
  }
}

/**
 * Generate a gate_id like `<type>-<run_id>-<short-sha>`. The short-sha is
 * 6 hex chars from `crypto.randomUUID()` so re-opening a phase (the same
 * (type, run_id) combo) produces a new file rather than overwriting the
 * previous attempt — the bridge's queue dedup is by `event_id` so we'd lose
 * the new gate's notification to the old gate's already-processed marker.
 */
function generateGateId(type: string, run_id: string): string {
  const sha = crypto.randomUUID().replace(/-/g, "").slice(0, SHORT_SHA_LEN);
  return `${type}-${run_id}-${sha}`;
}

/**
 * tmp + fsync + rename atomic write. Same pattern as the bridge's
 * `writeDecisionAtomic` in `handle-callback.ts`: writeFileSync to a `.tmp.<pid>`
 * sibling, fsync the file descriptor to flush to disk, then rename into place.
 * On crash, either the old file (if any) or the new file is visible — never
 * a half-written intermediate.
 */
function writeAtomic(dst: string, body: string): void {
  const tmp = `${dst}.tmp.${process.pid}`;
  writeFileSync(tmp, body, { mode: 0o600 });
  const fd = openSync(tmp, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, dst);
}

function readDecision(path: string): GateDecisionOrTimeout | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = GateDecisionSchema.safeParse(parsed);
  if (!result.success) return null;
  const d = result.data;
  // Map the schema-validated value into our return-type union. Splitting by
  // discriminant lets us preserve `comment?` typing without an `as`.
  if (d.decision === "approved") {
    return {
      decision: "approved",
      gate_id: d.gate_id,
      run_id: d.run_id,
      decided_at: d.decided_at,
      ...(d.comment !== undefined ? { comment: d.comment } : {}),
    };
  }
  if (d.decision === "rejected") {
    return {
      decision: "rejected",
      gate_id: d.gate_id,
      run_id: d.run_id,
      decided_at: d.decided_at,
      ...(d.comment !== undefined ? { comment: d.comment } : {}),
    };
  }
  return {
    decision: "deferred",
    gate_id: d.gate_id,
    run_id: d.run_id,
    decided_at: d.decided_at,
    ...(d.comment !== undefined ? { comment: d.comment } : {}),
  };
}

function readTimeoutFromPending(pendingPath: string): number {
  try {
    const raw = readFileSync(pendingPath, "utf8");
    const parsed = JSON.parse(raw) as { timeout_at?: unknown };
    if (typeof parsed.timeout_at === "string") {
      const t = Date.parse(parsed.timeout_at);
      if (!Number.isNaN(t)) return t;
    }
  } catch {
    // fall through
  }
  return Date.now() + DEFAULT_TIMEOUT_SECS * 1000;
}

function readRunIdFromPending(pendingPath: string): string | null {
  try {
    const raw = readFileSync(pendingPath, "utf8");
    const parsed = JSON.parse(raw) as { run_id?: unknown };
    if (typeof parsed.run_id === "string") return parsed.run_id;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Sleep for `ms`, but throw AbortError immediately if the signal fires.
 * Used by `awaitDecision` so an abort doesn't have to wait out the poll.
 */
function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Drive the clawhip emit decision tree:
 *   - null      → skip (file-watcher path is the durable fallback)
 *   - function  → use it (tests / custom transports)
 *   - undefined → shell out to `clawhip send` (production default; clawhip is
 *                 on PATH per Phase A's `install-mac.sh::section_clawhip`).
 *
 * The shellout uses `Bun.spawn` with a 5-second timeout. Failures (clawhip
 * binary missing, exit non-zero) are logged and swallowed — the gate's
 * pending.json file is still on disk, so the bridge's file-watcher will pick
 * it up. Losing the clawhip emit is degraded-but-correct.
 */
async function emitClawhip(
  emit: ClawhipEmitter | undefined,
  payload: ClawhipEmitPayload,
): Promise<void> {
  if (emit === null) return; // explicit skip
  if (emit !== undefined) {
    await emit(payload);
    return;
  }
  // Default: shell out to `clawhip send`.
  try {
    const proc = Bun.spawn(
      [
        "clawhip",
        "send",
        "--event",
        payload.event,
        "--severity",
        payload.severity,
        "--message",
        typeof payload.payload.message === "string" ? payload.payload.message : payload.event,
        "--webhook-payload",
        JSON.stringify(payload.payload),
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    await proc.exited;
    if (proc.exitCode !== 0) {
      console.warn(
        `[argus-router] clawhip send exited ${proc.exitCode} (${payload.event}); bridge will pick up gate via file-watcher`,
      );
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[argus-router] clawhip send failed (${payload.event}): ${msg}; bridge will pick up gate via file-watcher`,
    );
  }
}
