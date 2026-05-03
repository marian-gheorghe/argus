import type { ChatIds, RenderFn } from "./dispatcher.ts";
import { renderGateMessage } from "./render-gate.ts";
import type { QueuedPayload } from "./server.ts";

/**
 * Default render function. Picks `chat_id` from `chatIds` based on the
 * payload's `tier` and uses the event's `message` verbatim. Used for
 * non-gate tiers (info/warn/page/critical) where Phase B keeps the
 * message body simple.
 */
export const defaultRender: RenderFn = (payload, chatIds) => {
  // Be defensive: payload comes back from sqlite as untrusted JSON.
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<QueuedPayload>;
  if (!p.tier || !p.event || typeof p.event.message !== "string") return null;
  const chat_id = pickChatId(p.tier, chatIds);
  if (chat_id === undefined) return null;
  return { chat_id, text: p.event.message };
};

/**
 * Top-level render dispatcher. For `tier === "gate"` events, builds the
 * rich card with inline keyboard via `renderGateMessage`; for everything
 * else, falls back to `defaultRender`.
 *
 * Tests for the dispatcher continue to inject their own trivial render
 * function; production wires this `render` symbol via `index.ts`.
 */
export const render: RenderFn = (payload, chatIds) => {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Partial<QueuedPayload>;
  if (p.tier === "gate" && p.event) {
    return renderGateMessage(p.event, chatIds.gates);
  }
  return defaultRender(payload, chatIds);
};

function pickChatId(tier: QueuedPayload["tier"], chatIds: ChatIds): number | undefined {
  switch (tier) {
    case "info":
      return chatIds.info;
    case "warn":
      return chatIds.warn;
    case "page":
      return chatIds.page;
    case "critical":
      return chatIds.critical;
    case "gate":
      return chatIds.gates;
    default:
      return undefined;
  }
}
