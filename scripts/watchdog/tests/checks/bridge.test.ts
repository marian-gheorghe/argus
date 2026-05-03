import { describe, expect, test } from "bun:test";
import { BridgeCheck, type FetchFn } from "../../src/checks/bridge.ts";
import type { ServiceManager } from "../../src/platform.ts";

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

describe("BridgeCheck.check", () => {
  test("HTTP 200 → healthy", async () => {
    const fetchImpl: FetchFn = async () => new Response('{"ok":true}', { status: 200 });
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(r.detail).toContain("200");
  });

  test("HTTP 503 → unhealthy", async () => {
    const fetchImpl: FetchFn = async () => new Response("queue locked", { status: 503 });
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(false);
  });

  test("network throw → unhealthy", async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });

  test("timeout → unhealthy", async () => {
    const fetchImpl: FetchFn = async (_url, init) => {
      const sig = init?.signal;
      return await new Promise<Response>((_r, reject) => {
        sig?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    };
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr, fetchImpl, timeoutMs: 30 });
    const r = await c.check();
    expect(r.healthy).toBe(false);
  });

  test("default url is the bridge health endpoint", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchFn = async (url) => {
      seen.push(String(url));
      return new Response("ok", { status: 200 });
    };
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr, fetchImpl });
    await c.check();
    expect(seen[0]).toBe("http://127.0.0.1:9501/health");
  });
});

describe("BridgeCheck.restart", () => {
  test("delegates to service manager with com.argus.telegram-bridge label", async () => {
    const { mgr, calls } = mockServiceManager();
    const c = new BridgeCheck({
      serviceManager: mgr,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["com.argus.telegram-bridge"]);
  });

  test("propagates restart failure", async () => {
    const { mgr, setNext } = mockServiceManager();
    setNext(false, "denied");
    const c = new BridgeCheck({
      serviceManager: mgr,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("denied");
  });
});

describe("BridgeCheck", () => {
  test("name is stable", () => {
    const { mgr } = mockServiceManager();
    const c = new BridgeCheck({ serviceManager: mgr });
    expect(c.name).toBe("bridge");
  });
});
