#!/usr/bin/env bash
# scripts/build-desktop.sh — Build the Tauri desktop app with SEA sidecars
set -euo pipefail

echo "==> Building all TypeScript packages..."
pnpm build

echo "==> Building SEA sidecars..."
bash scripts/build-sea.sh dream
# Skills CLI is now in core — bundle it directly with esbuild into dist/skills
npx esbuild packages/core/dist/skills/cli.js \
  --bundle \
  --platform=node \
  --target=node20 \
  --format=cjs \
  --outfile=dist/skills.cjs
mkdir -p dist
# Try SEA injection for skills
cat > dist/skills-sea-config.json << EOF
{
  "main": "dist/skills.cjs",
  "output": "dist/skills-sea-prep.blob",
  "disableExperimentalSEAWarning": true
}
EOF
if node --experimental-sea-config dist/skills-sea-config.json 2>/dev/null; then
  cp "$(which node)" dist/skills
  if npx postject dist/skills NODE_SEA_BLOB dist/skills-sea-prep.blob \
      --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2 2>/dev/null; then
    rm -f dist/skills.cjs dist/skills-sea-config.json dist/skills-sea-prep.blob
    echo "==> Built SEA binary: dist/skills"
  else
    rm -f dist/skills dist/skills-sea-prep.blob dist/skills-sea-config.json
    echo "==> Built standalone bundle: dist/skills.cjs (SEA injection failed)"
  fi
else
  rm -f dist/skills-sea-config.json dist/skills-sea-prep.blob 2>/dev/null
  echo "==> Built standalone bundle: dist/skills.cjs"
fi

echo "==> Copying sidecars to src-tauri/sidecars/..."
mkdir -p src-tauri/sidecars

# Determine the target triple for Tauri sidecar naming
ARCH=$(uname -m)
case "$ARCH" in
  arm64|aarch64) TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin" ;;
  *) echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Tauri expects sidecars named: <name>-<target-triple>
# Copy SEA binaries or fallback .cjs bundles
if [ -f "dist/dream" ]; then
  cp dist/dream "src-tauri/sidecars/openpulse-dream-${TRIPLE}"
elif [ -f "dist/dream.cjs" ]; then
  echo "WARNING: Using .cjs bundle (not a true SEA). Node.js required on PATH."
  cp dist/dream.cjs "src-tauri/sidecars/openpulse-dream-${TRIPLE}"
fi

if [ -f "dist/skills" ]; then
  cp dist/skills "src-tauri/sidecars/openpulse-skills-${TRIPLE}"
elif [ -f "dist/skills.cjs" ]; then
  echo "WARNING: Using .cjs bundle (not a true SEA). Node.js required on PATH."
  cp dist/skills.cjs "src-tauri/sidecars/openpulse-skills-${TRIPLE}"
fi

echo "==> Building Tauri app..."
cargo tauri build

echo "==> Done! Check src-tauri/target/release/bundle/ for the .app and .dmg"
