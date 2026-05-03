import { Hono } from "hono";
import type { Logger } from "pino";
import pino from "pino";
import type { Severity } from "./schemas.ts";
import { ClawhipWebhookEvent, TelegramCallbackPayload } from "./schemas.ts";

import type { OutboundQueue } from "./queue.ts";

/**
 * Tier hint stored alongside the event in the queue payload. The dispatcher's
 * render function uses it to pick a chat_id. `info|warn|page|critical` mirror
 * `Severity`; `gate` is the gate-pending tier (gate events carry their own
 * `severity: "info"` but go to a dedicated gates chat).
 */
export type Tier = Severity | "gate";

/** Shape of the queued payload — event JSON + tier routing hint. */
export interface QueuedPayload {
  tier: Tier;
  event: ClawhipWebhookEvent;
}

export interface AppDeps {
  queue: OutboundQueue;
  log: Logger;
}

/**
 * Default pino logger factory. Production logs JSON to stdout; non-production
 * pretty-prints. Tests inject their own silent logger via `buildApp`.
 */
export function makeLog(): Logger {
  return pino({
    name: "argus-telegram-bridge",
    level: process.env.LOG_LEVEL ?? "info",
    transport:
      process.env.NODE_ENV === "production"
        ? undefined
        : { target: "pino-pretty", options: { colorize: true } },
  });
}

const VERSION = "0.1.0";
const NAME = "argus-telegram-bridge";

const TIERS = ["info", "warn", "page", "critical", "gate"] as const;

/**
 * Build a configured Hono app. All side-effecting deps are injected so tests
 * use mock or temp-dir fixtures instead of real env/state.
 */
export function buildApp(deps: AppDeps): Hono {
  const { queue, log } = deps;
  const app = new Hono();

  app.get("/health", (c) =>
    c.json({
      status: "ok",
      name: NAME,
      version: VERSION,
      uptime_secs: Math.round(process.uptime()),
    }),
  );

  for (const tier of TIERS) {
    app.post(`/webhook/${tier}`, async (c) => {
      const raw = await c.req.text();
      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        return c.json({ error: "invalid JSON body" }, 400);
      }
      const parsed = ClawhipWebhookEvent.safeParse(json);
      if (!parsed.success) {
        return c.json(
          {
            error: "invalid ClawhipWebhookEvent",
            issues: parsed.error.issues.map((i) => ({
              path: i.path,
              message: i.message,
              code: i.code,
            })),
          },
          400,
        );
      }
      const event = parsed.data;
      const payload: QueuedPayload = { tier, event };
      const { id, created } = queue.enqueue(event.event_id, payload);
      log.info(
        {
          event_id: event.event_id,
          event: event.event,
          severity: event.severity,
          tier,
          queued_id: id,
          deduplicated: !created,
        },
        "webhook enqueued",
      );
      return c.json({ accepted: true, queued_id: id, deduplicated: !created }, 200);
    });
  }

  // Telegram callback. Task 6 only validates and ACKs; Task 10 wires the handler.
  app.post("/telegram", verifyTelegramSecret, async (c) => {
    const raw = await c.req.text();
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid JSON body" }, 400);
    }
    const parsed = TelegramCallbackPayload.safeParse(json);
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
    log.info(
      {
        callback_query_id: parsed.data.callback_query.id,
        data: parsed.data.callback_query.data,
      },
      "telegram callback received (Task 10 will handle)",
    );
    return c.json({ ok: true }, 200);
  });

  return app;
}

/**
 * Stub middleware: full HMAC verification of `X-Telegram-Bot-Api-Secret-Token`
 * lands in Task 10. For Task 6, no-ops if no secret configured.
 */
async function verifyTelegramSecret(
  c: { req: { header: (n: string) => string | undefined } },
  next: () => Promise<void>,
): Promise<void> {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    await next();
    return;
  }
  // Task 10 fills this in.
  await next();
}
