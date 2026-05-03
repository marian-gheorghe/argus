import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";
import { type TmuxRestartDeps, runTmuxRestart } from "../src/tmux-restart.ts";

let stateDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-tmux-"));
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

interface SpawnRecord {
  cmd: string[];
}

function makeSpawn(): { spawn: TmuxRestartDeps["spawn"]; calls: SpawnRecord[] } {
  const calls: SpawnRecord[] = [];
  const spawn: TmuxRestartDeps["spawn"] = async (cmd) => {
    calls.push({ cmd });
    return { exitCode: 0, stderr: "" };
  };
  return { spawn, calls };
}

function seedCheckpoint(run_id: string, checkpoint: string): void {
  const dir = join(stateDir, "runs", run_id, "checkpoints", checkpoint);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "notepad.md"), "# notepad from checkpoint\n", "utf8");
  writeFileSync(
    join(dir, "project-memory.json"),
    JSON.stringify({ memory: "from checkpoint" }),
    "utf8",
  );
  // include a plans/ subdir
  mkdirSync(join(dir, "plans"), { recursive: true });
  writeFileSync(join(dir, "plans", "plan.md"), "# plan\n", "utf8");
}

describe("runTmuxRestart", () => {
  test("happy path: restores checkpoint files, runs tmux + omc resume, marks attempted", async () => {
    seedRun("run-tmux");
    seedCheckpoint("run-tmux", "20260503T120000Z");
    const { spawn, calls } = makeSpawn();
    const emitter = new MockEmitter();
    const deps: TmuxRestartDeps = {
      stateDir,
      emitter,
      spawn,
      sessionName: "run-tmux-leader",
      stderr: () => undefined,
    };
    const code = await runTmuxRestart(deps);
    expect(code).toBe(0);

    // restored notepad.md and project-memory.json at the live run dir
    expect(readFileSync(join(stateDir, "runs", "run-tmux", "notepad.md"), "utf8")).toContain(
      "from checkpoint",
    );
    expect(
      JSON.parse(readFileSync(join(stateDir, "runs", "run-tmux", "project-memory.json"), "utf8"))
        .memory,
    ).toBe("from checkpoint");
    // restored plans/
    expect(existsSync(join(stateDir, "runs", "run-tmux", "plans", "plan.md"))).toBe(true);

    // tmux new-session + send-keys called
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((s) => s.includes("tmux new-session"))).toBe(true);
    expect(cmds.some((s) => s.includes("tmux send-keys"))).toBe(true);
    expect(cmds.some((s) => s.includes("omc team --resume run-tmux"))).toBe(true);

    // emit was tmux.restart-attempted info
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("tmux.restart-attempted");
    expect(emitter.calls[0]?.severity).toBe("info");

    // marked in manifest
    const m = store.read("run-tmux");
    expect(m?.tmux_restart_attempted).toContain("run-tmux-leader");
  });

  test("second stale within run: emits PAGE 'auto-recovery exhausted', no restart", async () => {
    seedRun("run-tmux", { tmux_restart_attempted: ["run-tmux-leader"] });
    seedCheckpoint("run-tmux", "20260503T120000Z");
    const { spawn, calls } = makeSpawn();
    const emitter = new MockEmitter();
    const deps: TmuxRestartDeps = {
      stateDir,
      emitter,
      spawn,
      sessionName: "run-tmux-leader",
      stderr: () => undefined,
    };
    const code = await runTmuxRestart(deps);
    expect(code).toBe(0);
    expect(calls).toEqual([]); // no tmux invocations
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("tmux.restart-exhausted");
    expect(emitter.calls[0]?.severity).toBe("page");
  });

  test("session name with non-conventional pattern: reject + emit warn", async () => {
    seedRun("run-tmux");
    seedCheckpoint("run-tmux", "20260503T120000Z");
    const { spawn, calls } = makeSpawn();
    const emitter = new MockEmitter();
    const code = await runTmuxRestart({
      stateDir,
      emitter,
      spawn,
      sessionName: "weird-session-name",
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(emitter.calls.some((c) => c.severity === "warn")).toBe(true);
  });

  test("missing manifest: warn + no restart (run never registered)", async () => {
    const { spawn, calls } = makeSpawn();
    const emitter = new MockEmitter();
    const code = await runTmuxRestart({
      stateDir,
      emitter,
      spawn,
      sessionName: "ghost-leader",
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
  });

  test("no checkpoints directory: still restarts tmux but skips replay", async () => {
    seedRun("run-noc");
    const { spawn, calls } = makeSpawn();
    const emitter = new MockEmitter();
    const code = await runTmuxRestart({
      stateDir,
      emitter,
      spawn,
      sessionName: "run-noc-leader",
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    const cmds = calls.map((c) => c.cmd.join(" "));
    expect(cmds.some((s) => s.includes("tmux new-session"))).toBe(true);
    expect(emitter.calls.some((c) => c.event === "tmux.restart-attempted")).toBe(true);
  });

  test("uses LATEST checkpoint by lexicographic name when multiple exist", async () => {
    seedRun("run-multi");
    seedCheckpoint("run-multi", "20260501T120000Z");
    seedCheckpoint("run-multi", "20260502T120000Z");
    seedCheckpoint("run-multi", "20260503T120000Z");
    // Distinguish the latest by content:
    writeFileSync(
      join(stateDir, "runs", "run-multi", "checkpoints", "20260503T120000Z", "notepad.md"),
      "# LATEST\n",
      "utf8",
    );
    const { spawn } = makeSpawn();
    const emitter = new MockEmitter();
    await runTmuxRestart({
      stateDir,
      emitter,
      spawn,
      sessionName: "run-multi-leader",
      stderr: () => undefined,
    });
    expect(readFileSync(join(stateDir, "runs", "run-multi", "notepad.md"), "utf8")).toContain(
      "LATEST",
    );
  });

  test("tmux command fails: emit failure event, manifest still records the attempt", async () => {
    seedRun("run-fail");
    seedCheckpoint("run-fail", "20260503T120000Z");
    const calls: SpawnRecord[] = [];
    const spawn: TmuxRestartDeps["spawn"] = async (cmd) => {
      calls.push({ cmd });
      // first tmux command fails
      if (cmd[0] === "tmux") {
        return { exitCode: 1, stderr: "tmux: server not running" };
      }
      return { exitCode: 0, stderr: "" };
    };
    const emitter = new MockEmitter();
    const stderr: string[] = [];
    const code = await runTmuxRestart({
      stateDir,
      emitter,
      spawn,
      sessionName: "run-fail-leader",
      stderr: (s) => stderr.push(s),
    });
    expect(code).toBe(0);
    // manifest still marks the attempt — we don't want infinite retries
    const m = store.read("run-fail");
    expect(m?.tmux_restart_attempted).toContain("run-fail-leader");
    // an error event surfaced
    expect(emitter.calls.some((c) => c.event === "tmux.restart-failed")).toBe(true);
  });
});
