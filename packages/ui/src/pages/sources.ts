import {
  getSources,
  addSource,
  deleteSource,
  testSourceConnection,
  triggerSourceCollect,
  type SourceData,
} from "../lib/tauri-bridge.js";

export async function renderSources(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">Sources</h2>
      <p class="page-subtitle">MCP servers that feed data into OpenPulse</p>
    </div>
    <div style="margin-bottom: 1rem;">
      <button class="btn btn-primary" id="btn-add-source">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        Add Source
      </button>
    </div>
    <div id="add-source-form" style="display:none;"></div>
    <div id="sources-list"></div>
  `;

  document.getElementById("btn-add-source")?.addEventListener("click", () => {
    showAddForm();
  });

  await refreshSources();
}

async function refreshSources() {
  const list = document.getElementById("sources-list")!;
  try {
    const sources = await getSources();
    if (sources.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="background: rgba(96, 165, 250, 0.08); color: var(--accent);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>
          </div>
          <p>No sources configured. Add an MCP server to start pulling data into OpenPulse.</p>
        </div>`;
      return;
    }
    list.innerHTML = sources.map(renderSourceCard).join("");
    sources.forEach(bindSourceEvents);
  } catch (e: any) {
    list.innerHTML = `<div class="card" style="color: var(--danger);">Error: ${e}</div>`;
  }
}

function renderSourceCard(source: SourceData): string {
  const statusColor =
    source.lastStatus === "success"
      ? "var(--success)"
      : source.lastStatus === "error"
        ? "var(--danger)"
        : "var(--text-tertiary)";
  const lastRun = source.lastRunAt
    ? new Date(source.lastRunAt).toLocaleString("en-GB", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Never";

  return `
    <div class="source-card" data-name="${esc(source.name)}">
      <div class="source-card-header">
        <div>
          <span class="source-card-name">${esc(source.name)}</span>
          ${source.template ? `<span class="source-card-template">${esc(source.template)}</span>` : '<span class="source-card-template">auto-discover</span>'}
        </div>
        <div class="source-card-status">
          <span class="source-status-dot" style="background: ${statusColor};"></span>
          <span style="color: var(--text-tertiary); font-size: 0.75rem;">${source.lastStatus}</span>
        </div>
      </div>
      <div class="source-card-meta">
        <span>Schedule: <code>${esc(source.schedule)}</code></span>
        <span>Lookback: <code>${source.lookback}</code></span>
        <span>Last run: ${lastRun}</span>
        <span>Entries: ${source.entriesCollected}</span>
      </div>
      <div class="source-card-command">
        <code>${esc(source.command)} ${source.args.map(esc).join(" ")}</code>
      </div>
      ${source.lastError ? `<div style="color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem;">${esc(source.lastError)}</div>` : ""}
      <div class="source-card-actions">
        <button class="btn btn-primary" id="collect-${esc(source.name)}">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Collect Now
        </button>
        <button class="btn" id="test-${esc(source.name)}">Test Connection</button>
        <button class="btn btn-danger" id="delete-${esc(source.name)}">Delete</button>
      </div>
      <div class="console-output" id="output-${esc(source.name)}"></div>
    </div>
  `;
}

function bindSourceEvents(source: SourceData) {
  document.getElementById(`collect-${source.name}`)?.addEventListener("click", async () => {
    const output = document.getElementById(`output-${source.name}`)!;
    const btn = document.getElementById(`collect-${source.name}`)!;
    btn.classList.add("loading");
    output.textContent = "Collecting...";
    output.classList.add("visible");
    try {
      const result = await triggerSourceCollect(source.name);
      output.textContent = result;
      await refreshSources();
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.classList.remove("loading");
    }
  });

  document.getElementById(`test-${source.name}`)?.addEventListener("click", async () => {
    const output = document.getElementById(`output-${source.name}`)!;
    const btn = document.getElementById(`test-${source.name}`)!;
    btn.classList.add("loading");
    output.classList.add("visible");
    try {
      const result = await testSourceConnection(source.name);
      output.textContent = result.ok ? `✓ ${result.message}` : `✗ ${result.error}`;
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.classList.remove("loading");
    }
  });

  document.getElementById(`delete-${source.name}`)?.addEventListener("click", async () => {
    if (confirm(`Delete source "${source.name}"?`)) {
      await deleteSource(source.name);
      await refreshSources();
    }
  });
}

function showAddForm() {
  const form = document.getElementById("add-source-form")!;
  form.style.display = "block";
  form.innerHTML = `
    <div class="card">
      <h3>Add Source</h3>
      <div class="settings-section">
        <div class="form-group">
          <label class="form-label">Name</label>
          <input class="form-input" type="text" id="src-name" placeholder="gmail" />
        </div>
        <div class="form-group">
          <label class="form-label">Command</label>
          <input class="form-input" type="text" id="src-command" placeholder="npx" />
        </div>
        <div class="form-group">
          <label class="form-label">Args (comma-separated)</label>
          <input class="form-input" type="text" id="src-args" placeholder="-y, @anthropic/gmail-mcp" />
        </div>
        <div class="form-group">
          <label class="form-label">Schedule (cron)</label>
          <input class="form-input" type="text" id="src-schedule" value="0 23 * * *" />
          <p class="form-help">Cron expression. "0 23 * * *" = every day at 11pm</p>
        </div>
        <div class="form-group">
          <label class="form-label">Lookback</label>
          <select class="form-select" id="src-lookback">
            <option value="1h">1 hour</option>
            <option value="6h">6 hours</option>
            <option value="12h">12 hours</option>
            <option value="24h" selected>24 hours</option>
            <option value="1w">1 week</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Template</label>
          <select class="form-select" id="src-template">
            <option value="">Auto-discover (LLM)</option>
            <option value="gmail">Gmail</option>
            <option value="google-calendar">Google Calendar</option>
            <option value="github">GitHub</option>
          </select>
        </div>
        <div class="actions-row">
          <button class="btn btn-success" id="btn-save-source">Save</button>
          <button class="btn" id="btn-cancel-source">Cancel</button>
        </div>
      </div>
    </div>
  `;

  document.getElementById("btn-cancel-source")?.addEventListener("click", () => {
    form.style.display = "none";
  });

  document.getElementById("btn-save-source")?.addEventListener("click", async () => {
    const name = (document.getElementById("src-name") as HTMLInputElement).value.trim();
    const command = (document.getElementById("src-command") as HTMLInputElement).value.trim();
    const argsRaw = (document.getElementById("src-args") as HTMLInputElement).value.trim();
    const schedule = (document.getElementById("src-schedule") as HTMLInputElement).value.trim();
    const lookback = (document.getElementById("src-lookback") as HTMLSelectElement).value;
    const template = (document.getElementById("src-template") as HTMLSelectElement).value || undefined;

    if (!name || !command) {
      alert("Name and Command are required.");
      return;
    }

    const args = argsRaw ? argsRaw.split(",").map((a) => a.trim()) : [];

    await addSource({ name, command, args, schedule, lookback, template, enabled: true });
    form.style.display = "none";
    await refreshSources();
  });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
