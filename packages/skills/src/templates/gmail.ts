import type { CollectionTemplate, CollectedItem } from "./types.js";
import type { SourceMcpClient } from "../mcp-client.js";

export const gmailTemplate: CollectionTemplate = {
  name: "gmail",
  description: "Collect recent emails from Gmail MCP",
  async collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]> {
    const sinceStr = since.toISOString().slice(0, 10);
    const untilStr = until.toISOString().slice(0, 10);
    const result = await client.callTool("search_emails", {
      query: `after:${sinceStr} before:${untilStr}`,
      max_results: 50,
    });
    const items: CollectedItem[] = [];
    const content = result.content as Array<{ type: string; text: string }>;
    for (const block of content) {
      if (block.type === "text") {
        try {
          const emails = JSON.parse(block.text);
          for (const email of Array.isArray(emails) ? emails : [emails]) {
            items.push({
              log: `Email from ${email.from || "unknown"}: ${email.subject || "no subject"}\n${email.snippet || email.body || ""}`.trim(),
              timestamp: email.date || email.received || undefined,
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
