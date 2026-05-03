import { ClawhipEmitter, type KnowledgeEmitter } from "./emit.ts";
import { runLearnerCadence } from "./learner-cadence.ts";
import { runLearnerPostprocess } from "./learner-postprocess.ts";
import { runNotepadCap } from "./notepad-cap-hook.ts";
import type { SummarizeFn } from "./notepad-summarizer.ts";

/**
 * Argus-knowledge CLI dispatcher.
 *
 * Subcommands:
 *   argus-knowledge learner-cadence                         Stop hook
 *   argus-knowledge learner-postprocess <skill-path>        post-process /learner output
 *   argus-knowledge notepad-cap                             PostToolUse hook
 *
 * The two hooks (`learner-cadence`, `notepad-cap`) are crash-resistant:
 * any internal error returns exit 0 (already handled by the runners).
 * `learner-postprocess` is operator-invoked and surfaces failures
 * (exit 1) so the operator sees what went wrong.
 */

export interface CliDeps {
  stateDir: string;
  projectSkillsDir: string;
  userSkillsDir: string;
  learningsLogPath: string;
  emitter: KnowledgeEmitter;
  env: Record<string, string | undefined>;
  summarize: SummarizeFn;
  stderr: (msg: string) => void;
  now: () => Date;
  notepadMaxLines: number;
}

const USAGE = `argus-knowledge <command> [args]

Commands:
  learner-cadence                       Stop hook: queue /learner at phase boundaries
  learner-postprocess <skill-path>      Post-process a /learner output (classify + collision-check + write)
  notepad-cap                           PostToolUse hook: summarize notepad.md if > 500 lines
  help                                  Show this help
`;

export async function dispatchCli(args: string[], deps: CliDeps): Promise<number> {
  const cmd = args[0];
  if (!cmd) {
    deps.stderr(USAGE);
    return 2;
  }
  switch (cmd) {
    case "learner-cadence":
      return runLearnerCadence({
        env: deps.env,
        stateDir: deps.stateDir,
        stderr: deps.stderr,
        now: deps.now,
      });

    case "notepad-cap":
      return runNotepadCap({
        env: deps.env,
        stateDir: deps.stateDir,
        summarize: deps.summarize,
        emitter: deps.emitter,
        stderr: deps.stderr,
        now: deps.now,
        maxLines: deps.notepadMaxLines,
      });

    case "learner-postprocess": {
      const skillPath = args[1];
      if (!skillPath) {
        deps.stderr("learner-postprocess: missing <skill-path>\n");
        return 2;
      }
      const run_id = deps.env.OMC_CURRENT_RUN_ID ?? "manual";
      const phase = deps.env.OMC_CURRENT_PHASE ?? "manual";
      try {
        await runLearnerPostprocess({
          skillPath,
          runId: run_id,
          phase,
          projectSkillsDir: deps.projectSkillsDir,
          userSkillsDir: deps.userSkillsDir,
          learningsLogPath: deps.learningsLogPath,
          emitter: deps.emitter,
          now: deps.now,
          stderr: deps.stderr,
        });
        return 0;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        deps.stderr(`learner-postprocess: ${msg}\n`);
        return 1;
      }
    }

    case "help":
    case "--help":
    case "-h":
      deps.stderr(USAGE);
      return 0;

    default:
      deps.stderr(`unknown command: ${cmd}\n${USAGE}`);
      return 2;
  }
}

// CLI entry: build prod deps + dispatch.
if (import.meta.main) {
  void main();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = process.env.HOME ?? "";
  const stateDir = process.env.OMC_STATE_DIR ?? `${home}/.claude/omc`;
  const repoRoot = process.env.ARGUS_REPO_ROOT ?? process.cwd();
  const projectSkillsDir = process.env.ARGUS_PROJECT_SKILLS_DIR ?? `${repoRoot}/.omc/skills`;
  const userSkillsDir = process.env.ARGUS_USER_SKILLS_DIR ?? `${home}/.omc/skills`;
  const learningsLogPath =
    process.env.ARGUS_LEARNINGS_LOG ?? `${home}/.claude/omc/argus/learnings.jsonl`;
  const emitter = new ClawhipEmitter();

  const deps: CliDeps = {
    stateDir,
    projectSkillsDir,
    userSkillsDir,
    learningsLogPath,
    emitter,
    env: process.env,
    summarize: defaultSummarize,
    stderr: (msg) => process.stderr.write(msg),
    now: () => new Date(),
    notepadMaxLines: Number.parseInt(process.env.ARGUS_NOTEPAD_MAX_LINES ?? "500", 10),
  };
  const code = await dispatchCli(argv, deps);
  process.exit(code);
}

/**
 * Default production summarizer. Shells out to `claude --model haiku`
 * using stdin/stdout. The CLI prompt is a fixed instruction asking for
 * the structured `Decisions:` / `Open issues:` / `Patterns:` headings
 * the summarizer expects. If `claude` is unavailable, we throw — the
 * notepad-cap hook catches the throw, leaves the notepad untouched,
 * and logs the failure to stderr.
 */
const defaultSummarize: SummarizeFn = async (notepad: string) => {
  const prompt = [
    "Summarize the following Argus run notepad. Output exactly three",
    "sections, each headed by 'Decisions:', 'Open issues:', or",
    "'Patterns:' followed by a bulleted list. No preamble, no",
    "trailing prose. Keep total output under 60 lines.",
    "",
    "----- NOTEPAD -----",
    notepad,
  ].join("\n");
  const proc = Bun.spawn(["claude", "--model", "haiku", "--no-stream"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  proc.stdin.write(prompt);
  proc.stdin.end();
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`claude exited ${proc.exitCode}: ${stderrText.trim() || "(no stderr)"}`);
  }
  return stdoutText;
};
