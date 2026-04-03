import { renderDashboard } from "./pages/dashboard.js";
import { renderReview } from "./pages/review.js";
import { renderSettings } from "./pages/settings.js";
import { renderHotLog } from "./pages/hot-log.js";
import { renderWarmThemes } from "./pages/warm-themes.js";
import { listPendingUpdates } from "./lib/tauri-bridge.js";

const content = document.getElementById("content")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]");

const pages: Record<string, (el: HTMLElement) => Promise<void>> = {
  dashboard: renderDashboard,
  review: renderReview,
  settings: renderSettings,
  "hot-log": renderHotLog,
  "warm-themes": renderWarmThemes,
};

let currentPage = "";

export async function navigate(page: string) {
  currentPage = page;

  // Highlight sidebar nav — detail pages highlight their parent
  const navPage = page === "hot-log" || page === "warm-themes" ? "dashboard" : page;
  navItems.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === navPage);
  });

  content.classList.remove("fade-in");
  void content.offsetWidth;
  content.classList.add("fade-in");

  const render = pages[page];
  if (render) await render(content);
}

// Make navigate available globally for inline handlers
(window as any).__navigate = navigate;

navItems.forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.page!));
});

// Update review badge with pending count
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

navigate("dashboard");
updateBadge();
