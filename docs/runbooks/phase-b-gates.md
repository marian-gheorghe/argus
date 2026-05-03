# Phase B Gates + Telegram Bridge — Runbook

Living log of the Phase B install on macOS. Append findings as you go.

## Status
- [ ] Task 1: Telegram bot creation (operator manual; deferred)
- [x] Task 2: Bridge project bootstrap + Bun install
- [x] Tasks 3,4,5: schemas + queue + telegram client (TDD)
- [x] Tasks 6,7,8: HTTP receiver + dispatcher + gate watcher (TDD)
- [x] Task 9 (rich gate-message renderer with markdown + inline keyboard)
- [x] Task 10: callback handler (TDD) — atomic decision write + HMAC + reject reply flow
- [x] Tasks 11,12,13: Cloudflare Tunnel + bridge launchd + clawhip routes
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

### 2026-05-03 — Tasks 9, 10: rich gate renderer + telegram callback handler (TDD)

Three review-followup fixes from Tasks 6-8 review landed in a small first commit before the main work:
- **Fix 1 (graceful drain):** `index.ts` shutdown now `await server.stop(true)` so in-flight HTTP requests drain before the dispatcher and queue are torn down. Closes a race where a clawhip POST arriving exactly at SIGTERM could be killed mid-enqueue.
- **Fix 3 (lazy queue construction):** the top-level `OutboundQueue` construction was moved inside the `import.meta.main` guard. A bare `import "./index.ts"` no longer eagerly opens a sqlite file. The unused top-level `app`/`queue`/`log` re-exports were dropped — tests use `buildApp` directly.
- **Fix 2 (fail-closed HMAC stub):** rolled into the Task 10 commit — the stub middleware was replaced with a real constant-time HMAC verification rather than retaining an interim "set-but-not-impl → 500" stub.

**Task 9 (rich gate renderer):** `src/render-gate.ts` exposes a pure `renderGateMessage(event, chat_id_gates)` returning the design §4.4 card body (header line with title + run-id, summary section, optional key-decisions bullets, artifact path, diff line, formatted timeout) plus a 3-button inline keyboard (`gate_id:approve`, `gate_id:reject`, `gate_id:defer`). Defensive null returns: missing/empty `gate_id`, `summary`, `artifact_path`, or `timeout_at`, an unparseable `timeout_at`, or a non-array `key_decisions` all return null so the dispatcher parks. Console.warn names the specific field for the operator. Long summaries (>1500 chars) are character-truncated with a `…(truncated)` suffix; phase-C may upgrade to markdown-aware truncation if it surfaces. `src/render.ts` exports a top-level `render` symbol that dispatches on `tier === "gate"` to the new renderer and falls back to `defaultRender` for everything else; `src/index.ts` is wired to `render` while dispatcher tests still inject their own trivial render so the swap-in is transparent. 18 new render-gate tests.

**Task 10 (callback handler):** `src/handle-callback.ts` exposes `buildCallbackHandler({queue, telegram, gatesDir, log, allowedChatId, expectedSecret})` returning a Hono handler wired into `POST /telegram`.
- Accepts two Telegram Update shapes: `{callback_query}` (button tap) and `{message}` (text reply, used to capture the rejection reason for force_reply prompts).
- Approve / defer → atomic decision-file write (tmp + `fsyncSync(fd)` + `renameSync`, mode 0600) + `answerCallbackQuery`. The fsync forces data to stable storage before the rename so a crash mid-rename can't lose the operator's decision. **NON-NEGOTIABLE** per the spec; verified in code, not just claimed.
- Reject → `sendMessage` with `force_reply: true`, insert `pending_replies` row keyed on `(chat_id, user_id)` with the prompt's `message_id`, `answerCallbackQuery` "Awaiting reason". Then a subsequent `{message}` arriving at the same endpoint that matches an existing pending row finalizes the rejection as `decision: "rejected"` with the typed text as `comment`, deletes the pending row.
- Allowlist: only `chatIds.gates` accepted; foreign chats → 403.
- HMAC: `expectedSecret` (from `TELEGRAM_WEBHOOK_SECRET`) gates the route via **constant-time string compare** against `X-Telegram-Bot-Api-Secret-Token` — no `===` on the secret string. When env unset, the header is ignored (dev/local mode).

