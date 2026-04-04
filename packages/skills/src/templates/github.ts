import type { CollectionTemplate, CollectedItem } from "./types.js";
import type { SourceMcpClient } from "../mcp-client.js";

export const githubTemplate: CollectionTemplate = {
  name: "github",
  description: "Collect activity from GitHub MCP",
  async collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]> {
    const result = await client.callTool("get_notifications", {
      since: since.toISOString(),
      all: true,
    });
    const items: CollectedItem[] = [];
    const content = result.content as Array<{ type: string; text: string }>;
    for (const block of content) {
      if (block.type === "text") {
        try {
          const notifications = JSON.parse(block.text);
          for (const n of Array.isArray(notifications) ? notifications : [notifications]) {
            items.push({
              log: `GitHub: ${n.type || "activity"} — ${n.subject?.title || n.title || n.reason || "notification"} on ${n.repository?.full_name || n.repo || "unknown"}`,
              timestamp: n.updated_at || n.created_at || undefined,
            });
          }
        } catch {
          items.push({ log: block.text });
        }
      }
    }
    return items;
  },
};
