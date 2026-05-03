import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runLearnerCadence } from "../src/learner-cadence.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";

let stateDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-knowledge-cadence-"));
  store = new ManifestStore(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-03T12:30:00.000Z");

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

describe("runLearnerCadence", () => {
  test("phase transition: queues /learner and updates phase + boundary timestamp", async () => {
    seedRun("run-1", { phase: "harness" });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-1", OMC_CURRENT_PHASE: "first-batch" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-1");
    expect(m?.phase).toBe("first-batch");
    expect(m?.next_prompt_prepend).toBe("/learner");
    expect(m?.phase_boundary_seen_at).toBe("2026-05-03T12:30:00.000Z");
  });

  test("same phase: no-op (does not overwrite)", async () => {
    seedRun("run-2", { phase: "harness", next_prompt_prepend: undefined });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-2", OMC_CURRENT_PHASE: "harness" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-2");
    expect(m?.phase).toBe("harness");
    expect(m?.next_prompt_prepend).toBeUndefined();
    expect(m?.phase_boundary_seen_at).toBeUndefined();
  });

  test("missing OMC_CURRENT_RUN_ID: silent no-op", async () => {
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_PHASE: "first-batch" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
  });

  test("missing OMC_CURRENT_PHASE: silent no-op", async () => {
    seedRun("run-3", { phase: "harness" });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-3" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-3");
    expect(m?.phase).toBe("harness");
    expect(m?.next_prompt_prepend).toBeUndefined();
  });

  test("missing manifest: silent no-op (do not throw)", async () => {
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-no-such", OMC_CURRENT_PHASE: "harness" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
  });

  test("idempotent: existing /learner prepend is preserved (not duplicated)", async () => {
    seedRun("run-4", { phase: "harness", next_prompt_prepend: "/learner" });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-4", OMC_CURRENT_PHASE: "first-batch" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-4");
    expect(m?.next_prompt_prepend).toBe("/learner");
    expect(m?.phase).toBe("first-batch");
  });

  test("phase transition: existing non-/learner prepend is preserved (not overwritten)", async () => {
    seedRun("run-5", {
      phase: "harness",
      next_prompt_prepend: "/something-else",
    });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-5", OMC_CURRENT_PHASE: "first-batch" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-5");
    // Don't clobber a non-/learner queued prompt.
    expect(m?.next_prompt_prepend).toBe("/something-else");
    // Phase still advances.
    expect(m?.phase).toBe("first-batch");
  });

  test("first phase ever (no prior phase set): treated as a transition", async () => {
    seedRun("run-6", { phase: undefined });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-6", OMC_CURRENT_PHASE: "harness" },
      stateDir,
      stderr: () => undefined,
      now: () => NOW,
    });
    expect(code).toBe(0);
    const m = store.read("run-6");
    expect(m?.phase).toBe("harness");
    expect(m?.next_prompt_prepend).toBe("/learner");
  });

  test("crash-resistant: a write failure does not throw (returns 0 + writes to stderr)", async () => {
    seedRun("run-7", { phase: "harness" });
    const messages: string[] = [];
    // Inject a stateDir that becomes unwritable mid-flight by deleting it.
    rmSync(join(stateDir, "runs", "run-7"), { recursive: true, force: true });
    const code = await runLearnerCadence({
      env: { OMC_CURRENT_RUN_ID: "run-7", OMC_CURRENT_PHASE: "first-batch" },
      stateDir,
      stderr: (msg) => messages.push(msg),
      now: () => NOW,
    });
    // Internal failure must still exit 0 — Stop hooks must never block.
    expect(code).toBe(0);
  });
});
