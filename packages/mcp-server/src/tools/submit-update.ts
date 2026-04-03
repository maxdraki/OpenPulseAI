import { appendActivity, type Vault } from "@openpulse/core";

export interface SubmitUpdateInput {
  content: string;
  source: string;
  theme?: string;
}

export async function handleSubmitUpdate(
  vault: Vault,
  input: SubmitUpdateInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const timestamp = new Date().toISOString();
  await appendActivity(vault, {
    timestamp,
    log: input.content,
    source: input.source,
    theme: input.theme,
  });
  const date = timestamp.slice(0, 10);
  return {
    content: [
      {
        type: "text" as const,
        text: `Recorded update from ${input.source} to ${date} log.${input.theme ? ` Theme: ${input.theme}` : ""}`,
      },
    ],
  };
}
