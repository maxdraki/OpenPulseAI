import type { LlmProvider } from "@openpulse/core";
import type { SourceMcpClient } from "./mcp-client.js";
import type { CollectedItem } from "./templates/types.js";

export async function autoDiscover(
  client: SourceMcpClient,
  provider: LlmProvider,
  model: string,
  since: Date,
  until: Date
): Promise<CollectedItem[]> {
  const tools = await client.listTools();
  if (tools.length === 0) return [];

  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description ?? "no description"}`)
    .join("\n");

  let plan: Array<{ tool: string; args: Record<string, unknown> }>;
  try {
    const planText = await provider.complete({
      model,
      prompt: `Given these MCP tools:\n${toolDescriptions}\n\nWhich tools should I call to gather user activity from ${since.toISOString()} to ${until.toISOString()}?\n\nReturn a JSON array: [{"tool": "tool_name", "args": {...}}]\nReturn ONLY the JSON array.`,
    });
    plan = JSON.parse(extractJson(planText));
  } catch {
    return [];
  }

  const rawResults: string[] = [];
  for (const step of plan) {
    try {
      const result = await client.callTool(step.tool, step.args);
      const content = result.content as Array<{ type: string; text: string }>;
      for (const block of content) {
        if (block.type === "text") rawResults.push(block.text);
      }
    } catch { /* skip failed tool calls */ }
  }

  if (rawResults.length === 0) return [];

  try {
    const formatted = await provider.complete({
      model,
      prompt: `Format these raw tool results as activity log entries:\n\n${rawResults.join("\n---\n")}\n\nReturn a JSON array: [{"log": "description of activity", "theme": "optional-theme"}]\nReturn ONLY the JSON array.`,
    });
    return JSON.parse(extractJson(formatted));
  } catch {
    return rawResults.map((r) => ({ log: r }));
  }
}

function extractJson(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  return text;
}
