import { renderDashboard } from "./pages/dashboard.js";
import { renderReview } from "./pages/review.js";
import { renderSettings } from "./pages/settings.js";
import { listPendingUpdates } from "./lib/tauri-bridge.js";

const content = document.getElementById("content")!;
const navItems = document.querySelectorAll<HTMLButtonElement>(".nav-item[data-page]");

const pages: Record<string, (el: HTMLElement) => Promise<void>> = {
  dashboard: renderDashboard,
  review: renderReview,
  settings: renderSettings,
};

let currentPage = "";

async function navigate(page: string) {
  if (page === currentPage) return;
  currentPage = page;

  navItems.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });

  content.classList.remove("fade-in");
  // Force reflow to restart animation
  void content.offsetWidth;
  content.classList.add("fade-in");

  const render = pages[page];
  if (render) await render(content);
}

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
