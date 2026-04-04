import { getSkills, installSkill, removeSkill, runSkillNow, type SkillData } from "../lib/tauri-bridge.js";

export async function renderSkills(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">Skills</h2>
      <p class="page-subtitle">AgentSkills.io-compatible skills that feed data into OpenPulse</p>
    </div>
    <div class="card" id="install-section">
      <h3>Install from Registry</h3>
      <div style="display: flex; gap: 0.5rem; align-items: flex-end;">
        <div class="form-group" style="flex: 1; margin-bottom: 0;">
          <input class="form-input" type="text" id="install-repo" placeholder="owner/repo (e.g. anthropics/skills)" />
        </div>
        <button class="btn btn-primary" id="btn-install">Install</button>
      </div>
      <div class="console-output" id="install-output"></div>
    </div>
    <div id="skills-list"></div>
  `;

  document.getElementById("btn-install")?.addEventListener("click", async () => {
    const input = document.getElementById("install-repo") as HTMLInputElement;
    const output = document.getElementById("install-output")!;
    const btn = document.getElementById("btn-install")!;
    const repo = input.value.trim();
    if (!repo) return;
    btn.classList.add("loading");
    output.textContent = `Installing ${repo}...`;
    output.classList.add("visible");
    try {
      const result = await installSkill(repo);
      output.textContent = result;
      input.value = "";
      await refreshSkills();
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.classList.remove("loading");
    }
  });

  await refreshSkills();
}

async function refreshSkills() {
  const list = document.getElementById("skills-list")!;
  try {
    const skills = await getSkills();
    if (skills.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon" style="background: rgba(96, 165, 250, 0.08); color: var(--accent);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4"/></svg>
          </div>
          <p>No skills installed. Install from the registry or add SKILL.md files to ~/OpenPulseAI/skills/</p>
        </div>`;
      return;
    }
    list.innerHTML = skills.map(renderSkillCard).join("");
    skills.forEach(bindSkillEvents);
  } catch (e: any) {
    list.innerHTML = `<div class="card" style="color: var(--danger);">Error: ${e}</div>`;
  }
}

function renderSkillCard(skill: SkillData): string {
  const statusColor = skill.lastStatus === "success" ? "var(--success)"
    : skill.lastStatus === "error" ? "var(--danger)" : "var(--text-tertiary)";
  const lastRun = skill.lastRunAt
    ? new Date(skill.lastRunAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
    : "Never";
  const eligIcon = skill.eligible
    ? '<span style="color: var(--success);">&#10003;</span>'
    : '<span style="color: var(--danger);">&#10007;</span>';

  return `
    <div class="skill-card" data-name="${esc(skill.name)}">
      <div class="skill-card-header">
        <div>
          <span class="skill-card-name">${esc(skill.name)}</span>
          ${skill.isBuiltin ? '<span class="skill-card-badge">bundled</span>' : '<span class="skill-card-badge skill-card-badge-user">installed</span>'}
          ${skill.schedule ? `<span class="skill-card-badge">${esc(skill.schedule)}</span>` : '<span class="skill-card-badge">manual</span>'}
        </div>
        <div class="skill-card-status">
          <span class="skill-status-dot" style="background: ${statusColor};"></span>
          <span style="color: var(--text-tertiary); font-size: 0.75rem;">${skill.lastStatus}</span>
        </div>
      </div>
      <p class="skill-card-desc">${esc(skill.description)}</p>
      <div class="skill-card-meta">
        <span>${eligIcon} ${skill.eligible ? "Eligible" : `Missing: ${skill.missing.join(", ")}`}</span>
        <span>Lookback: <code>${skill.lookback}</code></span>
        <span>Last run: ${lastRun}</span>
        <span>Entries: ${skill.entriesCollected}</span>
      </div>
      ${skill.lastError ? `<div style="color: var(--danger); font-size: 0.78rem; margin-top: 0.5rem;">${esc(skill.lastError)}</div>` : ""}
      <div class="skill-card-actions">
        <button class="btn btn-primary" id="run-${esc(skill.name)}" ${!skill.eligible ? "disabled" : ""}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"/></svg>
          Run Now
        </button>
        ${!skill.isBuiltin ? `<button class="btn btn-danger" id="remove-${esc(skill.name)}">Remove</button>` : ""}
      </div>
      <div class="console-output" id="output-${esc(skill.name)}"></div>
    </div>
  `;
}

function bindSkillEvents(skill: SkillData) {
  document.getElementById(`run-${skill.name}`)?.addEventListener("click", async () => {
    const output = document.getElementById(`output-${skill.name}`)!;
    const btn = document.getElementById(`run-${skill.name}`)!;
    btn.classList.add("loading");
    output.textContent = "Running...";
    output.classList.add("visible");
    try {
      const result = await runSkillNow(skill.name);
      output.textContent = result;
      await refreshSkills();
    } catch (e: any) {
      output.textContent = `Error: ${e}`;
    } finally {
      btn.classList.remove("loading");
    }
  });

  document.getElementById(`remove-${skill.name}`)?.addEventListener("click", async () => {
    if (confirm(`Remove skill "${skill.name}"?`)) {
      await removeSkill(skill.name);
      await refreshSkills();
    }
  });
}

function esc(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
