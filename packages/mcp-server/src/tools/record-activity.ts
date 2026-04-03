import { appendActivity, type Vault } from "@openpulse/core";

export interface RecordActivityInput {
  log: string;
  theme?: string;
}

export async function handleRecordActivity(
  vault: Vault,
  input: RecordActivityInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const timestamp = new Date().toISOString();
  await appendActivity(vault, { timestamp, log: input.log, theme: input.theme });
  const date = timestamp.slice(0, 10);
  return {
    content: [
      {
        type: "text" as const,
        text: `Recorded activity to ${date} log.${input.theme ? ` Theme: ${input.theme}` : ""}`,
      },
    ],
  };
}
