// Skills Evidence page — aggregates skill tags across all warm themes and
// shows evidence counts + last-demonstrated date + links to supporting themes.
//
// DOM is built programmatically with textContent so user-supplied strings
// (skill tags, theme names) can never be interpreted as HTML.
import { getWarmThemes } from "../lib/tauri-bridge.js";
import type { WarmTheme } from "../lib/tauri-bridge.js";
import { el } from "../lib/utils.js";

interface SkillAggregate {
  skill: string;
  themes: Array<{ theme: string; lastUpdated: string }>;
  lastDemonstrated: string;
}

export function aggregateSkills(themes: WarmTheme[]): SkillAggregate[] {
  const bySkill = new Map<string, SkillAggregate>();
  for (const t of themes) {
    if (!Array.isArray(t.skills)) continue;
    for (const skill of t.skills) {
      if (!skill) continue;
      const entry = bySkill.get(skill) ?? { skill, themes: [], lastDemonstrated: "" };
      entry.themes.push({ theme: t.theme, lastUpdated: t.lastUpdated });
      if (t.lastUpdated > entry.lastDemonstrated) entry.lastDemonstrated = t.lastUpdated;
      bySkill.set(skill, entry);
    }
  }
  return [...bySkill.values()].sort((a, b) => {
    if (b.themes.length !== a.themes.length) return b.themes.length - a.themes.length;
    return b.lastDemonstrated.localeCompare(a.lastDemonstrated);
  });
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

function navigate(page: string) {
  (window as any).__navigate(page);
}

function buildHeader(): HTMLElement {
  const header = el("div", { class: "page-header" });
  header.appendChild(el("h2", { class: "page-title" }, "Skills Evidence"));
  header.appendChild(el("p", { class: "page-subtitle" }, "Capabilities demonstrated across your projects, backed by activity entries."));
  return header;
}

function buildEmpty(): HTMLElement {
  const wrap = el("div", { class: "empty-state" });
  wrap.appendChild(el("p", {}, "No skill evidence has been captured yet. As the Dream Pipeline processes your activity entries, skills demonstrated in those entries will be tagged and accumulate here."));
  wrap.appendChild(el("p", {}, "New projects show evidence within a day or two of their first approved update."));
  return wrap;
}

function buildTable(aggregates: SkillAggregate[], themeCount: number): HTMLElement {
  const wrap = el("div");

  const summary = el("p", { class: "skills-summary" });
  summary.appendChild(el("strong", {}, String(aggregates.length)));
  summary.appendChild(document.createTextNode(" distinct skills evidenced across "));
  summary.appendChild(el("strong", {}, String(themeCount)));
  summary.appendChild(document.createTextNode(" themes."));
  wrap.appendChild(summary);

  const table = el("table", { class: "skills-table" });
  const thead = el("thead");
  const headRow = el("tr");
  for (const label of ["Skill", "Evidence", "Last demonstrated", "Themes"]) {
    headRow.appendChild(el("th", {}, label));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el("tbody");
  for (const a of aggregates) {
    const row = el("tr");

    const tagCell = el("td", { class: "skill-tag" });
    tagCell.appendChild(el("code", {}, a.skill));
    row.appendChild(tagCell);

    row.appendChild(el("td", { class: "skill-count" }, String(a.themes.length)));
    row.appendChild(el("td", { class: "skill-date" }, formatDate(a.lastDemonstrated)));

    const themesCell = el("td", { class: "skill-themes" });
    const top = a.themes.slice(0, 5);
    top.forEach((t, i) => {
      const link = el("a", { href: "#themes", class: "skill-theme-link" }, t.theme);
      link.addEventListener("click", (e) => {
        e.preventDefault();
        navigate("themes");
      });
      themesCell.appendChild(link);
      if (i < top.length - 1) themesCell.appendChild(document.createTextNode(", "));
    });
    if (a.themes.length > 5) {
      themesCell.appendChild(el("span", { class: "muted" }, ` (+${a.themes.length - 5} more)`));
    }
    row.appendChild(themesCell);

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);

  return wrap;
}

export async function renderSkillsEvidence(container: HTMLElement): Promise<void> {
  container.textContent = "";
  container.appendChild(buildHeader());

  const body = el("div", { id: "skills-content" });
  body.appendChild(el("div", { class: "empty-state" }, "Loading…"));
  container.appendChild(body);

  try {
    const themes = await getWarmThemes();
    const aggregates = aggregateSkills(themes);
    body.textContent = "";
    body.appendChild(aggregates.length === 0 ? buildEmpty() : buildTable(aggregates, themes.length));
  } catch (err: any) {
    body.textContent = `Failed to load: ${String(err)}`;
  }
}
