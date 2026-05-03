import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MockEmitter } from "../src/emit.ts";
import { ManifestStore, type RunManifest } from "../src/manifest.ts";
import { type ProviderFallbackDeps, runProviderFallback } from "../src/provider-fallback.ts";

let stateDir: string;
let argusDir: string;
let store: ManifestStore;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "argus-pf-state-"));
  argusDir = mkdtempSync(join(tmpdir(), "argus-pf-cred-"));
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

function seedSecrets(opts: { max20?: boolean; api?: boolean }): void {
  const lines: string[] = [];
  if (opts.max20) lines.push('CLAUDE_CODE_OAUTH_TOKEN="t-max20"');
  if (opts.api) lines.push('ANTHROPIC_API_KEY="sk-ant-api"');
  writeFileSync(join(argusDir, "secrets.env"), lines.join("\n"), "utf8");
}

const NOW = new Date("2026-05-03T12:30:00.000Z");
function deps(args?: Partial<ProviderFallbackDeps>): ProviderFallbackDeps {
  return {
    env: { OMC_CURRENT_RUN_ID: "run-pf" },
    stateDir,
    argusDir,
    emitter: new MockEmitter(),
    stderr: () => undefined,
    now: () => NOW,
    pageAfterMs: 2 * 60 * 60 * 1000,
    ...args,
  };
}

describe("runProviderFallback", () => {
  test("max20 -> api when in api mode and Max20 creds present", async () => {
    seedRun("run-pf", { provider_mode: "api" });
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(deps({ emitter }));
    expect(code).toBe(0);
    const m = store.read("run-pf");
    expect(m?.provider_mode).toBe("max20");
    expect(m?.provider_outage_started_at).toBe(NOW.toISOString());
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("provider.fallback-engaged");
    expect(emitter.calls[0]?.severity).toBe("warn");
    expect(emitter.calls[0]?.payload.new_mode).toBe("max20");
    // override file written
    const overridePath = join(stateDir, "provider-override.env");
    expect(existsSync(overridePath)).toBe(true);
    const content = readFileSync(overridePath, "utf8");
    expect(content).toContain("ARGUS_PROVIDER=max20");
  });

  test("api -> max20: switch when in max20 mode and API key present", async () => {
    seedRun("run-pf", { provider_mode: "max20" });
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(deps({ emitter }));
    expect(code).toBe(0);
    const m = store.read("run-pf");
    expect(m?.provider_mode).toBe("api");
    expect(emitter.calls[0]?.payload.new_mode).toBe("api");
  });

  test("no fallback creds available: emit warn but cannot toggle", async () => {
    seedRun("run-pf", { provider_mode: "max20" });
    // ONLY max20 creds; no api fallback
    seedSecrets({ max20: true, api: false });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(deps({ emitter }));
    expect(code).toBe(0);
    const m = store.read("run-pf");
    expect(m?.provider_mode).toBe("max20"); // unchanged
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("provider.fallback-unavailable");
    expect(emitter.calls[0]?.severity).toBe("page");
  });

  test("missing secrets.env: warn but no crash", async () => {
    seedRun("run-pf");
    const emitter = new MockEmitter();
    const stderr: string[] = [];
    const code = await runProviderFallback(deps({ emitter, stderr: (s) => stderr.push(s) }));
    expect(code).toBe(0);
    expect(emitter.calls).toHaveLength(1);
    expect(emitter.calls[0]?.event).toBe("provider.fallback-unavailable");
  });

  test("idempotent: second call when outage already engaged + same mode does not re-emit fallback", async () => {
    seedRun("run-pf", {
      provider_mode: "api",
      provider_outage_started_at: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();

    await runProviderFallback(deps({ emitter }));
    // First call switches api -> max20
    const after1 = store.read("run-pf");
    expect(after1?.provider_mode).toBe("max20");

    await runProviderFallback(deps({ emitter }));
    // Second call: already in max20, but api creds still exist -> would switch
    // back. We expect the function to detect this is a flap and stay put OR
    // toggle back if outage continues. The simpler design: it toggles to the
    // OTHER mode. So second call goes max20 -> api again. We don't want
    // infinite flapping; track via a flap-counter or skip when current mode
    // was set <60s ago. We pin to the latter: do nothing if last switch was
    // within 60s.
    const after2 = store.read("run-pf");
    expect(after2?.provider_mode).toBe("max20"); // no flap
    expect(emitter.calls.filter((c) => c.event === "provider.fallback-engaged")).toHaveLength(1);
  });

  test("after pageAfterMs of continuous outage: emit page even if mode is unchanged", async () => {
    // outage started 3h ago; manifest already in fallback mode (max20) — call
    // should escalate.
    const threeHoursAgo = new Date(NOW.getTime() - 3 * 60 * 60 * 1000).toISOString();
    seedRun("run-pf", {
      provider_mode: "max20",
      provider_outage_started_at: threeHoursAgo,
    });
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(deps({ emitter }));
    expect(code).toBe(0);
    const pageEmits = emitter.calls.filter(
      (c) => c.severity === "page" && c.event === "provider.outage-prolonged",
    );
    expect(pageEmits).toHaveLength(1);
  });

  test("missing manifest: silent no-op", async () => {
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(
      deps({
        env: { OMC_CURRENT_RUN_ID: "run-no-such" },
        emitter,
      }),
    );
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });

  test("no run_id: silent no-op", async () => {
    seedSecrets({ max20: true, api: true });
    const emitter = new MockEmitter();
    const code = await runProviderFallback(deps({ env: {}, emitter }));
    expect(code).toBe(0);
    expect(emitter.calls).toEqual([]);
  });
});
