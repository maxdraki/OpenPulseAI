// Chat — in-app conversational interface backed by handleChatWithPulse.
// All innerHTML usage is either static SVG constants or vault content
// rendered through the marked library (trusted, HTML-escaped).
import { chatSendMessage, getWarmThemes } from "../lib/tauri-bridge.js";
import { renderMarkdown } from "../lib/markdown.js";
import { log } from "../lib/logger.js";

const SESSION_KEY = "openpulse.chat.sessionId";

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

export async function renderChat(container: HTMLElement): Promise<void> {
  // Page header
  const header = document.createElement("div");
  header.className = "page-header";
  header.style.display = "flex";
  header.style.justifyContent = "space-between";
  header.style.alignItems = "flex-start";
  header.style.gap = "1rem";

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

  const newChatBtn = document.createElement("button");
  newChatBtn.className = "btn btn-ghost btn-sm";
  newChatBtn.title = "Start a new chat";
  newChatBtn.setAttribute("aria-label", "Start a new chat");
  const newChatIconSpan = document.createElement("span");
  newChatIconSpan.style.display = "inline-flex";
  newChatIconSpan.innerHTML = NEW_CHAT_ICON; // static SVG constant
  const newChatLabel = document.createElement("span");
  newChatLabel.textContent = "New chat";
  newChatBtn.appendChild(newChatIconSpan);
  newChatBtn.appendChild(newChatLabel);
  newChatBtn.style.alignSelf = "center";
  header.appendChild(newChatBtn);

  // Chat surface
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
  sendIconSpan.innerHTML = SEND_ICON; // static SVG constant
  const sendLabel = document.createElement("span");
  sendLabel.textContent = "Send";
  sendBtn.appendChild(sendIconSpan);
  sendBtn.appendChild(sendLabel);

  inputRow.appendChild(textarea);
  inputRow.appendChild(sendBtn);

  chatPage.appendChild(messagesEl);
  chatPage.appendChild(inputRow);

  container.textContent = "";
  container.appendChild(header);
  container.appendChild(chatPage);

  // Lazy-load known themes for wiki-link rewriting in assistant responses.
  let knownThemes: Set<string> = new Set();
  void loadKnownThemes().then((s) => { knownThemes = s; });

  function appendBubble(kind: "user" | "assistant" | "error", text: string): HTMLElement {
    if (emptyState.parentElement) emptyState.remove();
    const bubble = document.createElement("div");
    bubble.className = `chat-bubble chat-bubble-${kind}`;
    if (kind === "assistant") {
      // marked output of trusted vault content; renderMarkdown HTML-escapes user-supplied bits
      bubble.innerHTML = renderMarkdown(text, knownThemes);
      bubble.classList.add("md-content");
    } else {
      // user input + error strings — plain text
      bubble.textContent = text;
    }
    messagesEl.appendChild(bubble);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
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

    // Pending placeholder — replaced when the response arrives.
    const pending = appendBubble("assistant", "_…_");
    pending.classList.add("chat-bubble-pending");

    try {
      const sessionId = sessionStorage.getItem(SESSION_KEY) ?? undefined;
      const result = await chatSendMessage(text, sessionId);
      sessionStorage.setItem(SESSION_KEY, result.sessionId);
      pending.classList.remove("chat-bubble-pending");
      pending.innerHTML = renderMarkdown(result.content, knownThemes);
      pending.classList.add("md-content");
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log("error", "Chat send failed", msg);
      pending.remove();
      appendBubble("error", `Couldn't reach the chat service: ${msg}`);
      // Restore the user's input so they can retry without re-typing.
      textarea.value = previousText;
    } finally {
      sendBtn.disabled = false;
      textarea.disabled = false;
      textarea.focus();
    }
  }

  // Enter sends; Shift+Enter inserts newline.
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  });

  sendBtn.addEventListener("click", () => { void send(); });

  newChatBtn.addEventListener("click", () => {
    sessionStorage.removeItem(SESSION_KEY);
    messagesEl.textContent = "";
    messagesEl.appendChild(emptyState);
    textarea.value = "";
    textarea.focus();
    // Refresh themes in case the vault changed since page mount.
    void loadKnownThemes().then((s) => { knownThemes = s; });
  });

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
