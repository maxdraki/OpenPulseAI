import { type Vault } from "@openpulse/core";
import { searchWarmFiles } from "../search.js";

export interface QueryMemoryInput {
  query: string;
}

export async function handleQueryMemory(
  vault: Vault,
  input: QueryMemoryInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const results = await searchWarmFiles(vault, input.query);

  if (results.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: `No thematic summaries found matching: "${input.query}"`,
        },
      ],
    };
  }

  const formatted = results
    .map((doc) => `## ${doc.theme}\n\n${doc.content}`)
    .join("\n\n---\n\n");

  return {
    content: [
      {
        type: "text" as const,
        text: `Found ${results.length} theme(s) matching "${input.query}":\n\n${formatted}`,
      },
    ],
  };
}
