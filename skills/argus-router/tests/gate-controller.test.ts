import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GateController } from "../lib/gate-controller.ts";
import {
  type ClawhipEmitPayload,
  GateDecision as GateDecisionSchema,
  GatePending as GatePendingSchema,
} from "../lib/gate-types.ts";

let tmpDir: string;
let gatesDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-router-"));
  gatesDir = join(tmpDir, "gates");
  mkdirSync(gatesDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeMockEmit(): {
  emit: (e: ClawhipEmitPayload) => void;
  calls: ClawhipEmitPayload[];
} {
  const calls: ClawhipEmitPayload[] = [];
  return {
    emit: (e) => {
      calls.push(e);
    },
    calls,
  };
}

describe("GateController.openGate", () => {
  test("writes a valid <gate-id>.pending.json that parses against GatePending", async () => {
    const ctrl = new GateController();
    const { emit, calls } = makeMockEmit();
    const result = await ctrl.openGate({
      type: "PRD",
      run_id: "run_abc",
      title: "Phase 1 PRD",
      summary: "Stripe payments service",
      key_decisions: ["Stripe SDK v15"],
      artifact_path: "/tmp/prd.md",
      gatesDir,
      clawhipEmit: emit,
    });
    expect(result.gate_id).toMatch(/^PRD-run_abc-[a-f0-9]{6}$/);
    expect(result.pending_path).toBe(join(gatesDir, `${result.gate_id}.pending.json`));
    const raw = readFileSync(result.pending_path, "utf8");
    const parsed = GatePendingSchema.parse(JSON.parse(raw));
    expect(parsed.gate_id).toBe(result.gate_id);
    expect(parsed.run_id).toBe("run_abc");
    expect(parsed.type).toBe("PRD");
    expect(parsed.title).toBe("Phase 1 PRD");
    expect(parsed.summary).toBe("Stripe payments service");
    expect(parsed.key_decisions).toEqual(["Stripe SDK v15"]);
    expect(parsed.artifact_path).toBe("/tmp/prd.md");
    expect(typeof parsed.created_at).toBe("string");
    expect(typeof parsed.timeout_at).toBe("string");
    // Default timeout = 8h
    const created = Date.parse(parsed.created_at);
    const expires = Date.parse(parsed.timeout_at);
    expect(expires - created).toBeCloseTo(28800 * 1000, -3); // within ~1s
    expect(calls).toHaveLength(1);
  });

  test("calls injected clawhipEmit with gate.pending event payload", async () => {
    const ctrl = new GateController();
    const { emit, calls } = makeMockEmit();
    const { gate_id } = await ctrl.openGate({
      type: "code-review",
      run_id: "run_xyz",
      title: "Phase 2 code review",
      summary: "Three endpoints implemented",
      artifact_path: "/tmp/diff.patch",
      diff_url: "https://example.com/pr/42",
      gatesDir,
      clawhipEmit: emit,
    });
    expect(calls).toHaveLength(1);
    const evt = calls[0];
    expect(evt).toBeDefined();
    if (!evt) throw new Error("expected emit call");
    expect(evt.event).toBe("gate.pending");
    expect(evt.severity).toBe("info");
    expect(evt.payload.gate_id).toBe(gate_id);
    expect(evt.payload.run_id).toBe("run_xyz");
    expect(evt.payload.diff_url).toBe("https://example.com/pr/42");
    expect(evt.payload.event_id).toBe(`gate.pending:${gate_id}`);
  });

  test("returns unique gate_ids across calls (short-sha collision guard)", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    const ids = new Set<string>();
    for (let i = 0; i < 25; i++) {
      const r = await ctrl.openGate({
        type: "PRD",
        run_id: "run_same",
        title: "t",
        summary: "s",
        artifact_path: "/tmp/x",
        gatesDir,
        clawhipEmit: emit,
      });
      ids.add(r.gate_id);
    }
    expect(ids.size).toBe(25);
  });

  test("file mode is 0600 (operator comments can carry sensitive context)", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    const { pending_path } = await ctrl.openGate({
      type: "PRD",
      run_id: "run_perms",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      gatesDir,
      clawhipEmit: emit,
    });
    const mode = statSync(pending_path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  test("atomic write leaves no .tmp.<pid> artifacts behind", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    await ctrl.openGate({
      type: "PRD",
      run_id: "run_atomic",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      gatesDir,
      clawhipEmit: emit,
    });
    const entries = readdirSync(gatesDir);
    for (const e of entries) {
      expect(e).not.toContain(".tmp.");
    }
  });

  test("clawhipEmit set to null skips clawhip emission (file-watcher path still works)", async () => {
    const ctrl = new GateController();
    // null = don't try to shell out, don't call any emitter
    const { pending_path } = await ctrl.openGate({
      type: "PRD",
      run_id: "run_no_emit",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      gatesDir,
      clawhipEmit: null,
    });
    // The pending file MUST still exist — that's the durable path the bridge
    // file-watcher picks up even when clawhip is unavailable.
    expect(existsSync(pending_path)).toBe(true);
  });

  test("custom timeout_secs is reflected in timeout_at", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    const { pending_path } = await ctrl.openGate({
      type: "PRD",
      run_id: "run_timeout",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 60,
      gatesDir,
      clawhipEmit: emit,
    });
    const parsed = GatePendingSchema.parse(JSON.parse(readFileSync(pending_path, "utf8")));
    const delta = Date.parse(parsed.timeout_at) - Date.parse(parsed.created_at);
    expect(delta).toBeCloseTo(60 * 1000, -2);
  });
});

