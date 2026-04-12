/** Escape HTML entities in a string for safe insertion into templates. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** logo.dev CDN URL for a service logo */
const LOGO_TOKEN = "pk_LAYYrrRiTb2tIjkY-KCbMw";
export function logoUrl(domain: string, size = 48): string {
  return `https://img.logo.dev/${domain}?token=${LOGO_TOKEN}&size=${size}&format=png`;
}
