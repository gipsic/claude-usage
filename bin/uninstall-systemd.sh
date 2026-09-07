#!/bin/sh
# Remove the claude-usage systemd user service. Collected data in ~/.claude-usage
# is left alone.
set -e
UNIT="claude-usage.service"
UNIT_PATH="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/$UNIT"

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now "$UNIT" >/dev/null 2>&1 || true
fi
rm -f "$UNIT_PATH"
command -v systemctl >/dev/null 2>&1 && systemctl --user daemon-reload || true
echo "  Removed $UNIT (data in ${CLAUDE_USAGE_HOME:-$HOME/.claude-usage} kept)."
