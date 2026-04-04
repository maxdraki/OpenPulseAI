import { describe, it, expect, vi } from "vitest";
import type { LlmProvider } from "@openpulse/core";
import { autoDiscover } from "../src/auto-discover.js";

function mockProvider(...responses: string[]): LlmProvider {
  const fn = vi.fn();
  responses.forEach((r) => fn.mockResolvedValueOnce(r));
  return { complete: fn };
}

function mockClient(tools: any[], toolResults: Record<string, string>) {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockImplementation((name: string) => ({
      content: [{ type: "text", text: toolResults[name] || "[]" }],
    })),
  } as any;
}

describe("autoDiscover", () => {
  it("generates plan and collects results", async () => {
    const tools = [{ name: "get_activity", description: "Get recent activity", inputSchema: {} }];
    const client = mockClient(tools, { get_activity: '[{"title":"PR merged"}]' });
    const provider = mockProvider(
      JSON.stringify([{ tool: "get_activity", args: {} }]),
      JSON.stringify([{ log: "PR merged on repo-x", theme: "development" }])
    );
    const items = await autoDiscover(client, provider, "test-model", new Date(), new Date());
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].log).toContain("PR merged");
  });

  it("returns empty array on LLM parse failure", async () => {
    const client = mockClient([], {});
    const provider = mockProvider("not valid json");
    const items = await autoDiscover(client, provider, "test-model", new Date(), new Date());
    expect(items).toEqual([]);
  });
});
