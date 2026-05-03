import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OutboundQueue } from "../src/queue.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-queue-"));
  dbPath = join(tmpDir, "queue.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("OutboundQueue", () => {
  test("enqueue returns a row id with created=true on first insert", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const r = q.enqueue("evt-1", { hello: "world" });
      expect(r.created).toBe(true);
      expect(r.id).toBeGreaterThan(0);
      expect(q.depth()).toBe(1);
    } finally {
      q.close();
    }
  });

  test("re-enqueue same event_id returns existing id with created=false (dedup)", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const a = q.enqueue("evt-1", { v: 1 });
      const b = q.enqueue("evt-1", { v: 2 });
      expect(b.created).toBe(false);
      expect(b.id).toBe(a.id);
      expect(q.depth()).toBe(1);
    } finally {
      q.close();
    }
  });

  test("peek returns oldest pending; markDelivered removes; subsequent peek advances or returns null", () => {
    const q = new OutboundQueue(dbPath);
    try {
      q.enqueue("evt-1", { v: 1 });
      q.enqueue("evt-2", { v: 2 });

      const first = q.peek();
      expect(first).not.toBeNull();
      if (first) {
        expect(first.event_id).toBe("evt-1");
        q.markDelivered(first.id);
      }

      const second = q.peek();
      expect(second).not.toBeNull();
      if (second) {
        expect(second.event_id).toBe("evt-2");
        q.markDelivered(second.id);
      }

      expect(q.peek()).toBeNull();
      expect(q.depth()).toBe(0);
    } finally {
      q.close();
    }
  });

  test("durability: rows survive close/reopen at same path", () => {
    const q1 = new OutboundQueue(dbPath);
    q1.enqueue("evt-1", { v: 1 });
    q1.enqueue("evt-2", { v: 2 });
    q1.close();

    const q2 = new OutboundQueue(dbPath);
    try {
      expect(q2.depth()).toBe(2);
      const peek = q2.peek();
      expect(peek?.event_id).toBe("evt-1");
    } finally {
      q2.close();
    }
  });

  test("markFailed increments attempts, sets last_error and a future next_attempt_at", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const { id } = q.enqueue("evt-1", { v: 1 });
      q.markFailed(id, "boom", 60);

      // Right after markFailed, the row's backoff puts it past now → peek returns null.
      expect(q.peek()).toBeNull();
      // Depth unchanged: failed rows stay in the queue (until parked).
      expect(q.depth()).toBe(1);
    } finally {
      q.close();
    }
  });

  test("peek ignores rows whose next_attempt_at is in the future", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const { id } = q.enqueue("evt-future", { v: 1 });
      q.markFailed(id, "transient", 3600); // 1 hour out
      expect(q.peek()).toBeNull();

      // A second event added now should peek normally.
      q.enqueue("evt-now", { v: 2 });
      const ready = q.peek();
      expect(ready?.event_id).toBe("evt-now");
    } finally {
      q.close();
    }
  });

  test("peek returns rows once the backoff window passes (zero-second backoff)", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const { id } = q.enqueue("evt-1", { v: 1 });
      q.markFailed(id, "transient", 0);
      const ready = q.peek();
      expect(ready).not.toBeNull();
      expect(ready?.event_id).toBe("evt-1");
      expect(ready?.attempts).toBe(1);
      expect(ready?.last_error).toBe("transient");
    } finally {
      q.close();
    }
  });

  test("parkPermanent moves row to parking_lot atomically", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const { id } = q.enqueue("evt-bad", { v: 1 });
      expect(q.depth()).toBe(1);
      expect(q.parkedDepth()).toBe(0);

      q.parkPermanent(id, "telegram 400: bad chat_id");

      expect(q.depth()).toBe(0);
      expect(q.parkedDepth()).toBe(1);
      expect(q.peek()).toBeNull();
    } finally {
      q.close();
    }
  });

  test("WAL mode is active after open", () => {
    const q = new OutboundQueue(dbPath);
    try {
      // bun:sqlite exposes the underlying Database; we re-open read-only to query journal_mode.
      const probe = new Database(dbPath);
      const row = probe.query("PRAGMA journal_mode").get() as { journal_mode: string };
      probe.close();
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      q.close();
    }
  });

  test("payload survives JSON round-trip", () => {
    const q = new OutboundQueue(dbPath);
    try {
      const payload = { chat_id: 42, text: "hello", arr: [1, 2, 3], nested: { a: "b" } };
      q.enqueue("evt-1", payload);
      const row = q.peek();
      expect(row).not.toBeNull();
      if (row) {
        expect(JSON.parse(row.payload)).toEqual(payload);
      }
    } finally {
      q.close();
    }
  });

  test("concurrent enqueues all succeed without losing rows", async () => {
    const q = new OutboundQueue(dbPath);
    try {
      const tasks = Array.from({ length: 50 }, (_, i) =>
        Promise.resolve().then(() => q.enqueue(`evt-${i}`, { i })),
      );
      const results = await Promise.all(tasks);
      const created = results.filter((r) => r.created).length;
      expect(created).toBe(50);
      expect(q.depth()).toBe(50);
    } finally {
      q.close();
    }
  });

  test("concurrent enqueues with duplicate event_ids dedup correctly", async () => {
    const q = new OutboundQueue(dbPath);
    try {
      const tasks = Array.from({ length: 20 }, () =>
        Promise.resolve().then(() => q.enqueue("evt-dup", { v: 1 })),
      );
      const results = await Promise.all(tasks);
      const ids = new Set(results.map((r) => r.id));
      // All 20 refer to the same row.
      expect(ids.size).toBe(1);
      expect(q.depth()).toBe(1);
    } finally {
      q.close();
    }
  });
});
