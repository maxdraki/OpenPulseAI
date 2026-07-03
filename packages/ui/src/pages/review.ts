import { listPendingUpdates, approveUpdate, approveUpdatesBatch, rejectUpdate, regeneratePendingUpdate, ApiError, type PendingUpdate } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { renderDiffHtml } from "../lib/diff.js";
import { log } from "../lib/logger.js";

/** True when `err` is a stale-conflict 409 from the approve endpoint (see
 *  `packages/ui/server.ts`'s `POST /api/approve-update`). */
function isStaleConflict(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && (err.body as { error?: string } | undefined)?.error === "stale";
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
        } else {
          batchLabel.textContent = `Dream run: ${batchDate} — ${batchUpdates.length} themes updated`;
        }

        const batchActions = document.createElement("div");
        batchActions.className = "batch-actions";

        const approveAllBtn = document.createElement("button");
        approveAllBtn.className = "btn btn-success";
        approveAllBtn.textContent = "Approve All";

        const rejectAllBtn = document.createElement("button");
        rejectAllBtn.className = "btn btn-danger";
        rejectAllBtn.textContent = "Reject All";

        approveAllBtn.addEventListener("click", async () => {
          approveAllBtn.disabled = true;
          rejectAllBtn.disabled = true;
          try {
            // One server-side batch call so the whole action lands as a single
            // vault-git commit listing every theme (see approve.ts's
            // approvePendingUpdatesBatch) instead of one commit per item.
            const results = await approveUpdatesBatch(batchUpdates.map((u) => u.id));
            const staleCount = results.filter((r) => !r.ok && r.stale).length;
            const otherFailed = results.filter((r) => !r.ok && !r.stale).length;

            if (otherFailed) log("error", `Approved batch with ${otherFailed} failure(s): ${batchKey}`);
            if (staleCount) log("warn", `Approved batch: ${staleCount} item(s) skipped as stale: ${batchKey}`);
            if (!otherFailed && !staleCount) log("info", `Approved batch: ${batchKey}`);

            await loadPending(listEl);
            updateReviewBadge();

            if (staleCount || otherFailed) {
              const parts: string[] = [];
              if (staleCount) parts.push(`${staleCount} skipped — page changed since proposed`);
              if (otherFailed) parts.push(`${otherFailed} failed`);
              showReviewSummary(`Approve All: ${parts.join(", ")}. Approved the rest.`);
            }
          } catch (e: unknown) {
            // Request itself failed (network error, 500, etc.) — nothing was
            // necessarily approved server-side, so re-enable the buttons
            // rather than leaving the batch permanently stuck (M7).
            log("error", `Approve All failed: ${batchKey}`, String(e));
            showReviewSummary("Approve All failed — please try again.");
            approveAllBtn.disabled = false;
            rejectAllBtn.disabled = false;
          }
        });

        rejectAllBtn.addEventListener("click", async () => {
          approveAllBtn.disabled = true;
          rejectAllBtn.disabled = true;
          const results = await Promise.allSettled(batchUpdates.map((u) => rejectUpdate(u.id)));
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed) log("error", `Rejected batch with ${failed} failure(s): ${batchKey}`);
          else log("info", `Rejected batch: ${batchKey}`);
          await loadPending(listEl);
          updateReviewBadge();
        });

        batchActions.appendChild(approveAllBtn);
        batchActions.appendChild(rejectAllBtn);
        batchHeader.appendChild(batchLabel);
        batchHeader.appendChild(batchActions);
        listEl.appendChild(batchHeader);
      }

      // Render individual cards for each update in this batch
      for (const update of batchUpdates) {
        listEl.appendChild(buildCard(update, listEl));
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

function buildCard(update: PendingUpdate, listEl: HTMLElement): HTMLElement {
  const card = document.createElement("div");
  card.className = "pending-card";

  // Header: theme badge + date
  const header = document.createElement("div");
  header.className = "pending-header";
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

  actions.appendChild(approveBtn);
  actions.appendChild(editBtn);
  actions.appendChild(diffBtn);
  actions.appendChild(rejectBtn);
  actions.appendChild(regenerateBtn);

  // Stale banner — shown when a 409 approve conflict tells us the page
  // changed since this update was proposed (see isStaleConflict above).
  const staleBanner = document.createElement("div");
  staleBanner.className = "pending-stale-banner";
  staleBanner.textContent = "Stale — page changed since this was proposed";
  staleBanner.style.display = "none";

  card.appendChild(header);
  card.appendChild(staleBanner);
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
      await approveUpdate(update.id, edited);
      log("info", `Approved update: ${update.theme}`, edited ? "with edits" : "as-is");
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

  return card;
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
