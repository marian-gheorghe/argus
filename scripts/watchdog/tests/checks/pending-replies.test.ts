import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PendingRepliesCheck } from "../../src/checks/pending-replies.ts";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-watchdog-pending-"));
  dbPath = join(tmpDir, "bridge-queue.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Helper: seed a sqlite db with the bridge's `pending_replies` schema and
 * insert N rows whose `created_at` is `secondsAgo` seconds in the past.
 */
function seed(path: string, rows: { secondsAgo: number; chat_id: number; user_id: number }[]) {
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_replies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      gate_id TEXT NOT NULL,
      prompt_message_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(chat_id, user_id)
    );
  `);
  for (const r of rows) {
    db.query(
      `INSERT INTO pending_replies (chat_id, user_id, gate_id, prompt_message_id, created_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' seconds'))`,
    ).run(r.chat_id, r.user_id, `gate-${r.chat_id}`, 1, r.secondsAgo);
  }
  db.close();
}

function depth(path: string): number {
  const db = new Database(path);
  const row = db.query("SELECT COUNT(*) AS c FROM pending_replies").get() as { c: number };
  db.close();
  return row.c;
}

describe("PendingRepliesCheck.check", () => {
  test("name is stable", () => {
    const c = new PendingRepliesCheck({ dbPath });
    expect(c.name).toBe("pending-replies");
  });

  test("returns healthy=true even when db file is missing (no bridge yet)", async () => {
    // dbPath does not exist
    const c = new PendingRepliesCheck({ dbPath });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    // Side-effect-only check: still healthy when there's nothing to do.
    expect(r.detail).toMatch(/skipped|deleted=0/);
  });

  test("deletes rows older than threshold and reports count", async () => {
    seed(dbPath, [
      { secondsAgo: 10, chat_id: 1, user_id: 1 },
      { secondsAgo: 9000, chat_id: 1, user_id: 2 },
      { secondsAgo: 9000, chat_id: 1, user_id: 3 },
    ]);
    expect(depth(dbPath)).toBe(3);
    const c = new PendingRepliesCheck({ dbPath, olderThanSecs: 7200 });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(r.detail).toContain("deleted=2");
    expect(depth(dbPath)).toBe(1);
  });

  test("with no expired rows, deletes 0 and stays healthy", async () => {
    seed(dbPath, [
      { secondsAgo: 10, chat_id: 1, user_id: 1 },
      { secondsAgo: 60, chat_id: 1, user_id: 2 },
    ]);
    const c = new PendingRepliesCheck({ dbPath, olderThanSecs: 7200 });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(r.detail).toContain("deleted=0");
    expect(depth(dbPath)).toBe(2);
  });

  test("default olderThanSecs is 7200 (2h)", async () => {
    seed(dbPath, [
      { secondsAgo: 7000, chat_id: 1, user_id: 1 },
      { secondsAgo: 8000, chat_id: 1, user_id: 2 },
    ]);
    const c = new PendingRepliesCheck({ dbPath }); // no override → 7200
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(r.detail).toContain("deleted=1");
    expect(depth(dbPath)).toBe(1);
  });

  test("does not throw if pending_replies table doesn't exist (creates it)", async () => {
    // Build an empty sqlite file with no tables; the check should idempotently
    // create the table (mirrors bridge's CREATE TABLE IF NOT EXISTS) so a
    // mid-deploy state where the bridge hasn't written yet doesn't crash us.
    const db = new Database(dbPath);
    db.close();
    const c = new PendingRepliesCheck({ dbPath });
    const r = await c.check();
    expect(r.healthy).toBe(true);
  });
});

describe("PendingRepliesCheck.restart", () => {
  test("is a no-op that returns ok:true", async () => {
    const c = new PendingRepliesCheck({ dbPath });
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no-op");
  });
});
