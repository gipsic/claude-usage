#!/bin/sh
# Install claude-usage as a systemd --user service: starts at login, restarts if
# it dies, and keeps tracking in the background whether or not a browser is open.
# The Linux counterpart of bin/install-daemon.sh (launchd).
#
#   bin/install-systemd.sh [port] [--dry-run]
#
# --dry-run prints the unit it would install and changes nothing.
set -e

PORT=4778
DRY=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    ''|*[!0-9]*) ;;
    *) PORT="$arg" ;;
  esac
done
UNIT="claude-usage.service"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN="$ROOT/claude-usage"
DATA="${CLAUDE_USAGE_HOME:-$HOME/.claude-usage}"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_PATH="$UNIT_DIR/$UNIT"

[ -x "$BIN" ] || { echo "install-systemd: $BIN is not executable" >&2; exit 1; }
command -v systemctl >/dev/null 2>&1 || {
  cat >&2 <<MSG
install-systemd: systemctl not found.

Without systemd, run the tracker yourself (any supervisor will do):

  $BIN serve --port $PORT

MSG
  exit 1; }

NODE_BIN=$(command -v node) || { echo "install-systemd: node not found on PATH" >&2; exit 1; }
NODE_DIR=$(dirname "$NODE_BIN")

if [ -n "$DRY" ]; then
  cat <<EOF

  Would install $UNIT

    ExecStart   $BIN serve --port $PORT
    node dir    $NODE_DIR
    unit        $UNIT_PATH
    data        $DATA

  Nothing was written. Run without --dry-run to install.

EOF
  exit 0
fi

mkdir -p "$UNIT_DIR" "$DATA/logs"

# A user service starts with a bare environment, so node's directory is spelled
# out here the same way the launchd plist does it.
cat > "$UNIT_PATH" <<UNIT
[Unit]
Description=claude-usage — Claude Code usage and limit tracker
Documentation=https://github.com/gipsic/claude-usage
After=default.target

[Service]
Type=simple
ExecStart=$BIN serve --port $PORT
Environment=PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin
Environment=CLAUDE_USAGE_HOME=$DATA
Environment=NO_COLOR=1
WorkingDirectory=$ROOT
Restart=on-failure
RestartSec=60
# serve exits 75 when the port is already taken - another copy is already
# running, so restarting in a loop would only fight it.
RestartPreventExitStatus=75
Nice=10
IOSchedulingClass=idle

[Install]
WantedBy=default.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now "$UNIT" >/dev/null 2>&1 || systemctl --user enable --now "$UNIT"

sleep 2
if command -v curl >/dev/null 2>&1 && curl -sf -o /dev/null "http://127.0.0.1:$PORT/api/health"; then
  STATE="running"
else
  STATE="not responding yet — check: journalctl --user -u $UNIT -n 50"
fi

LINGER=""
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  LINGER="  Tracking stops when you log out. To keep it running:
    sudo loginctl enable-linger $USER
"
fi

cat <<EOF

  Installed $UNIT

    dashboard   http://127.0.0.1:$PORT
    status      $STATE
    unit        $UNIT_PATH
    logs        journalctl --user -u $UNIT -f

$LINGER  It starts automatically at login and restarts if it exits.
  Stop it with:  claude-usage uninstall-daemon

EOF
