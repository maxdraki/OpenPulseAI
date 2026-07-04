import { listPendingUpdates, approveUpdate, approveUpdatesBatch, rejectUpdate, regeneratePendingUpdate, resubmitAigisRollup, ApiError, type PendingUpdate, type AigisSubmissionOutcome } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { renderDiffHtml } from "../lib/diff.js";
import { log } from "../lib/logger.js";
import { confirmDialog } from "../lib/dialog.js";

/** True when `err` is a stale-conflict 409 from the approve endpoint (see
 *  `packages/ui/server.ts`'s `POST /api/approve-update`). */
function isStaleConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | undefined)?.error === "stale";
}

// --- Pure per-item selection logic (batch approve/reject within a multi-item
// batch) — kept side-effect-free so it's directly unit-testable; see
// packages/ui/test/review-selection.test.ts. ---

/** Label for the batch header's approve button. Reads "Approve All (n)" when
 *  every card is checked (least-surprise default — matches the old
 *  behavior), or "Approve Selected (n)" once anything is unchecked. */
export function computeApproveLabel(total: number, selected: number): string {
  return selected === total ? `Approve All (${total})` : `Approve Selected (${selected})`;
}

/** Symmetric with computeApproveLabel — same "All" vs "Selected" rule for the
 *  Reject button. */
export function computeRejectLabel(total: number, selected: number): string {
  return selected === total ? `Reject All (${total})` : `Reject Selected (${selected})`;
}

/** One-line "N updates · M selected" summary shown in the batch header. */
export function batchSummaryLine(total: number, selected: number): string {
  return `${total} update${total === 1 ? "" : "s"} · ${selected} selected`;
}

/** Ids of the items whose id is present in `selected`, in `items` order —
 *  what gets sent to the batch approve/reject calls. */
export function selectedUpdateIds<T extends { id: string }>(items: readonly T[], selected: ReadonlySet<string>): string[] {
  return items.filter((item) => selected.has(item.id)).map((item) => item.id);
}

/** "Select all / none" toggle: selects every id unless every id is already
 *  selected, in which case it clears the selection. (An empty selection is
 *  not "all selected", so it selects all rather than no-op-ing.) */
export function toggleSelectAll(ids: readonly string[], current: ReadonlySet<string>): Set<string> {
  const allSelected = ids.length > 0 && ids.every((id) => current.has(id));
  return allSelected ? new Set() : new Set(ids);
}

/** Rebuilds a batch's selection set for a fresh `loadPending()` reload from a
 *  persisted set of *deselected* ids (see the module-level `deselectedByBatch`
 *  map in review.ts). Every current id is selected except the ones recorded
 *  as deselected — so unchecking a few cards in a large batch survives a
 *  reload triggered by acting on a different card. `deselected` is mutated in
 *  place to drop ids that no longer appear in `ids` (approved/rejected items,
 *  or a batch that shrank), so the persisted set never grows unboundedly. */
export function rebuildSelection(ids: readonly string[], deselected: Set<string>): Set<string> {
  const idSet = new Set(ids);
  for (const id of deselected) {
    if (!idSet.has(id)) deselected.delete(id);
  }
  return new Set(ids.filter((id) => !deselected.has(id)));
}

// Note: renderMarkdown uses the `marked` library which handles HTML escaping.
// The vault content rendered here is from our own dream pipeline, not arbitrary user input.

export async function renderReview(container: HTMLElement): Promise<void> {
  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Review";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Approve, edit, or reject proposed theme updates";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  const summaryEl = document.createElement("div");
  summaryEl.id = "review-batch-summary";
  summaryEl.className = "review-batch-summary";
  summaryEl.style.display = "none";

  const listEl = document.createElement("div");
  listEl.id = "pending-list";

  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(summaryEl);
  container.appendChild(listEl);

  await loadPending(listEl);
}

/** Shows a transient summary above the pending list (survives `loadPending`'s
 *  re-render of `listEl`, since it lives outside it) — e.g. how many items an
 *  "Approve All" skipped as stale. */
function showReviewSummary(message: string): void {
  const el = document.getElementById("review-batch-summary");
  if (!el) return;
  el.textContent = message;
  el.style.display = "";
}

