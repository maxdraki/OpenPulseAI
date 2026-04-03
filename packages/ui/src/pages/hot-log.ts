import { getHotEntries } from "../lib/tauri-bridge.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderHotLog(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <button class="btn-back" id="btn-back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Dashboard
      </button>
      <h2 class="page-title">Hot Log</h2>
      <p class="page-subtitle">Raw chronological activity entries</p>
    </div>
    <div id="hot-entries">
      <div class="empty-state"><p>Loading...</p></div>
    </div>
  `;

  document.getElementById("btn-back")?.addEventListener("click", () => nav("dashboard"));

  try {
    const entries = await getHotEntries();
    const list = document.getElementById("hot-entries")!;

    if (entries.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="background: rgba(245, 158, 11, 0.08); color: var(--hot);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c.5 2.5 2 4.5 2 7a4 4 0 1 1-8 0c0-2.5 2.5-5 3-7 1 2 2.5 3.5 3 0z"/></svg>
          </div>
          <p>No hot entries yet. Activity will appear here when agents report via the MCP tools.</p>
        </div>`;
      return;
    }

    list.innerHTML = entries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      return `
        <div class="hot-entry">
          <div class="hot-entry-header">
            <span class="hot-entry-time">${time}</span>
            ${entry.theme ? `<span class="hot-entry-theme">${escapeHtml(entry.theme)}</span>` : ""}
            ${entry.source ? `<span class="hot-entry-source">${escapeHtml(entry.source)}</span>` : ""}
          </div>
          <div class="hot-entry-body">${escapeHtml(entry.log)}</div>
        </div>
      `;
    }).join("");
  } catch (e: any) {
    document.getElementById("hot-entries")!.innerHTML =
      `<div class="card" style="color: var(--danger);">Failed to load: ${e}</div>`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
