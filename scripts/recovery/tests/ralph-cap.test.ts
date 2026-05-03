import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";
import { type RalphCapDeps, runRalphCap } from "../src/ralph-cap.ts";

let stateDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-ralph-cap-"));
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

describe("runRalphCap — happy path", () => {
  test("no run_id in env: silent no-op exit 0", async () => {
    const emitter = new MockEmitter();
    const code = await runRalphCap({
      env: {},
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("no task_id in env: silent no-op exit 0", async () => {
    const emitter = new MockEmitter();
    seedRun("run-rc");
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("missing manifest: silent no-op (don't break the agent)", async () => {
    const emitter = new MockEmitter();
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-missing", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("under threshold: increments counter, no emit, no prompt prepend", async () => {
    const emitter = new MockEmitter();
    seedRun("run-rc", { ralph_iterations: { "task-1": 5 } });
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
    const m = store.read("run-rc");
    expect(m?.ralph_iterations["task-1"]).toBe(6);
    expect(m?.next_prompt_prepend).toBeUndefined();
  });
});

describe("runRalphCap — threshold crossing", () => {
  test("at threshold: emit agent.loop-exhausted WARN + set prompt prepend", async () => {
    const emitter = new MockEmitter();
    seedRun("run-rc", { ralph_iterations: { "task-1": 29 } });
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("agent.loop-exhausted");
    expect(emitter.calls[0]?.severity).toBe("warn");
    expect(emitter.calls[0]?.payload.run_id).toBe("run-rc");
    expect(emitter.calls[0]?.payload.task_id).toBe("task-1");
    const m = store.read("run-rc");
    expect(m?.ralph_iterations["task-1"]).toBe(30);
    expect(m?.next_prompt_prepend).toContain("architect review");
  });

  test("idempotent at exactly threshold across two consecutive calls (only one emit)", async () => {
    const emitter = new MockEmitter();
    seedRun("run-rc", { ralph_iterations: { "task-1": 29 } });
    await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    // Second call: counter is now 30; we're past threshold but we should not
    // re-emit until we cross 2x (the "page" point). For 30 < count < 60 we
    // stay quiet to avoid emit-spam.
    await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(emitter.calls).toHaveLength(1);
    const m = store.read("run-rc");
    expect(m?.ralph_iterations["task-1"]).toBe(31);
  });

  test("at 2x threshold: emit agent.loop-exhausted PAGE", async () => {
    const emitter = new MockEmitter();
    seedRun("run-rc", { ralph_iterations: { "task-1": 59 } });
    await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: () => undefined,
    });
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("agent.loop-exhausted");
    expect(emitter.calls[0]?.severity).toBe("page");
    const m = store.read("run-rc");
    expect(m?.ralph_iterations["task-1"]).toBe(60);
  });
});

describe("runRalphCap — robustness", () => {
  test("emit failure does not propagate (returns 0, logs to stderr)", async () => {
    const emitter = new MockEmitter();
    emitter.failNext("clawhip-broken");
    const stderr: string[] = [];
    seedRun("run-rc", { ralph_iterations: { "task-1": 29 } });
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-rc", OMC_TASK_ID: "task-1" },
      stateDir,
      emitter,
      maxIterations: 30,
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    const errlog = stderr.join("");
    expect(errlog).toContain("clawhip-broken");
  });

  test("unexpected throw inside the body is caught and exit 0", async () => {
    const emitter = new MockEmitter();
    const stderr: string[] = [];
    // bad stateDir (a path that's actually a regular file, so manifest read
    // attempts from below will throw). We make it a file:
    const badPath = join(stateDir, "actually-a-file");
    require("node:fs").writeFileSync(badPath, "x");
    const code = await runRalphCap({
      env: { OMC_CURRENT_RUN_ID: "run-x", OMC_TASK_ID: "task-1" },
      stateDir: join(badPath, "nope"),
      emitter,
      maxIterations: 30,
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
  });
});
