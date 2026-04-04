import { getLogs } from "../lib/logger.js";
import type { LogLevel, LogEntry } from "../lib/logger.js";

const LEVELS: Array<{ id: LogLevel | "all"; label: string }> = [
  { id: "all", label: "All" },
  { id: "info", label: "Info" },
  { id: "warn", label: "Warn" },
  { id: "error", label: "Error" },
];

export async function renderLogs(container: HTMLElement): Promise<void> {
  let activeFilter: LogLevel | "all" = "all";

  // Build page structure
  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Logs";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Recent activity and errors (last 7 days)";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  // Filter bar
  const filterBar = document.createElement("div");
  filterBar.className = "log-filter-bar";

  for (const level of LEVELS) {
    const btn = document.createElement("button");
    btn.className = "log-filter-btn" + (level.id === "all" ? " active" : "");
    btn.dataset.level = level.id;
    btn.textContent = level.label;
    filterBar.appendChild(btn);
  }

  const card = document.createElement("div");
  card.className = "card";

  const logList = document.createElement("div");
  logList.className = "log-list";
  logList.id = "log-list";
  card.appendChild(filterBar);
  card.appendChild(logList);

  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(card);

  // Load and render
  async function loadLogs() {
    const filter = activeFilter === "all" ? undefined : activeFilter;
    const entries = await getLogs(filter);
    renderLogEntries(logList, entries);
  }

  // Filter click handler
  filterBar.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-level]");
    if (!btn) return;
    activeFilter = btn.dataset.level as LogLevel | "all";
    filterBar.querySelectorAll(".log-filter-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    loadLogs();
  });

  await loadLogs();
}

function renderLogEntries(container: HTMLElement, entries: LogEntry[]): void {
  container.textContent = "";

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "log-empty";
    empty.textContent = "No log entries found.";
    container.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "log-entry";

    const badge = document.createElement("span");
    badge.className = `log-badge log-badge--${entry.level}`;
    badge.textContent = entry.level.toUpperCase();

    const time = document.createElement("span");
    time.className = "log-time";
    const d = new Date(entry.timestamp);
    time.textContent = d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });

    const msg = document.createElement("span");
    msg.className = "log-message";
    msg.textContent = entry.message;

    row.appendChild(badge);
    row.appendChild(time);
    row.appendChild(msg);

    if (entry.detail) {
      const detail = document.createElement("div");
      detail.className = "log-detail";
      detail.textContent = entry.detail;
      row.appendChild(detail);
    }

    container.appendChild(row);
  }
}
