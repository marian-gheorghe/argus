import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OutboundQueue } from "../src/queue.ts";
import { buildApp } from "../src/server.ts";

const silentLog = pino({ level: "silent" });

let tmpDir: string;
let queue: OutboundQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-health-"));
  queue = new OutboundQueue(join(tmpDir, "queue.sqlite"));
});

afterEach(() => {
  queue.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("/health endpoint", () => {
  test("returns ok status", async () => {
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
