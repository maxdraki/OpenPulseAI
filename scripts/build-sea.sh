#!/usr/bin/env bash
# scripts/build-sea.sh — Build Node.js Single Executable Applications
set -euo pipefail

PACKAGE=$1
ENTRY="packages/$PACKAGE/dist/index.js"
OUT="dist/$PACKAGE"

mkdir -p dist

echo "Building SEA for $PACKAGE..."

npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile="$OUT.cjs"

cat > "$OUT-sea-config.json" << EOF
{
  "main": "$OUT.cjs",
  "output": "$OUT-sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF

node --experimental-sea-config "$OUT-sea-config.json"

cp "$(which node)" "$OUT"
npx postject "$OUT" NODE_SEA_BLOB "$OUT-sea-prep.blob" \
  --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2

rm "$OUT.cjs" "$OUT-sea-config.json" "$OUT-sea-prep.blob"

echo "Built: $OUT"
