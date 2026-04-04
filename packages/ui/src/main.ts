import { renderDashboard } from "./pages/dashboard.js";
import { renderReview } from "./pages/review.js";
import { renderSettings } from "./pages/settings.js";
import { renderHotLog } from "./pages/hot-log.js";
import { renderWarmThemes } from "./pages/warm-themes.js";
import { renderSkills } from "./pages/skills.js";
import { listPendingUpdates } from "./lib/tauri-bridge.js";

const content = document.getElementById("content")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]");

const pages: Record<string, (el: HTMLElement) => Promise<void>> = {
  dashboard: renderDashboard,
  review: renderReview,
  settings: renderSettings,
  "hot-log": renderHotLog,
  "warm-themes": renderWarmThemes,
  skills: renderSkills,
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
  const navPage = page === "hot-log" || page === "warm-themes" ? "dashboard" : page;
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

// SVG path constants for theme icons (static, no user input)
const MOON_SVG = '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>';
const SUN_SVG = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';

// Theme toggle: light → dark → system
const THEME_CYCLE = ["light", "dark", "system"] as const;
const SYSTEM_SVG = '<rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/>';

function initTheme() {
  const saved = localStorage.getItem("openpulse-theme") ?? "system";
  applyTheme(saved);

  // Listen for OS theme changes when in system mode
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const current = localStorage.getItem("openpulse-theme") ?? "system";
    if (current === "system") applyTheme("system");
  });

  document.getElementById("theme-toggle")?.addEventListener("click", () => {
    const current = localStorage.getItem("openpulse-theme") ?? "system";
    const idx = THEME_CYCLE.indexOf(current as any);
    const next = THEME_CYCLE[(idx + 1) % THEME_CYCLE.length];
    applyTheme(next);
    localStorage.setItem("openpulse-theme", next);
  });
}

function resolveTheme(pref: string): "light" | "dark" {
  if (pref === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return pref as "light" | "dark";
}

function applyTheme(pref: string) {
  const effective = resolveTheme(pref);
  document.documentElement.dataset.theme = effective;

  // Swap Shoelace theme stylesheet
  const shoelaceLink = document.querySelector('link[href*="shoelace"][href*="themes"]') as HTMLLinkElement;
  if (shoelaceLink) {
    const newHref = effective === "light"
      ? shoelaceLink.href.replace("dark.css", "light.css")
      : shoelaceLink.href.replace("light.css", "dark.css");
    shoelaceLink.href = newHref;
  }

  // Update toggle label and icon (static SVG content, safe to set)
  const label = document.getElementById("theme-label");
  const icon = document.getElementById("theme-icon");
  const labels: Record<string, string> = { light: "Dark mode", dark: "System", system: "Light mode" };
  const icons: Record<string, string> = { light: SUN_SVG, dark: SYSTEM_SVG, system: MOON_SVG };
  if (label) label.textContent = labels[pref] ?? "Light mode";
  if (icon) icon.innerHTML = icons[pref] ?? MOON_SVG;
}

// Initial render from URL hash or default to dashboard
const initialPage = location.hash.replace("#", "") || "dashboard";
history.replaceState(null, "", `#${initialPage}`);
renderPage(initialPage);
updateBadge();
initTheme();
