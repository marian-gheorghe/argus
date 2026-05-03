import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { GateWatcher } from "../src/gate-watcher.ts";
import { OutboundQueue } from "../src/queue.ts";

const silentLog = pino({ level: "silent" });

const validPending = {
  gate_id: "gate_1",
  run_id: "run_abc",
  type: "PRD" as const,
  title: "Gate 1 — PRD approval",
  summary: "Stripe payment service.",
  key_decisions: ["Stripe SDK v15"],
  artifact_path: "/tmp/prd.md",
  diff_url: "https://example.com/diff",
  created_at: "2026-05-03T07:00:00Z",
  timeout_at: "2026-05-04T07:00:00Z",
};

let tmpDir: string;
let gatesDir: string;
let dbPath: string;
let queue: OutboundQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-gw-"));
  gatesDir = join(tmpDir, "gates");
  dbPath = join(tmpDir, "queue.sqlite");
  // chokidar can recursively watch a path that exists; create gates dir.
  require("node:fs").mkdirSync(gatesDir, { recursive: true });
  queue = new OutboundQueue(dbPath);
});

afterEach(() => {
  queue.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("GateWatcher", () => {
  test("startup sweep: existing pending files are enqueued after start", async () => {
    writeFileSync(
      join(gatesDir, "gate_1.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_1" }),
    );
    writeFileSync(
      join(gatesDir, "gate_2.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_2" }),
    );
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    expect(queue.depth()).toBe(2);
    ctrl.abort();
    await w.stop();
  });

  test("file added after start is enqueued within ~200ms", async () => {
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    expect(queue.depth()).toBe(0);
    writeFileSync(
      join(gatesDir, "gate_X.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_X" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(1);
    ctrl.abort();
    await w.stop();
  });

  test("non-pending files are ignored", async () => {
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    writeFileSync(join(gatesDir, "foo.txt"), "ignored");
    writeFileSync(
      join(gatesDir, "gate_1.decision.json"),
      JSON.stringify({ gate_id: "gate_1", decision: "approved" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(0);
    ctrl.abort();
    await w.stop();
  });

  test("malformed JSON file is logged + skipped, watcher keeps running", async () => {
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    writeFileSync(join(gatesDir, "broken.pending.json"), "{not-json");
    await wait(300);
    expect(queue.depth()).toBe(0);

    // Watcher still alive: drop a valid file.
    writeFileSync(
      join(gatesDir, "gate_ok.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_ok" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(1);
    ctrl.abort();
    await w.stop();
  });

  test("duplicate gate (same gate_id) is deduplicated by event_id", async () => {
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    writeFileSync(
      join(gatesDir, "gate_dup.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_dup" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(1);
    // Re-write — chokidar fires `change`, but enqueue dedup keeps depth at 1.
    writeFileSync(
      join(gatesDir, "gate_dup.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_dup", title: "modified" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(1);
    ctrl.abort();
    await w.stop();
  });

  test("abort signal stops the watcher; later writes do not enqueue", async () => {
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    ctrl.abort();
    await w.stop();
    writeFileSync(
      join(gatesDir, "gate_late.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_late" }),
    );
    await wait(300);
    expect(queue.depth()).toBe(0);
  });

  test("enqueued payload is shaped like a clawhip event with tier='gate'", async () => {
    writeFileSync(
      join(gatesDir, "gate_inspect.pending.json"),
      JSON.stringify({ ...validPending, gate_id: "gate_inspect" }),
    );
    const w = new GateWatcher({ gatesDir, queue, log: silentLog });
    const ctrl = new AbortController();
    await w.start(ctrl.signal);
    const row = queue.peek();
    expect(row).not.toBeNull();
    if (row) {
      expect(row.event_id).toBe("gate.pending:gate_inspect");
      const payload = JSON.parse(row.payload) as {
        tier?: string;
        event?: { event?: string; severity?: string; gate_id?: string; event_id?: string };
      };
      expect(payload.tier).toBe("gate");
      expect(payload.event?.event).toBe("gate.pending");
      expect(payload.event?.severity).toBe("info");
      expect(payload.event?.gate_id).toBe("gate_inspect");
      expect(payload.event?.event_id).toBe("gate.pending:gate_inspect");
    }
    ctrl.abort();
    await w.stop();
  });
});