**Pending-replies state lives in the same sqlite DB as the outbound queue:** added a new `pending_replies` table to `OutboundQueue` with `UNIQUE(chat_id, user_id)` (so re-rejecting replaces the prior row) and four methods: `insertPendingReply` (REPLACE on conflict), `findPendingReply`, `deletePendingReply`, `expirePendingReplies(older_than_secs)`. Co-locating in the same DB keeps the bridge's persistent state to a single file and lets a future watchdog reuse the existing schema-migration path. 6 new queue tests.

`src/server.ts` `buildApp` now optionally takes `telegram`, `gatesDir`, `chatIds`, `expectedSecret`. Wires the callback handler when present; returns 503 on `/telegram` when any are missing — loud-misconfig instead of silent 404. The existing `/webhook/*` and `/health` tests continue to pass with the minimal `{queue, log}` deps.

`src/telegram.ts` `sendMessage` gains an optional `{force_reply}` opts arg (emits `reply_markup: {force_reply: true}`).

`src/index.ts` threads `telegram`, `gatesDir`, `chatIds`, and `TELEGRAM_WEBHOOK_SECRET` into `buildApp`. All env reads centralized at the boundary; no `process.env` inside business logic.

**Tradeoffs / design choices made within the spec's bounds:**
- **Single-endpoint reject flow:** the rejection-reply message is handled at the same `/telegram` endpoint as the button tap. The spec mentioned a possible sibling endpoint; we kept it unified because Telegram's webhook posts both Update kinds to the same configured URL anyway, and dispatching by Update shape inside the handler keeps the routing logic in one place.
- **`run_id` in decision file = `gate_id` placeholder:** the bridge doesn't have the `run_id` at decision time (it would need to read the `<gate_id>.pending.json` to recover it). For Phase B we set `run_id = gate_id` and rely on OMC to reconcile via `gate_id` (the unique key). Phase C should upgrade to read the `.pending.json` on decision so the decision file carries the true run_id for downstream observability.
- **Pending-replies table in OutboundQueue, not a separate class:** the spec offered "OutboundQueue or a new small PendingReplies class". We kept it on `OutboundQueue` because the data lives in the same sqlite file already; introducing a second class for four methods on three columns would have been cosmetic separation only.
- **`force_reply` API:** added a fourth optional arg to `TelegramClient.sendMessage` rather than a new method, because every other field (chat_id, text, keyboard, parse_mode) is already handled by `sendMessage` and the sole new consideration is the `reply_markup` shape.
- **HMAC constant-time compare:** explicit char-by-char XOR loop in JS-land; we do not use `crypto.timingSafeEqual` because the input strings come from headers (variable-length, untrusted) and constructing `Buffer`s for length-mismatched inputs is itself observable. The early `length !== length` check is intentional — Telegram's secret_token is fixed-length per setWebhook, so length mismatch always means tampering rather than an accidental info leak.

Verification (from `scripts/telegram-bridge/`):
- `bun run typecheck` → exit 0, silent.
- `bun test` → `129 pass / 0 fail / 292 expect() calls` across 9 files (was 93 across 7).
- `bun run lint` → `Checked 19 files`, no errors, no warnings.

Commits this session:
- `phase-b: graceful drain + lazy queue construction (review followups)`
- `phase-b: rich gate-message renderer with markdown + inline keyboard`
- `phase-b: telegram callback handler — atomic decision writes + HMAC + reject reply flow`
- `phase-b: runbook entry for tasks 9-10 (gate render + callback handler)`

### 2026-05-03 — Tasks 11, 12, 13: Cloudflare Tunnel + bridge launchd + clawhip routes

Five small commits stitching together the deployment side of Phase B. No new business logic — pure plumbing so the operator can `bash scripts/install-mac.sh` and end up with three healthy launchd daemons (clawhip, omc-wait, telegram-bridge) plus an optional fourth (cloudflared) once the one-time tunnel handshake is done.

**Task 11 (cloudflared tunnel for Telegram webhook ingress):**

