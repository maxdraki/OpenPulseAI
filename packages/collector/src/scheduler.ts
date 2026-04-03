import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import type { Vault, CollectorState } from "@openpulse/core";

export function isDue(schedule: string, lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return true;
  try {
    const interval = CronExpressionParser.parse(schedule, { currentDate: new Date(lastRunAt) });
    const nextRun = interval.next().toDate();
    return now >= nextRun;
  } catch {
    return true;
  }
}

const stateDir = (vault: Vault) => join(vault.root, "vault", "collector-state");

export async function loadCollectorState(vault: Vault, sourceName: string): Promise<CollectorState | null> {
  try {
    const raw = await readFile(join(stateDir(vault), `${sourceName}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCollectorState(vault: Vault, state: CollectorState): Promise<void> {
  const dir = stateDir(vault);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.sourceName}.json`), JSON.stringify(state, null, 2), "utf-8");
}
