import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";
import type { Logger } from "pino";
import type { OutboundQueue } from "./queue.ts";
import { type GateDecision, TelegramCallbackPayload } from "./schemas.ts";
import type { TelegramClient } from "./telegram.ts";

/**
 * Build the Hono handler for `POST /telegram`.
 *
 * Accepts two distinct Telegram Update shapes:
 *  - `{callback_query: ...}` from a button tap.
 *  - `{message: ...}` for plain text messages, used here to capture replies
 *    to the force_reply prompts opened by the reject flow.
 *
 * Allowlist: `chatIds.gates` is the only chat we accept gate-decision
 * traffic from. Any other chat → 403.
 *
 * HMAC: when `expectedSecret` is provided, the request must carry a matching
 * `X-Telegram-Bot-Api-Secret-Token` header (constant-time compare). When
 * unset, no header check (dev/local mode).
 *
 * Responsibilities split:
 *  - approve / defer → write `<gate_id>.decision.json` immediately.
 *  - reject → send a `force_reply` prompt, record a `pending_replies` row,
 *    answer callback. The eventual reply message arriving at this same
 *    endpoint finalizes the rejection with the operator's typed comment.
 */

export interface CallbackDeps {
  queue: OutboundQueue;
  telegram: TelegramClient;
  gatesDir: string;
  log: Logger;
  allowedChatId: number;
  expectedSecret?: string;
}

/** Return type for the Hono handler factory: `(c) => Promise<Response>`. */
export type CallbackHandler = (c: Context) => Promise<Response>;

export function buildCallbackHandler(deps: CallbackDeps): CallbackHandler {
  const { queue, telegram, gatesDir, log, allowedChatId, expectedSecret } = deps;

  return async function handleCallback(c: Context): Promise<Response> {
    // 1. HMAC check (when configured).
    if (expectedSecret !== undefined && expectedSecret.length > 0) {
      const got = c.req.header("X-Telegram-Bot-Api-Secret-Token");
      if (!verifySecretConstantTime(got, expectedSecret)) {
        log.warn("telegram callback: HMAC verification failed");
        return c.json({ error: "forbidden" }, 403);
      }
    }

    // 2. Body parsing.
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    if (!json || typeof json !== "object") {
      return c.json({ error: "expected object body" }, 400);
    }
    const obj = json as Record<string, unknown>;

    // 3. Branch by Update shape.
    if ("callback_query" in obj) {
      return await handleCallbackQuery(obj, c);
    }
    if ("message" in obj) {
      return await handleMessage(obj, c);
    }
    return c.json({ error: "expected callback_query or message field" }, 400);
  };

  /** Branch: button tap. */
  async function handleCallbackQuery(body: Record<string, unknown>, c: Context): Promise<Response> {
    const parsed = TelegramCallbackPayload.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: "invalid TelegramCallbackPayload",
          issues: parsed.error.issues.map((i) => ({
            path: i.path,
            message: i.message,
            code: i.code,
          })),
        },
        400,
      );
    }
    const cq = parsed.data.callback_query;

    // Allowlist enforcement.
    if (cq.message.chat.id !== allowedChatId) {
      log.warn(
        { chat_id: cq.message.chat.id, allowed: allowedChatId },
        "telegram callback: chat_id not allowlisted",
      );
      return c.json({ error: "forbidden" }, 403);
    }

    // Parse `<gate_id>:action` shape.
    const sep = cq.data.indexOf(":");
    if (sep < 1 || sep === cq.data.length - 1) {
      return c.json({ error: "invalid callback_data: expected <gate_id>:<action>" }, 400);
    }
    const gate_id = cq.data.slice(0, sep);
    const action = cq.data.slice(sep + 1);
    if (action !== "approve" && action !== "reject" && action !== "defer") {
      return c.json({ error: `invalid action: ${action}` }, 400);
    }

    if (action === "approve") {
      writeDecisionAtomic(gatesDir, {
        gate_id,
        run_id: gate_id, // run_id is unknown at decision time; OMC reconciles via gate_id.
        decision: "approved",
        decided_at: new Date().toISOString(),
        decided_by_chat_id: cq.message.chat.id,
      });
      await telegram.answerCallbackQuery(cq.id, "✅ Approved");
      log.info({ gate_id, action, chat_id: cq.message.chat.id }, "decision recorded");
      return c.json({ ok: true }, 200);
    }

    if (action === "defer") {
      writeDecisionAtomic(gatesDir, {
        gate_id,
        run_id: gate_id,
        decision: "deferred",
        decided_at: new Date().toISOString(),
        decided_by_chat_id: cq.message.chat.id,
      });
      await telegram.answerCallbackQuery(cq.id, "⏸ Deferred 4h");
      log.info({ gate_id, action, chat_id: cq.message.chat.id }, "decision recorded");
      return c.json({ ok: true }, 200);
    }

    // action === "reject" — open a reply prompt and remember the mapping.
    const promptText = `Reply to this message with the reason for rejecting ${gate_id}:`;
    const sent = await telegram.sendMessage(cq.message.chat.id, promptText, undefined, {
      force_reply: true,
    });
    queue.insertPendingReply(cq.message.chat.id, cq.from.id, gate_id, sent.message_id);
    await telegram.answerCallbackQuery(cq.id, "❌ Awaiting reason");
    log.info(
      {
        gate_id,
        chat_id: cq.message.chat.id,
        user_id: cq.from.id,
        prompt_message_id: sent.message_id,
      },
      "reject prompt sent, awaiting reply",
    );
    return c.json({ ok: true }, 200);
  }

  /** Branch: message reply. Used to capture the reject reason. */
  async function handleMessage(body: Record<string, unknown>, c: Context): Promise<Response> {
    const parsed = parseMessage(body);
    if (!parsed) {
      // Not a shape we care about — accept gracefully.
      return c.json({ ok: true, ignored: "not a reply we track" }, 200);
    }
    const { chat_id, user_id, text, reply_to_message_id } = parsed;

    // Allowlist enforcement.
    if (chat_id !== allowedChatId) {
      log.warn({ chat_id, allowed: allowedChatId }, "telegram message: chat_id not allowlisted");
      return c.json({ error: "forbidden" }, 403);
    }

    const pending = queue.findPendingReply(chat_id, user_id);
    if (!pending) {
      // No reject in flight for this user — ignore.
      return c.json({ ok: true, ignored: "no pending reply" }, 200);
    }
    if (
      typeof reply_to_message_id === "number" &&
      reply_to_message_id !== pending.prompt_message_id
    ) {
      // Reply targeted a different message — not the rejection prompt.
      return c.json({ ok: true, ignored: "reply target mismatch" }, 200);
    }

    writeDecisionAtomic(gatesDir, {
      gate_id: pending.gate_id,
      run_id: pending.gate_id,
      decision: "rejected",
      comment: text,
      decided_at: new Date().toISOString(),
      decided_by_chat_id: chat_id,
    });
    queue.deletePendingReply(chat_id, user_id);
    log.info(
      { gate_id: pending.gate_id, chat_id, user_id },
      "reject decision recorded with comment",
    );
    return c.json({ ok: true }, 200);
  }
}

