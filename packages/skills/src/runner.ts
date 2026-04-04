import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendActivity,
  type Vault,
  type LlmProvider,
  type SkillDefinition,
  type CollectorState,
} from "@openpulse/core";
import { saveCollectorState } from "./scheduler.js";

const execFileAsync = promisify(execFile);

/**
 * Extract shell commands from a SKILL.md body.
 * Looks for inline backtick commands and fenced code blocks.
 */
export function extractShellCommands(body: string): string[] {
  const commands: string[] = [];

  // Match inline backtick commands that look like shell: `command args`
  const inlineRegex = /`([^`]+)`/g;
  let match;
  while ((match = inlineRegex.exec(body)) !== null) {
    const cmd = match[1].trim();
    // Filter: must contain a space (command + args) or start with common command chars
    if (cmd.includes(" ") || cmd.startsWith("./") || cmd.startsWith("$")) {
      // Skip things that look like code references, not commands
      if (!cmd.includes("(") && !cmd.includes("{") && !cmd.startsWith("//")) {
        commands.push(cmd);
      }
    }
  }

  // Match fenced code blocks: ```bash\ncommand\n```
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

/**
 * Execute a skill: extract shell commands, pre-run them, send outputs to LLM, write result to hot.
 */
export async function runSkill(
  skill: SkillDefinition,
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<CollectorState> {
  const now = new Date();

  try {
    // 1. Extract and pre-execute shell commands
    const commands = extractShellCommands(skill.body);
    const commandOutputs: Array<{ command: string; output: string; error?: string }> = [];

    for (const cmd of commands) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
          timeout: 30000,
          env: process.env,
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

    // 2. Build prompt with command outputs
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
      `You are OpenPulse executing the skill "${skill.name}".`,
      `Today's date: ${now.toISOString().slice(0, 10)}`,
      `Lookback period: ${skill.lookback} (since ${since.toISOString().slice(0, 10)})`,
      "",
      "Follow the skill instructions below. The shell commands referenced in the instructions",
      "have already been executed and their outputs are provided. Synthesize these outputs into",
      "a clear, concise Markdown summary. Focus on what's actionable or status-relevant.",
    ].join("\n");

    const prompt = [
      "## Skill Instructions\n",
      skill.body,
      "\n\n## Command Outputs\n",
      commandContext,
    ].join("\n");

    // 3. Send to LLM
    const response = await provider.complete({ model, prompt, systemPrompt });

    // 4. Write to hot layer
    if (response.trim()) {
      await appendActivity(vault, {
        timestamp: now.toISOString(),
        log: response.trim(),
        theme: "auto",
        source: skill.name,
      });
    }

    // 5. Save state
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
