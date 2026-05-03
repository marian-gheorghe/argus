import type { Logger } from "pino";
import type { OutboundQueue } from "./queue.ts";
import type { QueuedPayload } from "./server.ts";
import {
  type InlineKeyboard,
  PermanentError,
  type TelegramClient,
  TransientError,
} from "./telegram.ts";

/**
 * Tier → chat-id map. Resolved once at boot from env (`TELEGRAM_CHAT_ID_*`)
 * and passed into the dispatcher + render function.
 *
 * Note: `gate` events route to `gates` (not a separate `gate` chat name) —
 * the Telegram chat is logically the "gates queue", which may carry both
 * gate events and gate decisions.
 */
export interface ChatIds {
  info: number;
  warn: number;
  page: number;
  critical: number;
  gates: number;
}

/** Result of one dispatcher tick — used by tests + lets `run` decide pacing. */
export type TickResult = "empty" | "delivered" | "transient" | "parked";

/**
 * Pure function that converts a queued payload into a Telegram-ready message.
 * Returning `null` means "park this row immediately" (e.g. malformed payload
 * the dispatcher can't render).
 */
export type RenderFn = (
  payload: unknown,
  chatIds: ChatIds,
) => { chat_id: number; text: string; keyboard?: InlineKeyboard } | null;

interface DispatcherDeps {
  queue: OutboundQueue;
  telegram: TelegramClient;
  render: RenderFn;
  log: Logger;
  chatIds: ChatIds;
  config?: { maxAttemptsBeforePark?: number };
}

const DEFAULT_MAX_ATTEMPTS_BEFORE_PARK = 5;
const IDLE_SLEEP_MS = 500;

/**
 * Single-consumer outbound dispatcher loop.
 *
 * Policy:
 * - On `TransientError`: `markFailed` with the error's backoff_secs. After
 *   `maxAttemptsBeforePark` consecutive transient failures, park the row.
 * - On `PermanentError`: park immediately.
 * - If the render function returns `null`: park (the payload can't be sent).
 *
 * Mockable: telegram client + render are injected. `tick()` is a single
 * iteration with no internal sleeping — tests call it directly. `run()` adds
 * the loop + idle-sleep + abort-signal handling on top.
 */
export class Dispatcher {
  private readonly queue: OutboundQueue;
  private readonly telegram: TelegramClient;
  private readonly render: RenderFn;
  private readonly log: Logger;
  private readonly chatIds: ChatIds;
  private readonly maxAttemptsBeforePark: number;

  constructor(deps: DispatcherDeps) {
    this.queue = deps.queue;
    this.telegram = deps.telegram;
    this.render = deps.render;
    this.log = deps.log;
    this.chatIds = deps.chatIds;
    this.maxAttemptsBeforePark =
      deps.config?.maxAttemptsBeforePark ?? DEFAULT_MAX_ATTEMPTS_BEFORE_PARK;
  }

  async tick(): Promise<TickResult> {
    const row = this.queue.peek();
    if (!row) return "empty";

    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.queue.parkPermanent(row.id, `payload JSON parse failed: ${msg}`);
      this.log.error({ id: row.id, event_id: row.event_id, err: msg }, "parked: bad JSON payload");
      return "parked";
    }

    const rendered = this.render(payload, this.chatIds);
    if (!rendered) {
      this.queue.parkPermanent(row.id, "render returned null");
      this.log.warn({ id: row.id, event_id: row.event_id }, "parked: render returned null");
      return "parked";
    }

    try {
      const result = await this.telegram.sendMessage(
        rendered.chat_id,
        rendered.text,
        rendered.keyboard,
      );
      this.queue.markDelivered(row.id);
      this.log.info(
        {
          id: row.id,
          event_id: row.event_id,
          chat_id: rendered.chat_id,
          message_id: result.message_id,
        },
        "delivered",
      );
      return "delivered";
    } catch (e) {
      if (e instanceof TransientError) {
        // attempts AFTER this failure
        const newAttempts = row.attempts + 1;
        if (newAttempts >= this.maxAttemptsBeforePark) {
          this.queue.parkPermanent(
            row.id,
            `transient failures exceeded max=${this.maxAttemptsBeforePark}: ${e.message}`,
          );
          this.log.error(
            { id: row.id, event_id: row.event_id, attempts: newAttempts, err: e.message },
            "parked: max transient attempts",
          );
          return "parked";
        }
        this.queue.markFailed(row.id, e.message, e.backoff_secs);
        this.log.warn(
          {
            id: row.id,
            event_id: row.event_id,
            attempts: newAttempts,
            backoff_secs: e.backoff_secs,
            err: e.message,
          },
          "transient failure",
        );
        return "transient";
      }
      if (e instanceof PermanentError) {
        this.queue.parkPermanent(row.id, e.message);
        this.log.error(
          { id: row.id, event_id: row.event_id, err: e.message },
          "parked: permanent error",
        );
        return "parked";
      }
      // Unknown error: treat as transient with a default backoff but park if exceeded.
      const msg = e instanceof Error ? e.message : String(e);
      const newAttempts = row.attempts + 1;
      if (newAttempts >= this.maxAttemptsBeforePark) {
        this.queue.parkPermanent(row.id, `unknown error exceeded max attempts: ${msg}`);
        this.log.error(
          { id: row.id, event_id: row.event_id, err: msg },
          "parked: unknown error, max attempts",
        );
        return "parked";
      }
      this.queue.markFailed(row.id, `unknown: ${msg}`, 30);
      this.log.error({ id: row.id, event_id: row.event_id, err: msg }, "unknown error");
      return "transient";
    }
  }

  /**
   * Drive `tick()` until `signal` aborts. On empty queue, sleep `IDLE_SLEEP_MS`
   * before the next tick. On any non-empty result, loop immediately to keep
   * the queue draining.
   */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      const result = await this.tick();
      if (signal.aborted) return;
      if (result === "empty") {
        await this.sleep(IDLE_SLEEP_MS, signal);
      }
    }
  }

  private sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const t = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}
