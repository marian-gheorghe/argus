# Phase B — Gate Model + Telegram Bridge Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development if executing in this session) to implement this plan task-by-task.

**Prerequisites:** Phase A merged to `main` with verdict ≥ PASS-WITH-CAVEATS. Daemons (`com.argus.clawhip`, `com.argus.omc-wait`) running. `#runs-info` Discord channel showing live `git.commit` and `agent.*` events from a smoke-test run.

**Goal:** Real autonomy — submit a directive, sleep, wake to a Telegram inline-button gate approval, sleep again, wake to a GitHub PR review request, approve, see the merge land. Phone-from-bed approvals work end-to-end.

**Architecture:** Telegram bridge as a **first-class Bun service** (not a 30-line script): TypeScript strict, zod-validated event schemas, sqlite-backed durable outbound queue with retries, modular Telegram client with exponential backoff, Hono HTTP receiver for clawhip webhook deliveries, fs.watch + polling-fallback gate-file watcher, structured JSON logs via pino, full vitest coverage of business logic, graceful shutdown that drains the queue. The OMC dispatcher skill writes `<gate-id>.pending.json` files and polls for `.decision.json` responses; the bridge owns the Telegram side of that contract.

**Tech Stack additions over Phase A:** Bun runtime, TypeScript strict mode, `zod`, `better-sqlite3`, `pino`, `hono`, `vitest`, Telegram Bot API (HTTP, no SDK).

**Out of scope for Phase B** (deferred to Phase C):
- Cost tracker hook
- Watchdog cron / dead-man's-switch
- Recovery matrix automation (loop caps, crash budget, provider fallback)
- VPS provisioning
- `/learner` cadence + skill scoping
- `#argus-page` and `#argus-critical` chat routing — Phase B handles **only** `#argus-gates`. PAGE/CRITICAL tiers are added in Phase C.

**Skills referenced:** `@superpowers:test-driven-development` (the bridge service is real code with real tests — TDD discipline applies), `@superpowers:verification-before-completion`, `@superpowers:systematic-debugging`.

---

## Pre-flight