/** Persists which ids the user has *deselected* within each batch, keyed by
 *  batchKey, across `loadPending()` reloads. `loadPending` re-runs after any
 *  single card's Approve/Reject/Regenerate — not just batch actions — so
 *  without this, a batch's `selected` set (previously re-initialized to
 *  all-checked on every call) would silently forget any cards the user had
 *  unchecked the moment they acted on an unrelated card. See
 *  `rebuildSelection` for how a fresh id list is reconciled against this. */
const deselectedByBatch = new Map<string, Set<string>>();

async function loadPending(listEl: HTMLElement): Promise<void> {
  listEl.textContent = "";

  try {
    const updates = await listPendingUpdates();

    if (updates.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const icon = document.createElement("div");
      icon.className = "empty-state-icon";
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("width", "22");
      svg.setAttribute("height", "22");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("fill", "none");
      svg.setAttribute("stroke", "currentColor");
      svg.setAttribute("stroke-width", "2");
      const polyline = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      polyline.setAttribute("points", "20 6 9 17 4 12");
      svg.appendChild(polyline);
      icon.appendChild(svg);
      const msg = document.createElement("p");
      msg.textContent = "All clear. Run the Dream Pipeline from the Dashboard to generate new proposals.";
      empty.appendChild(icon);
      empty.appendChild(msg);
      listEl.appendChild(empty);
      return;
    }

    // Group updates by batchId; ungrouped items use their own id as the key
    const batches = new Map<string, PendingUpdate[]>();
    for (const update of updates) {
      const key = update.batchId ?? update.id;
      const group = batches.get(key) ?? [];
      group.push(update);
      batches.set(key, group);
    }

    // Drop persisted deselections for batches that no longer exist (fully
    // approved/rejected) so the map doesn't grow unboundedly.
    for (const key of Array.from(deselectedByBatch.keys())) {
      if (!batches.has(key)) deselectedByBatch.delete(key);
    }

    for (const [batchKey, batchUpdates] of batches) {
      if (batchUpdates.length > 1) {
        // Render batch header with Approve All / Reject All
        const batchHeader = document.createElement("div");
        batchHeader.className = "batch-header";

        const batchLabel = document.createElement("span");
        const batchDate = new Date(batchKey).toLocaleDateString("en-GB", {
          day: "numeric", month: "short", year: "numeric",
          hour: "2-digit", minute: "2-digit",
        });
        // Check if this is a sub-kind batch
        const firstItem = batchUpdates[0];
        if (firstItem?.lintFix) {
          batchLabel.textContent = `Lint Fix — ${firstItem.lintFix}: ${batchUpdates.length} page(s)`;
          batchLabel.style.color = "var(--warning, #d97706)";
        } else if (firstItem?.compactionType) {
          batchLabel.textContent = `Compaction (${firstItem.compactionType}): ${batchUpdates.length} theme(s)`;
          batchLabel.style.color = "var(--warning, #d97706)";
        } else if (firstItem?.schemaEvolution) {
          batchLabel.textContent = `Schema Evolution (${firstItem.schemaEvolution.confidence}): ${batchUpdates.length} change(s)`;
          batchLabel.style.color = "var(--warning, #d97706)";
        } else if (firstItem?.querybackSource) {
          batchLabel.textContent = `From chat: ${batchUpdates.length} theme(s)`;
          batchLabel.style.color = "var(--accent, #2563eb)";
        } else if (firstItem?.aigisRollup) {
          batchLabel.textContent = `Aigis rollup: ${batchUpdates.length} period(s)`;
          batchLabel.style.color = "#0f766e";
        } else {
          batchLabel.textContent = `Dream run: ${batchDate} — ${batchUpdates.length} themes updated`;
        }

        // Per-item selection — defaults to everything checked (least-surprise:
        // "Approve All" still means all, until the user unchecks something),
        // but reconciled against any deselections persisted from a previous
        // render of this same batch (see `deselectedByBatch` / `rebuildSelection`)
        // so they survive a reload triggered by acting on a different card.
        const allIds = batchUpdates.map((u) => u.id);
        const deselected = deselectedByBatch.get(batchKey) ?? new Set<string>();
        deselectedByBatch.set(batchKey, deselected);
        const selected = rebuildSelection(allIds, deselected);

        const batchSummary = document.createElement("span");
        batchSummary.className = "batch-summary";

        const batchActions = document.createElement("div");
        batchActions.className = "batch-actions";

        const selectAllBtn = document.createElement("button");
        selectAllBtn.className = "btn btn-secondary";

        const approveAllBtn = document.createElement("button");
        approveAllBtn.className = "btn btn-success";

        const rejectAllBtn = document.createElement("button");
        rejectAllBtn.className = "btn btn-danger";

        /** Keeps the summary line + button labels/disabled-state in sync with
         *  the live `selected` set — called after every checkbox toggle. */
        function refreshBatchHeader(): void {
          const n = selected.size;
          batchSummary.textContent = batchSummaryLine(allIds.length, n);
          approveAllBtn.textContent = computeApproveLabel(allIds.length, n);
          rejectAllBtn.textContent = computeRejectLabel(allIds.length, n);
          approveAllBtn.disabled = n === 0;
          rejectAllBtn.disabled = n === 0;
          selectAllBtn.textContent = n === allIds.length ? "Select None" : "Select All";
        }
        refreshBatchHeader();

        /** Sets a batch's in-flight state: disables the header buttons plus
         *  every per-card checkbox and the select-all toggle, so the user
         *  can't change the selection mid-request (minor fix alongside the
         *  persisted-deselection bug — see task-12 fix round 1). */
        function setBatchBusy(busy: boolean): void {
          approveAllBtn.disabled = busy || selected.size === 0;
          rejectAllBtn.disabled = busy || selected.size === 0;
          selectAllBtn.disabled = busy;
          for (const cb of checkboxes.values()) cb.disabled = busy;
        }

        selectAllBtn.addEventListener("click", () => {
          const next = toggleSelectAll(allIds, selected);
          selected.clear();
          for (const id of next) selected.add(id);
          deselected.clear();
          for (const id of allIds) {
            if (!selected.has(id)) deselected.add(id);
          }
          refreshBatchHeader();
          for (const cb of checkboxes.values()) cb.checked = selected.has(cb.dataset.updateId!);
        });

        approveAllBtn.addEventListener("click", async () => {
          const ids = selectedUpdateIds(batchUpdates, selected);
          if (ids.length === 0) return;
          setBatchBusy(true);
          try {
            // One server-side batch call so the whole action lands as a single
            // vault-git commit listing every theme (see approve.ts's
            // approvePendingUpdatesBatch) instead of one commit per item.
            const results = await approveUpdatesBatch(ids);
            const staleCount = results.filter((r) => !r.ok && r.stale).length;
            const otherFailed = results.filter((r) => !r.ok && !r.stale).length;
            // Aigis outcomes are per-item and the cards are about to be torn
            // down by loadPending() below — summarize here instead (see the
            // single-card path above, which keeps the card around so its own
            // outcome/retry can be shown inline; a whole batch doesn't have
            // that luxury without a lot more UI, so a summary line + "check
            // Settings" pointer is the pragmatic version for now).
            const aigisFailed = results.filter((r) => r.ok && r.aigisSubmission && !r.aigisSubmission.ok && !r.aigisSubmission.skipped).length;
            const aigisSkipped = results.filter((r) => r.ok && r.aigisSubmission?.skipped).length;

            if (otherFailed) log("error", `Approved batch with ${otherFailed} failure(s): ${batchKey}`);
            if (staleCount) log("warn", `Approved batch: ${staleCount} item(s) skipped as stale: ${batchKey}`);
            if (!otherFailed && !staleCount) log("info", `Approved batch: ${batchKey}`);

            await loadPending(listEl);
            updateReviewBadge();

            const summaryParts: string[] = [];
            if (staleCount) summaryParts.push(`${staleCount} skipped — page changed since proposed`);
            if (otherFailed) summaryParts.push(`${otherFailed} failed`);
            if (aigisFailed) summaryParts.push(`${aigisFailed} Aigis submission(s) failed — retry from Settings`);
            if (aigisSkipped) summaryParts.push(`${aigisSkipped} Aigis submission(s) skipped — not connected`);
            if (summaryParts.length > 0) {
              showReviewSummary(`Approve: ${summaryParts.join(", ")}. Approved the rest.`);
            }
          } catch (e: unknown) {
            // Request itself failed (network error, 500, etc.) — nothing was
            // necessarily approved server-side, so re-enable the buttons
            // rather than leaving the batch permanently stuck (M7).
            log("error", `Approve failed: ${batchKey}`, String(e));
            showReviewSummary("Approve failed — please try again.");
            setBatchBusy(false);
          }
        });

        function doRejectSelected(): void {
          const ids = selectedUpdateIds(batchUpdates, selected);
          if (ids.length === 0) return;
          setBatchBusy(true);
          void (async () => {
            const results = await Promise.allSettled(ids.map((id) => rejectUpdate(id)));
            const failed = results.filter((r) => r.status === "rejected").length;
            if (failed) log("error", `Rejected batch with ${failed} failure(s): ${batchKey}`);
            else log("info", `Rejected batch: ${batchKey}`);
            await loadPending(listEl);
            updateReviewBadge();
          })();
        }

        rejectAllBtn.addEventListener("click", () => {
          const n = selected.size;
          // A bulk reject of more than a handful of items is destructive and
          // easy to fat-finger after unchecking a few cards — confirm first.
          if (n > 3) {
            confirmDialog(`Reject ${n} selected update${n === 1 ? "" : "s"}? This can't be undone.`, doRejectSelected);
          } else {
            doRejectSelected();
          }
        });

        batchActions.appendChild(selectAllBtn);
        batchActions.appendChild(approveAllBtn);
        batchActions.appendChild(rejectAllBtn);
        batchHeader.appendChild(batchLabel);
        batchHeader.appendChild(batchSummary);
        batchHeader.appendChild(batchActions);
        listEl.appendChild(batchHeader);

        // Render individual cards with a per-item include checkbox.
        const checkboxes = new Map<string, HTMLInputElement>();
        for (const update of batchUpdates) {
          const { card, checkbox } = buildCard(update, listEl, {
            checked: selected.has(update.id),
            onToggle: (checked) => {
              if (checked) {
                selected.add(update.id);
                deselected.delete(update.id);
              } else {
                selected.delete(update.id);
                deselected.add(update.id);
              }
              refreshBatchHeader();
            },
          });
          if (checkbox) checkboxes.set(update.id, checkbox);
          listEl.appendChild(card);
        }
        continue;
      }

      // Single-item batch — keep the plain per-card UI, no checkbox clutter.
      for (const update of batchUpdates) {
        listEl.appendChild(buildCard(update, listEl).card);
      }
    }
  } catch (e: any) {
    const errDiv = document.createElement("div");
    errDiv.className = "card";
    errDiv.style.color = "var(--danger)";
    errDiv.textContent = `Error loading pending updates: ${e}`;
    listEl.appendChild(errDiv);
  }
}

