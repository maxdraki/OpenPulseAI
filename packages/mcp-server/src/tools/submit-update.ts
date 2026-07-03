import type { Vault } from "@openpulse/core";
import { handleRecordActivity } from "./record-activity.js";

export interface SubmitUpdateInput {
  content: string;
  source: string;
  theme?: string;
}

/**
 * @deprecated Thin backward-compatible alias over `handleRecordActivity`.
 * Prefer `record_activity` (with its optional `source` field) for new
 * integrations — this tool is kept registered only so existing clients
 * that already call `submit_update` keep working.
 */
export async function handleSubmitUpdate(
  vault: Vault,
  input: SubmitUpdateInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return handleRecordActivity(vault, {
    log: input.content,
    source: input.source,
    theme: input.theme,
  });
}
