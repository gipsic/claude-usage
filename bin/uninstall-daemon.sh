#!/bin/sh
# Remove the claude-usage launchd agent. Collected data in ~/.claude-usage is left alone.
set -e
LABEL="com.claude-usage.tracker"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
rm -f "$PLIST"
echo "  Removed $LABEL (data in ${CLAUDE_USAGE_HOME:-$HOME/.claude-usage} kept)."
