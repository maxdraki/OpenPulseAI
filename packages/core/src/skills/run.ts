import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault } from "../vault.js";
import { loadConfig } from "../config.js";
import { createProvider } from "../llm/factory.js";
import { discoverSkills } from "./loader.js";
import { checkEligibility } from "./eligibility.js";
import { runSkill } from "./runner.js";
import { isDue, loadCollectorState } from "./scheduler.js";
import { initLogger, vaultLog } from "../logger.js";

/**
 * Resolves the bundled `builtin-skills/` directory that ships alongside this
 * package. Historically this was always `dirname(fileURLToPath(import.meta.url))`-
 * relative — reliable when this module runs as plain ESM (dev, vitest), but
 * NOT when it's bundled into a CommonJS sidecar by esbuild: esbuild empties
 * `import.meta.url` for `--format=cjs` output (a documented limitation — see
 * `packages/ui/server.ts`'s `startServer` boot-guard comment for the same
 * issue elsewhere in this codebase), which makes `fileURLToPath("")` throw.
 * This IS exercised in the packaged app: `packages/ui/server.ts` imports
 * `runSkillByName` directly (not as a subprocess) and its orchestrator's
 * `runCollector` callback calls it on every scheduled/manual skill run, and
 * that whole module graph gets bundled into the `openpulse-ui-server`
 * sidecar (see `scripts/build-sidecar-ui.sh`) — so without this fallback,
 * every skill run in the desktop app would throw before doing anything.
 *
 * Resolution order: an explicit `OPENPULSE_BUILTIN_SKILLS_DIR` env var (set
 * by the Tauri supervisor — see `src-tauri/src/server_sidecar.rs` — to the
 * app's bundled resource dir, since `builtin-skills/` ships there, not next
 * to the sidecar binary); else the normal `import.meta.url`-relative path
 * (works whenever this module runs as real ESM); else a `process.cwd()`-
 * relative guess matching this repo's dev layout (`packages/ui` or
 * `packages/core` as cwd — both resolve to `packages/core/builtin-skills`).
 */
export function resolveBuiltinSkillsDir(): string {
  if (process.env.OPENPULSE_BUILTIN_SKILLS_DIR) {
    return process.env.OPENPULSE_BUILTIN_SKILLS_DIR;
  }
  try {
    const url = import.meta.url;
    if (url) return join(dirname(fileURLToPath(url)), "..", "..", "builtin-skills");
  } catch {
    /* esbuild-bundled CJS: import.meta.url is "", fileURLToPath throws — fall through */
  }
  return join(process.cwd(), "..", "core", "builtin-skills");
}

/**
 * Run a specific skill by name programmatically.
 * This is the function that server.ts and the Tauri backend should call
 * instead of spawning a subprocess.
 */
export async function runSkillByName(name: string, vaultRoot: string): Promise<void> {
  initLogger(vaultRoot);

  const config = await loadConfig(vaultRoot);
  const vault = new Vault(vaultRoot);
  await vault.init();

  // Discover skills from builtin + user directories
  const builtinDir = resolveBuiltinSkillsDir();
  const userDir = join(vaultRoot, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  const skill = skills.find((s) => s.name === name);
  if (!skill) throw new Error(`Skill "${name}" not found`);

  const elig = await checkEligibility(skill);
  if (!elig.eligible) throw new Error(`Skill "${name}" ineligible: ${elig.missing.join(", ")}`);

  const provider = createProvider(config);
  await runSkill(skill, vault, provider, config.llm.model);
}

/**
 * Run all scheduled skills that are due.
 */
export async function runDueSkills(vaultRoot: string): Promise<void> {
  initLogger(vaultRoot);

  const config = await loadConfig(vaultRoot);
  const vault = new Vault(vaultRoot);
  await vault.init();

  const builtinDir = resolveBuiltinSkillsDir();
  const userDir = join(vaultRoot, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  const provider = createProvider(config);
  const now = new Date();

  for (const skill of skills) {
    if (!skill.schedule) continue;
    const elig = await checkEligibility(skill);
    if (!elig.eligible) continue;

    const state = await loadCollectorState(vault, skill.name);
    if (!isDue(skill.schedule, state?.lastRunAt ?? null, now)) continue;

    await vaultLog("info", `Running scheduled skill: ${skill.name}`);
    await runSkill(skill, vault, provider, config.llm.model);
  }
}
