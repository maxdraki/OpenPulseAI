# Connector & Proxy System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add MCP-native source connectors that pull data from external services (Gmail, Calendar, GitHub, any MCP server) on configurable schedules, plus multi-turn chat and update submission tools — turning OpenPulse into a queryable Digital Twin.

**Architecture:** New `@openpulse/collector` package acts as MCP client, connecting to registered Source MCPs via stdio. Template-driven collection for known sources, LLM-driven auto-discovery for unknown ones. Two new outbound MCP tools (`chat_with_pulse`, `submit_update`). UI Sources page for managing source configs.

**Tech Stack:** `@modelcontextprotocol/sdk` (client + server), `cron-parser`, existing `@openpulse/core` LLM provider abstraction, Vitest

---

## File Structure (New/Modified)

```
packages/
├── core/src/
│   ├── types.ts                    # MODIFY: add SourceConfig, CollectorState, ChatSession
│   ├── config.ts                   # MODIFY: parse sources[] from YAML
│   ├── vault.ts                    # MODIFY: add sessionsDir
│   └── index.ts                    # MODIFY: export new types
├── mcp-server/src/
│   ├── server.ts                   # MODIFY: register 2 new tools, accept optional provider
│   └── tools/
│       ├── submit-update.ts        # CREATE: push updates into hot
│       ├── chat-with-pulse.ts      # CREATE: multi-turn conversation
│       └── chat-session.ts         # CREATE: session persistence helpers
├── collector/                      # CREATE: entire package
│   ├── package.json
│   ├── tsconfig.json
│   ├── vitest.config.ts
│   ├── src/
│   │   ├── index.ts                # CLI entry point
│   │   ├── mcp-client.ts           # MCP client wrapper
│   │   ├── scheduler.ts            # isDue() + state persistence
│   │   ├── orchestrator.ts         # collect a single source end-to-end
│   │   ├── auto-discover.ts        # LLM-driven tool discovery
│   │   └── templates/
│   │       ├── types.ts            # CollectionTemplate interface
│   │       ├── registry.ts         # template lookup
│   │       ├── gmail.ts
│   │       ├── google-calendar.ts
│   │       └── github.ts
│   └── test/
│       ├── mcp-client.test.ts
│       ├── scheduler.test.ts
│       ├── orchestrator.test.ts
│       ├── auto-discover.test.ts
│       └── templates/
│           ├── gmail.test.ts
│           └── registry.test.ts
└── ui/
    ├── server.ts                   # MODIFY: add source CRUD + test + collect endpoints
    ├── src/
    │   ├── main.ts                 # MODIFY: add sources page route
    │   ├── lib/tauri-bridge.ts     # MODIFY: add source API functions
    │   └── pages/sources.ts        # CREATE: Sources management page
    ├── index.html                  # MODIFY: add Sources nav item
    └── src/styles.css              # MODIFY: add source card styles
```

---

## Phase 1: Core Types & Config

### Task 1: Extend Core Types, Config, and Vault

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/vault.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/test/config.test.ts`
- Modify: `packages/core/test/vault.test.ts`

- [ ] **Step 1: Add new types to types.ts**

Add these after the existing `PendingUpdate` interface:

```typescript
/** MCP source server configuration */
export interface SourceConfig {
  name: string;
  command: string;
  args: string[];
  schedule: string;       // cron expression (5-field)
  lookback: string;       // duration: "1h", "24h", "1w", "30d"
  template?: string;      // known template name or undefined for LLM auto-discovery
  enabled: boolean;
  env?: Record<string, string>;
}

/** Collector runtime state per source */
export interface CollectorState {
  sourceName: string;
  lastRunAt: string | null; // ISO 8601
  lastStatus: "success" | "error" | "never";
  lastError?: string;
  entriesCollected: number;
}

/** Multi-turn chat session */
export interface ChatSession {
  id: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  themesConsulted: string[];
  createdAt: string;      // ISO 8601
  lastActivity: string;   // ISO 8601
}
```

- [ ] **Step 2: Extend OpenPulseConfig**

Add `sources` field to `OpenPulseConfig`:

```typescript
export interface OpenPulseConfig {
  vaultPath: string;
  themes: string[];
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string;
  };
  sources: SourceConfig[];  // NEW
}
```

- [ ] **Step 3: Update config.ts to parse sources**

Update `DEFAULT_CONFIG` to include `sources: []`. Update `loadConfig` to parse the `sources` array from YAML:

```typescript
export const DEFAULT_CONFIG: OpenPulseConfig = {
  vaultPath: "",
  themes: [],
  llm: {
    provider: "anthropic",
    model: "claude-sonnet-4-5-20250929",
  },
  sources: [],
};

