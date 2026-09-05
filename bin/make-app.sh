#!/bin/sh
# Build "Claude Usage.app" — a launcher bundle you can add to
# System Settings -> General -> Login Items so the tracker opens at login and
# the dashboard is one click away in Finder / Spotlight / the Dock.
#
#   bin/make-app.sh [destination-dir] [port]
set -e

DEST="${1:-$HOME/Applications}"
PORT="${2:-4778}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
APP="$DEST/Claude Usage.app"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>              <string>Claude Usage</string>
  <key>CFBundleDisplayName</key>       <string>Claude Usage</string>
  <key>CFBundleIdentifier</key>        <string>com.claude-usage.app</string>
  <key>CFBundleVersion</key>           <string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key>       <string>APPL</string>
  <key>CFBundleExecutable</key>        <string>ClaudeUsage</string>
  <key>CFBundleIconFile</key>          <string>AppIcon</string>
  <key>LSMinimumSystemVersion</key>    <string>13.0</string>
  <key>LSUIElement</key>               <true/>
  <key>NSHighResolutionCapable</key>   <true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/ClaudeUsage" <<LAUNCHER
#!/bin/sh
# Start the tracker if it is not already up, then show the dashboard.
set -e
ROOT="$ROOT"
PORT="$PORT"
export PATH="$(dirname "$(command -v node)"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin"

if ! curl -sf -o /dev/null "http://127.0.0.1:\$PORT/api/health" 2>/dev/null; then
  "\$ROOT/claude-usage" serve --port "\$PORT" \\
    >> "\${CLAUDE_USAGE_HOME:-\$HOME/.claude-usage}/logs/app.log" 2>&1 &
  # Give the listener a moment before handing the URL to the browser.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    curl -sf -o /dev/null "http://127.0.0.1:\$PORT/api/health" && break
    sleep 0.4
  done
fi
open "http://127.0.0.1:\$PORT"
LAUNCHER

chmod +x "$APP/Contents/MacOS/ClaudeUsage"
mkdir -p "${CLAUDE_USAGE_HOME:-$HOME/.claude-usage}/logs"

# A small generated icon so the bundle is recognisable in the Dock / Login Items.
TMPD=$(mktemp -d)
ICONSET="$TMPD/AppIcon.iconset"
SVG="$TMPD/icon.svg"
mkdir -p "$ICONSET"
cat > "$SVG" <<'SVGEOF'
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <rect width="1024" height="1024" rx="228" fill="#1c1a17"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="#2c2823" stroke-width="104"
          stroke-linecap="round" stroke-dasharray="1414 471" transform="rotate(-220 512 512)"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="#d97757" stroke-width="104"
          stroke-linecap="round" stroke-dasharray="990 895" transform="rotate(-220 512 512)"/>
</svg>
SVGEOF

if command -v qlmanage >/dev/null 2>&1 && command -v sips >/dev/null 2>&1; then
  PNG="$TMPD/icon.png"
  qlmanage -t -s 1024 -o "$TMPD" "$SVG" >/dev/null 2>&1 || true
  [ -f "$SVG.png" ] && mv "$SVG.png" "$PNG"
  if [ -f "$PNG" ]; then
    for sz in 16 32 64 128 256 512; do
      sips -z $sz $sz "$PNG" --out "$ICONSET/icon_${sz}x${sz}.png" >/dev/null 2>&1 || true
      sips -z $((sz*2)) $((sz*2)) "$PNG" --out "$ICONSET/icon_${sz}x${sz}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns" 2>/dev/null || true
  fi
fi

rm -rf "$TMPD"
touch "$APP"
cat <<EOF

  Built "$APP"

  Open at login:
    System Settings -> General -> Login Items -> "+"  and pick Claude Usage
  or run:
    osascript -e 'tell application "System Events" to make login item at end \\
      with properties {path:"$APP", hidden:true}'

  For a true background service that also restarts itself, prefer:
    claude-usage install-daemon

EOF
