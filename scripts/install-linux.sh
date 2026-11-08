#!/usr/bin/env sh
# ExoDeck Linux installer shortcut
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec "${SCRIPT_DIR}/install.sh" "$@"
