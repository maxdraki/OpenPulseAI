import { getSkills, installSkill, installDependency, removeSkill, runSkillNow, getSkillConfig, saveSkillConfig, apiGet, type SkillData } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { log } from "../lib/logger.js";
import { confirmDialog } from "../lib/dialog.js";

// Logo.dev CDN for service logos
const LOGO_TOKEN = "pk_LAYYrrRiTb2tIjkY-KCbMw";
const logo = (domain: string) => `https://img.logo.dev/${domain}?token=${LOGO_TOKEN}&size=48&format=png`;

// Catalog of known data sources
const DATA_SOURCES = [
  { id: "github-activity", name: "GitHub", description: "Commits, PRs, reviews, issues and notifications", icon: logo("github.com") },
  { id: "folder-watcher", name: "File Changes", description: "Track modified files across project directories", icon: "" },
  { id: "google-daily-digest", name: "Google Workspace", description: "Gmail and Calendar activity digest", icon: logo("google.com") },
  { id: "trello-activity", name: "Trello", description: "Board activity, card updates, comments", icon: logo("trello.com") },
  { id: "jira-activity", name: "Jira", description: "Issues, sprints, status changes", icon: logo("atlassian.com") },
  { id: "slack-activity", name: "Slack", description: "Channel messages and mentions", icon: logo("slack.com") },
  { id: "weekly-rollup", name: "Weekly Rollup", description: "Synthesise themes into a weekly status", icon: "" },
];

