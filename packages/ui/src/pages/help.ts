import { getVaultPath, getProjectPath } from "../lib/tauri-bridge.js";

export async function renderHelp(container: HTMLElement): Promise<void> {
  // Load real paths
  let vaultPath = "~/OpenPulseAI";
  let projectPath = "/path/to/OpenPulseAI";
  try {
    vaultPath = await getVaultPath();
  } catch { /* use default */ }
  try {
    projectPath = await getProjectPath();
  } catch { /* use default */ }

  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Help";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Getting started with OpenPulse";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  const content = document.createElement("div");
  content.className = "help-content";

  const sections = [
    {
      title: "What is OpenPulse?",
      body: `OpenPulse is your Digital Twin proxy. AI agents report activity into your vault, skills pull data from external sources on schedules, and an LLM synthesizes everything into curated summaries. Stakeholders can query your proxy without interrupting you.`,
    },
    {
      title: "Connect Claude Desktop",
      body: `Go to Settings → Connections and click "Connect" next to Claude Desktop. This automatically adds OpenPulse as a local MCP server. Restart Claude Desktop to pick up the change.`,
      after: `If the automatic setup doesn't work, manually add this to the Claude Desktop config file:\n• macOS: ~/Library/Application Support/Claude/claude_desktop_config.json\n• Windows: %APPDATA%\\Claude\\claude_desktop_config.json\n• Linux: ~/.config/Claude/claude_desktop_config.json`,
      code: JSON.stringify({
        mcpServers: {
          openpulse: {
            command: "node",
            args: [`${projectPath}/packages/mcp-server/dist/index.js`],
          },
        },
      }, null, 2),
    },
    {
      title: "Connect Claude Code",
      body: `Add to your .claude/settings.json or project CLAUDE.md:`,
      code: JSON.stringify({
        mcpServers: {
          openpulse: {
            command: "node",
            args: [`${projectPath}/packages/mcp-server/dist/index.js`],
          },
        },
      }, null, 2),
    },
    {
      title: "MCP Tools Available",
      items: [
        ["record_activity", "Log what you just did. Accepts a log message and optional theme."],
        ["ingest_document", "Ingest a markdown document for thematic processing."],
        ["query_memory", "Query your vault for status summaries."],
        ["submit_update", "Push a status update into your journals."],
        ["chat_with_pulse", "Have a conversation about your recorded activities. Requires an LLM provider configured in Settings."],
      ],
    },
    {
      title: "Vault Structure",
      items: [
        [`Journals (${vaultPath}/vault/hot/)`, "Daily activity entries. One file per day."],
        [`Themes (${vaultPath}/vault/warm/)`, "Curated summaries by topic, approved by you."],
        [`Pending (${vaultPath}/vault/warm/_pending/)`, "AI-generated summaries awaiting your review."],
        [`Archive (${vaultPath}/vault/cold/)`, "Monthly archives of processed journals."],
        [`Logs (${vaultPath}/vault/logs/)`, "Application logs for debugging."],
      ],
    },
    {
      title: "Skills",
      body: `Skills are SKILL.md files that pull data from external sources on a schedule. Three are bundled: Google Daily Digest, GitHub Activity, and Weekly Rollup. Install more from the Skills page or create your own.`,
    },
    {
      title: "Dream Pipeline",
      body: `The Dream Pipeline reads your journal entries, classifies them by theme, and synthesizes curated summaries. Run it from the Dashboard page. Proposed summaries appear on the Review page for your approval before becoming themes.`,
    },
  ];

  for (const section of sections) {
    const card = document.createElement("div");
    card.className = "card help-section";

    const h3 = document.createElement("h3");
    h3.textContent = section.title;
    card.appendChild(h3);

    if (section.body) {
      const p = document.createElement("p");
      p.className = "help-text";
      p.textContent = section.body;
      card.appendChild(p);
    }

    if (section.code) {
      const wrapper = document.createElement("div");
      wrapper.className = "help-code-wrapper";
      const pre = document.createElement("pre");
      pre.className = "help-code";
      const code = document.createElement("code");
      code.textContent = section.code;
      pre.appendChild(code);
      const copyBtn = document.createElement("button");
      copyBtn.className = "help-copy-btn";
      copyBtn.textContent = "Copy";
      copyBtn.addEventListener("click", async () => {
        await navigator.clipboard.writeText(section.code!);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      });
      wrapper.appendChild(pre);
      wrapper.appendChild(copyBtn);
      card.appendChild(wrapper);
    }

    if (section.after) {
      const p = document.createElement("p");
      p.className = "help-text";
      p.textContent = section.after;
      card.appendChild(p);
    }

    if (section.items) {
      const dl = document.createElement("dl");
      dl.className = "help-list";
      for (const [term, desc] of section.items) {
        const dt = document.createElement("dt");
        dt.textContent = term;
        const dd = document.createElement("dd");
        dd.textContent = desc;
        dl.appendChild(dt);
        dl.appendChild(dd);
      }
      card.appendChild(dl);
    }

    content.appendChild(card);
  }

  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(content);
}

