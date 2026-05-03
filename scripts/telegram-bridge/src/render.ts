import type { ChatIds, RenderFn } from "./dispatcher.ts";
import type { QueuedPayload } from "./server.ts";

/**
 * Default render function. Picks `chat_id` from `chatIds` based on the
 * payload's `tier` and uses the event's `message` verbatim.
 *
 * Task 9 will replace this for `tier === "gate"` with a rich gate-card
 * renderer (markdown body + inline keyboard). Until then, gates render
 * the same way as alerts.
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
