/**
 * Lightweight markdown-to-HTML renderer for vault content.
 * Handles: headings, bold, italic, code, lists, paragraphs.
 * Groups consecutive list items into <ul> blocks.
 * Input is from our own vault files (trusted), not user input.
 */
export function renderMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  const lines = escaped.split("\n");
  const output: string[] = [];
  let inList = false;

  for (const line of lines) {
    const isListItem = /^\s*[-*]\s/.test(line);

    if (isListItem && !inList) {
      output.push("<ul>");
      inList = true;
    } else if (!isListItem && inList) {
      output.push("</ul>");
      inList = false;
    }

    // Headings
    if (line.startsWith("#### ")) { output.push(`<h6>${inlineFormat(line.slice(5))}</h6>`); continue; }
    if (line.startsWith("### ")) { output.push(`<h5>${inlineFormat(line.slice(4))}</h5>`); continue; }
    if (line.startsWith("## ")) { output.push(`<h4>${inlineFormat(line.slice(3))}</h4>`); continue; }
    if (line.startsWith("# ")) { output.push(`<h3>${inlineFormat(line.slice(2))}</h3>`); continue; }

    // List items
    if (isListItem) {
      const content = line.replace(/^\s*[-*]\s+/, "");
      output.push(`<li>${inlineFormat(content)}</li>`);
      continue;
    }

    // Empty lines
    if (line.trim() === "") continue;

    // Regular paragraph
    output.push(`<p>${inlineFormat(line)}</p>`);
  }

  if (inList) output.push("</ul>");

  return output.join("\n");
}

function inlineFormat(text: string): string {
  return text
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}
