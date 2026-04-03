import { saveIngestedDocument, type Vault } from "@openpulse/core";

export interface IngestDocumentInput {
  filename: string;
  content: string;
}

export async function handleIngestDocument(
  vault: Vault,
  input: IngestDocumentInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  await saveIngestedDocument(vault, input.filename, input.content);
  return {
    content: [{ type: "text" as const, text: `Ingested document: ${input.filename}` }],
  };
}