export async function loadConfig(rootDir: string): Promise<OpenPulseConfig> {
  const configPath = join(rootDir, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const parsed = parse(raw);
    const provider = VALID_PROVIDERS.includes(parsed?.llm?.provider)
      ? parsed.llm.provider
      : "anthropic";

    const sources: SourceConfig[] = (parsed?.sources ?? [])
      .filter((s: any) => s?.name && s?.command)
      .map((s: any) => ({
        name: s.name,
        command: s.command,
        args: s.args ?? [],
        schedule: s.schedule ?? "0 23 * * *",
        lookback: s.lookback ?? "24h",
        template: s.template ?? undefined,
        enabled: s.enabled ?? true,
        env: s.env ?? {},
      }));

    return {
      vaultPath: rootDir,
      themes: parsed?.themes ?? [],
      llm: {
        provider,
        model: parsed?.llm?.model ?? DEFAULT_CONFIG.llm.model,
        apiKey: parsed?.llm?.apiKey,
      },
      sources,
    };
  } catch {
    return { ...DEFAULT_CONFIG, vaultPath: rootDir };
  }
}
```

- [ ] **Step 4: Add sessionsDir to Vault**

In `packages/core/src/vault.ts`, add:

```typescript
readonly sessionsDir: string;

// In constructor:
this.sessionsDir = join(root, "vault", "sessions");

// In init():
await mkdir(this.sessionsDir, { recursive: true });
```

- [ ] **Step 5: Update barrel export**

Add to `packages/core/src/index.ts`:

```typescript
export type {
  // ... existing exports ...
  SourceConfig,
  CollectorState,
  ChatSession,
} from "./types.js";
```

- [ ] **Step 6: Write config tests**

Add to `packages/core/test/config.test.ts`:

```typescript
it("parses sources from config.yaml", async () => {
  await writeFile(
    join(tempDir, "config.yaml"),
    `sources:\n  - name: gmail\n    command: npx\n    args: ["-y", "gmail-mcp"]\n    schedule: "0 23 * * *"\n    lookback: 24h\n    template: gmail\n`,
    "utf-8"
  );
  const config = await loadConfig(tempDir);
  expect(config.sources).toHaveLength(1);
  expect(config.sources[0].name).toBe("gmail");
  expect(config.sources[0].enabled).toBe(true);
});

it("defaults enabled to true and args to empty", async () => {
  await writeFile(
    join(tempDir, "config.yaml"),
    `sources:\n  - name: test\n    command: node\n`,
    "utf-8"
  );
  const config = await loadConfig(tempDir);
  expect(config.sources[0].enabled).toBe(true);
  expect(config.sources[0].args).toEqual([]);
});

it("skips invalid source entries missing name", async () => {
  await writeFile(
    join(tempDir, "config.yaml"),
    `sources:\n  - command: node\n  - name: valid\n    command: node\n`,
    "utf-8"
  );
  const config = await loadConfig(tempDir);
  expect(config.sources).toHaveLength(1);
  expect(config.sources[0].name).toBe("valid");
});

it("returns empty sources when section missing", async () => {
  await writeFile(join(tempDir, "config.yaml"), `llm:\n  provider: anthropic\n`, "utf-8");
  const config = await loadConfig(tempDir);
  expect(config.sources).toEqual([]);
});
```

- [ ] **Step 7: Write vault test for sessionsDir**

Add to `packages/core/test/vault.test.ts`:

```typescript
it("creates sessions directory on init", async () => {
  const vault = new Vault(tempDir);
  await vault.init();
  const { stat } = await import("node:fs/promises");
  expect((await stat(vault.sessionsDir)).isDirectory()).toBe(true);
});

it("sessionsDir returns correct path", () => {
  const vault = new Vault("/tmp/test-vault");
  expect(vault.sessionsDir).toBe("/tmp/test-vault/vault/sessions");
});
```

- [ ] **Step 8: Run all core tests**

Run: `pnpm vitest run packages/core/`
Expected: All tests pass (existing + new)

- [ ] **Step 9: Commit**

```bash
git add packages/core/
git commit -m "feat(core): add SourceConfig, CollectorState, ChatSession types; parse sources from config; add sessionsDir to Vault"
```

---

## Phase 2: New MCP Tools

### Task 2: `submit_update` MCP Tool

**Files:**
- Create: `packages/mcp-server/src/tools/submit-update.ts`
- Create: `packages/mcp-server/test/submit-update.test.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Write failing test**

```typescript
// packages/mcp-server/test/submit-update.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { handleSubmitUpdate } from "../src/tools/submit-update.js";

describe("submit_update tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-submit-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("writes entry to hot log with source field", async () => {
    const result = await handleSubmitUpdate(vault, {
      content: "Deploy completed successfully",
      source: "slack-bot",
      theme: "infrastructure",
    });
    expect(result.content[0].text).toContain("Recorded");
    const today = new Date().toISOString().slice(0, 10);
    const log = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(log).toContain("Deploy completed successfully");
    expect(log).toContain("slack-bot");
    expect(log).toContain("infrastructure");
  });

  it("works without theme", async () => {
    const result = await handleSubmitUpdate(vault, {
      content: "Quick status update",
      source: "teams-bot",
    });
    expect(result.content[0].text).toContain("Recorded");
  });
});
```

- [ ] **Step 2: Run test, verify fail**

- [ ] **Step 3: Implement handler**