- [ ] Phase A merged to `main`, daemons green for ≥24h.
- [ ] You're on a fresh worktree: `git worktree add .worktrees/phase-b-gates -b phase-b/gates` from main.
- [ ] You have admin on a Telegram account (free; you'll create a bot via @BotFather).
- [ ] `bun --version` works (we'll install it in Task 2 if not).

---

## Task 1: Manual — create Telegram bot and capture credentials

**Why:** The bridge needs a bot token before any code can run. This is a one-time UI dance with @BotFather. Capturing the token in `~/.argus/secrets.env` keeps it out of the repo.

**Steps:**

1. In Telegram, message **@BotFather** → `/newbot` → name it `argus-bot` (or similar) → choose a unique username ending in `bot`. BotFather returns a token like `7891234567:AAH...`.
2. Create three private group chats: `argus-gates`, `argus-page`, `argus-critical`. Add the bot to each (group settings → Add Member). For Phase B you only USE `argus-gates`; `page`/`critical` get wired in Phase C, but creating them now avoids a context-switch later.
3. For each chat, capture the chat ID. Easy way: send `/start` from your account, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates` and find `chat.id` in the JSON. **Group chat IDs are negative integers** (e.g., `-1001234567890`) — that's correct.
4. Append to `~/.argus/secrets.env`:

```bash
TELEGRAM_BOT_TOKEN="7891234567:AAH..."
TELEGRAM_CHAT_ID_GATES="-1001234567890"
TELEGRAM_CHAT_ID_PAGE="-1009876543210"
TELEGRAM_CHAT_ID_CRITICAL="-1005555555555"
```

5. Verify the bot can post:

```bash
source ~/.argus/secrets.env
curl -fsS -X POST \
  "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" \
  -d "chat_id=${TELEGRAM_CHAT_ID_GATES}" \
  -d "text=phase-b bot smoke test"
echo
```

**Expected:** JSON with `"ok": true`. Check `argus-gates` chat — message visible.

6. Append a runbook entry under `docs/runbooks/phase-b-gates.md` (you'll create the runbook scaffold in Task 2).

**No commit yet** — secrets are local-only. The runbook entry will be committed in Task 2.

---

## Task 2: Bootstrap Phase B install steps + bridge project skeleton

**Why:** Modular code + reproducible install. The bridge lives in `scripts/telegram-bridge/` as a self-contained Bun project so it can be tested independently and shipped via `bun install` on the VPS later.

**Files:**
- Create: `docs/runbooks/phase-b-gates.md`
- Modify: `scripts/install-mac.sh` (add Bun install + bridge bootstrap section)
- Create: `scripts/telegram-bridge/package.json`
- Create: `scripts/telegram-bridge/tsconfig.json`
- Create: `scripts/telegram-bridge/.gitignore`
- Create: `scripts/telegram-bridge/src/index.ts` (entry, just a "hello" log for now)
- Create: `scripts/telegram-bridge/README.md`

**Steps:**

1. **Add Bun to the install script.** Append to `scripts/install-mac.sh` a new section after `section_brew_packages`:

```bash
section_bun() {
  log "Ensuring Bun is installed"
  if command -v bun >/dev/null 2>&1; then
    log "  bun already on PATH ($(bun --version))"
  else
    log "  installing bun via official installer"
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
  fi
}
```

Wire `section_bun` into `main()` after `section_brew_packages`.

2. **Create the bridge project skeleton.**

`scripts/telegram-bridge/package.json`:

```json
{
  "name": "argus-telegram-bridge",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/index.ts",
    "start": "bun run src/index.ts",
    "test": "bun test",
    "typecheck": "tsc --noEmit",
    "lint": "biome check src"
  },
  "dependencies": {
    "@hono/node-server": "^1.x",
    "better-sqlite3": "^11.x",
    "hono": "^4.x",
    "pino": "^9.x",
    "pino-pretty": "^11.x",
    "zod": "^3.x"
  },
  "devDependencies": {
    "@biomejs/biome": "^1.x",
    "@types/better-sqlite3": "^7.x",
    "@types/bun": "latest",
    "typescript": "^5.x"
  }
}
```

`scripts/telegram-bridge/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

`scripts/telegram-bridge/.gitignore`:

```
node_modules/
*.log
*.sqlite
*.sqlite-journal
.env
.env.local
```

`scripts/telegram-bridge/src/index.ts`:

```ts
import pino from "pino";

const log = pino({ name: "argus-telegram-bridge" });
log.info({ phase: "boot" }, "argus-telegram-bridge starting");

// All real logic lives in modules imported from here in later tasks.
// For now, just stay alive so we can verify launchd wiring.
const server = Bun.serve({
  port: Number(process.env.BRIDGE_PORT ?? 9501),
  hostname: "127.0.0.1",
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("argus-telegram-bridge: not implemented yet", { status: 501 });
  },
});

log.info({ port: server.port }, "listening");
```

`scripts/telegram-bridge/README.md`: a short README pointing at the design doc + this plan.

3. **Install deps.**

```bash
cd scripts/telegram-bridge
bun install
bun run typecheck
```

Expected: deps install, typecheck passes (no output).

4. **Smoke-test the boot path.**

```bash
bun run start &
sleep 1
curl -fsS http://127.0.0.1:9501/health
kill %1
```

Expected: `{"status":"ok"}` printed.

5. **Create the runbook scaffold.** Mirror Phase A's runbook but seeded with Phase B tasks.

6. **Commit.**

```bash
git add scripts/install-mac.sh scripts/telegram-bridge/ docs/runbooks/phase-b-gates.md
git commit -m "phase-b: bootstrap telegram-bridge Bun project + Bun install section"
```

---

## Task 3: Define event schemas (zod) — TDD

**Why:** The bridge's contract surface is two pairs: (a) inbound clawhip webhook → outbound Telegram message; (b) inbound Telegram callback (button tap) → `<gate-id>.decision.json` write. Schemas pin both. Schema tests fail before any code, so misconfigurations surface during construction.

**Files:**
- Create: `scripts/telegram-bridge/src/schemas.ts`
- Create: `scripts/telegram-bridge/tests/schemas.test.ts`

**TDD discipline (per task):** write schema test → red → write schema → green → commit.

**Steps:**

1. **Write tests first.** `tests/schemas.test.ts` covers:
   - `ClawhipWebhookEvent` accepts well-formed payloads from clawhip's generic webhook sink (event-id, event-name, severity, message, run-id, gate-id when present, summary, key-decisions list, artifact path, timeout-at).
   - Rejects payloads missing event-id (we use this for dedup).
   - Rejects payloads with unknown severity values.
   - `TelegramCallbackPayload` accepts well-formed inline-keyboard callback updates from Telegram.
   - `GatePending` and `GateDecision` JSON files validate per design §4.3.

```ts
import { describe, expect, test } from "bun:test";
import { ClawhipWebhookEvent, GateDecision, GatePending, TelegramCallbackPayload } from "../src/schemas.ts";

describe("ClawhipWebhookEvent", () => {
  test("accepts well-formed payload", () => {
    const ok = ClawhipWebhookEvent.safeParse({
      event_id: "evt_abc123",
      event: "gate.pending",
      severity: "info",
      message: "Gate 1 — PRD approval",
      run_id: "2026-05-03-payment-svc-a3f81c2",
      gate_id: "gate_1",
      summary: "Stripe payment service.",
      key_decisions: ["Stripe SDK v15", "Postgres + Redis"],
      artifact_path: "/Users/x/.claude/omc/runs/.../prd.md",
      timeout_at: "2026-05-04T07:30:00Z",
    });
    expect(ok.success).toBe(true);
  });
  test("rejects missing event_id", () => {
    const bad = ClawhipWebhookEvent.safeParse({ event: "x", severity: "info", message: "y" });
    expect(bad.success).toBe(false);
  });
  test("rejects unknown severity", () => {
    const bad = ClawhipWebhookEvent.safeParse({
      event_id: "e", event: "x", severity: "blah", message: "y",
    });
    expect(bad.success).toBe(false);
  });
});
// (similar describe/test blocks for the other 3 schemas)
```

Run: `bun test` → all red (schemas don't exist).

2. **Implement schemas.** `src/schemas.ts`:

```ts
import { z } from "zod";

export const Severity = z.enum(["info", "warn", "page", "critical"]);
export type Severity = z.infer<typeof Severity>;

export const ClawhipWebhookEvent = z.object({
  event_id: z.string().min(1),               // dedup key
  event: z.string().min(1),                  // e.g., "gate.pending"
  severity: Severity,
  message: z.string(),
  run_id: z.string().optional(),
  gate_id: z.string().optional(),
  summary: z.string().optional(),
  key_decisions: z.array(z.string()).optional(),
  artifact_path: z.string().optional(),
  diff_url: z.string().url().optional(),
  timeout_at: z.string().datetime().optional(),
  // permissive on extras; clawhip may add fields we don't yet use
}).passthrough();
export type ClawhipWebhookEvent = z.infer<typeof ClawhipWebhookEvent>;

export const TelegramCallbackPayload = z.object({
  callback_query: z.object({
    id: z.string(),
    from: z.object({ id: z.number(), username: z.string().optional() }),
    message: z.object({ chat: z.object({ id: z.number() }), message_id: z.number() }),
    data: z.string(),  // we encode "<gate-id>:approve|reject|defer"
  }),
});
export type TelegramCallbackPayload = z.infer<typeof TelegramCallbackPayload>;

export const GatePending = z.object({
  gate_id: z.string(),
  run_id: z.string(),
  type: z.enum(["PRD", "code-review", "final-integration"]),
  title: z.string(),
  summary: z.string(),
  key_decisions: z.array(z.string()).default([]),
  artifact_path: z.string(),
  diff_url: z.string().url().optional(),
  created_at: z.string().datetime(),
  timeout_at: z.string().datetime(),
});
export type GatePending = z.infer<typeof GatePending>;

export const GateDecision = z.object({
  gate_id: z.string(),
  run_id: z.string(),
  decision: z.enum(["approved", "rejected", "deferred"]),
  comment: z.string().optional(),
  decided_at: z.string().datetime(),
  decided_by_chat_id: z.number().optional(),
});
export type GateDecision = z.infer<typeof GateDecision>;
```

Run: `bun test` → all green.

3. **Commit.**

```bash
git add scripts/telegram-bridge/src/schemas.ts scripts/telegram-bridge/tests/schemas.test.ts
git commit -m "phase-b: define + test event schemas (zod) for bridge contract"
```

---

## Task 4: Durable outbound queue (sqlite) — TDD

**Why:** Telegram has outages. Network blips happen. Without a durable queue, an event arriving at the bridge during a blip is silently lost — the *exact failure mode* clawhip already has and that we're trying to fix here. sqlite (via better-sqlite3, synchronous) gives us atomic appends + atomic dequeues with no async complexity.

**Files:**
- Create: `scripts/telegram-bridge/src/queue.ts`
- Create: `scripts/telegram-bridge/tests/queue.test.ts`

**Steps (TDD):**

1. **Tests first.** `tests/queue.test.ts`:
   - Open queue at a temp file path → `enqueue` returns row id, `peek` returns oldest pending, `markDelivered` removes it, `markFailed` increments retry count + sets `next_attempt_at`.
   - Re-open the same file → pending rows persist (durability check).
   - `peek` honors `next_attempt_at` (rows in backoff don't surface).
   - Dedup: `enqueue` with an existing `event_id` is a no-op (returns the existing row id).

2. **Implement.** `src/queue.ts`:

```ts
import Database from "better-sqlite3";

export interface QueueRow {
  id: number;
  event_id: string;
  payload: string;          // JSON
  enqueued_at: string;
  attempts: number;
  next_attempt_at: string;  // ISO; due now if <= now
  last_error: string | null;
}

export class OutboundQueue {
  private db: Database.Database;

  constructor(path: string) {
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS outbound (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT UNIQUE NOT NULL,
        payload TEXT NOT NULL,
        enqueued_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        last_error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_outbound_due ON outbound(next_attempt_at);
    `);
  }

  enqueue(event_id: string, payload: object): number {
    const stmt = this.db.prepare(
      "INSERT INTO outbound (event_id, payload) VALUES (?, ?) ON CONFLICT(event_id) DO NOTHING RETURNING id"
    );
    const row = stmt.get(event_id, JSON.stringify(payload)) as { id: number } | undefined;
    if (row) return row.id;
    // Already existed; return existing
    const existing = this.db.prepare("SELECT id FROM outbound WHERE event_id = ?").get(event_id) as { id: number };
    return existing.id;
  }

  peek(): QueueRow | null {
    const row = this.db.prepare(
      "SELECT * FROM outbound WHERE next_attempt_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ORDER BY id ASC LIMIT 1"
    ).get() as QueueRow | undefined;
    return row ?? null;
  }

  markDelivered(id: number): void {
    this.db.prepare("DELETE FROM outbound WHERE id = ?").run(id);
  }

  markFailed(id: number, error: string, backoff_secs: number): void {
    this.db.prepare(`
      UPDATE outbound
      SET attempts = attempts + 1,
          last_error = ?,
          next_attempt_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+' || ? || ' seconds')
      WHERE id = ?
    `).run(error, backoff_secs, id);
  }

  depth(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM outbound").get() as { c: number }).c;
  }

  close(): void { this.db.close(); }
}
```

3. **Run tests** → green. **Commit.**

```bash
git add scripts/telegram-bridge/src/queue.ts scripts/telegram-bridge/tests/queue.test.ts
git commit -m "phase-b: durable sqlite-backed outbound queue with dedup + retry backoff"
```

---

## Task 5: Telegram API client with retry/backoff — TDD

**Why:** Telegram API can return 429 (rate limit), 5xx (transient), or 401 (token revoked). The client must distinguish:
- **transient** (429, 5xx, network error) → mark queue row failed with backoff
- **permanent** (400, 401) → log + alert, but don't infinite-retry (move to a `parking_lot` table after N attempts)

**Files:**
- Create: `scripts/telegram-bridge/src/telegram.ts`
- Create: `scripts/telegram-bridge/tests/telegram.test.ts`

**Steps:**

1. **Tests** with mocked `fetch`:
   - `sendMessage(chatId, text, keyboard?)` returns the API response on 200.
   - On 429 with `retry_after`, throws `TransientError` with that backoff.
   - On 5xx, throws `TransientError` with default backoff.
   - On 401, throws `PermanentError`.
   - On network error, throws `TransientError`.

2. **Implementation.** `src/telegram.ts`:

```ts
export class TransientError extends Error { constructor(public backoff_secs: number, msg: string) { super(msg); } }
export class PermanentError extends Error {}

