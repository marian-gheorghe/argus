import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, dispatchCli } from "../src/cli.ts";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";
import type { SummarizeFn } from "../src/notepad-summarizer.ts";

let stateDir: string;
let workDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-knowledge-cli-state-"));
  workDir = mkdtempSync(join(tmpdir(), "argus-knowledge-cli-work-"));
  store = new ManifestStore(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-03T13:00:00.000Z");

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

const stubSummarize: SummarizeFn = async () =>
  ["Decisions:", "- chose X", "Open issues:", "- one"].join("\n");

function deps(args?: Partial<CliDeps>): CliDeps & { _emitter: MockEmitter } {
  const emitter = new MockEmitter();
  const dd: CliDeps = {
    stateDir,
    projectSkillsDir: join(workDir, "project-skills"),
    userSkillsDir: join(workDir, "user-skills"),
    learningsLogPath: join(workDir, "learnings.jsonl"),
    emitter,
    env: { OMC_CURRENT_RUN_ID: "run-cli", OMC_CURRENT_PHASE: "harness" },
    summarize: stubSummarize,
    stderr: () => undefined,
    now: () => NOW,
    notepadMaxLines: 500,
    ...args,
  };
  return Object.assign(dd, { _emitter: emitter });
}

describe("dispatchCli", () => {
  test("unknown command -> exit 2", async () => {
    const code = await dispatchCli(["unknown-command"], deps());
    expect(code).toBe(2);
  });

  test("no command -> exit 2 + usage", async () => {
    const messages: string[] = [];
    const code = await dispatchCli([], deps({ stderr: (m) => messages.push(m) }));
    expect(code).toBe(2);
    expect(messages.join("")).toContain("argus-knowledge");
  });

  test("help -> exit 0", async () => {
    const code = await dispatchCli(["help"], deps());
    expect(code).toBe(0);
  });

  test("learner-cadence wires through to runLearnerCadence", async () => {
    seedRun("run-cli", { phase: "harness" });
    const code = await dispatchCli(
      ["learner-cadence"],
      deps({ env: { OMC_CURRENT_RUN_ID: "run-cli", OMC_CURRENT_PHASE: "first-batch" } }),
    );
    expect(code).toBe(0);
    const m = store.read("run-cli");
    expect(m?.next_prompt_prepend).toBe("/learner");
  });

  test("notepad-cap wires through to runNotepadCap", async () => {
    const dir = join(stateDir, "runs", "run-np");
    mkdirSync(dir, { recursive: true });
    const npPath = join(dir, "notepad.md");
    const big = `${Array.from({ length: 600 }, (_, i) => `line ${i}`).join("\n")}\n`;
    writeFileSync(npPath, big, "utf8");
    const d = deps({ env: { OMC_CURRENT_RUN_ID: "run-np" } });
    const code = await dispatchCli(["notepad-cap"], d);
    expect(code).toBe(0);
    expect(d._emitter.calls.some((c) => c.event === "learner.notepad-summarized")).toBe(true);
  });

  test("learner-postprocess requires <skill-path> arg", async () => {
    const code = await dispatchCli(["learner-postprocess"], deps());
    expect(code).toBe(2);
  });

  test("learner-postprocess <path> writes the SKILL.md", async () => {
    const skillFile = join(workDir, "tdd-recipe.md");
    writeFileSync(
      skillFile,
      "---\nname: tdd-recipe\ntriggers:\n  - implementing\n---\nBody",
      "utf8",
    );
    const code = await dispatchCli(
      ["learner-postprocess", skillFile],
      deps({ env: { OMC_CURRENT_RUN_ID: "run-cli", OMC_CURRENT_PHASE: "first-batch" } }),
    );
    expect(code).toBe(0);
    const written = readFileSync(join(workDir, "user-skills", "tdd-recipe", "SKILL.md"), "utf8");
    expect(written).toContain("name: tdd-recipe");
  });

  test("learner-postprocess: missing skill path -> exit 1 (not crash-resistant; surfaced to operator)", async () => {
    const messages: string[] = [];
    const code = await dispatchCli(
      ["learner-postprocess", join(workDir, "missing.md")],
      deps({ stderr: (m) => messages.push(m) }),
    );
    expect(code).toBe(1);
    expect(messages.join("")).toContain("learner-postprocess");
  });
});