```typescript
// packages/mcp-server/src/tools/submit-update.ts
import { appendActivity, type Vault } from "@openpulse/core";

export interface SubmitUpdateInput {
  content: string;
  source: string;
  theme?: string;
}

export async function handleSubmitUpdate(
  vault: Vault,
  input: SubmitUpdateInput
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const timestamp = new Date().toISOString();
  await appendActivity(vault, {
    timestamp,
    log: input.content,
    source: input.source,
    theme: input.theme,
  });
  const date = timestamp.slice(0, 10);
  return {
    content: [
      {
        type: "text" as const,
        text: `Recorded update from ${input.source} to ${date} log.${input.theme ? ` Theme: ${input.theme}` : ""}`,
      },
    ],
  };
}
```

- [ ] **Step 4: Register in server.ts**

Import `handleSubmitUpdate` and add:

```typescript
server.tool(
  "submit_update",
  "Push a Markdown status update into the OpenPulse hot layer from an external source.",
  { content: z.string(), source: z.string(), theme: z.string().optional() },
  async (input) => handleSubmitUpdate(vault, input)
);
```

- [ ] **Step 5: Run tests, verify pass**
- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat(mcp): add submit_update tool for external status pushes"
```

---

### Task 3: `chat_with_pulse` MCP Tool + Session Management

**Files:**
- Create: `packages/mcp-server/src/tools/chat-session.ts`
- Create: `packages/mcp-server/src/tools/chat-with-pulse.ts`
- Create: `packages/mcp-server/test/chat-session.test.ts`
- Create: `packages/mcp-server/test/chat-with-pulse.test.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: Write session persistence tests**

```typescript
// packages/mcp-server/test/chat-session.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { createNewSession, saveSession, loadSession } from "../src/tools/chat-session.js";

describe("Chat Session", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-session-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates a new session with UUID", () => {
    const session = createNewSession();
    expect(session.id).toBeTruthy();
    expect(session.messages).toEqual([]);
    expect(session.themesConsulted).toEqual([]);
  });

  it("saves and loads session round-trip", async () => {
    const session = createNewSession();
    session.messages.push({ role: "user", content: "Hello" });
    await saveSession(vault, session);
    const loaded = await loadSession(vault, session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(session.id);
    expect(loaded!.messages).toHaveLength(1);
  });

  it("returns null for non-existent session", async () => {
    const loaded = await loadSession(vault, "nonexistent-id");
    expect(loaded).toBeNull();
  });
});
```

- [ ] **Step 2: Implement session persistence**

```typescript
// packages/mcp-server/src/tools/chat-session.ts
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Vault, ChatSession } from "@openpulse/core";

export function createNewSession(): ChatSession {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    messages: [],
    themesConsulted: [],
    createdAt: now,
    lastActivity: now,
  };
}

export async function saveSession(vault: Vault, session: ChatSession): Promise<void> {
  session.lastActivity = new Date().toISOString();
  const path = join(vault.sessionsDir, `${session.id}.json`);
  await writeFile(path, JSON.stringify(session, null, 2), "utf-8");
}

export async function loadSession(vault: Vault, sessionId: string): Promise<ChatSession | null> {
  try {
    const path = join(vault.sessionsDir, `${sessionId}.json`);
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as ChatSession;
  } catch {
    return null;
  }
}
```

- [ ] **Step 3: Run session tests, verify pass**

- [ ] **Step 4: Write chat_with_pulse tests (mocked LLM)**

```typescript
// packages/mcp-server/test/chat-with-pulse.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import type { LlmProvider } from "@openpulse/core";
import { handleChatWithPulse } from "../src/tools/chat-with-pulse.js";

function mockProvider(response: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

describe("chat_with_pulse tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-chat-"));
    vault = new Vault(tempDir);
    await vault.init();
    await writeTheme(vault, "project-auth", "Login page refactored. JWT implemented.");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("creates new session and returns response with sessionId", async () => {
    const provider = mockProvider("The auth project is on track.");
    const result = await handleChatWithPulse(vault, provider, "test-model", {
      message: "What's the auth status?",
    });
    expect(result.content[0].text).toContain("The auth project is on track.");
    expect(result.sessionId).toBeTruthy();
  });

  it("continues existing session", async () => {
    const provider = mockProvider("First response.");
    const r1 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "Hello",
    });

    (provider.complete as any).mockResolvedValue("Follow-up response.");
    const r2 = await handleChatWithPulse(vault, provider, "test-model", {
      message: "Tell me more",
      sessionId: r1.sessionId,
    });
    expect(r2.content[0].text).toContain("Follow-up response.");
    expect(r2.sessionId).toBe(r1.sessionId);
  });

  it("includes warm theme context in LLM prompt", async () => {
    const provider = mockProvider("Answer.");
    await handleChatWithPulse(vault, provider, "test-model", {
      message: "auth status",
    });
    const callArgs = (provider.complete as any).mock.calls[0][0];
    expect(callArgs.prompt).toContain("Login page refactored");
  });
});
```

- [ ] **Step 5: Implement chat_with_pulse handler**

