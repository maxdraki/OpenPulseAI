import {
  getOrchestratorStatus,
  getSkills,
  updateSchedule,
  triggerOrchestratorRun,
  toggleOrchestratorSchedule,
  type OrchestratorSchedule,
  type OrchestratorCollector,
  type OrchestratorStatus,
  type SkillData,
} from "../lib/tauri-bridge.js";
import { log } from "../lib/logger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTime(time24: string): string {
  const [hourStr, minStr] = time24.split(":");
  const hour = parseInt(hourStr, 10);
  const min = minStr ?? "00";
  const ampm = hour >= 12 ? "PM" : "AM";
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${min} ${ampm}`;
}

const DAY_ABBREVS: Record<string, string> = {
  mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun",
};

const WEEKDAY_SET = new Set(["mon", "tue", "wed", "thu", "fri"]);
const WEEKEND_SET = new Set(["sat", "sun"]);
const ALL_SET = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

function formatDays(days: string[]): string {
  const set = new Set(days);
  if (setsEqual(set, ALL_SET)) return "Every day";
  if (setsEqual(set, WEEKDAY_SET)) return "Weekdays";
  if (setsEqual(set, WEEKEND_SET)) return "Weekends";
  return days.map((d) => DAY_ABBREVS[d] ?? d).join(", ");
}

function formatSchedule(sched: OrchestratorSchedule): string {
  return `${formatDays(sched.days)} at ${formatTime(sched.time)}`;
}

function relativeTime(iso: string | null): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function resultDot(result: "success" | "error" | "never"): HTMLElement {
  const dot = document.createElement("span");
  dot.className = "result-dot";
  if (result === "success") {
    dot.style.color = "var(--success)";
    dot.textContent = "●";
    dot.title = "Last run succeeded";
  } else if (result === "error") {
    dot.style.color = "var(--danger)";
    dot.textContent = "●";
    dot.title = "Last run failed";
  } else {
    dot.style.color = "var(--text-tertiary)";
    dot.textContent = "●";
    dot.title = "Never run";
  }
  return dot;
}

// ─── Time picker builder ─────────────────────────────────────────────────────

const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];

interface TimePicker {
  el: HTMLElement;
  getSchedule(): OrchestratorSchedule | null;
}

function buildTimePicker(
  onSave: (sched: OrchestratorSchedule) => void,
  onCancel: () => void,
): TimePicker {
  const wrap = document.createElement("div");
  wrap.className = "time-picker";

  // Time row
  const timeRow = document.createElement("div");
  timeRow.className = "time-picker-row";

  const timeLabel = document.createElement("span");
  timeLabel.textContent = "at";
  timeLabel.style.color = "var(--text-tertiary)";
  timeLabel.style.fontSize = "0.82rem";

  const hourSel = document.createElement("select");
  for (let h = 1; h <= 12; h++) {
    const opt = document.createElement("option");
    opt.value = String(h);
    opt.textContent = String(h);
    hourSel.appendChild(opt);
  }
  hourSel.value = "7";

  const minSel = document.createElement("select");
  for (const m of ["00", "15", "30", "45"]) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    minSel.appendChild(opt);
  }

  const ampmSel = document.createElement("select");
  for (const v of ["AM", "PM"]) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    ampmSel.appendChild(opt);
  }
  ampmSel.value = "PM";

  const colon = document.createElement("span");
  colon.textContent = ":";
  colon.style.color = "var(--text-secondary)";

  timeRow.appendChild(timeLabel);
  timeRow.appendChild(hourSel);
  timeRow.appendChild(colon);
  timeRow.appendChild(minSel);
  timeRow.appendChild(ampmSel);
  wrap.appendChild(timeRow);

  // Day toggles row
  const daysRow = document.createElement("div");
  daysRow.className = "time-picker-row";
  const daysLabel = document.createElement("span");
  daysLabel.textContent = "on";
  daysLabel.style.color = "var(--text-tertiary)";
  daysLabel.style.fontSize = "0.82rem";
  daysRow.appendChild(daysLabel);

  const togglesWrap = document.createElement("div");
  togglesWrap.className = "day-toggles";
  const toggleBtns: HTMLButtonElement[] = [];
  const selectedDays = new Set<string>(["mon", "tue", "wed", "thu", "fri"]);

  DAY_KEYS.forEach((key, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "day-toggle" + (selectedDays.has(key) ? " active" : "");
    btn.textContent = DAY_LABELS[i];
    btn.dataset.day = key;
    btn.addEventListener("click", () => {
      if (selectedDays.has(key)) {
        selectedDays.delete(key);
        btn.classList.remove("active");
      } else {
        selectedDays.add(key);
        btn.classList.add("active");
      }
    });
    toggleBtns.push(btn);
    togglesWrap.appendChild(btn);
  });
  daysRow.appendChild(togglesWrap);
  wrap.appendChild(daysRow);

  // Shortcuts
  function applyDaySet(days: string[]) {
    selectedDays.clear();
    for (const d of days) selectedDays.add(d);
    toggleBtns.forEach((btn) => {
      btn.classList.toggle("active", selectedDays.has(btn.dataset.day!));
    });
  }

  const shortcuts = document.createElement("div");
  shortcuts.className = "day-shortcuts";

  const everyDayBtn = document.createElement("button");
  everyDayBtn.type = "button";
  everyDayBtn.className = "day-shortcut";
  everyDayBtn.textContent = "Every day";
  everyDayBtn.addEventListener("click", () => applyDaySet([...ALL_SET]));

  const weekdaysBtn = document.createElement("button");
  weekdaysBtn.type = "button";
  weekdaysBtn.className = "day-shortcut";
  weekdaysBtn.textContent = "Weekdays";
  weekdaysBtn.addEventListener("click", () => applyDaySet([...WEEKDAY_SET]));

  shortcuts.appendChild(everyDayBtn);
  shortcuts.appendChild(weekdaysBtn);
  wrap.appendChild(shortcuts);

  // Save / Cancel
  const actRow = document.createElement("div");
  actRow.className = "time-picker-row";
  actRow.style.marginTop = "0.5rem";

  const saveBtn = document.createElement("button");
  saveBtn.type = "button";
  saveBtn.className = "btn btn-primary btn-sm";
  saveBtn.textContent = "Save";
  saveBtn.style.fontSize = "0.8rem";
  saveBtn.style.padding = "0.25rem 0.75rem";

  const cancelBtn = document.createElement("button");
  cancelBtn.type = "button";
  cancelBtn.className = "btn btn-ghost btn-sm";
  cancelBtn.textContent = "Cancel";
  cancelBtn.style.fontSize = "0.8rem";
  cancelBtn.style.padding = "0.25rem 0.75rem";

  saveBtn.addEventListener("click", () => {
    const sched = getSchedule();
    if (sched) onSave(sched);
  });
  cancelBtn.addEventListener("click", onCancel);

  actRow.appendChild(saveBtn);
  actRow.appendChild(cancelBtn);
  wrap.appendChild(actRow);

  function getSchedule(): OrchestratorSchedule | null {
    if (selectedDays.size === 0) return null;
    const h = parseInt(hourSel.value, 10);
    const m = minSel.value;
    const isAM = ampmSel.value === "AM";
    let h24: number;
    if (isAM) {
      h24 = h === 12 ? 0 : h;
    } else {
      h24 = h === 12 ? 12 : h + 12;
    }
    const time = `${String(h24).padStart(2, "0")}:${m}`;
    const days = DAY_KEYS.filter((d) => selectedDays.has(d));
    return { time, days };
  }

  return { el: wrap, getSchedule };
}

// ─── Collector card builder ──────────────────────────────────────────────────

function buildCollectorCard(
  skillName: string,
  collector: OrchestratorCollector | undefined,
  onUpdate: () => void,
): HTMLElement {
  const card = document.createElement("div");
  card.className = "schedule-card";

  // Header
  const header = document.createElement("div");
  header.className = "schedule-card-header";

  const nameEl = document.createElement("span");
  nameEl.className = "schedule-card-name";
  nameEl.textContent = skillName;

  const toggleLabel = document.createElement("label");
  toggleLabel.style.display = "flex";
  toggleLabel.style.alignItems = "center";
  toggleLabel.style.gap = "0.35rem";
  toggleLabel.style.cursor = "pointer";
  toggleLabel.style.fontSize = "0.78rem";
  toggleLabel.style.color = "var(--text-secondary)";

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.checked = collector?.enabled ?? false;
  checkbox.style.cursor = "pointer";
  checkbox.addEventListener("change", async () => {
    try {
      await toggleOrchestratorSchedule(skillName, checkbox.checked);
      log("info", `Toggled ${skillName} schedule: ${checkbox.checked}`);
      onUpdate();
    } catch (e) {
      log("error", `Error toggling ${skillName}`, String(e));
      checkbox.checked = !checkbox.checked;
    }
  });

  toggleLabel.appendChild(checkbox);
  toggleLabel.appendChild(document.createTextNode("Enabled"));
  header.appendChild(nameEl);
  header.appendChild(toggleLabel);
  card.appendChild(header);

  // Schedule tags
  const schedules: OrchestratorSchedule[] = collector ? [...collector.schedules] : [];
  const tagsWrap = document.createElement("div");
  tagsWrap.className = "schedule-tags";

  function renderTags() {
    tagsWrap.textContent = "";
    schedules.forEach((sched, i) => {
      const tag = document.createElement("span");
      tag.className = "schedule-tag";

      const tagText = document.createElement("span");
      tagText.textContent = formatSchedule(sched);

      const removeBtn = document.createElement("button");
      removeBtn.type = "button";
      removeBtn.className = "schedule-tag-remove";
      removeBtn.textContent = "×";
      removeBtn.title = "Remove schedule";
      removeBtn.addEventListener("click", async () => {
        const removed = schedules.splice(i, 1)[0];
        renderTags();
        try {
          await updateSchedule(skillName, schedules, checkbox.checked);
          log("info", `Removed schedule from ${skillName}`);
          onUpdate();
        } catch (e) {
          log("error", `Error removing schedule from ${skillName}`, String(e));
          schedules.splice(i, 0, removed);
          renderTags();
        }
      });

      tag.appendChild(tagText);
      tag.appendChild(removeBtn);
      tagsWrap.appendChild(tag);
    });
  }

  renderTags();

  // Add schedule button inline with tags
  const addBtn = document.createElement("button");
  addBtn.type = "button";
  addBtn.className = "btn btn-ghost btn-sm";
  addBtn.style.cssText = "font-size: 0.78rem; padding: 0.2rem 0.5rem;";
  addBtn.textContent = "+ Add";
  tagsWrap.appendChild(addBtn);

  card.appendChild(tagsWrap);

  // Picker slot (hidden until Add clicked)
  let pickerActive = false;
  const pickerSlot = document.createElement("div");

  addBtn.addEventListener("click", () => {
    if (pickerActive) return;
    pickerActive = true;
    const picker = buildTimePicker(
      async (sched) => {
        schedules.push(sched);
        renderTags();
        pickerSlot.textContent = "";
        pickerActive = false;
        try {
          await updateSchedule(skillName, schedules, checkbox.checked);
          log("info", `Added schedule to ${skillName}: ${formatSchedule(sched)}`);
          onUpdate();
        } catch (e) {
          log("error", `Error saving schedule for ${skillName}`, String(e));
          schedules.pop();
          renderTags();
        }
      },
      () => {
        pickerSlot.textContent = "";
        pickerActive = false;
      },
    );
    pickerSlot.appendChild(picker.el);
  });

  card.appendChild(pickerSlot);

  // Meta row (last run + next run + Run Now button on same line)
  const meta = document.createElement("div");
  meta.className = "schedule-meta";

  const lastRunEl = document.createElement("span");
  const lastRunLabel = document.createElement("span");
  lastRunLabel.textContent = "Last run: ";
  lastRunLabel.style.color = "var(--text-tertiary)";
  lastRunEl.appendChild(lastRunLabel);
  if (collector) {
    lastRunEl.appendChild(resultDot(collector.lastResult));
    lastRunEl.appendChild(document.createTextNode(" " + relativeTime(collector.lastRun)));
  } else {
    lastRunEl.appendChild(document.createTextNode("—"));
  }

  const nextRunEl = document.createElement("span");
  const nextRunLabel = document.createElement("span");
  nextRunLabel.textContent = "Next: ";
  nextRunLabel.style.color = "var(--text-tertiary)";
  nextRunEl.appendChild(nextRunLabel);
  if (collector?.nextRun) {
    nextRunEl.appendChild(
      document.createTextNode(
        new Date(collector.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      ),
    );
  } else {
    nextRunEl.appendChild(document.createTextNode("—"));
  }

  meta.appendChild(lastRunEl);
  meta.appendChild(nextRunEl);

  // Run Now button with play icon
  const runBtn = document.createElement("button");
  runBtn.type = "button";
  runBtn.className = "btn btn-primary";
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
  runBtn.addEventListener("click", async () => {
    runBtn.disabled = true;
    // Clear children safely, set running text
    while (runBtn.firstChild) runBtn.removeChild(runBtn.firstChild);
    runBtn.appendChild(document.createTextNode("Running\u2026"));
    try {
      await triggerOrchestratorRun(skillName);
      log("info", `Triggered run for ${skillName}`);
    } catch (e) {
      log("error", `Error triggering run for ${skillName}`, String(e));
    } finally {
      runBtn.disabled = false;
      // Restore icon + text
      while (runBtn.firstChild) runBtn.removeChild(runBtn.firstChild);
      runBtn.appendChild(playSvg);
      runBtn.appendChild(document.createTextNode(" Run Now"));
      onUpdate();
    }
  });
  meta.appendChild(runBtn);
  card.appendChild(meta);

  // Error detail
  if (collector?.lastResult === "error" && collector.lastError) {
    const errEl = document.createElement("div");
    errEl.style.marginTop = "0.4rem";
    errEl.style.fontSize = "0.75rem";
    errEl.style.color = "var(--danger)";
    errEl.style.fontFamily = "var(--font-mono)";
    errEl.textContent = collector.lastError;
    card.appendChild(errEl);
  }

  return card;
}

// ─── Main render ─────────────────────────────────────────────────────────────

let _pollInterval: ReturnType<typeof setInterval> | null = null;
let _stopPolling: (() => void) | null = null;

export async function renderSchedule(container: HTMLElement): Promise<void> {
  // Clean up previous render's poll and listeners
  if (_stopPolling) _stopPolling();
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }

  container.textContent = "";

  // Page header
  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Schedule";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Manage data source schedules and the orchestrator";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);
  container.appendChild(pageHeader);

  // Status banner placeholder
  const bannerEl = document.createElement("div");
  container.appendChild(bannerEl);

  // Content area
  const contentEl = document.createElement("div");
  container.appendChild(contentEl);

  async function refresh() {
    let status: OrchestratorStatus;
    let skills: SkillData[];
    try {
      [status, skills] = await Promise.all([getOrchestratorStatus(), getSkills()]);
    } catch (e) {
      log("error", "Schedule page: failed to load data", String(e));
      bannerEl.className = "orchestrator-banner stopped";
      bannerEl.textContent = "Failed to load orchestrator status";
      return;
    }

    // Banner
    bannerEl.textContent = "";
    bannerEl.className = status.running ? "orchestrator-banner running" : "orchestrator-banner stopped";
    const dotEl = document.createElement("span");
    dotEl.textContent = "●";
    bannerEl.appendChild(dotEl);

    if (status.running) {
      let nextSkill = "";
      let nextTime = "";
      let nextMs = Infinity;
      for (const [name, col] of Object.entries(status.collectors)) {
        if (col.nextRun) {
          const ms = new Date(col.nextRun).getTime() - Date.now();
          if (ms > 0 && ms < nextMs) {
            nextMs = ms;
            nextSkill = name;
            nextTime = new Date(col.nextRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
          }
        }
      }
      const msg = nextSkill
        ? ` Orchestrator running — next: ${nextSkill} at ${nextTime}`
        : " Orchestrator running";
      bannerEl.appendChild(document.createTextNode(msg));
    } else {
      bannerEl.appendChild(document.createTextNode(" Orchestrator stopped"));
    }

    // Re-render content
    contentEl.textContent = "";

    // ── Collector cards ──
    const skillsInOrchestrator = new Set(Object.keys(status.collectors));

    if (skillsInOrchestrator.size > 0) {
      const scheduledHeader = document.createElement("h3");
      scheduledHeader.style.fontSize = "0.8rem";
      scheduledHeader.style.color = "var(--text-tertiary)";
      scheduledHeader.style.textTransform = "uppercase";
      scheduledHeader.style.letterSpacing = "0.06em";
      scheduledHeader.style.marginBottom = "0.5rem";
      scheduledHeader.textContent = "Collectors";
      contentEl.appendChild(scheduledHeader);

      for (const [skillName, collector] of Object.entries(status.collectors)) {
        const card = buildCollectorCard(skillName, collector, refresh);
        contentEl.appendChild(card);
      }
    }

    // ── Unscheduled section ──
    // Only show eligible (configured) sources that aren't scheduled yet
    const unscheduled = skills.filter((s) => s.eligible && !skillsInOrchestrator.has(s.name));
    if (unscheduled.length > 0) {
      const unschedSection = document.createElement("div");
      unschedSection.className = "unscheduled-section";

      const unschedH4 = document.createElement("h4");
      unschedH4.textContent = "Unscheduled";
      unschedSection.appendChild(unschedH4);

      for (const skill of unscheduled) {
        const row = document.createElement("div");
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.padding = "0.4rem 0.75rem";
        row.style.background = "var(--bg-surface)";
        row.style.border = "1px solid var(--border-subtle)";
        row.style.borderRadius = "var(--radius-sm)";
        row.style.marginBottom = "0.35rem";

        const nameSpan = document.createElement("span");
        nameSpan.style.fontSize = "0.85rem";
        nameSpan.style.color = "var(--text-secondary)";
        nameSpan.textContent = skill.name;
        row.appendChild(nameSpan);

        const addBtn = document.createElement("button");
        addBtn.type = "button";
        addBtn.className = "btn btn-ghost btn-sm";
        addBtn.style.fontSize = "0.75rem";
        addBtn.style.padding = "0.2rem 0.5rem";
        addBtn.textContent = "+ Add schedule";
        const skillName = skill.name;
        addBtn.addEventListener("click", async () => {
          try {
            await updateSchedule(skillName, [], true);
            log("info", `Added ${skillName} to orchestrator`);
            await refresh();
          } catch (e) {
            log("error", `Error adding ${skillName}`, String(e));
          }
        });
        row.appendChild(addBtn);
        unschedSection.appendChild(row);
      }
      contentEl.appendChild(unschedSection);
    }

    // ── Dream Pipeline section ──
    const dream = status.dreamPipeline;
    const dreamSection = document.createElement("div");
    dreamSection.className = "dream-section";

    const dreamHeader = document.createElement("div");
    dreamHeader.style.display = "flex";
    dreamHeader.style.justifyContent = "space-between";
    dreamHeader.style.alignItems = "center";
    dreamHeader.style.marginBottom = "0.5rem";

    const dreamTitle = document.createElement("span");
    dreamTitle.style.fontWeight = "600";
    dreamTitle.style.fontSize = "0.95rem";
    dreamTitle.textContent = "Dream Pipeline";

    const autoLabel = document.createElement("label");
    autoLabel.style.display = "flex";
    autoLabel.style.alignItems = "center";
    autoLabel.style.gap = "0.35rem";
    autoLabel.style.cursor = "pointer";
    autoLabel.style.fontSize = "0.78rem";
    autoLabel.style.color = "var(--text-secondary)";

    const autoCheck = document.createElement("input");
    autoCheck.type = "checkbox";
    autoCheck.checked = dream.autoTrigger;
    autoCheck.style.cursor = "pointer";
    autoCheck.addEventListener("change", async () => {
      try {
        await toggleOrchestratorSchedule("dreamPipeline", autoCheck.checked);
        log("info", `Toggled dream auto-trigger: ${autoCheck.checked}`);
        refresh();
      } catch (e) {
        log("error", "Error toggling dream", String(e));
        autoCheck.checked = !autoCheck.checked;
      }
    });

    autoLabel.appendChild(autoCheck);
    autoLabel.appendChild(document.createTextNode("Auto-trigger"));
    dreamHeader.appendChild(dreamTitle);
    dreamHeader.appendChild(autoLabel);
    dreamSection.appendChild(dreamHeader);

    // Barrier progress
    const totalCollectors = Object.keys(status.collectors).length;
    const completedToday = dream.collectorsCompletedToday.length;

    const barrierWrap = document.createElement("div");
    barrierWrap.className = "barrier-progress";

    const barrierText = document.createElement("span");
    barrierText.textContent = `${completedToday} of ${totalCollectors} collectors completed today`;
    barrierWrap.appendChild(barrierText);

    const barrierBar = document.createElement("div");
    barrierBar.className = "barrier-bar";
    const barrierFill = document.createElement("div");
    barrierFill.className = "barrier-bar-fill";
    const pct = totalCollectors > 0 ? Math.round((completedToday / totalCollectors) * 100) : 0;
    barrierFill.style.width = `${pct}%`;
    barrierBar.appendChild(barrierFill);
    barrierWrap.appendChild(barrierBar);
    dreamSection.appendChild(barrierWrap);

    // Last run meta
    const dreamMeta = document.createElement("div");
    dreamMeta.className = "schedule-meta";

    const dreamLastRun = document.createElement("span");
    const dreamLastLabel = document.createElement("span");
    dreamLastLabel.textContent = "Last run: ";
    dreamLastLabel.style.color = "var(--text-tertiary)";
    dreamLastRun.appendChild(dreamLastLabel);
    dreamLastRun.appendChild(resultDot(dream.lastResult));
    dreamLastRun.appendChild(document.createTextNode(" " + relativeTime(dream.lastRun)));
    dreamMeta.appendChild(dreamLastRun);
    dreamSection.appendChild(dreamMeta);

    // Dream error detail
    if (dream.lastResult === "error" && dream.lastError) {
      const errEl = document.createElement("div");
      errEl.style.marginTop = "0.35rem";
      errEl.style.fontSize = "0.75rem";
      errEl.style.color = "var(--danger)";
      errEl.style.fontFamily = "var(--font-mono)";
      errEl.textContent = dream.lastError;
      dreamSection.appendChild(errEl);
    }

    // Run Now button
    const dreamRunBtn = document.createElement("button");
    dreamRunBtn.type = "button";
    dreamRunBtn.className = "btn btn-ghost btn-sm";
    dreamRunBtn.style.fontSize = "0.78rem";
    dreamRunBtn.style.padding = "0.2rem 0.6rem";
    dreamRunBtn.style.marginTop = "0.35rem";
    dreamRunBtn.textContent = "Run Now";
    dreamRunBtn.addEventListener("click", async () => {
      dreamRunBtn.disabled = true;
      dreamRunBtn.textContent = "Running…";
      try {
        await triggerOrchestratorRun("dreamPipeline");
        log("info", "Triggered dream pipeline run");
        refresh();
      } catch (e) {
        log("error", "Error triggering dream pipeline", String(e));
      } finally {
        dreamRunBtn.disabled = false;
        dreamRunBtn.textContent = "Run Now";
      }
    });
    dreamSection.appendChild(dreamRunBtn);
    contentEl.appendChild(dreamSection);
  }

  await refresh();

  // Poll every 30 seconds
  _pollInterval = setInterval(refresh, 30_000);

  // Clear poll on navigation — store ref so next render can clean up
  _stopPolling = () => {
    if (_pollInterval !== null) {
      clearInterval(_pollInterval);
      _pollInterval = null;
    }
    window.removeEventListener("hashchange", _stopPolling!);
    window.removeEventListener("popstate", _stopPolling!);
    _stopPolling = null;
  };
  window.addEventListener("hashchange", _stopPolling);
  window.addEventListener("popstate", _stopPolling);
}