/**
 * Permissive parser for the `message` shape we care about. Returns null if
 * the body isn't recognizable as a text reply with the fields we need.
 */
function parseMessage(body: Record<string, unknown>): {
  chat_id: number;
  user_id: number;
  text: string;
  reply_to_message_id: number | undefined;
} | null {
  const m = body.message;
  if (!m || typeof m !== "object") return null;
  const msg = m as Record<string, unknown>;
  const chat = msg.chat as { id?: unknown } | undefined;
  const from = msg.from as { id?: unknown } | undefined;
  const replyTo = msg.reply_to_message as { message_id?: unknown } | undefined;
  if (!chat || typeof chat.id !== "number") return null;
  if (!from || typeof from.id !== "number") return null;
  if (typeof msg.text !== "string") return null;
  return {
    chat_id: chat.id,
    user_id: from.id,
    text: msg.text,
    reply_to_message_id: typeof replyTo?.message_id === "number" ? replyTo.message_id : undefined,
  };
}

/**
 * Constant-time string compare for HMAC-style secrets. NEVER use `===` —
 * V8 short-circuits string compares on first-different-char, which is
 * a timing oracle. We compare every char via XOR.
 */
function verifySecretConstantTime(got: string | undefined, expected: string): boolean {
  if (typeof got !== "string") return false;
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Atomic decision-file write: tmp + fsync + rename. Forces the data to
 * disk before the rename so a crash mid-rename can't lose the decision.
 * Uses 0600 perms; the file may carry the operator's free-text comment.
 */
function writeDecisionAtomic(gatesDir: string, decision: GateDecision): void {
  mkdirSync(gatesDir, { recursive: true });
  const dst = join(gatesDir, `${decision.gate_id}.decision.json`);
  const tmp = `${dst}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(decision, null, 2), { mode: 0o600 });
  // Force the data to stable storage before swapping in the visible name.
  const fd = openSync(tmp, "r");
  fsyncSync(fd);
  closeSync(fd);
  renameSync(tmp, dst);
}