export interface InlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
}

export class TelegramClient {
  constructor(private token: string, private fetchImpl: typeof fetch = fetch) {}

  async sendMessage(chat_id: number | string, text: string, keyboard?: InlineKeyboard): Promise<void> {
    const body: Record<string, unknown> = { chat_id, text, parse_mode: "Markdown" };
    if (keyboard) body.reply_markup = keyboard;
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new TransientError(15, `network: ${(e as Error).message}`);
    }
    if (res.ok) return;
    if (res.status === 429) {
      const data = await res.json().catch(() => ({})) as { parameters?: { retry_after?: number } };
      throw new TransientError(data.parameters?.retry_after ?? 30, "rate limited");
    }
    if (res.status >= 500) throw new TransientError(30, `5xx: ${res.status}`);
    throw new PermanentError(`telegram error ${res.status}: ${await res.text()}`);
  }
}
```

3. **Tests pass. Commit.**

---

## Task 6: HTTP receiver (Hono) — accept clawhip webhooks

**Why:** clawhip routes events to `http://127.0.0.1:9501/<endpoint>` per Section 5.3 of the design. The bridge needs to validate, dedup, enqueue, and ACK quickly so clawhip's mpsc isn't blocked.

**Files:**
- Create: `scripts/telegram-bridge/src/server.ts`
- Modify: `scripts/telegram-bridge/src/index.ts`
- Create: `scripts/telegram-bridge/tests/server.test.ts`

