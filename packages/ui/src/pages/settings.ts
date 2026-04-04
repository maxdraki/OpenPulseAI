import { getLlmConfig, saveLlmSettings, getVaultPath, validateAndListModels, testModel } from "../lib/tauri-bridge.js";
import type { ModelInfo } from "../lib/tauri-bridge.js";

const PROVIDERS = [
  { id: "anthropic", name: "Anthropic", desc: "Claude models", needsKey: true },
  { id: "openai", name: "OpenAI", desc: "GPT models", needsKey: true },
  { id: "gemini", name: "Google", desc: "Gemini models", needsKey: true },
  { id: "ollama", name: "Ollama", desc: "Local models", needsKey: false },
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
  const providerGrid = document.createElement("div");
  providerGrid.className = "provider-grid";
  providerGrid.id = "provider-grid";

  for (const p of PROVIDERS) {
    const btn = document.createElement("button");
    btn.className = "provider-card" + (p.id === currentProvider ? " selected" : "");
    btn.dataset.provider = p.id;
    const strong = document.createElement("strong");
    strong.textContent = p.name;
    const span = document.createElement("span");
    span.textContent = p.desc;
    btn.appendChild(strong);
    btn.appendChild(span);
    providerGrid.appendChild(btn);
  }

  providerCardEl.appendChild(providerH3);
  providerCardEl.appendChild(providerGrid);

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

  // Mount everything
  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(providerCardEl);
  container.appendChild(credentialsCard);
  container.appendChild(modelCard);
  container.appendChild(vaultCard);

  // Load vault path
  try {
    const vaultPathStr = await getVaultPath();
    vaultPath.textContent = vaultPathStr;
  } catch { /* ignore */ }

  // Render credentials for initial provider
  renderCredentials(currentProvider, currentModel, currentApiKey, currentBaseUrl);

  // Provider grid click handler
  providerGrid.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-provider]");
    if (!btn) return;
    const providerId = btn.dataset.provider!;

    // Update selection highlight
    document.querySelectorAll(".provider-card").forEach(c => c.classList.remove("selected"));
    btn.classList.add("selected");

    // Hide model card when switching providers
    modelCard.style.display = "none";

    // If switching back to the saved provider, restore saved values
    const savedModel = providerId === currentProvider ? currentModel : "";
    const savedApiKey = providerId === currentProvider ? currentApiKey : "";
    const savedBaseUrl = providerId === currentProvider ? currentBaseUrl : "";
    renderCredentials(providerId, savedModel, savedApiKey, savedBaseUrl);
  });
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
      statusEl.textContent = result.error ?? "No models found";
      statusEl.className = "validate-status error";
      return;
    }

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
    saveStatus.textContent = "Saved";
    saveStatus.className = "save-status success";

    // Show test button
    const testBtn = document.getElementById("btn-test") as HTMLButtonElement;
    testBtn.style.display = "";
    testBtn.onclick = () => handleTest(provider, model, apiKey, baseUrl);

    setTimeout(() => { saveStatus.textContent = ""; }, 2500);
  } catch (e: any) {
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
      saveStatus.textContent = `\u2713 "${result.response}"`;
      saveStatus.className = "save-status success";
    } else {
      saveStatus.textContent = result.error ?? "Test failed";
      saveStatus.className = "save-status error";
    }
  } catch (e: any) {
    saveStatus.textContent = `Error: ${e?.message ?? e}`;
    saveStatus.className = "save-status error";
  } finally {
    testBtn.classList.remove("loading");
    testBtn.disabled = false;
  }
}
