# BYOM (Bring Your Own Model) — Design Spec

**Date:** 2026-04-04
**Status:** Approved

## Goal

Replace the free-text model input in Settings with a guided flow: user picks a provider, enters credentials, OpenPulse validates the key by calling the provider's list-models API, and the user picks from a real dropdown of available models. Add Ollama as a fourth provider for local models.

## Decisions

- **Provider APIs for model discovery** — no external aggregators (OpenRouter, LiteLLM). Each provider's own list endpoint is the source of truth.
- **Server-side validation** — API key validation and model listing happens in the Rust backend (Tauri) and dev server (Express), not in the browser. Keys stay out of frontend memory.
- **Ollama support** — OpenAI-compatible adapter with configurable base URL (default `localhost:11434`). No API key needed.
- **Filter model lists** — Only show chat/completion models. Exclude embeddings, TTS, image generation, etc.
- **Configurable Ollama URL** — Supports remote Ollama servers and non-default ports.

## Model Discovery

New Tauri command `validate_and_list_models` and dev server route `POST /api/validate-models`.

### Request

```json
{
  "provider": "anthropic" | "openai" | "gemini" | "ollama",
  "apiKey": "sk-...",
  "baseUrl": "http://localhost:11434"
}
```

`apiKey` required for anthropic/openai/gemini. `baseUrl` only used for ollama (defaults to `http://localhost:11434` if omitted).

### Response

```json
{
  "valid": true,
  "models": [
    { "id": "claude-sonnet-4-5-20250929", "name": "Claude Sonnet 4.5" },
    { "id": "claude-opus-4-20250514", "name": "Claude Opus 4" }
  ]
}
```

On failure:

```json
{
  "valid": false,
  "error": "Invalid API key",
  "models": []
}
```

### Provider Endpoints

| Provider | Endpoint | Auth | Filter |
|---|---|---|---|
| Anthropic | `GET https://api.anthropic.com/v1/models` | `x-api-key` header, `anthropic-version: 2023-06-01` | Return all (Anthropic only has chat models) |
| OpenAI | `GET https://api.openai.com/v1/models` | `Authorization: Bearer KEY` | IDs starting with `gpt-`, `o1-`, `o3-`, or `chatgpt-` |
| Gemini | `GET https://generativelanguage.googleapis.com/v1beta/models?key=KEY` | Query parameter | Models with `generateContent` in `supportedGenerationMethods` |
| Ollama | `GET {baseUrl}/api/tags` | None | Return all |

### Error Handling

- 401/403 response -> `{ valid: false, error: "Invalid API key" }`
- Network error / connection refused -> `{ valid: false, error: "Cannot connect to {provider}" }`
- Timeout (5s) -> `{ valid: false, error: "Connection timed out" }`

### Model Name Extraction

Each provider returns models in a different shape. Normalized to `{ id, name }`:

- **Anthropic**: `data[].id` and `data[].display_name`
- **OpenAI**: `data[].id` — use the ID as both id and name (OpenAI doesn't return display names)
- **Gemini**: `models[].name` (strip `models/` prefix) and `models[].displayName`
- **Ollama**: `models[].name` — use as both id and name

## Ollama Adapter

New file: `packages/core/src/llm/ollama.ts`

Implements `LlmProvider` using the existing `openai` npm package with a custom `baseURL`. Ollama's API is OpenAI-compatible at `/v1/chat/completions`.

```typescript
export class OllamaProvider implements LlmProvider {
  private client: OpenAI;

  constructor(baseUrl: string = "http://localhost:11434") {
    this.client = new OpenAI({
      baseURL: `${baseUrl}/v1`,
      apiKey: "ollama",  // required by SDK but unused
    });
  }

  async complete(params: CompletionParams): Promise<string> {
    // Same implementation as OpenAIProvider
  }
}
```

## Config Changes

### `types.ts`

```typescript
export type LlmProviderName = "anthropic" | "openai" | "gemini" | "ollama";

export interface OpenPulseConfig {
  vaultPath: string;
  themes: string[];
  llm: {
    provider: LlmProviderName;
    model: string;
    apiKey?: string;
    baseUrl?: string;  // Ollama base URL
  };
}
```

### `config.yaml`

```yaml
themes:
  - engineering
  - meetings
llm:
  provider: ollama
  model: llama3.2
  baseUrl: http://localhost:11434
```

### `config.ts`

`loadConfig` reads `baseUrl` from the yaml `llm` section. Default config has no `baseUrl`.

### `factory.ts`

Add Ollama case:

```typescript
case "ollama":
  return new OllamaProvider(config.llm.baseUrl);
```

## Settings UI

The settings page becomes a guided flow within the existing page layout. All steps are visible once revealed (not a wizard with hidden steps).

### Step 1: Provider Picker

Four selectable cards: Anthropic, OpenAI, Gemini, Ollama. Each shows the provider name and a one-line description. Selecting one highlights it and reveals step 2.

### Step 2: Credentials

- **Anthropic/OpenAI/Gemini**: API key password input + "Validate" button
- **Ollama**: Base URL text input (default `http://localhost:11434`) + "Connect" button

Clicking Validate/Connect calls `validateAndListModels`. Shows a spinner during the request. On success, shows a green checkmark and reveals step 3. On failure, shows the error message inline in red.

### Step 3: Model Picker

Dropdown populated with `models` from the validation response. Pre-selects the currently configured model if present in the list, otherwise the first model.

### Step 4: Save

"Save Settings" button persists provider + model + apiKey + baseUrl. Shows success/error status inline. Same pattern as today.

### State Reset

Changing the provider in step 1 clears steps 2-4 and starts fresh. Changing the API key clears steps 3-4.

## Tauri Bridge Changes

### New function

```typescript
export async function validateAndListModels(
  provider: string,
  apiKey?: string,
  baseUrl?: string,
): Promise<{ valid: boolean; error?: string; models: Array<{ id: string; name: string }> }>
```

### Modified function

```typescript
export async function saveLlmSettings(
  provider: string,
  model: string,
  apiKey?: string,
  baseUrl?: string,  // new parameter
): Promise<void>
```

### Modified return type

```typescript
export async function getLlmConfig(): Promise<{
  provider: string;
  model: string;
  baseUrl?: string;  // new field
}>
```

## Backend Changes

### Rust (`src-tauri/`)

- **New file: `src/discovery.rs`** — `validate_and_list_models` command. Makes HTTP requests using `reqwest` (add to Cargo.toml). Implements the 4-provider dispatch with filtering logic.
- **Modified: `src/config.rs`** — `LlmConfig` struct gains `base_url: Option<String>`. `get_llm_config` returns it. `save_llm_settings` accepts and persists it. `ConfigFile` deserializer reads `baseUrl` from yaml.
- **Modified: `src/main.rs`** — Register `discovery::validate_and_list_models` command.

### Dev server (`packages/ui/server.ts`)

- **New route: `POST /api/validate-models`** — Same logic as Rust but using `fetch()` in Node. Request body: `{ provider, apiKey?, baseUrl? }`. Response: `{ valid, error?, models }`.
- **Modified: `POST /api/save-llm-settings`** — Accept `baseUrl` in body, write to config.yaml.
- **Modified: `GET /api/llm-config`** — Return `baseUrl` if present.

## Files Changed

### New files

| File | Purpose |
|---|---|
| `packages/core/src/llm/ollama.ts` | Ollama LlmProvider adapter |
| `src-tauri/src/discovery.rs` | Tauri validate + list models command |

### Modified files

| File | Change |
|---|---|
| `packages/core/src/types.ts` | Add `"ollama"` to LlmProviderName, add `baseUrl` to config |
| `packages/core/src/llm/factory.ts` | Add Ollama case |
| `packages/core/src/config.ts` | Read `baseUrl` from yaml |
| `packages/ui/src/pages/settings.ts` | Rewrite to guided flow |
| `packages/ui/src/lib/tauri-bridge.ts` | Add `validateAndListModels`, update signatures |
| `packages/ui/server.ts` | Add validate-models route, update config routes |
| `src-tauri/src/config.rs` | Add `baseUrl` support |
| `src-tauri/src/main.rs` | Register discovery command |
| `src-tauri/Cargo.toml` | Add `reqwest` dependency |

## Testing

- **Ollama adapter**: Unit test with mocked OpenAI client, same pattern as existing `openai.test.ts`.
- **Factory**: Add Ollama case to existing factory tests.
- **Config**: Test `baseUrl` round-trip (load + save).
- **Discovery**: Mock HTTP responses for each provider's list endpoint. Test filtering logic. Test error cases (401, network error, timeout).
- **Settings UI**: Manual testing — verify the guided flow works in both dev server and Tauri modes.

## Out of Scope

- Streaming support
- Provider-specific settings (temperature, top-p, etc.)
- Model metadata display (context window, pricing)
- API key storage in Tauri Stronghold (future)
- Custom/additional providers beyond the four
