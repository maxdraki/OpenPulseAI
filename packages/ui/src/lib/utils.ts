/** Escape HTML entities in a string for safe insertion into templates. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Create a DOM element with attributes and optional text content. Prefer this
 * over innerHTML when any value originates from the filesystem or API — text
 * goes through textContent so nothing is ever interpreted as HTML.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== undefined) node.setAttribute(key, value);
  }
  if (text !== undefined) node.textContent = text;
  return node;
}

/** logo.dev CDN URL for a service logo */
const LOGO_TOKEN = "pk_LAYYrrRiTb2tIjkY-KCbMw";
export function logoUrl(domain: string, size = 48): string {
  return `https://img.logo.dev/${domain}?token=${LOGO_TOKEN}&size=${size}&format=png`;
}
