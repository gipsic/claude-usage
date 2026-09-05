#!/bin/sh
# Build a single self-contained executable using Node's SEA (Single Executable
# Application) support: dist/claude-usage-<arch>.
#
# Needs network access once, for esbuild and postject via npx.
# The plain `claude-usage` launcher is the recommended way to run this tool -
# SEA is still experimental upstream. Use this when you want one file to copy
# to another Mac that has no Node installed.
set -e

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIST="$ROOT/dist"
ARCH=$(uname -m)
OUT="$DIST/claude-usage-$ARCH"

command -v node >/dev/null 2>&1 || { echo "build-binary: node 22+ required" >&2; exit 1; }
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$MAJOR" -ge 22 ] || { echo "build-binary: node 22+ required, found $(node -v)" >&2; exit 1; }

rm -rf "$DIST"
mkdir -p "$DIST"

echo "==> bundling src/ and web/ into one CommonJS file"
# The web assets are read from disk at runtime, so they are inlined as a virtual
# file map and served from memory when the bundle detects it is running as a SEA.
node "$ROOT/bin/inline-web.mjs" "$DIST/web-assets.cjs"

npx --yes esbuild "$ROOT/src/main.mjs" \
  --bundle --platform=node --format=cjs --target=node22 \
  --define:CLAUDE_USAGE_SEA=true \
  --inject:"$DIST/web-assets.cjs" \
  --outfile="$DIST/bundle.cjs"

cat > "$DIST/sea-config.json" <<JSON
{
  "main": "$DIST/bundle.cjs",
  "output": "$DIST/sea-prep.blob",
  "disableExperimentalSEAWarning": true,
  "useSnapshot": false,
  "useCodeCache": false
}
JSON

echo "==> generating the SEA blob"
node --experimental-sea-config "$DIST/sea-config.json"

echo "==> copying the node runtime"
cp "$(command -v node)" "$OUT"
codesign --remove-signature "$OUT" 2>/dev/null || true

echo "==> injecting the blob"
npx --yes postject "$OUT" NODE_SEA_BLOB "$DIST/sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 \
  --macho-segment-name NODE_SEA

echo "==> re-signing (ad-hoc)"
codesign --sign - "$OUT" 2>/dev/null || \
  echo "    codesign failed; run: xattr -d com.apple.quarantine \"$OUT\""

chmod +x "$OUT"
rm -f "$DIST/sea-prep.blob" "$DIST/sea-config.json"

cat <<EOF

  Built $OUT  ($(du -h "$OUT" | cut -f1))

    "$OUT" doctor
    sudo cp "$OUT" /usr/local/bin/claude-usage

EOF
