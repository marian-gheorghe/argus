/**
 * Errors raised by `TelegramClient`. Callers (the dispatcher loop) use the
 * class to decide whether to retry with backoff (Transient) or park the row
 * permanently (Permanent).
 */
export class TransientError extends Error {
  readonly backoff_secs: number;
  constructor(backoff_secs: number, msg: string) {
    super(msg);
    this.name = "TransientError";
    this.backoff_secs = backoff_secs;
  }
}

export class PermanentError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "PermanentError";
  }
}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

interface TelegramApiError {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
}

interface SendMessageResult {
  message_id: number;
}

const DEFAULT_RETRY_AFTER = 30;
const SERVER_ERROR_BACKOFF = 30;
const NETWORK_ERROR_BACKOFF = 15;

/**
 * Tiny Telegram Bot API client.
 *
 * Design choices:
 * - `fetch` is injectable so unit tests can stub it without touching the network.
 * - Errors are classified into `TransientError` (callers retry with backoff_secs)
 *   vs `PermanentError` (callers park). The dispatcher loop owns the policy of
 *   what to do — this client just classifies.
 * - All requests POST JSON; `parse_mode: "Markdown"` is set on `sendMessage`
 *   so we can render gate cards with bold/code formatting.
 */
export class TelegramClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async sendMessage(
    chat_id: number | string,
    text: string,
    keyboard?: InlineKeyboard,
    opts?: { force_reply?: boolean },
  ): Promise<SendMessageResult> {
    const body: Record<string, unknown> = {
      chat_id,
      text,
      parse_mode: "Markdown",
    };
    if (keyboard) body.reply_markup = keyboard;
    // `force_reply` opens the in-Telegram reply prompt with no inline kb;
    // passes through as `reply_markup: { force_reply: true }` per the API.
    if (opts?.force_reply) body.reply_markup = { force_reply: true };

    const res = await this.post("sendMessage", body);
    const data = (await res.json().catch(() => ({}))) as {
      result?: { message_id?: number };
    };
    const messageId = data.result?.message_id;
    if (typeof messageId !== "number") {
      throw new PermanentError("telegram sendMessage: missing result.message_id");
    }
    return { message_id: messageId };
  }

  async answerCallbackQuery(callback_query_id: string, text?: string): Promise<void> {
    const body: Record<string, unknown> = { callback_query_id };
    if (text !== undefined) body.text = text;
    await this.post("answerCallbackQuery", body);
  }

  async setWebhook(url: string, secret_token?: string): Promise<void> {
    const body: Record<string, unknown> = { url };
    if (secret_token !== undefined) body.secret_token = secret_token;
    await this.post("setWebhook", body);
  }

  /**
   * Low-level POST with full error classification. Returns the Response on
   * success (2xx) so callers can read the body; throws Transient/Permanent on
   * any failure path.
   */
  private async post(method: string, body: Record<string, unknown>): Promise<Response> {
    const url = `https://api.telegram.org/bot${this.token}/${method}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new TransientError(NETWORK_ERROR_BACKOFF, `network: ${msg}`);
    }

    if (res.ok) return res;

    if (res.status === 429) {
      const data = (await res.json().catch(() => ({}))) as TelegramApiError;
      const retry = data.parameters?.retry_after;
      throw new TransientError(
        typeof retry === "number" ? retry : DEFAULT_RETRY_AFTER,
        `rate limited: ${data.description ?? "no description"}`,
      );
    }

    if (res.status >= 500) {
      throw new TransientError(SERVER_ERROR_BACKOFF, `telegram ${res.status}`);
    }

    if (res.status === 401) {
      throw new PermanentError("invalid bot token");
    }

    // 4xx other than 401/429 — read body for the API description.
    const data = (await res.json().catch(() => ({}))) as TelegramApiError;
    const description = data.description ?? `${res.status}`;
    throw new PermanentError(`telegram ${res.status}: ${description}`);
  }
}
