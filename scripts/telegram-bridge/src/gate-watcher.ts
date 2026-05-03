import { readFileSync } from "node:fs";
import { basename } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { Logger } from "pino";
import type { OutboundQueue } from "./queue.ts";
import { type GatePending, GatePending as GatePendingSchema } from "./schemas.ts";
import type { QueuedPayload } from "./server.ts";

interface GateWatcherDeps {
  gatesDir: string;
  queue: OutboundQueue;
  log: Logger;
}

const PENDING_SUFFIX = ".pending.json";

/**
 * Watches `gatesDir` for `*.pending.json` files written by the OMC dispatcher.
 *
 * On startup: sweeps existing pending files (the durable path — catches
 * anything written while the bridge was offline). On ongoing additions:
 * chokidar fires `add`, we enqueue.
 *
 * Idempotency: `event_id` is `gate.pending:<gate_id>` so re-firing the same
 * gate (or chokidar's `change` event on the same path) is a queue-level no-op
 * via the UNIQUE(event_id) dedup in `OutboundQueue`.
 *
 * Why chokidar (not `fs.watch`): macOS `fs.watch` recursive returns paths
 * relative to the watched dir; Linux uses `inotify` semantics with different
 * coalescing rules. chokidar normalizes both and adds a debounced-stable
 * `awaitWriteFinish` for partially-written files.
 */
export class GateWatcher {
  private readonly gatesDir: string;
  private readonly queue: OutboundQueue;
  private readonly log: Logger;
  private watcher: FSWatcher | null = null;
  private aborted = false;

  constructor(deps: GateWatcherDeps) {
    this.gatesDir = deps.gatesDir;
    this.queue = deps.queue;
    this.log = deps.log;
  }

  async start(signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      this.aborted = true;
      return;
    }
    signal.addEventListener("abort", () => {
      this.aborted = true;
      void this.stop();
    });

    // chokidar handles the startup sweep itself: it emits `add` for existing files
    // immediately on `ready`. We resolve start() once `ready` fires so callers
    // can be sure the sweep is complete.
    const watcher = chokidar.watch(this.gatesDir, {
      ignoreInitial: false,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
    });
    this.watcher = watcher;

    watcher.on("add", (path) => this.handleFile(path));
    watcher.on("change", (path) => this.handleFile(path));
    watcher.on("error", (err) => {
      this.log.error({ err: err instanceof Error ? err.message : String(err) }, "watcher error");
    });

    await new Promise<void>((resolve) => {
      watcher.once("ready", () => resolve());
    });
  }

  async stop(): Promise<void> {
    if (this.watcher) {
      const w = this.watcher;
      this.watcher = null;
      await w.close();
    }
  }

  private handleFile(path: string): void {
    if (this.aborted) return;
    const name = basename(path);
    if (!name.endsWith(PENDING_SUFFIX)) {
      // Ignore .decision.json (we write those), foo.txt, etc.
      return;
    }
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ path, err: msg }, "gate-watcher: read failed");
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log.warn({ path, err: msg }, "gate-watcher: invalid JSON, skipping");
      return;
    }
    const parsed = GatePendingSchema.safeParse(json);
    if (!parsed.success) {
      this.log.warn(
        { path, issues: parsed.error.issues },
        "gate-watcher: schema validation failed, skipping",
      );
      return;
    }
    const gate = parsed.data;
    const event_id = `gate.pending:${gate.gate_id}`;
    const payload: QueuedPayload = {
      tier: "gate",
      event: gateToClawhip(event_id, gate),
    };
    const result = this.queue.enqueue(event_id, payload);
    this.log.info(
      {
        path,
        gate_id: gate.gate_id,
        event_id,
        queued_id: result.id,
        deduplicated: !result.created,
      },
      "gate-watcher: enqueued",
    );
  }
}

/**
 * Convert a `GatePending` (from disk) into a `ClawhipWebhookEvent` shape so
 * it flows through the same outbound queue + render path as a clawhip-emitted
 * `gate.pending` event would. `severity: "info"` because the gate "alert"
 * routes by tier (`gate` chat), not by severity tier.
 */
function gateToClawhip(
  event_id: string,
  gate: GatePending,
): {
  event_id: string;
  event: string;
  severity: "info";
  message: string;
  run_id: string;
  gate_id: string;
  summary: string;
  key_decisions: string[];
  artifact_path: string;
  diff_url?: string;
  timeout_at: string;
} {
  const base = {
    event_id,
    event: "gate.pending",
    severity: "info" as const,
    message: gate.title,
    run_id: gate.run_id,
    gate_id: gate.gate_id,
    summary: gate.summary,
    key_decisions: gate.key_decisions,
    artifact_path: gate.artifact_path,
    timeout_at: gate.timeout_at,
  };
  if (gate.diff_url) {
    return { ...base, diff_url: gate.diff_url };
  }
  return base;
}
