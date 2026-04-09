// Journal entries page — renders vault hot-layer data via marked (trusted content)
import { getHotEntries, deleteHotEntry } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { escapeHtml } from "../lib/utils.js";
import { confirmDialog } from "../lib/dialog.js";
import { log } from "../lib/logger.js";

function nav(page: string) { (window as any).__navigate(page); }

export async function renderJournals(container: HTMLElement): Promise<void> {
  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";

  const backBtn = document.createElement("button");
  backBtn.className = "btn-back";
  backBtn.textContent = " Dashboard";
  const backSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  backSvg.setAttribute("width", "16");
  backSvg.setAttribute("height", "16");
  backSvg.setAttribute("viewBox", "0 0 24 24");
  backSvg.setAttribute("fill", "none");
  backSvg.setAttribute("stroke", "currentColor");
  backSvg.setAttribute("stroke-width", "2");
  const chevron = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
  chevron.setAttribute("points", "15 18 9 12 15 6");
  backSvg.appendChild(chevron);
  backBtn.prepend(backSvg);
  backBtn.addEventListener("click", () => nav("dashboard"));

  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Journals";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Chronological activity entries from agents and skills";

  pageHeader.appendChild(backBtn);
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  const listEl = document.createElement("div");
  listEl.id = "journal-entries";

  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(listEl);

  await loadEntries(listEl);
}

async function loadEntries(listEl: HTMLElement): Promise<void> {
  listEl.textContent = "";

  try {
    const entries = await getHotEntries();

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      const p = document.createElement("p");
      p.textContent = "No journal entries yet. Activity will appear here when agents report via the MCP tools.";
      empty.appendChild(p);
      listEl.appendChild(empty);
      return;
    }

    for (const entry of entries) {
      const card = document.createElement("div");
      card.className = "journal-entry";
      card.style.position = "relative";

      // Header
      const header = document.createElement("div");
      header.className = "journal-entry-header";

      const time = document.createElement("span");
      time.className = "journal-entry-time";
      time.textContent = new Date(entry.timestamp).toLocaleString("en-GB", {
        day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      header.appendChild(time);

      if (entry.theme) {
        const theme = document.createElement("span");
        theme.className = "journal-entry-theme";
        theme.textContent = entry.theme;
        header.appendChild(theme);
      }
      if (entry.source) {
        const source = document.createElement("span");
        source.className = "journal-entry-source";
        source.textContent = entry.source;
        header.appendChild(source);
      }

      // Delete button
      const deleteBtn = document.createElement("button");
      deleteBtn.className = "journal-delete-btn";
      deleteBtn.title = "Delete entry";
      const trashSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      trashSvg.setAttribute("width", "13");
      trashSvg.setAttribute("height", "13");
      trashSvg.setAttribute("viewBox", "0 0 24 24");
      trashSvg.setAttribute("fill", "none");
      trashSvg.setAttribute("stroke", "currentColor");
      trashSvg.setAttribute("stroke-width", "2");
      const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
      poly.setAttribute("points", "3 6 5 6 21 6");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2");
      trashSvg.appendChild(poly);
      trashSvg.appendChild(path);
      deleteBtn.appendChild(trashSvg);
      deleteBtn.addEventListener("click", () => {
        confirmDialog("Delete this journal entry? This cannot be undone.", async () => {
          try {
            await deleteHotEntry(entry.id);
            log("info", "Journal entry deleted", entry.timestamp);
            card.remove();
          } catch (e: any) {
            log("error", "Failed to delete journal entry", String(e));
          }
        });
      });

      // Body (trusted vault content rendered via marked)
      const body = document.createElement("div");
      body.className = "journal-entry-body md-content";
      body.innerHTML = renderMarkdown(entry.log); // safe: vault content via marked

      card.appendChild(header);
      card.appendChild(deleteBtn);
      card.appendChild(body);
      listEl.appendChild(card);
    }
  } catch (e: any) {
    const err = document.createElement("div");
    err.className = "card";
    err.style.color = "var(--danger)";
    err.textContent = `Failed to load: ${e}`;
    listEl.appendChild(err);
  }
}
