# Phase B Gates + Telegram Bridge — Runbook

Living log of the Phase B install on macOS. Append findings as you go.

## Status
- [ ] Task 1: Telegram bot creation (operator manual; deferred)
- [ ] Task 2: Bridge project bootstrap + Bun install
- [ ] Tasks 3,4,5: schemas + queue + telegram client (TDD)
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
