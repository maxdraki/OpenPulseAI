import { getLlmConfig, saveLlmSettings, getVaultPath, validateAndListModels, testModel, getClaudeDesktopStatus, connectClaudeDesktop, disconnectClaudeDesktop } from "../lib/tauri-bridge.js";
import type { ModelInfo } from "../lib/tauri-bridge.js";
import { log } from "../lib/logger.js";

const LOGO_TOKEN = "pk_LAYYrrRiTb2tIjkY-KCbMw";
const logo = (domain: string) => `https://img.logo.dev/${domain}?token=${LOGO_TOKEN}&size=32&format=png`;

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", desc: "Claude models", needsKey: true, logo: logo("anthropic.com") },
  { id: "openai", name: "OpenAI", desc: "GPT models", needsKey: true, logo: logo("openai.com") },
  { id: "gemini", name: "Google", desc: "Gemini models", needsKey: true, logo: logo("google.com") },
  { id: "mistral", name: "Mistral", desc: "Mistral models", needsKey: true, logo: logo("mistral.ai") },
  { id: "ollama", name: "Ollama", desc: "Local models", needsKey: false, logo: logo("ollama.com") },
];

export async function renderSettings(container: HTMLElement): Promise<void> {
  // Load current config first
  let currentProvider = "anthropic";
  let currentModel = "";
  let currentApiKey = "";
  let currentBaseUrl = "";

  try {
    const config = await getLlmConfig();
    currentProvider = config.provider;
    currentModel = config.model;
    currentApiKey = config.apiKey ?? "";
    currentBaseUrl = config.baseUrl ?? "";
  } catch { /* use defaults */ }

  // Remember the saved provider so we can restore credentials when switching back
  const savedProvider = currentProvider;
  const savedApiKey = currentApiKey;
  const savedBaseUrl = currentBaseUrl;
  const savedModel = currentModel;

  // Build provider buttons using DOM methods (safe)
  const pageHeader = document.createElement("div");
  pageHeader.className = "page-header";
  const h2 = document.createElement("h2");
  h2.className = "page-title";
  h2.textContent = "Settings";
  const subtitle = document.createElement("p");
  subtitle.className = "page-subtitle";
  subtitle.textContent = "Configure your LLM provider and vault";
  pageHeader.appendChild(h2);
  pageHeader.appendChild(subtitle);

  const providerCardEl = document.createElement("div");
  providerCardEl.className = "card";
  const providerH3 = document.createElement("h3");
  providerH3.textContent = "LLM Provider";

  const providerRow = document.createElement("div");
  providerRow.className = "provider-select-row";

  const providerLogo = document.createElement("img");
  providerLogo.className = "provider-logo";
  providerLogo.width = 24;
  providerLogo.height = 24;
  providerLogo.addEventListener("error", () => { providerLogo.style.display = "none"; });
  const currentProv = PROVIDERS.find((p) => p.id === currentProvider);
  if (currentProv?.logo) {
    providerLogo.src = currentProv.logo;
    providerLogo.alt = currentProv.name;
  }

  const providerSelect = document.createElement("select");
  providerSelect.className = "form-select";
  providerSelect.id = "provider-select";
  for (const p of PROVIDERS) {
    const option = document.createElement("option");
    option.value = p.id;
    option.textContent = `${p.name} — ${p.desc}`;
    if (p.id === currentProvider) option.selected = true;
    providerSelect.appendChild(option);
  }

  providerSelect.addEventListener("change", () => {
    const selected = PROVIDERS.find((p) => p.id === providerSelect.value);
    if (selected?.logo) {
      providerLogo.src = selected.logo;
      providerLogo.alt = selected.name;
      providerLogo.style.display = "";
    } else {
      providerLogo.style.display = "none";
    }
    const newProvider = providerSelect.value;
    currentProvider = newProvider;

    // Reset downstream
    const modelCardEl = document.getElementById("model-card");
    if (modelCardEl) modelCardEl.style.display = "none";

    // Restore saved credentials if switching back to the original provider
    if (newProvider === savedProvider) {
      renderCredentials(newProvider, savedModel, savedApiKey, savedBaseUrl);
      if (savedModel) {
        populateModelDropdown([{ id: savedModel, name: savedModel }], savedModel);
        if (modelCardEl) modelCardEl.style.display = "";
      }
    } else {
      renderCredentials(newProvider, "", "", "");
    }
  });

  providerRow.appendChild(providerLogo);
  providerRow.appendChild(providerSelect);

  providerCardEl.appendChild(providerH3);
  providerCardEl.appendChild(providerRow);

  const credentialsCard = document.createElement("div");
  credentialsCard.className = "card";
  credentialsCard.id = "credentials-card";

  const modelCard = document.createElement("div");
  modelCard.className = "card";
  modelCard.id = "model-card";
  modelCard.style.display = "none";

  const modelH3 = document.createElement("h3");
  modelH3.textContent = "Model";
  const modelSection = document.createElement("div");
  modelSection.className = "settings-section";

  const modelFormGroup = document.createElement("div");
  modelFormGroup.className = "form-group";
  const modelLabel = document.createElement("label");
  modelLabel.className = "form-label";
  modelLabel.htmlFor = "model-select";
  modelLabel.textContent = "Select model";
  const modelSelect = document.createElement("select");
  modelSelect.className = "form-select";
  modelSelect.id = "model-select";
  modelFormGroup.appendChild(modelLabel);
  modelFormGroup.appendChild(modelSelect);

  const modelActionsRow = document.createElement("div");
  modelActionsRow.className = "actions-row";
  const saveBtn = document.createElement("button");
  saveBtn.className = "btn btn-primary";
  saveBtn.id = "btn-save";
  saveBtn.textContent = "Save";
  const testBtn = document.createElement("button");
  testBtn.className = "btn btn-secondary";
  testBtn.id = "btn-test";
  testBtn.textContent = "Test";
  testBtn.style.display = "none";
  const saveStatus = document.createElement("span");
  saveStatus.className = "save-status";
  saveStatus.id = "save-status";
  modelActionsRow.appendChild(saveBtn);
  modelActionsRow.appendChild(testBtn);
  modelActionsRow.appendChild(saveStatus);

  modelSection.appendChild(modelFormGroup);
  modelSection.appendChild(modelActionsRow);
  modelCard.appendChild(modelH3);
  modelCard.appendChild(modelSection);

  const vaultCard = document.createElement("div");
  vaultCard.className = "card";
  const vaultH3 = document.createElement("h3");
  vaultH3.textContent = "Vault";
  const vaultPath = document.createElement("div");
  vaultPath.className = "vault-path";
  vaultPath.id = "vault-path";
  vaultPath.textContent = "Loading...";
  vaultCard.appendChild(vaultH3);
  vaultCard.appendChild(vaultPath);

  // Connections card
  const connectionsCard = document.createElement("div");
  connectionsCard.className = "card";
  const connectionsH3 = document.createElement("h3");
  connectionsH3.textContent = "Connections";
  connectionsCard.appendChild(connectionsH3);

  const claudeRow = document.createElement("div");
  claudeRow.className = "connection-row";
  claudeRow.id = "claude-desktop-row";
  connectionsCard.appendChild(claudeRow);

  // Mount everything
  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(providerCardEl);
  container.appendChild(credentialsCard);
  container.appendChild(modelCard);
  container.appendChild(connectionsCard);
  container.appendChild(vaultCard);

  // Load vault path
  try {
    const vaultPathStr = await getVaultPath();
    vaultPath.textContent = vaultPathStr;
  } catch { /* ignore */ }

  // Load Claude Desktop connection status
  await renderClaudeDesktopConnection();

  // Render credentials for initial provider
  renderCredentials(currentProvider, currentModel, currentApiKey, currentBaseUrl);

  // If we have a saved key, auto-validate to populate the full model list
  if (currentApiKey && currentProvider !== "ollama") {
    const mc = document.getElementById("model-card");
    try {
      const result = await validateAndListModels(currentProvider, currentApiKey, currentBaseUrl);
      if (result.valid && result.models.length > 0) {
        populateModelDropdown(result.models, currentModel);
        if (mc) mc.style.display = "";
      } else if (currentModel) {
        // Validation failed but we have a saved model — show just that
        populateModelDropdown([{ id: currentModel, name: currentModel }], currentModel);
        if (mc) mc.style.display = "";
      }
    } catch {
      // Fallback: show just the saved model
      if (currentModel) {
        populateModelDropdown([{ id: currentModel, name: currentModel }], currentModel);
        if (mc) mc.style.display = "";
      }
    }
  } else if (currentProvider === "ollama") {
    // Ollama doesn't need a key — validate immediately
    const mc = document.getElementById("model-card");
    try {
      const result = await validateAndListModels("ollama", undefined, currentBaseUrl);
      if (result.valid && result.models.length > 0) {
        populateModelDropdown(result.models, currentModel);
        if (mc) mc.style.display = "";
      }
    } catch { /* ignore */ }
  }
}