**Steps:**

1. **Tests:** POST to `/webhook/info`, `/webhook/warn`, `/webhook/page`, `/webhook/critical`, `/webhook/gate` with valid/invalid payloads. Expect 200 + queue depth incremented for valid; 400 for invalid; 200 + no-op for duplicate event_id.

2. **Implement** `src/server.ts` with Hono routes. Each route validates with the corresponding schema, enqueues into `OutboundQueue` with the chat-id determined by route (`info` → unused for Phase B, `gate` → `TELEGRAM_CHAT_ID_GATES`, etc.), returns `{ accepted: true }`.

3. **Wire into `src/index.ts`:** boot order: load env → open queue → construct telegram client → mount Hono → start `Bun.serve` → log "listening" → on SIGTERM/SIGINT: stop accepting → drain queue (with timeout) → close db → exit 0.

4. **Tests pass. Commit.**

---

## Task 7: Outbound dispatcher loop

**Why:** A separate "delivery worker" pops from the queue and ships to Telegram. Decoupling receiver from sender keeps the receiver's tail latency low.

**Files:** modify `src/index.ts` to spawn a dispatcher worker; create `src/dispatcher.ts`.

**Steps:**

1. **Tests:** with a fake clock + injected `TelegramClient`, verify:
   - Empty queue → loop sleeps `500ms`, no API calls.
   - Item in queue → dispatched, marked delivered.
   - `TransientError` → marked failed with the right backoff_secs.
   - `PermanentError` → moved to a `parking_lot` table; logged with `error` severity.