- New `scripts/install-cloudflared.sh` — operator runs this ONCE on each host; idempotent so re-runs are safe. Steps: `cloudflared tunnel login` (gated on absence of `~/.cloudflared/cert.pem`); `cloudflared tunnel create argus-bridge` (gated on `tunnel list | awk` match); `cloudflared tunnel route dns argus-bridge $ARGUS_TUNNEL_HOSTNAME` (Cloudflare upserts so re-runs are no-ops); render `~/.cloudflared/config.yml` via heredoc + atomic tmp→mv with chmod 600; persist `ARGUS_TUNNEL_ID` into `~/.argus/secrets.env` (grep+replace if stale, append if missing). The script ends by printing the exact `curl ... setWebhook` command the operator needs to run after `install-mac.sh` brings the bridge up.
- New `launchd/com.argus.cloudflared.plist` template with `__CLOUDFLARED_BIN__`, `__USER_PATH__`, `__HOME__` placeholders. ProgramArguments runs `cloudflared tunnel --config $HOME/.cloudflared/config.yml run argus-bridge` — credentials come from `~/.cloudflared/<uuid>.json` written during `tunnel login`, so no token in the plist.
- New `section_cloudflared` in `install-mac.sh`. Crucially, this section is *skip-when-not-configured*: if `cloudflared` isn't on PATH OR `~/.cloudflared/config.yml` doesn't exist, it logs and returns 0 instead of failing. That preserves the property that `install-mac.sh` is safe to re-run before the operator has done the interactive `tunnel login`. Same atomic-write + plutil-lint + placeholder-residue check as `section_launchd`.

**Task 12 (telegram-bridge launchd plist):**

- New `launchd/com.argus.telegram-bridge.plist` template. Five placeholders: `__BUN_BIN__`, `__BRIDGE_DIR__`, `__USER_PATH__`, `__HOME__`, `__OMC_STATE_DIR__`. The plist's `ProgramArguments` invokes a thin wrapper (`run.sh`) rather than `bun` directly so secrets don't have to be embedded in the launchd config — they live in `$HOME/.argus/secrets.env` (chmod 0600) and are sourced at process boot. The plist DOES carry the non-secret env: `BRIDGE_PORT=9501`, `BRIDGE_HOST=127.0.0.1`, `LOG_LEVEL=info`, `NODE_ENV=production`, `OMC_GATES_DIR`, `QUEUE_DB_PATH`. `KeepAlive=true` so launchd respawns the bridge on crash; `WorkingDirectory` set so relative paths inside the bridge (none currently, but defensive) resolve correctly.
- New `scripts/telegram-bridge/run.sh` (committed `+x`). Sources `~/.argus/secrets.env`, validates that all seven required env vars are present (`TELEGRAM_BOT_TOKEN`, four `TELEGRAM_CHAT_ID_*`, `TELEGRAM_WEBHOOK_SECRET`), then `exec`s `bun run src/index.ts`. Resolves bun via `$BUN_BIN` (set by the plist) → `$HOME/.bun/bin/bun` → `command -v bun`, in that order — the precedence lets a developer override the binary via env in dev without touching the plist.
- New `section_bridge` in `install-mac.sh`, wired into `main()` between `section_hook_bridge` and `section_launchd`. Creates `~/.argus/state` (queue's sqlite dir) and `$OMC_STATE_DIR/gates` (gate-watcher's input dir) defensively — OMC will create the latter too but redundancy is harmless. Atomic-write + plutil-lint + placeholder-residue check, same pattern as `section_launchd`.

**Task 13 (clawhip routes update):**

- `config/clawhip.toml.example` extended with five new routes — `gate.pending` → bridge `/webhook/gate`, `gate.timeout` → bridge `/webhook/page`, `gate.approved` → Discord `runs-info`, `agent.failed` → Discord `runs-info`, `omc.rate-limit-pause` → Discord `runs-info`. Existing `git.commit`, `agent.*`, `session.*` routes preserved verbatim. The bridge URLs are hardcoded localhost (`http://127.0.0.1:9501`) so no token substitution is needed — `section_clawhip_config`'s existing `sed s|REPLACE_WITH_...|...|` pass continues to handle just the Discord webhooks.

**Wiring order in `install-mac.sh::main()`** (after this session):

1. `section_brew_packages` (cloudflared installed here)
2. `section_bun`
3. `section_omc`
4. `section_clawhip`
5. `section_clawhip_config`
6. `section_hook_bridge`
7. `section_bridge` (NEW — launchd plist for the bridge)
8. `section_launchd` (existing — clawhip + omc-wait)
9. `section_cloudflared` (NEW — last, because cloudflared depends on the bridge being installed so when it starts it has a backend to forward to)

**Tradeoffs / design choices:**