function renderCredentials(provider: string, currentModel: string, currentApiKey: string, currentBaseUrl: string): void {
  const providerData = PROVIDERS.find(p => p.id === provider)!;
  const card = document.getElementById("credentials-card")!;

  // Clear and rebuild using DOM methods
  card.textContent = "";

  const h3 = document.createElement("h3");
  h3.textContent = providerData.needsKey ? "Credentials" : "Connection";
  card.appendChild(h3);

  const section = document.createElement("div");
  section.className = "settings-section";

  const formGroup = document.createElement("div");
  formGroup.className = "form-group";

  if (providerData.needsKey) {
    const label = document.createElement("label");
    label.className = "form-label";
    label.htmlFor = "apikey-input";
    label.textContent = "API Key";
    const input = document.createElement("input");
    input.className = "form-input";
    input.type = "password";
    input.id = "apikey-input";
    input.placeholder = "Enter your API key";
    if (currentApiKey) input.value = currentApiKey;
    const help = document.createElement("p");
    help.className = "form-help";
    help.textContent = "Stored securely via Tauri Stronghold when running as desktop app.";
    formGroup.appendChild(label);
    formGroup.appendChild(input);
    formGroup.appendChild(help);
  } else {
    const label = document.createElement("label");
    label.className = "form-label";
    label.htmlFor = "baseurl-input";
    label.textContent = "Base URL";
    const input = document.createElement("input");
    input.className = "form-input";
    input.type = "text";
    input.id = "baseurl-input";
    input.value = currentBaseUrl || "http://localhost:11434";
    input.placeholder = "http://localhost:11434";
    formGroup.appendChild(label);
    formGroup.appendChild(input);
  }

  const actionsRow = document.createElement("div");
  actionsRow.className = "actions-row";
  const validateBtn = document.createElement("button");
  validateBtn.className = "btn btn-secondary";
  validateBtn.id = "btn-validate";
  validateBtn.textContent = providerData.needsKey ? "Validate" : "Connect";
  const statusEl = document.createElement("span");
  statusEl.className = "validate-status";
  statusEl.id = "validate-status";
  actionsRow.appendChild(validateBtn);
  actionsRow.appendChild(statusEl);

  section.appendChild(formGroup);
  section.appendChild(actionsRow);
  card.appendChild(section);

  validateBtn.addEventListener("click", async () => {
    await handleValidate(provider, currentModel);
  });
}

