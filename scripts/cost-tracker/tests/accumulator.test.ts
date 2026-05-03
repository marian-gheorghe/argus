import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accumulator } from "../src/accumulator.ts";
import { Pricing } from "../src/pricing.ts";

const PRICING = Pricing.fromObject({
  haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
  sonnet: { input: 3.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
  opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
});

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-acc-"));
  dbPath = join(tmpDir, "cost-tracker.sqlite");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("Accumulator schema + ensureRun", () => {
  test("ensureRun is idempotent — second call does NOT reset spent_eur or tokens", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "sonnet", "input", 1_000_000, "exploration", PRICING);
      a.ensureRun("run-1", 999);
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        // ceiling stays at the original value (idempotent insert ignores updates)
        expect(row.ceiling_eur).toBe(50);
        expect(row.spent_eur).toBeCloseTo(3.0, 6);
        expect(row.sonnet_input_tokens).toBe(1_000_000);
      }
    } finally {
      a.close();
    }
  });

  test("getRun returns null for unknown run_id", () => {
    const a = new Accumulator(dbPath);
    try {
      expect(a.getRun("nope")).toBeNull();
    } finally {
      a.close();
    }
  });

  test("WAL mode is active after open", () => {
    const a = new Accumulator(dbPath);
    try {
      const probe = new Database(dbPath);
      const row = probe.query("PRAGMA journal_mode").get() as { journal_mode: string };
      probe.close();
      expect(row.journal_mode.toLowerCase()).toBe("wal");
    } finally {
      a.close();
    }
  });
});

describe("Accumulator.add", () => {
  test("adds tokens to the right tier_type column and recomputes spent_eur", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "sonnet", "input", 1_000_000, "exploration", PRICING);
      a.add("run-1", "sonnet", "output", 1_000_000, "exploration", PRICING);
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.sonnet_input_tokens).toBe(1_000_000);
        expect(row.sonnet_output_tokens).toBe(1_000_000);
        // 1M input @ 3 + 1M output @ 15 = 18 EUR
        expect(row.spent_eur).toBeCloseTo(18.0, 6);
      }
    } finally {
      a.close();
    }
  });

  test("supports multiple tiers in the same run; spent_eur sums across tiers", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "haiku", "input", 1_000_000, "routine", PRICING); // 0.8 EUR
      a.add("run-1", "opus", "output", 100_000, "architecture", PRICING); // 100k * 75e-6 = 7.5 EUR
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.spent_eur).toBeCloseTo(0.8 + 7.5, 6);
        expect(row.haiku_input_tokens).toBe(1_000_000);
        expect(row.opus_output_tokens).toBe(100_000);
      }
    } finally {
      a.close();
    }
  });

  test("auto-creates the run if ensureRun was never called", () => {
    const a = new Accumulator(dbPath);
    try {
      // Defensive: spec says callers should ensureRun first, but if a hook race
      // hits add without ensureRun, we should not throw.
      a.add("run-1", "sonnet", "input", 1_000_000, "phase", PRICING, /* default ceiling */ 50);
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.ceiling_eur).toBe(50);
        expect(row.spent_eur).toBeCloseTo(3.0, 6);
      }
    } finally {
      a.close();
    }
  });

  test("zero-token add is a no-op (does not touch spent_eur or tokens)", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "sonnet", "input", 1_000, "p1", PRICING);
      const before = a.getRun("run-1");
      a.add("run-1", "sonnet", "input", 0, "p1", PRICING);
      const after = a.getRun("run-1");
      expect(before).not.toBeNull();
      expect(after).not.toBeNull();
      if (before && after) {
        expect(after.sonnet_input_tokens).toBe(before.sonnet_input_tokens);
        expect(after.spent_eur).toBeCloseTo(before.spent_eur, 12);
      }
    } finally {
      a.close();
    }
  });

  test("last_phase is updated to the most recent add's phase", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "sonnet", "input", 1_000, "early", PRICING);
      a.add("run-1", "sonnet", "input", 1_000, "later", PRICING);
      const row = a.getRun("run-1");
      expect(row?.last_phase).toBe("later");
    } finally {
      a.close();
    }
  });

  test("recomputing spent_eur uses CURRENT pricing — not deltas — so rate updates apply", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      a.add("run-1", "sonnet", "input", 1_000_000, "p1", PRICING);
      // Spent reflects 3 EUR at PRICING's sonnet input rate.
      const before = a.getRun("run-1");
      expect(before?.spent_eur).toBeCloseTo(3.0, 6);
      // Now add zero tokens with a DIFFERENT pricing table (sonnet doubled).
      const NEW_PRICING = Pricing.fromObject({
        haiku: { input: 0.8e-6, cached_input: 0.1e-6, output: 4.0e-6 },
        sonnet: { input: 6.0e-6, cached_input: 0.3e-6, output: 15.0e-6 },
        opus: { input: 15.0e-6, cached_input: 1.5e-6, output: 75.0e-6 },
      });
      a.add("run-1", "sonnet", "input", 0, "p2", NEW_PRICING);
      const after = a.getRun("run-1");
      expect(after?.spent_eur).toBeCloseTo(6.0, 6);
    } finally {
      a.close();
    }
  });
});

