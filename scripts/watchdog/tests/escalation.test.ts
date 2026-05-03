import { describe, expect, test } from "bun:test";
import pino from "pino";
import type { Check } from "../src/check.ts";
import {
  type DeadMan,
  Escalator,
  MockDeadMan,
  OMCNativeCallbackDeadMan,
} from "../src/escalation.ts";

const silentLog = pino({ level: "silent" });

function mockCheck(opts: {
  name: string;
  restart: () => Promise<{ ok: boolean; detail: string }>;
}): Check & { restartCalls: number } {
  let restartCalls = 0;
  const c: Check & { restartCalls: number } = {
    name: opts.name,
    restartCalls: 0,
    check: async () => ({ healthy: true, detail: "stub" }),
    restart: async () => {
      restartCalls += 1;
      c.restartCalls = restartCalls;
      return opts.restart();
    },
  };
  return c;
}

describe("Escalator", () => {
  test("counter < threshold → throttled (no restart, no dead-man)", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({ name: "x", restart: async () => ({ ok: true, detail: "ok" }) });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    const r = await e.escalate(c, 1, 2);
    expect(r.action).toBe("throttled");
    expect(c.restartCalls).toBe(0);
    expect(dm.calls).toHaveLength(0);
  });

  test("counter >= threshold → restart attempted; success → action=restarted", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({ name: "x", restart: async () => ({ ok: true, detail: "kicked" }) });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    const r = await e.escalate(c, 2, 2);
    expect(r.action).toBe("restarted");
    expect(c.restartCalls).toBe(1);
    expect(dm.calls).toHaveLength(0);
  });

  test("restart fails → emits dead-man with critical event", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({ name: "clawhip", restart: async () => ({ ok: false, detail: "boom" }) });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    const r = await e.escalate(c, 2, 2);
    expect(r.action).toBe("dead-man");
    expect(c.restartCalls).toBe(1);
    expect(dm.calls).toHaveLength(1);
    const call = dm.calls[0];
    if (!call) throw new Error("expected dm call");
    expect(call.event).toBe("clawhip.dead-man");
    expect(call.message).toContain("clawhip");
    expect(call.payload).toMatchObject({ check: "clawhip", restart_detail: "boom" });
  });

  test("second escalate within cooldown → throttled even at threshold", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({ name: "x", restart: async () => ({ ok: true, detail: "kicked" }) });
    let now = 1_000_000;
    const e = new Escalator({
      deadman: dm,
      log: silentLog,
      restartCooldownMs: 60_000,
      now: () => now,
    });
    const r1 = await e.escalate(c, 2, 2);
    expect(r1.action).toBe("restarted");
    // 30s later, still < 60s cooldown
    now += 30_000;
    const r2 = await e.escalate(c, 3, 2);
    expect(r2.action).toBe("throttled");
    expect(c.restartCalls).toBe(1);
  });

  test("after cooldown, a second restart is allowed", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({ name: "x", restart: async () => ({ ok: true, detail: "kicked" }) });
    let now = 1_000_000;
    const e = new Escalator({
      deadman: dm,
      log: silentLog,
      restartCooldownMs: 60_000,
      now: () => now,
    });
    const r1 = await e.escalate(c, 2, 2);
    expect(r1.action).toBe("restarted");
    now += 90_000; // > cooldown
    const r2 = await e.escalate(c, 3, 2);
    expect(r2.action).toBe("restarted");
    expect(c.restartCalls).toBe(2);
  });

  test("cooldown is per-check, not global", async () => {
    const dm = new MockDeadMan();
    const a = mockCheck({ name: "a", restart: async () => ({ ok: true, detail: "ok" }) });
    const b = mockCheck({ name: "b", restart: async () => ({ ok: true, detail: "ok" }) });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    const r1 = await e.escalate(a, 2, 2);
    const r2 = await e.escalate(b, 2, 2);
    expect(r1.action).toBe("restarted");
    expect(r2.action).toBe("restarted");
  });

  test("restart throw is captured and treated as failed → dead-man", async () => {
    const dm = new MockDeadMan();
    const c = mockCheck({
      name: "x",
      restart: async () => {
        throw new Error("kaboom");
      },
    });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    const r = await e.escalate(c, 2, 2);
    expect(r.action).toBe("dead-man");
    expect(dm.calls).toHaveLength(1);
    const call = dm.calls[0];
    if (!call) throw new Error("expected dm call");
    expect(call.payload).toMatchObject({ restart_detail: expect.stringContaining("kaboom") });
  });

  test("dead-man emit failure does NOT throw out of escalate", async () => {
    const dm: DeadMan = {
      emit: async () => {
        throw new Error("dead-man channel down too");
      },
    };
    const c = mockCheck({ name: "x", restart: async () => ({ ok: false, detail: "boom" }) });
    const e = new Escalator({ deadman: dm, log: silentLog, restartCooldownMs: 60_000 });
    // Should resolve, not throw — the escalator is a last-resort path.
    const r = await e.escalate(c, 2, 2);
    expect(r.action).toBe("dead-man");
    expect(r.detail).toMatch(/dead-man emit failed/i);
  });
});

describe("MockDeadMan", () => {
  test("records emit calls", async () => {
    const dm = new MockDeadMan();
    await dm.emit("e1", "hello", { a: 1 });
    expect(dm.calls).toEqual([{ event: "e1", message: "hello", payload: { a: 1 } }]);
  });

  test("failNext makes the next emit reject", async () => {
    const dm = new MockDeadMan();
    dm.failNext("nope");
    await expect(dm.emit("e1", "x")).rejects.toThrow("nope");
    // Recovery: subsequent emits succeed.
    await dm.emit("e2", "y");
    expect(dm.calls).toHaveLength(1);
  });
});

describe("OMCNativeCallbackDeadMan", () => {
  test("invokes omc emit with critical tier and event/message args", async () => {
    const seen: string[][] = [];
    const dm = new OMCNativeCallbackDeadMan({
      omcBin: "omc",
      spawn: async (cmd) => {
        seen.push(cmd);
        return { exitCode: 0, stderr: "" };
      },
    });
    await dm.emit("clawhip.dead-man", "down", { check: "clawhip" });
    expect(seen).toHaveLength(1);
    const c = seen[0];
    if (!c) throw new Error("expected call");
    expect(c[0]).toBe("omc");
    expect(c).toContain("emit");
    expect(c).toContain("--tier");
    expect(c).toContain("critical");
    expect(c).toContain("--event");
    expect(c).toContain("clawhip.dead-man");
    expect(c).toContain("--message");
    expect(c).toContain("down");
    // Payload is JSON-encoded and passed via --payload-json (or stdin).
    const flagIdx = c.indexOf("--payload-json");
    expect(flagIdx).toBeGreaterThan(-1);
    const payloadStr = c[flagIdx + 1];
    expect(payloadStr).toBeDefined();
    expect(JSON.parse(String(payloadStr))).toEqual({ check: "clawhip" });
  });

  test("throws on non-zero exit so caller can fall back", async () => {
    const dm = new OMCNativeCallbackDeadMan({
      omcBin: "omc",
      spawn: async () => ({ exitCode: 7, stderr: "auth missing" }),
    });
    await expect(dm.emit("e", "x")).rejects.toThrow(/auth missing|exit=7/);
  });
});