async function handleValidate(provider: string, currentModel: string): Promise<void> {
  const btn = document.getElementById("btn-validate") as HTMLButtonElement;
  const statusEl = document.getElementById("validate-status")!;
  const providerData = PROVIDERS.find(p => p.id === provider)!;

  const apiKey = providerData.needsKey
    ? (document.getElementById("apikey-input") as HTMLInputElement | null)?.value
    : undefined;
  const baseUrl = !providerData.needsKey
    ? (document.getElementById("baseurl-input") as HTMLInputElement | null)?.value
    : undefined;

  btn.classList.add("loading");
  btn.disabled = true;
  statusEl.textContent = "";
  statusEl.className = "validate-status";

  try {
    const result = await validateAndListModels(provider, apiKey || undefined, baseUrl || undefined);

    if (!result.valid || result.models.length === 0) {
      const errMsg = result.error ?? "No models found";
      statusEl.textContent = errMsg;
      statusEl.className = "validate-status error";
      log("warn", `Validation failed for ${provider}`, errMsg);
      return;
    }

    log("info", `Validated ${provider}`, `${result.models.length} models available`);

    statusEl.textContent = `\u2713 ${result.models.length} model${result.models.length === 1 ? "" : "s"} available`;
    statusEl.className = "validate-status success";

    populateModelDropdown(result.models, currentModel);
    const modelCard = document.getElementById("model-card")!;
    modelCard.style.display = "";

    // Wire up save button
    const saveBtn = document.getElementById("btn-save")!;
    saveBtn.onclick = async () => {
      await handleSave(provider, apiKey, baseUrl);
    };
  } catch (e: any) {
    statusEl.textContent = `Error: ${e?.message ?? e}`;
    statusEl.className = "validate-status error";
  } finally {
    btn.classList.remove("loading");
    btn.disabled = false;
  }
}

function populateModelDropdown(models: ModelInfo[], currentModel: string): void {
  const select = document.getElementById("model-select") as HTMLSelectElement;
  // Clear existing options safely
  while (select.firstChild) {
    select.removeChild(select.firstChild);
  }

  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    select.appendChild(opt);
  }

  // Pre-select current model if present in the list
  if (currentModel) {
    const match = models.find(m => m.id === currentModel);
    if (match) {
      select.value = currentModel;
    }
  }
}

