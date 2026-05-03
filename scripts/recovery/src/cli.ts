import { runCrashBudgetBump } from "./crash-budget.ts";
import { ClawhipEmitter, type RecoveryEmitter } from "./emit.ts";
import { runFakeCompletionGuard } from "./fake-completion-guard.ts";
import { runProviderFallback } from "./provider-fallback.ts";
import { runRalphCap } from "./ralph-cap.ts";
import { type TmuxRestartSpawn, runTmuxRestart } from "./tmux-restart.ts";

/**
 * Argus-recovery CLI dispatcher + HTTP serve mode.
 *
 * Subcommands (CLI):
 *   argus-recovery ralph-cap                              Stop hook
 *   argus-recovery fake-completion                        Stop hook
 *   argus-recovery tmux-restart --session <name>          clawhip route / manual
 *   argus-recovery provider-fallback                      clawhip route / manual
 *   argus-recovery budget bump <run_id> <reason>          manual / scripted
 *   argus-recovery serve --port 9601                      HTTP mode
 *
 * Routes (HTTP, all POST except healthz):
 *   POST /tmux-restart        body: { session_name }
 *   POST /provider-fallback   body: { run_id }
 *   POST /budget/bump         body: { run_id, reason }
 *   POST /ralph-cap           body: { run_id, task_id }
 *   POST /fake-completion     body: <Stop-hook payload>
 *   GET  /healthz
 *
 * Single binary, dual entry — clawhip's webhook routes can hit the HTTP
 * endpoints while OMC's Stop hook + manual ops use the CLI.
 */

export interface CliDeps {
  stateDir: string;
  argusDir: string;
  emitter: RecoveryEmitter;
  env: Record<string, string | undefined>;
  spawn: TmuxRestartSpawn;
  cancelRun: (run_id: string) => Promise<void>;
  stderr: (msg: string) => void;
  stdin: string;
  now: () => Date;
  ralphMaxIterations: number;
  fakeCompletionFreshnessMs: number;
  providerPageAfterMs: number;
  crashBudgetThreshold: number;
}

const USAGE = `argus-recovery <command> [args]

Commands:
  ralph-cap                            Stop-hook: ralph iteration cap
  fake-completion                      Stop-hook: fake-completion guard
  tmux-restart --session <name>        Restart a tmux session with checkpoint replay
  provider-fallback                    Toggle Max20 <-> API on outage
  budget bump <run_id> <reason>        Bump crash counter for a run
  serve [--port 9601]                  HTTP server mode for clawhip routes
`;