describe("GateController.awaitDecision", () => {
  test("returns the decision when the file appears mid-poll", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    const opened = await ctrl.openGate({
      type: "PRD",
      run_id: "run_await",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 60,
      gatesDir,
      clawhipEmit: emit,
    });
    // Simulate the bridge writing the decision after 100ms.
    setTimeout(() => {
      const decision = {
        gate_id: opened.gate_id,
        run_id: "run_await",
        decision: "approved" as const,
        decided_at: new Date().toISOString(),
        decided_by_chat_id: 12345,
      };
      writeFileSync(join(gatesDir, `${opened.gate_id}.decision.json`), JSON.stringify(decision));
    }, 100);
    const result = await ctrl.awaitDecision({
      gate_id: opened.gate_id,
      pending_path: opened.pending_path,
      pollIntervalMs: 50,
      gatesDir,
      clawhipEmit: emit,
    });
    expect(result.decision).toBe("approved");
    expect(result.gate_id).toBe(opened.gate_id);
    if (result.decision !== "timeout") {
      expect(result.run_id).toBe("run_await");
    }
  });

  test("returns timeout + emits gate.timeout when wall-clock deadline elapses", async () => {
    const ctrl = new GateController();
    const { emit, calls } = makeMockEmit();
    const opened = await ctrl.openGate({
      type: "PRD",
      run_id: "run_timeout_path",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 1, // 1 second timeout
      gatesDir,
      clawhipEmit: emit,
    });
    expect(calls).toHaveLength(1); // gate.pending
    const result = await ctrl.awaitDecision({
      gate_id: opened.gate_id,
      pending_path: opened.pending_path,
      pollIntervalMs: 50,
      gatesDir,
      clawhipEmit: emit,
    });
    expect(result.decision).toBe("timeout");
    expect(result.gate_id).toBe(opened.gate_id);
    expect(calls).toHaveLength(2);
    const timeoutCall = calls[1];
    expect(timeoutCall).toBeDefined();
    if (!timeoutCall) throw new Error("expected timeout emit call");
    expect(timeoutCall.event).toBe("gate.timeout");
    expect(timeoutCall.severity).toBe("page");
    expect(timeoutCall.payload.gate_id).toBe(opened.gate_id);
  });

  test("honors AbortSignal — exits cleanly without further work", async () => {
    const ctrl = new GateController();
    const { emit, calls } = makeMockEmit();
    const opened = await ctrl.openGate({
      type: "PRD",
      run_id: "run_abort",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 60,
      gatesDir,
      clawhipEmit: emit,
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 80);
    const startCalls = calls.length;
    await expect(
      ctrl.awaitDecision({
        gate_id: opened.gate_id,
        pending_path: opened.pending_path,
        pollIntervalMs: 50,
        gatesDir,
        clawhipEmit: emit,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/abort/i);
    // No timeout event should have fired (we aborted before deadline).
    expect(calls.length).toBe(startCalls);
  });

  test("rejected decision with comment round-trips intact", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    const opened = await ctrl.openGate({
      type: "code-review",
      run_id: "run_rej",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 60,
      gatesDir,
      clawhipEmit: emit,
    });
    setTimeout(() => {
      const decision = {
        gate_id: opened.gate_id,
        run_id: "run_rej",
        decision: "rejected" as const,
        comment: "wrong dependency injection pattern",
        decided_at: new Date().toISOString(),
      };
      writeFileSync(join(gatesDir, `${opened.gate_id}.decision.json`), JSON.stringify(decision));
    }, 50);
    const result = await ctrl.awaitDecision({
      gate_id: opened.gate_id,
      pending_path: opened.pending_path,
      pollIntervalMs: 25,
      gatesDir,
      clawhipEmit: emit,
    });
    expect(result.decision).toBe("rejected");
    if (result.decision === "rejected") {
      expect(result.comment).toBe("wrong dependency injection pattern");
    }
  });
});

describe("GateController.fireGate", () => {
  test("happy path: open + await + return decision", async () => {
    const ctrl = new GateController();
    const { emit } = makeMockEmit();
    // Pre-arrange: write decision file *after* fireGate starts. Use a small
    // poll interval so the test runs fast.
    const watchAndWrite = async () => {
      // Wait for a pending file to appear, then write the matching decision.
      for (let i = 0; i < 200; i++) {
        const entries = readdirSync(gatesDir);
        const pending = entries.find((e) => e.endsWith(".pending.json"));
        if (pending) {
          const gate_id = pending.replace(".pending.json", "");
          const decision = {
            gate_id,
            run_id: "run_fire",
            decision: "deferred" as const,
            comment: "ask again in 4h",
            decided_at: new Date().toISOString(),
          };
          writeFileSync(join(gatesDir, `${gate_id}.decision.json`), JSON.stringify(decision));
          return;
        }
        await wait(20);
      }
    };
    const writePromise = watchAndWrite();
    const result = await ctrl.fireGate({
      type: "PRD",
      run_id: "run_fire",
      title: "t",
      summary: "s",
      artifact_path: "/tmp/x",
      timeout_secs: 30,
      pollIntervalMs: 25,
      gatesDir,
      clawhipEmit: emit,
    });
    await writePromise;
    expect(result.decision).toBe("deferred");
    if (result.decision === "deferred") {
      expect(result.comment).toBe("ask again in 4h");
    }
  });
});

describe("GateController.createSpeculativeBranch", () => {
  test("creates speculative/<run_id>/<gate_id> in a fresh git repo", async () => {
    const repo = mkdirSync(join(tmpDir, "repo"), { recursive: true });
    const repoDir = repo as string;
    // Initialize git repo with a commit.
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "test@test.test"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "hi");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: repoDir });

    const ctrl = new GateController();
    const r1 = await ctrl.createSpeculativeBranch({
      run_id: "run_xyz",
      gate_id: "PRD-run_xyz-abc123",
      gitCwd: repoDir,
    });
    expect(r1.branch_name).toBe("speculative/run_xyz/PRD-run_xyz-abc123");
    expect(r1.created).toBe(true);

    // Verify branch exists.
    const verify = Bun.spawnSync(["git", "branch", "--list", r1.branch_name], { cwd: repoDir });
    expect(verify.exitCode).toBe(0);
    expect(new TextDecoder().decode(verify.stdout)).toContain(r1.branch_name);
  });

  test("idempotent: second call with same args is a no-op", async () => {
    const repoDir = join(tmpDir, "repo2");
    mkdirSync(repoDir, { recursive: true });
    Bun.spawnSync(["git", "init", "-q", "-b", "main"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.email", "test@test.test"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: repoDir });
    Bun.spawnSync(["git", "config", "commit.gpgsign", "false"], { cwd: repoDir });
    writeFileSync(join(repoDir, "README.md"), "hi");
    Bun.spawnSync(["git", "add", "."], { cwd: repoDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "init"], { cwd: repoDir });

    const ctrl = new GateController();
    const r1 = await ctrl.createSpeculativeBranch({
      run_id: "run_idem",
      gate_id: "PRD-run_idem-xx0001",
      gitCwd: repoDir,
    });
    expect(r1.created).toBe(true);
    const r2 = await ctrl.createSpeculativeBranch({
      run_id: "run_idem",
      gate_id: "PRD-run_idem-xx0001",
      gitCwd: repoDir,
    });
    expect(r2.created).toBe(false);
    expect(r2.branch_name).toBe(r1.branch_name);
  });
});

