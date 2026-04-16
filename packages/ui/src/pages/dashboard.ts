// Dashboard — stat cards + inline themes. All innerHTML usage is either static SVG
// icons or vault content rendered through the marked library (trusted, HTML-escaped).
import { getVaultHealth, getWarmThemes, getBacklinks } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderDashboard(container: HTMLElement): Promise<void> {
  const header = document.createElement("div");
  header.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Dashboard";
  const sub = document.createElement("p");
  sub.className = "page-subtitle";
  sub.textContent = "Your digital twin at a glance";
  header.appendChild(h2);
  header.appendChild(sub);

  const statsGrid = document.createElement("div");
  statsGrid.className = "stat-grid stat-grid-2";
  statsGrid.id = "stats";

  const themesSection = document.createElement("div");
  themesSection.id = "themes-section";

  container.textContent = "";
  container.appendChild(header);
  container.appendChild(statsGrid);
  container.appendChild(themesSection);

  await Promise.all([loadStats(statsGrid), loadThemes(themesSection, await getBacklinks())]);
}

// Static SVG strings for stat card icons (not user-supplied)
const JOURNAL_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c.5 2.5 2 4.5 2 7a4 4 0 1 1-8 0c0-2.5 2.5-5 3-7 1 2 2.5 3.5 3 0z"/></svg>';
const REVIEW_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';

async function loadStats(grid: HTMLElement): Promise<void> {
  try {
    const h = await getVaultHealth();
    grid.textContent = "";
    grid.appendChild(buildStatCard("hot", String(h.hotCount), "Journals", "journals", JOURNAL_ICON));
    grid.appendChild(buildStatCard("pending", String(h.pendingCount), "Pending Reviews", "review", REVIEW_ICON));
  } catch {
    grid.textContent = "Failed to load stats";
  }
}

function buildStatCard(type: string, value: string, label: string, navTarget: string, iconSvg: string): HTMLElement {
  const card = document.createElement("div");
  card.className = `stat-card ${type} clickable`;
  card.addEventListener("click", () => nav(navTarget));

  const icon = document.createElement("div");
  icon.className = "stat-icon";
  icon.innerHTML = iconSvg; // static SVG constant, not user data

  const val = document.createElement("div");
  val.className = "stat-value";
  val.textContent = value;

  const lbl = document.createElement("div");
  lbl.className = "stat-label";
  lbl.textContent = label;

  const arrow = document.createElement("div");
  arrow.className = "stat-arrow";
  arrow.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>';

  card.appendChild(icon);
  card.appendChild(val);
  card.appendChild(lbl);
  card.appendChild(arrow);
  return card;
}

async function loadThemes(section: HTMLElement, backlinks: Record<string, string[]>): Promise<void> {
  section.textContent = "";

  const sectionHeader = document.createElement("h3");
  sectionHeader.className = "dashboard-section-title";
  sectionHeader.textContent = "Themes";
  section.appendChild(sectionHeader);

  try {
    const themes = await getWarmThemes();

    if (themes.length === 0) {
      const empty = document.createElement("p");
      empty.className = "dashboard-empty";
      empty.textContent = "No themes yet. Run the Dream Pipeline from the Schedule page to synthesize your journal entries.";
      section.appendChild(empty);
      return;
    }

    for (const theme of themes) {
      const card = document.createElement("div");
      card.className = "dashboard-theme-card";

      const headerRow = document.createElement("div");
      headerRow.className = "dashboard-theme-header";
      headerRow.style.cursor = "pointer";

      const chevron = document.createElement("span");
      chevron.className = "dashboard-theme-chevron";
      chevron.textContent = "\u25B8";

      const name = document.createElement("span");
      name.className = "dashboard-theme-name";
      name.textContent = theme.theme;

      const updated = document.createElement("span");
      updated.className = "dashboard-theme-updated";
      if (theme.lastUpdated) {
        updated.textContent = new Date(theme.lastUpdated).toLocaleDateString("en-GB", {
          day: "numeric", month: "short",
        });
      }

      headerRow.appendChild(chevron);
      headerRow.appendChild(name);
      headerRow.appendChild(updated);

      // Content: vault data rendered via marked library (trusted)
      const content = document.createElement("div");
      content.className = "dashboard-theme-content md-content";
      content.style.display = "none";
      content.innerHTML = renderMarkdown(theme.content); // safe: vault content via marked

      const inbound = backlinks[theme.theme] ?? [];
      if (inbound.length > 0) {
        const bl = document.createElement("div");
        bl.className = "dashboard-theme-backlinks";
        bl.textContent = `Linked from: ${inbound.map(t => `[[${t}]]`).join(", ")}`;
        content.appendChild(bl);
      }

      headerRow.addEventListener("click", () => {
        const open = content.style.display !== "none";
        content.style.display = open ? "none" : "";
        chevron.textContent = open ? "\u25B8" : "\u25BE";
      });

      card.appendChild(headerRow);
      card.appendChild(content);
      section.appendChild(card);
    }
  } catch {
    const err = document.createElement("p");
    err.style.color = "var(--danger)";
    err.textContent = "Failed to load themes";
    section.appendChild(err);
  }
}
