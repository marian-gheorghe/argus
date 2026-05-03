import { Database } from "bun:sqlite";
import type { Pricing, Tier, TokenType } from "./pricing.ts";

export type ThresholdLevel = "warn" | "page" | "kill";

/**
 * One row per `run_id`. spent_eur is recomputed from raw token counts on every
 * `add` call so that pricing changes apply retroactively to in-flight runs —
 * we treat the TOML pricing table as authoritative at any given moment.
 */
export interface RunRow {
  run_id: string;
  ceiling_eur: number;
  spent_eur: number;
  haiku_input_tokens: number;
  haiku_cached_input_tokens: number;
  haiku_output_tokens: number;
  sonnet_input_tokens: number;
  sonnet_cached_input_tokens: number;
  sonnet_output_tokens: number;
  opus_input_tokens: number;
  opus_cached_input_tokens: number;
  opus_output_tokens: number;
  warn_emitted: number;
  page_emitted: number;
  kill_emitted: number;
  last_phase: string | null;
  last_update: string;
}

const TIER_TYPE_TO_COLUMN: Record<Tier, Record<TokenType, keyof RunRow>> = {
  haiku: {
    input: "haiku_input_tokens",
    cached_input: "haiku_cached_input_tokens",
    output: "haiku_output_tokens",
  },
  sonnet: {
    input: "sonnet_input_tokens",
    cached_input: "sonnet_cached_input_tokens",
    output: "sonnet_output_tokens",
  },
  opus: {
    input: "opus_input_tokens",
    cached_input: "opus_cached_input_tokens",
    output: "opus_output_tokens",
  },
};

const LEVEL_TO_COLUMN: Record<ThresholdLevel, "warn_emitted" | "page_emitted" | "kill_emitted"> = {
  warn: "warn_emitted",
  page: "page_emitted",
  kill: "kill_emitted",
};

/**
 * Per-run cost accumulator backed by `bun:sqlite` (WAL mode).
 *
 * Concurrency model:
 * - Single hook process per Claude Code session, but multiple `add` calls can
 *   be in flight if the agent overlaps tool calls (PostToolUse fires per
 *   tool, and tools can run in parallel via Bun's microtask queue).
 * - We use `BEGIN IMMEDIATE` transactions on every read-modify-write so two
 *   adds against the same run serialise at the sqlite layer. WAL mode keeps
 *   readers (other tools, dashboards) non-blocking.
 *
 * Spent recomputation:
 * - `spent_eur` is recomputed from raw tokens on EVERY add — never delta-added.
 *   Rationale: pricing rates can be updated mid-run (operator edits
 *   `~/.argus/pricing.toml`), and we want the budget enforcement to reflect
 *   the rates the operator just told us about. Recompute is O(9 multiplies),
 *   trivially cheap.
 *
 * Threshold flags:
 * - `markEmitted(level)` returns whether the flag was previously 0. The caller
 *   uses this to gate the actual clawhip emit — guarantees exactly-once
 *   semantics across hook re-entries (hooks restart, races, etc.).
 */
