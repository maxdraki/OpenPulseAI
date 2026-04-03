import { getVaultHealth, triggerDream } from "../lib/tauri-bridge.js";

export async function renderDashboard(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h2 class="page-title">Dashboard</h2>
    <div class="stat-grid" id="stats">
      <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Hot Entries</div></div>
      <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Warm Themes</div></div>
      <div class="stat-card"><div class="stat-value">-</div><div class="stat-label">Pending Reviews</div></div>
    </div>
    <div class="card">
      <h3>Actions</h3>
      <div style="display: flex; gap: 0.5rem; align-items: center;">
        <sl-button variant="primary" id="btn-dream" size="small">
          <sl-icon slot="prefix" name="moon-stars"></sl-icon>
          Run Dream Pipeline
        </sl-button>
        <sl-button variant="default" id="btn-refresh" size="small">
          <sl-icon slot="prefix" name="arrow-clockwise"></sl-icon>
          Refresh
        </sl-button>
      </div>
      <div id="dream-output" style="margin-top: 0.75rem; font-size: 0.85rem; font-family: 'Google Sans Mono', monospace; color: var(--text-secondary);"></div>
    </div>
  `;

  await refreshStats();

  document.getElementById("btn-refresh")?.addEventListener("click", refreshStats);
  document.getElementById("btn-dream")?.addEventListener("click", async () => {
    const output = document.getElementById("dream-output")!;
    const btn = document.getElementById("btn-dream") as any;
    btn.loading = true;
    try {
      const result = await triggerDream();
      output.textContent = result;
      await refreshStats();
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.loading = false;
    }
  });
}

async function refreshStats() {
  const grid = document.getElementById("stats")!;
  try {
    const health = await getVaultHealth();
    grid.innerHTML = `
      <div class="stat-card">
        <div class="stat-value">${health.hotCount}</div>
        <div class="stat-label">Hot Entries</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${health.warmCount}</div>
        <div class="stat-label">Warm Themes</div>
      </div>
      <div class="stat-card">
        <div class="stat-value">${health.pendingCount}</div>
        <div class="stat-label">Pending Reviews</div>
      </div>
    `;
  } catch (e: any) {
    grid.innerHTML = `<div class="card" style="grid-column: 1/-1; color: var(--danger);">Failed to load: ${e}</div>`;
  }
}
