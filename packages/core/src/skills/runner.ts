import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { appendActivity } from "../hot.js";
import type { Vault } from "../vault.js";
import type { LlmProvider } from "../llm/provider.js";
import type { SkillDefinition, CollectorState } from "../types.js";
import { saveCollectorState } from "./scheduler.js";
import { scanSkillForThreats } from "./security.js";

const execFileAsync = promisify(execFile);

/**
 * Extract shell commands from a SKILL.md body.
 * Looks for inline backtick commands and fenced code blocks.
 */
export function extractShellCommands(body: string): string[] {
  const commands: string[] = [];

  const inlineRegex = /`([^`]+)`/g;
  let match;
  while ((match = inlineRegex.exec(body)) !== null) {
    const cmd = match[1].trim();
    if (cmd.includes(" ") || cmd.startsWith("./") || cmd.startsWith("$")) {
      // Skip things that look like code references (function calls, object literals)
      // but allow shell grouping like \( and ${ and escaped braces
      const looksLikeCode = /\w+\(/.test(cmd) && !cmd.includes("\\(");
      if (!looksLikeCode && !cmd.startsWith("//")) {
        commands.push(cmd);
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
  } catch { /* no user config */ }

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

function applyConfig(text: string, config: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const value = config[key];
    if (value === undefined) return `{{${key}}}`;
    // Expand ~ to home dir. For multi-line values (paths type),
    // escape each path separately so find/ls get them as separate args
    const lines = value.split("\n").filter((l) => l.trim());
    const expanded = lines.map(expandHome);
    return expanded.map(escapeForShell).join(" ");
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

  try {
    const config = await loadSkillConfig(vault, skill);
    const body = applyConfig(skill.body, config);

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

    const commandContext = commandOutputs.length > 0
      ? commandOutputs
          .map((c) =>
            `### Command: \`${c.command}\`\n${c.error ? `**Error:** ${c.error}\n` : ""}**Output:**\n${c.output}`
          )
          .join("\n\n")
      : "(No shell commands were executed)";

    const lookbackMs = parseLookback(skill.lookback);
    const since = new Date(now.getTime() - lookbackMs);

    const systemPrompt = [
      `You are a data collector summarising output from the "${skill.name}" skill.`,
      `Your goal: produce a factual journal entry that captures what actually happened,`,
      `so the user can later look back and understand their work activity.`,
      `Today's date: ${now.toISOString().slice(0, 10)}`,
      `Lookback period: ${skill.lookback} (since ${since.toISOString().slice(0, 10)})`,
      "",
      "The shell commands below have already been executed and their outputs are provided.",
      "Summarise ONLY what the command output shows. If a command returned no output,",
      "say so briefly. Never invent data that isn't in the command output.",
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
    const state: CollectorState = {
      skillName: skill.name,
      lastRunAt: now.toISOString(),
      lastStatus: "error",
      lastError: e.message,
      entriesCollected: 0,
    };
    await saveCollectorState(vault, state);
    return state;
  }
}

function parseLookback(lookback: string): number {
  const match = lookback.match(/^(\d+)(h|d|w)$/);
  if (!match) return 24 * 60 * 60 * 1000;
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
