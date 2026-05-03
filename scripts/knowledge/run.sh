#!/usr/bin/env bash
# Argus — knowledge module thin wrapper.
# Resolves bun and execs `argus-knowledge <subcommand>` with the
# arguments forwarded. Used by both the Stop hook (learner-cadence)
# and PostToolUse hook (notepad-cap) wrappers, plus operator-invoked
# learner-postprocess. No secrets to source.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Resolve bun: prefer BUN_BIN env, else $HOME/.bun/bin/bun, else PATH.
BUN="${BUN_BIN:-}"
if [[ -z "$BUN" ]]; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN="$HOME/.bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  else
    echo "argus-knowledge: bun not found (set BUN_BIN or install bun)" >&2
    exit 1
  fi
fi

exec "$BUN" run "$SCRIPT_DIR/src/cli.ts" "$@"
