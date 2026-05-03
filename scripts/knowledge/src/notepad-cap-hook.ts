/**
 * Notepad 500-line cap hook (design §9.6) — PostToolUse entry.
 *
 * 1. Read OMC_CURRENT_RUN_ID. Missing -> silent no-op.
 * 2. Compute notepad path: `<stateDir>/runs/<run_id>/notepad.md`.
 *    Missing -> silent no-op.
 * 3. Read notepad. <= maxLines (default 500) -> exit 0.
 * 4. Idempotency gate: if first ~256 bytes contain SUMMARY_MARKER_RE,
 *    we already summarized this notepad. Exit 0.
 * 5. Call summarizeNotepad(); atomically write the summary back.
 *    Atomically copy the original to
 *    `<stateDir>/runs/<run_id>/notepads/archive/<timestamp>.md`.
 * 6. Emit `learner.notepad-summarized` (INFO) with old/new line
 *    counts.
 *
 * Crash resistance: this is a PostToolUse hook. Any failure exits 0
 * + logs to stderr. The notepad is rewritten only after the
 * summarize() call succeeds; if summarize throws, the original is
 * untouched.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { KnowledgeEmitter } from "./emit.ts";
import { SUMMARY_MARKER_RE, type SummarizeFn, summarizeNotepad } from "./notepad-summarizer.ts";

export interface NotepadCapOpts {
  env: Record<string, string | undefined>;
  stateDir: string;
  summarize: SummarizeFn;
  emitter: KnowledgeEmitter;
  stderr: (msg: string) => void;
  now: () => Date;
  maxLines: number;
}

export async function runNotepadCap(opts: NotepadCapOpts): Promise<number> {
  try {
    const run_id = opts.env.OMC_CURRENT_RUN_ID;
    if (!run_id) return 0;

    const notepadPath = join(opts.stateDir, "runs", run_id, "notepad.md");
    if (!existsSync(notepadPath)) return 0;

    const original = readFileSync(notepadPath, "utf8");
    const oldLineCount = countLines(original);
    if (oldLineCount <= opts.maxLines) return 0;

    // Idempotency: a previously-summarized notepad keeps the marker
    // line at the top. The marker doesn't shrink with content (a
    // long summary may itself exceed maxLines), so we gate on the
    // marker rather than the line count.
    const head = original.slice(0, 1024);
    if (SUMMARY_MARKER_RE.test(head)) return 0;

    // Compute archive path (UTC timestamp, fs-safe).
    const archiveDir = join(opts.stateDir, "runs", run_id, "notepads", "archive");
    const ts = fsTimestamp(opts.now());
    const archivePath = join(archiveDir, `${ts}.md`);

    // Summarize FIRST. If this throws, we don't touch the notepad.
    let summary: string;
    try {
      summary = await summarizeNotepad({
        notepad: original,
        archivePath,
        summarize: opts.summarize,
        now: opts.now,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      opts.stderr(`notepad-cap: summarize failed (notepad untouched): ${msg}\n`);
      return 0;
    }

    // Archive the original.
    mkdirSync(archiveDir, { recursive: true });
    atomicWrite(archivePath, original);

    // Replace the notepad atomically.
    atomicWrite(notepadPath, summary);

    // Emit (best-effort: failure does not roll back the rewrite).
    try {
      await opts.emitter.emit("learner.notepad-summarized", "info", {
        run_id,
        old_line_count: oldLineCount,
        new_line_count: countLines(summary),
        archive_path: archivePath,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      opts.stderr(`notepad-cap: emitter failed (continuing): ${msg}\n`);
    }

    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    opts.stderr(`notepad-cap: internal error (suppressed): ${msg}\n`);
    return 0;
  }
}

function countLines(s: string): number {
  if (s.length === 0) return 0;
  // Count "\n" characters; a trailing "\n" counts as a separator
  // between two records, the second being empty — same convention as
  // wc -l so the threshold matches operator intuition.
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10) n++;
  }
  // If the file does NOT end in newline, the last partial line counts.
  if (s.charCodeAt(s.length - 1) !== 10) n++;
  return n;
}

function fsTimestamp(d: Date): string {
  // YYYY-MM-DDTHH-MM-SSZ — colons replaced with hyphens for FS safety.
  return d
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "Z");
}

function atomicWrite(finalPath: string, content: string): void {
  mkdirSync(dirname(finalPath), { recursive: true });
  const tmpPath = `${finalPath}.tmp.${process.pid}`;
  const fd = openSync(tmpPath, "w", 0o600);
  try {
    writeSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmpPath, finalPath);
}
