#!/bin/sh
# Menu-bar plugin for SwiftBar (swiftbar.app) or xbar (xbarapp.com).
#
#   ln -s "$PWD/bin/claude-usage.1m.sh" \
#         ~/Library/Application\ Support/SwiftBar/claude-usage.1m.sh
#
# The ".1m." in the filename is the refresh interval - rename to .30s. or .5m.
# All rendering lives in `claude-usage menubar --format swiftbar`; this wrapper
# only locates the tool, because plugins run with a bare PATH.
SELF="$0"
while [ -L "$SELF" ]; do
  LINK=$(readlink "$SELF")
  case "$LINK" in
    /*) SELF="$LINK" ;;
    *)  SELF="$(dirname "$SELF")/$LINK" ;;
  esac
done
ROOT=$(cd "$(dirname "$SELF")/.." && pwd)
PORT="${CLAUDE_USAGE_PORT:-4778}"

if OUT=$("$ROOT/claude-usage" menubar --format swiftbar --port "$PORT" 2>/dev/null) && [ -n "$OUT" ]; then
  echo "$OUT"
else
  echo "⏣ --"
  echo "---"
  echo "claude-usage unavailable | color=#d0453b"
  echo "Check install | bash='$ROOT/claude-usage' param1=doctor terminal=true"
fi
