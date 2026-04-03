import type { CollectionTemplate, CollectedItem } from "./types.js";
import type { SourceMcpClient } from "../mcp-client.js";

export const calendarTemplate: CollectionTemplate = {
  name: "google-calendar",
  description: "Collect events from Google Calendar MCP",
  async collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]> {
    const result = await client.callTool("list_events", {
      start: since.toISOString(),
      end: until.toISOString(),
    });
    const items: CollectedItem[] = [];
    const content = result.content as Array<{ type: string; text: string }>;
    for (const block of content) {
      if (block.type === "text") {
        try {
          const events = JSON.parse(block.text);
          for (const event of Array.isArray(events) ? events : [events]) {
            items.push({
              log: `Calendar: ${event.summary || event.title || "Untitled"} (${event.start || "?"} - ${event.end || "?"})${event.location ? ` at ${event.location}` : ""}`,
              timestamp: event.start || undefined,
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
