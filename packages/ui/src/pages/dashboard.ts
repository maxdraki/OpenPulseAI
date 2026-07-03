// Dashboard — stat cards + inline themes. All innerHTML usage is either static SVG
// icons or vault content rendered through the marked library (trusted, HTML-escaped).
import { getVaultHealth, getWarmThemes, getBacklinks, getDreamUsage } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";

function nav(page: string) { (window as any).__navigate(page); }

// Static SVG for the refresh button — Lucide `rotate-cw`. A single nearly-full
// circular arc reads as a circle visually (the previous Feather `refresh-cw`
// used two short arcs that looked like an ellipse at small sizes).
const REFRESH_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/></svg>';

export async function renderDashboard(container: HTMLElement): Promise<void> {
  const header = document.createElement("div");
  header.className = "page-header";
  // Inline flex so the refresh button sits to the right of the title block
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "flex-start";
  header.style.gap = "1rem";

  const titleBlock = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Dashboard";
  const sub = document.createElement("p");
  sub.className = "page-subtitle";
  sub.textContent = "Your digital twin at a glance";
  titleBlock.appendChild(h2);
  titleBlock.appendChild(sub);
  header.appendChild(titleBlock);

  const refreshBtn = document.createElement("button");
  refreshBtn.className = "btn btn-ghost btn-sm";
  refreshBtn.title = "Refresh";
  refreshBtn.setAttribute("aria-label", "Refresh dashboard");
  // Icon + label — `.btn` already does inline-flex with a 0.45rem gap, so this
  // composes cleanly. SVG is a static constant (not user data) so innerHTML is safe.
  const refreshIcon = document.createElement("span");
  refreshIcon.style.display = "inline-flex";
  refreshIcon.innerHTML = REFRESH_ICON;
  const refreshLabel = document.createElement("span");
  refreshLabel.textContent = "Refresh";
  refreshBtn.appendChild(refreshIcon);
  refreshBtn.appendChild(refreshLabel);
  refreshBtn.style.alignSelf = "center";
  header.appendChild(refreshBtn);

  const statsGrid = document.createElement("div");
  statsGrid.className = "stat-grid stat-grid-2";
  statsGrid.id = "stats";

  const usageNote = document.createElement("p");
  usageNote.className = "dashboard-usage-note";
  usageNote.id = "dream-usage-note";

  const themesSection = document.createElement("div");
  themesSection.id = "themes-section";

  container.textContent = "";
  container.appendChild(header);
  container.appendChild(statsGrid);
  container.appendChild(usageNote);
  container.appendChild(themesSection);

  async function refreshAll() {
    refreshBtn.disabled = true;
    refreshBtn.style.opacity = "0.6";
    try {
      await Promise.all([
        loadStats(statsGrid),
        loadThemes(themesSection, await getBacklinks()),
        loadDreamUsage(usageNote),
      ]);
    } finally {
      refreshBtn.disabled = false;
      refreshBtn.style.opacity = "";
    }
  }

  refreshBtn.addEventListener("click", refreshAll);

  await refreshAll();
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

async function loadDreamUsage(note: HTMLElement): Promise<void> {
  try {
    const { usage, at } = await getDreamUsage();
    if (!usage) {
      note.textContent = "";
      return;
    }
    const when = at ? new Date(at).toLocaleString() : "unknown time";
    note.textContent =
      `Last dream run (${when}): ${usage.calls} LLM call${usage.calls === 1 ? "" : "s"}, ` +
      `${usage.inputTokens} in / ${usage.outputTokens} out tokens` +
      (usage.retries > 0 ? `, ${usage.retries} retr${usage.retries === 1 ? "y" : "ies"}` : "");
  } catch {
    note.textContent = "";
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

    const knownThemes = new Set(themes.map(t => t.theme));

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

      const typeBadge = document.createElement("span");
      typeBadge.className = `pending-type-badge type-${(theme as any).type ?? "project"}`;
      typeBadge.textContent = (theme as any).type ?? "project";

      const updated = document.createElement("span");
      updated.className = "dashboard-theme-updated";
      if (theme.lastUpdated) {
        updated.textContent = new Date(theme.lastUpdated).toLocaleDateString("en-GB", {
          day: "numeric", month: "short",
        });
      }

      headerRow.appendChild(chevron);
      headerRow.appendChild(name);
      headerRow.appendChild(typeBadge);
      headerRow.appendChild(updated);

      // Content: vault data rendered via marked library (trusted)
      const content = document.createElement("div");
      content.className = "dashboard-theme-content md-content";
      content.style.display = "none";
      content.innerHTML = renderMarkdown(theme.content, knownThemes); // safe: vault content via marked

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

      // Wiki-link clicks: scroll to and expand the target theme card
      content.addEventListener("click", (e) => {
        const target = e.target as HTMLElement;
        if (!target.classList.contains("wiki-link")) return;
        e.preventDefault();
        const targetTheme = target.dataset.theme;
        const allCards = section.querySelectorAll<HTMLElement>(".dashboard-theme-card");
        for (const c of allCards) {
          const cardName = c.querySelector<HTMLElement>(".dashboard-theme-name")?.textContent;
          if (cardName === targetTheme) {
            c.scrollIntoView({ behavior: "smooth", block: "start" });
            const cardContent = c.querySelector<HTMLElement>(".dashboard-theme-content");
            const cardChevron = c.querySelector<HTMLElement>(".dashboard-theme-chevron");
            if (cardContent && cardContent.style.display === "none") {
              cardContent.style.display = "";
              if (cardChevron) cardChevron.textContent = "\u25BE";
            }
            break;
          }
        }
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