```typescript
// packages/mcp-server/src/tools/chat-with-pulse.ts
import type { Vault, LlmProvider } from "@openpulse/core";
import { readAllThemes } from "@openpulse/core";
import { createNewSession, loadSession, saveSession } from "./chat-session.js";
import { searchWarmFiles } from "../search.js";

export interface ChatWithPulseInput {
  message: string;
  sessionId?: string;
}

export interface ChatWithPulseResult {
  content: Array<{ type: "text"; text: string }>;
  sessionId: string;
}

export async function handleChatWithPulse(
  vault: Vault,
  provider: LlmProvider,
  model: string,
  input: ChatWithPulseInput
): Promise<ChatWithPulseResult> {
  // Load or create session
  let session = input.sessionId
    ? await loadSession(vault, input.sessionId)
    : null;
  if (!session) session = createNewSession();

  // Find relevant warm themes
  const relevantThemes = await searchWarmFiles(vault, input.message);
  const allThemes = relevantThemes.length > 0 ? relevantThemes : await readAllThemes(vault);
  session.themesConsulted = [...new Set([
    ...session.themesConsulted,
    ...allThemes.map((t) => t.theme),
  ])];

  // Build context from warm themes
  const context = allThemes
    .map((t) => `## ${t.theme}\n${t.content}`)
    .join("\n\n---\n\n");

  // Build conversation history
  const history = session.messages
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");

  // Add current message
  session.messages.push({ role: "user", content: input.message });

  const prompt = [
    history ? `Previous conversation:\n${history}\n\n` : "",
    `User: ${input.message}`,
  ].join("");

  const systemPrompt = `You are OpenPulse, a Digital Twin proxy. Answer questions based ONLY on the following curated knowledge. Be concise and accurate. If you don't have information about something, say so.\n\n${context}`;

  const response = await provider.complete({ model, prompt, systemPrompt });

  session.messages.push({ role: "assistant", content: response });
  await saveSession(vault, session);

  return {
    content: [{ type: "text" as const, text: response }],
    sessionId: session.id,
  };
}
```

- [ ] **Step 6: Update server.ts — accept optional provider, register new tools**

Modify `createServer` to accept an optional provider and register both new tools:

```typescript
import { loadConfig, createProvider, type LlmProvider } from "@openpulse/core";
import { handleSubmitUpdate } from "./tools/submit-update.js";
import { handleChatWithPulse } from "./tools/chat-with-pulse.js";

export async function createServer(vaultRoot: string, opts?: { provider?: LlmProvider }) {
  const vault = new Vault(vaultRoot);
  await vault.init();
  const config = await loadConfig(vaultRoot);

  let provider = opts?.provider ?? null;
  if (!provider) {
    try { provider = createProvider(config); } catch { /* no API key configured */ }
  }

  const server = new McpServer({ name: "openpulse", version: "0.1.0" });

  // ... existing tool registrations ...

  server.tool(
    "submit_update",
    "Push a Markdown status update into the OpenPulse hot layer.",
    { content: z.string(), source: z.string(), theme: z.string().optional() },
    async (input) => handleSubmitUpdate(vault, input)
  );

  if (provider) {
    server.tool(
      "chat_with_pulse",
      "Have a multi-turn conversation about recorded activities and knowledge.",
      { message: z.string(), sessionId: z.string().optional() },
      async (input) => handleChatWithPulse(vault, provider!, config.llm.model, input)
    );
  }

  return { server, vault };
}
```

- [ ] **Step 7: Run all mcp-server tests, verify pass**
- [ ] **Step 8: Commit**

```bash
git add packages/mcp-server/
git commit -m "feat(mcp): add chat_with_pulse and submit_update tools with session management"
```

---

## Phase 3: Collector Package

### Task 4: Scaffold `@openpulse/collector`

**Files:**
- Create: `packages/collector/package.json`
- Create: `packages/collector/tsconfig.json`
- Create: `packages/collector/vitest.config.ts`
- Create: `packages/collector/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@openpulse/collector",
  "version": "0.1.0",
  "type": "module",
  "main": "dist/index.js",
  "bin": { "openpulse-collect": "dist/index.js" },
  "scripts": { "build": "tsc", "start": "node dist/index.js" },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.12.0",
    "@openpulse/core": "workspace:*",
    "cron-parser": "^5.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "vitest": "^3.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json, vitest.config.ts** (same pattern as other packages)

- [ ] **Step 3: Create minimal CLI entry point**

```typescript
// packages/collector/src/index.ts
#!/usr/bin/env node
import { loadConfig, Vault } from "@openpulse/core";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  const sources = config.sources.filter((s) => s.enabled);
  console.error(`[collector] Found ${sources.length} enabled source(s)`);

  if (sources.length === 0) {
    console.error("[collector] No sources configured. Add sources in config.yaml or the Control Center.");
    return;
  }

  // Orchestration added in Task 8
  for (const source of sources) {
    console.error(`[collector] Source: ${source.name} (${source.schedule})`);
  }
}

main().catch((e) => { console.error("[collector] Fatal:", e); process.exit(1); });
```

- [ ] **Step 4: Install deps, verify build**

```bash
pnpm install && pnpm --filter @openpulse/collector build
```

