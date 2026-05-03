import { Database } from "bun:sqlite";

/**
 * A single row in the durable outbound queue.
 * `payload` is JSON-encoded; callers `JSON.parse(row.payload)` to recover the object.
 */
export interface QueueRow {
  id: number;
  event_id: string;
  payload: string;
  enqueued_at: string;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
}

export interface EnqueueResult {
  id: number;
  /** true if a new row was inserted; false if a row with this `event_id` already existed. */
  created: boolean;
}

/**
 * Durable outbound queue backed by sqlite (bun:sqlite, WAL mode).
 *
 * Design notes:
 * - `event_id` is a UNIQUE constraint → INSERT-OR-IGNORE gives idempotent enqueue.
 *   When `enqueue` is called with an existing `event_id`, the new payload is
 *   silently discarded and the existing row id is returned with `created: false`.
 *   This is correct dedup semantics for clawhip-emitted events (same event_id =>
 *   same payload by contract).
 * - `next_attempt_at` is the visibility timestamp; `peek` only returns rows due now.
 *   Ordering: `next_attempt_at ASC, id ASC` — proper FIFO of due rows; failed rows
 *   that come back due after a backoff don't permanently win against fresh enqueues.
 * - `parking_lot` holds rows that have hit a permanent error; `parkPermanent` is
 *   transactional so a crash mid-park can't lose or duplicate the row.
 *
 * Concurrency assumption: SINGLE CONSUMER. The dispatcher loop is the only caller
 * of `peek` + `markDelivered` / `markFailed` / `parkPermanent`. Multiple ingest
 * paths can call `enqueue` concurrently (HTTP receiver + gate-file watcher) — that
 * is safe via the UNIQUE constraint and INSERT OR IGNORE. If a future refactor
 * spawns multiple dispatcher workers, add an `in_flight_until` column with a
 * conditional UPDATE-RETURNING claim pattern; do not add naive parallel `peek`s.
 */
export class OutboundQueue {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    // WAL gives us better concurrency for the dispatcher loop + ingest webhook.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_due ON outbound(next_attempt_at);

      CREATE TABLE IF NOT EXISTS parking_lot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        original_id INTEGER NOT NULL,
        event_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        enqueued_at TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        parked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        parking_reason TEXT NOT NULL
      );
    `);
  }

  enqueue(event_id: string, payload: object): EnqueueResult {
    const json = JSON.stringify(payload);
    const insert = this.db.query(
      "INSERT OR IGNORE INTO outbound (event_id, payload) VALUES (?, ?) RETURNING id",
    );
    const inserted = insert.get(event_id, json) as { id: number } | null;
    if (inserted) {
      return { id: inserted.id, created: true };
    }
    const existing = this.db.query("SELECT id FROM outbound WHERE event_id = ?").get(event_id) as {
      id: number;
    } | null;
    if (!existing) {
      // Should not happen — INSERT OR IGNORE returned nothing yet no row exists.
      throw new Error(`enqueue: event_id ${event_id} neither inserted nor found`);
    }
    return { id: existing.id, created: false };
  }

  peek(): QueueRow | null {
    const row = this.db
      .query<QueueRow, []>(
        `SELECT id, event_id, payload, enqueued_at, attempts, next_attempt_at, last_error
         FROM outbound
         WHERE next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         ORDER BY next_attempt_at ASC, id ASC
         LIMIT 1`,
      )
      .get();
    return row ?? null;
  }

  markDelivered(id: number): void {
    this.db.query("DELETE FROM outbound WHERE id = ?").run(id);
  }

  markFailed(id: number, error: string, backoff_secs: number): void {
    this.db
      .query(
        `UPDATE outbound
         SET attempts = attempts + 1,
             last_error = ?,
             next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
         WHERE id = ?`,
      )
      .run(error, backoff_secs, id);
  }

  /**
   * Move a row from `outbound` to `parking_lot` in a single transaction.
   * The live queue isn't blocked by this row; an operator can inspect parking_lot later.
   */
  parkPermanent(id: number, error: string): void {
    const txn = this.db.transaction((rowId: number, reason: string) => {
      const row = this.db
        .query<
          {
            id: number;
            event_id: string;
            payload: string;
            enqueued_at: string;
            attempts: number;
          },
          [number]
        >(
          `SELECT id, event_id, payload, enqueued_at, attempts
           FROM outbound WHERE id = ?`,
        )
        .get(rowId);
      if (!row) return;
      this.db
        .query(
          `INSERT INTO parking_lot
             (original_id, event_id, payload, enqueued_at, attempts, parking_reason)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(row.id, row.event_id, row.payload, row.enqueued_at, row.attempts, reason);
      this.db.query("DELETE FROM outbound WHERE id = ?").run(rowId);
    });
    txn(id, error);
  }

  depth(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM outbound").get() as { c: number };
    return row.c;
  }

  parkedDepth(): number {
    const row = this.db.query("SELECT COUNT(*) AS c FROM parking_lot").get() as { c: number };
    return row.c;
  }

  close(): void {
    this.db.close();
  }
}
