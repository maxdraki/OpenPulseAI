/**
 * Staleness detection for pending-update approval (see `PendingUpdate.previousContent`).
 *
 * A pending update's `proposedContent` was synthesized against the theme's
 * on-disk content at the time it was created (`previousContent`). If the
 * on-disk page changes before the user approves (another Dream run, a
 * compaction/lint update, or a hand-edit), approving would silently discard
 * whatever changed it in between. `checkStaleness` compares the two so
 * callers can refuse to write rather than clobber.
 */

/**
 * Normalize content for comparison: strip trailing whitespace from every
 * line and from the end of the string, so purely cosmetic differences
 * (trailing spaces, a missing final newline) never register as "changed".
 */
export function normalizeContentForCompare(content: string | null | undefined): string {
  if (content == null) return "";
  return content
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\s+$/, "");
}

export interface StalenessResult {
  /** True when the on-disk content has diverged from the update's `previousContent`. */
  stale: boolean;
  /**
   * True when `previousContent` was absent entirely (`undefined`) — a legacy
   * pending record created before staleness tracking existed. Legacy records
   * are never treated as stale (nothing to compare against), but callers
   * should log a warning so the gap is visible.
   */
  legacy: boolean;
}

/**
 * Compare a pending update's snapshot of a page (`previousContent`) against
 * the page's current on-disk content.
 *
 * - `previousContent === undefined` → legacy record, not stale (caller warns).
 * - `previousContent === null` and current is missing/empty → equal (both
 *   represent "brand-new theme, nothing on disk yet").
 * - Otherwise compared with trailing-whitespace normalization.
 */
export function checkStaleness(
  previousContent: string | null | undefined,
  currentContent: string | null | undefined
): StalenessResult {
  if (previousContent === undefined) {
    return { stale: false, legacy: true };
  }
  const stale = normalizeContentForCompare(previousContent) !== normalizeContentForCompare(currentContent);
  return { stale, legacy: false };
}