describe("GateController — schema sanity", () => {
  test("emitted clawhip payload contains GatePending fields the bridge needs", async () => {
    const ctrl = new GateController();
    const { emit, calls } = makeMockEmit();
    await ctrl.openGate({
      type: "final-integration",
      run_id: "run_inspect",
      title: "Final integration gate",
      summary: "All phases complete",
      key_decisions: ["merge to main"],
      artifact_path: "/tmp/final.md",
      diff_url: "https://example.com/pr/99",
      gatesDir,
      clawhipEmit: emit,
    });
    const evt = calls[0];
    expect(evt).toBeDefined();
    if (!evt) throw new Error("expected emit call");
    // The pending JSON we wrote must validate as GatePending.
    const file = readdirSync(gatesDir).find((e) => e.endsWith(".pending.json"));
    expect(file).toBeDefined();
    if (!file) throw new Error("expected pending file");
    const pending = GatePendingSchema.parse(JSON.parse(readFileSync(join(gatesDir, file), "utf8")));
    expect(pending.diff_url).toBe("https://example.com/pr/99");
    // The clawhip payload mirrors the bridge-side GateWatcher's gateToClawhip
    // shape: it carries enough context that the bridge (or the file-watcher
    // path) can render the same message either way.
    expect(evt.payload.gate_id).toBe(pending.gate_id);
    expect(evt.payload.run_id).toBe(pending.run_id);
    expect(evt.payload.summary).toBe(pending.summary);
    expect(evt.payload.artifact_path).toBe(pending.artifact_path);
    expect(evt.payload.timeout_at).toBe(pending.timeout_at);
  });

  test("written decision file (when present) validates against GateDecision", async () => {
    // Confirms the contract: if the bridge writes a valid file, our parser accepts it.
    const decision = {
      gate_id: "PRD-run_x-aaaaaa",
      run_id: "run_x",
      decision: "approved" as const,
      decided_at: new Date().toISOString(),
    };
    writeFileSync(join(gatesDir, `${decision.gate_id}.decision.json`), JSON.stringify(decision));
    const raw = readFileSync(join(gatesDir, `${decision.gate_id}.decision.json`), "utf8");
    const parsed = GateDecisionSchema.parse(JSON.parse(raw));
    expect(parsed.decision).toBe("approved");
  });
});
