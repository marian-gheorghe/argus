#!/usr/bin/env bash
# Argus — recovery launchd wrapper.
# Spawns `argus-recovery serve --port 9601` for clawhip route hooks.
# Lighter than the bridge's run.sh: no secrets to source. We only need to
# resolve the bun binary (env-injected BUN_BIN, then $HOME/.bun/bin/bun, then
# PATH) and exec the recovery CLI in serve mode.

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
    echo "argus-recovery: bun not found (set BUN_BIN or install bun)" >&2
    exit 1
  fi
fi

PORT="${ARGUS_RECOVERY_PORT:-9601}"

exec "$BUN" run "$SCRIPT_DIR/src/cli.ts" serve --port "$PORT"
