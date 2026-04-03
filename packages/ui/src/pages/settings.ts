import { getLlmConfig, saveLlmSettings, getVaultPath } from "../lib/tauri-bridge.js";

const DEFAULT_MODELS: Record<string, string> = {
  anthropic: "claude-sonnet-4-5-20250929",
  openai: "gpt-4o",
  gemini: "gemini-2.0-flash",
};

export async function renderSettings(container: HTMLElement): Promise<void> {
  container.innerHTML = `
    <div class="page-header">
      <h2 class="page-title">Settings</h2>
      <p class="page-subtitle">Configure your LLM provider and vault</p>
    </div>
    <div class="card">
      <h3>LLM Provider</h3>
      <div class="settings-section">
        <div class="form-group">
          <label class="form-label" for="provider-select">Provider</label>
          <select class="form-select" id="provider-select">
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="openai">OpenAI (GPT)</option>
            <option value="gemini">Google (Gemini)</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="model-input">Model</label>
          <input class="form-input" type="text" id="model-input" placeholder="Model name" />
        </div>
        <div class="form-group">
          <label class="form-label" for="apikey-input">API Key</label>
          <input class="form-input" type="password" id="apikey-input" placeholder="Enter your API key" />
          <p class="form-help">Stored securely via Tauri Stronghold when running as desktop app.</p>
        </div>
        <div class="actions-row">
          <button class="btn btn-primary" id="btn-save">Save Settings</button>
          <span class="save-status" id="save-status"></span>
        </div>
      </div>
    </div>
    <div class="card">
      <h3>Vault</h3>
      <div class="vault-path" id="vault-path">Loading...</div>
    </div>
  `;

  // Load current settings
  try {
    const config = await getLlmConfig();
    (document.getElementById("provider-select") as HTMLSelectElement).value = config.provider;
    (document.getElementById("model-input") as HTMLInputElement).value = config.model;
  } catch { /* use defaults */ }

  try {
    const vaultPath = await getVaultPath();
    document.getElementById("vault-path")!.textContent = vaultPath;
  } catch { /* ignore */ }

  const providerSelect = document.getElementById("provider-select") as HTMLSelectElement;
  const modelInput = document.getElementById("model-input") as HTMLInputElement;

  providerSelect.addEventListener("change", () => {
    const provider = providerSelect.value;
    if (!modelInput.value || Object.values(DEFAULT_MODELS).includes(modelInput.value)) {
      modelInput.value = DEFAULT_MODELS[provider] ?? "";
    }
  });

  document.getElementById("btn-save")?.addEventListener("click", async () => {
    const status = document.getElementById("save-status")!;
    const btn = document.getElementById("btn-save")!;
    btn.classList.add("loading");
    try {
      const provider = providerSelect.value;
      const model = modelInput.value;
      const apiKey = (document.getElementById("apikey-input") as HTMLInputElement).value;
      await saveLlmSettings(provider, model, apiKey || undefined);
      status.textContent = "Saved";
      status.className = "save-status success";
      (document.getElementById("apikey-input") as HTMLInputElement).value = "";
      setTimeout(() => { status.textContent = ""; }, 2500);
    } catch (e: any) {
      status.textContent = `Error: ${e}`;
      status.className = "save-status error";
    } finally {
      btn.classList.remove("loading");
    }
  });
}
