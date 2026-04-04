/**
 * Lightweight markdown-to-HTML renderer for vault content.
 * Handles: headings, bold, italic, code, lists, paragraphs.
 * Input is from our own vault files (trusted), not user input.
 */
export function renderMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .split("\n")
    .map((line) => {
      // Headings
      if (line.startsWith("#### ")) return `<h6>${line.slice(5)}</h6>`;
      if (line.startsWith("### ")) return `<h5>${line.slice(4)}</h5>`;
      if (line.startsWith("## ")) return `<h4>${line.slice(3)}</h4>`;
      if (line.startsWith("# ")) return `<h3>${line.slice(2)}</h3>`;

      // List items
      if (/^\s*[-*]\s/.test(line)) {
        const content = line.replace(/^\s*[-*]\s+/, "");
        return `<li>${inlineFormat(content)}</li>`;
      }

      // Empty lines become breaks
      if (line.trim() === "") return "";

      // Regular paragraph
      return `<p>${inlineFormat(line)}</p>`;
    })
    .join("\n");
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
