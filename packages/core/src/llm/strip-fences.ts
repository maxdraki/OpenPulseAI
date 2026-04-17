/**
 * Strip surrounding Markdown code fences (```json ... ``` or ``` ... ```)
 * from an LLM response so the inner payload can be parsed directly.
 * Trims first; if the trimmed text starts with a code fence, both the leading
 * and trailing fences are removed. Returns the trimmed text unchanged
 * otherwise.
 */
export function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  return trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
}
