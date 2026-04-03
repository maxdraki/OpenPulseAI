import { readAllThemes, type Vault, type ThemeDocument } from "@openpulse/core";

export async function searchWarmFiles(vault: Vault, query: string): Promise<ThemeDocument[]> {
  const themes = await readAllThemes(vault);
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return themes;

  const scored = themes
    .map((doc) => {
      const haystack = `${doc.theme} ${doc.content}`.toLowerCase();
      const matchCount = words.filter((w) => haystack.includes(w)).length;
      return { doc, matchCount };
    })
    .filter((s) => s.matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount);

  return scored.map((s) => s.doc);
}
