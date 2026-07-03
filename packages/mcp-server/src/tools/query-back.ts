import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingUpdate, Vault } from "@openpulse/core";
import { vaultLog } from "@openpulse/core";

/**
 * Feedback-loop guard shared by query_memory's (`maybeFileQueryBack`) and
 * chat_with_pulse's query-back filing paths: both judge "is this durable
 * knowledge?" independently on every call, so a repeated/similar question
 * (or a second chat turn touching the same themes) can otherwise propose
 * the same concept page twice before the first pending update is
 * reviewed. Scans `vault.pendingDir` for an existing pending update whose
 * `querybackSource` is set (i.e. it was itself filed by a query-back, not
 * a dream-pipeline synthesis) and whose theme matches `themeSlug`.
 *
 * Malformed/unreadable pending files are skipped rather than failing the
 * whole scan — this guard must stay best-effort, same as the query-back
 * filing it protects.
 */
export async function hasPendingQueryback(vault: Vault, themeSlug: string): Promise<boolean> {
  let files: string[];
  try {
    files = await readdir(vault.pendingDir);
  } catch {
    return false; // pendingDir may not exist yet on a fresh vault
  }

  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await readFile(join(vault.pendingDir, f), "utf-8");
      const update = JSON.parse(raw) as PendingUpdate;
      if (update.querybackSource && update.theme === themeSlug) {
        return true;
      }
    } catch {
      // Skip unreadable/malformed pending files rather than aborting the scan.
    }
  }
  return false;
}

/**
 * Checks the guard and logs (there's no "debug" level in `LogLevel` — see
 * logger.ts — so this uses "info") when a duplicate is found. Callers skip
 * filing entirely when this returns true.
 */
export async function skipIfQuerybackPending(
  vault: Vault,
  themeSlug: string,
  caller: string
): Promise<boolean> {
  if (await hasPendingQueryback(vault, themeSlug)) {
    await vaultLog(
      "info",
      `${caller}: skipping query-back filing, a pending update already proposes theme "${themeSlug}"`
    );
    return true;
  }
  return false;
}
