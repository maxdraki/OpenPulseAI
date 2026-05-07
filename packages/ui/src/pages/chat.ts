// Chat — in-app conversational interface backed by handleChatWithPulse.
// All innerHTML usage is either static SVG constants or vault content
// rendered through the marked library (trusted, HTML-escaped).
import {
  chatSendMessage,
  getWarmThemes,
  listChatSessions,
  getChatSession,
  deleteChatSession,
  type ChatSessionMeta,
  type ChatSessionFull,
} from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { confirmDialog } from "../lib/dialog.js";
import { log } from "../lib/logger.js";

const NEW_CHAT_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>' +
  '<line x1="12" y1="8" x2="12" y2="14"/>' +
  '<line x1="9" y1="11" x2="15" y2="11"/>' +
  '</svg>';

const SEND_ICON =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<line x1="22" y1="2" x2="11" y2="13"/>' +
  '<polygon points="22 2 15 22 11 13 2 9 22 2"/>' +
  '</svg>';

const DELETE_ICON =
  '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
  '<polyline points="3 6 5 6 21 6"/>' +
  '<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>' +
  '<path d="M10 11v6"/><path d="M14 11v6"/>' +
  '</svg>';

/** Read the active session id from the URL hash (#chat/<id>). */
function activeSessionFromHash(): string | undefined {
  const m = location.hash.match(/^#chat\/([0-9a-f-]{36})$/i);
  return m ? m[1] : undefined;
}

function setActiveSession(id: string | undefined): void {
  history.replaceState(null, "", id ? `#chat/${id}` : "#chat");
}

/** Render a relative timestamp like "5m", "2h", "3d", "12 May". */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const now = Date.now();
  const seconds = Math.max(0, (now - then) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h`;
  if (seconds < 86_400 * 7) return `${Math.floor(seconds / 86_400)}d`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export async function renderChat(container: HTMLElement): Promise<void> {
  // Page header (title + new-chat sits on the right)
  const header = document.createElement("div");
  header.className = "page-header";

  const titleBlock = document.createElement("div");
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Chat";
  const sub = document.createElement("p");
  sub.className = "page-subtitle";
  sub.textContent = "Ask anything about your vault";
  titleBlock.appendChild(h2);
  titleBlock.appendChild(sub);
  header.appendChild(titleBlock);

  // Two-column shell: sessions list (left) + active chat (right)
  const shell = document.createElement("div");
  shell.className = "chat-shell";

  const sidebar = document.createElement("div");
  sidebar.className = "chat-sidebar";

  const newChatBtn = document.createElement("button");
  newChatBtn.className = "btn btn-ghost btn-sm chat-new-btn";
  newChatBtn.title = "Start a new chat";
  newChatBtn.setAttribute("aria-label", "Start a new chat");
  const newChatIconSpan = document.createElement("span");
  newChatIconSpan.style.display = "inline-flex";
  newChatIconSpan.innerHTML = NEW_CHAT_ICON;
  const newChatLabel = document.createElement("span");
  newChatLabel.textContent = "New chat";
  newChatBtn.appendChild(newChatIconSpan);
  newChatBtn.appendChild(newChatLabel);
  sidebar.appendChild(newChatBtn);

  const sessionList = document.createElement("div");
  sessionList.className = "chat-session-list";
  sidebar.appendChild(sessionList);

  // Right pane (chat surface)
  const chatPage = document.createElement("div");
  chatPage.className = "chat-page";

  const messagesEl = document.createElement("div");
  messagesEl.className = "chat-messages";
  messagesEl.setAttribute("role", "log");
  messagesEl.setAttribute("aria-live", "polite");

  const emptyState = document.createElement("div");
  emptyState.className = "chat-empty";
  emptyState.textContent =
    "Ask anything about your vault — I'll consult the wiki themes and answer.";
  messagesEl.appendChild(emptyState);

  const inputRow = document.createElement("div");
  inputRow.className = "chat-input-row";

  const textarea = document.createElement("textarea");
  textarea.className = "chat-textarea form-input";
  textarea.rows = 2;
  textarea.placeholder = "Ask about your vault…";
  textarea.setAttribute("aria-label", "Message");

  const sendBtn = document.createElement("button");
  sendBtn.className = "btn btn-primary";
  sendBtn.title = "Send (Enter)";
  sendBtn.setAttribute("aria-label", "Send message");
  const sendIconSpan = document.createElement("span");
  sendIconSpan.style.display = "inline-flex";
  sendIconSpan.innerHTML = SEND_ICON;
  const sendLabel = document.createElement("span");
  sendLabel.textContent = "Send";
  sendBtn.appendChild(sendIconSpan);
  sendBtn.appendChild(sendLabel);

  inputRow.appendChild(textarea);
  inputRow.appendChild(sendBtn);

  chatPage.appendChild(messagesEl);
  chatPage.appendChild(inputRow);

  shell.appendChild(sidebar);
  shell.appendChild(chatPage);

  container.textContent = "";
  container.appendChild(header);
  container.appendChild(shell);

  // ── State ──
  let knownThemes: Set<string> = new Set();
  let activeSessionId: string | undefined = activeSessionFromHash();
  void loadKnownThemes().then((s) => { knownThemes = s; });

  function showEmptyState(): void {
    messagesEl.textContent = "";
    messagesEl.appendChild(emptyState);
  }

  function appendBubble(kind: "user" | "assistant" | "error", text: string): HTMLElement {
    if (emptyState.parentElement) emptyState.remove();
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${kind}`;
    if (kind === "assistant") {
      bubble.innerHTML = renderMarkdown(text, knownThemes);
      bubble.classList.add("md-content");
    } else {
      bubble.textContent = text;
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }

  function renderMessages(messages: ChatSessionFull["messages"]): void {
    messagesEl.textContent = "";
    if (messages.length === 0) {
      messagesEl.appendChild(emptyState);
      return;
    }
    for (const m of messages) {
      const bubble = document.createElement("div");
      bubble.className = `chat-bubble chat-bubble-${m.role === "user" ? "user" : "assistant"}`;
      if (m.role === "assistant") {
        bubble.innerHTML = renderMarkdown(m.content, knownThemes);
        bubble.classList.add("md-content");
      } else {
        bubble.textContent = m.content;
      }
      messagesEl.appendChild(bubble);
    }
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  async function refreshSessionList(): Promise<void> {
    let sessions: ChatSessionMeta[] = [];
    try {
      sessions = await listChatSessions();
    } catch (err) {
      log("warn", "Failed to load chat sessions", err instanceof Error ? err.message : String(err));
    }

    sessionList.textContent = "";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-session-empty";
      empty.textContent = "No conversations yet.";
      sessionList.appendChild(empty);
      return;
    }

    for (const s of sessions) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "chat-session-row";
      if (s.id === activeSessionId) row.classList.add("active");

      const titleEl = document.createElement("div");
      titleEl.className = "chat-session-title";
      titleEl.textContent = s.title;
      row.appendChild(titleEl);

      const metaEl = document.createElement("div");
      metaEl.className = "chat-session-meta";
      metaEl.textContent = `${relativeTime(s.lastActivity)} · ${s.messageCount} msg${s.messageCount === 1 ? "" : "s"}`;
      row.appendChild(metaEl);

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "chat-session-delete";
      delBtn.title = "Delete this conversation";
      delBtn.setAttribute("aria-label", `Delete conversation: ${s.title}`);
      delBtn.innerHTML = DELETE_ICON;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        confirmDialog(`Delete "${s.title}"? This can't be undone.`, async () => {
          try {
            await deleteChatSession(s.id);
            if (activeSessionId === s.id) {
              activeSessionId = undefined;
              setActiveSession(undefined);
              showEmptyState();
            }
            await refreshSessionList();
          } catch (err) {
            log("error", "Failed to delete chat session", err instanceof Error ? err.message : String(err));
          }
        });
      });
      row.appendChild(delBtn);

      row.addEventListener("click", () => { void selectSession(s.id); });
      sessionList.appendChild(row);
    }
  }

  async function selectSession(id: string): Promise<void> {
    activeSessionId = id;
    setActiveSession(id);
    try {
      const session = await getChatSession(id);
      renderMessages(session.messages);
    } catch (err) {
      log("error", "Failed to load chat session", err instanceof Error ? err.message : String(err));
      showEmptyState();
    }
    // Update active highlight in sidebar
    sessionList.querySelectorAll<HTMLElement>(".chat-session-row").forEach((el) => el.classList.remove("active"));
    // Re-render so the row layout matches; cheap.
    void refreshSessionList();
  }

  async function send(): Promise<void> {
    const text = textarea.value.trim();
    if (!text) return;
    if (text.length > 8000) {
      appendBubble("error", "Message too long (max 8000 chars). Try splitting it up.");
      return;
    }

    sendBtn.disabled = true;
    textarea.disabled = true;
    const previousText = textarea.value;
    textarea.value = "";

    appendBubble("user", text);
    const pending = appendBubble("assistant", "_…_");
    pending.classList.add("chat-bubble-pending");

    try {
      const result = await chatSendMessage(text, activeSessionId);
      activeSessionId = result.sessionId;
      setActiveSession(result.sessionId);
      pending.classList.remove("chat-bubble-pending");
      pending.innerHTML = renderMarkdown(result.content, knownThemes);
      pending.classList.add("md-content");
      messagesEl.scrollTop = messagesEl.scrollHeight;
      // Refresh sidebar so the active session moves to the top + title updates.
      void refreshSessionList();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "Chat send failed", msg);
      pending.remove();
      appendBubble("error", `Couldn't reach the chat service: ${msg}`);
      textarea.value = previousText;
    } finally {
      sendBtn.disabled = false;
      textarea.disabled = false;
      textarea.focus();
    }
  }

  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  sendBtn.addEventListener("click", () => { void send(); });

  newChatBtn.addEventListener("click", () => {
    activeSessionId = undefined;
    setActiveSession(undefined);
    showEmptyState();
    textarea.value = "";
    textarea.focus();
    void loadKnownThemes().then((s) => { knownThemes = s; });
    void refreshSessionList();
  });

  // Initial load
  if (activeSessionId) {
    await selectSession(activeSessionId);
  }
  await refreshSessionList();
  textarea.focus();
}

async function loadKnownThemes(): Promise<Set<string>> {
  try {
    const themes = await getWarmThemes();
    return new Set(themes.map((t) => t.theme));
  } catch {
    return new Set();
  }
}
