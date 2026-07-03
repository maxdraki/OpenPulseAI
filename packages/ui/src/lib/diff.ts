/**
 * Small line-based diff (LCS) for the Review page's before/after view — see
 * `.superpowers/sdd/task-5-brief.md` §C. Pure function, no npm dependency:
 * classic LCS table + backtrack, same shape as `diff`/`git diff`'s line mode
 * (ties between "remove" and "add" at a change point resolve toward
 * removing first, matching the conventional unified-diff reading order).
 */
export type DiffOpType = "equal" | "add" | "remove";

export interface DiffOp {
  type: DiffOpType;
  text: string;
}

function splitLines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/**
 * Computes a line-level diff between `before` and `after`. Returns an
 * ordered list of ops — `equal` lines appear once, `remove` lines belong
 * only to `before`, `add` lines belong only to `after`.
 */
export function diffLines(before: string, after: string): DiffOp[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;

  // dp[i][j] = length of the LCS of a[i..n) and b[j..m)
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", text: a[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: "remove", text: a[i] });
      i++;
    } else {
      ops.push({ type: "add", text: b[j] });
      j++;
    }
  }
  while (i < n) {
    ops.push({ type: "remove", text: a[i] });
    i++;
  }
  while (j < m) {
    ops.push({ type: "add", text: b[j] });
    j++;
  }
  return ops;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders a `diffLines` result as HTML for the Review page's Diff toggle
 * (see `pages/review.ts`) — added lines green, removed lines red, via the
 * `.diff-*` classes in `styles.css` (CSS variables, so it works in both
 * light and dark themes). Text is HTML-escaped; this is safe to assign to
 * `innerHTML` directly.
 */
export function renderDiffHtml(before: string, after: string): string {
  const ops = diffLines(before, after);
  if (ops.length === 0) return `<div class="diff-empty">No content.</div>`;
  return ops
    .map((op) => {
      const marker = op.type === "add" ? "+" : op.type === "remove" ? "−" : " ";
      return `<div class="diff-line diff-${op.type}"><span class="diff-marker">${marker}</span><span class="diff-text">${escapeHtml(op.text) || "&nbsp;"}</span></div>`;
    })
    .join("");
}