async function handleSave(provider: string, apiKey?: string, baseUrl?: string): Promise<void> {
  const saveBtn = document.getElementById("btn-save") as HTMLButtonElement;
  const saveStatus = document.getElementById("save-status")!;
  const select = document.getElementById("model-select") as HTMLSelectElement;
  const model = select.value;

  saveBtn.classList.add("loading");
  saveBtn.disabled = true;

  try {
    await saveLlmSettings(provider, model, apiKey || undefined, baseUrl || undefined);
    log("info", `Settings saved`, `${provider} / ${model}`);
    saveStatus.textContent = "Saved";
    saveStatus.className = "save-status success";

    // Show test button
    const testBtn = document.getElementById("btn-test") as HTMLButtonElement;
    testBtn.style.display = "";
    testBtn.onclick = () => handleTest(provider, model, apiKey, baseUrl);

    setTimeout(() => { saveStatus.textContent = ""; }, 2500);
  } catch (e: any) {
    log("error", `Failed to save settings`, e?.message ?? String(e));
    saveStatus.textContent = `Error: ${e?.message ?? e}`;
    saveStatus.className = "save-status error";
  } finally {
    saveBtn.classList.remove("loading");
    saveBtn.disabled = false;
  }
}

async function handleTest(provider: string, model: string, apiKey?: string, baseUrl?: string): Promise<void> {
  const testBtn = document.getElementById("btn-test") as HTMLButtonElement;
  const saveStatus = document.getElementById("save-status")!;

  testBtn.classList.add("loading");
  testBtn.disabled = true;
  saveStatus.textContent = "Testing...";
  saveStatus.className = "save-status";

  try {
    const result = await testModel(provider, model, apiKey, baseUrl);
    if (result.success) {
      log("info", `Model test passed`, `${provider}/${model}: "${result.response}"`);
      saveStatus.textContent = `\u2713 "${result.response}"`;
      saveStatus.className = "save-status success";
    } else {
      log("error", `Model test failed`, `${provider}/${model}: ${result.error}`);
      saveStatus.textContent = result.error ?? "Test failed";
      saveStatus.className = "save-status error";
    }
  } catch (e: any) {
    log("error", `Model test error`, e?.message ?? String(e));
    saveStatus.textContent = `Error: ${e?.message ?? e}`;
    saveStatus.className = "save-status error";
  } finally {
    testBtn.classList.remove("loading");
    testBtn.disabled = false;
  }
}

async function renderClaudeDesktopConnection(): Promise<void> {
  const row = document.getElementById("claude-desktop-row")!;
  row.textContent = "";

  let status;
  try {
    status = await getClaudeDesktopStatus();
  } catch {
    status = { installed: false, connected: false, configPath: "" };
  }

  const label = document.createElement("div");
  label.className = "connection-info";

  const name = document.createElement("strong");
  name.textContent = "Claude Desktop";
  label.appendChild(name);

  const statusText = document.createElement("span");
  statusText.className = status.connected ? "connection-status connected" : "connection-status";
  statusText.textContent = status.connected ? "Connected" : "Not connected";
  label.appendChild(statusText);

  row.appendChild(label);

  const btn = document.createElement("button");
  if (status.connected) {
    btn.className = "btn btn-danger btn-sm";
    btn.textContent = "Disconnect";
    btn.addEventListener("click", async () => {
      btn.classList.add("loading");
      btn.disabled = true;
      try {
        await disconnectClaudeDesktop();
        log("info", "Disconnected from Claude Desktop");
        await renderClaudeDesktopConnection();
      } catch (e: any) {
        log("error", "Failed to disconnect from Claude Desktop", String(e));
      }
    });
  } else {
    btn.className = "btn btn-primary btn-sm";
    btn.textContent = "Connect";
    btn.addEventListener("click", async () => {
      btn.classList.add("loading");
      btn.disabled = true;
      try {
        await connectClaudeDesktop();
        log("info", "Connected to Claude Desktop");
        await renderClaudeDesktopConnection();
      } catch (e: any) {
        log("error", "Failed to connect to Claude Desktop", String(e));
      }
    });
  }
  row.appendChild(btn);

  if (status.connected) {
    const hint = document.createElement("p");
    hint.className = "connection-hint";
    hint.textContent = "Restart Claude Desktop to pick up the new config.";
    row.appendChild(hint);
  }
}
