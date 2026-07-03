import { appendActivity, type Vault } from "@openpulse/core";

export interface RecordActivityInput {
  log: string;
  theme?: string;
  source?: string;
}

/**
 * Shared implementation for recording activity into the hot layer. Backs
 * both `record_activity` (the primary, recommended tool) and `submit_update`
 * (kept registered as a thin deprecated alias for backward compatibility —
 * see server.ts).
 */
export async function handleRecordActivity(
  vault: Vault,
  input: RecordActivityInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const timestamp = new Date().toISOString();
  await appendActivity(vault, {
    timestamp,
    log: input.log,
    theme: input.theme,
    source: input.source,
  });
  const date = timestamp.slice(0, 10);
  return {
    content: [
      {
        type: "text" as const,
        text: `Recorded activity to ${date} log.${input.source ? ` Source: ${input.source}.` : ""}${input.theme ? ` Theme: ${input.theme}` : ""}`,
      },
    ],
  };
}
