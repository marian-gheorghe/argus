/**
 * Notepad summarizer (design §9.6).
 *
 * Pure-ish: takes a notepad's raw content and a `summarize()` callback,
 * returns the structured replacement string. The summarizer itself is
 * **injected** so tests don't make network calls. The default
 * production summarizer is a thin `claude --model haiku` shell-out
 * (defined in cli.ts so this module stays test-friendly).
 *
 * The output template:
 *
 * ```
 * <SUMMARY_MARKER (with timestamp)>
 *
 * ## Decisions made this phase
 * - ...
 *
 * ## Open issues
 * - ...
 *
 * ## Patterns observed
 * - ...
 *
 * ## Original notepad archived to: <archive-path>
 * ```
 *
 * If `summarize()` returns text that already has `Decisions:`,
 * `Open issues:`, `Patterns:` headings, we re-emit them as the three
 * sections above. Otherwise we emit a single `## Free-form summary`
 * section with the raw text.
 *
 * The first line is a deterministic SUMMARY_MARKER which the
 * notepad-cap-hook checks before re-summarizing — running the cap
 * hook against an already-summarized notepad must be a no-op.
 */

const MARKER_PREFIX = "<!-- argus-notepad-summary";

export const SUMMARY_MARKER_RE = /^<!-- argus-notepad-summary[^>]*-->$/m;

/** Test convenience: a short stable substring that always appears in the marker. */
export const SUMMARY_MARKER = MARKER_PREFIX;

export type SummarizeFn = (input: string) => Promise<string>;

export interface SummarizeOpts {
  notepad: string;
  archivePath: string;
  summarize: SummarizeFn;
  now: () => Date;
}

interface ExtractedSections {
  decisions: string[];
  openIssues: string[];
  patterns: string[];
  hadHeadings: boolean;
}

export async function summarizeNotepad(opts: SummarizeOpts): Promise<string> {
  const raw = await opts.summarize(opts.notepad);
  const ts = formatTs(opts.now());
  const header = `${MARKER_PREFIX} generated=${ts} -->`;
  const sections = extractSections(raw);

  const out: string[] = [header, ""];
  out.push(`# Notepad summary (generated ${ts} by Argus knowledge module)`, "");
  if (sections.hadHeadings) {
    out.push("## Decisions made this phase");
    out.push(...renderBullets(sections.decisions));
    out.push("");
    out.push("## Open issues");
    out.push(...renderBullets(sections.openIssues));
    out.push("");
    out.push("## Patterns observed");
    out.push(...renderBullets(sections.patterns));
    out.push("");
  } else {
    out.push("## Free-form summary");
    out.push(raw.trim());
    out.push("");
  }
  out.push(`## Original notepad archived to: ${opts.archivePath}`, "");
  return out.join("\n");
}

function renderBullets(items: string[]): string[] {
  if (items.length === 0) return ["- (none)"];
  return items.map((s) => `- ${s}`);
}

/**
 * Heading-driven extractor. Recognises `Decisions:`, `Open issues:`,
 * `Patterns:` (case-insensitive). Items under each heading can be
 * bulleted with `-` or `*`. Headings remain in effect until the next
 * recognised heading.
 */
function extractSections(text: string): ExtractedSections {
  const HEAD_DECISION = /^decisions(?: made)?(?: this phase)?\s*:?\s*$/i;
  const HEAD_ISSUES = /^open\s*issues\s*:?\s*$/i;
  const HEAD_PATTERNS = /^patterns(?: observed)?\s*:?\s*$/i;
  const decisions: string[] = [];
  const openIssues: string[] = [];
  const patterns: string[] = [];
  let hadHeadings = false;
  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.replace(/^#+\s*/, "").trim();
    if (HEAD_DECISION.test(stripped)) {
      hadHeadings = true;
      current = decisions;
      continue;
    }
    if (HEAD_ISSUES.test(stripped)) {
      hadHeadings = true;
      current = openIssues;
      continue;
    }
    if (HEAD_PATTERNS.test(stripped)) {
      hadHeadings = true;
      current = patterns;
      continue;
    }
    if (current === null) continue;
    const bul = /^\s*[-*]\s*(.+?)\s*$/.exec(line);
    if (bul) {
      const item = bul[1] ?? "";
      if (item.length > 0) current.push(item);
    }
  }
  return { decisions, openIssues, patterns, hadHeadings };
}

function formatTs(d: Date): string {
  // YYYY-MM-DD HH:MM (UTC).
  const iso = d.toISOString();
  const [date, timeAndRest] = iso.split("T");
  const time = (timeAndRest ?? "").slice(0, 5);
  return `${date} ${time}`;
}
