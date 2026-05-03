# Phase B Gates + Telegram Bridge — Runbook

Living log of the Phase B install on macOS. Append findings as you go.

## Status
- [ ] Task 1: Telegram bot creation (operator manual; deferred)
- [x] Task 2: Bridge project bootstrap + Bun install
- [x] Tasks 3,4,5: schemas + queue + telegram client (TDD)
- [x] Tasks 6,7,8: HTTP receiver + dispatcher + gate watcher (TDD)
- [x] Task 9: index wire-up (server + dispatcher + gate-watcher with graceful drain)
- [ ] Task 10: callback handler (TDD)
- [ ] Tasks 11,12,13: Cloudflare Tunnel + bridge launchd + clawhip routes
- [ ] Task 14: OMC dispatcher skill (gate state machine)
- [ ] Tasks 15,16: 24h smoke + verdict (operator manual)

## Findings (chronological)

### 2026-05-03 — Task 2: Bridge project bootstrap + Bun install
- Added `section_bun()` to `scripts/install-mac.sh`, wired into `main()` between `section_brew_packages` and `section_omc`. Idempotent: skips install if `bun` already on PATH; sources `$HOME/.bun/_bun` after install so the rest of the script sees the binary.
- Installed Bun on this host via `curl -fsSL https://bun.sh/install | bash` — version `1.3.13` on PATH at `~/.bun/bin/bun`. Installer auto-appended `~/.bun/bin` to `~/.zshrc`.
- Created `scripts/telegram-bridge/` Bun project: `package.json`, `tsconfig.json` (strict + `noUncheckedIndexedAccess`), `biome.json`, `.gitignore`, `src/index.ts`, `tests/health.test.ts`, `README.md`.
- **Robust-long-term decision:** switched from `better-sqlite3` (planned) to `bun:sqlite` (Bun built-in) — eliminates a native-build dependency. Plan reference text in README updated to reflect this.
- **Robust-long-term decision:** dropped `vitest` from the dep list; using `bun test` (built-in) for a Bun-first project — fewer deps, faster startup, watch mode included.
- `src/index.ts` exports `app` and guards `Bun.serve` behind `if (import.meta.main)` so test imports don't bind ports. Health endpoint returns `{status, name, version, uptime_secs}`.
- **tsconfig fix during Task 2:** added `"noEmit": true` and `"allowImportingTsExtensions": true` so `tsc --noEmit` accepts the test file's `.ts` import specifier (which `bun test` requires).
- Verification:
  - `bash -n scripts/install-mac.sh` → exit 0 (clean).
  - `bun --version` → `1.3.13`.
  - `bun install` → `46 packages installed [2.85s]`.
  - `bun run typecheck` → no errors.
  - `bun test` → `1 pass / 0 fail / 5 expect() calls`.

### 2026-05-03 — Tasks 3, 4, 5: schemas, queue, telegram client (TDD)
- All three tasks landed as separate commits, each one a tests-first cycle (red → green → format → commit).
- **Task 3 (schemas):** `src/schemas.ts` + 29 tests (`tests/schemas.test.ts`). Five zod schemas: `Severity`, `ClawhipWebhookEvent` (`.passthrough()` for forward-compat with future clawhip fields, `event_id` non-empty for dedup), `TelegramCallbackPayload`, `GatePending` (with `key_decisions` defaulted to `[]`), `GateDecision`. Tests cover happy path, missing required fields with explicit `path` assertions, enum rejection, URL/datetime validation, passthrough preservation, and TS type round-trips.
- **Task 4 (queue):** `src/queue.ts` + 12 tests (`tests/queue.test.ts`). `OutboundQueue` over `bun:sqlite` (built-in — no native build). Schema: `outbound` (UNIQUE `event_id` for dedup, `next_attempt_at` for visibility timeouts) + `parking_lot` (terminal failures). `enqueue` returns `{ id, created }`; `parkPermanent` is wrapped in `db.transaction` so a crash mid-park can't lose or duplicate the row. Tests use `mkdtempSync` per-test for clean isolation, verify durability across close/reopen, exercise concurrent enqueues (50 parallel ops, all rows accounted for), and assert WAL mode is active via a separate read probe.
- **Task 5 (telegram client):** `src/telegram.ts` + 19 tests (`tests/telegram.test.ts`). `TelegramClient` with three methods (`sendMessage`, `answerCallbackQuery`, `setWebhook`) and shared `post()` classifier. Errors split into `TransientError` (carries `backoff_secs`; 429 with `parameters.retry_after`, 429 default 30, 5xx → 30, network throw → 15) vs `PermanentError` (401 → "invalid bot token", 4xx with description). Tests use a single `mockFetch(responder)` factory that captures URL/method/headers/body for assertions and never touches the network — `https://api.telegram.org` only appears as a constant the tests assert against, never as a real fetch destination.
- **Tradeoffs / design choices made within the spec's bounds:**
  - Dedup keyed on `event_id` (UNIQUE constraint) so re-enqueues are O(1) idempotent. The `created` flag in the result lets the HTTP receiver in Task 6 distinguish "first time" from "duplicate ack" cleanly.
  - Mock fetch returns `impl as unknown as typeof fetch` because Bun's `typeof fetch` includes a static `preconnect` member; tests never call it, so the cast is local and well-commented.
  - Permanent error policy: 403 (bot blocked by user) is classified as Permanent, matching 401/400; the dispatcher will park these.
  - `markFailed` does not park automatically — Task 7's dispatcher loop owns the policy of "after N retries, park". Keeping queue.ts pure-mechanism, dispatcher pure-policy.
