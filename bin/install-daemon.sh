#!/bin/sh
# Install claude-usage as a per-user launchd agent: starts at login, restarts if
# it dies, and keeps tracking in the background whether or not a browser is open.
#
#   bin/install-daemon.sh [port]
set -e

PORT="${1:-4778}"
LABEL="com.claude-usage.tracker"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="$ROOT/claude-usage"
DATA="${CLAUDE_USAGE_HOME:-$HOME/.claude-usage}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

[ -x "$BIN" ] || { echo "install-daemon: $BIN is not executable" >&2; exit 1; }

# macOS gates Desktop, Documents and Downloads behind TCC. A launchd agent has no
# access to them, so it would fail to exec with a bare "Operation not permitted".
case "$ROOT/" in
  "$HOME/Desktop/"*|"$HOME/Documents/"*|"$HOME/Downloads/"*)
    cat >&2 <<MSG
install-daemon: claude-usage lives under a folder macOS protects:

  $ROOT

A background launchd agent cannot run from there. Move the tool somewhere
unprotected first, then install again:

  DEST=~/.local/share/claude-usage
  mkdir -p "\$(dirname "\$DEST")" && cp -R "$ROOT" "\$DEST"
  rm -rf "$ROOT" && ln -s "\$DEST" "$ROOT"     # keeps it visible where it was
  "\$DEST/claude-usage" install-daemon

MSG
    exit 1 ;;
esac

NODE_BIN=$(command -v node) || { echo "install-daemon: node not found on PATH" >&2; exit 1; }
NODE_DIR=$(dirname "$NODE_BIN")

mkdir -p "$HOME/Library/LaunchAgents" "$DATA/logs"

# launchd agents start with a bare PATH, so node's directory is spelled out here.
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>          <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
    <string>serve</string>
    <string>--port</string>
    <string>$PORT</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>               <string>$NODE_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>CLAUDE_USAGE_HOME</key>  <string>$DATA</string>
    <key>NO_COLOR</key>           <string>1</string>
  </dict>
  <key>RunAtLoad</key>            <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>     <false/>
  </dict>
  <key>ThrottleInterval</key>     <integer>60</integer>
  <key>ProcessType</key>          <string>Background</string>
  <key>LowPriorityIO</key>        <true/>
  <key>StandardOutPath</key>      <string>$DATA/logs/tracker.out.log</string>
  <key>StandardErrorPath</key>    <string>$DATA/logs/tracker.err.log</string>
  <key>WorkingDirectory</key>     <string>$ROOT</string>
</dict>
</plist>
PLIST

# Replace any previous instance. bootout/bootstrap is the modern API; the older
# load/unload pair is the fallback for macOS versions that lack it.
DOMAIN="gui/$(id -u)"
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload -w "$PLIST" 2>/dev/null || true
if ! launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  launchctl load -w "$PLIST"
fi
launchctl enable "$DOMAIN/$LABEL" 2>/dev/null || true

sleep 2
if curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  STATE="running"
else
  STATE="not responding yet — check $DATA/logs/tracker.err.log"
fi

cat <<EOF

  Installed $LABEL

    dashboard   http://127.0.0.1:$PORT
    status      $STATE
    plist       $PLIST
    logs        $DATA/logs/

  It starts automatically at login and restarts if it exits.
  Stop it with:  claude-usage uninstall-daemon

EOF
