#!/usr/bin/env bash
# scripts/build-sea.sh — Build Node.js Single Executable Applications
#
# Usage: ./scripts/build-sea.sh <package-name>
# Example: ./scripts/build-sea.sh mcp-server
#
# Tries Node.js SEA first (requires Node 20+ from nodejs.org, not distro packages).
# Falls back to esbuild-only bundle if SEA injection fails.
set -euo pipefail

PACKAGE=$1
ENTRY="packages/$PACKAGE/dist/index.js"
OUT="dist/$PACKAGE"

mkdir -p dist

echo "==> Bundling $PACKAGE with esbuild..."

npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$OUT.cjs"

echo "    Bundle: $OUT.cjs ($(du -h "$OUT.cjs" | cut -f1))"

# Try SEA injection
cat > "$OUT-sea-config.json" << EOF
{
  "main": "$OUT.cjs",
  "output": "$OUT-sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF

if node --experimental-sea-config "$OUT-sea-config.json" 2>/dev/null; then
  echo "==> Injecting SEA blob..."
  cp "$(which node)" "$OUT"
  if npx postject "$OUT" NODE_SEA_BLOB "$OUT-sea-prep.blob" \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null; then
    rm -f "$OUT.cjs" "$OUT-sea-config.json" "$OUT-sea-prep.blob"
    echo "==> Built SEA binary: $OUT ($(du -h "$OUT" | cut -f1))"
    exit 0
  else
    echo "    SEA injection failed (Node binary missing fuse sentinel)."
    echo "    Install Node.js from nodejs.org or use fnm/nvm for SEA support."
    rm -f "$OUT" "$OUT-sea-prep.blob"
  fi
else
  echo "    SEA config generation failed."
fi

# Fallback: keep the .cjs bundle as-is (Node runs it as CommonJS)
rm -f "$OUT-sea-config.json" "$OUT-sea-prep.blob" 2>/dev/null
echo "==> Built standalone bundle: $OUT.cjs ($(du -h "$OUT.cjs" | cut -f1))"
echo "    Run with: node $OUT.cjs"
echo "    (Not a true SEA — requires Node.js on PATH. Use nodejs.org Node for full SEA.)"
