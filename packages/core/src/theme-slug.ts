/**
 * Turn a free-form term into a safe theme filename slug.
 *
 * - Converts camelCase and PascalCase to kebab-case (TypeDecorators → type-decorators)
 * - Lowercases, replaces whitespace and underscores with "-"
 * - Strips path separators and ".." traversal
 * - Collapses consecutive dashes, trims leading dashes/dots/underscores
 * - Caps length at 100 characters
 */
export function sanitizeThemeSlug(name: string): string {
  return name
    .trim()
    // Insert dash between lowercase/digit → uppercase (typeDecorators → type-Decorators)
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    // Insert dash between run of uppercase and following Capitalized word (HTMLParser → HTML-Parser)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/[\/\\]/g, "")
    .replace(/\.\./g, "")
    .replace(/-+/g, "-")
    .replace(/^[-_.]+/, "")
    .replace(/[-_.]+$/, "")
    .slice(0, 100);
}
