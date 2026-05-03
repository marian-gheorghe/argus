import { Hono } from "hono";
import type { Logger } from "pino";
import pino from "pino";
import type { ChatIds } from "./dispatcher.ts";
import { buildCallbackHandler } from "./handle-callback.ts";
import type { OutboundQueue } from "./queue.ts";
import { ClawhipWebhookEvent, type Severity } from "./schemas.ts";
import type { TelegramClient } from "./telegram.ts";

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
  /**
   * Telegram client — used by the `/telegram` callback handler to ack
   * button taps and post `force_reply` prompts. Tests inject a mock.
   */
  telegram?: TelegramClient;
  /**
   * Directory where the bridge writes `<gate_id>.decision.json` files for
   * OMC to consume. Must be the same dir that `gate-watcher` reads from.
   */
  gatesDir?: string;
  /**
   * Tier → chat-id map. Only `chatIds.gates` is used here for the
   * `/telegram` allowlist check; the dispatcher uses the rest.
   */
  chatIds?: ChatIds;
  /**
   * Telegram webhook secret token. When set, the `/telegram` route requires
   * a matching `X-Telegram-Bot-Api-Secret-Token` header (constant-time
   * compare). When unset, the header is ignored — dev/local mode.
   */
  expectedSecret?: string;
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
 *
 * The `/telegram` route is wired via `buildCallbackHandler` when the
 * gate-decision deps (`telegram`, `gatesDir`, `chatIds`) are present. When
 * any are missing, the route returns 503 — this lets the webhook + health
 * tests run without constructing telegram mocks.
 */
export function buildApp(deps: AppDeps): Hono {
  const { queue, log, telegram, gatesDir, chatIds, expectedSecret } = deps;
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

  if (telegram && gatesDir && chatIds) {
    const callbackHandler = buildCallbackHandler({
      queue,
      telegram,
      gatesDir,
      log,
      allowedChatId: chatIds.gates,
      expectedSecret,
    });
    app.post("/telegram", callbackHandler);
  } else {
    // Misconfigured: explicit 503 lets the operator notice rather than the
    // request silently 404'ing. Tests that don't exercise /telegram
    // intentionally omit these deps.
    app.post("/telegram", (c) =>
      c.json({ error: "telegram callback handler not configured" }, 503),
    );
  }

  return app;
}
