import { listPendingUpdates, approveUpdate, rejectUpdate, type PendingUpdate } from "../lib/tauri-bridge.js";

export async function renderReview(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">Review</h2>
      <p class="page-subtitle">Approve, edit, or reject pending warm layer updates</p>
    </div>
    <div id="pending-list"></div>
  `;
  await refreshPending();
}

async function refreshPending() {
  const list = document.getElementById("pending-list")!;
  try {
    const updates = await listPendingUpdates();
    if (updates.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
          <p>All clear. Run the Dream Pipeline to generate new proposals from your hot logs.</p>
        </div>
      `;
      return;
    }
    list.innerHTML = updates.map(renderUpdateCard).join("");
    updates.forEach(bindCardEvents);
  } catch (e: any) {
    list.innerHTML = `<div class="card" style="color: var(--danger);">Error loading pending updates: ${e}</div>`;
  }
}

function renderUpdateCard(update: PendingUpdate): string {
  const date = new Date(update.createdAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return `
    <div class="pending-card" data-id="${update.id}">
      <div class="pending-header">
        <span class="pending-theme-badge">${escapeHtml(update.theme)}</span>
        <span class="pending-date">${date}</span>
      </div>
      ${update.previousContent ? `
        <div class="pending-section-label">Previous</div>
        <div class="previous-content">${escapeHtml(update.previousContent)}</div>
      ` : ""}
      <div class="pending-section-label">Proposed Update</div>
      <textarea class="pending-textarea" id="content-${update.id}">${escapeHtml(update.proposedContent)}</textarea>
      <div class="pending-actions">
        <button class="btn btn-success" id="approve-${update.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>
          Approve
        </button>
        <button class="btn btn-danger" id="reject-${update.id}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          Reject
        </button>
      </div>
    </div>
  `;
}

function bindCardEvents(update: PendingUpdate) {
  document.getElementById(`approve-${update.id}`)?.addEventListener("click", async () => {
    const textarea = document.getElementById(`content-${update.id}`) as HTMLTextAreaElement;
    const edited = textarea.value !== update.proposedContent ? textarea.value : undefined;
    await approveUpdate(update.id, edited);
    await refreshPending();
    // Update the badge in the sidebar
    updateReviewBadge();
  });

  document.getElementById(`reject-${update.id}`)?.addEventListener("click", async () => {
    await rejectUpdate(update.id);
    await refreshPending();
    updateReviewBadge();
  });
}

async function updateReviewBadge() {
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

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