export class Accumulator {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        run_id TEXT PRIMARY KEY,
        ceiling_eur REAL NOT NULL,
        spent_eur REAL NOT NULL DEFAULT 0,
        haiku_input_tokens INTEGER NOT NULL DEFAULT 0,
        haiku_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        haiku_output_tokens INTEGER NOT NULL DEFAULT 0,
        sonnet_input_tokens INTEGER NOT NULL DEFAULT 0,
        sonnet_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        sonnet_output_tokens INTEGER NOT NULL DEFAULT 0,
        opus_input_tokens INTEGER NOT NULL DEFAULT 0,
        opus_cached_input_tokens INTEGER NOT NULL DEFAULT 0,
        opus_output_tokens INTEGER NOT NULL DEFAULT 0,
        warn_emitted INTEGER NOT NULL DEFAULT 0,
        page_emitted INTEGER NOT NULL DEFAULT 0,
        kill_emitted INTEGER NOT NULL DEFAULT 0,
        last_phase TEXT,
        last_update TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
    `);
  }

  /** Idempotent: subsequent calls with the same run_id are no-ops. */
  ensureRun(run_id: string, ceiling_eur: number): void {
    this.db
      .query("INSERT OR IGNORE INTO runs (run_id, ceiling_eur) VALUES (?, ?)")
      .run(run_id, ceiling_eur);
  }

  /**
   * Add `tokens` to the (tier, type) cell of `run_id` and recompute `spent_eur`
   * from the row's totals × the supplied pricing table. If the run row does
   * not exist yet, it is auto-created with `defaultCeiling` (defaults to a
   * conservative 50 EUR — but callers should pass an explicit ceiling in
   * production via ensureRun).
   *
   * Atomic: SELECT + UPDATE inside a single BEGIN IMMEDIATE transaction.
   */
  add(
    run_id: string,
    tier: Tier,
    type: TokenType,
    tokens: number,
    phase: string,
    pricing: Pricing,
    defaultCeiling = 50,
  ): void {
    if (!Number.isInteger(tokens) || tokens < 0) {
      throw new Error(`Accumulator.add: tokens must be a non-negative integer, got ${tokens}`);
    }
    const column = TIER_TYPE_TO_COLUMN[tier][type];
    const txn = this.db.transaction(() => {
      // Ensure-row inside the txn so a race where ensureRun was skipped still
      // produces a valid row before we read.
      this.db
        .query("INSERT OR IGNORE INTO runs (run_id, ceiling_eur) VALUES (?, ?)")
        .run(run_id, defaultCeiling);

      const row = this.db.query("SELECT * FROM runs WHERE run_id = ?").get(run_id) as RunRow;

      const newColValue = (row[column] as number) + tokens;
      // Recompute spent from totals (post-update for the touched column,
      // unchanged for the other 8).
      const tiers: Tier[] = ["haiku", "sonnet", "opus"];
      const types: TokenType[] = ["input", "cached_input", "output"];
      let spent = 0;
      for (const t of tiers) {
        for (const ty of types) {
          const col = TIER_TYPE_TO_COLUMN[t][ty];
          const tokensForCell = col === column ? newColValue : (row[col] as number);
          spent += tokensForCell * pricing.rate(t, ty);
        }
      }

      // `column` comes from TIER_TYPE_TO_COLUMN[Tier][TokenType] — a closed
      // enum, never user input — so string-interpolating it into the UPDATE
      // statement is safe.
      this.db
        .query(
          `UPDATE runs
           SET ${column} = ?, spent_eur = ?, last_phase = ?,
               last_update = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE run_id = ?`,
        )
        .run(newColValue, spent, phase, run_id);
    });
    txn.immediate();
  }

  /**
   * Atomically flip the threshold-emitted flag from 0→1.
   * Returns true iff the flag was previously 0 (caller should emit).
   * Returns false if the row doesn't exist or the flag was already 1.
   */
  markEmitted(run_id: string, level: ThresholdLevel): boolean {
    const column = LEVEL_TO_COLUMN[level];
    // `column` is sourced from LEVEL_TO_COLUMN[ThresholdLevel], a closed
    // enum — never user input — so string-interpolating it is safe.
    const txn = this.db.transaction(() => {
      const row = this.db
        .query<{ flag: number }, [string]>(`SELECT ${column} AS flag FROM runs WHERE run_id = ?`)
        .get(run_id);
      if (!row) return false;
      if (row.flag !== 0) return false;
      this.db.query(`UPDATE runs SET ${column} = 1 WHERE run_id = ?`).run(run_id);
      return true;
    });
    return txn.immediate();
  }

  getRun(run_id: string): RunRow | null {
    const row = this.db.query("SELECT * FROM runs WHERE run_id = ?").get(run_id) as RunRow | null;
    return row ?? null;
  }

  /**
   * No-op for now (rows kept for forensics / Phase D dashboards).
   * If the table grows pathologically (>>100k runs), add an archive table.
   */
  closeRun(_run_id: string): void {
    // intentional no-op
  }

  close(): void {
    this.db.close();
  }
}
