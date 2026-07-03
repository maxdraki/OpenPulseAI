/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Bearer token for the dev API server, injected by vite.config.ts from the
   *  same auto-generated token file server.ts reads — see dev-token.ts. */
  readonly VITE_OPENPULSE_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