- [ ] **Step 5: Commit**

```bash
git add packages/collector/
git commit -m "chore: scaffold @openpulse/collector package"
```

---

### Task 5: MCP Client Wrapper

**Files:**
- Create: `packages/collector/src/mcp-client.ts`
- Create: `packages/collector/test/mcp-client.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/collector/test/mcp-client.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import { SourceMcpClient } from "../src/mcp-client.js";

describe("SourceMcpClient", () => {
  let mcpServer: McpServer;

  beforeEach(() => {
    mcpServer = new McpServer({ name: "test-source", version: "1.0.0" });
    mcpServer.tool("get_emails", "Get recent emails", { limit: z.number() }, async ({ limit }) => ({
      content: [{ type: "text" as const, text: JSON.stringify([{ subject: "Test", from: "alice@test.com" }]) }],
    }));
  });

  it("connects and lists tools", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new SourceMcpClient({ name: "test", command: "", args: [], schedule: "", lookback: "24h", enabled: true });
    await client.connectWithTransport(clientTransport);

    const tools = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("get_emails");

    await client.disconnect();
  });

  it("calls a tool and returns result", async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new SourceMcpClient({ name: "test", command: "", args: [], schedule: "", lookback: "24h", enabled: true });
    await client.connectWithTransport(clientTransport);

    const result = await client.callTool("get_emails", { limit: 10 });
    expect(result.content).toBeDefined();

    await client.disconnect();
  });
});
```

- [ ] **Step 2: Implement MCP client wrapper**

```typescript
// packages/collector/src/mcp-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { SourceConfig } from "@openpulse/core";

export class SourceMcpClient {
  private client: Client;
  private config: SourceConfig;
  private connected = false;

  constructor(config: SourceConfig) {
    this.config = config;
    this.client = new Client({ name: `openpulse-collector-${config.name}`, version: "1.0.0" });
  }

  /** Connect via stdio (production) — spawns the MCP server process */
  async connect(): Promise<void> {
    const transport = new StdioClientTransport({
      command: this.config.command,
      args: this.config.args,
      env: { ...process.env, ...(this.config.env ?? {}) } as Record<string, string>,
    });
    await this.client.connect(transport);
    this.connected = true;
  }

  /** Connect with injected transport (testing) */
  async connectWithTransport(transport: Transport): Promise<void> {
    await this.client.connect(transport);
    this.connected = true;
  }

  async listTools() {
    const result = await this.client.listTools();
    return result.tools;
  }

  async callTool(name: string, args: Record<string, unknown> = {}) {
    return this.client.callTool({ name, arguments: args });
  }

  async disconnect(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }
}
```

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git add packages/collector/
git commit -m "feat(collector): MCP client wrapper with stdio and in-memory transport support"
```

---

### Task 6: Collection Templates

**Files:**
- Create: `packages/collector/src/templates/types.ts`
- Create: `packages/collector/src/templates/gmail.ts`
- Create: `packages/collector/src/templates/google-calendar.ts`
- Create: `packages/collector/src/templates/github.ts`
- Create: `packages/collector/src/templates/registry.ts`
- Create: `packages/collector/test/templates/gmail.test.ts`
- Create: `packages/collector/test/templates/registry.test.ts`

- [ ] **Step 1: Define template interface**

```typescript
// packages/collector/src/templates/types.ts
import type { SourceMcpClient } from "../mcp-client.js";

export interface CollectedItem {
  log: string;
  theme?: string;
  timestamp?: string;
}

export interface CollectionTemplate {
  name: string;
  description: string;
  collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]>;
}

/** Parse lookback string like "24h", "1w", "30d" into milliseconds */
export function parseLookback(lookback: string): number {
  const match = lookback.match(/^(\d+)(h|d|w)$/);
  if (!match) return 24 * 60 * 60 * 1000; // default 24h
  const value = parseInt(match[1]);
  const unit = match[2];
  switch (unit) {
    case "h": return value * 60 * 60 * 1000;
    case "d": return value * 24 * 60 * 60 * 1000;
    case "w": return value * 7 * 24 * 60 * 60 * 1000;
    default: return 24 * 60 * 60 * 1000;
  }
}
```

- [ ] **Step 2: Implement Gmail template**

```typescript
// packages/collector/src/templates/gmail.ts
import type { CollectionTemplate, CollectedItem } from "./types.js";
import type { SourceMcpClient } from "../mcp-client.js";

