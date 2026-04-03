import { getVaultHealth, triggerDream } from "../lib/tauri-bridge.js";

export async function renderDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">Dashboard</h2>
      <p class="page-subtitle">Vault health and pipeline controls</p>
    </div>
    <div class="stat-grid" id="stats">
      ${statCardSkeleton("hot", "Hot Entries")}
      ${statCardSkeleton("warm", "Warm Themes")}
      ${statCardSkeleton("pending", "Pending Reviews")}
    </div>
    <div class="card">
      <h3>Pipeline</h3>
      <div class="actions-row">
        <button class="btn btn-primary" id="btn-dream">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          Run Dream Pipeline
        </button>
        <button class="btn" id="btn-refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
          Refresh
        </button>
      </div>
      <div class="console-output" id="dream-output"></div>
    </div>
  `;

  await refreshStats();

  document.getElementById("btn-refresh")?.addEventListener("click", refreshStats);
  document.getElementById("btn-dream")?.addEventListener("click", async () => {
    const output = document.getElementById("dream-output")!;
    const btn = document.getElementById("btn-dream")!;
    btn.classList.add("loading");
    output.textContent = "Starting dream pipeline...";
    output.classList.add("visible");
    try {
      const result = await triggerDream();
      output.textContent = result;
      await refreshStats();
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.classList.remove("loading");
    }
  });
}

function statCardSkeleton(type: string, label: string): string {
  return `
    <div class="stat-card ${type}">
      <div class="stat-icon">${iconForType(type)}</div>
      <div class="stat-value">-</div>
      <div class="stat-label">${label}</div>
    </div>
  `;
}

function iconForType(type: string): string {
  switch (type) {
    case "hot": return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2c.5 2.5 2 4.5 2 7a4 4 0 1 1-8 0c0-2.5 2.5-5 3-7 1 2 2.5 3.5 3 0z"/><path d="M12 22v-3"/></svg>`;
    case "warm": return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/></svg>`;
    case "pending": return `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`;
    default: return "";
  }
}

async function refreshStats() {
  const grid = document.getElementById("stats")!;
  try {
    const h = await getVaultHealth();
    grid.innerHTML = `
      <div class="stat-card hot">
        <div class="stat-icon">${iconForType("hot")}</div>
        <div class="stat-value">${h.hotCount}</div>
        <div class="stat-label">Hot Entries</div>
      </div>
      <div class="stat-card warm">
        <div class="stat-icon">${iconForType("warm")}</div>
        <div class="stat-value">${h.warmCount}</div>
        <div class="stat-label">Warm Themes</div>
      </div>
      <div class="stat-card pending">
        <div class="stat-icon">${iconForType("pending")}</div>
        <div class="stat-value">${h.pendingCount}</div>
        <div class="stat-label">Pending Reviews</div>
      </div>
    `;
  } catch (e: any) {
    grid.innerHTML = `<div class="card" style="grid-column: 1/-1; color: var(--danger);">Failed to load vault health: ${e}</div>`;
  }
}
