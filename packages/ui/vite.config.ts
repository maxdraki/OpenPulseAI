import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ["VITE_", "TAURI_"],
  build: {
    target: "esnext",
    outDir: "dist",
    rollupOptions: {
      // @tauri-apps/api is only available inside the Tauri runtime;
      // mark it external so the browser/dev build doesn't fail.
      external: ["@tauri-apps/api/core"],
    },
  },
});