export const gmailTemplate: CollectionTemplate = {
  name: "gmail",
  description: "Collect recent emails from Gmail MCP",
  async collect(client: SourceMcpClient, since: Date, until: Date): Promise<CollectedItem[]> {
    const sinceStr = since.toISOString().slice(0, 10);
    const untilStr = until.toISOString().slice(0, 10);

    const result = await client.callTool("search_emails", {
      query: `after:${sinceStr} before:${untilStr}`,
      max_results: 50,
    });

    const items: CollectedItem[] = [];
    for (const block of result.content) {
      if (block.type === "text") {
        try {
          const emails = JSON.parse(block.text);
          for (const email of Array.isArray(emails) ? emails : [emails]) {
            items.push({
              log: `Email from ${email.from || "unknown"}: ${email.subject || "no subject"}\n${email.snippet || email.body || ""}`.trim(),
              timestamp: email.date || email.received || undefined,
            });
          }
        } catch {
          items.push({ log: block.text });
        }
      }
    }
    return items;
  },
};
```

- [ ] **Step 3: Implement Calendar and GitHub templates** (similar pattern)

- [ ] **Step 4: Create registry**

```typescript
// packages/collector/src/templates/registry.ts
import type { CollectionTemplate } from "./types.js";
import { gmailTemplate } from "./gmail.js";
import { calendarTemplate } from "./google-calendar.js";
import { githubTemplate } from "./github.js";

const templates = new Map<string, CollectionTemplate>();
templates.set("gmail", gmailTemplate);
templates.set("google-calendar", calendarTemplate);
templates.set("github", githubTemplate);

export function getTemplate(name: string): CollectionTemplate | undefined {
  return templates.get(name);
}

export function listTemplates(): string[] {
  return [...templates.keys()];
}
```

- [ ] **Step 5: Write tests**
- [ ] **Step 6: Run tests, verify pass**
- [ ] **Step 7: Commit**

```bash
git add packages/collector/
git commit -m "feat(collector): collection templates for Gmail, Calendar, GitHub with registry"
```

---

### Task 7: LLM-Driven Auto-Discovery

**Files:**
- Create: `packages/collector/src/auto-discover.ts`
- Create: `packages/collector/test/auto-discover.test.ts`

- [ ] **Step 1: Write failing tests with mocked LLM and client**

```typescript
// packages/collector/test/auto-discover.test.ts
import { describe, it, expect, vi } from "vitest";
import type { LlmProvider } from "@openpulse/core";
import { autoDiscover } from "../src/auto-discover.js";

function mockProvider(...responses: string[]): LlmProvider {
  const fn = vi.fn();
  responses.forEach((r) => fn.mockResolvedValueOnce(r));
  return { complete: fn };
}

function mockClient(tools: any[], toolResults: Record<string, string>) {
  return {
    listTools: vi.fn().mockResolvedValue(tools),
    callTool: vi.fn().mockImplementation((name: string) => ({
      content: [{ type: "text", text: toolResults[name] || "[]" }],
    })),
  };
}

