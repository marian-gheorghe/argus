import { describe, expect, test } from "bun:test";
import { ClawhipCheck, type FetchFn } from "../../src/checks/clawhip.ts";
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

describe("ClawhipCheck.check", () => {
  test("HTTP 200 → healthy", async () => {
    const fetchImpl: FetchFn = async () => new Response("ok", { status: 200 });
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(true);
    expect(r.detail).toContain("200");
  });

  test("HTTP 500 → unhealthy", async () => {
    const fetchImpl: FetchFn = async () => new Response("oops", { status: 500 });
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("500");
  });

  test("network throw → unhealthy", async () => {
    const fetchImpl: FetchFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr, fetchImpl });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toContain("ECONNREFUSED");
  });

  test("timeout → unhealthy", async () => {
    // fetch that respects the AbortSignal — never resolves on its own.
    const fetchImpl: FetchFn = async (_url, init) => {
      const sig = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (sig?.aborted) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        sig?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr, fetchImpl, timeoutMs: 50 });
    const r = await c.check();
    expect(r.healthy).toBe(false);
    expect(r.detail).toMatch(/abort|timeout/i);
  });

  test("default url is the local clawhip status endpoint", async () => {
    const seen: string[] = [];
    const fetchImpl: FetchFn = async (url) => {
      seen.push(String(url));
      return new Response("ok", { status: 200 });
    };
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr, fetchImpl });
    await c.check();
    expect(seen[0]).toBe("http://127.0.0.1:25294/status");
  });
});

describe("ClawhipCheck.restart", () => {
  test("delegates to service manager with com.argus.clawhip label", async () => {
    const { mgr, calls, setNext } = mockServiceManager();
    setNext(true, "kickstarted com.argus.clawhip");
    const c = new ClawhipCheck({
      serviceManager: mgr,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["com.argus.clawhip"]);
  });

  test("propagates restart failure", async () => {
    const { mgr, setNext } = mockServiceManager();
    setNext(false, "no such service");
    const c = new ClawhipCheck({
      serviceManager: mgr,
      fetchImpl: async () => new Response("ok", { status: 200 }),
    });
    const r = await c.restart();
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no such service");
  });
});

describe("ClawhipCheck", () => {
  test("name is stable", () => {
    const { mgr } = mockServiceManager();
    const c = new ClawhipCheck({ serviceManager: mgr });
    expect(c.name).toBe("clawhip");
  });
});
