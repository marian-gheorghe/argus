import { describe, expect, test } from "bun:test";
import {
  type InlineKeyboard,
  PermanentError,
  TelegramClient,
  TransientError,
} from "../src/telegram.ts";

// --- mock fetch factory ----------------------------------------------------

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function mockFetch(
  responder: (call: CapturedCall) => Response | Promise<Response> | Promise<never>,
): {
  fetch: typeof fetch;
  calls: CapturedCall[];
} {
  const calls: CapturedCall[] = [];
  const impl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers as Record<string, string>;
      for (const k of Object.keys(h)) headers[k] = h[k] as string;
    }
    const rawBody = init?.body;
    const body = typeof rawBody === "string" ? (JSON.parse(rawBody) as unknown) : (rawBody ?? null);
    const call: CapturedCall = {
      url,
      method: (init?.method ?? "GET").toUpperCase(),
      headers,
      body,
    };
    calls.push(call);
    return await responder(call);
  };
  // Bun's `typeof fetch` includes a static `preconnect` member — cast through unknown
  // since our tests never call it.
  return { fetch: impl as unknown as typeof fetch, calls };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const TOKEN = "test-token";
const API_BASE = `https://api.telegram.org/bot${TOKEN}`;

// --- sendMessage: success --------------------------------------------------

describe("TelegramClient.sendMessage", () => {
  test("returns message_id on 200 OK", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 99 } }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    const r = await client.sendMessage(42, "hello");
    expect(r.message_id).toBe(99);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${API_BASE}/sendMessage`);
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
  });

  test("includes parse_mode 'Markdown' in body", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    await client.sendMessage(42, "hi");
    const body = calls[0]?.body as { parse_mode?: string };
    expect(body.parse_mode).toBe("Markdown");
  });

  test("body includes inline_keyboard when keyboard provided", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    const keyboard: InlineKeyboard = {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: "g1:approve" },
          { text: "Reject", callback_data: "g1:reject" },
        ],
      ],
    };
    await client.sendMessage(42, "decision?", keyboard);
    const body = calls[0]?.body as { reply_markup?: InlineKeyboard };
    expect(body.reply_markup).toEqual(keyboard);
  });

  test("body omits reply_markup when no keyboard", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    await client.sendMessage(42, "plain");
    const body = calls[0]?.body as Record<string, unknown>;
    expect("reply_markup" in body).toBe(false);
  });

  test("accepts string chat_id (channel @handle)", async () => {
    const { fetch, calls } = mockFetch(() =>
      jsonResponse(200, { ok: true, result: { message_id: 1 } }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    await client.sendMessage("@channel", "hi");
    const body = calls[0]?.body as { chat_id: unknown };
    expect(body.chat_id).toBe("@channel");
  });
});

// --- sendMessage: transient errors -----------------------------------------

describe("TelegramClient.sendMessage transient errors", () => {
  test("429 with parameters.retry_after → TransientError(retry_after)", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(429, {
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 7 },
      }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    if (caught instanceof TransientError) {
      expect(caught.backoff_secs).toBe(7);
    }
  });

  test("429 without retry_after → TransientError(30) default", async () => {
    const { fetch } = mockFetch(() => jsonResponse(429, { ok: false, description: "rl" }));
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    if (caught instanceof TransientError) expect(caught.backoff_secs).toBe(30);
  });

  test("503 → TransientError(30)", async () => {
    const { fetch } = mockFetch(() => new Response("Service Unavailable", { status: 503 }));
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    if (caught instanceof TransientError) expect(caught.backoff_secs).toBe(30);
  });

  test("500 → TransientError(30)", async () => {
    const { fetch } = mockFetch(() => new Response("oops", { status: 500 }));
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
  });

  test("network throw → TransientError(15) carrying message", async () => {
    const { fetch } = mockFetch(() => {
      return Promise.reject(new Error("dns failure"));
    });
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    if (caught instanceof TransientError) {
      expect(caught.backoff_secs).toBe(15);
      expect(caught.message).toContain("dns failure");
    }
  });
});

// --- sendMessage: permanent errors -----------------------------------------

describe("TelegramClient.sendMessage permanent errors", () => {
  test("401 → PermanentError('invalid bot token')", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(401, { ok: false, description: "Unauthorized" }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermanentError);
    if (caught instanceof PermanentError) {
      expect(caught.message).toContain("invalid bot token");
    }
  });

  test("400 with description → PermanentError carrying description", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(400, { ok: false, description: "chat not found" }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermanentError);
    if (caught instanceof PermanentError) {
      expect(caught.message).toContain("chat not found");
    }
  });

  test("403 (forbidden) → PermanentError", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(403, { ok: false, description: "bot was blocked" }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.sendMessage(1, "x");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermanentError);
  });
});

// --- answerCallbackQuery ---------------------------------------------------

describe("TelegramClient.answerCallbackQuery", () => {
  test("succeeds on 200 OK with callback_query_id + optional text", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { ok: true, result: true }));
    const client = new TelegramClient(TOKEN, fetch);
    await client.answerCallbackQuery("cbq_1", "Got it");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${API_BASE}/answerCallbackQuery`);
    const body = call.body as { callback_query_id: string; text?: string };
    expect(body.callback_query_id).toBe("cbq_1");
    expect(body.text).toBe("Got it");
  });

  test("400 → PermanentError", async () => {
    const { fetch } = mockFetch(() =>
      jsonResponse(400, { ok: false, description: "query is too old" }),
    );
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.answerCallbackQuery("cbq_1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PermanentError);
  });

  test("network throw → TransientError(15)", async () => {
    const { fetch } = mockFetch(() => Promise.reject(new Error("offline")));
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.answerCallbackQuery("cbq_1");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
    if (caught instanceof TransientError) expect(caught.backoff_secs).toBe(15);
  });
});

// --- setWebhook ------------------------------------------------------------

describe("TelegramClient.setWebhook", () => {
  test("succeeds on 200 OK; passes url + secret_token", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { ok: true, result: true }));
    const client = new TelegramClient(TOKEN, fetch);
    await client.setWebhook("https://example.com/webhook", "shh");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    if (!call) throw new Error("expected one call");
    expect(call.url).toBe(`${API_BASE}/setWebhook`);
    const body = call.body as { url: string; secret_token?: string };
    expect(body.url).toBe("https://example.com/webhook");
    expect(body.secret_token).toBe("shh");
  });

  test("succeeds without secret_token", async () => {
    const { fetch, calls } = mockFetch(() => jsonResponse(200, { ok: true, result: true }));
    const client = new TelegramClient(TOKEN, fetch);
    await client.setWebhook("https://example.com/webhook");
    const body = calls[0]?.body as Record<string, unknown>;
    expect(body.url).toBe("https://example.com/webhook");
    expect("secret_token" in body).toBe(false);
  });

  test("503 → TransientError", async () => {
    const { fetch } = mockFetch(() => new Response("nope", { status: 503 }));
    const client = new TelegramClient(TOKEN, fetch);
    let caught: unknown;
    try {
      await client.setWebhook("https://example.com/webhook");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransientError);
  });
});
