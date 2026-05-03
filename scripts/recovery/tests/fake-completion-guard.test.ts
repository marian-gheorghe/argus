import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import {
  type FakeCompletionGuardDeps,
  runFakeCompletionGuard,
} from "../src/fake-completion-guard.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";

let stateDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-fake-completion-"));
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

const NOW = new Date("2026-05-03T12:30:00.000Z");
function deps(args: Partial<FakeCompletionGuardDeps> & { stdin: string }): FakeCompletionGuardDeps {
  return {
    env: { OMC_CURRENT_RUN_ID: "run-fc" },
    stateDir,
    emitter: new MockEmitter(),
    stderr: () => undefined,
    now: () => NOW,
    freshnessMs: 5 * 60 * 1000,
    ...args,
  };
}

describe("runFakeCompletionGuard", () => {
  test("no DONE claim: silent no-op", async () => {
    seedRun("run-fc");
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({ stdin: '{"transcript":"some normal output"}', emitter }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
    const m = store.read("run-fc");
    expect(m?.next_prompt_prepend).toBeUndefined();
  });

  test("DONE claim with fresh verify-pass: no emit", async () => {
    // verify_pass within 5min window
    const recent = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString();
    seedRun("run-fc", { last_verify_pass_at: recent });
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({
        stdin: '{"transcript":"<promise>DONE</promise> all green"}',
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
    const m = store.read("run-fc");
    expect(m?.next_prompt_prepend).toBeUndefined();
  });

  test("DONE claim with stale verify-pass: emit + prompt prepend", async () => {
    // verify_pass over 10 minutes ago
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    seedRun("run-fc", { last_verify_pass_at: stale });
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({
        stdin: '{"transcript":"OK <promise>DONE</promise> finished"}',
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("agent.fake-completion");
    expect(emitter.calls[0]?.severity).toBe("warn");
    const m = store.read("run-fc");
    expect(m?.next_prompt_prepend).toContain("team-verify");
  });

  test("DONE claim with NO verify-pass at all: emit + prompt prepend", async () => {
    seedRun("run-fc");
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({
        stdin: '{"transcript":"<promise>DONE</promise>"}',
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("agent.fake-completion");
    const m = store.read("run-fc");
    expect(m?.next_prompt_prepend).toContain("team-verify");
  });

  test("missing manifest: safe no-op (don't break the agent)", async () => {
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({
        env: { OMC_CURRENT_RUN_ID: "run-no-such" },
        stdin: '{"transcript":"<promise>DONE</promise>"}',
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("no run_id: silent no-op", async () => {
    const emitter = new MockEmitter();
    const code = await runFakeCompletionGuard(
      deps({
        env: {},
        stdin: '{"transcript":"<promise>DONE</promise>"}',
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("malformed stdin JSON: safe no-op", async () => {
    seedRun("run-fc");
    const emitter = new MockEmitter();
    const stderr: string[] = [];
    const code = await runFakeCompletionGuard(
      deps({
        stdin: "not-json{",
        emitter,
        stderr: (s) => stderr.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("regex matches multiple variants: <promise>DONE</promise>, plain DONE token, etc.", async () => {
    seedRun("run-fc");
    const emitter = new MockEmitter();
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    seedRun("run-fc", { last_verify_pass_at: stale });

    // <promise>DONE</promise>
    await runFakeCompletionGuard(
      deps({ stdin: '{"transcript":"<promise>DONE</promise>"}', emitter }),
    );
    expect(emitter.calls).toHaveLength(1);

    // <promise>done</promise> (case-insensitive)
    await runFakeCompletionGuard(
      deps({ stdin: '{"transcript":"<promise>done</promise>"}', emitter }),
    );
    expect(emitter.calls).toHaveLength(2);

    // Whitespace-tolerant
    await runFakeCompletionGuard(
      deps({ stdin: '{"transcript":"<promise>  DONE  </promise>"}', emitter }),
    );
    expect(emitter.calls).toHaveLength(3);
  });

  test("emit failure does not propagate, stderr logged", async () => {
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    seedRun("run-fc", { last_verify_pass_at: stale });
    const emitter = new MockEmitter();
    emitter.failNext("clawhip-broken");
    const stderr: string[] = [];
    const code = await runFakeCompletionGuard(
      deps({
        stdin: '{"transcript":"<promise>DONE</promise>"}',
        emitter,
        stderr: (s) => stderr.push(s),
      }),
    );
    expect(code).toBe(0);
    expect(stderr.join("")).toContain("clawhip-broken");
    // Even on emit failure, the prompt-prepend persists — the next agent
    // turn still sees the directive even if the operator missed the alert.
    const m = store.read("run-fc");
    expect(m?.next_prompt_prepend).toContain("team-verify");
  });
});
