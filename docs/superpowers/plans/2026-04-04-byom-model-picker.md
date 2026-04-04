# BYOM Model Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the free-text model input with a guided flow that validates API keys against provider APIs and populates a model dropdown, plus add Ollama as a fourth provider.

**Architecture:** Ollama adapter in `packages/core` reuses the `openai` SDK. Model discovery lives server-side — new Tauri command in `discovery.rs` and Express route in `server.ts`. Settings UI becomes a guided provider -> credentials -> model flow.

**Tech Stack:** TypeScript (core + UI), Rust (Tauri backend), `openai` npm SDK (for Ollama), `reqwest` crate (for Rust HTTP)

**Spec:** `docs/superpowers/specs/2026-04-04-byom-model-picker.md`

---

## File Map

### New files

| File | Responsibility |
|---|---|
| `packages/core/src/llm/ollama.ts` | Ollama LlmProvider adapter (OpenAI-compatible) |
| `packages/core/test/llm/ollama.test.ts` | Ollama adapter unit tests |
| `src-tauri/src/discovery.rs` | Tauri `validate_and_list_models` command |

### Modified files

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `"ollama"` to `LlmProviderName`, add `baseUrl` to llm config |
| `packages/core/src/llm/factory.ts` | Add Ollama case |
| `packages/core/src/config.ts` | Read `baseUrl` from yaml |
| `packages/core/src/index.ts` | Export `OllamaProvider` |
| `packages/core/test/llm/factory.test.ts` | Add Ollama test cases |
| `packages/ui/src/lib/tauri-bridge.ts` | Add `validateAndListModels`, update `saveLlmSettings` and `getLlmConfig` |
| `packages/ui/server.ts` | Add `POST /api/validate-models`, update config routes for `baseUrl` |
| `packages/ui/src/pages/settings.ts` | Rewrite to guided flow |
| `packages/ui/src/styles.css` | Add provider grid styles |
| `src-tauri/src/config.rs` | Add `base_url` to config read/write |
| `src-tauri/src/main.rs` | Register `discovery::validate_and_list_models` |
| `src-tauri/Cargo.toml` | Add `reqwest` dependency |

---

## Task 1: Add Ollama to core types and config

**Files:**
- Modify: `packages/core/src/types.ts:10`
- Modify: `packages/core/src/config.ts`

- [ ] **Step 1: Update `LlmProviderName` in `types.ts`**

In `packages/core/src/types.ts`, change line 10 from:

```typescript
export type LlmProviderName = "anthropic" | "openai" | "gemini";
```

to:

```typescript
export type LlmProviderName = "anthropic" | "openai" | "gemini" | "ollama";
```

And add `baseUrl` to the llm config. Change lines 16-20 from:

```typescript
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string; // resolved from env or keychain if not set
  };
```

to:

```typescript
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string; // resolved from env or keychain if not set
    baseUrl?: string; // Ollama base URL (default http://localhost:11434)
  };
```

- [ ] **Step 2: Update `loadConfig` in `config.ts`**

In `packages/core/src/config.ts`, update the return statement inside the try block (around line 26-33) to include `baseUrl`:

```typescript
    return {
      vaultPath: rootDir,
      themes: parsed?.themes ?? [],
      llm: {
        provider,
        model: parsed?.llm?.model ?? DEFAULT_CONFIG.llm.model,
        apiKey: parsed?.llm?.apiKey,
        baseUrl: parsed?.llm?.baseUrl,
      },
    };
```

- [ ] **Step 3: Run tests**

```bash
pnpm vitest run
```

Expected: All 292 tests pass. The type change is backwards-compatible.

- [ ] **Step 4: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/config.ts
git commit -m "feat(core): add ollama to LlmProviderName and baseUrl to config"
```

---

## Task 2: Create Ollama adapter

**Files:**
- Create: `packages/core/src/llm/ollama.ts`
- Create: `packages/core/test/llm/ollama.test.ts`
- Modify: `packages/core/src/index.ts`

- [ ] **Step 1: Write the test file**

Create `packages/core/test/llm/ollama.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { OllamaProvider } from "../../src/llm/ollama.js";

