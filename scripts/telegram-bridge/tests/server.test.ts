import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OutboundQueue } from "../src/queue.ts";
import { buildApp } from "../src/server.ts";

// Silent logger so tests don't pollute stdout.
const silentLog = pino({ level: "silent" });

let tmpDir: string;
let dbPath: string;
let queue: OutboundQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-server-"));
  dbPath = join(tmpDir, "queue.sqlite");
  queue = new OutboundQueue(dbPath);
});

afterEach(() => {
  queue.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const validInfoEvent = {
  event_id: "evt_info_1",
  event: "agent.completed",
  severity: "info" as const,
  message: "all done",
};

const validGateEvent = {
  event_id: "evt_gate_1",
  event: "gate.pending",
  severity: "info" as const,
  message: "Gate 1 — PRD approval",
  gate_id: "gate_1",
  run_id: "run_abc",
};

const validCallback = {
  callback_query: {
    id: "cbq_1",
    from: { id: 4242, username: "operator" },
    message: { chat: { id: -100123 }, message_id: 17 },
    data: "gate_1:approve",
  },
};

function jsonRequest(path: string, body: unknown, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

describe("GET /health", () => {
  test("returns ok status from buildApp", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      name: string;
      version: string;
      uptime_secs: number;
    };
    expect(body.status).toBe("ok");
    expect(body.name).toBe("argus-telegram-bridge");
    expect(body.version).toBe("0.1.0");
    expect(typeof body.uptime_secs).toBe("number");
  });
});

describe("POST /webhook/* validation + enqueue", () => {
  test("POST /webhook/info with valid body → 200, accepted, queue depth 1", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/webhook/info", validInfoEvent));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      accepted: boolean;
      queued_id: number;
      deduplicated: boolean;
    };
    expect(body.accepted).toBe(true);
    expect(typeof body.queued_id).toBe("number");
    expect(body.deduplicated).toBe(false);
    expect(queue.depth()).toBe(1);
  });

  test("re-POST same event_id → deduplicated true, queue depth still 1", async () => {
    const app = buildApp({ queue, log: silentLog });
    const r1 = await app.request(jsonRequest("/webhook/info", validInfoEvent));
    expect(r1.status).toBe(200);
    const r2 = await app.request(jsonRequest("/webhook/info", validInfoEvent));
    expect(r2.status).toBe(200);
    const b2 = (await r2.json()) as { deduplicated: boolean; queued_id: number };
    expect(b2.deduplicated).toBe(true);
    expect(queue.depth()).toBe(1);
  });

  test("POST /webhook/info with malformed JSON → 400", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/webhook/info", "{not-json"));
    expect(res.status).toBe(400);
    expect(queue.depth()).toBe(0);
  });

  test("POST /webhook/info missing event_id → 400 with helpful error", async () => {
    const app = buildApp({ queue, log: silentLog });
    const { event_id: _omit, ...rest } = validInfoEvent;
    const res = await app.request(jsonRequest("/webhook/info", rest));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues?: unknown[] };
    expect(body.error).toBeDefined();
    expect(Array.isArray(body.issues)).toBe(true);
    if (Array.isArray(body.issues)) {
      const found = (body.issues as Array<{ path: unknown }>).some(
        (i) => Array.isArray(i.path) && i.path.includes("event_id"),
      );
      expect(found).toBe(true);
    }
    expect(queue.depth()).toBe(0);
  });

  test("POST /webhook/warn tags payload with tier='warn'", async () => {
    const app = buildApp({ queue, log: silentLog });
    const evt = { ...validInfoEvent, event_id: "warn1", severity: "warn" as const };
    const res = await app.request(jsonRequest("/webhook/warn", evt));
    expect(res.status).toBe(200);
    const row = queue.peek();
    expect(row).not.toBeNull();
    if (row) {
      const payload = JSON.parse(row.payload) as { tier?: string; event?: { event_id?: string } };
      expect(payload.tier).toBe("warn");
      expect(payload.event?.event_id).toBe("warn1");
    }
  });

  test("POST /webhook/page tags tier='page'", async () => {
    const app = buildApp({ queue, log: silentLog });
    const evt = { ...validInfoEvent, event_id: "page1", severity: "page" as const };
    const res = await app.request(jsonRequest("/webhook/page", evt));
    expect(res.status).toBe(200);
    const row = queue.peek();
    if (row) {
      const payload = JSON.parse(row.payload) as { tier?: string };
      expect(payload.tier).toBe("page");
    }
  });

  test("POST /webhook/critical tags tier='critical'", async () => {
    const app = buildApp({ queue, log: silentLog });
    const evt = { ...validInfoEvent, event_id: "crit1", severity: "critical" as const };
    const res = await app.request(jsonRequest("/webhook/critical", evt));
    expect(res.status).toBe(200);
    const row = queue.peek();
    if (row) {
      const payload = JSON.parse(row.payload) as { tier?: string };
      expect(payload.tier).toBe("critical");
    }
  });

  test("POST /webhook/gate tags tier='gate'", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/webhook/gate", validGateEvent));
    expect(res.status).toBe(200);
    const row = queue.peek();
    expect(row).not.toBeNull();
    if (row) {
      const payload = JSON.parse(row.payload) as { tier?: string; event?: { gate_id?: string } };
      expect(payload.tier).toBe("gate");
      expect(payload.event?.gate_id).toBe("gate_1");
    }
  });
});

describe("POST /telegram callback validation (Task 6 stub)", () => {
  test("valid TelegramCallbackPayload → 200", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/telegram", validCallback));
    expect(res.status).toBe(200);
  });

  test("malformed body → 400", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/telegram", { wrong: "shape" }));
    expect(res.status).toBe(400);
  });

  test("malformed JSON → 400", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request(jsonRequest("/telegram", "{not-json"));
    expect(res.status).toBe(400);
  });
});

describe("Routing edge cases", () => {
  test("GET on POST endpoint → 405 or 404 (method not allowed)", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request("/webhook/info");
    // Hono returns 404 for unmatched method+path combinations by default.
    expect([404, 405]).toContain(res.status);
  });

  test("unknown path → 404", async () => {
    const app = buildApp({ queue, log: silentLog });
    const res = await app.request("/totally/bogus");
    expect(res.status).toBe(404);
  });
});
