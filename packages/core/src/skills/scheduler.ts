import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Cron } from "croner";
import type { CollectorState } from "../types.js";
import type { Vault } from "../vault.js";

export function isDue(schedule: string, lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return true;
  try {
    const job = new Cron(schedule, { paused: true });
    const next = job.nextRun(new Date(lastRunAt));
    job.stop();
    if (!next) return true;
    return next <= now;
  } catch {
    return true;
  }
}

const stateDir = (vault: Vault) => join(vault.root, "vault", "collector-state");

export async function loadCollectorState(vault: Vault, skillName: string): Promise<CollectorState | null> {
  try {
    const raw = await readFile(join(stateDir(vault), `${skillName}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCollectorState(vault: Vault, state: CollectorState): Promise<void> {
  const dir = stateDir(vault);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.skillName}.json`), JSON.stringify(state, null, 2), "utf-8");
}