describe("autoDiscover", () => {
  it("generates plan from tools and collects results", async () => {
    const tools = [{ name: "get_activity", description: "Get recent activity", inputSchema: {} }];
    const client = mockClient(tools, { get_activity: '[{"title":"PR merged"}]' });
    const provider = mockProvider(
      JSON.stringify([{ tool: "get_activity", args: {} }]),
      JSON.stringify([{ log: "PR merged on repo-x", theme: "development" }])
    );

    const items = await autoDiscover(client as any, provider, "test-model", new Date(), new Date());
    expect(items.length).toBeGreaterThan(0);
    expect(items[0].log).toContain("PR merged");
  });

  it("returns empty array on LLM parse failure", async () => {
    const client = mockClient([], {});
    const provider = mockProvider("not valid json");
    const items = await autoDiscover(client as any, provider, "test-model", new Date(), new Date());
    expect(items).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement auto-discover**

```typescript
// packages/collector/src/auto-discover.ts
import type { LlmProvider } from "@openpulse/core";
import type { SourceMcpClient } from "./mcp-client.js";
import type { CollectedItem } from "./templates/types.js";

export async function autoDiscover(
  client: SourceMcpClient,
  provider: LlmProvider,
  model: string,
  since: Date,
  until: Date
): Promise<CollectedItem[]> {
  const tools = await client.listTools();
  if (tools.length === 0) return [];

  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description ?? "no description"}`)
    .join("\n");

  // Step 1: Ask LLM to create a collection plan
  let plan: Array<{ tool: string; args: Record<string, unknown> }>;
  try {
    const planText = await provider.complete({
      model,
      prompt: `Given these MCP tools:\n${toolDescriptions}\n\nWhich tools should I call to gather user activity from ${since.toISOString()} to ${until.toISOString()}?\n\nReturn a JSON array: [{"tool": "tool_name", "args": {...}}]\nReturn ONLY the JSON array.`,
    });
    plan = JSON.parse(extractJson(planText));
  } catch {
    return [];
  }

  // Step 2: Execute the plan
  const rawResults: string[] = [];
  for (const step of plan) {
    try {
      const result = await client.callTool(step.tool, step.args);
      for (const block of result.content) {
        if (block.type === "text") rawResults.push(block.text);
      }
    } catch { /* skip failed tool calls */ }
  }

  if (rawResults.length === 0) return [];

  // Step 3: Ask LLM to format results as activity entries
  try {
    const formatted = await provider.complete({
      model,
      prompt: `Format these raw tool results as activity log entries:\n\n${rawResults.join("\n---\n")}\n\nReturn a JSON array: [{"log": "description of activity", "theme": "optional-theme"}]\nReturn ONLY the JSON array.`,
    });
    return JSON.parse(extractJson(formatted));
  } catch {
    return rawResults.map((r) => ({ log: r }));
  }
}

function extractJson(text: string): string {
  // Try to extract JSON from markdown fences
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) return fenceMatch[1].trim();
  // Try to find array in text
  const arrayMatch = text.match(/\[[\s\S]*\]/);
  if (arrayMatch) return arrayMatch[0];
  return text;
}
```

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git add packages/collector/
git commit -m "feat(collector): LLM-driven auto-discovery for unknown MCP sources"
```

---

### Task 8: Scheduler + Orchestrator + CLI

**Files:**
- Create: `packages/collector/src/scheduler.ts`
- Create: `packages/collector/src/orchestrator.ts`
- Create: `packages/collector/test/scheduler.test.ts`
- Create: `packages/collector/test/orchestrator.test.ts`
- Modify: `packages/collector/src/index.ts`

- [ ] **Step 1: Write scheduler tests**

```typescript
// packages/collector/test/scheduler.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import { isDue, loadCollectorState, saveCollectorState } from "../src/scheduler.js";

describe("Scheduler", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-sched-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("isDue returns true when source has never run", () => {
    expect(isDue("0 23 * * *", null, new Date())).toBe(true);
  });

  it("isDue returns false when last run is recent", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    expect(isDue("0 23 * * *", fiveMinAgo, new Date())).toBe(false);
  });

  it("saves and loads collector state", async () => {
    const state = { sourceName: "gmail", lastRunAt: new Date().toISOString(), lastStatus: "success" as const, entriesCollected: 5 };
    await saveCollectorState(vault, state);
    const loaded = await loadCollectorState(vault, "gmail");
    expect(loaded).not.toBeNull();
    expect(loaded!.entriesCollected).toBe(5);
  });
});
```

- [ ] **Step 2: Implement scheduler**

```typescript
// packages/collector/src/scheduler.ts
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import CronParser from "cron-parser";
import type { Vault, CollectorState } from "@openpulse/core";

export function isDue(schedule: string, lastRunAt: string | null, now: Date): boolean {
  if (!lastRunAt) return true;

  try {
    const interval = CronParser.parseExpression(schedule, { currentDate: new Date(lastRunAt) });
    const nextRun = interval.next().toDate();
    return now >= nextRun;
  } catch {
    return true; // if cron is invalid, always run
  }
}

const stateDir = (vault: Vault) => join(vault.root, "vault", "collector-state");

export async function loadCollectorState(vault: Vault, sourceName: string): Promise<CollectorState | null> {
  try {
    const raw = await readFile(join(stateDir(vault), `${sourceName}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCollectorState(vault: Vault, state: CollectorState): Promise<void> {
  const { mkdir } = await import("node:fs/promises");
  const dir = stateDir(vault);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.sourceName}.json`), JSON.stringify(state, null, 2), "utf-8");
}
```

- [ ] **Step 3: Write orchestrator tests (mocked client and templates)**

- [ ] **Step 4: Implement orchestrator**

```typescript
// packages/collector/src/orchestrator.ts
import { appendActivity, type Vault, type SourceConfig, type CollectorState, type LlmProvider } from "@openpulse/core";
import { SourceMcpClient } from "./mcp-client.js";
import { getTemplate } from "./templates/registry.js";
import { parseLookback } from "./templates/types.js";
import { autoDiscover } from "./auto-discover.js";
import { saveCollectorState } from "./scheduler.js";

export async function collectSource(
  source: SourceConfig,
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<CollectorState> {
  const client = new SourceMcpClient(source);
  const now = new Date();
  const lookbackMs = parseLookback(source.lookback);
  const since = new Date(now.getTime() - lookbackMs);

  try {
    console.error(`[collector] Connecting to ${source.name}...`);
    await client.connect();

    let items;
    const template = source.template ? getTemplate(source.template) : undefined;
    if (template) {
      console.error(`[collector] Using template: ${template.name}`);
      items = await template.collect(client, since, now);
    } else {
      console.error(`[collector] Using LLM auto-discovery`);
      items = await autoDiscover(client, provider, model, since, now);
    }

    console.error(`[collector] Collected ${items.length} items from ${source.name}`);

    for (const item of items) {
      await appendActivity(vault, {
        timestamp: item.timestamp ?? now.toISOString(),
        log: item.log,
        theme: item.theme ?? "auto",
        source: source.name,
      });
    }

    const state: CollectorState = {
      sourceName: source.name,
      lastRunAt: now.toISOString(),
      lastStatus: "success",
      entriesCollected: items.length,
    };
    await saveCollectorState(vault, state);
    return state;
  } catch (e: any) {
    console.error(`[collector] Error collecting from ${source.name}: ${e.message}`);
    const state: CollectorState = {
      sourceName: source.name,
      lastRunAt: now.toISOString(),
      lastStatus: "error",
      lastError: e.message,
      entriesCollected: 0,
    };
    await saveCollectorState(vault, state);
    return state;
  } finally {
    await client.disconnect();
  }
}
```

- [ ] **Step 5: Update CLI entry point with full orchestration**

```typescript
// packages/collector/src/index.ts
#!/usr/bin/env node
import { loadConfig, Vault, createProvider } from "@openpulse/core";
import { isDue, loadCollectorState } from "./scheduler.js";
import { collectSource } from "./orchestrator.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;

async function main() {
  const args = process.argv.slice(2);
  const forceSource = args.includes("--force") ? args[args.indexOf("--force") + 1] : null;
  const runAll = args.includes("--all");
  const listOnly = args.includes("--list");

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  const sources = config.sources.filter((s) => s.enabled);

  if (listOnly) {
    for (const s of sources) {
      const state = await loadCollectorState(vault, s.name);
      console.log(`${s.name}: schedule=${s.schedule} lookback=${s.lookback} template=${s.template ?? "auto"} lastRun=${state?.lastRunAt ?? "never"} status=${state?.lastStatus ?? "never"}`);
    }
    return;
  }

  if (sources.length === 0) {
    console.error("[collector] No enabled sources configured.");
    return;
  }

  const provider = createProvider(config);
  const now = new Date();

  for (const source of sources) {
    if (forceSource && source.name !== forceSource) continue;

    if (!runAll && !forceSource) {
      const state = await loadCollectorState(vault, source.name);
      if (!isDue(source.schedule, state?.lastRunAt ?? null, now)) {
        console.error(`[collector] ${source.name}: not due yet, skipping.`);
        continue;
      }
    }

    console.error(`[collector] Collecting from ${source.name}...`);
    const result = await collectSource(source, vault, provider, config.llm.model);
    console.error(`[collector] ${source.name}: ${result.lastStatus} (${result.entriesCollected} entries)`);
  }

  console.error("[collector] Done.");
}

main().catch((e) => { console.error("[collector] Fatal:", e); process.exit(1); });
```

- [ ] **Step 6: Run all collector tests**
- [ ] **Step 7: Build and verify**

```bash
pnpm --filter @openpulse/collector build
```

- [ ] **Step 8: Commit**

```bash
git add packages/collector/
git commit -m "feat(collector): scheduler, orchestrator, and CLI with --force/--all/--list flags"
```

---

## Phase 4: UI Sources Page

### Task 9: API Endpoints for Source Management

**Files:**
- Modify: `packages/ui/server.ts`

- [ ] **Step 1: Add source CRUD + test + collect endpoints**

Add to `server.ts`:

- `GET /api/sources` — return sources array from config with collector state merged
- `POST /api/sources` — add new source to config.yaml
- `PUT /api/sources/:name` — update existing source
- `DELETE /api/sources/:name` — remove source from config
- `POST /api/sources/:name/test` — spawn MCP server, call listTools(), return tool list
- `POST /api/sources/:name/collect` — run `node packages/collector/dist/index.js --force <name>`

- [ ] **Step 2: Verify with curl**
- [ ] **Step 3: Commit**

```bash
git add packages/ui/server.ts
git commit -m "feat(ui): API endpoints for source CRUD, test connection, and manual collection"
```

---

### Task 10: Sources UI Page

**Files:**
- Create: `packages/ui/src/pages/sources.ts`
- Modify: `packages/ui/src/lib/tauri-bridge.ts`
- Modify: `packages/ui/src/main.ts`
- Modify: `packages/ui/index.html`
- Modify: `packages/ui/src/styles.css`

- [ ] **Step 1: Add source API functions to bridge**
- [ ] **Step 2: Add Sources nav item to sidebar in index.html**
- [ ] **Step 3: Add sources route to main.ts**
- [ ] **Step 4: Implement Sources page with list, add/edit form, test/run buttons**
- [ ] **Step 5: Add source card styles to styles.css**
- [ ] **Step 6: Verify in browser**
- [ ] **Step 7: Commit**

```bash
git add packages/ui/
git commit -m "feat(ui): Sources management page with add, edit, test connection, and manual collect"
```

---

## Verification Plan

1. **Unit tests pass**: `pnpm vitest run` — all tests green across all packages
2. **Build succeeds**: `pnpm build` — all 5 packages compile
3. **Collector CLI**: `node packages/collector/dist/index.js --list` shows configured sources
4. **MCP tools**: Connect via Claude Desktop, test `submit_update` and `chat_with_pulse`
5. **UI Sources**: Open Control Center, add a source, test connection, trigger manual collect
6. **End-to-end**: Configure a source MCP → run collector → run dream → approve in UI → query via `chat_with_pulse`

---

## Task Dependency Graph

```
Task 1 (types+config)
  ├── Task 2 (submit_update) ──────────────────────┐
  ├── Task 3 (chat_with_pulse) ────────────────────┤
  └── Task 4 (collector scaffold)                   │
       └── Task 5 (MCP client)                      │
            ├── Task 6 (templates)                   │
            └── Task 7 (auto-discover)               │
                 └── Task 8 (scheduler+orchestrator) │
                      └── Task 9 (API endpoints) ◄──┘
                           └── Task 10 (UI page)
```

Tasks 2+3 can run in parallel. Tasks 6+7 can run in parallel. Task 9 depends on Task 8 for the collect trigger.
