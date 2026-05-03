import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Accumulator } from "../src/accumulator.ts";
import { MockEmitter } from "../src/emit.ts";
import { type HookDeps, modelToTier, runHook } from "../src/hook.ts";
import { Policy } from "../src/policy.ts";
import { Pricing } from "../src/pricing.ts";

let tmpDir: string;
let dbPath: string;
let policyPath: string;
let pricingPath: string;

const PRICING_TOML = `
[claude-haiku]
input_eur_per_million = 0.80
cached_input_eur_per_million = 0.10
output_eur_per_million = 4.00

[claude-sonnet]
input_eur_per_million = 3.00
cached_input_eur_per_million = 0.30
output_eur_per_million = 15.00

[claude-opus]
input_eur_per_million = 15.00
cached_input_eur_per_million = 1.50
output_eur_per_million = 75.00
`;

const POLICY_API = `
[default]
billing = "api"
api_ceiling_eur = 0.50
api_ceiling_overridable = true

[tier_thresholds]
warn = 0.75
page = 1.00
kill = 1.10
`;

const POLICY_MAX20 = `
[default]
billing = "max20"
api_ceiling_eur = 50
api_ceiling_overridable = true
`;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-hook-"));
  dbPath = join(tmpDir, "cost-tracker.sqlite");
  policyPath = join(tmpDir, "policy.toml");
  pricingPath = join(tmpDir, "pricing.toml");
  writeFileSync(pricingPath, PRICING_TOML);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

interface RunResult {
  exitCode: number;
  stderr: string;
  emitter: MockEmitter;
  pauseCalls: string[];
  cancelCalls: string[];
}

async function fire(stdin: string, env: Record<string, string>): Promise<RunResult> {
  const emitter = new MockEmitter();
  const pauseCalls: string[] = [];
  const cancelCalls: string[] = [];
  const stderrChunks: string[] = [];
  const deps: HookDeps = {
    stdin,
    env,
    policyPath,
    pricingPath,
    dbPath,
    emitter,
    pauseRun: async (run_id: string) => {
      pauseCalls.push(run_id);
    },
    cancelRun: async (run_id: string) => {
      cancelCalls.push(run_id);
    },
    stderr: (msg: string) => stderrChunks.push(msg),
  };
  const exitCode = await runHook(deps);
  return { exitCode, stderr: stderrChunks.join(""), emitter, pauseCalls, cancelCalls };
}

function makePostToolUsePayload(args: {
  model: string;
  input?: number;
  cached?: number;
  output?: number;
}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_response: {
      usage: {
        input_tokens: args.input ?? 0,
        cache_read_input_tokens: args.cached ?? 0,
        output_tokens: args.output ?? 0,
      },
      model: args.model,
    },
  });
}

describe("modelToTier", () => {
  test("maps haiku family", () => {
    expect(modelToTier("claude-3-haiku-20240307")).toBe("haiku");
    expect(modelToTier("claude-3-5-haiku-20241022")).toBe("haiku");
    expect(modelToTier("claude-3-5-haiku-latest")).toBe("haiku");
  });

  test("maps sonnet family (3.5 + 4)", () => {
    expect(modelToTier("claude-3-5-sonnet-20241022")).toBe("sonnet");
    expect(modelToTier("claude-sonnet-4-20250514")).toBe("sonnet");
    expect(modelToTier("claude-sonnet-4-7")).toBe("sonnet");
  });

  test("maps opus family", () => {
    expect(modelToTier("claude-3-opus-20240229")).toBe("opus");
    expect(modelToTier("claude-opus-4-20250514")).toBe("opus");
  });

  test("returns null for unknown models (caller defaults to sonnet)", () => {
    expect(modelToTier("gpt-4")).toBeNull();
    expect(modelToTier("claude-experimental-mystery")).toBeNull();
    expect(modelToTier("")).toBeNull();
  });
});

describe("hook — Max20 mode", () => {
  test("exits 0 silently and writes nothing", async () => {
    writeFileSync(policyPath, POLICY_MAX20);
    const stdin = makePostToolUsePayload({
      model: "claude-sonnet-4-20250514",
      input: 1_000_000,
      output: 1_000_000,
    });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-1" });
    expect(r.exitCode).toBe(0);
    expect(r.emitter.calls).toHaveLength(0);
    // sqlite db must NOT have been opened (no rows)
    const acc = new Accumulator(dbPath);
    try {
      expect(acc.getRun("run-1")).toBeNull();
    } finally {
      acc.close();
    }
  });
});