interface SubKindBadgeSpec {
  cls: string;
  text: string;
}

function subKindBadge(update: PendingUpdate): SubKindBadgeSpec | null {
  if (update.compactionType) {
    return { cls: "type-compact", text: `Compaction (${update.compactionType})` };
  }
  if (update.schemaEvolution) {
    return { cls: "type-schema", text: `Schema (${update.schemaEvolution.confidence})` };
  }
  if (update.querybackSource) {
    return { cls: "type-chat", text: "From chat" };
  }
  if (update.aigisRollup) {
    const period = new Date(update.aigisRollup.periodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    return { cls: "type-aigis", text: `Aigis rollup · ${period}` };
  }
  if (update.lintFix) {
    const label =
      update.lintFix === "merge"        ? "Lint merge"        :
      update.lintFix === "delete"       ? "Lint delete"       :
      update.lintFix === "rename"       ? "Lint rename"       :
      update.lintFix === "orphans"      ? "Lint orphan"       :
      update.lintFix === "stubs"        ? "Lint stub"         :
      update.lintFix === "broken-link"  ? "Lint fix-links"    :
      update.lintFix === "dedup-dates"  ? "Lint dedup-dates"  : `Lint ${update.lintFix}`;
    return { cls: "type-lint", text: label };
  }
  return null;
}

interface CardSelectionOptions {
  checked: boolean;
  onToggle: (checked: boolean) => void;
}

interface BuiltCard {
  card: HTMLElement;
  /** Present only when `selection` was passed in (multi-item batch). */
  checkbox: HTMLInputElement | null;
}

function buildCard(update: PendingUpdate, listEl: HTMLElement, selection?: CardSelectionOptions): BuiltCard {
  const card = document.createElement("div");
  card.className = "pending-card";

  // Header: theme badge + date
  const header = document.createElement("div");
  header.className = "pending-header";

  let checkbox: HTMLInputElement | null = null;
  if (selection) {
    checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "pending-select-checkbox";
    checkbox.checked = selection.checked;
    checkbox.dataset.updateId = update.id;
    checkbox.setAttribute("aria-label", `Include ${update.theme} in batch action`);
    checkbox.addEventListener("change", () => selection.onToggle(checkbox!.checked));
    header.appendChild(checkbox);
  }

  const badge = document.createElement("span");
  badge.className = "pending-theme-badge";
  badge.textContent = update.theme;
  const typeBadge = document.createElement("span");
  typeBadge.className = `pending-type-badge type-${(update as any).type ?? "project"}`;
  typeBadge.textContent = (update as any).type ?? "project";
  const date = document.createElement("span");
  date.className = "pending-date";
  date.textContent = new Date(update.createdAt).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  header.appendChild(badge);
  header.appendChild(typeBadge);

  // Sub-kind badge (compaction / schema / queryback / lint-fix)
  const subKind = subKindBadge(update);
  if (subKind) {
    const subKindEl = document.createElement("span");
    subKindEl.className = `pending-type-badge ${subKind.cls}`;
    subKindEl.textContent = subKind.text;
    header.appendChild(subKindEl);
  }

  header.appendChild(date);

  // Proposed content label
  const label = document.createElement("div");
  label.className = "pending-section-label";
  label.textContent = "Proposed Update";

  // Rendered markdown preview (vault content rendered via marked library)
  const contentPreview = document.createElement("div");
  contentPreview.className = "pending-preview md-content";
  const rendered = renderMarkdown(update.proposedContent);
  contentPreview.innerHTML = rendered; // safe: marked escapes HTML, content is from our own pipeline

  // Hidden textarea for editing
  const textarea = document.createElement("textarea");
  textarea.className = "pending-textarea";
  textarea.style.display = "none";
  textarea.value = update.proposedContent;

  // Before/after diff view (hidden until the Diff toggle is used) — see
  // renderDiffHtml in ../lib/diff.js. Updates with no previousContent (new
  // pages, or legacy pre-staleness-tracking records) have nothing to diff
  // against, so the toggle is disabled with a hint rather than silently
  // rendering a whole-page "added" diff.
  const hasPreviousContent = update.previousContent != null;
  const diffContainer = document.createElement("div");
  diffContainer.className = "pending-diff";
  diffContainer.style.display = "none";

  // Actions row
  const actions = document.createElement("div");
  actions.className = "pending-actions";

  const approveBtn = document.createElement("button");
  approveBtn.className = "btn btn-success";
  approveBtn.textContent = " Approve";
  const approveSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  approveSvg.setAttribute("width", "14");
  approveSvg.setAttribute("height", "14");
  approveSvg.setAttribute("viewBox", "0 0 24 24");
  approveSvg.setAttribute("fill", "none");
  approveSvg.setAttribute("stroke", "currentColor");
  approveSvg.setAttribute("stroke-width", "2");
  const checkPoly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  checkPoly.setAttribute("points", "20 6 9 17 4 12");
  approveSvg.appendChild(checkPoly);
  approveBtn.prepend(approveSvg);

  const editBtn = document.createElement("button");
  editBtn.className = "btn btn-secondary";
  editBtn.textContent = "Edit";

  const diffBtn = document.createElement("button");
  diffBtn.className = "btn btn-secondary";
  diffBtn.textContent = "Diff";
  if (!hasPreviousContent) {
    diffBtn.disabled = true;
    diffBtn.title = "No previous version recorded for this update — nothing to diff against";
  }

  const rejectBtn = document.createElement("button");
  rejectBtn.className = "btn btn-danger";
  rejectBtn.textContent = " Reject";
  const rejectSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  rejectSvg.setAttribute("width", "14");
  rejectSvg.setAttribute("height", "14");
  rejectSvg.setAttribute("viewBox", "0 0 24 24");
  rejectSvg.setAttribute("fill", "none");
  rejectSvg.setAttribute("stroke", "currentColor");
  rejectSvg.setAttribute("stroke-width", "2");
  const x1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  x1.setAttribute("x1", "18"); x1.setAttribute("y1", "6"); x1.setAttribute("x2", "6"); x1.setAttribute("y2", "18");
  const x2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
  x2.setAttribute("x1", "6"); x2.setAttribute("y1", "6"); x2.setAttribute("x2", "18"); x2.setAttribute("y2", "18");
  rejectSvg.appendChild(x1);
  rejectSvg.appendChild(x2);
  rejectBtn.prepend(rejectSvg);

  const regenerateBtn = document.createElement("button");
  regenerateBtn.className = "btn btn-secondary";
  regenerateBtn.textContent = "Regenerate";
  regenerateBtn.style.display = "none";

  // Aigis retry — only ever shown for aigisRollup cards, and only once an
  // approve's submission outcome comes back failed/skipped (see
  // showAigisOutcome below).
  const aigisRetryBtn = document.createElement("button");
  aigisRetryBtn.className = "btn btn-secondary";
  aigisRetryBtn.textContent = "Retry submission";
  aigisRetryBtn.style.display = "none";

  actions.appendChild(approveBtn);
  actions.appendChild(editBtn);
  actions.appendChild(diffBtn);
  actions.appendChild(rejectBtn);
  actions.appendChild(regenerateBtn);
  actions.appendChild(aigisRetryBtn);

  // Stale banner — shown when a 409 approve conflict tells us the page
  // changed since this update was proposed (see isStaleConflict above).
  const staleBanner = document.createElement("div");
  staleBanner.className = "pending-stale-banner";
  staleBanner.textContent = "Stale — page changed since this was proposed";
  staleBanner.style.display = "none";

  // Aigis submission outcome — shown after approving an aigisRollup card
  // (success / failed-with-reason / skipped-not-connected). See
  // approve.ts's aigisSubmission result and task-17 brief §B.
  const aigisStatus = document.createElement("div");
  aigisStatus.className = "aigis-submission-status";
  aigisStatus.style.display = "none";

  function showAigisOutcome(outcome: AigisSubmissionOutcome | undefined): void {
    if (!outcome) return;
    aigisStatus.style.display = "";
    if (outcome.ok) {
      aigisStatus.className = "aigis-submission-status success";
      aigisStatus.textContent = "Submitted to Aigis.";
      aigisRetryBtn.style.display = "none";
    } else if (outcome.skipped) {
      aigisStatus.className = "aigis-submission-status skipped";
      aigisStatus.textContent = "Not submitted — Aigis isn't connected. Approved content is saved; connect Aigis in Settings, then retry.";
      aigisRetryBtn.style.display = "";
    } else {
      aigisStatus.className = "aigis-submission-status failed";
      aigisStatus.textContent = `Aigis submission failed: ${outcome.error ?? "unknown error"}`;
      aigisRetryBtn.style.display = "";
    }
  }

  aigisRetryBtn.addEventListener("click", async () => {
    aigisRetryBtn.disabled = true;
    aigisRetryBtn.classList.add("loading");
    try {
      await resubmitAigisRollup(update.id);
      log("info", `Retried Aigis submission: ${update.theme}`);
      showAigisOutcome({ ok: true });
    } catch (e: unknown) {
      log("error", `Aigis retry failed: ${update.theme}`, String(e));
      const message = e instanceof ApiError ? e.message : String(e);
      showAigisOutcome({ ok: false, error: message });
    } finally {
      aigisRetryBtn.disabled = false;
      aigisRetryBtn.classList.remove("loading");
    }
  });

  card.appendChild(header);
  card.appendChild(staleBanner);
  card.appendChild(aigisStatus);
  card.appendChild(label);
  card.appendChild(contentPreview);
  card.appendChild(diffContainer);
  card.appendChild(textarea);
  card.appendChild(actions);

  function markStale(): void {
    card.classList.add("stale");
    staleBanner.style.display = "";
    regenerateBtn.style.display = "";
  }

  // Edit / Diff / Proposed view toggles. Proposed (rendered markdown) is the
  // default; Edit and Diff are mutually exclusive with each other and with
  // Proposed, so switching to one closes the other.
  let editing = false;
  let showingDiff = false;

  function closeDiff(): void {
    if (!showingDiff) return;
    showingDiff = false;
    diffContainer.style.display = "none";
    diffBtn.textContent = "Diff";
  }

  function closeEdit(): void {
    if (!editing) return;
    editing = false;
    textarea.style.display = "none";
    editBtn.textContent = "Edit";
  }

  editBtn.addEventListener("click", () => {
    closeDiff();
    editing = !editing;
    if (editing) {
      contentPreview.style.display = "none";
      textarea.style.display = "";
      editBtn.textContent = "Preview";
    } else {
      textarea.style.display = "none";
      contentPreview.innerHTML = renderMarkdown(textarea.value); // safe: same rationale as above
      contentPreview.style.display = "";
      editBtn.textContent = "Edit";
    }
  });

  diffBtn.addEventListener("click", () => {
    if (!hasPreviousContent) return;
    closeEdit();
    showingDiff = !showingDiff;
    if (showingDiff) {
      contentPreview.style.display = "none";
      // safe: renderDiffHtml HTML-escapes every line before interpolating it
      diffContainer.innerHTML = renderDiffHtml(update.previousContent ?? "", textarea.value);
      diffContainer.style.display = "";
      diffBtn.textContent = "Proposed";
    } else {
      diffContainer.style.display = "none";
      contentPreview.style.display = "";
      diffBtn.textContent = "Diff";
    }
  });

  // Approve
  approveBtn.addEventListener("click", async () => {
    approveBtn.classList.add("loading");
    approveBtn.disabled = true;
    try {
      const edited = textarea.value !== update.proposedContent ? textarea.value : undefined;
      const result = await approveUpdate(update.id, edited);
      log("info", `Approved update: ${update.theme}`, edited ? "with edits" : "as-is");

      if (update.aigisRollup) {
        // The pending is already gone server-side (approve removes it), but
        // the card stays put here — with a full loadPending() it would
        // vanish before its Aigis submission outcome/retry could be shown
        // (see task-17 brief §B). Just retire its actions in place instead.
        approveBtn.style.display = "none";
        editBtn.style.display = "none";
        rejectBtn.style.display = "none";
        diffBtn.style.display = "none";
        showAigisOutcome(result.aigisSubmission);
        updateReviewBadge();
        return;
      }

      await loadPending(listEl);
      updateReviewBadge();
    } catch (e: unknown) {
      if (isStaleConflict(e)) {
        log("warn", `Approve blocked — page changed since proposed: ${update.theme}`);
        markStale();
        approveBtn.classList.remove("loading");
        approveBtn.disabled = false;
      } else {
        log("error", `Failed to approve: ${update.theme}`, String(e));
        approveBtn.classList.remove("loading");
        approveBtn.disabled = false;
      }
    }
  });

  // Regenerate — asks the server to merge this stale proposal onto the
  // current on-disk page, then refreshes the card with the replacement.
  regenerateBtn.addEventListener("click", async () => {
    regenerateBtn.disabled = true;
    regenerateBtn.classList.add("loading");
    try {
      await regeneratePendingUpdate(update.id);
      log("info", `Regenerated update against current page: ${update.theme}`);
      await loadPending(listEl);
      updateReviewBadge();
    } catch (e: unknown) {
      log("error", `Failed to regenerate: ${update.theme}`, String(e));
      regenerateBtn.disabled = false;
      regenerateBtn.classList.remove("loading");
    }
  });

  // Reject
  rejectBtn.addEventListener("click", async () => {
    try {
      await rejectUpdate(update.id);
      log("info", `Rejected update: ${update.theme}`);
      await loadPending(listEl);
      updateReviewBadge();
    } catch (e: any) {
      log("error", `Failed to reject: ${update.theme}`, String(e));
    }
  });

  return { card, checkbox };
}

async function updateReviewBadge(): Promise<void> {
  const badge = document.getElementById("review-badge");
  if (!badge) return;
  try {
    const updates = await listPendingUpdates();
    if (updates.length > 0) {
      badge.textContent = String(updates.length);
      badge.style.display = "inline";
    } else {
      badge.style.display = "none";
    }
  } catch {
    badge.style.display = "none";
  }
}
