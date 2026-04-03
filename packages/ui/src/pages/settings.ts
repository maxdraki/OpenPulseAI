import { getLlmConfig, saveLlmSettings, getVaultPath } from "../lib/tauri-bridge.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
};

export async function renderSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <h2 class="page-title">Settings</h2>
    <div class="card">
      <h3>LLM Provider</h3>
      <div class="settings-form">
        <sl-select id="provider-select" label="Provider" value="anthropic" size="small">
          <sl-option value="anthropic">Anthropic (Claude)</sl-option>
          <sl-option value="openai">OpenAI (GPT)</sl-option>
          <sl-option value="gemini">Google (Gemini)</sl-option>
        </sl-select>
        <sl-input id="model-input" label="Model" size="small" placeholder="Model name"></sl-input>
        <sl-input id="apikey-input" label="API Key" type="password" size="small" placeholder="Enter your API key" password-toggle>
          <small slot="help-text">Stored securely via Tauri Stronghold when running as desktop app.</small>
        </sl-input>
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <sl-button variant="primary" id="btn-save" size="small">Save Settings</sl-button>
          <span id="save-status" style="font-size: 0.85rem;"></span>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Vault Location</h3>
      <p style="color: var(--text-secondary); font-family: 'Google Sans Mono', monospace;" id="vault-path">Loading...</p>
    </div>
  `;

  // Load current settings
  try {
    const config = await getLlmConfig();
    const providerSelect = document.getElementById("provider-select") as any;
    const modelInput = document.getElementById("model-input") as any;
    providerSelect.value = config.provider;
    modelInput.value = config.model;
  } catch { /* use defaults */ }

  try {
    const vaultPath = await getVaultPath();
    document.getElementById("vault-path")!.textContent = vaultPath;
  } catch { /* ignore */ }

  const providerSelect = document.getElementById("provider-select") as any;
  const modelInput = document.getElementById("model-input") as any;

  providerSelect.addEventListener("sl-change", () => {
    const provider = providerSelect.value;
    if (!modelInput.value || Object.values(DEFAULT_MODELS).includes(modelInput.value)) {
      modelInput.value = DEFAULT_MODELS[provider] ?? "";
    }
  });

  document.getElementById("btn-save")?.addEventListener("click", async () => {
    const status = document.getElementById("save-status")!;
    const btn = document.getElementById("btn-save") as any;
    btn.loading = true;
    try {
      const provider = providerSelect.value;
      const model = modelInput.value;
      const apiKey = (document.getElementById("apikey-input") as any).value;
      await saveLlmSettings(provider, model, apiKey || undefined);
      status.textContent = "Saved!";
      status.style.color = "var(--success)";
      (document.getElementById("apikey-input") as any).value = "";
    } catch (e: any) {
      status.textContent = `Error: ${e}`;
      status.style.color = "var(--danger)";
    } finally {
      btn.loading = false;
    }
  });
}
