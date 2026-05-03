import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CrashBudgetDeps, runCrashBudgetBump } from "../src/crash-budget.ts";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";

let stateDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-crash-budget-"));
  store = new ManifestStore(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

function seedRun(run_id: string, override?: Partial<RunManifest>): void {
  const m: RunManifest = {
    run_id,
    started_at: "2026-05-03T12:00:00.000Z",
    state: "running",
    crash_count: 0,
    ralph_iterations: {},
    tmux_restart_attempted: [],
    provider_mode: "max20",
    provider_outage_started_at: null,
    ...override,
  };
  store.write(run_id, m);
}

interface CancelRecord {
  run_id: string;
}

function deps(args?: Partial<CrashBudgetDeps>): CrashBudgetDeps & { cancels: CancelRecord[] } {
  const cancels: CancelRecord[] = [];
  const cancelRun = async (run_id: string): Promise<void> => {
    cancels.push({ run_id });
  };
  return {
    stateDir,
    emitter: new MockEmitter(),
    threshold: 3,
    cancelRun,
    stderr: () => undefined,
    cancels,
    ...args,
  } as CrashBudgetDeps & { cancels: CancelRecord[] };
}

describe("runCrashBudgetBump", () => {
  test("first bump: count=1, no escalation, no cancel", async () => {
    seedRun("run-cb");
    const emitter = new MockEmitter();
    const d = deps({ emitter });
    const out = await runCrashBudgetBump({
      run_id: "run-cb",
      reason: "tmux-restart",
      ...d,
    });
    expect(out.count).toBe(1);
    expect(out.escalated).toBe(false);
    expect(emitter.calls).toEqual([]);
    expect(d.cancels).toEqual([]);
  });

  test("third bump: emits CRITICAL crash-budget-exhausted + calls cancelRun", async () => {
    seedRun("run-cb");
    const emitter = new MockEmitter();
    const d = deps({ emitter });
    await runCrashBudgetBump({ run_id: "run-cb", reason: "a", ...d });
    await runCrashBudgetBump({ run_id: "run-cb", reason: "b", ...d });
    const out = await runCrashBudgetBump({ run_id: "run-cb", reason: "c", ...d });
    expect(out.count).toBe(3);
    expect(out.escalated).toBe(true);
    const fatals = emitter.calls.filter(
      (c) => c.event === "crash-budget-exhausted" && c.severity === "critical",
    );
    expect(fatals).toHaveLength(1);
    expect(d.cancels).toEqual([{ run_id: "run-cb" }]);
  });

  test("idempotent: bumps 4 and 5 do not re-emit nor re-cancel", async () => {
    seedRun("run-cb");
    const emitter = new MockEmitter();
    const d = deps({ emitter });
    for (let i = 0; i < 5; i++) {
      await runCrashBudgetBump({ run_id: "run-cb", reason: `r-${i}`, ...d });
    }
    const fatals = emitter.calls.filter((c) => c.event === "crash-budget-exhausted");
    expect(fatals).toHaveLength(1);
    expect(d.cancels).toHaveLength(1);
    const m = store.read("run-cb");
    expect(m?.crash_count).toBe(5);
  });

  test("missing manifest: writes a new one rather than crashing", async () => {
    // The CLI is callable from a clawhip route hook; we cannot guarantee
    // the manifest was already created. Auto-create on bump.
    const emitter = new MockEmitter();
    const d = deps({ emitter });
    const out = await runCrashBudgetBump({
      run_id: "run-new",
      reason: "first-strike",
      ...d,
    });
    expect(out.count).toBe(1);
    const m = store.read("run-new");
    expect(m?.crash_count).toBe(1);
    expect(m?.run_id).toBe("run-new");
  });

  test("emit failure does not stop the cancel call", async () => {
    seedRun("run-cb", { crash_count: 2 });
    const emitter = new MockEmitter();
    emitter.failNext("clawhip-broken");
    const stderr: string[] = [];
    const d = deps({ emitter, stderr: (s) => stderr.push(s) });
    const out = await runCrashBudgetBump({
      run_id: "run-cb",
      reason: "trigger",
      ...d,
    });
    expect(out.escalated).toBe(true);
    // emit failed but cancelRun still ran
    expect(d.cancels).toEqual([{ run_id: "run-cb" }]);
    expect(stderr.join("")).toContain("clawhip-broken");
  });

  test("cancelRun failure does not propagate", async () => {
    seedRun("run-cb", { crash_count: 2 });
    const emitter = new MockEmitter();
    const stderr: string[] = [];
    const out = await runCrashBudgetBump({
      run_id: "run-cb",
      reason: "trigger",
      stateDir,
      emitter,
      threshold: 3,
      cancelRun: async () => {
        throw new Error("omc-broken");
      },
      stderr: (s) => stderr.push(s),
    });
    expect(out.escalated).toBe(true);
    expect(stderr.join("")).toContain("omc-broken");
  });

  test("custom threshold via deps.threshold", async () => {
    seedRun("run-cb");
    const emitter = new MockEmitter();
    const d = deps({ emitter, threshold: 2 });
    await runCrashBudgetBump({ run_id: "run-cb", reason: "a", ...d });
    const out = await runCrashBudgetBump({ run_id: "run-cb", reason: "b", ...d });
    expect(out.escalated).toBe(true);
  });

  test("payload includes reason and accumulated reasons", async () => {
    seedRun("run-cb");
    const emitter = new MockEmitter();
    const d = deps({ emitter });
    await runCrashBudgetBump({ run_id: "run-cb", reason: "tmux-restart", ...d });
    await runCrashBudgetBump({ run_id: "run-cb", reason: "clawhip-restart", ...d });
    await runCrashBudgetBump({
      run_id: "run-cb",
      reason: "verifier-disagreement",
      ...d,
    });
    const fatal = emitter.calls.find((c) => c.event === "crash-budget-exhausted");
    expect(fatal?.payload.reason).toBe("verifier-disagreement");
    expect(fatal?.payload.run_id).toBe("run-cb");
  });
});