describe("OllamaProvider", () => {
  it("instantiates with default base URL", () => {
    const provider = new OllamaProvider();
    expect(provider).toBeDefined();
  });

  it("instantiates with custom base URL", () => {
    const provider = new OllamaProvider("http://192.168.1.100:11434");
    expect(provider).toBeDefined();
  });

  it("implements complete() method", () => {
    const provider = new OllamaProvider();
    expect(typeof provider.complete).toBe("function");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run packages/core/test/llm/ollama.test.ts
```

Expected: FAIL — cannot find module `../../src/llm/ollama.js`.

- [ ] **Step 3: Create the Ollama adapter**

Create `packages/core/src/llm/ollama.ts`:

```typescript
import OpenAI from "openai";
import type { LlmProvider, CompletionParams } from "./provider.js";

export class OllamaProvider implements LlmProvider {
  private client: OpenAI;

  constructor(baseUrl: string = "http://localhost:11434") {
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "ollama", // required by SDK but unused by Ollama
    });
  }

  async complete(params: CompletionParams): Promise<string> {
    const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
    if (params.systemPrompt) {
      messages.push({ role: "system", content: params.systemPrompt });
    }
    messages.push({ role: "user", content: params.prompt });

    const response = await this.client.chat.completions.create({
      model: params.model,
      max_tokens: params.maxTokens ?? 2048,
      messages,
    });

    return response.choices[0]?.message?.content ?? "";
  }
}
```

- [ ] **Step 4: Export from index.ts**

In `packages/core/src/index.ts`, add after the `createProvider` export:

```typescript
export { OllamaProvider } from "./llm/ollama.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run packages/core/test/llm/ollama.test.ts
```

Expected: 3 tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/llm/ollama.ts packages/core/test/llm/ollama.test.ts packages/core/src/index.ts
git commit -m "feat(core): add Ollama LlmProvider adapter"
```

---

## Task 3: Add Ollama to factory

**Files:**
- Modify: `packages/core/src/llm/factory.ts`
- Modify: `packages/core/test/llm/factory.test.ts`

- [ ] **Step 1: Add test cases for Ollama**

In `packages/core/test/llm/factory.test.ts`, add the import:

```typescript
import { OllamaProvider } from "../../src/llm/ollama.js";
```

And add these test cases inside the `describe` block:

```typescript
  it("creates OllamaProvider for ollama config", () => {
    const provider = createProvider(makeConfig("ollama"));
    expect(provider).toBeInstanceOf(OllamaProvider);
  });

  it("creates OllamaProvider with custom baseUrl", () => {
    const config = makeConfig("ollama");
    config.llm.baseUrl = "http://192.168.1.100:11434";
    const provider = createProvider(config);
    expect(provider).toBeInstanceOf(OllamaProvider);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run packages/core/test/llm/factory.test.ts
```

Expected: 2 new tests FAIL — "Unknown LLM provider: ollama".

- [ ] **Step 3: Update factory**

In `packages/core/src/llm/factory.ts`, add the import:

```typescript
import { OllamaProvider } from "./ollama.js";
```

And add the Ollama case before the `default:` in the switch:

```typescript
    case "ollama":
      return new OllamaProvider(config.llm.baseUrl);
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @openpulse/core build && pnpm vitest run packages/core/test/llm/factory.test.ts
```

Expected: All 7 tests pass (5 existing + 2 new).

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/llm/factory.ts packages/core/test/llm/factory.test.ts
git commit -m "feat(core): add Ollama to provider factory"
```

---

## Task 4: Add model discovery to dev server

**Files:**
- Modify: `packages/ui/server.ts`

- [ ] **Step 1: Add the validate-models route**

In `packages/ui/server.ts`, add this route before the `app.listen` call at the bottom:

```typescript
app.post("/api/validate-models", async (req, res) => {
  const { provider, apiKey, baseUrl } = req.body;
  if (!provider) return res.status(400).json({ valid: false, error: "provider is required", models: [] });

  try {
    let models: Array<{ id: string; name: string }> = [];

    if (provider === "anthropic") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch("https://api.anthropic.com/v1/models", {
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 401 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      models = (data.data ?? []).map((m: any) => ({ id: m.id, name: m.display_name ?? m.id }));
    } else if (provider === "openai") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch("https://api.openai.com/v1/models", {
        headers: { "Authorization": `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 401 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      const chatPrefixes = ["gpt-", "o1-", "o3-", "o4-", "chatgpt-"];
      models = (data.data ?? [])
        .filter((m: any) => chatPrefixes.some((p) => m.id.startsWith(p)))
        .map((m: any) => ({ id: m.id, name: m.id }));
    } else if (provider === "gemini") {
      if (!apiKey) return res.json({ valid: false, error: "API key is required", models: [] });
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!resp.ok) return res.json({ valid: false, error: resp.status === 400 ? "Invalid API key" : `API error: ${resp.status}`, models: [] });
      const data = await resp.json();
      models = (data.models ?? [])
        .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
        .map((m: any) => ({ id: (m.name ?? "").replace("models/", ""), name: m.displayName ?? m.name }));
    } else if (provider === "ollama") {
      const url = baseUrl || "http://localhost:11434";
      const resp = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
      if (!resp.ok) return res.json({ valid: false, error: `Cannot connect to Ollama at ${url}`, models: [] });
      const data = await resp.json();
      models = (data.models ?? []).map((m: any) => ({ id: m.name, name: m.name }));
    } else {
      return res.json({ valid: false, error: `Unknown provider: ${provider}`, models: [] });
    }

    models.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ valid: true, models });
  } catch (e: any) {
    const msg = e.name === "TimeoutError" ? "Connection timed out" : `Cannot connect to ${provider}`;
    res.json({ valid: false, error: msg, models: [] });
  }
});
```

- [ ] **Step 2: Update `GET /api/llm-config` to return baseUrl**

In `packages/ui/server.ts`, find the `app.get("/api/llm-config"` route and replace it with:

```typescript
app.get("/api/llm-config", async (_req, res) => {
  const configPath = join(VAULT_ROOT, "config.yaml");
  try {
    const raw = await readFile(configPath, "utf-8");
    const providerMatch = raw.match(/provider:\s*(\w+)/);
    const modelMatch = raw.match(/model:\s*(.+)/);
    const baseUrlMatch = raw.match(/baseUrl:\s*(.+)/);
    res.json({
      provider: providerMatch?.[1] ?? "anthropic",
      model: modelMatch?.[1]?.trim() ?? "claude-sonnet-4-5-20250929",
      baseUrl: baseUrlMatch?.[1]?.trim(),
    });
  } catch {
    res.json({ provider: "anthropic", model: "claude-sonnet-4-5-20250929" });
  }
});
```

- [ ] **Step 3: Update `POST /api/save-llm-settings` to accept baseUrl**

In `packages/ui/server.ts`, find the `app.post("/api/save-llm-settings"` route. Update the destructuring on the first line of the handler:

```typescript
  const { provider, model, apiKey, baseUrl } = req.body;
```

And update the yaml construction to include baseUrl when present. Replace the line:

```typescript
    yaml += `llm:\n  provider: ${provider}\n  model: ${model}\n`;
```

with:

```typescript
    yaml += `llm:\n  provider: ${provider}\n  model: ${model}\n`;
    if (baseUrl) {
      yaml += `  baseUrl: ${baseUrl}\n`;
    }
```

Also add `"ollama"` to the envMap:

```typescript
      const envMap: Record<string, string> = {
        anthropic: "ANTHROPIC_API_KEY",
        openai: "OPENAI_API_KEY",
        gemini: "GEMINI_API_KEY",
        ollama: "",
      };
```

- [ ] **Step 4: Verify the dev server starts**

```bash
cd packages/ui && npx tsx server.ts &
sleep 2
curl -s http://localhost:3001/api/llm-config | head
kill %1
```

Expected: Returns JSON with provider, model, and optionally baseUrl.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/server.ts
git commit -m "feat(ui): add model discovery and Ollama support to dev server"
```

---

## Task 5: Update tauri-bridge.ts

**Files:**
- Modify: `packages/ui/src/lib/tauri-bridge.ts`

- [ ] **Step 1: Update `getLlmConfig` return type**

In `packages/ui/src/lib/tauri-bridge.ts`, replace the `getLlmConfig` function:

```typescript
export async function getLlmConfig(): Promise<{ provider: string; model: string; baseUrl?: string }> {
  if (isTauri) return tauriInvoke("get_llm_config");
  return apiGet("/llm-config");
}
```

- [ ] **Step 2: Update `saveLlmSettings` to accept baseUrl**

Replace the `saveLlmSettings` function:

```typescript
export async function saveLlmSettings(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<void> {
  if (isTauri) return tauriInvoke("save_llm_settings", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
  await apiPost("/save-llm-settings", { provider, model, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}
```

- [ ] **Step 3: Add validateAndListModels function**

Add after `saveLlmSettings`:

```typescript
export interface ModelInfo {
  id: string;
  name: string;
}

export interface ValidateModelsResult {
  valid: boolean;
  error?: string;
  models: ModelInfo[];
}

export async function validateAndListModels(provider: string, apiKey?: string, baseUrl?: string): Promise<ValidateModelsResult> {
  if (isTauri) return tauriInvoke("validate_and_list_models", { provider, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
  return apiPost("/validate-models", { provider, apiKey: apiKey ?? null, baseUrl: baseUrl ?? null });
}
```

- [ ] **Step 4: Verify the UI still builds**

```bash
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds.

- [ ] **Step 5: Commit**

```bash
git add packages/ui/src/lib/tauri-bridge.ts
git commit -m "feat(ui): add validateAndListModels and baseUrl to bridge"
```

---

## Task 6: Rewrite Settings page UI

**Files:**
- Modify: `packages/ui/src/pages/settings.ts`
- Modify: `packages/ui/src/styles.css`

Note: The settings page uses the same pattern as the existing codebase (building DOM via template literals assigned to container content). All user-visible text in the template is static/hardcoded (provider names, labels), not derived from user input. The model dropdown options are populated from API responses using safe DOM methods (createElement/option.value/option.textContent).

- [ ] **Step 1: Replace settings.ts with the guided flow**

Replace the entire contents of `packages/ui/src/pages/settings.ts` with the new guided BYOM flow. The file should:

1. Import `getLlmConfig`, `saveLlmSettings`, `getVaultPath`, `validateAndListModels` from the bridge
2. Import `ModelInfo` type from the bridge
3. Define a `PROVIDERS` array with `{ id, name, desc, needsKey }` for the 4 providers
4. On render:
   - Load current config via `getLlmConfig()`
   - Render a page with 4 sections: Provider grid, Credentials card (hidden initially), Model card (hidden initially), Vault card
   - Provider grid: 4 buttons in a CSS grid, one per provider. Clicking selects it and shows credentials
   - Credentials: For key-based providers, show API key input + Validate button. For Ollama, show base URL input + Connect button
   - Validate/Connect button calls `validateAndListModels()`, on success populates model dropdown
   - Model dropdown + Save button. Save calls `saveLlmSettings()` with all params
   - Changing provider resets credentials and model sections

The model select dropdown must be populated using DOM API (createElement, option.value, option.textContent) rather than building option HTML from user data, to prevent injection from model names.

- [ ] **Step 2: Add provider grid styles**

In `packages/ui/src/styles.css`, add these styles:

```css
.provider-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
}

.provider-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 1rem;
  border: 2px solid var(--border-color, #2a3040);
  border-radius: 8px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.provider-card:hover {
  border-color: var(--accent-color, #3b82f6);
}

.provider-card.selected {
  border-color: var(--accent-color, #3b82f6);
  background: rgba(59, 130, 246, 0.1);
}

.provider-card strong {
  font-size: 1rem;
}

.provider-card span {
  font-size: 0.8rem;
  opacity: 0.6;
}

.validate-status {
  font-size: 0.85rem;
  margin-left: 0.5rem;
}

.validate-status.success {
  color: #22c55e;
}

.validate-status.error {
  color: #ef4444;
}
```

- [ ] **Step 3: Verify the UI builds**

```bash
pnpm --filter @openpulse/ui build
```

Expected: Build succeeds.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/src/pages/settings.ts packages/ui/src/styles.css
git commit -m "feat(ui): rewrite settings page with guided BYOM flow"
```

---

## Task 7: Update Rust config for baseUrl

**Files:**
- Modify: `src-tauri/src/config.rs`

- [ ] **Step 1: Add `base_url` to structs and commands**

Update `src-tauri/src/config.rs`:

- Add `#[serde(rename_all = "camelCase")]` to `LlmConfig` struct
- Add `base_url: Option<String>` field to `LlmConfig` (with `#[serde(skip_serializing_if = "Option::is_none")]`)
- Add `#[serde(rename_all = "camelCase")]` to `ConfigFile` and `LlmSection` structs
- Add `base_url: Option<String>` to `LlmSection`
- Update `get_llm_config` to return `base_url` from the parsed config
- Update `save_llm_settings` to accept `base_url: Option<String>` parameter and write `baseUrl:` to yaml when present
- Update envMap to handle `"ollama"` provider (skip API key logging)

- [ ] **Step 2: Verify Rust compiles**

```bash
source "$HOME/.cargo/env" && cd src-tauri && cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/config.rs
git commit -m "feat(desktop): add baseUrl support to config commands"
```

---

## Task 8: Add Rust model discovery command

**Files:**
- Create: `src-tauri/src/discovery.rs`
- Modify: `src-tauri/src/main.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Add `reqwest` to Cargo.toml**

In `src-tauri/Cargo.toml`, add to `[dependencies]`:

```toml
reqwest = { version = "0.12", features = ["json"] }
tokio = { version = "1", features = ["rt-multi-thread"] }
```

- [ ] **Step 2: Create `src-tauri/src/discovery.rs`**

Create the file with:

- `ModelInfo` struct with `id: String` and `name: String` (Serialize)
- `ValidateResult` struct with `valid: bool`, `error: Option<String>`, `models: Vec<ModelInfo>` (Serialize)
- Helper `err_result(msg)` that returns a `ValidateResult` with `valid: false`
- `validate_and_list_models` async Tauri command taking `provider: String`, `api_key: Option<String>`, `base_url: Option<String>`
- Uses `reqwest::Client` with 5-second timeout
- Match on provider:
  - `"anthropic"`: GET `https://api.anthropic.com/v1/models` with `x-api-key` and `anthropic-version: 2023-06-01` headers. Parse `data[].id` and `data[].display_name`.
  - `"openai"`: GET `https://api.openai.com/v1/models` with `Authorization: Bearer` header. Filter to IDs starting with `gpt-`, `o1-`, `o3-`, `o4-`, `chatgpt-`. Parse `data[].id`.
  - `"gemini"`: GET `https://generativelanguage.googleapis.com/v1beta/models?key=KEY`. Filter to models with `generateContent` in `supportedGenerationMethods`. Parse `models[].name` (strip `models/` prefix) and `models[].displayName`.
  - `"ollama"`: GET `{baseUrl}/api/tags` (default `http://localhost:11434`). No auth. Parse `models[].name`.
- Error handling: 401/403 returns "Invalid API key", timeout returns "Connection timed out", network error returns "Cannot connect to {provider}"
- Sort models by name before returning

- [ ] **Step 3: Register the command in `main.rs`**

Add `mod discovery;` at the top of `src-tauri/src/main.rs` and add `discovery::validate_and_list_models` to the `invoke_handler`.

- [ ] **Step 4: Verify Rust compiles**

```bash
source "$HOME/.cargo/env" && cd src-tauri && cargo check
```

Expected: Compiles. First run will download `reqwest` and its dependencies.

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/discovery.rs src-tauri/src/main.rs src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "feat(desktop): add model discovery command with 4-provider support"
```

---

## Task 9: End-to-end verification

**Files:** No new files — verification only.

- [ ] **Step 1: Build all TypeScript packages**

```bash
pnpm build
```

Expected: All packages build successfully.

- [ ] **Step 2: Run all tests**

```bash
pnpm vitest run
```

Expected: All tests pass (292 existing + new Ollama tests).

- [ ] **Step 3: Compile Rust backend**

```bash
source "$HOME/.cargo/env" && cd src-tauri && cargo check
```

Expected: Compiles with no errors.

- [ ] **Step 4: Test dev server model discovery**

Start the dev server and test the validate-models endpoint:

```bash
cd packages/ui && npx tsx server.ts &
sleep 2

# Test with invalid key (should fail gracefully)
curl -s -X POST http://localhost:3001/api/validate-models \
  -H "Content-Type: application/json" \
  -d '{"provider":"anthropic","apiKey":"invalid-key"}'

# Test Ollama (will fail if not running - that is OK)
curl -s -X POST http://localhost:3001/api/validate-models \
  -H "Content-Type: application/json" \
  -d '{"provider":"ollama"}'

kill %1
```

Expected: Anthropic returns `{ "valid": false, "error": "Invalid API key", "models": [] }`. Ollama returns either a model list or a connection error.

- [ ] **Step 5: Launch Tauri dev mode**

```bash
source "$HOME/.cargo/env" && cargo tauri dev
```

Expected: Window opens. Navigate to Settings page. Should see 4 provider cards. Clicking one reveals credentials input.

- [ ] **Step 6: Commit any fixes**

If smoke testing revealed issues:

```bash
git add -A
git commit -m "fix(byom): address smoke test issues"
```
