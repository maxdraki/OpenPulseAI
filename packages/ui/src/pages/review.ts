import { listPendingUpdates, approveUpdate, rejectUpdate, type PendingUpdate } from "../lib/tauri-bridge.js";

export async function renderReview(container: HTMLElement): Promise<void> {
  container.innerHTML = `<h2 class="page-title">Review Pending Updates</h2><div id="pending-list"></div>`;
  await refreshPending();
}

async function refreshPending() {
  const list = document.getElementById("pending-list")!;
  try {
    const updates = await listPendingUpdates();
    if (updates.length === 0) {
      list.innerHTML = `<div class="empty-state">
        <sl-icon name="check-circle" style="font-size: 2rem; color: var(--success); margin-bottom: 0.5rem;"></sl-icon>
        <p>No pending updates. Run the Dream Pipeline to generate proposals.</p>
      </div>`;
      return;
    }
    list.innerHTML = updates.map(renderUpdateCard).join("");
    updates.forEach(bindCardEvents);
  } catch (e: any) {
    list.innerHTML = `<div class="card" style="color: var(--danger);">Error: ${e}</div>`;
  }
}

function renderUpdateCard(update: PendingUpdate): string {
  const date = new Date(update.createdAt).toLocaleString();
  return `
    <div class="pending-card" data-id="${update.id}">
      <div class="pending-header">
        <span class="pending-theme">
          <sl-badge variant="neutral">${update.theme}</sl-badge>
        </span>
        <span class="pending-date">${date}</span>
      </div>
      ${update.previousContent ? `
        <sl-details summary="Previous content" style="margin-bottom: 0.75rem;">
          <div class="previous-content">${escapeHtml(update.previousContent)}</div>
        </sl-details>
      ` : ""}
      <label style="font-size: 0.8rem; color: var(--text-secondary); display: block; margin-bottom: 0.25rem;">Proposed update (editable):</label>
      <sl-textarea id="content-${update.id}" value="${escapeAttr(update.proposedContent)}" rows="8" resize="auto" style="font-family: 'Google Sans Mono', monospace;"></sl-textarea>
      <div class="pending-actions">
        <sl-button variant="success" size="small" id="approve-${update.id}">
          <sl-icon slot="prefix" name="check-lg"></sl-icon> Approve
        </sl-button>
        <sl-button variant="danger" size="small" id="reject-${update.id}">
          <sl-icon slot="prefix" name="x-lg"></sl-icon> Reject
        </sl-button>
      </div>
    </div>
  `;
}

function bindCardEvents(update: PendingUpdate) {
  document.getElementById(`approve-${update.id}`)?.addEventListener("click", async () => {
    const textarea = document.getElementById(`content-${update.id}`) as any;
    const edited = textarea.value !== update.proposedContent ? textarea.value : undefined;
    await approveUpdate(update.id, edited);
    await refreshPending();
  });

  document.getElementById(`reject-${update.id}`)?.addEventListener("click", async () => {
    await rejectUpdate(update.id);
    await refreshPending();
  });
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
