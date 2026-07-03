// Themes page — renders vault warm-layer data via marked library (trusted content).
// All dynamic values are either escaped (escapeHtml) or rendered through marked
// which handles HTML escaping. No user-supplied input reaches innerHTML.
import { getWarmThemes, searchThemes, type WarmTheme, type ThemeSearchResult } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { escapeHtml } from "../lib/utils.js";

const SEARCH_DEBOUNCE_MS = 250;

function nav(page: string) { (window as any).__navigate(page); }

function renderThemeCards(themes: WarmTheme[], list: HTMLElement): void {
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
}

/** Renders search hits (theme/heading/snippet). Clicking a hit jumps to
 *  that theme's full card (there's no separate per-theme route — the
 *  Themes page itself is the "theme view") by filtering the already-loaded
 *  theme list down to that one name. */
function renderSearchResults(
  results: ThemeSearchResult[],
  list: HTMLElement,
  onSelectTheme: (theme: string) => void,
): void {
  if (results.length === 0) {
    list.textContent = "";
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const p = document.createElement("p");
    p.textContent = "No matches found.";
    empty.appendChild(p);
    list.appendChild(empty);
    return;
  }

  list.innerHTML = results.map((r) => {
    return '<div class="theme-card theme-search-result" data-theme="' + escapeHtml(r.theme) + '">'
      + '<div class="theme-card-header">'
      + `<span class="theme-card-name">${escapeHtml(r.theme)}</span>`
      + `<span class="theme-card-updated">${escapeHtml(r.heading || "—")}</span>`
      + '</div>'
      + `<div class="theme-card-content theme-search-snippet">${escapeHtml(r.snippet)}</div>`
      + '</div>';
  }).join("");

  list.querySelectorAll<HTMLElement>(".theme-search-result").forEach((el) => {
    el.addEventListener("click", () => {
      const theme = el.dataset.theme;
      if (theme) onSelectTheme(theme);
    });
  });
}

export async function renderThemes(container: HTMLElement): Promise<void> {
  container.innerHTML = '<div class="page-header">'
    + '<button class="btn-back" id="btn-back">'
    + '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>'
    + ' Dashboard</button>'
    + '<h2 class="page-title">Themes</h2>'
    + '<p class="page-subtitle">Curated status summaries by topic</p>'
    + '</div>'
    + '<div class="themes-search-box">'
    + '<input type="search" id="themes-search-input" class="form-input themes-search-input" placeholder="Search themes...">'
    + '</div>'
    + '<div id="themes-list"><div class="empty-state"><p>Loading...</p></div></div>';

  document.getElementById("btn-back")?.addEventListener("click", () => nav("dashboard"));

  const list = document.getElementById("themes-list")!;
  const searchInput = document.getElementById("themes-search-input") as HTMLInputElement;

  let allThemes: WarmTheme[] = [];
  try {
    allThemes = await getWarmThemes();
    renderThemeCards(allThemes, list);
  } catch (e: any) {
    list.textContent = `Failed to load: ${e}`;
  }

  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let requestSeq = 0;

  searchInput?.addEventListener("input", () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    const query = searchInput.value.trim();

    if (!query) {
      renderThemeCards(allThemes, list);
      return;
    }

    debounceTimer = setTimeout(async () => {
      const seq = ++requestSeq;
      try {
        const results = await searchThemes(query);
        if (seq !== requestSeq) return; // a newer keystroke's request already landed
        renderSearchResults(results, list, (theme) => {
          searchInput.value = "";
          const match = allThemes.filter((t) => t.theme === theme);
          renderThemeCards(match.length > 0 ? match : allThemes, list);
        });
      } catch (e: any) {
        if (seq !== requestSeq) return;
        list.textContent = `Search failed: ${e}`;
      }
    }, SEARCH_DEBOUNCE_MS);
  });
}
