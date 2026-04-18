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
  sources?: string[]; // for stub: theme names that mention the term
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

  // Track which themes mention each term
  const termSources = new Map<string, Set<string>>();

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

    // Record this theme as a source for each unique term seen in it
    for (const term of seenInThisTheme) {
      const sources = termSources.get(term) ?? new Set<string>();
      sources.add(themeName);
      termSources.set(term, sources);
    }
  }

  // Filter to terms mentioned in ≥ 3 themes
  const frequentTerms = Array.from(termSources.entries())
    .filter(([, sources]) => sources.size >= 3)
    .map(([term, sources]) => ({
      term,
      count: sources.size,
      sources: Array.from(sources),
    }));

  if (frequentTerms.length === 0) {
    return [];
  }

  const prompt = `You are reviewing a wiki for missing concept pages.

The wiki's purpose is to document **concepts, entities, and decisions** — not code-level implementation details.

For each term below, judge whether it is a **genuine concept worth its own page** or just an **internal code symbol** (e.g. TypeScript interface, variable name, class identifier, function parameter).

REJECT terms that are:
- TypeScript interfaces, classes, enums (e.g. UserState, Config, SourceData)
- Internal type names that only make sense in source code
- Acronyms or identifiers without a domain meaning outside code
- Technical plumbing (buffers, caches, contexts, handlers, registries)

ACCEPT terms that are:
- Domain concepts the user would discuss verbally with a colleague
- Named products, features, or user-facing workflows
- External services, protocols, or recognised design patterns
- Recurring decisions or tradeoffs worth recording

Terms (with occurrence count and source themes):
${frequentTerms
  .map((t) => `- "${t.term}" (${t.count} mentions in: ${t.sources.slice(0, 5).join(", ")})`)
  .join("\n")}

Existing pages: ${themeNames.join(", ")}

Respond with ONLY a JSON array of terms that deserve wiki pages. Be strict — default to rejecting.
[{"term": "TermName", "count": 3, "reason": "one sentence explaining why this is a domain concept, not a code symbol"}]
If nothing qualifies, return [].`;

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

    // Attach sources to each accepted term so downstream can build backlinks
    const sourcesByTerm = new Map(frequentTerms.map((t) => [t.term, t.sources]));

    return parsed.map((item) => ({
      type: "stub-candidate" as const,
      term: item.term,
      detail: item.reason,
      count: item.count,
      sources: sourcesByTerm.get(item.term) ?? [],
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
