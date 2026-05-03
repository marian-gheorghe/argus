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

# Fail fast if Task 6 (manual Discord webhook setup) hasn't been completed.
# Without this, the operator burns 5+ minutes on cargo install before the
# in-section check at section_clawhip_config errors out.
require_secrets() {
  local secrets="$HOME/.argus/secrets.env"
  [[ -f "$secrets" ]] || fail "Missing $secrets — complete Task 6 (Discord webhook) first."
  # shellcheck disable=SC1090
  source "$secrets"
  [[ -n "${CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO:-}" ]] || \
    fail "CLAWHIP_DISCORD_WEBHOOK_RUNS_INFO not set in $secrets — complete Task 6."
}

# Sections — filled in across Phase A tasks
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
    command -v cargo >/dev/null 2>&1 || fail "cargo not on PATH after rustup install"
  else
    log "  cargo already on PATH ($(cargo --version))"
  fi
}
section_bun() {
  log "Ensuring Bun is installed"
  if command -v bun >/dev/null 2>&1; then
    log "  bun already on PATH ($(bun --version))"
    return
  fi
  log "  installing bun via official installer"
  curl -fsSL https://bun.sh/install | bash
  # The installer puts bun in $HOME/.bun/bin and modifies shell rc.
  # Source it now so the rest of this script can see it.
  # shellcheck disable=SC1091
  [[ -s "$HOME/.bun/_bun" ]] && source "$HOME/.bun/_bun"
  export PATH="$HOME/.bun/bin:$PATH"
  command -v bun >/dev/null 2>&1 || fail "bun install completed but binary not on PATH"
  log "  bun installed: $(bun --version)"
}
section_omc() {
  log "Ensuring OMC (oh-my-claude-sisyphus) is installed"
  if command -v omc >/dev/null 2>&1; then
    log "  omc already on PATH ($(omc --version 2>/dev/null || echo 'version unknown'))"
  else
    log "  installing oh-my-claude-sisyphus globally via npm"
    npm install -g oh-my-claude-sisyphus@latest
  fi
  log "  omc binary at: $(command -v omc)"
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
}
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
section_hook_bridge() {
  log "Ensuring clawhip's claude-code hook bridge is installed"
  if [[ -f "$HOME/.clawhip/hooks/native-hook.mjs" ]]; then
    log "  hook bridge already present at $HOME/.clawhip/hooks/native-hook.mjs"
  else
    log "  installing via clawhip plugin install claude-code"
    clawhip plugin install claude-code
  fi
}
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
    # Validate post-render: plutil-lint + residual-placeholder check.
    plutil -lint "$dst" >/dev/null || fail "Rendered $dst failed plutil -lint"
    ! grep -q '__[A-Z_]*__' "$dst" || \
      fail "Rendered $dst still contains placeholder tokens — sed substitution failed"
  done

  log "  plists installed in $HOME/Library/LaunchAgents/"
  log "  daemons will be started in Task 10"
}

# Phase B / Task 11 — render cloudflared launchd plist iff the operator has
# already run scripts/install-cloudflared.sh (which writes ~/.cloudflared/config.yml
# and creates the named tunnel). Skip-without-failing when not yet configured —
# install-mac.sh is meant to be re-runnable before AND after the one-time tunnel
# setup, so we shouldn't error out the whole install just because the operator
# hasn't done the interactive `cloudflared tunnel login` yet.
section_cloudflared() {
  log "Installing launchd plist for cloudflared (Telegram webhook ingress)"
  if ! command -v cloudflared >/dev/null 2>&1; then
    warn "  cloudflared not on PATH — section_brew_packages should have installed it; skipping plist install"
    return 0
  fi
  if [[ ! -f "$HOME/.cloudflared/config.yml" ]]; then
    log "  cloudflared tunnel not configured — run scripts/install-cloudflared.sh first; skipping plist install"
    return 0
  fi

  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.argus/logs"
  local cloudflared_bin
  cloudflared_bin="$(command -v cloudflared)"

  local label="com.argus.cloudflared"
  local src="$(pwd)/launchd/$label.plist"
  local dst="$HOME/Library/LaunchAgents/$label.plist"
  local tmp="$dst.tmp.$$"
  [[ -f "$src" ]] || fail "Missing template: $src"
  log "  rendering $label"
  # Atomic-write: tmp + chmod + mv. rename(2) is atomic on same fs.
  sed \
    -e "s|__CLOUDFLARED_BIN__|$cloudflared_bin|g" \
    -e "s|__USER_PATH__|$PATH|g" \
    -e "s|__HOME__|$HOME|g" \
    "$src" > "$tmp"
  chmod 644 "$tmp"
  mv "$tmp" "$dst"
  # Validate post-render: plutil-lint + residual-placeholder check.
  plutil -lint "$dst" >/dev/null || fail "Rendered $dst failed plutil -lint"
  ! grep -q '__[A-Z_]*__' "$dst" || \
    fail "Rendered $dst still contains placeholder tokens — sed substitution failed"

  log "  plist installed at $dst"
  log "  cloudflared will start at next launchctl load (or reboot)"
}

main() {
  require_macos
  require_brew
  require_secrets
  log "Argus Phase A install starting (ARGUS_HOME=$ARGUS_HOME, OMC_STATE_DIR=$OMC_STATE_DIR)"
  section_brew_packages
  section_bun
  section_omc
  section_clawhip
  section_clawhip_config
  section_hook_bridge
  section_launchd
  section_cloudflared
  log "Phase A install complete."
}

main "$@"