// Human-readable cron descriptions for common patterns
function describeCron(cron: string | null): string {
  if (!cron) return "Manual only";
  const parts = cron.split(" ");
  if (parts.length !== 5) return cron;
  const [min, hour, , , dow] = parts;

  const h = parseInt(hour);
  const timeStr = `${h > 12 ? h - 12 : h}:${min.padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;

  if (dow === "*" && parts[2] === "*" && parts[3] === "*") return `Daily at ${timeStr}`;
  if (dow === "1-5") return `Weekdays at ${timeStr}`;
  if (dow === "0" || dow === "7") return `Sundays at ${timeStr}`;
  if (dow === "1") return `Mondays at ${timeStr}`;
  if (dow === "5") return `Fridays at ${timeStr}`;
  return cron;
}

// Human-readable lookback
function describeLookback(lb: string): string {
  if (lb === "24h") return "Last 24 hours";
  if (lb === "7d") return "Last 7 days";
  if (lb === "48h") return "Last 48 hours";
  return lb;
}

// Auto-fixable dependencies (can be installed via server endpoint)
const AUTO_FIX: Record<string, { label: string; note?: string }> = {
  "bin: gh":   { label: "Install GitHub CLI", note: "You'll need to run 'gh auth login' after installing." },
  "bin: gog":  { label: "Install gogcli", note: "Requires Go to be installed." },
  "bin: git":  { label: "Install git" },
  "bin: curl": { label: "Install curl" },
};

// Manual-only fixes (instructions, not auto-runnable)
const MANUAL_FIX: Record<string, string> = {
  "env: GITHUB_TOKEN": "Set with: export GITHUB_TOKEN=your_token",
  "env: ANTHROPIC_API_KEY": "Set in Settings page or: export ANTHROPIC_API_KEY=your_key",
  "env: OPENAI_API_KEY": "Set in Settings page or: export OPENAI_API_KEY=your_key",
  "env: GEMINI_API_KEY": "Set in Settings page or: export GEMINI_API_KEY=your_key",
};

// Module-level reference so renderSkillCard can trigger a reload
let loadSkills: (() => Promise<void>) | null = null;

export async function renderDataSources(container: HTMLElement): Promise<void> {
  // Build page
  container.textContent = "";

  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Data Sources";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Connect your tools and services";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  // Intro card
  const introCard = document.createElement("div");
  introCard.className = "card help-section";
  const introText = document.createElement("p");
  introText.className = "help-text";
  introText.textContent = "Data sources are collectors that pull activity from external tools (GitHub, Google, files, etc.) on a schedule and write summaries into your vault. Bundled sources come pre-installed. Connect the ones you use, then set their schedules on the Schedule page.";
  introCard.appendChild(introText);

  // Skills list (installed data sources)
  const skillsList = document.createElement("div");
  skillsList.id = "skills-list";

  // Advanced section (collapsed)
  const advancedSection = document.createElement("div");

  const advancedToggle = document.createElement("button");
  advancedToggle.className = "advanced-toggle";
  advancedToggle.textContent = "\u25B6 Advanced: Install from GitHub";

  const advancedContent = document.createElement("div");
  advancedContent.style.display = "none";

  const installCard = document.createElement("div");
  installCard.className = "card";
  const installH3 = document.createElement("h3");
  installH3.textContent = "Install from GitHub";
  installCard.appendChild(installH3);

  const installHelp = document.createElement("p");
  installHelp.className = "help-text";
  installHelp.style.marginBottom = "0.75rem";
  installHelp.textContent = "Enter a GitHub repository URL or owner/repo. The repo must contain a SKILL.md file.";
  installCard.appendChild(installHelp);

  const installRow = document.createElement("div");
  installRow.style.cssText = "display: flex; gap: 0.5rem; align-items: flex-end;";
  const inputGroup = document.createElement("div");
  inputGroup.className = "form-group";
  inputGroup.style.cssText = "flex: 1; margin-bottom: 0;";
  const installInput = document.createElement("input");
  installInput.className = "form-input";
  installInput.type = "text";
  installInput.id = "install-repo";
  installInput.placeholder = "e.g. github.com/user/my-skill or user/my-skill";
  inputGroup.appendChild(installInput);
  const installBtn = document.createElement("button");
  installBtn.className = "btn btn-primary";
  installBtn.id = "btn-install";
  installBtn.textContent = "Install";
  installRow.appendChild(inputGroup);
  installRow.appendChild(installBtn);
  installCard.appendChild(installRow);

  const installOutput = document.createElement("div");
  installOutput.className = "console-output";
  installOutput.id = "install-output";
  installCard.appendChild(installOutput);

  advancedContent.appendChild(installCard);
  advancedSection.appendChild(advancedToggle);
  advancedSection.appendChild(advancedContent);

  advancedToggle.addEventListener("click", () => {
    const visible = advancedContent.style.display !== "none";
    advancedContent.style.display = visible ? "none" : "";
    advancedToggle.textContent = (visible ? "\u25B6" : "\u25BC") + " Advanced: Install from GitHub";
  });

  container.appendChild(pageHeader);
  container.appendChild(introCard);
  container.appendChild(skillsList);
  container.appendChild(advancedSection);

  // Install handler
  installBtn.addEventListener("click", async () => {
    const repo = installInput.value.trim();
    if (!repo) return;
    installBtn.classList.add("loading");
    installOutput.textContent = `Installing ${repo}...`;
    installOutput.classList.add("visible");
    try {
      const result = await installSkill(repo);
      log("info", `Data source installed: ${repo}`, result);
      installOutput.textContent = result;
      const scheduleLink = document.createElement("a");
      scheduleLink.href = "#schedule";
      scheduleLink.textContent = "Set up a schedule \u2192";
      scheduleLink.style.cssText = "display: block; margin-top: 0.5rem; color: var(--accent); font-size: 0.85rem;";
      installOutput.appendChild(scheduleLink);
      installInput.value = "";
      await loadSkills?.();
    } catch (e: any) {
      log("error", `Data source install failed: ${repo}`, String(e));
      installOutput.textContent = `Error: ${e}`;
    } finally {
      installBtn.classList.remove("loading");
    }
  });

  loadSkills = async () => {
    try {
      const skills = await getSkills();
      renderDataSourcesContent(skillsList, skills);
    } catch (e: any) {
      skillsList.textContent = "";
      const errCard = document.createElement("div");
      errCard.className = "card";
      errCard.style.color = "var(--danger)";
      errCard.textContent = `Error loading data sources: ${e}`;
      skillsList.appendChild(errCard);
    }
  };

  await loadSkills?.();
}

// Render catalog + installed sections
function renderDataSourcesContent(container: HTMLElement, skills: SkillData[]): void {
  container.textContent = "";

  // Only mark as "Connected" if the skill is eligible (deps met + config provided)
  const connectedIds = new Set(skills.filter((s) => s.eligible).map((s) => s.name));

  // ── Catalog section ──
  const catalogSection = document.createElement("div");
  catalogSection.className = "card";

  const catalogH3 = document.createElement("h3");
  catalogH3.textContent = "Add a Data Source";
  catalogSection.appendChild(catalogH3);

  const catalogGrid = document.createElement("div");
  catalogGrid.className = "data-source-catalog";

  for (const ds of DATA_SOURCES) {
    const card = document.createElement("div");
    card.className = "ds-catalog-card";

    const iconEl = document.createElement("div");
    iconEl.className = "ds-catalog-icon";
    if (ds.icon.startsWith("http")) {
      const img = document.createElement("img");
      img.src = ds.icon;
      img.alt = ds.name;
      img.width = 28;
      img.height = 28;
      img.style.borderRadius = "4px";
      iconEl.appendChild(img);
    } else {
      iconEl.textContent = ds.icon || "\u{1F4E6}";
    }

    const infoEl = document.createElement("div");
    infoEl.className = "ds-catalog-info";

    const nameEl = document.createElement("div");
    nameEl.className = "ds-catalog-name";
    nameEl.textContent = ds.name;

    const descEl = document.createElement("div");
    descEl.className = "ds-catalog-desc";
    descEl.textContent = ds.description;

    infoEl.appendChild(nameEl);
    infoEl.appendChild(descEl);
    card.appendChild(iconEl);
    card.appendChild(infoEl);

    if (connectedIds.has(ds.id)) {
      const badge = document.createElement("span");
      badge.className = "ds-catalog-badge";
      badge.textContent = "\u2713 Connected";
      card.appendChild(badge);

      // Clicking scrolls to the installed skill card
      card.addEventListener("click", () => {
        const target = document.getElementById(`skill-card-${ds.id}`);
        if (target) target.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });
    } else {
      const addBtn = document.createElement("button");
      addBtn.className = "btn btn-sm ds-catalog-add";
      addBtn.textContent = "Add";
      // For uninstalled builtin IDs: clicking scrolls down if somehow present; otherwise no-op for now
      addBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        // Future: open config panel. For now scroll to advanced section.
        const adv = document.querySelector(".advanced-toggle") as HTMLButtonElement | null;
        if (adv) {
          adv.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
      card.appendChild(addBtn);
    }

    catalogGrid.appendChild(card);
  }

  catalogSection.appendChild(catalogGrid);
  container.appendChild(catalogSection);

  // ── Installed section ──
  const installedSection = document.createElement("div");
  installedSection.id = "installed-data-sources";

  const installedH3 = document.createElement("h3");
  installedH3.style.cssText = "font-size: 0.8rem; color: var(--text-tertiary); text-transform: uppercase; letter-spacing: 0.06em; margin: 1.25rem 0 0.5rem;";
  installedH3.textContent = "Your Data Sources";
  installedSection.appendChild(installedH3);

  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-state-icon";
    icon.style.cssText = "background: rgba(96, 165, 250, 0.08); color: var(--accent);";
    icon.textContent = "?";
    const msg = document.createElement("p");
    msg.textContent = "No data sources found. Add one from the catalog above or install a SKILL.md file to ~/OpenPulseAI/skills/";
    empty.appendChild(icon);
    empty.appendChild(msg);
    installedSection.appendChild(empty);
  } else {
    for (const skill of skills) {
      const card = renderSkillCard(skill);
      card.id = `skill-card-${skill.name}`;
      installedSection.appendChild(card);
    }
  }

  container.appendChild(installedSection);
}

function renderSkillsList(container: HTMLElement, skills: SkillData[]): void {
  container.textContent = "";

  if (skills.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    const icon = document.createElement("div");
    icon.className = "empty-state-icon";
    icon.style.cssText = "background: rgba(96, 165, 250, 0.08); color: var(--accent);";
    icon.textContent = "?";
    const msg = document.createElement("p");
    msg.textContent = "No skills found. Install one from GitHub or add a SKILL.md file to ~/OpenPulseAI/skills/";
    empty.appendChild(icon);
    empty.appendChild(msg);
    container.appendChild(empty);
    return;
  }

  for (const skill of skills) {
    container.appendChild(renderSkillCard(skill));
  }
}

function renderSkillCard(skill: SkillData): HTMLElement {
  const card = document.createElement("div");
  card.className = "skill-card";

  // Header row: name + badges + status
  const header = document.createElement("div");
  header.className = "skill-card-header";

  const nameArea = document.createElement("div");
  const name = document.createElement("span");
  name.className = "skill-card-name clickable";
  name.textContent = skill.name;
  name.title = "Click to view skill details";
  nameArea.appendChild(name);

  const typeBadge = document.createElement("span");
  typeBadge.className = skill.isBuiltin ? "skill-card-badge" : "skill-card-badge skill-card-badge-user";
  typeBadge.textContent = skill.isBuiltin ? "bundled" : "installed";
  nameArea.appendChild(typeBadge);

  const schedBadge = document.createElement("span");
  schedBadge.className = "skill-card-badge";
  schedBadge.textContent = describeCron(skill.schedule);
  schedBadge.title = skill.schedule ?? "No schedule — run manually";
  nameArea.appendChild(schedBadge);

  const statusArea = document.createElement("div");
  statusArea.className = "skill-card-status";
  const dot = document.createElement("span");
  dot.className = "skill-status-dot";
  dot.style.background = skill.lastStatus === "success" ? "var(--success)"
    : skill.lastStatus === "error" ? "var(--danger)" : "var(--text-tertiary)";
  const statusText = document.createElement("span");
  statusText.style.cssText = "color: var(--text-tertiary); font-size: 0.75rem;";
  statusText.textContent = skill.lastStatus === "never" ? "Not run yet" : skill.lastStatus;
  statusArea.appendChild(dot);
  statusArea.appendChild(statusText);

  header.appendChild(nameArea);
  header.appendChild(statusArea);

  // Description
  const desc = document.createElement("p");
  desc.className = "skill-card-desc";
  desc.textContent = skill.description;

  // Meta row
  const meta = document.createElement("div");
  meta.className = "skill-card-meta";

  // Eligibility
  const eligSpan = document.createElement("span");
  if (skill.eligible) {
    eligSpan.style.color = "var(--success)";
    eligSpan.textContent = "\u2713 Ready to run";
  } else {
    eligSpan.style.color = "var(--danger)";
    eligSpan.textContent = "\u2717 Setup needed";
  }
  meta.appendChild(eligSpan);

  const lookbackSpan = document.createElement("span");
  lookbackSpan.textContent = describeLookback(skill.lookback);
  lookbackSpan.title = "How far back this skill looks for data";
  meta.appendChild(lookbackSpan);

  const lastRunSpan = document.createElement("span");
  if (skill.lastRunAt) {
    const d = new Date(skill.lastRunAt);
    lastRunSpan.textContent = "Last run: " + d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } else {
    lastRunSpan.textContent = "Never run";
  }
  meta.appendChild(lastRunSpan);

  if (skill.entriesCollected > 0) {
    const entriesSpan = document.createElement("span");
    entriesSpan.textContent = `${skill.entriesCollected} entries collected`;
    meta.appendChild(entriesSpan);
  }

  card.appendChild(header);
  card.appendChild(desc);

  // Config panel (if skill has config fields)
  if (skill.config && skill.config.length > 0) {
    const configPanel = document.createElement("div");
    configPanel.className = "skill-config-panel";

    const configTitle = document.createElement("button");
    configTitle.className = "skill-config-toggle";
    configTitle.textContent = "\u2699 Configure";

    const configFields = document.createElement("div");
    configFields.className = "skill-config-fields";
    configFields.style.display = "none";

    // Load existing config then build fields
    getSkillConfig(skill.name).then((savedConfig) => {
      for (const field of skill.config) {
        const row = document.createElement("div");
        row.className = "form-group";
        row.style.marginBottom = "0.4rem";

        const label = document.createElement("label");
        label.className = "form-label";
        label.style.fontSize = "0.78rem";
        label.textContent = field.label;
        row.appendChild(label);

        if (field.type === "paths") {
          // Multi-path list with add/remove
          const pathList = document.createElement("div");
          pathList.className = "skill-path-list";
          pathList.dataset.configKey = field.key;

          const rawValue = savedConfig[field.key] ?? field.default ?? "";
          const paths = rawValue.split("\n").filter((p: string) => p.trim());
          if (paths.length === 0) paths.push(field.default ?? "");

          function renderPathItems() {
            pathList.querySelectorAll(".skill-path-item").forEach((el) => el.remove());
            const currentPaths = getPathValues();
            for (let i = 0; i < currentPaths.length; i++) {
              const item = document.createElement("div");
              item.className = "skill-path-item";
              const inp = document.createElement("input");
              inp.className = "form-input";
              inp.style.fontSize = "0.82rem";
              inp.type = "text";
              inp.value = currentPaths[i];
              inp.placeholder = "/path/to/folder";
              const removeBtn = document.createElement("button");
              removeBtn.className = "skill-path-remove";
              removeBtn.textContent = "\u00d7";
              removeBtn.title = "Remove";
              removeBtn.addEventListener("click", () => {
                item.remove();
              });
              item.appendChild(inp);
              if (currentPaths.length > 1) item.appendChild(removeBtn);
              pathList.insertBefore(item, pathList.querySelector(".skill-path-add"));
            }
          }

          function getPathValues(): string[] {
            const items = pathList.querySelectorAll<HTMLInputElement>(".skill-path-item input");
            if (items.length === 0) return paths;
            return Array.from(items).map((inp) => inp.value).filter((v) => v.trim());
          }

          const addBtn = document.createElement("button");
          addBtn.className = "skill-path-add btn btn-sm";
          addBtn.textContent = "+ Add folder";

          // Folder picker container (hidden until "Add folder" clicked)
          const pickerContainer = document.createElement("div");
          pickerContainer.className = "folder-picker";
          pickerContainer.style.display = "none";

          addBtn.addEventListener("click", async () => {
            if (pickerContainer.style.display !== "none") {
              pickerContainer.style.display = "none";
              return;
            }
            pickerContainer.style.display = "";
            await loadFolderPicker(pickerContainer, "~", (selectedPath) => {
              pickerContainer.style.display = "none";
              const item = document.createElement("div");
              item.className = "skill-path-item";
              const inp = document.createElement("input");
              inp.className = "form-input";
              inp.style.fontSize = "0.82rem";
              inp.type = "text";
              inp.value = selectedPath;
              inp.readOnly = true;
              const removeBtn = document.createElement("button");
              removeBtn.className = "skill-path-remove";
              removeBtn.textContent = "\u00d7";
              removeBtn.title = "Remove";
              removeBtn.addEventListener("click", () => item.remove());
              item.appendChild(inp);
              item.appendChild(removeBtn);
              pathList.insertBefore(item, addBtn);
            });
          });

          pathList.appendChild(addBtn);
          pathList.appendChild(pickerContainer);
          row.appendChild(pathList);

          // Initial render
          for (const p of paths) {
            const item = document.createElement("div");
            item.className = "skill-path-item";
            const inp = document.createElement("input");
            inp.className = "form-input";
            inp.style.fontSize = "0.82rem";
            inp.type = "text";
            inp.value = p;
            inp.placeholder = "/path/to/folder";
            const rmBtn = document.createElement("button");
            rmBtn.className = "skill-path-remove";
            rmBtn.textContent = "\u00d7";
            rmBtn.title = "Remove";
            rmBtn.addEventListener("click", () => item.remove());
            item.appendChild(inp);
            if (paths.length > 1) item.appendChild(rmBtn);
            pathList.insertBefore(item, addBtn);
          }
        } else {
          // Single text/path input
          const input = document.createElement("input");
          input.className = "form-input";
          input.style.fontSize = "0.82rem";
          input.type = "text";
          input.placeholder = field.default ?? "";
          input.value = savedConfig[field.key] ?? field.default ?? "";
          input.dataset.configKey = field.key;
          row.appendChild(input);
        }

        configFields.appendChild(row);
      }

      const saveBtn = document.createElement("button");
      saveBtn.className = "btn btn-sm btn-primary";
      saveBtn.textContent = "Save Config";
      saveBtn.addEventListener("click", async () => {
        const values: Record<string, string> = {};
        // Single-value inputs
        configFields.querySelectorAll<HTMLInputElement>("input[data-config-key]").forEach((inp) => {
          if (inp.value) values[inp.dataset.configKey!] = inp.value;
        });
        // Multi-path lists
        configFields.querySelectorAll<HTMLDivElement>(".skill-path-list[data-config-key]").forEach((list) => {
          const key = list.dataset.configKey!;
          const paths = Array.from(list.querySelectorAll<HTMLInputElement>(".skill-path-item input"))
            .map((inp) => inp.value.trim())
            .filter(Boolean);
          if (paths.length > 0) values[key] = paths.join("\n");
        });
        try {
          await saveSkillConfig(skill.name, values);
          log("info", `Config saved: ${skill.name}`, JSON.stringify(values));
          saveBtn.textContent = "\u2713 Saved";
          setTimeout(() => { saveBtn.textContent = "Save Config"; }, 1500);
        } catch (e: any) {
          log("error", `Config save failed: ${skill.name}`, String(e));
        }
      });
      configFields.appendChild(saveBtn);
    });

    configTitle.addEventListener("click", () => {
      configFields.style.display = configFields.style.display === "none" ? "" : "none";
    });

    configPanel.appendChild(configTitle);
    configPanel.appendChild(configFields);
    card.appendChild(configPanel);
  }

  card.appendChild(meta);

  // Missing dependencies with fix buttons or hints
  if (!skill.eligible && skill.missing.length > 0) {
    const missingCard = document.createElement("div");
    missingCard.className = "skill-missing-deps";

    const missingTitle = document.createElement("strong");
    missingTitle.textContent = "Missing dependencies:";
    missingCard.appendChild(missingTitle);

    const missingList = document.createElement("ul");
    for (const dep of skill.missing) {
      const li = document.createElement("li");
      li.className = "skill-dep-row";

      const depName = document.createElement("code");
      depName.textContent = dep;
      li.appendChild(depName);

      const autoFix = AUTO_FIX[dep];
      const manualFix = MANUAL_FIX[dep];

      if (autoFix) {
        // Extract the binary name from "bin: gh" → "gh"
        const binName = dep.replace("bin: ", "");
        const fixBtn = document.createElement("button");
        fixBtn.className = "btn btn-sm btn-primary";
        fixBtn.textContent = autoFix.label;
        fixBtn.addEventListener("click", async () => {
          fixBtn.classList.add("loading");
          fixBtn.disabled = true;
          fixBtn.textContent = "Installing...";
          try {
            const result = await installDependency(binName);
            log("info", `Dependency install: ${binName}`, result.output);
            if (result.success) {
              fixBtn.textContent = "\u2713 Installed";
              fixBtn.className = "btn btn-sm";
              fixBtn.style.color = "var(--success)";
              if (autoFix.note) {
                const note = document.createElement("span");
                note.className = "skill-fix-hint";
                note.textContent = " \u2014 " + autoFix.note;
                li.appendChild(note);
              }
              // Reload skills to update eligibility
              await loadSkills?.();
            } else {
              fixBtn.textContent = "Failed";
              fixBtn.className = "btn btn-sm";
              fixBtn.style.color = "var(--danger)";
              const errSpan = document.createElement("span");
              errSpan.className = "skill-fix-hint";
              errSpan.textContent = " \u2014 " + result.output.slice(0, 100);
              li.appendChild(errSpan);
            }
          } catch (e: any) {
            log("error", `Dependency install failed: ${binName}`, String(e));
            fixBtn.textContent = "Error";
            fixBtn.disabled = false;
          }
        });
        li.appendChild(fixBtn);
      } else if (manualFix) {
        const hintSpan = document.createElement("span");
        hintSpan.className = "skill-fix-hint";
        hintSpan.textContent = " \u2014 " + manualFix;
        li.appendChild(hintSpan);
      }

      missingList.appendChild(li);
    }
    missingCard.appendChild(missingList);
    card.appendChild(missingCard);
  }

  // Last error
  if (skill.lastError) {
    const errorDiv = document.createElement("div");
    errorDiv.className = "skill-last-error";
    errorDiv.textContent = skill.lastError;
    card.appendChild(errorDiv);
  }

  // Actions
  const actions = document.createElement("div");
  actions.className = "skill-card-actions";

  const runBtn = document.createElement("button");
  runBtn.className = "btn btn-primary";
  runBtn.disabled = !skill.eligible;
  runBtn.title = skill.eligible ? "Run this skill now" : "Fix missing dependencies first";

  const playSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  playSvg.setAttribute("width", "14");
  playSvg.setAttribute("height", "14");
  playSvg.setAttribute("viewBox", "0 0 24 24");
  playSvg.setAttribute("fill", "none");
  playSvg.setAttribute("stroke", "currentColor");
  playSvg.setAttribute("stroke-width", "2");
  const polygon = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
  polygon.setAttribute("points", "5 3 19 12 5 21 5 3");
  playSvg.appendChild(polygon);
  runBtn.appendChild(playSvg);
  runBtn.appendChild(document.createTextNode(" Run Now"));
  actions.appendChild(runBtn);

  // Remove icon (non-builtin only) — bottom-right of card
  if (!skill.isBuiltin) {
    const removeBtn = document.createElement("button");
    removeBtn.className = "skill-remove-btn";
    removeBtn.title = "Remove skill";
    const trashSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    trashSvg.setAttribute("width", "14");
    trashSvg.setAttribute("height", "14");
    trashSvg.setAttribute("viewBox", "0 0 24 24");
    trashSvg.setAttribute("fill", "none");
    trashSvg.setAttribute("stroke", "currentColor");
    trashSvg.setAttribute("stroke-width", "2");
    const path1 = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    path1.setAttribute("points", "3 6 5 6 21 6");
    const path2 = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path2.setAttribute("d", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2");
    trashSvg.appendChild(path1);
    trashSvg.appendChild(path2);
    removeBtn.appendChild(trashSvg);
    removeBtn.addEventListener("click", () => {
      confirmDialog(`Remove skill "${skill.name}"? This deletes the skill files.`, async () => {
        await removeSkill(skill.name);
        log("info", `Skill removed: ${skill.name}`);
        card.remove();
      });
    });
    card.appendChild(removeBtn);
  }

  card.appendChild(actions);

  // Output console
  const output = document.createElement("div");
  output.className = "console-output";
  card.appendChild(output);

  // Skill body panel (collapsed by default)
  // Content is from SKILL.md files (our own vault), rendered via marked library
  const bodyPanel = document.createElement("div");
  bodyPanel.className = "skill-body-panel";
  bodyPanel.style.display = "none";
  if (skill.body) {
    const wrapper = document.createElement("div");
    wrapper.className = "md-content";
    wrapper.innerHTML = renderMarkdown(skill.body); // safe: trusted SKILL.md content via marked
    bodyPanel.appendChild(wrapper);
  }
  card.appendChild(bodyPanel);

  // Name click toggles body panel
  name.addEventListener("click", () => {
    bodyPanel.style.display = bodyPanel.style.display === "none" ? "" : "none";
  });

  // Run handler
  runBtn.addEventListener("click", async () => {
    runBtn.classList.add("loading");
    runBtn.disabled = true;
    output.textContent = `Running ${skill.name}...`;
    output.classList.add("visible");
    try {
      const result = await runSkillNow(skill.name);
      log("info", `Skill completed: ${skill.name}`, result);
      output.textContent = result;
    } catch (e: any) {
      log("error", `Skill failed: ${skill.name}`, String(e));
      output.textContent = `Error: ${e}`;
    } finally {
      runBtn.classList.remove("loading");
      runBtn.disabled = !skill.eligible;
    }
  });

  return card;
}

async function loadFolderPicker(
  container: HTMLElement,
  initialPath: string,
  onSelect: (path: string) => void
): Promise<void> {
  container.textContent = "";
  let currentPath = initialPath;

  async function render() {
    container.textContent = "";

    // Breadcrumb showing current path
    const breadcrumb = document.createElement("div");
    breadcrumb.className = "folder-picker-breadcrumb";
    breadcrumb.textContent = currentPath;
    container.appendChild(breadcrumb);

    // Fetch directories
    const data = await apiGet<{ path: string; dirs: string[] }>(`/browse-dirs?path=${encodeURIComponent(currentPath)}`);
    currentPath = data.path; // resolved path

    // Up button
    if (currentPath !== "/") {
      const upBtn = document.createElement("div");
      upBtn.className = "folder-picker-item folder-picker-up";
      upBtn.textContent = "\u2191 ..";
      upBtn.addEventListener("click", () => {
        currentPath = currentPath.replace(/\/[^/]+\/?$/, "") || "/";
        render();
      });
      container.appendChild(upBtn);
    }

    // Directory list
    const dirs: string[] = data.dirs ?? [];
    if (dirs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "folder-picker-empty";
      empty.textContent = "No subdirectories";
      container.appendChild(empty);
    } else {
      for (const dir of dirs.slice(0, 50)) {
        const item = document.createElement("div");
        item.className = "folder-picker-item";
        item.textContent = dir;
        item.addEventListener("click", () => {
          currentPath = currentPath === "/" ? `/${dir}` : `${currentPath}/${dir}`;
          render();
        });
        container.appendChild(item);
      }
    }

    // Select this folder button
    const selectBtn = document.createElement("button");
    selectBtn.className = "btn btn-sm btn-primary";
    selectBtn.textContent = `Select: ${currentPath}`;
    selectBtn.style.marginTop = "0.4rem";
    selectBtn.addEventListener("click", () => onSelect(currentPath));
    container.appendChild(selectBtn);
  }

  await render();
}
