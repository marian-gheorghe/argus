import { describe, expect, test } from "bun:test";
import { OmcWaitCheck } from "../../src/checks/omc-wait.ts";
import type { ServiceManager, SpawnFn } from "../../src/platform.ts";

function mockServiceManager(): {
  mgr: ServiceManager;
  calls: string[];
  setNext: (ok: boolean, detail: string) => void;
} {
  const calls: string[] = [];
  let next = { ok: true, detail: "ok" };
  const mgr: ServiceManager = {
    restart: async (label) => {
      calls.push(label);
      return next;
    },
  };
  return {
    mgr,
    calls,
    setNext: (ok, detail) => {
      next = { ok, detail };
    },
  };
}

describe("OmcWaitCheck.check", () => {
  test("pgrep exit 0 → healthy", async () => {
    const seen: string[][] = [];
    const spawn: SpawnFn = async (cmd) => {
      seen.push(cmd);
      return { exitCode: 0, stderr: "" };
    };
    const { mgr } = mockServiceManager();
    const c = new OmcWaitCheck({ serviceManager: mgr, spawn });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(seen[0]).toEqual(["pgrep", "-f", "omc wait"]);
  });

  test("pgrep exit 1 (no match) → unhealthy", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 1, stderr: "" });
    const { mgr } = mockServiceManager();
    const c = new OmcWaitCheck({ serviceManager: mgr, spawn });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("not running");
  });

  test("pgrep exit 2+ (error) → unhealthy with stderr", async () => {
    const spawn: SpawnFn = async () => ({ exitCode: 2, stderr: "syntax error" });
    const { mgr } = mockServiceManager();
    const c = new OmcWaitCheck({ serviceManager: mgr, spawn });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("syntax error");
  });

  test("spawn throw → unhealthy", async () => {
    const spawn: SpawnFn = async () => {
      throw new Error("ENOENT pgrep");
    };
    const { mgr } = mockServiceManager();
    const c = new OmcWaitCheck({ serviceManager: mgr, spawn });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("ENOENT");
  });
});

describe("OmcWaitCheck.restart", () => {
  test("delegates to service manager with com.argus.omc-wait label", async () => {
    const { mgr, calls } = mockServiceManager();
    const c = new OmcWaitCheck({
      serviceManager: mgr,
      spawn: async () => ({ exitCode: 0, stderr: "" }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["com.argus.omc-wait"]);
  });

  test("propagates restart failure", async () => {
    const { mgr, setNext } = mockServiceManager();
    setNext(false, "broken");
    const c = new OmcWaitCheck({
      serviceManager: mgr,
      spawn: async () => ({ exitCode: 0, stderr: "" }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("broken");
  });
});

describe("OmcWaitCheck", () => {
  test("name is stable", () => {
    const { mgr } = mockServiceManager();
    const c = new OmcWaitCheck({ serviceManager: mgr });
    expect(c.name).toBe("omc-wait");
  });
});
