import { renderDashboard } from "./pages/dashboard.js";
import { renderReview } from "./pages/review.js";
import { renderSettings } from "./pages/settings.js";

const content = document.getElementById("content")!;
const navButtons = document.querySelectorAll<HTMLElement>("#nav sl-button[data-page]");

const pages: Record<string, (el: HTMLElement) => Promise<void>> = {
  dashboard: renderDashboard,
  review: renderReview,
  settings: renderSettings,
};

function navigate(page: string) {
  navButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === page);
  });
  const render = pages[page];
  if (render) render(content);
}

navButtons.forEach((btn) => {
  btn.addEventListener("click", () => navigate(btn.dataset.page!));
});

navigate("dashboard");
