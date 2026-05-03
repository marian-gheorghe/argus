import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CliDeps, dispatchCli, makeHttpHandler } from "../src/cli.ts";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";

let stateDir: string;
let argusDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-cli-state-"));
  argusDir = mkdtempSync(join(tmpdir(), "argus-cli-cred-"));
  store = new ManifestStore(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(argusDir, { recursive: true, force: true });
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

const NOW = new Date("2026-05-03T12:30:00.000Z");

function deps(args?: Partial<CliDeps>): CliDeps & { _emitter: MockEmitter } {
  const emitter = new MockEmitter();
  const dd: CliDeps = {
    stateDir,
    argusDir,
    emitter,
    env: { OMC_CURRENT_RUN_ID: "run-cli", OMC_TASK_ID: "task-1" },
    spawn: async () => ({ exitCode: 0, stderr: "" }),
    cancelRun: async () => undefined,
    stderr: () => undefined,
    stdin: "{}",
    now: () => NOW,
    ralphMaxIterations: 30,
    fakeCompletionFreshnessMs: 5 * 60 * 1000,
    providerPageAfterMs: 2 * 60 * 60 * 1000,
    crashBudgetThreshold: 3,
    ...args,
  };
  return Object.assign(dd, { _emitter: emitter });
}

describe("dispatchCli", () => {
  test("unknown command returns exit code 2", async () => {
    const d = deps();
    const code = await dispatchCli(["unknown-command"], d);
    expect(code).toBe(2);
  });

  test("ralph-cap subcommand wires through to runRalphCap", async () => {
    seedRun("run-cli", { ralph_iterations: { "task-1": 29 } });
    const d = deps();
    const code = await dispatchCli(["ralph-cap"], d);
    expect(code).toBe(0);
    expect(d._emitter.calls[0]?.event).toBe("agent.loop-exhausted");
  });

  test("fake-completion subcommand reads stdin", async () => {
    const stale = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString();
    seedRun("run-cli", { last_verify_pass_at: stale });
    const d = deps({ stdin: '{"transcript":"<promise>DONE</promise>"}' });
    const code = await dispatchCli(["fake-completion"], d);
    expect(code).toBe(0);
    expect(d._emitter.calls[0]?.event).toBe("agent.fake-completion");
  });

  test("tmux-restart subcommand: requires --session arg", async () => {
    const d = deps();
    const code = await dispatchCli(["tmux-restart"], d);
    expect(code).toBe(2); // missing required arg
  });

  test("tmux-restart subcommand with --session", async () => {
    seedRun("run-cli");
    const d = deps();
    const code = await dispatchCli(["tmux-restart", "--session", "run-cli-leader"], d);
    expect(code).toBe(0);
    expect(d._emitter.calls.some((c) => c.event === "tmux.restart-attempted")).toBe(true);
  });

  test("provider-fallback subcommand", async () => {
    seedRun("run-cli", { provider_mode: "api" });
    writeFileSync(join(argusDir, "secrets.env"), 'CLAUDE_CODE_OAUTH_TOKEN="t"\n', "utf8");
    const d = deps();
    const code = await dispatchCli(["provider-fallback"], d);
    expect(code).toBe(0);
    expect(d._emitter.calls.some((c) => c.event === "provider.fallback-engaged")).toBe(true);
  });

  test("budget bump subcommand: takes <run_id> <reason>", async () => {
    seedRun("run-budget");
    const d = deps();
    const code = await dispatchCli(["budget", "bump", "run-budget", "tmux-restart"], d);
    expect(code).toBe(0);
    const m = store.read("run-budget");
    expect(m?.crash_count).toBe(1);
  });

  test("budget bump: missing args -> exit 2", async () => {
    const d = deps();
    const code = await dispatchCli(["budget", "bump", "run-budget"], d);
    expect(code).toBe(2);
  });

  test("budget without subcommand -> exit 2", async () => {
    const d = deps();
    const code = await dispatchCli(["budget"], d);
    expect(code).toBe(2);
  });
});

describe("makeHttpHandler", () => {
  test("POST /tmux-restart with JSON body", async () => {
    seedRun("run-cli");
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(
      new Request("http://127.0.0.1:9601/tmux-restart", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ session_name: "run-cli-leader" }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(d._emitter.calls.some((c) => c.event === "tmux.restart-attempted")).toBe(true);
  });

  test("POST /provider-fallback", async () => {
    seedRun("run-cli", { provider_mode: "api" });
    writeFileSync(join(argusDir, "secrets.env"), 'CLAUDE_CODE_OAUTH_TOKEN="t"\n', "utf8");
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(
      new Request("http://127.0.0.1:9601/provider-fallback", {
        method: "POST",
        body: JSON.stringify({ run_id: "run-cli" }),
      }),
    );
    expect(res.status).toBe(200);
  });

  test("POST /budget/bump requires run_id and reason in body", async () => {
    seedRun("run-cli");
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(
      new Request("http://127.0.0.1:9601/budget/bump", {
        method: "POST",
        body: JSON.stringify({ run_id: "run-cli", reason: "tmux-restart" }),
      }),
    );
    expect(res.status).toBe(200);
    const m = store.read("run-cli");
    expect(m?.crash_count).toBe(1);
  });

  test("POST /budget/bump: missing fields -> 400", async () => {
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(
      new Request("http://127.0.0.1:9601/budget/bump", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("GET /healthz returns 200 ok", async () => {
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(new Request("http://127.0.0.1:9601/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
  });

  test("Unknown route returns 404", async () => {
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(new Request("http://127.0.0.1:9601/nope"));
    expect(res.status).toBe(404);
  });

  test("Wrong method -> 405", async () => {
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(new Request("http://127.0.0.1:9601/tmux-restart", { method: "GET" }));
    expect(res.status).toBe(405);
  });

  test("Malformed JSON body -> 400", async () => {
    const d = deps();
    const handler = makeHttpHandler(d);
    const res = await handler(
      new Request("http://127.0.0.1:9601/tmux-restart", {
        method: "POST",
        body: "{not-json",
      }),
    );
    expect(res.status).toBe(400);
  });
});
