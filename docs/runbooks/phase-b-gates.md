# Phase B Gates + Telegram Bridge — Runbook

Living log of the Phase B install on macOS. Append findings as you go.

## Status
- [ ] Task 1: Telegram bot creation (operator manual; deferred)
- [x] Task 2: Bridge project bootstrap + Bun install
- [x] Tasks 3,4,5: schemas + queue + telegram client (TDD)
- [ ] Tasks 6,7,8: HTTP receiver + dispatcher + gate watcher (TDD)
- [ ] Tasks 9,10: render + callback handler (TDD)
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