describe("Accumulator concurrency", () => {
  test("10 parallel adds against the same run all land — final spent_eur is correct", async () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      const N = 10;
      const TOKENS_PER_CALL = 100_000;
      const tasks = Array.from({ length: N }, () =>
        Promise.resolve().then(() =>
          a.add("run-1", "sonnet", "input", TOKENS_PER_CALL, "p", PRICING),
        ),
      );
      await Promise.all(tasks);
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.sonnet_input_tokens).toBe(N * TOKENS_PER_CALL);
        // 1M tokens @ 3 EUR = 3 EUR
        expect(row.spent_eur).toBeCloseTo(3.0, 6);
      }
    } finally {
      a.close();
    }
  });

  test("parallel adds across all 9 (tier × type) columns sum to the right total", async () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      // Each call adds 1_000_000 to a different (tier, type) cell. Total 9
      // calls in flight at once. Final spent_eur should be the sum of each
      // tier's per-token rate × 1M.
      const tiers = ["haiku", "sonnet", "opus"] as const;
      const types = ["input", "cached_input", "output"] as const;
      const tasks: Promise<void>[] = [];
      for (const tier of tiers) {
        for (const type of types) {
          tasks.push(
            Promise.resolve().then(() => {
              a.add("run-1", tier, type, 1_000_000, "p", PRICING);
            }),
          );
        }
      }
      await Promise.all(tasks);
      const row = a.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        const expected =
          // haiku 0.8 + 0.1 + 4 = 4.9
          4.9 +
          // sonnet 3 + 0.3 + 15 = 18.3
          18.3 +
          // opus 15 + 1.5 + 75 = 91.5
          91.5;
        expect(row.spent_eur).toBeCloseTo(expected, 6);
      }
    } finally {
      a.close();
    }
  });
});

describe("Accumulator.markEmitted", () => {
  test("first call returns true (was zero), second returns false (idempotent)", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      expect(a.markEmitted("run-1", "warn")).toBe(true);
      expect(a.markEmitted("run-1", "warn")).toBe(false);
      const row = a.getRun("run-1");
      expect(row?.warn_emitted).toBe(1);
    } finally {
      a.close();
    }
  });

  test("warn / page / kill flags are independent", () => {
    const a = new Accumulator(dbPath);
    try {
      a.ensureRun("run-1", 50);
      expect(a.markEmitted("run-1", "warn")).toBe(true);
      expect(a.markEmitted("run-1", "page")).toBe(true);
      expect(a.markEmitted("run-1", "kill")).toBe(true);
      expect(a.markEmitted("run-1", "warn")).toBe(false);
      expect(a.markEmitted("run-1", "page")).toBe(false);
      expect(a.markEmitted("run-1", "kill")).toBe(false);
      const row = a.getRun("run-1");
      expect(row?.warn_emitted).toBe(1);
      expect(row?.page_emitted).toBe(1);
      expect(row?.kill_emitted).toBe(1);
    } finally {
      a.close();
    }
  });

  test("markEmitted returns false for unknown run_id (no row to flip)", () => {
    const a = new Accumulator(dbPath);
    try {
      // Defensive: if the hook somehow calls markEmitted before ensureRun, the
      // operation is a no-op; the caller still got "not previously emitted"
      // semantically — but we return false so the caller skips the emit.
      expect(a.markEmitted("ghost", "warn")).toBe(false);
    } finally {
      a.close();
    }
  });
});

describe("Accumulator durability", () => {
  test("rows survive close/reopen", () => {
    const a = new Accumulator(dbPath);
    a.ensureRun("run-1", 42);
    a.add("run-1", "sonnet", "input", 1_000, "p", PRICING);
    a.markEmitted("run-1", "warn");
    a.close();

    const b = new Accumulator(dbPath);
    try {
      const row = b.getRun("run-1");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.ceiling_eur).toBe(42);
        expect(row.sonnet_input_tokens).toBe(1_000);
        expect(row.warn_emitted).toBe(1);
      }
    } finally {
      b.close();
    }
  });
});
