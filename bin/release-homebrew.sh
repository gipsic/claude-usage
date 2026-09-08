#!/bin/sh
# Point the Homebrew tap at a release: rewrites url + sha256 in the formula,
# copies it into the tap and pushes.
#
#   bin/release-homebrew.sh v1.5.3 [path-to-tap]
#
# The tap lives at github.com/gipsic/homebrew-tap (brew tap gipsic/tap). It is
# cloned into the given path, or a temporary one.
set -e

TAG="${1:?usage: release-homebrew.sh vX.Y.Z [tap-dir]}"
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/packaging/homebrew/claude-usage.rb"
TAP="${2:-$(mktemp -d)/homebrew-tap}"
URL="https://github.com/gipsic/claude-usage/archive/refs/tags/$TAG.tar.gz"

echo "==> checksumming $URL"
TMP=$(mktemp -d)
curl -fsSL -o "$TMP/src.tar.gz" "$URL"
SHA=$(shasum -a 256 "$TMP/src.tar.gz" | cut -d' ' -f1)
rm -rf "$TMP"
echo "    $SHA"

[ -d "$TAP/.git" ] || git clone "https://github.com/gipsic/homebrew-tap" "$TAP"
mkdir -p "$TAP/Formula"

# Only the two lines that identify the release change; everything else in the
# formula is reviewed in the main repo.
sed -e "s|^  url .*|  url \"$URL\"|" \
    -e "s|^  sha256 .*|  sha256 \"$SHA\"|" \
    "$SRC" > "$TAP/Formula/claude-usage.rb"

cd "$TAP"
git add Formula/claude-usage.rb
git commit -m "claude-usage ${TAG#v}" || { echo "nothing to commit"; exit 0; }
git push
echo
echo "  Tap updated. Verify with:"
echo "    brew update && brew upgrade claude-usage"
echo
