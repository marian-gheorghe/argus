/**
 * /learner postprocess orchestrator (design §9.2 + §9.5).
 *
 * After `/learner` produces a new skill (a markdown file with YAML
 * frontmatter), this orchestrator:
 *   1. Parses frontmatter + body.
 *   2. Calls classifyScope() to decide project vs user scope.
 *   3. Globs the existing skills under the chosen scope dir and
 *      calls detectCollisions() to find trigger overlap.
 *   4. If collisions exist, prepends `<!-- collision: candidate-merge
 *      with X -->` comments to the new skill body and emits a WARN
 *      event `learner.collision`.
 *   5. Atomically writes the new SKILL.md under
 *      `<scopeDir>/<skill-name>/SKILL.md`.
 *   6. Appends a JSONL line to the learnings log.
 *
 * Frontmatter parsing is a *very* small handwritten parser — we
 * accept a single `name:` scalar, a `triggers:` list either as a
 * `[a, b, c]` flow or `\n  - a\n  - b\n` block. Avoiding a YAML dep
 * keeps `/learner` outputs predictable: they go through the same
 * tooling that wrote them.
 *
 * **Invocation (Phase C):** manual or scripted from a Phase D
 * file-watcher / OMC `/learner` skill extension. Not wired to any
 * hook here.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { type Scope, classifyScope } from "./classify-scope.ts";
import { type Collision, type ExistingSkill, detectCollisions } from "./collision-check.ts";
import type { KnowledgeEmitter } from "./emit.ts";

export interface SkillFrontmatter {
  name?: string;
  triggers: string[];
  // additional fields are preserved verbatim in the rendered output
  // (we don't currently surface them in the typed shape).
  _raw: string;
}

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkill(md: string): ParsedSkill {
  const m = FRONTMATTER_RE.exec(md);
  if (!m) {
    return { frontmatter: { triggers: [], _raw: "" }, body: md };
  }
  const raw = m[1] ?? "";
  const body = m[2] ?? "";
  const fm = parseFrontmatter(raw);
  return { frontmatter: fm, body };
}

function parseFrontmatter(raw: string): SkillFrontmatter {
  const lines = raw.split(/\r?\n/);
  let name: string | undefined;
  const triggers: string[] = [];
  let inTriggersBlock = false;
  for (const line of lines) {
    const nameMatch = /^name:\s*(.+?)\s*$/.exec(line);
    if (nameMatch) {
      name = nameMatch[1];
      inTriggersBlock = false;
      continue;
    }
    // Inline list: triggers: [a, b, c]
    const inlineMatch = /^triggers:\s*\[([^\]]*)\]\s*$/.exec(line);
    if (inlineMatch) {
      const items = (inlineMatch[1] ?? "").split(",").map((s) =>
        s
          .trim()
          .replace(/^["']|["']$/g, "")
          .trim(),
      );
      for (const it of items) {
        if (it.length > 0) triggers.push(it);
      }
      inTriggersBlock = false;
      continue;
    }
    // Block start: triggers:
    if (/^triggers:\s*$/.test(line)) {
      inTriggersBlock = true;
      continue;
    }
    if (inTriggersBlock) {
      const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(line);
      if (itemMatch) {
        const item = (itemMatch[1] ?? "").replace(/^["']|["']$/g, "").trim();
        if (item.length > 0) triggers.push(item);
        continue;
      }
      // any non-list line ends the block
      if (line.trim().length > 0) {
        inTriggersBlock = false;
      }
    }
  }
  return { name, triggers, _raw: raw };
}

export interface PostprocessOpts {
  skillPath: string; // path to the new SKILL.md output by /learner
  runId: string;
  phase: string;
  projectSkillsDir: string;
  userSkillsDir: string;
  learningsLogPath: string;
  emitter: KnowledgeEmitter;
  now: () => Date;
  stderr: (msg: string) => void;
}

export interface PostprocessResult {
  scope: Scope;
  writtenPath: string;
  collisions: Collision[];
}

export async function runLearnerPostprocess(opts: PostprocessOpts): Promise<PostprocessResult> {
  const md = readFileSync(opts.skillPath, "utf8");
  const parsed = parseSkill(md);
  const skillName = parsed.frontmatter.name ?? stripExt(basename(opts.skillPath));

  const { scope, reasons } = classifyScope({
    skillContent: md,
    skillName,
  });

  const scopeDir = scope === "project" ? opts.projectSkillsDir : opts.userSkillsDir;
  const existing = readExistingSkills(scopeDir);
  const collisions = detectCollisions({
    newSkill: { name: skillName, triggers: parsed.frontmatter.triggers },
    existing,
  });

  // Re-render the skill: collision comments prepended to body.
  const collisionComments = collisions
    .map((c) => `<!-- collision: candidate-merge with ${c.with.name} -->`)
    .join("\n");
  const finalContent = renderSkill(parsed, collisionComments);

  // Atomically write to <scopeDir>/<skill-name>/SKILL.md
  const skillDir = join(scopeDir, skillName);
  mkdirSync(skillDir, { recursive: true });
  const writtenPath = join(skillDir, "SKILL.md");
  atomicWrite(writtenPath, finalContent);

  // Emit collision event.
  if (collisions.length > 0) {
    try {
      await opts.emitter.emit("learner.collision", "warn", {
        run_id: opts.runId,
        phase: opts.phase,
        scope,
        new_skill: skillName,
        new_skill_path: writtenPath,
        collisions: collisions.map((c) => ({
          with: c.with.name,
          path: c.with.path,
          overlap: c.overlap,
        })),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      opts.stderr(`learner-postprocess: emitter failed (continuing): ${msg}\n`);
    }
  }

  // Append learnings log line. Atomic append: open(O_APPEND) on a single
  // small write is atomic at the page level (POSIX guarantee for writes
  // <= PIPE_BUF, ~4KB; our line is well under that).
  const triggerSummary = parsed.frontmatter.triggers.slice(0, 3).join(" | ") || "(none)";
  const entry = {
    run_id: opts.runId,
    phase: opts.phase,
    scope,
    skill_path: writtenPath,
    trigger_summary: triggerSummary,
    extracted_at: opts.now().toISOString(),
    classification_reasons: reasons,
  };
  appendJsonLine(opts.learningsLogPath, JSON.stringify(entry));

  return { scope, writtenPath, collisions };
}

/** Glob existing skills as `<scopeDir>/*\/SKILL.md`. */
function readExistingSkills(scopeDir: string): ExistingSkill[] {
  if (!existsSync(scopeDir)) return [];
  const result: ExistingSkill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(scopeDir);
  } catch {
    return [];
  }
  for (const entry of entries) {
    const dir = join(scopeDir, entry);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(dir);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    const skillPath = join(dir, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    let content: string;
    try {
      content = readFileSync(skillPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkill(content);
    result.push({
      path: skillPath,
      name: parsed.frontmatter.name ?? entry,
      triggers: parsed.frontmatter.triggers,
    });
  }
  return result;
}

function renderSkill(parsed: ParsedSkill, collisionComments: string): string {
  const fm = parsed.frontmatter._raw;
  const body = parsed.body.replace(/^\r?\n+/, "");
  const prefix = collisionComments.length > 0 ? `${collisionComments}\n\n` : "";
  if (fm.length === 0) {
    return `${prefix}${body}`;
  }
  return `---\n${fm}\n---\n${prefix}${body}`;
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

function appendJsonLine(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const buf = `${line}\n`;
  writeFileSync(path, buf, { flag: "a", mode: 0o600 });
}

function stripExt(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}
