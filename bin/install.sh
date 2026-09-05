#!/bin/sh
# Put `claude-usage` on your PATH by symlinking it into a bin directory.
#   bin/install.sh [target-dir]      (default: the first writable of
#                                     ~/.local/bin, /opt/homebrew/bin, /usr/local/bin)
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)

DEST="$1"
if [ -z "$DEST" ]; then
  for D in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do
    if [ -d "$D" ] && [ -w "$D" ]; then DEST="$D"; break; fi
  done
fi
[ -n "$DEST" ] || { mkdir -p "$HOME/.local/bin"; DEST="$HOME/.local/bin"; }
mkdir -p "$DEST"

ln -sf "$ROOT/claude-usage" "$DEST/claude-usage"
echo "  linked $DEST/claude-usage -> $ROOT/claude-usage"

case ":$PATH:" in
  *":$DEST:"*) ;;
  *) echo "  note: $DEST is not on your PATH. Add this to ~/.zshrc:"
     echo "        export PATH=\"$DEST:\$PATH\"" ;;
esac

echo
echo "  Next:"
echo "    claude-usage doctor          check data sources and credentials"
echo "    claude-usage serve --open    dashboard now"
echo "    claude-usage install-daemon  run it at login, in the background"
echo
