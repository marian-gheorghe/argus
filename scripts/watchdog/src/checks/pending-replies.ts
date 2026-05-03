import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import type { Check, CheckResult, RestartResult } from "../check.ts";

/**
 * Pending-replies expiry check. Solves Phase B Issue 3:
 * `OutboundQueue.expirePendingReplies()` was implemented in
 * `scripts/telegram-bridge/src/queue.ts` but never invoked from production
 * code. Without periodic expiry, abandoned `pending_replies` rows
 * (a user tapped "Reject + comment" but never sent the follow-up message)
 * accumulate forever.
 *
 * What this check does:
 *   - Opens (or initialises) the bridge's sqlite at `dbPath`.
 *   - Deletes `pending_replies` rows older than `olderThanSecs` (default 2h).
 *   - Always returns `{healthy: true, ...}` — its purpose is the side effect,
 *     not the health signal. We don't want a stale-row condition to escalate
 *     into a restart of the bridge.
 *   - `restart()` is a no-op that returns ok:true; nothing to recover.
 *
 * ============================================================================
 * SQL DUPLICATION — PHASE C+ CLEANUP
 * ============================================================================
 * The DELETE + CREATE TABLE statements below are duplicated verbatim from
 * `scripts/telegram-bridge/src/queue.ts` (`OutboundQueue` class). Reasons:
 *   1. Keeping the watchdog free of an inter-package dependency on the bridge
 *      avoids transitive deps (chokidar, hono) leaking into the watchdog's
 *      install footprint.
 *   2. The watchdog must run even if the bridge directory is missing/half-
 *      installed — a strict import would fail at module load.
 *
 * Cost: schema drift risk. If the bridge changes the `pending_replies` schema
 * (rename a column, change `created_at` format), this check still runs against
 * the old DDL. Mitigation: this code uses `CREATE TABLE IF NOT EXISTS`, so the
 * watchdog NEVER writes a fresh schema over an existing one — the bridge's
 * DDL wins. The DELETE matches `created_at` literally; if that column moves,
 * the DELETE silently affects 0 rows (no harm — the bridge will then add its
 * own expiry path).
 *
 * Phase C+ followup: extract `argus-sqlite-types` shared package with both the
 * DDL and the typed accessors. Tracked in the runbook.
 * ============================================================================
 */

const DEFAULT_OLDER_THAN_SECS = 7200; // 2 hours

const TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS pending_replies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    gate_id TEXT NOT NULL,
    prompt_message_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(chat_id, user_id)
  );
`;

const DELETE_SQL = `
  DELETE FROM pending_replies
  WHERE created_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-' || ? || ' seconds')
`;

export interface PendingRepliesCheckDeps {
  dbPath: string;
  olderThanSecs?: number;
}

export class PendingRepliesCheck implements Check {
  readonly name = "pending-replies";
  private readonly dbPath: string;
  private readonly olderThanSecs: number;

  constructor(deps: PendingRepliesCheckDeps) {
    this.dbPath = deps.dbPath;
    this.olderThanSecs = deps.olderThanSecs ?? DEFAULT_OLDER_THAN_SECS;
  }

  async check(): Promise<CheckResult> {
    // If the bridge hasn't been started yet (db file absent), don't create
    // an empty file — that would race the bridge's first `new OutboundQueue`.
    // Skip cleanly; we'll catch up on a future tick.
    if (!existsSync(this.dbPath)) {
      return {
        healthy: true,
        detail: `skipped: ${this.dbPath} does not exist (bridge not yet started)`,
      };
    }

    let db: Database | null = null;
    try {
      db = new Database(this.dbPath);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec(TABLE_DDL);
      const result = db.query(DELETE_SQL).run(this.olderThanSecs);
      const deleted = Number(result.changes);
      return {
        healthy: true,
        detail: `expirePendingReplies deleted=${deleted} (older_than_secs=${this.olderThanSecs})`,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Healthy=true even on failure: this is a janitor task, not a liveness
      // signal. Failing to expire shouldn't escalate to a bridge restart.
      // The error is surfaced in the detail for log visibility.
      return { healthy: true, detail: `expirePendingReplies skipped: ${msg}` };
    } finally {
      db?.close();
    }
  }

  async restart(): Promise<RestartResult> {
    return { ok: true, detail: "no-op (pending-replies has no daemon to restart)" };
  }
}
