import { getWarmThemes } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderWarmThemes(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <button class="btn-back" id="btn-back">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        Dashboard
      </button>
      <h2 class="page-title">Warm Themes</h2>
      <p class="page-subtitle">Curated source-of-truth status files</p>
    </div>
    <div id="warm-list">
      <div class="empty-state"><p>Loading...</p></div>
    </div>
  `;

  document.getElementById("btn-back")?.addEventListener("click", () => nav("dashboard"));

  try {
    const themes = await getWarmThemes();
    const list = document.getElementById("warm-list")!;

    if (themes.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="background: rgba(6, 182, 212, 0.08); color: var(--warm);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/></svg>
          </div>
          <p>No warm themes yet. Run the Dream Pipeline to synthesize hot entries into themes, then approve them in Review.</p>
        </div>`;
      return;
    }

    list.innerHTML = themes.map((theme) => {
      const updated = new Date(theme.lastUpdated).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
      return `
        <div class="warm-card">
          <div class="warm-card-header">
            <span class="warm-card-name">${escapeHtml(theme.theme)}</span>
            <span class="warm-card-updated">Updated ${updated}</span>
          </div>
          <div class="warm-card-content md-content">${renderMarkdown(theme.content)}</div>
        </div>
      `;
    }).join("");
  } catch (e: any) {
    document.getElementById("warm-list")!.innerHTML =
      `<div class="card" style="color: var(--danger);">Failed to load: ${e}</div>`;
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