- Verification (from `scripts/telegram-bridge/`):
  - `bun run typecheck` → exit 0, silent.
  - `bun test` → `61 pass / 0 fail / 115 expect() calls` across 4 files (health + schemas + queue + telegram).
  - `bun run lint` → `Checked 8 files`, no errors, no warnings.
- Commits (4 total this session):
  - `phase-b: define event schemas with zod (clawhip + telegram + gate)`
  - `phase-b: durable sqlite outbound queue with dedup, retry backoff, parking lot`
  - `phase-b: telegram API client with transient/permanent error classification`
  - `phase-b: runbook entry for tasks 3-5 (schemas, queue, telegram client)`

### 2026-05-03 — Tasks 6, 7, 8, 9: HTTP receiver, dispatcher, gate watcher, index wire-up (TDD)
- All four landed as separate red→green commits.
- **Task 6 (HTTP receiver):** `src/server.ts` with `buildApp({queue, log})` factory so tests inject deps; `src/index.ts` is now the only place `Bun.serve` is called. Routes: `GET /health`, `POST /webhook/{info,warn,page,critical,gate}`, `POST /telegram` (Task 10 will fill the handler). Each `/webhook/*` parses JSON → `ClawhipWebhookEvent.safeParse` → 400 with structured zod issues on fail → enqueue with `tier` hint baked into the queued payload (`{tier, event}` shape — `QueuedPayload`). Returns `{accepted, queued_id, deduplicated}` so the receiver clearly distinguishes first-time enqueues from dedup hits. `verifyTelegramSecret` is a pass-through stub for Task 6; full HMAC check lands in Task 10. 14 new tests; existing `health.test.ts` migrated off `import { app } from "../src/index.ts"` (which would now eagerly open a sqlite DB) onto a `buildApp({tempQueue, silentLog})` fixture.
- **Task 7 (dispatcher):** `src/dispatcher.ts` with `class Dispatcher` exposing `tick(): Promise<TickResult>` for unit tests and `run(signal: AbortSignal)` for the production loop. Policy split: `TransientError` → `markFailed(backoff_secs)`; `PermanentError` → `parkPermanent`; render returning `null` → park immediately; after `maxAttemptsBeforePark` (default 5) consecutive transients → park. The render function is injected (`RenderFn` type) so Task 9 can plug in the rich gate-message renderer without changing the dispatcher; for now `src/render.ts` exports `defaultRender` that picks `chat_id` from `chatIds` based on `tier` and uses `event.message` verbatim. `run()` uses `await sleep(IDLE_SLEEP_MS=500, signal)` between empty ticks with a clean abort path (timeout cleared, listener removed) so SIGTERM doesn't leak handles. 11 new tests. Mocked telegram client with a `stubTelegram(impl)` factory mirroring the pattern from `telegram.test.ts`.
- **Task 8 (gate watcher):** Added `chokidar@^5` (the only new runtime dep this session). `src/gate-watcher.ts` exposes `class GateWatcher` with `start(signal)` (resolves once chokidar's `ready` fires — i.e. after the startup sweep is complete) and `stop()`. Each `*.pending.json` is read → `JSON.parse` → `GatePending.safeParse`; valid gates get a deterministic `event_id = "gate.pending:" + gate_id` so re-enqueues dedup at the queue layer. Payload is shaped as a `ClawhipWebhookEvent` with `event: "gate.pending"`, `severity: "info"`, `tier: "gate"` so it flows through the same render path as a clawhip-webhook-emitted gate event would. Non-`*.pending.json` files (incl. `*.decision.json` written by Task 10 and stray `foo.txt`) are ignored. Malformed JSON is logged at warn and skipped — watcher keeps running. 7 new tests using real fs writes + a 300ms wait for chokidar's `awaitWriteFinish` debounce.
- **Task 9 (index wire-up):** `src/index.ts` constructs queue + telegram + chatIds + dispatcher + gate-watcher from env, mounts the app, and runs the graceful drain on SIGTERM/SIGINT: `server.stop()` (no new webhooks) → `stopController.abort()` (dispatcher + watcher exit) → `gateWatcher.stop()` (close chokidar) → `await dispatcherPromise` (drain in-flight) → `queue.close()` → `process.exit(0)`. All env vars from spec wired: `BRIDGE_PORT`, `BRIDGE_HOST`, `LOG_LEVEL`, `QUEUE_DB_PATH` (default `$HOME/.argus/state/bridge-queue.sqlite`, parent `mkdir -p`'d), `OMC_GATES_DIR` (default `$HOME/.claude/omc/gates`, also `mkdir -p`'d), `TELEGRAM_BOT_TOKEN` (required), `TELEGRAM_CHAT_ID_{INFO,WARN,PAGE,CRITICAL,GATES}` (required, integer-validated). `import.meta.main` guard preserved so test files importing `index.ts` (none currently — health.test.ts uses `buildApp` directly) wouldn't bind ports.
- **Tradeoffs / design choices made within the spec's bounds:**
  - **Tier in payload, not in queue schema:** the HTTP route (`/webhook/info` etc.) and the gate watcher both write `{tier, event}` into the JSON payload column rather than introducing a new sqlite column. Keeps the `OutboundQueue` agnostic to routing concerns; the dispatcher's render function owns the `tier → chat_id` translation.
  - **Mockable dispatcher:** `tick()` is a pure single-step function (peek → render → send → mark/park) with no internal sleeping, which makes it easy to unit-test without fake clocks. `run()` adds the loop and abort-aware sleep on top. Tests mock the `TelegramClient` via a `stubTelegram` factory rather than mocking `fetch` (one level higher than the telegram-client tests, which is appropriate for a higher-level component test).
  - **`defaultRender` is the simplest possible:** picks chat by tier, uses `event.message` verbatim, returns `null` for malformed payloads (so the dispatcher parks). Task 9-spec-replacement (the rich gate-card renderer with markdown body + inline keyboard) will replace it for `tier === "gate"`.
  - **chokidar over `fs.watch`:** macOS recursive `fs.watch` returns paths relative to the watched dir but Linux's `inotify`-backed watch coalesces events differently; chokidar normalizes both and adds `awaitWriteFinish` for partially-written files. Single new dep, well worth it for a watcher this small.
  - **Gate watcher startup sweep via chokidar's own `ready` event:** rather than implementing a separate `readdir` + manual loop, we use `ignoreInitial: false` and resolve `start()` after `ready` fires. chokidar emits `add` for every existing file before `ready`, giving us the sweep for free.
- Verification (from `scripts/telegram-bridge/`):
  - `bun run typecheck` → exit 0, silent.
  - `bun test` → `93 pass / 0 fail / 199 expect() calls` across 7 files (health + schemas + queue + telegram + server + dispatcher + gate-watcher).
  - `bun run lint` → `Checked 15 files`, no errors, no warnings.
- Commits this session:
  - `phase-b: hono HTTP receiver — validates and enqueues webhook events`
  - `phase-b: dispatcher loop with retry/park policy and tier-aware routing`
  - `phase-b: chokidar-based gate file watcher with idempotent enqueue`
  - `phase-b: wire receiver + dispatcher + gate-watcher in index.ts; runbook`
