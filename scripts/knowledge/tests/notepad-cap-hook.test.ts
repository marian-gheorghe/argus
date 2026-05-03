import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import { runNotepadCap } from "../src/notepad-cap-hook.ts";
import { SUMMARY_MARKER, type SummarizeFn } from "../src/notepad-summarizer.ts";

let stateDir: string;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-knowledge-cap-"));
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

const NOW = new Date("2026-05-03T13:00:00.000Z");

function notepadPath(run_id: string): string {
  return join(stateDir, "runs", run_id, "notepad.md");
}

function writeNotepad(run_id: string, body: string): void {
  const dir = join(stateDir, "runs", run_id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(notepadPath(run_id), body, "utf8");
}

const stubSummarizer: SummarizeFn = async () =>
  ["Decisions:", "- chose X", "Open issues:", "- one", "Patterns:", "- pattern A"].join("\n");

describe("runNotepadCap", () => {
  test("missing OMC_CURRENT_RUN_ID -> exit 0, no-op", async () => {
    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: {},
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("missing notepad file -> exit 0, no-op", async () => {
    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-1" },
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("under-cap notepad -> no summarize, no archive", async () => {
    writeNotepad("run-1", "line 1\nline 2\nline 3\n");
    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-1" },
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    const after = readFileSync(notepadPath("run-1"), "utf8");
    expect(after).toBe("line 1\nline 2\nline 3\n");
    expect(emitter.calls).toEqual([]);
  });

  test("over-cap notepad -> summarize, archive, emit info", async () => {
    const original = `${Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeNotepad("run-1", original);

    const emitter = new MockEmitter();
    let summarizeCalls = 0;
    const summarize: SummarizeFn = async (input) => {
      summarizeCalls++;
      expect(input.split("\n").length).toBeGreaterThan(500);
      return ["Decisions:", "- D1", "Open issues:", "- O1", "Patterns:", "- P1"].join("\n");
    };

    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-1" },
      stateDir,
      summarize,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    expect(summarizeCalls).toBe(1);

    const after = readFileSync(notepadPath("run-1"), "utf8");
    expect(after).toContain(SUMMARY_MARKER);
    expect(after.split("\n").length).toBeLessThan(original.split("\n").length);

    // Archive present.
    const archiveDir = join(stateDir, "runs", "run-1", "notepads", "archive");
    expect(existsSync(archiveDir)).toBe(true);
    const archives = readdirSync(archiveDir);
    expect(archives.length).toBe(1);
    const archived = readFileSync(join(archiveDir, archives[0] ?? ""), "utf8");
    expect(archived).toBe(original);

    // Event emitted.
    expect(emitter.calls).toHaveLength(1);
    const evt = emitter.calls[0];
    expect(evt?.event).toBe("learner.notepad-summarized");
    expect(evt?.severity).toBe("info");
    expect(evt?.payload.run_id).toBe("run-1");
    expect(evt?.payload.old_line_count).toBe(600);
    expect(typeof evt?.payload.new_line_count).toBe("number");
  });

  test("idempotent: running again on a freshly-summarized notepad does NOT re-summarize", async () => {
    const original = `${Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeNotepad("run-2", original);

    const emitter = new MockEmitter();
    let calls = 0;
    const summarize: SummarizeFn = async () => {
      calls++;
      // Return enough lines that the post-write notepad would itself be
      // over the cap if we didn't have the marker check.
      const filler = Array.from({ length: 700 }, (_, i) => `- line ${i}`).join("\n");
      return `Decisions:\n${filler}`;
    };

    await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-2" },
      stateDir,
      summarize,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(calls).toBe(1);

    // Second invocation: should be a no-op (the notepad already has
    // the summary marker at top, even if its line count is large).
    await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-2" },
      stateDir,
      summarize,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(calls).toBe(1); // not bumped
    expect(emitter.calls).toHaveLength(1); // no second emit
  });

  test("archive dir is created if missing", async () => {
    const original = `${Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeNotepad("run-3", original);
    const archiveDir = join(stateDir, "runs", "run-3", "notepads", "archive");
    expect(existsSync(archiveDir)).toBe(false);

    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-3" },
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    expect(existsSync(archiveDir)).toBe(true);
  });

  test("crash-resistant: summarizer failure -> exit 0 + writes to stderr (no notepad change)", async () => {
    const original = `${Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeNotepad("run-4", original);
    const messages: string[] = [];
    const summarize: SummarizeFn = async () => {
      throw new Error("haiku unavailable");
    };
    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-4" },
      stateDir,
      summarize,
      emitter,
      stderr: (m) => messages.push(m),
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    // notepad untouched
    const after = readFileSync(notepadPath("run-4"), "utf8");
    expect(after).toBe(original);
    expect(messages.some((m) => m.includes("haiku unavailable"))).toBe(true);
  });

  test("emitter failure: notepad still gets rewritten + archived (event delivery is best-effort)", async () => {
    const original = `${Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;
    writeNotepad("run-5", original);
    const emitter = new MockEmitter();
    emitter.failNext("clawhip down");
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-5" },
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 500,
    });
    expect(code).toBe(0);
    // notepad WAS rewritten — we don't roll back on a clawhip failure.
    const after = readFileSync(notepadPath("run-5"), "utf8");
    expect(after).toContain(SUMMARY_MARKER);
  });

  test("custom maxLines threshold", async () => {
    writeNotepad("run-6", "a\nb\nc\nd\ne\nf\n");
    const emitter = new MockEmitter();
    const code = await runNotepadCap({
      env: { OMC_CURRENT_RUN_ID: "run-6" },
      stateDir,
      summarize: stubSummarizer,
      emitter,
      stderr: () => undefined,
      now: () => NOW,
      maxLines: 5,
    });
    expect(code).toBe(0);
    expect(emitter.calls).toHaveLength(1);
  });
});