- **Wrapper script over launchd-embedded secrets:** the launchd plist sits at `$HOME/Library/LaunchAgents/com.argus.telegram-bridge.plist` (mode 0644 by convention). Embedding the bot token there would expose it to anything in the user session. The wrapper hops through a chmod-0600 dotfile so the secret distribution remains a single file even though the daemon system reads from the world-readable plist.
- **`section_cloudflared` skip-when-not-configured:** the alternative was to fail the install if the operator hadn't run `install-cloudflared.sh` yet. Rejected — `install-mac.sh` is meant to be re-runnable in any state, and `cloudflared tunnel login` requires interactive browser auth which we can't automate. Skipping with a clear log message is the right move; the operator runs `install-mac.sh` again after `install-cloudflared.sh` and the section picks up.
- **Tunnel ID persisted into `secrets.env`:** strictly speaking the launchd plist doesn't need it (we use `cloudflared tunnel ... run argus-bridge` by name, which `cloudflared` resolves via local credentials). But persisting it gives operator-readable evidence that setup completed and gives Phase C/D tooling (e.g. a tunnel-health probe) a stable reference point.
- **`gate.timeout` → `/webhook/page`, not `/webhook/critical`:** a timeout is a paged human decision, not a system-down emergency. Reserving CRITICAL for things that imply harness loss aligns with the design's tier semantics. Phase C may revisit if operators report missing the buzzer when a gate ages out at 03:00.
- **`gate.approved` to Discord, not Telegram:** the operator already saw the approval (they tapped the button); a second Telegram echo would be noise. Discord's `runs-info` is the audit trail.

**Verification:**

- `bash -n scripts/install-mac.sh` → exit 0.
- `bash -n scripts/install-cloudflared.sh` → exit 0.
- `bash -n scripts/telegram-bridge/run.sh` → exit 0.
- `plutil -lint launchd/com.argus.cloudflared.plist` → OK.
- `plutil -lint launchd/com.argus.telegram-bridge.plist` → OK.
- `bun test` (from `scripts/telegram-bridge/`) → `129 pass / 0 fail / 292 expect() calls` (unchanged from Task 10).

**Operator next-steps (deferred to Tasks 15-16):**

1. Run `ARGUS_TUNNEL_HOSTNAME=argus-bridge.<your-domain> bash scripts/install-cloudflared.sh` once.
2. Re-run `bash scripts/install-mac.sh` (now `section_cloudflared` will pick up the config).
3. `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.argus.{telegram-bridge,cloudflared}.plist` to start the daemons.
4. Register the Telegram webhook with the `curl ... setWebhook` command printed at the end of `install-cloudflared.sh`.
5. Smoke-test by writing a fake `*.pending.json` into `$OMC_STATE_DIR/gates/` and confirming a Telegram message arrives.

**Open concerns flagged for Phase C:**

- The `cloudflared tunnel list` parser uses `awk '$2==name'` — Cloudflare's CLI output format is undocumented and could change. A future hardening pass should switch to `--output json` if the binary supports it.
- `section_cloudflared` doesn't `launchctl bootstrap` the plist (matches `section_launchd`'s pattern). The operator does this manually post-install. Phase D may automate via `launchctl bootstrap` with a `print` probe to check first.

Commits this session (5 total):
- `phase-b: install-cloudflared.sh helper for one-time tunnel setup`
- `phase-b: cloudflared launchd plist + section_cloudflared (skip-when-not-configured)`
- `phase-b: telegram-bridge launchd plist + run.sh wrapper + section_bridge`
- `phase-b: clawhip routes for gate.* and warn-tier events`
- `phase-b: runbook entry for tasks 11-13`

### 2026-05-03 — Task 14: argus-router skill (OMC dispatcher / gate state machine)

Closes the gate contract on the OMC side. The telegram-bridge has been
sitting waiting for `<gate-id>.pending.json` files since Task 8; this task
ships the producer of those files plus the `awaitDecision` polling loop and
the speculative-continue branch helper. The skill lives at
`skills/argus-router/` as a standalone Bun + TS project (mirrors
`scripts/telegram-bridge/`'s tooling so an OMC Stop hook can `import` from
it directly without a build step).

**Layout:**

```
skills/argus-router/
├── SKILL.md                          # frontmatter (name, triggers, source) + ~290-line body
├── lib/
│   ├── gate-types.ts                 # zod schemas (duplicated from bridge for now)
│   └── gate-controller.ts            # the state machine
├── tests/
│   └── gate-controller.test.ts       # 16 tests, real fs against mkdtempSync, real git in temp dir
├── package.json                      # zod dep; biome, @types/bun, typescript dev deps
├── tsconfig.json                     # strict + noUncheckedIndexedAccess (mirrors bridge)
├── biome.json                        # recommended rules + 100-col + 2-space (mirrors bridge)
├── .gitignore                        # ignores node_modules, sqlite, .env; negates !bun.lock
└── bun.lock                          # committed for VPS reproducibility (Phase C)
```

