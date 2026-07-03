// The "empty index → rebuild once → retry" helper lives in @openpulse/core
// next to searchIndex (see search/search.ts) so every consumer — the MCP
// tools here, and the UI dev server's Themes search — shares one
// implementation instead of maintaining duplicate copies.
export { searchWithRebuildRetry } from "@openpulse/core";
