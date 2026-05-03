import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { type ChatIds, Dispatcher, type RenderFn } from "../src/dispatcher.ts";
import { OutboundQueue } from "../src/queue.ts";
import type { QueuedPayload } from "../src/server.ts";
import {
  type InlineKeyboard,
  PermanentError,
  type TelegramClient,
  TransientError,
} from "../src/telegram.ts";

const silentLog = pino({ level: "silent" });

const chatIds: ChatIds = {
  info: 100,
  warn: 200,
  page: 300,
  critical: 400,
  gates: 500,
};

interface SendCall {
  chat_id: number | string;
  text: string;
  keyboard: InlineKeyboard | undefined;
}

/**
 * Stub telegram client that records sendMessage calls and lets each test
 * decide what to throw or return.
 */
function stubTelegram(impl: (call: SendCall) => Promise<{ message_id: number }>): {
  client: TelegramClient;
  calls: SendCall[];
} {
  const calls: SendCall[] = [];
  const client = {
    sendMessage: async (
      chat_id: number | string,
      text: string,
      keyboard?: InlineKeyboard,
    ): Promise<{ message_id: number }> => {
      const call: SendCall = { chat_id, text, keyboard };
      calls.push(call);
      return await impl(call);
    },
  } as unknown as TelegramClient;
  return { client, calls };
}

/** Trivial render: pulls tier → chat_id, uses event.message verbatim. */
const trivialRender: RenderFn = (payload, ids) => {
  const p = payload as QueuedPayload;
  const chat_id = p.tier === "gate" ? ids.gates : ids[p.tier];
  return { chat_id, text: p.event.message };
};

let tmpDir: string;
let queue: OutboundQueue;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "argus-dispatcher-"));
  queue = new OutboundQueue(join(tmpDir, "queue.sqlite"));
});

afterEach(() => {
  queue.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeEvent(tier: "info" | "warn" | "page" | "critical" | "gate", id: string) {
  return {
    tier,
    event: {
      event_id: id,
      event: "agent.completed",
      severity: tier === "gate" ? ("info" as const) : tier,
      message: `hello ${id}`,
    },
  };
}

describe("Dispatcher.tick", () => {
  test("empty queue → tick returns 'empty', no telegram calls", async () => {
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const r = await d.tick();
    expect(r).toBe("empty");
    expect(calls).toHaveLength(0);
  });

  test("pending row → tick returns 'delivered', telegram called with right chat_id, row removed", async () => {
    queue.enqueue("evt-info-1", makeEvent("info", "evt-info-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const r = await d.tick();
    expect(r).toBe("delivered");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.chat_id).toBe(chatIds.info);
    expect(calls[0]?.text).toBe("hello evt-info-1");
    expect(queue.depth()).toBe(0);
  });

  test("gate tier → routed to gates chat", async () => {
    queue.enqueue("evt-gate-1", makeEvent("gate", "evt-gate-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    await d.tick();
    expect(calls[0]?.chat_id).toBe(chatIds.gates);
  });

  test("TransientError → tick returns 'transient', row marked failed with backoff", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client } = stubTelegram(async () => {
      throw new TransientError(60, "rate limited");
    });
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const r = await d.tick();
    expect(r).toBe("transient");
    // Row stays in queue but is not visible (backoff is 60s).
    expect(queue.depth()).toBe(1);
    expect(queue.peek()).toBeNull();
    expect(queue.parkedDepth()).toBe(0);
  });

  test("PermanentError → tick returns 'parked', row in parking_lot", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client } = stubTelegram(async () => {
      throw new PermanentError("invalid bot token");
    });
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const r = await d.tick();
    expect(r).toBe("parked");
    expect(queue.depth()).toBe(0);
    expect(queue.parkedDepth()).toBe(1);
  });

  test("after maxAttemptsBeforePark transient failures → parked", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    // Use 0-second backoff so peek keeps returning the row.
    const { client } = stubTelegram(async () => {
      throw new TransientError(0, "transient");
    });
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
      config: { maxAttemptsBeforePark: 3 },
    });
    expect(await d.tick()).toBe("transient");
    expect(await d.tick()).toBe("transient");
    // Third attempt should park because attempts will be 2 → 3 ≥ max=3.
    const last = await d.tick();
    expect(last).toBe("parked");
    expect(queue.depth()).toBe(0);
    expect(queue.parkedDepth()).toBe(1);
  });

  test("render returns null → row parked immediately", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const nullRender: RenderFn = () => null;
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: nullRender,
      log: silentLog,
      chatIds,
    });
    const r = await d.tick();
    expect(r).toBe("parked");
    expect(calls).toHaveLength(0);
    expect(queue.depth()).toBe(0);
    expect(queue.parkedDepth()).toBe(1);
  });

  test("keyboard from render is forwarded to telegram", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const kb: InlineKeyboard = {
      inline_keyboard: [[{ text: "ok", callback_data: "x:approve" }]],
    };
    const renderWithKb: RenderFn = (payload, ids) => {
      const p = payload as QueuedPayload;
      const chat_id = p.tier === "gate" ? ids.gates : ids[p.tier];
      return { chat_id, text: "msg", keyboard: kb };
    };
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: renderWithKb,
      log: silentLog,
      chatIds,
    });
    await d.tick();
    expect(calls[0]?.keyboard).toEqual(kb);
  });
});

describe("Dispatcher.run", () => {
  test("exits cleanly on abort signal (empty queue)", async () => {
    const { client } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const ctrl = new AbortController();
    const p = d.run(ctrl.signal);
    // Let the loop spin a few times before aborting.
    setTimeout(() => ctrl.abort(), 50);
    await p;
    // If we got here, it exited cleanly.
    expect(true).toBe(true);
  });

  test("processes a queued event then exits on abort", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const ctrl = new AbortController();
    const p = d.run(ctrl.signal);
    // Give it time to process at least one tick, then abort.
    setTimeout(() => ctrl.abort(), 100);
    await p;
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(queue.depth()).toBe(0);
  });

  test("pre-aborted signal → exits without ticking", async () => {
    queue.enqueue("evt-1", makeEvent("info", "evt-1"));
    const { client, calls } = stubTelegram(async () => ({ message_id: 1 }));
    const d = new Dispatcher({
      queue,
      telegram: client,
      render: trivialRender,
      log: silentLog,
      chatIds,
    });
    const ctrl = new AbortController();
    ctrl.abort();
    await d.run(ctrl.signal);
    expect(calls).toHaveLength(0);
    // Row still in queue.
    expect(queue.depth()).toBe(1);
  });
});
