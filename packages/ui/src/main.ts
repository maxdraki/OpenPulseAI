import { renderDashboard } from "./pages/dashboard.js";
import { renderReview } from "./pages/review.js";
import { renderSettings } from "./pages/settings.js";
import { renderJournals } from "./pages/journals.js";
import { renderThemes } from "./pages/themes.js";
import { renderDataSources } from "./pages/data-sources.js";
import { renderLogs } from "./pages/logs.js";
import { renderHelp } from "./pages/help.js";
import { renderSchedule } from "./pages/schedule.js";
import { renderSkillsEvidence } from "./pages/skills-evidence.js";
import { listPendingUpdates } from "./lib/tauri-bridge.js";

const content = document.getElementById("content")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]");

const pages: Record<string, (el: HTMLElement) => Promise<void>> = {
  dashboard: renderDashboard,
  review: renderReview,
  settings: renderSettings,
  journals: renderJournals,
  themes: renderThemes,
  "data-sources": renderDataSources,
  logs: renderLogs,
  help: renderHelp,
  schedule: renderSchedule,
  "skills-evidence": renderSkillsEvidence,
};

export function navigate(page: string) {
  // Push to browser history so back/forward buttons work
  const current = location.hash.replace("#", "") || "dashboard";
  if (current !== page) {
    history.pushState(null, "", `#${page}`);
  }
  renderPage(page);
}

function renderPage(page: string) {
  // Highlight sidebar nav — detail pages highlight their parent
  const navPage = page === "journals" || page === "themes" ? "dashboard" : page;
  navItems.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === navPage);
  });

  content.classList.remove("fade-in");
  void content.offsetWidth;
  content.classList.add("fade-in");

  const render = pages[page];
  if (render) render(content);
}

// Make navigate available globally for page modules
(window as any).__navigate = navigate;

// Sidebar nav clicks
navItems.forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.page!));
});

// Browser back/forward button support
window.addEventListener("popstate", () => {
  const page = location.hash.replace("#", "") || "dashboard";
  renderPage(page);
});

// Update review badge
async function updateBadge() {
  const badge = document.getElementById("review-badge");
  if (!badge) return;
  try {
    const updates = await listPendingUpdates();
    if (updates.length > 0) {
      badge.textContent = String(updates.length);
      badge.style.display = "inline";
    } else {
      badge.style.display = "none";
    }
  } catch {
    badge.style.display = "none";
  }
}

// Theme switcher: 3 mutually exclusive buttons
function initTheme() {
  const saved = localStorage.getItem("openpulse-theme") ?? "system";
  applyTheme(saved);

  // Listen for OS theme changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem("openpulse-theme") ?? "system") === "system") applyTheme("system");
  });

  document.getElementById("theme-switcher")?.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-theme]");
    if (!btn) return;
    const pref = btn.dataset.theme!;
    applyTheme(pref);
    localStorage.setItem("openpulse-theme", pref);
  });
}

function applyTheme(pref: string) {
  const effective = pref === "system"
    ? (window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")
    : pref;

  document.documentElement.dataset.theme = effective;

  // Swap Shoelace theme stylesheet
  const shoelaceLink = document.querySelector('link[href*="shoelace"][href*="themes"]') as HTMLLinkElement;
  if (shoelaceLink) {
    const newHref = effective === "light"
      ? shoelaceLink.href.replace("dark.css", "light.css")
      : shoelaceLink.href.replace("light.css", "dark.css");
    shoelaceLink.href = newHref;
  }

  // Highlight active button
  document.querySelectorAll(".theme-btn").forEach((btn) => {
    btn.classList.toggle("active", (btn as HTMLElement).dataset.theme === pref);
  });
}

// Initial render from URL hash or default to dashboard
const initialPage = location.hash.replace("#", "") || "dashboard";
history.replaceState(null, "", `#${initialPage}`);
renderPage(initialPage);
updateBadge();
initTheme();
