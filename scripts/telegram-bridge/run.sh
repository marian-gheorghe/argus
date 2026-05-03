#!/usr/bin/env bash
# Argus — telegram-bridge launchd wrapper.
# Sources secrets from $HOME/.argus/secrets.env and execs `bun run src/index.ts`.
# Keeps secrets out of the launchd plist (which is world-readable in the user
# session) by funnelling them through a single chmod-0600 dotfile.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SECRETS_FILE="$HOME/.argus/secrets.env"

if [[ ! -f "$SECRETS_FILE" ]]; then
  echo "argus-telegram-bridge: missing $SECRETS_FILE — cannot start" >&2
  exit 1
fi

# shellcheck disable=SC1090
source "$SECRETS_FILE"

# Required env (fail fast with a clear message rather than letting Node panic deep).
for var in TELEGRAM_BOT_TOKEN \
           TELEGRAM_CHAT_ID_INFO \
           TELEGRAM_CHAT_ID_WARN \
           TELEGRAM_CHAT_ID_PAGE \
           TELEGRAM_CHAT_ID_CRITICAL \
           TELEGRAM_CHAT_ID_GATES \
           TELEGRAM_WEBHOOK_SECRET; do
  if [[ -z "${!var:-}" ]]; then
    echo "argus-telegram-bridge: required env $var is not set in $SECRETS_FILE" >&2
    exit 1
  fi
done
export TELEGRAM_BOT_TOKEN \
       TELEGRAM_CHAT_ID_INFO \
       TELEGRAM_CHAT_ID_WARN \
       TELEGRAM_CHAT_ID_PAGE \
       TELEGRAM_CHAT_ID_CRITICAL \
       TELEGRAM_CHAT_ID_GATES \
       TELEGRAM_WEBHOOK_SECRET

# Resolve bun: prefer BUN_BIN from launchd's plist, else $HOME/.bun/bin/bun, else PATH.
BUN="${BUN_BIN:-}"
if [[ -z "$BUN" ]]; then
  if [[ -x "$HOME/.bun/bin/bun" ]]; then
    BUN="$HOME/.bun/bin/bun"
  elif command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  else
    echo "argus-telegram-bridge: bun not found (set BUN_BIN or install bun)" >&2
    exit 1
  fi
fi

exec "$BUN" run "$SCRIPT_DIR/src/index.ts"
