#!/usr/bin/env bash
# scripts/build-sidecar-ui.sh — Build the UI API server (packages/ui/server.ts)
# as an always-on Tauri sidecar.
#
# Follows scripts/build-sea.sh's esbuild -> SEA -> fallback pattern, with one
# difference: the entry is TypeScript source directly. server.ts has no
# separate `tsc` dist step of its own (the dev flow runs it straight via
# `npx tsx server.ts`), so esbuild transpiles + bundles it in one step here.
#
# Usage: ./scripts/build-sidecar-ui.sh
set -euo pipefail

ENTRY="packages/ui/server.ts"
OUT="dist/openpulse-ui-server"

mkdir -p dist

echo "==> Bundling UI server ($ENTRY) with esbuild..."

# @huggingface/transformers (local embeddings — see
# packages/core/src/search/embeddings.ts) is only ever reached via a lazy
# `import()` behind a try/catch, but esbuild still tries to statically
# bundle it, which drags in onnxruntime-node's native platform binaries
# (.node files) esbuild can't load and fails the whole bundle. Marking it
# external keeps the bundle buildable; at runtime the dynamic import will
# simply fail to resolve inside the sidecar binary (module not on disk next
# to it), which is exactly the "embeddings unavailable, degrade to FTS-only"
# path embeddings.ts already handles — same tradeoff build-sea.sh accepts.
npx esbuild "$ENTRY" \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --external:@huggingface/transformers \
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
  else
    echo "    SEA injection failed (Node binary missing fuse sentinel)."
    echo "    Install Node.js from nodejs.org or use fnm/nvm for SEA support."
    rm -f "$OUT" "$OUT-sea-prep.blob"
  fi
else
  echo "    SEA config generation failed."
fi

if [ ! -f "$OUT" ]; then
  # Fallback: keep the .cjs bundle as-is (Node runs it as CommonJS)
  rm -f "$OUT-sea-config.json" "$OUT-sea-prep.blob" 2>/dev/null
  echo "==> Built standalone bundle: $OUT.cjs ($(du -h "$OUT.cjs" | cut -f1))"
  echo "    Run with: node $OUT.cjs"
  echo "    (Not a true SEA — requires Node.js on PATH. Use nodejs.org Node for full SEA.)"
fi

# --- Place it next to the dream/skills sidecars for Tauri's externalBin ---

echo "==> Copying to src-tauri/sidecars/..."
mkdir -p src-tauri/sidecars

# Determine the target triple for Tauri sidecar naming (matches
# scripts/build-desktop.sh's convention for the dream/skills sidecars).
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Tauri expects sidecars named: <name>-<target-triple>
if [ -f "$OUT" ]; then
  cp "$OUT" "src-tauri/sidecars/openpulse-ui-server-${TRIPLE}"
elif [ -f "$OUT.cjs" ]; then
  echo "WARNING: Using .cjs bundle (not a true SEA). Node.js required on PATH."
  cp "$OUT.cjs" "src-tauri/sidecars/openpulse-ui-server-${TRIPLE}"
fi

echo "==> Done: src-tauri/sidecars/openpulse-ui-server-${TRIPLE}"
