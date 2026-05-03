import { describe, expect, test } from "bun:test";
import { SUMMARY_MARKER, type SummarizeFn, summarizeNotepad } from "../src/notepad-summarizer.ts";

const NOW = new Date("2026-05-03T13:00:00.000Z");

describe("summarizeNotepad", () => {
  test("uses injected summarize fn (no real Claude call)", async () => {
    const calls: string[] = [];
    const summarize: SummarizeFn = async (input) => {
      calls.push(input);
      return [
        "Decisions:",
        "- chose Bun over Node",
        "Open issues:",
        "- need to verify Linux behaviour",
        "Patterns:",
        "- atomic-write everything to /Users/...",
      ].join("\n");
    };
    const out = await summarizeNotepad({
      notepad: "Lots of notepad content here.\nMore lines.\n",
      archivePath: "/tmp/archive/2026.md",
      summarize,
      now: () => NOW,
    });
    expect(calls).toHaveLength(1);
    expect(out).toContain(SUMMARY_MARKER);
    expect(out).toContain("## Decisions made this phase");
    expect(out).toContain("chose Bun over Node");
    expect(out).toContain("## Open issues");
    expect(out).toContain("need to verify Linux behaviour");
    expect(out).toContain("## Patterns observed");
    expect(out).toContain("Original notepad archived to: /tmp/archive/2026.md");
  });

  test("structured input -> structured sections preserved", async () => {
    const summarize: SummarizeFn = async (_input) =>
      ["Decisions:", "- D1", "- D2", "Open issues:", "- O1", "Patterns:", "- P1", "- P2"].join(
        "\n",
      );
    const out = await summarizeNotepad({
      notepad: "x".repeat(100),
      archivePath: "/x.md",
      summarize,
      now: () => NOW,
    });
    expect(out).toContain("- D1");
    expect(out).toContain("- D2");
    expect(out).toContain("- O1");
    expect(out).toContain("- P1");
    expect(out).toContain("- P2");
  });

  test("free-form summary input -> 'Free-form summary' section", async () => {
    const summarize: SummarizeFn = async (_input) =>
      "This phase focused on the notepad summarizer. We finished it and moved on.";
    const out = await summarizeNotepad({
      notepad: "irrelevant",
      archivePath: "/x.md",
      summarize,
      now: () => NOW,
    });
    expect(out).toContain("## Free-form summary");
    expect(out).toContain("This phase focused on the notepad summarizer.");
  });

  test("summary marker is present (idempotency gate)", async () => {
    const summarize: SummarizeFn = async () => "free form text";
    const out = await summarizeNotepad({
      notepad: "x",
      archivePath: "/x.md",
      summarize,
      now: () => NOW,
    });
    expect(out.startsWith(SUMMARY_MARKER)).toBe(true);
  });

  test("includes generation timestamp in marker line", async () => {
    const summarize: SummarizeFn = async () => "free form";
    const out = await summarizeNotepad({
      notepad: "x",
      archivePath: "/x.md",
      summarize,
      now: () => NOW,
    });
    // Match the date portion of the marker line (e.g. "2026-05-03 13:00").
    expect(out).toMatch(/2026-05-03 13:00/);
  });

  test("propagates summarize() errors to caller", async () => {
    const summarize: SummarizeFn = async () => {
      throw new Error("haiku unavailable");
    };
    await expect(
      summarizeNotepad({
        notepad: "x",
        archivePath: "/x.md",
        summarize,
        now: () => NOW,
      }),
    ).rejects.toThrow("haiku unavailable");
  });

  test("extracts decisions from body containing both bulleted and prose forms", async () => {
    const summarize: SummarizeFn = async () =>
      [
        "Decisions:",
        "* picked option A",
        "- ruled out option B",
        "Open issues:",
        "- pending Linux test",
      ].join("\n");
    const out = await summarizeNotepad({
      notepad: "x",
      archivePath: "/x.md",
      summarize,
      now: () => NOW,
    });
    expect(out).toContain("- picked option A");
    expect(out).toContain("- ruled out option B");
    expect(out).toContain("- pending Linux test");
  });
});
