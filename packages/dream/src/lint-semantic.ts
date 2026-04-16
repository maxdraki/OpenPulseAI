import type { Vault, LlmProvider } from "@openpulse/core";
import { listThemes, readTheme, vaultLog } from "@openpulse/core";

/**
 * Semantic issue found via LLM analysis.
 */
export interface SemanticIssue {
  type: "contradiction" | "stub-candidate";
  themes?: string[];  // for contradiction: the two conflicting theme names
  term?: string;      // for stub-candidate: the proposed theme name
  detail: string;
  count?: number;     // for stub: how many themes mention it
}

/**
 * Strip markdown code fences from an LLM response to extract raw JSON.
 */
function stripCodeFences(text: string): string {
  return text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

/**
 * Find terms mentioned in ≥3 themes that don't have their own wiki page.
 * Returns findings via a single LLM call.
 */
export async function findStubCandidates(
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<SemanticIssue[]> {
  const themeNames = await listThemes(vault);
  const themeSet = new Set(themeNames.map((n) => n.toLowerCase()));

  // Count how many themes mention each term
  const termCounts = new Map<string, number>();

  for (const themeName of themeNames) {
    const doc = await readTheme(vault, themeName);
    if (!doc) continue;

    const content = doc.content;
    const seenInThisTheme = new Set<string>();

    // Extract backtick-wrapped identifiers and CamelCase terms
    for (const match of content.matchAll(/`([a-zA-Z][a-zA-Z0-9_-]{2,})`/g)) {
      if (!themeSet.has(match[1].toLowerCase())) seenInThisTheme.add(match[1]);
    }
    for (const match of content.matchAll(/\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g)) {
      if (!themeSet.has(match[1].toLowerCase())) seenInThisTheme.add(match[1]);
    }

    // Increment count for each unique term seen in this theme
    for (const term of seenInThisTheme) {
      termCounts.set(term, (termCounts.get(term) ?? 0) + 1);
    }
  }

  // Filter to terms with count ≥ 3
  const frequentTerms = Array.from(termCounts.entries())
    .filter(([, count]) => count >= 3)
    .map(([term, count]) => ({ term, count }));

  if (frequentTerms.length === 0) {
    return [];
  }

  const prompt = `You are reviewing a wiki for missing concept pages. The following terms appear frequently across wiki pages but don't have their own page. For each term, decide if it deserves its own wiki page.

Terms (with occurrence count):
${frequentTerms.map((t) => `- "${t.term}" (${t.count} mentions)`).join("\n")}

Existing pages: ${themeNames.join(", ")}

Respond with ONLY a JSON array of terms that should become wiki pages:
[{"term": "TermName", "count": 3, "reason": "one sentence why"}]
If no terms deserve pages, return [].`;

  try {
    const response = await provider.complete({
      model,
      prompt,
      temperature: 0,
    });

    const parsed = JSON.parse(stripCodeFences(response)) as Array<{
      term: string;
      count: number;
      reason: string;
    }>;

    return parsed.map((item) => ({
      type: "stub-candidate" as const,
      term: item.term,
      detail: item.reason,
      count: item.count,
    }));
  } catch (err) {
    await vaultLog("error", "findStubCandidates: LLM call or JSON parse failed", String(err));
    return [];
  }
}

/**
 * Find contradictions between theme pairs via a single batched LLM call.
 */
export async function findContradictions(
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<SemanticIssue[]> {
  const themeNames = await listThemes(vault);

  // Read all theme content
  const themeContents = new Map<string, string>();
  for (const name of themeNames) {
    const doc = await readTheme(vault, name);
    if (doc) {
      themeContents.set(name, doc.content);
    }
  }

  // Extract [[link]] targets per theme
  const themeLinks = new Map<string, Set<string>>();
  for (const [name, content] of themeContents) {
    const targets = new Set<string>();
    for (const match of content.matchAll(/\[\[([^\]]+)\]\]/g)) {
      targets.add(match[1]);
    }
    themeLinks.set(name, targets);
  }

  // Find pairs of themes that share at least one [[link]] target
  type ThemePair = { a: string; b: string; contentA: string; contentB: string };
  const pairs: ThemePair[] = [];
  const names = Array.from(themeContents.keys());

  outer: for (let i = 0; i < names.length; i++) {
    for (let j = i + 1; j < names.length; j++) {
      if (pairs.length >= 10) break outer;

      const nameA = names[i];
      const nameB = names[j];
      const linksA = themeLinks.get(nameA) ?? new Set<string>();
      const linksB = themeLinks.get(nameB) ?? new Set<string>();

      const hasSharedLink = [...linksA].some((target) => linksB.has(target));
      if (hasSharedLink) {
        pairs.push({
          a: nameA,
          b: nameB,
          contentA: (themeContents.get(nameA) ?? "").slice(0, 800),
          contentB: (themeContents.get(nameB) ?? "").slice(0, 800),
        });
      }
    }
  }

  if (pairs.length === 0) {
    return [];
  }

  const prompt = `Review these pairs of wiki pages for factual contradictions. A contradiction is when one page states something that directly conflicts with what another page states about the same fact.

${pairs
  .map(
    (pair, i) =>
      `[${i}] "${pair.a}" vs "${pair.b}":\n${pair.a}: ${pair.contentA}\n---\n${pair.b}: ${pair.contentB}`
  )
  .join("\n\n===\n\n")}

Respond with ONLY a JSON array of contradictions found:
[{"pair": [0], "themes": ["a", "b"], "detail": "Page A says X, page B says Y — they conflict"}]
If no contradictions, return [].`;

  try {
    const response = await provider.complete({
      model,
      prompt,
      temperature: 0,
    });

    const parsed = JSON.parse(stripCodeFences(response)) as Array<{
      pair: number[];
      themes: string[];
      detail: string;
    }>;

    return parsed.map((item) => ({
      type: "contradiction" as const,
      themes: item.themes,
      detail: item.detail,
    }));
  } catch (err) {
    await vaultLog("error", "findContradictions: LLM call or JSON parse failed", String(err));
    return [];
  }
}
