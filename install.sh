#!/bin/sh
# claude-usage installer for macOS.
#
#   From a checkout:   ./install.sh
#   One-liner:         curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
#
# Installs to ~/Applications/claude-usage (a folder launchd is allowed to run
# from - Desktop/Documents/Downloads are blocked by macOS), puts `claude-usage`
# on PATH, starts the background tracker at login, builds Claude Usage.app, and
# opens the dashboard. Re-running upgrades in place. Nothing needs sudo.
set -e

REPO_TARBALL="https://codeload.github.com/gipsic/claude-usage/tar.gz/refs/heads/main"
DEST="${CLAUDE_USAGE_INSTALL_DIR:-$HOME/Applications/claude-usage}"
PORT="${CLAUDE_USAGE_PORT:-4778}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS (Linux/Windows help wanted: see CONTRIBUTING.md)"

# --- node 22+ -----------------------------------------------------------------
find_node() {
  for C in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [ -n "$C" ] && [ -x "$C" ] && [ "$("$C" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] && { echo "$C"; return; }
  done
  for D in "$HOME/.nvm/versions/node" "$HOME/Library/Application Support/fnm/node-versions"; do
    [ -d "$D" ] || continue
    for V in $(ls -1 "$D" 2>/dev/null | sed 's/^v//' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      for C in "$D/v$V/bin/node" "$D/v$V/installation/bin/node"; do
        [ -x "$C" ] && [ "$("$C" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] && { echo "$C"; return; }
      done
    done
  done
}
NODE=$(find_node)
if [ -z "$NODE" ]; then
  say "Node.js 22 or newer is required."
  if command -v brew >/dev/null 2>&1; then
    note "Installing with Homebrew (brew install node)…"
    brew install node
    NODE=$(find_node) || die "node still not found after brew install"
  else
    die "install Node from https://nodejs.org (or: brew install node) and re-run"
  fi
fi
note "node: $NODE ($("$NODE" -v))"

# --- get the code ---------------------------------------------------------------
HERE=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo "")
if [ -n "$HERE" ] && [ -f "$HERE/claude-usage" ] && [ -d "$HERE/src" ]; then
  if [ "$HERE" != "$DEST" ]; then
    say "Copying to $DEST"
    mkdir -p "$(dirname "$DEST")"
    rm -rf "$DEST"
    cp -R "$HERE" "$DEST"
  fi
else
  say "Downloading claude-usage"
  TMP=$(mktemp -d)
  curl -fsSL "$REPO_TARBALL" | tar -xz -C "$TMP"
  mkdir -p "$(dirname "$DEST")"
  rm -rf "$DEST"
  mv "$TMP"/claude-usage-main "$DEST"
  rm -rf "$TMP"
fi
chmod +x "$DEST/claude-usage" "$DEST"/bin/*.sh "$DEST/install.sh" "$DEST/uninstall.sh" 2>/dev/null || true
rm -rf "$DEST/test/fixtures/projects" "$DEST/.tmp" 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

# --- PATH -----------------------------------------------------------------------
say "Linking the command"
sh "$DEST/bin/install.sh" >/dev/null
BIN_DIR=""
for D in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do [ -L "$D/claude-usage" ] && { BIN_DIR="$D"; break; }; done
note "$BIN_DIR/claude-usage"
case ":$PATH:" in *":$BIN_DIR:"*) ;; *)
  RC="$HOME/.zshrc"; [ -n "$BASH_VERSION" ] && RC="$HOME/.bashrc"
  grep -qs "$BIN_DIR" "$RC" || printf '\n# claude-usage\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"
  note "added $BIN_DIR to PATH in $RC (open a new terminal to pick it up)" ;;
esac

# --- first scan + service + app -------------------------------------------------
say "Scanning your Claude Code history"
"$DEST/claude-usage" scan | sed 's/^/  /'
say "Installing the background tracker (starts at login)"
"$DEST/claude-usage" install-daemon --port "$PORT" | grep -E "dashboard|status|Installed" | sed 's/^/  /'
say "Building Claude Usage.app"
sh "$DEST/bin/make-app.sh" "$HOME/Applications" "$PORT" >/dev/null && note "$HOME/Applications/Claude Usage.app"

cat <<MSG

$(say "Done.")  Dashboard: http://127.0.0.1:$PORT

  Next:
    • If macOS asks whether node may access "Claude Code-credentials", choose Always Allow.
    • For exact limit percentages and reset times, open the dashboard → Accounts → Sign in with browser
      (or run: claude-usage login --web)
    • Menu bar: install SwiftBar (swiftbar.app), then
        ln -s "$DEST/bin/claude-usage.1m.sh" ~/Library/Application\ Support/SwiftBar/
    • Check everything:  claude-usage doctor        Uninstall:  $DEST/uninstall.sh

MSG
"$NODE" -e "require('child_process').execFile('open',['http://127.0.0.1:$PORT'])" 2>/dev/null || true