**Surface area (`GateController`):**

- `openGate(opts)` — atomic `tmp+fsync+rename` write of `<gate-id>.pending.json` (mode 0o600), then dual-emit a `gate.pending` clawhip event.
- `awaitDecision(opts)` — poll for `<gate-id>.decision.json` every `pollIntervalMs` (default 30s); deadline read from `pending.timeout_at` so a controller restart preserves the original timeout. On deadline elapse: emit `gate.timeout` (severity=page) and return `{decision: "timeout"}`. AbortSignal-aware: aborting mid-sleep throws AbortError without waiting out the poll interval.
- `fireGate(opts)` — convenience: open + await chained.
- `createSpeculativeBranch(opts)` — for `deferred` outcomes, branch `speculative/<run_id>/<gate_id>` from HEAD via `git branch` (not checkout). Idempotent: re-entry returns `{created: false}`.

**`gate_id` shape: `<type>-<run_id>-<6 hex>`.**

- Type (`PRD` / `code-review` / `final-integration`) for operator orientation + clawhip routing.
- `run_id` to scope all of a single agent run's gates.
- 6 hex chars (truncated `crypto.randomUUID()`) so re-opening the same phase produces a fresh file. Reusing a `gate_id` would silently dedupe-drop in the bridge's queue (the queue's UNIQUE(event_id) — `gate.pending:<gate_id>` — guards against double-processing but also means we can't reuse the key for a second round).

**`clawhipEmit` injection contract** (the design choice that makes the dual-emission cleanly testable):

- `undefined` (production default) — shell out to `clawhip send` via `Bun.spawn`. Phase A's `install-mac.sh::section_clawhip` guarantees `clawhip` is on PATH.
- function — invoke directly. Tests use this; future hosts can use it to swap transports without touching the controller.
- `null` — explicitly skip emission. The pending.json is on disk anyway, so the bridge's chokidar watcher sees the gate. Useful for testing the durable-path fallback in isolation.

If the shellout fails (binary missing, exit non-zero) the controller logs `console.warn` and continues — losing clawhip-side emit is degraded-but-correct because the file-watcher path is the durable fallback. This is the property design §1's dual-emission promised; verifying it cost no extra logic since `Bun.spawn` already gives us non-throwing exitCode access.

**Speculative-continue branch idempotency:** `git branch --list <name>` prints the branch on stdout if it exists, empty otherwise (always exit 0). Splitting "existence check" from "create" lets us return `{created: false}` cleanly rather than relying on parsing `git branch <name>`'s "fatal: A branch named ... already exists" error. The branch is created from HEAD without checkout — workers stay on their per-worker branches; the orchestrator promotes/preserves the speculative branch later per design §4.6.

**Schema duplication (intentional, for now):** `lib/gate-types.ts` re-defines `GatePending`/`GateDecision` with the same zod shapes as `scripts/telegram-bridge/src/schemas.ts`. The duplication lets each project install + typecheck + test independently. Phase C cleanup task: extract to a shared `argus-schemas` package and have both projects depend on it. The skill's tests round-trip through both schemas (write a pending → re-parse with `GatePending`; bridge writes a decision → re-parse with `GateDecision`) so any future drift gets caught.

**Tests (16, all real-fs / real-git):**

Coverage groups:
- `openGate`: writes valid GatePending JSON, calls injected emit with `gate.pending`, returns unique gate_ids across calls (25-iteration collision check), file mode is 0o600, no `.tmp.<pid>` artifacts left behind, `clawhipEmit: null` skips emit but still writes the file, custom `timeout_secs` reflected in `timeout_at`.
- `awaitDecision`: returns parsed decision when file appears mid-poll, returns `{decision: "timeout"}` + emits `gate.timeout` after deadline, honors AbortSignal (rejects with AbortError, no extra emits), rejected decision with comment round-trips intact.
- `fireGate`: happy path (open + await + return decision; uses a watch-and-write coroutine to drop the decision file after openGate runs).
- `createSpeculativeBranch`: creates the branch in a fresh `git init` repo, idempotent on second call.
- Schema sanity: emitted clawhip payload contains the GatePending fields the bridge needs, written decision file validates against `GateDecision`.

