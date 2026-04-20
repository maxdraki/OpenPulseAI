import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendActivity } from "../hot.js";
import type { Vault } from "../vault.js";
import type { LlmProvider } from "../llm/provider.js";
import type { SkillDefinition, CollectorState } from "../types.js";
import { loadCollectorState, saveCollectorState } from "./scheduler.js";
import { scanSkillForThreats } from "./security.js";

const execFileAsync = promisify(execFile);

/**
 * Extract shell commands from a SKILL.md body.
 * Looks for inline backtick commands and fenced code blocks.
 */
const SHELL_BINARIES = /^(?:curl|wget|gh|git|find|ls|cat|grep|awk|sed|jq|node|python3?|bash|sh|echo|printf|date|linear|glab|notion)\b/;

export function extractShellCommands(body: string): string[] {
  const commands: string[] = [];

  const inlineRegex = /`([^`]+)`/g;
  let match;
  while ((match = inlineRegex.exec(body)) !== null) {
    const cmd = match[1].trim();
    if (cmd.includes(" ") || cmd.startsWith("./") || cmd.startsWith("$")) {
      // Commands starting with a known binary are always shell commands
      if (SHELL_BINARIES.test(cmd)) {
        commands.push(cmd);
      } else {
        // For other commands, skip things that look like function calls
        const looksLikeCode = /\w+\(/.test(cmd) && !cmd.includes("\\(");
        if (!looksLikeCode && !cmd.startsWith("//")) {
          commands.push(cmd);
        }
      }
    }
  }

  const fencedRegex = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  while ((match = fencedRegex.exec(body)) !== null) {
    const blockCommands = match[1]
      .trim()
      .split("\n")
      .filter((l) => l.trim() && !l.startsWith("#"));
    commands.push(...blockCommands);
  }

  return commands;
}

async function loadSkillConfig(
  vault: Vault,
  skill: SkillDefinition
): Promise<Record<string, string>> {
  const config: Record<string, string> = {};

  for (const field of skill.config ?? []) {
    if (field.default) config[field.key] = field.default;
  }

  try {
    const configPath = join(vault.root, "vault", "skill-config", `${skill.name}.json`);
    const raw = await readFile(configPath, "utf-8");
    const userConfig = JSON.parse(raw);
    for (const [key, value] of Object.entries(userConfig)) {
      if (typeof value === "string") config[key] = value;
    }
  } catch (e: any) {
    if (e?.code !== "ENOENT") {
      console.error(`[skills] Failed to read config for "${skill.name}":`, e?.message ?? e);
    }
  }

  return config;
}

function escapeForShell(value: string): string {
  // Wrap in single quotes, escape internal single quotes
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return (process.env.HOME ?? "") + value.slice(1);
  }
  return value;
}

/** Strip shell metacharacters from text config values to prevent injection */
function sanitizeConfigValue(value: string): string {
  // Allow alphanumeric, dashes, underscores, dots, colons, @, +, /
  // These cover API keys, tokens, email addresses, domains, URLs
  // Strip anything that could be shell-interpreted: $`;&|(){}!#\n
  return value.replace(/[`$;&|(){}!#\\\n\r]/g, "");
}

function applyConfig(text: string, config: Record<string, string>, skill: SkillDefinition): string {
  const pathFields = new Set(
    (skill.config ?? []).filter((f) => f.type === "path" || f.type === "paths").map((f) => f.key)
  );
  const domainFields = new Set(
    (skill.config ?? []).filter((f) => f.type === "domain").map((f) => f.key)
  );

  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = config[key];
    if (value === undefined) return `{{${key}}}`;

    if (pathFields.has(key)) {
      // Path values: expand ~ and shell-escape (may contain spaces)
      const lines = value.split("\n").filter((l) => l.trim());
      const expanded = lines.map(expandHome);
      return expanded.map(escapeForShell).join(" ");
    }

    if (domainFields.has(key)) {
      // Domain values: strip accidental protocol prefix (e.g. https://example.com → example.com)
      return sanitizeConfigValue(value.replace(/^https?:\/\//i, ""));
    }

    // Text values (API keys, tokens, IDs): sanitize shell metacharacters.
    // Also strip spaces around commas so comma-separated values (e.g. project keys)
    // are URL-safe without requiring the user to avoid spaces.
    return sanitizeConfigValue(value.replace(/\s*,\s*/g, ","));
  });
}

function filterEnv(skill: SkillDefinition): NodeJS.ProcessEnv {
  const allowedEnvVars = new Set(skill.requires.env);
  const sensitivePatterns = /KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;
  const safeEnv: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (allowedEnvVars.has(key) || !sensitivePatterns.test(key)) {
      safeEnv[key] = value;
    }
  }
  return safeEnv;
}

export async function runSkill(
  skill: SkillDefinition,
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<CollectorState> {
  const now = new Date();

  // Compute the collection window: use lastRunAt (if available) so we catch everything since
  // the last successful run — prevents gaps when the machine was off or the collector was
  // scheduled weekdays-only over a weekend. First runs fall back to firstRunLookback (or
  // lookback if that's not set), so freshly-added collectors get a sensible backfill window.
  const priorState = await loadCollectorState(vault, skill.name);
  const rawLastRun = priorState?.lastRunAt ? new Date(priorState.lastRunAt).getTime() : NaN;
  const firstRunWindow = parseLookback(skill.firstRunLookback ?? skill.lookback);
  const sinceMs = Number.isFinite(rawLastRun)
    ? rawLastRun
    : now.getTime() - firstRunWindow;
  const sinceDate = new Date(sinceMs);
  const systemConfig: Record<string, string> = {
    since_iso:  sinceDate.toISOString(),
    since_date: sinceDate.toISOString().slice(0, 10),
    since_unix: Math.floor(sinceMs / 1000).toString(),
    since_days: Math.max(1, Math.ceil((now.getTime() - sinceMs) / 86_400_000)).toString(),
    now_iso:    now.toISOString(),
    now_date:   now.toISOString().slice(0, 10),
    now_unix:   Math.floor(now.getTime() / 1000).toString(),
  };

  try {
    const config = await loadSkillConfig(vault, skill);
    const body = applyConfig(skill.body, { ...config, ...systemConfig }, skill);

    const isBuiltin = skill.location.includes("builtin-skills");
    const threats = scanSkillForThreats(body, isBuiltin);
    if (!threats.clean && threats.findings.some(f => f.severity === "high")) {
      const desc = threats.findings
        .filter(f => f.severity === "high")
        .map(f => f.description)
        .join("; ");
      throw new Error(`Skill "${skill.name}" blocked by security scanner: ${desc}`);
    }

    const commands = extractShellCommands(body);
    const commandOutputs: Array<{ command: string; output: string; error?: string }> = [];

    for (const cmd of commands) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
          timeout: 30000,
          env: filterEnv(skill),
        });
        commandOutputs.push({
          command: cmd,
          output: stdout.trim() || stderr.trim() || "(no output)",
        });
      } catch (e: any) {
        commandOutputs.push({
          command: cmd,
          output: e.stdout?.trim() || "",
          error: e.stderr?.trim() || e.message,
        });
      }
    }

    const allFailed = commands.length > 0 && commandOutputs.every((c) => c.error);
    if (allFailed) {
      const errors = commandOutputs.map((c) => c.error).join("; ");
      throw new Error(`All commands failed: ${errors}`);
    }

    const commandContext = commandOutputs.length > 0
      ? commandOutputs
          .map((c) =>
            `### Command: \`${c.command}\`\n${c.error ? `**Error:** ${c.error}\n` : ""}**Output:**\n${c.output}`
          )
          .join("\n\n")
      : "(No shell commands were executed)";

    const systemPrompt = [
      `You are a data collector producing a journal entry from the "${skill.name}" skill.`,
      `Today's date: ${now.toISOString().slice(0, 10)}`,
      `Collecting activity since: ${sinceDate.toISOString().slice(0, 10)}${priorState?.lastRunAt ? " (last run)" : " (first run — using lookback window)"}`,
      "",
      "The shell commands below have been executed and their outputs are provided.",
      "",
      "FIDELITY RULES (critical — downstream pipelines depend on these specifics):",
      "- Preserve every concrete identifier verbatim: commit SHAs, PR numbers, issue numbers, release tags, file paths, repo slugs, email subjects, calendar event titles, meeting attendees.",
      "- Preserve exact timestamps from the output (do not round to 'yesterday' or 'earlier today').",
      "- Do not abstract specifics into categories (e.g. do NOT write 'made several backend changes' — list the SHAs and messages).",
      "- Do not invent data that isn't in the command output.",
      "- If a command returned no output or failed, say so plainly.",
      "- Keep prose minimal — bullet-point facts are preferred over paragraphs.",
    ].join("\n");

    const prompt = [
      "## Skill Instructions\n",
      body,
      "\n\n## Command Outputs\n",
      commandContext,
    ].join("\n");

    const response = await provider.complete({ model, prompt, systemPrompt, temperature: 0.2 });

    if (response.trim()) {
      await appendActivity(vault, {
        timestamp: now.toISOString(),
        log: response.trim(),
        theme: "auto",
        source: skill.name,
      });
    }

    const state: CollectorState = {
      skillName: skill.name,
      lastRunAt: now.toISOString(),
      lastStatus: "success",
      entriesCollected: response.trim() ? 1 : 0,
    };
    await saveCollectorState(vault, state);
    return state;
  } catch (e: any) {
    // Preserve the previous successful lastRunAt so the next successful run re-collects
    // whatever window this failed run was meant to capture. Updating lastRunAt on failure
    // would advance the collection window past an un-captured block of time, leaking data.
    const state: CollectorState = {
      skillName: skill.name,
      lastRunAt: priorState?.lastRunAt ?? null,
      lastStatus: "error",
      lastError: e.message,
      entriesCollected: 0,
    };
    await saveCollectorState(vault, state);
    throw e;
  }
}

function parseLookback(lookback: string): number {
  const match = lookback.match(/^(\d+)(h|d|w)$/);
  if (!match) {
    console.error(`[skills] Unrecognised lookback "${lookback}", defaulting to 24h`);
    return 24 * 60 * 60 * 1000;
  }
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