describe("hook — API mode accumulation (no threshold)", () => {
  test("under-threshold add: accumulates spend, no emit", async () => {
    writeFileSync(policyPath, POLICY_API); // 0.50 EUR ceiling
    const stdin = makePostToolUsePayload({
      model: "claude-sonnet-4-20250514",
      input: 10_000, // 0.03 EUR — well under 0.375 (75%)
      output: 1_000, // 0.015 EUR
    });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-low" });
    expect(r.exitCode).toBe(0);
    expect(r.emitter.calls).toHaveLength(0);

    const acc = new Accumulator(dbPath);
    try {
      const row = acc.getRun("run-low");
      expect(row).not.toBeNull();
      if (row) {
        expect(row.sonnet_input_tokens).toBe(10_000);
        expect(row.sonnet_output_tokens).toBe(1_000);
        expect(row.spent_eur).toBeCloseTo(0.045, 6);
      }
    } finally {
      acc.close();
    }
  });
});

describe("hook — threshold crossings", () => {
  test("crossing 75% emits cost.warn exactly once across multiple invocations", async () => {
    writeFileSync(policyPath, POLICY_API); // 0.50 EUR ceiling, 75% = 0.375 EUR
    // 1 input million sonnet @ 3 EUR — way over 0.5; first call already
    // crosses kill. So we want a smaller payload.
    // Choose: 100k sonnet output @ 15e-6 = 1.5 EUR? Still over.
    // Use 25k output sonnet → 25k * 15e-6 = 0.375 EUR exactly = warn boundary.
    const stdin1 = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 25_000,
    });
    const r1 = await fire(stdin1, { OMC_CURRENT_RUN_ID: "run-warn" });
    expect(r1.exitCode).toBe(0);
    const warnCalls1 = r1.emitter.calls.filter((c) => c.event === "cost.warn");
    expect(warnCalls1).toHaveLength(1);
    expect(warnCalls1[0]?.payload.run_id).toBe("run-warn");

    // Second invocation, no new tokens - should NOT re-emit warn (idempotent).
    const stdin2 = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 0,
    });
    const r2 = await fire(stdin2, { OMC_CURRENT_RUN_ID: "run-warn" });
    expect(r2.exitCode).toBe(0);
    expect(r2.emitter.calls).toHaveLength(0);
  });

  test("crossing 100% emits cost.page AND triggers omc pause", async () => {
    writeFileSync(policyPath, POLICY_API); // 0.50 EUR ceiling
    // 35k sonnet output = 35000 * 15e-6 = 0.525 EUR → 105% (between page and kill).
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 35_000,
    });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-page" });
    expect(r.exitCode).toBe(0);
    // Both warn + page should be emitted in this single call (we cross both
    // boundaries) — the implementation chooses to emit each crossed-but-not-
    // yet-emitted level.
    const eventNames = r.emitter.calls.map((c) => c.event);
    expect(eventNames).toContain("cost.warn");
    expect(eventNames).toContain("cost.page");
    expect(r.pauseCalls).toContain("run-page");
    expect(r.cancelCalls).toHaveLength(0);
  });

  test("crossing 110% emits cost.kill AND triggers omc cancel", async () => {
    writeFileSync(policyPath, POLICY_API); // 0.50 EUR ceiling
    // 40k sonnet output = 0.6 EUR → 120% (over kill).
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 40_000,
    });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-kill" });
    expect(r.exitCode).toBe(0);
    const eventNames = r.emitter.calls.map((c) => c.event);
    expect(eventNames).toContain("cost.warn");
    expect(eventNames).toContain("cost.page");
    expect(eventNames).toContain("cost.kill");
    expect(r.pauseCalls).toContain("run-kill");
    expect(r.cancelCalls).toContain("run-kill");
  });
});

