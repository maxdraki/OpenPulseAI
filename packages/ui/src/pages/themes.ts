// Themes page — renders vault warm-layer data via marked library (trusted content).
// All dynamic values are either escaped (escapeHtml) or rendered through marked
// which handles HTML escaping. No user-supplied input reaches innerHTML.
import { getWarmThemes } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { escapeHtml } from "../lib/utils.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderThemes(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="page-header">'
    + '<button class="btn-back" id="btn-back">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
    + ' Dashboard</button>'
    + '<h2 class="page-title">Themes</h2>'
    + '<p class="page-subtitle">Curated status summaries by topic</p>'
    + '</div>'
    + '<div id="themes-list"><div class="empty-state"><p>Loading...</p></div></div>';

  document.getElementById("btn-back")?.addEventListener("click", () => nav("dashboard"));

  try {
    const themes = await getWarmThemes();
    const list = document.getElementById("themes-list")!;

    if (themes.length === 0) {
      list.textContent = "";
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const p = document.createElement("p");
      p.textContent = "No themes yet. Run the Dream Pipeline to synthesize journal entries into themes, then approve them in Review.";
      empty.appendChild(p);
      list.appendChild(empty);
      return;
    }

    list.innerHTML = themes.map((theme) => {
      const updated = new Date(theme.lastUpdated).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
      });
      return '<div class="theme-card">'
        + '<div class="theme-card-header">'
        + `<span class="theme-card-name">${escapeHtml(theme.theme)}</span>`
        + `<span class="theme-card-updated">Updated ${updated}</span>`
        + '</div>'
        + `<div class="theme-card-content md-content">${renderMarkdown(theme.content)}</div>`
        + '</div>';
    }).join("");
  } catch (e: any) {
    document.getElementById("themes-list")!.textContent = `Failed to load: ${e}`;
  }
}
