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

export function renderMarkdown(md: string): string {
  return marked.parse(md) as string;
}
