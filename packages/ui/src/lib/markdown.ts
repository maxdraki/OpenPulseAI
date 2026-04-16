/**
 * Markdown-to-HTML renderer for vault content.
 * Uses `marked` for proper parsing of headings, lists, nested lists, etc.
 * Input is from our own vault files (trusted), not arbitrary user input.
 */
import { marked } from "marked";

// Configure marked for compact output
marked.setOptions({
  gfm: true,
  breaks: false,
});

/**
 * Pre-process markdown before passing to marked:
 * - Convert [[wiki-links]] to anchor tags that navigate to the theme
 * - Strip ^[src:...] provenance markers (they're metadata, not display content)
 */
function preProcess(md: string, knownThemes?: Set<string>): string {
  // Strip provenance markers ^[src:...] and ^[inferred] etc.
  let out = md.replace(/\^\[src:[^\]]+\]/g, "").replace(/\^\[inferred\]/g, "").replace(/\^\[ambiguous\]/g, "");

  // Convert [[theme-name]] to a link only if the theme exists, otherwise plain text
  out = out.replace(/\[\[([^\]]+)\]\]/g, (_match, name) => {
    if (knownThemes && !knownThemes.has(name)) return name;
    const href = `#themes/${encodeURIComponent(name)}`;
    return `<a href="${href}" class="wiki-link" data-theme="${name}">${name}</a>`;
  });

  return out;
}

export function renderMarkdown(md: string, knownThemes?: Set<string>): string {
  return marked.parse(preProcess(md, knownThemes)) as string;
}
