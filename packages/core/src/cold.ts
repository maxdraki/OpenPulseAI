import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import type { Vault } from "./vault.js";

export async function archiveHotFile(
  vault: Vault,
  date: string
): Promise<void> {
  const month = date.slice(0, 7);
  const coldMonthDir = join(vault.coldDir, month);
  await mkdir(coldMonthDir, { recursive: true });

  const src = vault.dailyLogPath(date);
  const dest = join(coldMonthDir, `${date}.md`);
  await rename(src, dest);
}
