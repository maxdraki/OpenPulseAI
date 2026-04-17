/**
 * Turn a free-form term into a safe theme filename slug.
 *
 * Lowercases, replaces whitespace with "-", strips path separators,
 * strips ".." traversal, trims leading dots/dashes/underscores, and
 * caps length at 100 characters.
 */
export function sanitizeThemeSlug(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[\/\\]/g, "")
    .replace(/\.\./g, "")
    .replace(/^[-_.]+/, "")
    .slice(0, 100);
}
