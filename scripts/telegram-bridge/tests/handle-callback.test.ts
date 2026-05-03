import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { OutboundQueue } from "../src/queue.ts";
import { GateDecision } from "../src/schemas.ts";
import { buildApp } from "../src/server.ts";
import type { InlineKeyboard, TelegramClient } from "../src/telegram.ts";

const silentLog = pino({ level: "silent" });

const ALLOWED_CHAT_ID = -1001;
const FOREIGN_CHAT_ID = -9999;

interface TgCall {
  method: "sendMessage" | "answerCallbackQuery" | "setWebhook";
  args: unknown[];
}

/**
 * Mock telegram client that records every call. `sendMessage` returns a
 * stable message_id; tests can override per-call by setting `nextMessageId`.
 */
function mockTelegram(): { client: TelegramClient; calls: TgCall[]; nextMessageId: { v: number } } {
  const calls: TgCall[] = [];
  const nextMessageId = { v: 99 };
  const client = {
    sendMessage: async (
      chat_id: number | string,
      text: string,
      keyboard?: InlineKeyboard,
      opts?: { force_reply?: boolean },
    ): Promise<{ message_id: number }> => {
      calls.push({ method: "sendMessage", args: [chat_id, text, keyboard, opts] });
      return { message_id: nextMessageId.v };
    },
    answerCallbackQuery: async (callback_query_id: string, text?: string): Promise<void> => {
      calls.push({ method: "answerCallbackQuery", args: [callback_query_id, text] });
    },
    setWebhook: async (url: string, secret_token?: string): Promise<void> => {
      calls.push({ method: "setWebhook", args: [url, secret_token] });
    },
  } as unknown as TelegramClient;
  return { client, calls, nextMessageId };
}

let tmpDir: string;
let gatesDir: string;
let queue: OutboundQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-callback-"));
  gatesDir = join(tmpDir, "gates");
  queue = new OutboundQueue(join(tmpDir, "queue.sqlite"));
});

