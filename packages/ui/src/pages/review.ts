import { listPendingUpdates, approveUpdate, rejectUpdate, type PendingUpdate } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { log } from "../lib/logger.js";

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

  const listEl = document.createElement("div");
  listEl.id = "pending-list";

  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(listEl);

  await loadPending(listEl);
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
          const results = await Promise.allSettled(batchUpdates.map((u) => approveUpdate(u.id)));
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed) log("error", `Approved batch with ${failed} failure(s): ${batchKey}`);
          else log("info", `Approved batch: ${batchKey}`);
          await loadPending(listEl);
          updateReviewBadge();
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
      update.lintFix === "merge"   ? "Lint merge"  :
      update.lintFix === "delete"  ? "Lint delete" :
      update.lintFix === "rename"  ? "Lint rename" :
      update.lintFix === "orphans" ? "Lint orphan" :
      update.lintFix === "stubs"   ? "Lint stub"   : `Lint ${update.lintFix}`;
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

  actions.appendChild(approveBtn);
  actions.appendChild(editBtn);
  actions.appendChild(rejectBtn);

  card.appendChild(header);
  card.appendChild(label);
  card.appendChild(contentPreview);
  card.appendChild(textarea);
  card.appendChild(actions);

  // Edit toggle
  let editing = false;
  editBtn.addEventListener("click", () => {
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
    } catch (e: any) {
      log("error", `Failed to approve: ${update.theme}`, String(e));
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
