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
