#!/bin/sh
# claude-usage installer for macOS and Linux.
#
#   From a checkout:   ./install.sh
#   One-liner:         curl -fsSL https://raw.githubusercontent.com/gipsic/claude-usage/main/install.sh | sh
#
# macOS: installs to ~/Applications/claude-usage (a folder launchd is allowed to
# run from - Desktop/Documents/Downloads are blocked by macOS), starts a launchd
# agent and builds Claude Usage.app.
# Linux: installs to ~/.local/share/claude-usage and starts a systemd --user
# service. There is no menu-bar app and no desktop usage cache, so percentages
# come from the API alone.
# Both put `claude-usage` on PATH and open the dashboard. Re-running upgrades in
# place. Nothing needs sudo.
#
#   CLAUDE_USAGE_NO_SERVICE=1   download + first scan only: no service, no
#                               .app, no PATH change (CLI-only use, or testing)
set -e

OS=$(uname -s)
REPO_TARBALL="https://codeload.github.com/gipsic/claude-usage/tar.gz/refs/heads/main"
case "$OS" in
  Darwin) DEFAULT_DEST="$HOME/Applications/claude-usage" ;;
  Linux)  DEFAULT_DEST="${XDG_DATA_HOME:-$HOME/.local/share}/claude-usage" ;;
esac
DEST="${CLAUDE_USAGE_INSTALL_DIR:-$DEFAULT_DEST}"
PORT="${CLAUDE_USAGE_PORT:-4778}"

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

case "$OS" in
  Darwin|Linux) ;;
  *) die "unsupported platform: $OS (macOS and Linux only; Windows help wanted: see CONTRIBUTING.md)" ;;
esac

# --- node 22+ -----------------------------------------------------------------
find_node() {
  for C in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node "$HOME/.volta/bin/node"; do
    [ -n "$C" ] && [ -x "$C" ] && [ "$("$C" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ] && { echo "$C"; return; }
  done
  for D in "$HOME/.nvm/versions/node" "$HOME/Library/Application Support/fnm/node-versions" \
           "$HOME/.local/share/fnm/node-versions"; do
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
  if [ "$OS" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    note "Installing with Homebrew (brew install node)…"
    brew install node
    NODE=$(find_node) || die "node still not found after brew install"
  elif [ "$OS" = "Darwin" ]; then
    die "install Node from https://nodejs.org (or: brew install node) and re-run"
  else
    # Distro packages are often older than 22; nvm/fnm is the reliable route.
    die "install Node 22+ (https://nodejs.org, or: curl -fsSL https://fnm.vercel.app/install | bash) and re-run"
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
[ "$OS" = "Darwin" ] && xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

if [ -n "$CLAUDE_USAGE_NO_SERVICE" ]; then
  say "Scanning your Claude Code history"
  "$DEST/claude-usage" scan | sed 's/^/  /'
  say "Installed (no service)."
  note "run:  $DEST/claude-usage serve --open"
  note "later, for the background tracker + app:  $DEST/install.sh"
  exit 0
fi

# --- PATH -----------------------------------------------------------------------
say "Linking the command"
sh "$DEST/bin/install.sh" >/dev/null
BIN_DIR=""
for D in "$HOME/.local/bin" /opt/homebrew/bin /usr/local/bin; do [ -L "$D/claude-usage" ] && { BIN_DIR="$D"; break; }; done
note "$BIN_DIR/claude-usage"
# Decide from the shell profile, not from this session's PATH: a PATH that only
# has the directory because of how the installer happened to be launched leaves
# the user with "command not found" in every new terminal afterwards.
RC="$HOME/.zshrc"; [ -n "$BASH_VERSION" ] && RC="$HOME/.bashrc"
if grep -qs "$BIN_DIR" "$RC"; then
  case ":$PATH:" in *":$BIN_DIR:"*) ;; *) note "$BIN_DIR is in $RC — open a new terminal to pick it up" ;; esac
else
  printf '\n# claude-usage\nexport PATH="%s:$PATH"\n' "$BIN_DIR" >> "$RC"
  note "added $BIN_DIR to PATH in $RC (open a new terminal to pick it up)"
fi

# --- first scan + service + app -------------------------------------------------
say "Scanning your Claude Code history"
"$DEST/claude-usage" scan | sed 's/^/  /'
say "Installing the background tracker (starts at login)"
"$DEST/claude-usage" install-daemon --port "$PORT" | grep -E "dashboard|status|Installed|linger|enable-linger" | sed 's/^/  /'
if [ "$OS" = "Darwin" ]; then
  say "Building Claude Usage.app"
  sh "$DEST/bin/make-app.sh" "$HOME/Applications" "$PORT" >/dev/null && note "$HOME/Applications/Claude Usage.app"
fi

if [ "$OS" = "Darwin" ]; then
  PLATFORM_NOTES="    • If macOS asks whether node may access \"Claude Code-credentials\" or \"Claude Safe Storage\", choose Always Allow.
    • Menu bar: install SwiftBar (swiftbar.app), then
        ln -s \"$DEST/bin/claude-usage.1m.sh\" ~/Library/Application\\ Support/SwiftBar/"
  OPENER=open
else
  PLATFORM_NOTES="    • Percentages come from the API here: the desktop app's usage cache is macOS-only.
    • Logs: journalctl --user -u claude-usage.service -f"
  OPENER=xdg-open
fi

cat <<MSG

$(say "Done.")  Dashboard: http://127.0.0.1:$PORT

  Next:
$PLATFORM_NOTES
    • For exact limit percentages and reset times, open the dashboard → Accounts → Sign in with browser
      (or run: claude-usage login --web)
    • Check everything:  claude-usage doctor        Uninstall:  $DEST/uninstall.sh

MSG
"$NODE" -e "require('child_process').execFile(process.argv[1],['http://127.0.0.1:$PORT'])" "$OPENER" 2>/dev/null || true
