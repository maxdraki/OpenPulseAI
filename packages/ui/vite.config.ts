import { defineConfig } from "vite";
import { readFile } from "node:fs/promises";
import { loadOrCreateToken, tokenPath } from "./dev-token.js";

// process.env.OPENPULSE_API_TOKEN, if set, is what the dev API server actually
// enforces (see server.ts) — an explicit override wins there. This config only
// needs to know what to embed in the browser bundle, so it mirrors the same
// precedence: explicit env var, else the shared auto-generated token file.
const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? (process.env.HOME ? `${process.env.HOME}/OpenPulseAI` : undefined);

/**
 * Resolves the token WITHOUT ever creating files/directories. Used for
 * `vite build` (CI, production bundling, Tauri packaging) where writing to
 * ~/OpenPulseAI as a side effect of a build step would be surprising and
 * where HOME may be unset (e.g. some CI/packaging sandboxes). If the token
 * file doesn't exist yet, or HOME is unset, the build proceeds with no
 * token — `authHeaders()` in tauri-bridge.ts already degrades to sending no
 * Authorization header in that case, so requests just go out unauthenticated.
 * That's fine for Tauri (which doesn't talk to this dev API server at all)
 * but is a known gap if this bundle is ever pointed at an auth-enforcing
 * copy of the dev server in production — the dev API server is not meant to
 * be exposed like that, so we don't try to solve that case here.
 */
async function readTokenIfPresent(vaultRoot: string | undefined): Promise<string> {
  if (!vaultRoot) {
    console.warn("[vite.config] HOME is not set; building without an embedded API token.");
    return "";
  }
  try {
    return (await readFile(tokenPath(vaultRoot), "utf-8")).trim();
  } catch {
    return "";
  }
}

export default defineConfig(async ({ command }) => {
  let token = process.env.OPENPULSE_API_TOKEN ?? "";
  if (!token) {
    if (command === "serve") {
      if (!VAULT_ROOT) {
        console.warn("[vite.config] HOME is not set; dev server starting without an embedded API token.");
      } else {
        token = await loadOrCreateToken(VAULT_ROOT);
      }
    } else {
      // `vite build`: never create the token file/directory as a side effect
      // of a build (CI, prod, Tauri packaging). Read it if it's already there.
      token = await readTokenIfPresent(VAULT_ROOT);
    }
  }

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