2. **Implement** the dispatcher as `class Dispatcher { async tick() {...} async run() {... while !stop ... } }`. Run via `Bun.serve` background interval, or a self-rescheduling `setTimeout`.

3. **Tests pass. Commit.**

---

## Task 8: Gate file watcher

**Why:** The OMC dispatcher skill writes `<gate-id>.pending.json` files into `$OMC_STATE_DIR/gates/` when it wants to fire a gate. The bridge has to react quickly.

**Approach:** clawhip's webhook is the *fast path* (the OMC dispatcher skill emits a clawhip event AS WELL as writing the file). The file watcher is the *durable path* — if a clawhip webhook is dropped during a daemon restart, the watcher catches the file at startup. Both paths feed the same `enqueue(event_id, payload)` and dedup avoids double-sending.

**Files:** create `src/gate-watcher.ts`; create test.

**Steps:**

1. **Tests:** with a temp dir, write a `*.pending.json`, expect a callback fires with the validated `GatePending`. Existing files at startup are also picked up. Invalid JSON → logged + skipped.

2. **Implement** using `fs.watch` (recursive on macOS/Linux) + a 30-second polling sweep as fallback. Each sighting:
   - Parse + validate (zod).
   - Construct an `event_id` like `gate.pending:<gate_id>:<timeout_at>` (deterministic for dedup).
   - Push to `OutboundQueue` via the same path as a clawhip webhook would.