afterEach(() => {
  queue.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const chatIds = {
  info: 1,
  warn: 2,
  page: 3,
  critical: 4,
  gates: ALLOWED_CHAT_ID,
};

function jsonRequest(path: string, body: unknown, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
}

function callbackBody(opts: {
  data: string;
  chat_id?: number;
  user_id?: number;
  callback_query_id?: string;
  message_id?: number;
}) {
  return {
    callback_query: {
      id: opts.callback_query_id ?? "cbq_1",
      from: { id: opts.user_id ?? 4242, username: "operator" },
      message: { chat: { id: opts.chat_id ?? ALLOWED_CHAT_ID }, message_id: opts.message_id ?? 17 },
      data: opts.data,
    },
  };
}

function readDecision(gate_id: string): unknown {
  const path = join(gatesDir, `${gate_id}.decision.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("approve callback", () => {
  test("writes decision file with decision=approved and answers callback", async () => {
    const { client, calls } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve" })),
    );
    expect(res.status).toBe(200);

    expect(existsSync(join(gatesDir, "gate_1.decision.json"))).toBe(true);
    const parsed = GateDecision.parse(readDecision("gate_1"));
    expect(parsed.gate_id).toBe("gate_1");
    expect(parsed.decision).toBe("approved");
    expect(parsed.decided_by_chat_id).toBe(ALLOWED_CHAT_ID);

    const acks = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(acks).toHaveLength(1);
  });
});

describe("defer callback", () => {
  test("writes decision file with decision=deferred and answers callback", async () => {
    const { client, calls } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    const res = await app.request(jsonRequest("/telegram", callbackBody({ data: "gate_2:defer" })));
    expect(res.status).toBe(200);

    expect(existsSync(join(gatesDir, "gate_2.decision.json"))).toBe(true);
    const parsed = GateDecision.parse(readDecision("gate_2"));
    expect(parsed.decision).toBe("deferred");

    const acks = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(acks).toHaveLength(1);
  });
});

describe("reject callback", () => {
  test("starts pending-reply flow: sends force_reply, inserts row, no decision file yet", async () => {
    const { client, calls, nextMessageId } = mockTelegram();
    nextMessageId.v = 555; // prompt's message_id
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_3:reject" })),
    );
    expect(res.status).toBe(200);

    // No decision file yet — we are awaiting the reason.
    expect(existsSync(join(gatesDir, "gate_3.decision.json"))).toBe(false);

    // sendMessage with force_reply went out.
    const sends = calls.filter((c) => c.method === "sendMessage");
    expect(sends).toHaveLength(1);
    const send = sends[0];
    if (!send) throw new Error("expected sendMessage call");
    const opts = send.args[3] as { force_reply?: boolean } | undefined;
    expect(opts?.force_reply).toBe(true);

    // Pending row recorded.
    const found = queue.findPendingReply(ALLOWED_CHAT_ID, 4242);
    expect(found).not.toBeNull();
    if (found) {
      expect(found.gate_id).toBe("gate_3");
      expect(found.prompt_message_id).toBe(555);
    }

    // We acknowledged the callback query.
    const acks = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(acks).toHaveLength(1);
  });

  test("subsequent reply matching pending → writes decision=rejected with comment, deletes pending row", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    // Prime: tap reject.
    await app.request(jsonRequest("/telegram", callbackBody({ data: "gate_4:reject" })));

    // Now post the matching reply message.
    const replyBody = {
      message: {
        message_id: 1024,
        from: { id: 4242, username: "operator" },
        chat: { id: ALLOWED_CHAT_ID },
        text: "summary lacks rate-limit details",
        reply_to_message: { message_id: 99 }, // mockTelegram default
      },
    };
    const res = await app.request(jsonRequest("/telegram", replyBody));
    expect(res.status).toBe(200);

    expect(existsSync(join(gatesDir, "gate_4.decision.json"))).toBe(true);
    const parsed = GateDecision.parse(readDecision("gate_4"));
    expect(parsed.decision).toBe("rejected");
    expect(parsed.comment).toBe("summary lacks rate-limit details");
    // Pending row gone.
    expect(queue.findPendingReply(ALLOWED_CHAT_ID, 4242)).toBeNull();
  });

  test("reply without a matching pending row is ignored (200, no decision)", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    const replyBody = {
      message: {
        message_id: 2048,
        from: { id: 9999, username: "stranger" },
        chat: { id: ALLOWED_CHAT_ID },
        text: "random comment",
        reply_to_message: { message_id: 99 },
      },
    };
    const res = await app.request(jsonRequest("/telegram", replyBody));
    expect(res.status).toBe(200);
    expect(existsSync(join(gatesDir, "gate_4.decision.json"))).toBe(false);
  });
});

describe("validation + allowlist", () => {
  test("malformed JSON → 400", async () => {
    const { client } = mockTelegram();
    const app = buildApp({ queue, log: silentLog, telegram: client, gatesDir, chatIds });
    const res = await app.request(jsonRequest("/telegram", "{not-json"));
    expect(res.status).toBe(400);
  });

  test("body that is neither callback_query nor message → 400", async () => {
    const { client } = mockTelegram();
    const app = buildApp({ queue, log: silentLog, telegram: client, gatesDir, chatIds });
    const res = await app.request(jsonRequest("/telegram", { hello: "world" }));
    expect(res.status).toBe(400);
  });

  test("bad callback_data ('abc' not 'gate:action') → 400", async () => {
    const { client } = mockTelegram();
    const app = buildApp({ queue, log: silentLog, telegram: client, gatesDir, chatIds });
    const res = await app.request(jsonRequest("/telegram", callbackBody({ data: "abc" })));
    expect(res.status).toBe(400);
  });

  test("unknown action → 400", async () => {
    const { client } = mockTelegram();
    const app = buildApp({ queue, log: silentLog, telegram: client, gatesDir, chatIds });
    const res = await app.request(jsonRequest("/telegram", callbackBody({ data: "gate_1:wat" })));
    expect(res.status).toBe(400);
  });

  test("callback from non-allowlisted chat_id → 403", async () => {
    const { client } = mockTelegram();
    const app = buildApp({ queue, log: silentLog, telegram: client, gatesDir, chatIds });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve", chat_id: FOREIGN_CHAT_ID })),
    );
    expect(res.status).toBe(403);
    expect(existsSync(join(gatesDir, "gate_1.decision.json"))).toBe(false);
  });
});

describe("HMAC verification", () => {
  const expectedSecret = "s3kr3t-token-abc";

  test("env secret set, missing header → 403", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
      expectedSecret,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve" })),
    );
    expect(res.status).toBe(403);
  });

  test("env secret set, wrong header → 403", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
      expectedSecret,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve" }), {
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "wrong",
        },
      }),
    );
    expect(res.status).toBe(403);
  });

  test("env secret set, correct header → proceeds", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
      expectedSecret,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve" }), {
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": expectedSecret,
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(existsSync(join(gatesDir, "gate_1.decision.json"))).toBe(true);
  });

  test("env secret unset, header is ignored → proceeds", async () => {
    const { client } = mockTelegram();
    const app = buildApp({
      queue,
      log: silentLog,
      telegram: client,
      gatesDir,
      chatIds,
    });
    const res = await app.request(
      jsonRequest("/telegram", callbackBody({ data: "gate_1:approve" }), {
        headers: {
          "content-type": "application/json",
          "X-Telegram-Bot-Api-Secret-Token": "anything",
        },
      }),
    );
    expect(res.status).toBe(200);
  });
});
