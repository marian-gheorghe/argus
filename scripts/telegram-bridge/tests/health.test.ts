import { describe, expect, test } from "bun:test";
import { app } from "../src/index.ts";

describe("/health endpoint", () => {
  test("returns ok status", async () => {
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