3. **Tests pass. Commit.**

---

## Task 9: Build the gate Telegram message + inline keyboard

**Why:** This is the actual UX — the message format from design §4.4 with three inline buttons.

**Files:** create `src/render-gate.ts`; create test.

**Steps:**

1. **Test** `renderGateMessage(gate: GatePending): { text: string; keyboard: InlineKeyboard }` produces:
   - Markdown text matching design §4.4 layout (title with run-id, summary block, key-decisions bullets, artifact path, diff URL if present, timeout countdown text).
   - Three inline buttons: `✅ Approve` (callback_data `<gate-id>:approve`), `❌ Reject` (`<gate-id>:reject`), `⏸ Defer 4h` (`<gate-id>:defer`).
   - Truncates `summary` over 1500 chars (Telegram message limit is ~4096; we want headroom for buttons + decisions).

2. **Implement.** Pure function, deterministic, easy to test.

3. **Tests pass. Commit.**

---

## Task 10: Telegram callback (button-tap) handler

**Why:** When the human taps a button, Telegram POSTs a callback to a webhook URL we registered with `setWebhook`. The bridge must validate, write `<gate-id>.decision.json`, and ACK to Telegram (or buttons spin).

**Files:** add handler to `src/server.ts`; create `src/handle-callback.ts`; create test.

**Steps:**

1. **Tests:**
   - `Approve` callback → writes `<gate-id>.decision.json` with `decision: "approved"`, ACKs Telegram with `answerCallbackQuery`.
   - `Reject` callback → first sends a `forceReply` Telegram message asking for the reason, then on the user's text reply, writes the decision with `comment`.
   - `Defer` callback → writes `decision: "deferred"`, sends acknowledgement message.
   - Atomic write pattern: write to `.tmp`, fsync, rename → guarantees OMC poller never sees a half-written file.

2. **Implement.** `src/handle-callback.ts` exports `handleCallback(payload, ctx)`. The reject flow uses a small in-memory pending-reply map keyed by `(chat_id, user_id)` → `gate_id`; on the user's next text message, we resolve, write decision, clear the map. (sqlite-backed for durability across restarts — bake this into Task 4's queue or add a small `pending_replies` table.)