describe("hook — defensive failure modes", () => {
  test("missing OMC_CURRENT_RUN_ID env: warn to stderr, exit 0", async () => {
    writeFileSync(policyPath, POLICY_API);
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      input: 1000,
    });
    const r = await fire(stdin, {});
    expect(r.exitCode).toBe(0);
    expect(r.emitter.calls).toHaveLength(0);
    expect(r.stderr).toMatch(/OMC_CURRENT_RUN_ID/);
  });

  test("unknown model: defaults to sonnet, logs warn", async () => {
    writeFileSync(policyPath, POLICY_API);
    const stdin = makePostToolUsePayload({ model: "claude-mystery-future", input: 1000 });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-mystery" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/unknown model|defaulting to sonnet/i);
    const acc = new Accumulator(dbPath);
    try {
      const row = acc.getRun("run-mystery");
      expect(row?.sonnet_input_tokens).toBe(1000);
    } finally {
      acc.close();
    }
  });

  test("emit failure does NOT crash the hook (logs to stderr, exit 0)", async () => {
    writeFileSync(policyPath, POLICY_API);
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 25_000, // crosses warn
    });
    // Make the emitter throw on first call.
    const emitter = new MockEmitter();
    emitter.failNext("network unreachable");
    const stderrChunks: string[] = [];
    const deps: HookDeps = {
      stdin,
      env: { OMC_CURRENT_RUN_ID: "run-emit-fail" },
      policyPath,
      pricingPath,
      dbPath,
      emitter,
      pauseRun: async () => {},
      cancelRun: async () => {},
      stderr: (msg: string) => stderrChunks.push(msg),
    };
    const exitCode = await runHook(deps);
    expect(exitCode).toBe(0);
    expect(stderrChunks.join("")).toMatch(/network unreachable|emit failed/i);
  });

  test("pause shell-out failure does NOT crash the hook", async () => {
    writeFileSync(policyPath, POLICY_API);
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      output: 35_000, // crosses page
    });
    const emitter = new MockEmitter();
    const stderrChunks: string[] = [];
    const deps: HookDeps = {
      stdin,
      env: { OMC_CURRENT_RUN_ID: "run-pause-fail" },
      policyPath,
      pricingPath,
      dbPath,
      emitter,
      pauseRun: async () => {
        throw new Error("omc binary not found");
      },
      cancelRun: async () => {},
      stderr: (msg: string) => stderrChunks.push(msg),
    };
    const exitCode = await runHook(deps);
    expect(exitCode).toBe(0);
    expect(stderrChunks.join("")).toMatch(/omc binary not found|pause failed/i);
  });

  test("malformed JSON stdin: exit 0 with stderr", async () => {
    writeFileSync(policyPath, POLICY_API);
    const r = await fire("not json at all", { OMC_CURRENT_RUN_ID: "run-x" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/JSON|parse/i);
  });

  test("missing usage object: exit 0 silently (no-op)", async () => {
    writeFileSync(policyPath, POLICY_API);
    const r = await fire(JSON.stringify({ hook_event_name: "PostToolUse", tool_response: {} }), {
      OMC_CURRENT_RUN_ID: "run-nousage",
    });
    expect(r.exitCode).toBe(0);
    expect(r.emitter.calls).toHaveLength(0);
  });

  test("missing policy file: exit 0 with stderr (cannot enforce without policy)", async () => {
    // policyPath does not exist
    const stdin = makePostToolUsePayload({ model: "claude-3-5-sonnet-20241022", output: 1000 });
    const r = await fire(stdin, { OMC_CURRENT_RUN_ID: "run-no-policy" });
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toMatch(/policy/i);
  });

  test("internal accumulator throw: exit 0 with stderr", async () => {
    writeFileSync(policyPath, POLICY_API);
    const stdin = makePostToolUsePayload({
      model: "claude-3-5-sonnet-20241022",
      input: 1000,
    });
    // Inject a deliberately broken dbPath: an existing directory, which sqlite
    // can't open as a database.
    const deps: HookDeps = {
      stdin,
      env: { OMC_CURRENT_RUN_ID: "run-bad-db" },
      policyPath,
      pricingPath,
      dbPath: tmpDir, // a directory, not a file → sqlite open will throw
      emitter: new MockEmitter(),
      pauseRun: async () => {},
      cancelRun: async () => {},
      stderr: () => {},
    };
    const exitCode = await runHook(deps);
    expect(exitCode).toBe(0);
  });
});

describe("hook — sanity helper", () => {
  test("Pricing.load + Policy.load round-trip from fixtures used by the hook", () => {
    writeFileSync(policyPath, POLICY_API);
    const pol = Policy.load(policyPath);
    expect(pol.billing).toBe("api");
    const pri = Pricing.load(pricingPath);
    expect(pri.rate("sonnet", "input")).toBeCloseTo(3.0e-6, 12);
  });
});
