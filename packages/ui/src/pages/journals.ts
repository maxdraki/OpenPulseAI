// Journal entries page — renders vault hot-layer data via marked (trusted content)
import { getHotEntries } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { escapeHtml } from "../lib/utils.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderJournals(container: HTMLElement): Promise<void> {
  // Static template — no user input in these strings
  container.innerHTML = [
    '<div class="page-header">',
    '  <button class="btn-back" id="btn-back">',
    '    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    '    Dashboard',
    '  </button>',
    '  <h2 class="page-title">Journals</h2>',
    '  <p class="page-subtitle">Chronological activity entries from agents and skills</p>',
    '</div>',
    '<div id="journal-entries">',
    '  <div class="empty-state"><p>Loading...</p></div>',
    '</div>',
  ].join("\n");

  document.getElementById("btn-back")?.addEventListener("click", () => nav("dashboard"));

  try {
    const entries = await getHotEntries();
    const list = document.getElementById("journal-entries")!;

    if (entries.length === 0) {
      list.innerHTML = [
        '<div class="empty-state">',
        '  <div class="empty-state-icon" style="background: rgba(245, 158, 11, 0.08); color: var(--hot);">',
        '    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c.5 2.5 2 4.5 2 7a4 4 0 1 1-8 0c0-2.5 2.5-5 3-7 1 2 2.5 3.5 3 0z"/></svg>',
        '  </div>',
        '  <p>No journal entries yet. Activity will appear here when agents report via the MCP tools.</p>',
        '</div>',
      ].join("\n");
      return;
    }

    // Entry rendering uses escapeHtml for theme/source badges and renderMarkdown
    // (via marked library) for body content. Both are trusted vault data.
    list.innerHTML = entries.map((entry) => {
      const time = new Date(entry.timestamp).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      return [
        '<div class="journal-entry">',
        '  <div class="journal-entry-header">',
        `    <span class="journal-entry-time">${time}</span>`,
        entry.theme ? `    <span class="journal-entry-theme">${escapeHtml(entry.theme)}</span>` : "",
        entry.source ? `    <span class="journal-entry-source">${escapeHtml(entry.source)}</span>` : "",
        '  </div>',
        `  <div class="journal-entry-body md-content">${renderMarkdown(entry.log)}</div>`,
        '</div>',
      ].filter(Boolean).join("\n");
    }).join("");
  } catch (e: any) {
    document.getElementById("journal-entries")!.textContent = `Failed to load: ${e}`;
  }
}
