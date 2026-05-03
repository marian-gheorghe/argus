import { describe, expect, test } from "bun:test";
import { ClawhipEmitter, MockEmitter } from "../src/emit.ts";

describe("MockEmitter", () => {
  test("records emit calls in order", async () => {
    const m = new MockEmitter();
    await m.emit("cost.warn", { run_id: "r1", spent: 38 });
    await m.emit("cost.page", { run_id: "r1", spent: 50 });
    expect(m.calls).toHaveLength(2);
    expect(m.calls[0]).toEqual({ event: "cost.warn", payload: { run_id: "r1", spent: 38 } });
    expect(m.calls[1]).toEqual({ event: "cost.page", payload: { run_id: "r1", spent: 50 } });
  });

  test("can be configured to throw on next call (for crash-resistance tests)", async () => {
    const m = new MockEmitter();
    m.failNext("simulated network blip");
    await expect(m.emit("cost.warn", {})).rejects.toThrow("simulated network blip");
    // After the failure consumed, subsequent calls succeed.
    await m.emit("cost.warn", { ok: true });
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.payload).toEqual({ ok: true });
  });
});

describe("ClawhipEmitter", () => {
  test("invokes the injected spawner with the right argv and stdin payload", async () => {
    type SpawnArgs = { cmd: string[]; stdin: string };
    const captured: SpawnArgs[] = [];
    const fakeSpawn = async (cmd: string[], stdin: string) => {
      captured.push({ cmd, stdin });
      return { exitCode: 0, stderr: "" };
    };
    const e = new ClawhipEmitter({ spawn: fakeSpawn, clawhipBin: "clawhip" });
    await e.emit("cost.warn", { run_id: "r1", spent: 38, ceiling: 50 });
    expect(captured).toHaveLength(1);
    const args = captured[0];
    expect(args).toBeDefined();
    if (args) {
      expect(args.cmd).toEqual([
        "clawhip",
        "send",
        "--event",
        "cost.warn",
        "--severity",
        "warn",
        "--stdin-json",
      ]);
      const parsed = JSON.parse(args.stdin);
      expect(parsed.run_id).toBe("r1");
      expect(parsed.spent).toBe(38);
      expect(parsed.event_id).toBeDefined();
    }
  });

  test("uses severity 'page' for cost.page and 'critical' for cost.kill", async () => {
    const captured: string[] = [];
    const fakeSpawn = async (cmd: string[], _stdin: string) => {
      // severity is right after "--severity"
      const i = cmd.indexOf("--severity");
      const sev = i >= 0 ? cmd[i + 1] : "?";
      captured.push(sev ?? "?");
      return { exitCode: 0, stderr: "" };
    };
    const e = new ClawhipEmitter({ spawn: fakeSpawn, clawhipBin: "clawhip" });
    await e.emit("cost.warn", { run_id: "r1" });
    await e.emit("cost.page", { run_id: "r1" });
    await e.emit("cost.kill", { run_id: "r1" });
    expect(captured).toEqual(["warn", "page", "critical"]);
  });

  test("throws when clawhip exits non-zero so caller can choose to log", async () => {
    const fakeSpawn = async (_cmd: string[], _stdin: string) => ({
      exitCode: 1,
      stderr: "clawhip: route not configured",
    });
    const e = new ClawhipEmitter({ spawn: fakeSpawn, clawhipBin: "clawhip" });
    await expect(e.emit("cost.warn", {})).rejects.toThrow(/route not configured|exit/i);
  });

  test("includes a deterministic event_id derived from run_id + level for dedup", async () => {
    let captured = "";
    const fakeSpawn = async (_cmd: string[], stdin: string) => {
      captured = stdin;
      return { exitCode: 0, stderr: "" };
    };
    const e = new ClawhipEmitter({ spawn: fakeSpawn, clawhipBin: "clawhip" });
    await e.emit("cost.warn", { run_id: "abc-123", spent: 10, ceiling: 50 });
    const parsed1 = JSON.parse(captured);
    await e.emit("cost.warn", { run_id: "abc-123", spent: 99, ceiling: 50 });
    const parsed2 = JSON.parse(captured);
    // Same run + level => same event_id (so a re-emit, however unlikely, dedups
    // at clawhip's webhook layer too — defence in depth past markEmitted).
    expect(parsed1.event_id).toBe(parsed2.event_id);
    expect(parsed1.event_id).toBe("cost.warn:abc-123");
  });

  test("payload missing run_id falls back to a stable but unique event_id", async () => {
    let captured = "";
    const fakeSpawn = async (_cmd: string[], stdin: string) => {
      captured = stdin;
      return { exitCode: 0, stderr: "" };
    };
    const e = new ClawhipEmitter({ spawn: fakeSpawn, clawhipBin: "clawhip" });
    await e.emit("cost.warn", { spent: 10 });
    const parsed = JSON.parse(captured);
    expect(parsed.event_id).toBeDefined();
    expect(typeof parsed.event_id).toBe("string");
  });
});
