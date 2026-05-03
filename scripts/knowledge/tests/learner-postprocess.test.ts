import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import { parseSkill, runLearnerPostprocess } from "../src/learner-postprocess.ts";

let workDir: string;
let projectSkillsDir: string;
let userSkillsDir: string;
let learningsLog: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "argus-knowledge-pp-"));
  projectSkillsDir = join(workDir, "project-skills");
  userSkillsDir = join(workDir, "user-skills");
  learningsLog = join(workDir, "learnings.jsonl");
  mkdirSync(projectSkillsDir, { recursive: true });
  mkdirSync(userSkillsDir, { recursive: true });
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-03T12:30:00.000Z");

function writeNewSkill(name: string, content: string): string {
  const path = join(workDir, `${name}.md`);
  writeFileSync(path, content, "utf8");
  return path;
}

function writeExistingProjectSkill(name: string, frontmatter: string, body: string): void {
  const dir = join(projectSkillsDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), `---\n${frontmatter}\n---\n${body}`, "utf8");
}

describe("parseSkill", () => {
  test("parses YAML-ish frontmatter + body", () => {
    const md = "---\nname: foo\ntriggers:\n  - one\n  - two\n---\nBody text\n";
    const r = parseSkill(md);
    expect(r.frontmatter.name).toBe("foo");
    expect(r.frontmatter.triggers).toEqual(["one", "two"]);
    expect(r.body.trim()).toBe("Body text");
  });

  test("missing frontmatter -> empty fm + whole content as body", () => {
    const md = "Just a body, no frontmatter here.\n";
    const r = parseSkill(md);
    expect(r.frontmatter.name).toBeUndefined();
    expect(r.frontmatter.triggers).toEqual([]);
    expect(r.body.trim()).toBe("Just a body, no frontmatter here.");
  });

  test("inline list triggers: [a, b, c]", () => {
    const md = "---\nname: bar\ntriggers: [a, b, c]\n---\nbody";
    const r = parseSkill(md);
    expect(r.frontmatter.triggers).toEqual(["a", "b", "c"]);
  });
});

