#!/usr/bin/env bash
# scripts/build-desktop.sh — Build the Tauri desktop app with SEA sidecars
set -euo pipefail

echo "==> Building all TypeScript packages..."
pnpm build

echo "==> Building SEA sidecars..."
bash scripts/build-sea.sh dream
bash scripts/build-sea.sh skills

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