Tests use `mkdtempSync` per-test with `rmSync` cleanup in `afterEach` so a failed run doesn't pollute `/tmp`. Real `git` interactions go through `Bun.spawnSync` against an isolated repo (no risk of touching the actual worktree — the test sets up its own `git init` + `commit` in tmpdir).

**Tradeoffs / design choices:**

- **Why a class (`GateController`) for what's mostly stateless?** Symmetry with the bridge's `OutboundQueue` / `GateWatcher` / `Dispatcher`, and futureproofing for Phase C state (e.g. an in-memory `Map<gate_id, AwaitController>` so `awaitDecision` calls can be re-entrant + cancellable from a single host). The class costs nothing now and keeps the option open.
- **`AwaitDecisionExtras._timeoutAtMs` (underscore-prefixed, internal):** lets `fireGate` pass through the deadline it already computed without re-reading the pending file. Documented as private; tests don't use it.
- **`GateDecisionOrTimeout` discriminated union (not a throw on timeout):** timeouts are an *expected* outcome (operator on holiday), not an error. Forcing the caller into `try/catch` would mix error-handling with control-flow. The exhaustive switch in OMC's hook is the contract that ensures future variants get handled.
- **`severity: "page"` on `gate.timeout` (not `critical`):** mirrors Task 13's clawhip routes — a timeout is a paged human decision, not a system-down event. Reserving `critical` for harness regressions / cost-kills aligns with the tier semantics in design §5.
- **AbortSignal in `awaitDecision`, not `openGate`:** opening is a few syscalls + one shellout; the abort surface that matters is the long polling loop. Adding it everywhere would be bikeshedding.

**Verification (from `skills/argus-router/`):**

- `bun install` → `8 packages installed [596ms]`.
- `bun run typecheck` → exit 0, silent.
- `bun test` → `16 pass / 0 fail / 59 expect() calls` across 1 file (`tests/gate-controller.test.ts`).
- `bun run lint` → `Checked 3 files`, no errors, no warnings.

**Wiring with the rest of Phase B:**

The skill is the *producer* of the contract the bridge has been waiting for. End-to-end now: this skill writes `gate_X.pending.json` → bridge's `GateWatcher` (chokidar) sees it → enqueues via `OutboundQueue` → `Dispatcher` posts to Telegram → operator taps a button → bridge's `handle-callback.ts` writes `gate_X.decision.json` → this skill's `awaitDecision` poll picks it up → returns to OMC. Plus the parallel clawhip path for real-time freshness. Both paths through the bridge's `gate.pending:<gate_id>` event_id dedup so we can't double-render.

**Open concerns flagged for Phase C:**

- **No persistent rejection-comment storage.** A reject-then-redo round-trip puts the comment in `decision.json` until OMC's orchestrator reads it. If OMC crashes before reading, the comment lives only in the file (which could be GC'd by a later Phase C cleanup task). Phase C: per-run rejection history file.
- **No cost ceiling on speculative branches.** A defer can keep workers running for hours on a branch that may never merge. Phase C: cost-aware deferral with a hard cap.
- **No `awaitDecision` watchdog across OMC restarts.** If OMC dies mid-poll, no one is watching `decision.json`. The pending file persists, the decision file (if written) persists, but the OMC promise that started `awaitDecision` is gone. Phase C: file-watcher-based recovery on OMC startup that reattaches to in-flight gates.
- **`clawhip send` shellout cost.** ~50ms per emit on macOS. Acceptable at 3 gates/run, would matter at 30+/min — Phase D may swap to a long-lived JSON-RPC connection if clawhip ships one.
- **Schema duplication risk.** Two copies of `GatePending`/`GateDecision`. Phase C cleanup: shared `argus-schemas` package. Tests on both sides cover the contract today, but the discipline is on the human reviewer.

**Phase B status after Task 14:** the entire gate state machine is in place. Tasks 15 + 16 are smoke-test + merge-decision; no more code is expected.

Commits this session (5 total):
- `phase-b: bootstrap argus-router skill project skeleton`
- `phase-b: argus-router gate types (zod schemas + decision union)`
- `phase-b: argus-router gate controller (open/await/fire/spec-branch)`
- `phase-b: argus-router SKILL.md manifest + body`
- `phase-b: runbook entry for task 14 (argus-router skill)`
