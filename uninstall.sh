#!/bin/sh
# Remove claude-usage completely. Keeps ~/.claude-usage (your collected history)
# unless you pass --purge.
set -e
DEST=$(cd "$(dirname "$0")" && pwd)
"$DEST/claude-usage" uninstall-daemon 2>/dev/null || true
rm -f "$HOME/.local/bin/claude-usage" /opt/homebrew/bin/claude-usage /usr/local/bin/claude-usage 2>/dev/null || true
rm -rf "$HOME/Applications/Claude Usage.app"
rm -f "$HOME/Library/Application Support/SwiftBar/claude-usage."*".sh" 2>/dev/null || true
if [ "$1" = "--purge" ]; then rm -rf "${CLAUDE_USAGE_HOME:-$HOME/.claude-usage}"; echo "  removed data dir"; fi
echo "  removed service, command, app. Now: rm -rf \"$DEST\""
[ "$1" = "--purge" ] || echo "  (history kept in ~/.claude-usage — pass --purge to delete it)"
