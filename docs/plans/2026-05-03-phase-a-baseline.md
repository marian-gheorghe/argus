# Phase A — Single-Runtime Baseline Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prove OMC team mode runs unattended for ~8 hours on a small greenfield task, with `git.commit` and `agent.*` events flowing to a Discord `#runs-info` channel via clawhip — all on the user's Mac, no Telegram, no cost tracker, no watchdog yet.

**Architecture:** Install OMC (`oh-my-claude-sisyphus`) and clawhip on macOS; centralize OMC state under `$OMC_STATE_DIR=$HOME/.claude/omc`; configure clawhip to receive OMC native hooks and route `git.commit` + `agent.*` to a single Discord webhook; run both daemons under `launchd` so they survive shell exits; submit a small greenfield smoke-test (a CLI todo app in TypeScript) and confirm the team-mode loop completes end-to-end with events visible in Discord.

**Tech Stack:** macOS (Sequoia/Tahoe), Homebrew, Node 20, Bun (later phases), Rust toolchain (cargo for clawhip), tmux, OMC Claude Code orchestrator, clawhip event router, Discord (webhook only — no bot needed for Phase A), `launchd` for daemonization.

**Out of scope for Phase A** (deferred to Phase B/C, do NOT do here):
- Telegram bridge of any kind
- Gate file contract / gate state machine
- Cost tracker hook
- Watchdog cron
- Recovery matrix automation
- VPS provisioning / Hetzner setup
- Cloudflare Tunnel / GitHub webhook ingress (no `github.*` events in Phase A — purely local)
- Tailscale (you'll be at the Mac for the smoke test; remote attach is later)

**Skills referenced:** `@superpowers:verification-before-completion` (each task has an explicit verification command — never claim "done" without observing the expected output), `@superpowers:executing-plans` (drives this plan).

---

## Pre-flight

Before starting, confirm these are true. If any is false, stop and resolve before Task 1.

- [ ] You are on macOS, signed in as user with admin rights.
- [ ] Homebrew is installed (`brew --version` succeeds). If not: install from https://brew.sh first.
- [ ] You are in this worktree: `pwd` returns `…/argus/.worktrees/phase-a-baseline`.
- [ ] You are on branch `phase-a/baseline`: `git branch --show-current` returns `phase-a/baseline`.
- [ ] You have a Claude Max20 subscription active (we'll log into it during OMC setup).
- [ ] You have a Discord account (free tier is fine — we only need a webhook).

---

## Task 1: Bootstrap install script + Phase A runbook

**Why:** Capture every manual step in an idempotent script as we go. Future you (or the VPS phase) re-runs the script instead of reconstructing from memory.

**Files:**
- Create: `scripts/install-mac.sh` (skeleton with sections to fill in across later tasks)
- Create: `docs/runbooks/phase-a-baseline.md` (running log of what was done, what worked, what broke)

**Step 1: Create the install script skeleton.**

Write `scripts/install-mac.sh`:

```bash
#!/usr/bin/env bash
# Argus — Phase A install script for macOS.
# Idempotent: safe to re-run. Each section is self-checking.
set -euo pipefail

ARGUS_HOME="${ARGUS_HOME:-$HOME/.argus}"
OMC_STATE_DIR="${OMC_STATE_DIR:-$HOME/.claude/omc}"

log() { printf '\033[1;34m[argus-install]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[argus-install]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[1;31m[argus-install]\033[0m %s\n' "$*" >&2; exit 1; }

require_macos() {
  [[ "$(uname -s)" == "Darwin" ]] || fail "This script targets macOS. Use install-vps.sh on Linux."
}

require_brew() {
  command -v brew >/dev/null 2>&1 || fail "Homebrew not found. Install from https://brew.sh first."
}

# Sections — filled in across Phase A tasks
section_brew_packages() { :; }
section_omc()           { :; }
section_clawhip()       { :; }
section_discord()       { :; }
section_launchd()       { :; }

main() {
  require_macos
  require_brew
  log "Argus Phase A install starting (ARGUS_HOME=$ARGUS_HOME, OMC_STATE_DIR=$OMC_STATE_DIR)"
  section_brew_packages
  section_omc
  section_clawhip
  section_discord
  section_launchd
  log "Phase A install complete."
}

main "$@"
```

**Step 2: Make it executable.**

```bash
chmod +x scripts/install-mac.sh
```

**Step 3: Verify it runs without errors against the empty sections.**

```bash
./scripts/install-mac.sh
```

**Expected:**
```
[argus-install] Argus Phase A install starting (ARGUS_HOME=/Users/<you>/.argus, OMC_STATE_DIR=/Users/<you>/.claude/omc)
[argus-install] Phase A install complete.
```

If you see any other output, debug before moving on.

**Step 4: Create the runbook with template.**

Write `docs/runbooks/phase-a-baseline.md`:

```markdown
# Phase A Baseline — Runbook

Living log of the Phase A install on macOS. Append findings as you go;
do NOT delete history. Future-you (and the VPS phase) reads this.

## Environment

- macOS version: <fill in>
- Homebrew version: <fill in>
- Apple Silicon or Intel: <fill in>
- Mac model: <fill in>

## Status

- [ ] Task 1: bootstrap
- [ ] Task 2: brew packages
- [ ] Task 3: OMC install + setup
- [ ] Task 4: OMC_STATE_DIR + omc doctor
- [ ] Task 5: clawhip install
- [ ] Task 6: Discord webhook
- [ ] Task 7: clawhip config
- [ ] Task 8: hook bridge
- [ ] Task 9: launchd plists
- [ ] Task 10: daemons up
- [ ] Task 11: smoke test
- [ ] Task 12: findings + commit

## Findings (chronological)

(Append below as you complete each task. Format: `### YYYY-MM-DD HH:MM — Task N: <one-line summary>` then prose.)
```

**Step 5: Commit.**

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: bootstrap install script and runbook scaffolding"
```

---

## Task 2: Install macOS Homebrew prerequisites

**Why:** OMC needs Node + tmux. clawhip needs Rust toolchain. Bun (later phases) installs cleanly via brew too.

**Files:**
- Modify: `scripts/install-mac.sh` (replace the `section_brew_packages` stub)

**Step 1: Replace `section_brew_packages` in the install script.**

```bash
section_brew_packages() {
  local pkgs=(tmux node@20 cloudflared)
  log "Ensuring Homebrew packages: ${pkgs[*]}"
  for p in "${pkgs[@]}"; do
    if brew list --formula "$p" >/dev/null 2>&1; then
      log "  $p already installed"
    else
      log "  installing $p"
      brew install "$p"
    fi
  done
  # node@20 is keg-only on brew; ensure it's on PATH for this shell session
  if ! command -v node >/dev/null 2>&1; then
    warn "node not on PATH — you may need to add: $(brew --prefix node@20)/bin"
  fi
  # Rust via rustup (cargo isn't ideally a brew package — use rustup for clean toolchain mgmt)
  if ! command -v cargo >/dev/null 2>&1; then
    log "Installing rustup (Rust toolchain) via official installer"
    curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable
    # shellcheck disable=SC1091
    source "$HOME/.cargo/env"
  else
    log "  cargo already on PATH ($(cargo --version))"
  fi
}
```

**Step 2: Run the install script.**

```bash
./scripts/install-mac.sh
```

**Step 3: Verify each tool is on PATH.**

Run all three; each should print a version, not "command not found":

```bash
tmux -V
node --version
cargo --version
cloudflared --version
```

**Expected:** versions for all four. Node should be 20.x. Cargo should be ≥1.75.

**Step 4: Append a runbook entry under `## Findings`:**

```markdown
### 2026-05-03 HH:MM — Task 2: brew packages installed

- tmux: <version>
- node: <version>
- cargo: <version>
- cloudflared: <version> (installed but unused in Phase A; reserved for Phase B+)

Notes: <anything that surprised you>
```

**Step 5: Commit.**

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: install brew packages (tmux, node@20, cargo, cloudflared)"
```

---

## Task 3: Install OMC and run `omc setup`

**Why:** OMC is the orchestrator. Without it, we have nothing to wrap.

**Files:**
- Modify: `scripts/install-mac.sh` (replace the `section_omc` stub)

**Step 1: Replace `section_omc` in the install script.**

```bash
section_omc() {
  log "Ensuring OMC (oh-my-claude-sisyphus) is installed"
  if command -v omc >/dev/null 2>&1; then
    log "  omc already on PATH ($(omc --version 2>/dev/null || echo 'version unknown'))"
  else
    log "  installing oh-my-claude-sisyphus globally via npm"
    npm install -g oh-my-claude-sisyphus@latest
  fi
  log "  omc binary at: $(command -v omc)"
}
```

**Step 2: Run the install script.**

```bash
./scripts/install-mac.sh
```

**Step 3: Run OMC's interactive setup — do NOT skip.**

```bash
omc setup
```

This will prompt for Claude credentials. Choose Max plan, log in via browser when prompted. Accept defaults for everything else.

**Step 4: Verify OMC reports healthy.**

```bash
omc doctor
```

**Expected:** all green checks. If any are red, fix before moving on (most likely cause: missing tmux, which Task 2 should have handled).

**Step 5: Confirm Claude Code CLI works underneath OMC.**

```bash
claude --version
```

**Expected:** prints a version. If "command not found", `omc setup` failed silently — re-run it.

**Step 6: Append runbook entry.**

```markdown
### 2026-05-03 HH:MM — Task 3: OMC installed

- OMC version: <output of `omc --version`>
- Claude CLI version: <output of `claude --version`>
- omc doctor: <pass/fail summary>

Notes: <any prompts that surprised you during omc setup>
```

**Step 7: Commit.**

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: install OMC via npm; document omc setup outcomes"
```

---

## Task 4: Configure `OMC_STATE_DIR` and re-verify

**Why:** Centralizes state under `$HOME/.claude/omc` so Phase 2 cutover to Hetzner is a single rsync. Without this pin, OMC will scatter state into per-worktree dirs.

**Files:**
- Modify: `scripts/install-mac.sh` (extend `section_omc`)
- Modify: `~/.zshrc` or `~/.bash_profile` (whichever your login shell uses)

**Step 1: Extend `section_omc` to add `OMC_STATE_DIR` to the user's shell rc, idempotently.**

Append to the end of `section_omc`:

```bash
  local rc_file
  if [[ -n "${ZSH_VERSION:-}" || "$SHELL" == */zsh ]]; then
    rc_file="$HOME/.zshrc"
  else
    rc_file="$HOME/.bash_profile"
  fi
  local export_line='export OMC_STATE_DIR="$HOME/.claude/omc"'
  if ! grep -qF "$export_line" "$rc_file" 2>/dev/null; then
    log "  adding OMC_STATE_DIR export to $rc_file"
    printf '\n# Argus — centralized OMC state for portability\n%s\n' "$export_line" >> "$rc_file"
  else
    log "  OMC_STATE_DIR already exported in $rc_file"
  fi
  mkdir -p "$OMC_STATE_DIR"
```

**Step 2: Run the install script again (idempotency check).**

```bash
./scripts/install-mac.sh
```

You should see "already installed" and "already exported" for previously-done bits.

**Step 3: Open a NEW terminal so the export takes effect, then verify.**

```bash
echo "$OMC_STATE_DIR"
ls -d "$OMC_STATE_DIR"
```

**Expected:** `/Users/<you>/.claude/omc` printed, directory exists.

**Step 4: Re-run `omc doctor` to confirm OMC sees the centralized state dir.**

```bash
omc doctor
```

**Expected:** still green; state dir line should now reference `$HOME/.claude/omc`.

**Step 5: Append runbook entry, commit.**

```markdown
### 2026-05-03 HH:MM — Task 4: OMC_STATE_DIR centralized

- Path: $HOME/.claude/omc
- Shell rc updated: <which file>
- omc doctor still green: yes/no
```

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: pin OMC_STATE_DIR to \$HOME/.claude/omc for portability"
```

---

## Task 5: Install clawhip + run `clawhip setup`

**Why:** clawhip is the observability daemon. We need it installed before we can route OMC events anywhere.

**Files:**
- Modify: `scripts/install-mac.sh` (replace `section_clawhip` stub)

**Step 1: Replace `section_clawhip`.**

```bash
section_clawhip() {
  log "Ensuring clawhip is installed (cargo install)"
  if command -v clawhip >/dev/null 2>&1; then
    log "  clawhip already on PATH ($(clawhip --version 2>/dev/null || echo 'version unknown'))"
  else
    log "  installing clawhip via cargo (this can take 2-5 min on first build)"
    cargo install clawhip
  fi
  log "  clawhip binary at: $(command -v clawhip)"
  log "  clawhip config dir: $HOME/.clawhip (will be populated in Task 7)"
}
```

**Step 2: Run the install script.**

```bash
./scripts/install-mac.sh
```

The first install builds clawhip from source — give it 2-5 minutes.

**Step 3: Verify clawhip is on PATH and reports a version.**

```bash
clawhip --version
clawhip --help | head -20
```

**Expected:** version printed; help text shows top-level commands (`setup`, `serve`, `send`, `tmux`, `plugin`, `native`, `status`).

**Step 4: Append runbook entry, commit.**

```markdown
### 2026-05-03 HH:MM — Task 5: clawhip installed

- clawhip version: <version>
- Build time: <minutes> on <Apple Silicon / Intel>

Notes: <any cargo warnings, openssl issues, etc.>
```

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: install clawhip via cargo"
```

---

## Task 6: Create Discord webhook for `#runs-info`

**Why:** The cheapest end-to-end path for Phase A — no bot, no Slack scaffold, just a single webhook URL that clawhip POSTs JSON to. We'll upgrade to a bot in Phase B (when buttons + threads matter).

**This task is mostly manual** (Discord UI clicks). Capture the resulting webhook URL into a secret file; the install script will read it later, NOT contain it.

**Files:**
- Create: `~/.argus/secrets.env` (gitignored, on your local Mac only)
- Create: `config/clawhip.toml.example` (committed; placeholder only)

**Step 1: Create the secrets file location and ensure it's gitignored everywhere.**

```bash
mkdir -p "$HOME/.argus"
chmod 700 "$HOME/.argus"
touch "$HOME/.argus/secrets.env"
chmod 600 "$HOME/.argus/secrets.env"
```

Argus repo's `.gitignore` already excludes `.env` and `*.local.*`. The `~/.argus/` location is outside the repo entirely, so committing it is impossible — but the chmod is a defense-in-depth.

**Step 2 (manual UI): Create a Discord server.**

If you don't already have one, create a personal server: Discord → bottom-left `+` → "Create My Own" → "For me and my friends" → name it `argus-runs` (or whatever).

**Step 3 (manual UI): Create a text channel `#runs-info`.**

In your server, `+` next to "Text Channels" → name `runs-info` → "Create Channel".

**Step 4 (manual UI): Create a webhook for that channel.**

Right-click `#runs-info` → "Edit Channel" → "Integrations" → "Webhooks" → "New Webhook" → set name `argus-clawhip` → "Copy Webhook URL".

The URL will look like:
`https://discord.com/api/webhooks/<id>/<token>`

**Step 5: Save the webhook URL into the secrets file.**

```bash
echo 'CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO="https://discord.com/api/webhooks/...REPLACE..."' >> "$HOME/.argus/secrets.env"
chmod 600 "$HOME/.argus/secrets.env"
```

Use a real editor if needed — keep the value quoted.

**Step 6: Smoke-test the webhook from the command line BEFORE wiring clawhip.**

```bash
source "$HOME/.argus/secrets.env"
curl -fsS -X POST -H "Content-Type: application/json" \
  -d '{"content":"hello from argus phase A — webhook test"}' \
  "$CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO"
echo
```

**Expected:** the curl returns silently (HTTP 204 No Content). Check Discord — the message "hello from argus phase A — webhook test" should appear in `#runs-info` within ~1 second.

If you get HTTP 401 or 404, the URL is wrong — re-copy from Discord.

**Step 7: Create a placeholder example config to be filled in Task 7.**

Write `config/clawhip.toml.example` (this IS committed — no secrets):

```toml
# Argus — clawhip config example.
# Real config lives at $HOME/.clawhip/config.toml (NOT in this repo).
# Webhook URLs come from $HOME/.argus/secrets.env at install time.

[providers.discord]
# Phase A: webhook-only. No bot token. Bot setup deferred to Phase B.

[dispatch]
routine_batch_window_secs = 5
ci_batch_window_secs = 60

# INFO-tier: routine traffic to #runs-info via webhook
[[routes]]
event = "git.commit"
sink = "discord"
url = "REPLACE_WITH_CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO"
format = "compact"

[[routes]]
event = "agent.*"
sink = "discord"
url = "REPLACE_WITH_CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO"
format = "compact"

[[routes]]
event = "session.*"
sink = "discord"
url = "REPLACE_WITH_CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO"
format = "compact"
```

**Step 8: Append runbook entry, commit (only the example file — secrets stay on disk).**

```markdown
### 2026-05-03 HH:MM — Task 6: Discord webhook live

- Server: <name>
- Channel: #runs-info
- Webhook test message visible: yes/no
- Latency observed (curl → message in Discord): <seconds>
```

```bash
git add config/clawhip.toml.example docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: add clawhip config example; document Discord webhook setup"
```

---

## Task 7: Author real `clawhip.toml` from the example + secret

**Why:** clawhip needs a real config at `$HOME/.clawhip/config.toml` to know where to send events. This task generates it idempotently from the example template + the secret.

**Files:**
- Modify: `scripts/install-mac.sh` (replace `section_discord` stub — it's actually the clawhip-config section; we'll rename in this task)

**Step 1: Rename `section_discord` → `section_clawhip_config` for clarity.**

In `scripts/install-mac.sh`, change:
- The function name `section_discord()` to `section_clawhip_config()`
- The matching line in `main()` from `section_discord` to `section_clawhip_config`

**Step 2: Implement the new `section_clawhip_config`.**

Replace the empty body with:

```bash
section_clawhip_config() {
  log "Generating clawhip config from example + secret"
  local cfg="$HOME/.clawhip/config.toml"
  local example="$(pwd)/config/clawhip.toml.example"
  [[ -f "$example" ]] || fail "Missing $example — did you run this from the argus repo root?"
  [[ -f "$HOME/.argus/secrets.env" ]] || fail "Missing $HOME/.argus/secrets.env (Task 6)"

  # shellcheck disable=SC1091
  source "$HOME/.argus/secrets.env"
  [[ -n "${CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO:-}" ]] || \
    fail "CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO not set in $HOME/.argus/secrets.env"

  mkdir -p "$HOME/.clawhip"
  if [[ -f "$cfg" ]]; then
    log "  $cfg exists; backing up to $cfg.bak.$(date +%s)"
    cp "$cfg" "$cfg.bak.$(date +%s)"
  fi
  # Substitute the placeholder with the real webhook URL.
  # Atomic-write: write to tmp, chmod, then mv (rename(2) is atomic on same fs).
  # Prevents truncated config if disk fills / power loss during write.
  local tmp="$cfg.tmp.$$"
  sed "s|REPLACE_WITH_CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO|$CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO|g" \
    "$example" > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$cfg"
  log "  wrote $cfg ($(wc -l < "$cfg") lines)"
}
```

**Step 3: Run the install script.**

```bash
./scripts/install-mac.sh
```

**Step 4: Verify the generated config has the real webhook URL (NOT the placeholder).**

```bash
grep -c "REPLACE_WITH" "$HOME/.clawhip/config.toml" || echo "no placeholders remain — good"
grep "discord.com/api/webhooks" "$HOME/.clawhip/config.toml" | head -1
```

**Expected:**
- First command prints `0` (no placeholders remain) — actually `grep -c` returns count; or printed message
- Second command prints a line with the real webhook URL (you can confirm it matches what you put in `secrets.env`)

**Step 5: Smoke-test clawhip can deliver an event using its CLI.**

```bash
clawhip send --event "argus.phase-a-test" --message "clawhip ↔ Discord wiring check"
```

**Expected:** a message appears in `#runs-info` within ~5 seconds. (clawhip batches non-CI events on a 5-second window — that's the lag you'll see.)

If it doesn't appear: check `clawhip status`, check the daemon isn't running yet (if it is, restart it; we'll start it via launchd in Task 9).

**Step 6: Append runbook entry, commit (script change only — never the secret).**

```markdown
### 2026-05-03 HH:MM — Task 7: clawhip config wired

- $HOME/.clawhip/config.toml generated: yes
- `clawhip send` test message visible in Discord: yes/no
- Lag observed: <seconds>
```

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: generate clawhip config from example + secret env"
```

---

## Task 8: Wire OMC ↔ clawhip native hook bridge

**Why:** OMC emits hook events (`SessionStart`, `Stop`, `PostToolUse`, etc.) at lifecycle boundaries. clawhip's Claude Code plugin listens for those and converts them to `session.*` / `agent.*` events. Without this wiring, clawhip is deaf to OMC.

**Files:**
- No new files in this repo — clawhip's plugin generates `~/.clawhip/hooks/native-hook.mjs` and Claude Code's settings file gets the hook entries.
- Modify: `scripts/install-mac.sh` (add a `section_hook_bridge` step)

**Step 1: Inspect what clawhip's `claude-code` plugin provides.**

```bash
clawhip plugin list
```

**Expected:** at minimum `codex` and `claude-code` listed.

**Step 2: Install the Claude Code hook bridge.**

```bash
clawhip plugin install claude-code
```

**Expected:** the command writes `~/.clawhip/hooks/native-hook.mjs` and edits `~/.claude/settings.json` to register hook entries for `SessionStart`, `Stop`, `PreToolUse`, `PostToolUse`, `UserPromptSubmit`. (Exact entries may vary — check the diff.)

**Step 3: Verify the settings file was updated.**

```bash
cat ~/.claude/settings.json | python3 -m json.tool | grep -A 1 hook
```

**Expected:** hook entries reference `~/.clawhip/hooks/native-hook.mjs`.

**Step 4: Add an idempotent `section_hook_bridge` to the install script.**

Add this function and wire it into `main()` (after `section_clawhip_config`):

```bash
section_hook_bridge() {
  log "Ensuring clawhip's claude-code hook bridge is installed"
  if [[ -f "$HOME/.clawhip/hooks/native-hook.mjs" ]]; then
    log "  hook bridge already present at $HOME/.clawhip/hooks/native-hook.mjs"
  else
    log "  installing via clawhip plugin install claude-code"
    clawhip plugin install claude-code
  fi
}
```

```bash
# in main():
  section_brew_packages
  section_omc
  section_clawhip
  section_clawhip_config
  section_hook_bridge       # ← new
  section_launchd
```

**Step 5: Run the install script (idempotency check — should be a no-op now).**

```bash
./scripts/install-mac.sh
```

**Expected:** `hook bridge already present`.

**Step 6: Append runbook entry, commit.**

```markdown
### 2026-05-03 HH:MM — Task 8: hook bridge installed

- ~/.clawhip/hooks/native-hook.mjs exists: yes
- ~/.claude/settings.json updated: yes
- Hooks registered: <SessionStart, Stop, PostToolUse, UserPromptSubmit, etc.>
```

```bash
git add scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: install clawhip claude-code hook bridge"
```

---

## Task 9: Author launchd plists for `clawhip` and `omc wait`

**Why:** Both must run as background daemons so they survive shell exit and the smoke test isn't tied to a specific terminal. We'll keep these in the repo (under `launchd/`) as canonical templates; the install script copies them to `~/Library/LaunchAgents/`.

**Files:**
- Create: `launchd/com.argus.clawhip.plist`
- Create: `launchd/com.argus.omc-wait.plist`
- Modify: `scripts/install-mac.sh` (replace `section_launchd` stub)
- Modify: `.gitignore` if anything gets generated locally that shouldn't be tracked

**Step 1: Create the `launchd/` directory in the repo root (if not already present).**

```bash
mkdir -p launchd
```

**Step 2: Author `launchd/com.argus.clawhip.plist`.**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.argus.clawhip</string>

    <key>ProgramArguments</key>
    <array>
        <string>__CLAWHIP_BIN__</string>
        <string>serve</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__USER_PATH__</string>
        <key>HOME</key>
        <string>__HOME__</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>__HOME__/.argus/logs/clawhip.out.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/.argus/logs/clawhip.err.log</string>
</dict>
</plist>
```

The `__PLACEHOLDER__` tokens get substituted at install time (see Step 4).

**Step 3: Author `launchd/com.argus.omc-wait.plist`.**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.argus.omc-wait</string>

    <key>ProgramArguments</key>
    <array>
        <string>__OMC_BIN__</string>
        <string>wait</string>
        <string>--start</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>__USER_PATH__</string>
        <key>HOME</key>
        <string>__HOME__</string>
        <key>OMC_STATE_DIR</key>
        <string>__OMC_STATE_DIR__</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>StandardOutPath</key>
    <string>__HOME__/.argus/logs/omc-wait.out.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/.argus/logs/omc-wait.err.log</string>
</dict>
</plist>
```

**Step 4: Implement `section_launchd` in the install script.**

```bash
section_launchd() {
  log "Installing launchd plists for clawhip and omc wait"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.argus/logs"

  local clawhip_bin omc_bin
  clawhip_bin="$(command -v clawhip)" || fail "clawhip not on PATH"
  omc_bin="$(command -v omc)"          || fail "omc not on PATH"

  # Sed delimiter '|' avoids collisions with '/' in PATH/HOME values.
  # PATH entries containing '|' would break the substitution — exotic enough to ignore.
  for label in com.argus.clawhip com.argus.omc-wait; do
    local src="$(pwd)/launchd/$label.plist"
    local dst="$HOME/Library/LaunchAgents/$label.plist"
    local tmp="$dst.tmp.$$"
    [[ -f "$src" ]] || fail "Missing template: $src"
    log "  rendering $label"
    # Atomic-write: tmp + chmod + mv. rename(2) is atomic on same fs.
    sed \
      -e "s|__CLAWHIP_BIN__|$clawhip_bin|g" \
      -e "s|__OMC_BIN__|$omc_bin|g" \
      -e "s|__USER_PATH__|$PATH|g" \
      -e "s|__HOME__|$HOME|g" \
      -e "s|__OMC_STATE_DIR__|$OMC_STATE_DIR|g" \
      "$src" > "$tmp"
    chmod 644 "$tmp"
    mv "$tmp" "$dst"
  done

  log "  plists installed in $HOME/Library/LaunchAgents/"
  log "  daemons will be started in Task 10"
}
```

**Step 5: Run the install script.**

```bash
./scripts/install-mac.sh
```

**Step 6: Verify rendered plists look sane (no remaining `__PLACEHOLDER__` tokens).**

```bash
grep -l '__.*__' ~/Library/LaunchAgents/com.argus.*.plist || echo "no placeholders — good"
plutil -lint ~/Library/LaunchAgents/com.argus.clawhip.plist
plutil -lint ~/Library/LaunchAgents/com.argus.omc-wait.plist
```

**Expected:** "no placeholders — good"; both `plutil -lint` calls return `OK`.

**Step 7: Append runbook entry, commit.**

```markdown
### 2026-05-03 HH:MM — Task 9: launchd plists rendered

- com.argus.clawhip.plist: rendered, plutil OK
- com.argus.omc-wait.plist: rendered, plutil OK
- Logs will land at: $HOME/.argus/logs/{clawhip,omc-wait}.{out,err}.log
```

```bash
git add launchd/ scripts/install-mac.sh docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: add launchd plists for clawhip and omc wait daemons"
```

---

## Task 10: Start daemons + verify health

**Why:** Daemons must be running before the smoke-test in Task 11. This is also where we catch any plist or wiring bugs.

**Files:** none — this is a runtime task.

**Step 1: Load both plists into launchd.**

```bash
launchctl load ~/Library/LaunchAgents/com.argus.clawhip.plist
launchctl load ~/Library/LaunchAgents/com.argus.omc-wait.plist
```

**Expected:** silent success. If you get "Operation already in progress" or similar, run:

```bash
launchctl unload ~/Library/LaunchAgents/com.argus.clawhip.plist 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.argus.omc-wait.plist 2>/dev/null
launchctl load ~/Library/LaunchAgents/com.argus.clawhip.plist
launchctl load ~/Library/LaunchAgents/com.argus.omc-wait.plist
```

**Step 2: Confirm processes are running.**

```bash
launchctl list | grep com.argus
pgrep -fl clawhip
pgrep -fl "omc wait"
```

**Expected:**
- `launchctl list` shows both labels with PID > 0 (not `-`)
- `pgrep` returns one PID for each

If a PID is `-`, the daemon crashed at start. Check:

```bash
tail -50 "$HOME/.argus/logs/clawhip.err.log"
tail -50 "$HOME/.argus/logs/omc-wait.err.log"
```

Most common cause: PATH in the plist doesn't include where `node` (for OMC) or rust deps (for clawhip) live. Fix the rendered plist, unload + reload.

**Step 3: Hit clawhip's status endpoint.**

```bash
curl -fsS http://127.0.0.1:25294/status
echo
```

**Expected:** JSON or plain-text status response indicating "ok" / "running". If it 404s, clawhip isn't listening on that port — check err log.

**Step 4: Send a test event via clawhip CLI to confirm the daemon is the one delivering it (vs. last task's CLI direct-send).**

```bash
clawhip send --event "argus.phase-a-daemon-up" --message "daemons are alive"
```

Watch `#runs-info` — message should appear in <10 sec.

**Step 5: Append runbook entry, commit.**

```markdown
### 2026-05-03 HH:MM — Task 10: daemons up

- com.argus.clawhip PID: <num>
- com.argus.omc-wait PID: <num>
- clawhip /status response: <pasted JSON/text>
- "daemons are alive" message in #runs-info: yes/no
```

```bash
git add docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: daemons started; document health-check outcomes"
```

---

## Task 11: Smoke-test — submit a small greenfield task

**Why:** This is the actual proof that Phase A works end-to-end. Pick something small (a CLI todo app in TS), submit via `omc team`, watch Discord light up, and let it run for a few hours unattended.

**Files:** none in argus repo. The smoke-test creates files in a *separate* test-target repo.

**Step 1: Create a temporary test-target repo for the smoke task.**

```bash
mkdir -p "$HOME/work/argus-smoke-test"
cd "$HOME/work/argus-smoke-test"
git init -q -b main
echo "# Argus Phase A smoke test target" > README.md
git add README.md
git commit -q -m "init smoke-test repo"
```

**Step 2: Submit a small greenfield task via OMC team mode, with a tight scope.**

Stay in `$HOME/work/argus-smoke-test` for this command:

```bash
omc team --billing=max20 "Build a small CLI todo app in TypeScript with: \
add/list/done/delete commands, JSON file persistence at ~/.todo/data.json, \
unit tests with vitest, README with usage examples. Keep it simple — \
single-file CLI is fine. No build system beyond tsc + vitest."
```

This should kick off OMC team mode. You'll see tmux sessions spin up.

**Step 3: Within ~30 seconds, confirm events are flowing to Discord.**

Watch `#runs-info` — you should see (in order):
- `session.started` event
- `agent.started` events as workers spin up
- `git.commit` events as code lands

**If no events appear within 60 sec:**
- `tail -100 ~/.argus/logs/clawhip.err.log` (look for delivery errors)
- `tail -100 ~/.argus/logs/omc-wait.err.log` (look for daemon issues)
- Check `~/.claude/logs/` for hook-bridge errors
- Verify `~/.claude/settings.json` still has the hook entries from Task 8

**Step 4: Let it run unattended for at least 2 hours (target: 8 hours).**

Don't poll. Don't intervene unless something obviously breaks. The smoke test is exactly to find what breaks; let breakage surface naturally.

**While it runs:** keep an eye on `#runs-info` periodically. Note anything weird in the runbook AS IT HAPPENS.

**Step 5: When the run ends (success or failure), inspect outcome.**

```bash
# back in the argus worktree
cd /Users/marian.gheorghe/work/projects/argus/.worktrees/phase-a-baseline

# in the smoke-test target repo
cd "$HOME/work/argus-smoke-test"
git log --oneline | head -20
ls
cat README.md
npx tsc --noEmit 2>&1 | head -20  # if a tsconfig was generated
npx vitest run 2>&1 | tail -20    # if tests were generated
```

**Expected outcome (rough):** a working todo CLI with tests passing, ≥5 commits, ≥1 hour of unattended runtime.

**Acceptable outcomes for Phase A:**
- ✅ Run completed end-to-end
- ⚠️ Run partially completed but logged useful diagnostics — Phase A still passes if we know *why* and have a fix path
- ❌ Run hung silently or events stopped flowing without explanation — Phase A failed; debug before Phase B

**Step 6: Append a detailed runbook entry — this is the most important entry.**

```markdown
### 2026-05-03 HH:MM — Task 11: smoke-test outcome

**Submission:**
- Prompt: <paste the omc team prompt>
- Submitted at: <timestamp>
- Run duration: <wall-clock>

**Discord event flow:**
- First event in channel: <what + when>
- Total events seen: <approx count>
- Event lag (commit → Discord): <seconds, observed>
- Any events missing or out of order: <yes/no, details>

**Code outcome:**
- Files created in target repo: <list>
- `tsc --noEmit` clean: <yes/no>
- `vitest run` passing: <count> / <total>
- Commits: <count>

**Anomalies / breakage encountered:**
1. <one-line summary> — <what fixed it OR what's still open>
2. ...

**Phase A verdict: [PASS | PASS-WITH-CAVEATS | FAIL]**
```

**Step 7: Commit the runbook entry. (No source code from the smoke-test target repo gets committed to the argus repo — they're separate repos.)**

```bash
cd /Users/marian.gheorghe/work/projects/argus/.worktrees/phase-a-baseline
git add docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: smoke-test outcomes documented"
```

---

## Task 12: Final tidy + decide on merge

**Why:** Phase A artifacts need to land on `main` so Phase B can build on them. But only after the smoke test gives a verdict.

**Files:**
- Modify: `docs/runbooks/phase-a-baseline.md` (final summary at top)
- Possibly: `README.md` (small status update)

**Step 1: Append a top-of-runbook summary section above `## Status`.**

Edit `docs/runbooks/phase-a-baseline.md` and insert near the top:

```markdown
## Phase A Verdict (filled at end)

**Status:** PASS / PASS-WITH-CAVEATS / FAIL
**Date completed:** YYYY-MM-DD
**Smoke-test runtime:** <wall-clock>
**Open issues for Phase B to address:**
- <bullet>
- <bullet>

---
```

**Step 2: If verdict is PASS or PASS-WITH-CAVEATS, update README's status line.**

Edit `README.md`:
- Change "## Status — Pre-implementation" → "## Status — Phase A baseline operational; Phase B (gate model + Telegram) next"
- Add link: `See [docs/runbooks/phase-a-baseline.md](docs/runbooks/phase-a-baseline.md) for the install runbook.`

**Step 3: Commit final updates.**

```bash
git add README.md docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: final verdict + runbook summary"
```

**Step 4: Decide the merge path with the user.**

This is a STOP point. Do not auto-merge. Tell the user the verdict and recommend:
- **PASS** → squash-merge `phase-a/baseline` into `main`, delete the branch and worktree.
- **PASS-WITH-CAVEATS** → merge to `main` but open a `phase-a-followups.md` doc capturing what to address before Phase B.
- **FAIL** → do NOT merge. Keep the branch alive for further debugging.

The actual merge invokes `superpowers:finishing-a-development-branch` — let that skill guide cleanup.

**Step 5: Update runbook with final state.**

```markdown
### 2026-05-03 HH:MM — Task 12: Phase A complete

- Verdict: <PASS | PASS-WITH-CAVEATS | FAIL>
- Merge to main: <yes/no/pending>
- Worktree disposition: <kept | removed>
- Phase B prerequisites known to be needed: <list>
```

```bash
git add docs/runbooks/phase-a-baseline.md
git commit -m "phase-a: final state recorded; ready for merge decision"
```

---

## Total commits expected

If you follow this plan rigidly, you'll have ~12 commits on `phase-a/baseline` by the end. That's intentional — frequent small commits make it trivial to bisect any issue back to the task that introduced it.

## When something breaks during execution

Apply `@superpowers:systematic-debugging`:
- Stop at the failing step.
- Read the error fully (don't skim).
- Check the runbook — has this happened in an earlier task?
- Form a single hypothesis, test it, document the result.
- If you can't fix it in 15 minutes, capture state in the runbook and move to the next non-blocked task; come back later.

## When to claim "done"

Apply `@superpowers:verification-before-completion`:
- "Done" means the verification command in the step actually printed the expected output, AND the runbook entry for that task is filled in, AND the commit landed.
- Never check off a task box on the basis of "I think it worked." Run the verification.