describe("runLearnerPostprocess", () => {
  test("project-scope skill (project anchor in body) -> writes under projectSkillsDir", async () => {
    const skillPath = writeNewSkill(
      "edit-foo",
      [
        "---",
        "name: edit-foo",
        "triggers:",
        "  - editing /Users/marian/work/argus/scripts/foo.ts",
        "---",
        "When editing /Users/marian/work/argus/scripts/foo.ts, run the test suite first.",
      ].join("\n"),
    );

    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-1",
      phase: "harness",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });

    expect(out.scope).toBe("project");
    expect(out.collisions).toEqual([]);
    expect(out.writtenPath).toBe(join(projectSkillsDir, "edit-foo", "SKILL.md"));
    const written = readFileSync(out.writtenPath, "utf8");
    expect(written).toContain("editing /Users/marian/work/argus");
    // No collision comment.
    expect(written).not.toContain("collision:");
  });

  test("user-scope skill (no anchors) -> writes under userSkillsDir", async () => {
    const skillPath = writeNewSkill(
      "tdd-recipe",
      [
        "---",
        "name: tdd-recipe",
        "triggers:",
        "  - implementing a feature",
        "---",
        "Always write the failing test first, run it, then implement.",
      ].join("\n"),
    );

    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-1",
      phase: "harness",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });

    expect(out.scope).toBe("user");
    expect(out.writtenPath).toBe(join(userSkillsDir, "tdd-recipe", "SKILL.md"));
  });

  test("collision: prepends comment + emits learner.collision WARN", async () => {
    // Existing project skill with overlapping trigger.
    writeExistingProjectSkill(
      "old-auth",
      "name: old-auth\ntriggers:\n  - handle auth",
      "Old skill body.\n",
    );
    const skillPath = writeNewSkill(
      "new-auth",
      [
        "---",
        "name: new-auth",
        "triggers:",
        "  - auth handling",
        "---",
        "When ARGUS_DIR is set, do X.",
      ].join("\n"),
    );

    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-2",
      phase: "first-batch",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });

    expect(out.scope).toBe("project");
    expect(out.collisions.length).toBe(1);
    expect(out.collisions[0]?.with.name).toBe("old-auth");
    const written = readFileSync(out.writtenPath, "utf8");
    expect(written).toContain("<!-- collision: candidate-merge with old-auth -->");
    // The original frontmatter + body must be preserved.
    expect(written).toContain("name: new-auth");
    expect(written).toContain("When ARGUS_DIR is set");

    expect(emitter.calls.some((c) => c.event === "learner.collision")).toBe(true);
    const evt = emitter.calls.find((c) => c.event === "learner.collision");
    expect(evt?.severity).toBe("warn");
    expect(evt?.payload.run_id).toBe("run-2");
  });

  test("appends a JSONL line to the learnings log", async () => {
    const skillPath = writeNewSkill(
      "tdd-recipe",
      "---\nname: tdd-recipe\ntriggers:\n  - implementing\n---\nBody.",
    );
    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-3",
      phase: "harness",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });

    expect(out.scope).toBe("user");
    const log = readFileSync(learningsLog, "utf8");
    const line = log.trim();
    const entry = JSON.parse(line) as Record<string, unknown>;
    expect(entry.run_id).toBe("run-3");
    expect(entry.phase).toBe("harness");
    expect(entry.scope).toBe("user");
    expect(entry.skill_path).toBe(out.writtenPath);
    expect(typeof entry.trigger_summary).toBe("string");
    expect(entry.extracted_at).toBe("2026-05-03T12:30:00.000Z");
  });

  test("appends (does not truncate) when learnings log already has entries", async () => {
    writeFileSync(
      learningsLog,
      `${JSON.stringify({ run_id: "old", phase: "x", scope: "user", skill_path: "/foo" })}\n`,
      "utf8",
    );

    const skillPath = writeNewSkill(
      "another",
      "---\nname: another\ntriggers:\n  - foo\n---\nBody.",
    );

    const emitter = new MockEmitter();
    await runLearnerPostprocess({
      skillPath,
      runId: "run-4",
      phase: "harness",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });

    const log = readFileSync(learningsLog, "utf8");
    const lines = log.trim().split("\n");
    expect(lines).toHaveLength(2);
  });

  test("missing skill path -> throws (caller-visible error)", async () => {
    const emitter = new MockEmitter();
    await expect(
      runLearnerPostprocess({
        skillPath: join(workDir, "no-such.md"),
        runId: "run-5",
        phase: "harness",
        projectSkillsDir,
        userSkillsDir,
        learningsLogPath: learningsLog,
        emitter,
        now: () => NOW,
        stderr: () => undefined,
      }),
    ).rejects.toThrow();
  });

  test("derives skill name from frontmatter; falls back to filename", async () => {
    const skillPath = writeNewSkill(
      "fallback-name",
      "---\ntriggers:\n  - foo\n---\nBody only, no name in frontmatter.",
    );
    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-6",
      phase: "harness",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });
    expect(out.writtenPath.endsWith("fallback-name/SKILL.md")).toBe(true);
  });

  test("user-scope routes to userSkillsDir (no project anchors at all)", async () => {
    const skillPath = writeNewSkill(
      "merge-recipe",
      [
        "---",
        "name: merge-recipe",
        "triggers:",
        "  - encountering a merge conflict",
        "---",
        "Use git checkout --theirs and re-run the suite.",
      ].join("\n"),
    );
    const emitter = new MockEmitter();
    const out = await runLearnerPostprocess({
      skillPath,
      runId: "run-7",
      phase: "first-batch",
      projectSkillsDir,
      userSkillsDir,
      learningsLogPath: learningsLog,
      emitter,
      now: () => NOW,
      stderr: () => undefined,
    });
    expect(out.scope).toBe("user");
    expect(out.writtenPath.startsWith(userSkillsDir)).toBe(true);
  });
});