3. **Wire** Telegram webhook URL with `bot.setWebhook`. For Mac dev: this requires Cloudflare Tunnel exposed at `argus-webhooks.<your-domain>.com/telegram` (Phase A installed cloudflared but didn't wire it; Task 11 below wires it for Phase B).

4. **Tests pass. Commit.**

---

## Task 11: Cloudflare Tunnel for Telegram webhook ingress

**Why:** Telegram requires a public HTTPS URL for webhook callbacks. Cloudflare Tunnel exposes our local bridge port without opening firewall holes or needing a static IP.

**Steps:**

1. **One-time:** authenticate cloudflared (`cloudflared tunnel login`).
2. Create a tunnel: `cloudflared tunnel create argus-bridge`.
3. Map a hostname: `cloudflared tunnel route dns argus-bridge argus-bridge.<your-domain>`.
4. Add a `~/.cloudflared/config.yml` mapping `argus-bridge.<your-domain>` → `http://127.0.0.1:9501`.
5. Author a `launchd/com.argus.cloudflared.plist` to run `cloudflared tunnel run argus-bridge`.
6. Register the Telegram webhook: `curl -fsS -X POST "https://api.telegram.org/bot${TOKEN}/setWebhook" -d url=https://argus-bridge.<your-domain>/telegram`.

Document each step in the runbook with what URL / tunnel ID / cert path resulted.

7. **Commit** the plist template + a `scripts/install-cloudflared.sh` helper.

---

## Task 12: Bridge launchd plist + start daemon

**Why:** The bridge needs to run unattended, like clawhip and `omc wait`.

**Files:** create `launchd/com.argus.telegram-bridge.plist`; modify `scripts/install-mac.sh` `section_launchd` to include it.

The plist follows the same pattern as Phase A's, but with `bun run scripts/telegram-bridge/src/index.ts` (or a built single-file binary if we choose to `bun build` it — recommended for VPS phase but optional on Mac).

Verify with `launchctl list | grep telegram-bridge` and `curl http://127.0.0.1:9501/health`.

**Commit** the plist + install-script changes.

---

## Task 13: clawhip routes for `gate.*` events → bridge

**Why:** Update `config/clawhip.toml.example` to add the new routes; re-run install script to regenerate `~/.clawhip/config.toml`.

```toml
[[routes]]
event = "gate.pending"
sink = "webhook"
url = "http://127.0.0.1:9501/webhook/gate"
format = "compact"

[[routes]]
event = "gate.timeout"
sink = "webhook"
url = "http://127.0.0.1:9501/webhook/gate"
```

Verify a synthetic `clawhip send --event "gate.pending" --message "test gate"` results in a Telegram message in `#argus-gates`.

**Commit.**

---

## Task 14: OMC dispatcher skill — gate state machine

**Why:** The OMC side of the contract. A Claude Code skill that runs at phase boundaries: writes `<gate-id>.pending.json`, emits a clawhip `gate.pending` event, polls `<gate-id>.decision.json` until present, applies the decision (proceed / re-architect / speculative-continue branch).

**Files:**
- Create: `skills/argus-router/SKILL.md`
- Create: `skills/argus-router/lib/gate-controller.ts` (or `.mjs` — the skill is invoked as a hook, runtime is whatever Claude Code runs)
- Create: `skills/argus-router/tests/gate-controller.test.ts`

**Steps:**

1. **Tests:**
   - `openGate(type, run_id, artifact_path)` writes a well-formed `*.pending.json`, calls `clawhip send --event gate.pending ... --webhook-payload <json>`, returns the `gate_id`.
   - `awaitDecision(gate_id, timeout_secs)` polls every 30s, returns the decision object when `*.decision.json` appears.
   - Timeout: emits `gate.timeout` clawhip event, returns `{ decision: "timeout" }`.
   - Reject: returns `{ decision: "rejected", comment }`.

2. **Implement.** Use the same zod schemas from the bridge (consider extracting a shared `argus-schemas` package — or duplicate for now and unify in Phase C cleanup).

3. **Wire into OMC's `Stop` hook** so phase boundaries automatically open the right gate type per the run's manifest.

4. **Speculative-continue branch** logic per design §4.6: if decision is `deferred`, OMC creates branch `speculative/<run-id>/<gate-id>` and proceeds; on later `approved` from a re-fired gate, branch promotes; on `rejected`, branch preserved but not merged.

5. **Tests + integration smoke. Commit.**

---

## Task 15: 24h smoke test with two gates

**Why:** End-to-end proof. Submit a small greenfield task that will trigger one PRD gate (Telegram) and one PR gate (GitHub). Sleep. Wake to approval prompts. Approve from phone.

Capture in runbook:
- Time from gate fire → Telegram notification visible.
- Time from approval tap → OMC proceeding with phase 2.
- Behavior of any unhappy paths you happen to hit (reject, defer).
- Total run wall-clock vs. estimated.

**No code commit unless the smoke surfaces bugs.** If bugs: fix in their respective Task N+, recommit with reference to the runbook line.

---

## Task 16: Final tidy + merge decision

Mirror Phase A's Task 12: append top-of-runbook verdict, update README's status line, decide merge to main with `superpowers:finishing-a-development-branch`.

Phase B is the bulk of the autonomy promise — be conservative on the merge. PASS-WITH-CAVEATS that defers, e.g., the rejection-comment durable storage to Phase C is fine; FAIL on anything that means a gate could be silently lost.

---

## Phase B definition of done

- [ ] Telegram bridge running under launchd, healthy for ≥48h.
- [ ] Cloudflare Tunnel up; Telegram webhook URL set.
- [ ] At least one PRD gate approved via inline buttons end-to-end.
- [ ] At least one Reject + comment cycle exercised.
- [ ] At least one Defer cycle (speculative branch created and either promoted or preserved).
- [ ] At least one GitHub PR review gate approved end-to-end.
- [ ] Outbound queue has held ≥1 row across a daemon restart and delivered after restart (durability proven).
- [ ] All bridge tests passing in CI-equivalent (`bun test`).
- [ ] Runbook section 'Phase B Verdict' filled in.
