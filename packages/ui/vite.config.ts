import { defineConfig } from "vite";
import { loadOrCreateToken } from "./dev-token.js";

// process.env.OPENPULSE_API_TOKEN, if set, is what the dev API server actually
// enforces (see server.ts) — an explicit override wins there. This config only
// needs to know what to embed in the browser bundle, so it mirrors the same
// precedence: explicit env var, else the shared auto-generated token file.
const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

export default defineConfig(async () => {
  const token = process.env.OPENPULSE_API_TOKEN || (await loadOrCreateToken(VAULT_ROOT));

  return {
    clearScreen: false,
    server: {
      port: 1420,
      strictPort: true,
    },
    envPrefix: ["VITE_", "TAURI_"],
    // Bakes the token into import.meta.env.VITE_OPENPULSE_TOKEN for both `vite`
    // (dev server) and `vite build` (production bundle) — see tauri-bridge.ts's
    // authHeaders(), which attaches it as `Authorization: Bearer` on every /api
    // call. Tauri builds don't hit the dev API server at all (they use Tauri
    // commands instead — see isTauri branches in tauri-bridge.ts), so this value
    // is simply unused there.
    define: {
      "import.meta.env.VITE_OPENPULSE_TOKEN": JSON.stringify(token),
    },
    build: {
      target: "esnext",
      outDir: "dist",
      rollupOptions: {
        // @tauri-apps/api is only available inside the Tauri runtime;
        // mark it external so the browser/dev build doesn't fail.
        external: ["@tauri-apps/api/core"],
      },
    },
  };
});