export async function dispatchCli(args: string[], deps: CliDeps): Promise<number> {
  const cmd = args[0];
  if (!cmd) {
    deps.stderr(USAGE);
    return 2;
  }
  switch (cmd) {
    case "ralph-cap":
      return runRalphCap({
        env: deps.env,
        stateDir: deps.stateDir,
        emitter: deps.emitter,
        maxIterations: deps.ralphMaxIterations,
        stderr: deps.stderr,
      });

    case "fake-completion":
      return runFakeCompletionGuard({
        env: deps.env,
        stdin: deps.stdin,
        stateDir: deps.stateDir,
        emitter: deps.emitter,
        stderr: deps.stderr,
        now: deps.now,
        freshnessMs: deps.fakeCompletionFreshnessMs,
      });

    case "tmux-restart": {
      const session = parseFlag(args, "--session");
      if (!session) {
        deps.stderr("tmux-restart: missing --session <name>\n");
        return 2;
      }
      return runTmuxRestart({
        stateDir: deps.stateDir,
        emitter: deps.emitter,
        spawn: deps.spawn,
        sessionName: session,
        stderr: deps.stderr,
      });
    }

    case "provider-fallback":
      return runProviderFallback({
        env: deps.env,
        stateDir: deps.stateDir,
        argusDir: deps.argusDir,
        emitter: deps.emitter,
        stderr: deps.stderr,
        now: deps.now,
        pageAfterMs: deps.providerPageAfterMs,
      });

    case "budget": {
      const sub = args[1];
      if (sub !== "bump") {
        deps.stderr("budget: unknown subcommand (only 'bump' supported)\n");
        return 2;
      }
      const run_id = args[2];
      const reason = args[3];
      if (!run_id || !reason) {
        deps.stderr("budget bump: missing <run_id> <reason>\n");
        return 2;
      }
      const out = await runCrashBudgetBump({
        run_id,
        reason,
        stateDir: deps.stateDir,
        emitter: deps.emitter,
        threshold: deps.crashBudgetThreshold,
        cancelRun: deps.cancelRun,
        stderr: deps.stderr,
      });
      deps.stderr(
        `budget: count=${out.count} escalated=${out.escalated} (threshold=${deps.crashBudgetThreshold})\n`,
      );
      return 0;
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

function parseFlag(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

/**
 * HTTP request handler — Bun.serve fetch-style.
 * Delegates to the same recovery functions as the CLI. Returns JSON
 * responses with `{ ok, ... }` shape for clawhip's webhook ack.
 */
export function makeHttpHandler(deps: CliDeps): (req: Request) => Promise<Response> {
  return async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") {
      return jsonResponse(200, { ok: true });
    }

    const KNOWN_POST_ROUTES = [
      "/tmux-restart",
      "/provider-fallback",
      "/budget/bump",
      "/ralph-cap",
      "/fake-completion",
    ];
    if (!KNOWN_POST_ROUTES.includes(path)) {
      return jsonResponse(404, { ok: false, error: "not-found" });
    }
    if (req.method !== "POST") {
      return jsonResponse(405, { ok: false, error: "method-not-allowed" });
    }

    let body: unknown;
    try {
      const text = await req.text();
      body = text.length > 0 ? JSON.parse(text) : {};
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return jsonResponse(400, { ok: false, error: `invalid JSON body: ${msg}` });
    }

    try {
      switch (path) {
        case "/tmux-restart": {
          const session_name = (body as { session_name?: string }).session_name;
          if (!session_name) {
            return jsonResponse(400, { ok: false, error: "missing session_name" });
          }
          await runTmuxRestart({
            stateDir: deps.stateDir,
            emitter: deps.emitter,
            spawn: deps.spawn,
            sessionName: session_name,
            stderr: deps.stderr,
          });
          return jsonResponse(200, { ok: true });
        }

        case "/provider-fallback": {
          const run_id = (body as { run_id?: string }).run_id ?? deps.env.OMC_CURRENT_RUN_ID;
          await runProviderFallback({
            env: { ...deps.env, OMC_CURRENT_RUN_ID: run_id },
            stateDir: deps.stateDir,
            argusDir: deps.argusDir,
            emitter: deps.emitter,
            stderr: deps.stderr,
            now: deps.now,
            pageAfterMs: deps.providerPageAfterMs,
          });
          return jsonResponse(200, { ok: true });
        }

        case "/budget/bump": {
          const b = body as { run_id?: string; reason?: string };
          if (!b.run_id || !b.reason) {
            return jsonResponse(400, { ok: false, error: "missing run_id or reason" });
          }
          const out = await runCrashBudgetBump({
            run_id: b.run_id,
            reason: b.reason,
            stateDir: deps.stateDir,
            emitter: deps.emitter,
            threshold: deps.crashBudgetThreshold,
            cancelRun: deps.cancelRun,
            stderr: deps.stderr,
          });
          return jsonResponse(200, { ok: true, count: out.count, escalated: out.escalated });
        }

        case "/ralph-cap": {
          const b = body as { run_id?: string; task_id?: string };
          await runRalphCap({
            env: {
              ...deps.env,
              OMC_CURRENT_RUN_ID: b.run_id,
              OMC_TASK_ID: b.task_id,
            },
            stateDir: deps.stateDir,
            emitter: deps.emitter,
            maxIterations: deps.ralphMaxIterations,
            stderr: deps.stderr,
          });
          return jsonResponse(200, { ok: true });
        }

        case "/fake-completion": {
          await runFakeCompletionGuard({
            env: deps.env,
            stdin: JSON.stringify(body),
            stateDir: deps.stateDir,
            emitter: deps.emitter,
            stderr: deps.stderr,
            now: deps.now,
            freshnessMs: deps.fakeCompletionFreshnessMs,
          });
          return jsonResponse(200, { ok: true });
        }

        default:
          return jsonResponse(404, { ok: false, error: "not-found" });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.stderr(`http: handler crashed: ${msg}\n`);
      return jsonResponse(500, { ok: false, error: msg });
    }
  };
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// CLI entry: read stdin, build prod deps, dispatch.
if (import.meta.main) {
  void main();
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const home = process.env.HOME ?? "";
  const stateDir = process.env.OMC_STATE_DIR ?? `${home}/.claude/omc`;
  const argusDir = process.env.ARGUS_DIR ?? `${home}/.argus`;
  const emitter = new ClawhipEmitter();

  // Special-case `serve` since it doesn't read stdin and never returns.
  if (argv[0] === "serve") {
    const portStr = parseFlagFromArgs(argv, "--port") ?? "9601";
    const port = Number.parseInt(portStr, 10);
    if (!Number.isFinite(port)) {
      process.stderr.write(`serve: --port must be a number, got "${portStr}"\n`);
      process.exit(2);
    }
    const deps: CliDeps = {
      stateDir,
      argusDir,
      emitter,
      env: process.env,
      spawn: defaultSpawn,
      cancelRun: defaultCancelRun,
      stderr: (msg) => process.stderr.write(msg),
      stdin: "",
      now: () => new Date(),
      ralphMaxIterations: Number.parseInt(process.env.RALPH_MAX_ITERATIONS ?? "30", 10),
      fakeCompletionFreshnessMs: Number.parseInt(
        process.env.FAKE_COMPLETION_FRESHNESS_MS ?? "300000",
        10,
      ),
      providerPageAfterMs: Number.parseInt(
        process.env.PROVIDER_PAGE_AFTER_MS ?? `${2 * 60 * 60 * 1000}`,
        10,
      ),
      crashBudgetThreshold: Number.parseInt(process.env.CRASH_BUDGET_THRESHOLD ?? "3", 10),
    };
    const handler = makeHttpHandler(deps);
    Bun.serve({ port, fetch: handler });
    process.stderr.write(`argus-recovery serve listening on http://127.0.0.1:${port}\n`);
    return; // server keeps the process alive
  }

  // Otherwise: dispatch a one-shot command.
  let stdinText = "";
  // Stop-hook subcommands need stdin; budget / tmux-restart / provider-fallback
  // typically don't but it's harmless to accept (and avoids hanging on a TTY:
  // we only read if stdin is piped).
  const isPiped = !process.stdin.isTTY;
  if (isPiped) {
    stdinText = await new Response(Bun.stdin.stream()).text();
  }

  const deps: CliDeps = {
    stateDir,
    argusDir,
    emitter,
    env: process.env,
    spawn: defaultSpawn,
    cancelRun: defaultCancelRun,
    stderr: (msg) => process.stderr.write(msg),
    stdin: stdinText,
    now: () => new Date(),
    ralphMaxIterations: Number.parseInt(process.env.RALPH_MAX_ITERATIONS ?? "30", 10),
    fakeCompletionFreshnessMs: Number.parseInt(
      process.env.FAKE_COMPLETION_FRESHNESS_MS ?? "300000",
      10,
    ),
    providerPageAfterMs: Number.parseInt(
      process.env.PROVIDER_PAGE_AFTER_MS ?? `${2 * 60 * 60 * 1000}`,
      10,
    ),
    crashBudgetThreshold: Number.parseInt(process.env.CRASH_BUDGET_THRESHOLD ?? "3", 10),
  };
  const code = await dispatchCli(argv, deps);
  process.exit(code);
}

function parseFlagFromArgs(args: string[], flag: string): string | null {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1] ?? null;
}

const defaultSpawn: TmuxRestartSpawn = async (cmd) => {
  const proc = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stderrText] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { exitCode: proc.exitCode ?? -1, stderr: stderrText };
};

const defaultCancelRun = async (run_id: string): Promise<void> => {
  const proc = Bun.spawn(["omc", "cancel", run_id], { stdout: "ignore", stderr: "pipe" });
  const stderrText = await new Response(proc.stderr).text();
  await proc.exited;
  if (proc.exitCode !== 0) {
    throw new Error(`omc cancel ${run_id} exited ${proc.exitCode}: ${stderrText.trim()}`);
  }
};
