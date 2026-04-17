import type { LlmProvider } from "@openpulse/core";

export interface CanonicalizationResult {
  redirects: Record<string, string>;
  proposals: Array<{
    proposed: string;
    canonical: string;
    reason: "levenshtein" | "prefix" | "llm";
  }>;
}

/** Lowercase, kebab-case, collapse repeats, trim leading/trailing separators. */
export function normalizeThemeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const dp: number[] = Array(b.length + 1).fill(0).map((_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[b.length];
}

function sharedPrefixLength(a: string, b: string): number {
  const min = Math.min(a.length, b.length);
  let i = 0;
  while (i < min && a[i] === b[i]) i++;
  return i;
}

/** Find all pairs within Levenshtein <= 2 or shared prefix >= 6 characters. */
export function findFuzzyMatches(names: string[]): Array<{ a: string; b: string; reason: "levenshtein" | "prefix" }> {
  const out: Array<{ a: string; b: string; reason: "levenshtein" | "prefix" }> = [];
  for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      const a = names[i], b = names[j];
      if (a === b) continue;
      if (levenshtein(a, b) <= 2) {
        out.push({ a, b, reason: "levenshtein" });
      } else if (sharedPrefixLength(a, b) >= 6) {
        out.push({ a, b, reason: "prefix" });
      }
    }
  }
  return out;
}

/** Main canonicalization entrypoint: hybrid deterministic + batched LLM. */
export async function canonicalizeThemes(
  proposed: string[],
  existing: string[],
  provider: LlmProvider,
  model: string
): Promise<CanonicalizationResult> {
  const redirects: Record<string, string> = {};
  const proposals: CanonicalizationResult["proposals"] = [];

  const existingNormalized = new Map(existing.map((name) => [normalizeThemeName(name), name] as const));
  const stillNew: string[] = [];

  // Pass 1: exact-after-normalization
  for (const p of proposed) {
    const norm = normalizeThemeName(p);
    const canonical = existingNormalized.get(norm);
    if (canonical) {
      redirects[p] = canonical;
    } else {
      stillNew.push(p);
    }
  }

  // Pass 2: fuzzy (Levenshtein or shared prefix)
  const stillTrulyNew: string[] = [];
  for (const p of stillNew) {
    const pNorm = normalizeThemeName(p);
    let matched = false;
    for (const existingName of existing) {
      const eNorm = normalizeThemeName(existingName);
      if (levenshtein(pNorm, eNorm) <= 2) {
        proposals.push({ proposed: p, canonical: existingName, reason: "levenshtein" });
        matched = true;
        break;
      }
      if (sharedPrefixLength(pNorm, eNorm) >= 6) {
        proposals.push({ proposed: p, canonical: existingName, reason: "prefix" });
        matched = true;
        break;
      }
    }
    if (!matched) stillTrulyNew.push(p);
  }

  // Pass 3: LLM (only if truly-new themes remain)
  if (stillTrulyNew.length > 0 && existing.length > 0) {
    try {
      const prompt = `Do any of these proposed themes refer to the same thing as any existing theme?

Proposed: ${stillTrulyNew.join(", ")}
Existing: ${existing.join(", ")}

Return ONLY a JSON array: [{"proposed": "...", "canonical": "..." | null}]
Set canonical to null if no match.`;
      const response = await provider.complete({ model, prompt, temperature: 0 });
      let jsonText = response.trim();
      if (jsonText.startsWith("```")) jsonText = jsonText.replace(/^```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      const parsed = JSON.parse(jsonText) as Array<{ proposed: string; canonical: string | null }>;
      for (const item of parsed) {
        if (item.canonical && existing.includes(item.canonical)) {
          proposals.push({ proposed: item.proposed, canonical: item.canonical, reason: "llm" });
        }
      }
    } catch {
      // LLM pass failure is non-fatal; deterministic proposals still apply.
    }
  }

  return { redirects, proposals };
}
