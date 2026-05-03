#!/usr/bin/env bash
# Argus — watchdog launchd wrapper.
# Lighter than the bridge's run.sh: no secrets to source. We only need to
# resolve the bun binary (env-injected BUN_BIN, then $HOME/.bun/bin/bun, then
# PATH) and exec the watchdog's index.ts.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve bun: prefer BUN_BIN from launchd's plist, else $HOME/.bun/bin/bun, else PATH.
BUN="${BUN_BIN:-}"
if [[ -z "$BUN" ]]; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN="$HOME/.bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  else
    echo "argus-watchdog: bun not found (set BUN_BIN or install bun)" >&2
    exit 1
  fi
fi

exec "$BUN" run "$SCRIPT_DIR/src/index.ts"
