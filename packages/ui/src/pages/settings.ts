import { getLlmConfig, saveLlmSettings, getVaultPath, validateAndListModels, testModel, getClaudeDesktopStatus, connectClaudeDesktop, disconnectClaudeDesktop, getAigisConfig, saveAigisConfig, testAigisConnection, getAigisLastSubmission } from "../lib/tauri-bridge.js";
import type { ModelInfo } from "../lib/tauri-bridge.js";
import { log } from "../lib/logger.js";
import { logoUrl } from "../lib/utils.js";

const logo = (domain: string) => logoUrl(domain, 32);

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
  let currentApiKey = "";          // raw key is only ever present on the Tauri desktop path
  let hasStoredKey = false;        // web path: a key exists server-side but is never sent here
  let keyHint = "";
  let currentBaseUrl = "";

  try {
    const config = await getLlmConfig();
    currentProvider = config.provider;
    currentModel = config.model;
    currentApiKey = config.apiKey ?? "";
    hasStoredKey = config.hasKey ?? Boolean(config.apiKey);
    keyHint = config.keyHint ?? "";
    currentBaseUrl = config.baseUrl ?? "";
  } catch { /* use defaults */ }

  const savedProvider = currentProvider;
  const savedApiKey = currentApiKey;
  const savedBaseUrl = currentBaseUrl;
  const savedModel = currentModel;

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
      renderCredentials(newProvider, savedModel, savedApiKey, savedBaseUrl, newProvider === savedProvider && hasStoredKey, newProvider === savedProvider ? keyHint : "");
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

  // Connect Aigis card
  const aigisCard = document.createElement("div");
  aigisCard.className = "card";
  const aigisH3 = document.createElement("h3");
  aigisH3.textContent = "Connect Aigis";
  const aigisDesc = document.createElement("p");
  aigisDesc.className = "form-help";
  aigisDesc.textContent = "Connects OpenPulseAI to your aigis.bio candidate-knowledge journal. Nothing is auto-submitted — rollups stay review-gated in the Review tab, same as everything else.";
  aigisCard.appendChild(aigisH3);
  aigisCard.appendChild(aigisDesc);

  const aigisSection = document.createElement("div");
  aigisSection.className = "settings-section";

  const endpointGroup = document.createElement("div");
  endpointGroup.className = "form-group";
  const endpointLabel = document.createElement("label");
  endpointLabel.className = "form-label";
  endpointLabel.htmlFor = "aigis-endpoint-input";
  endpointLabel.textContent = "Endpoint";
  const endpointInput = document.createElement("input");
  endpointInput.className = "form-input";
  endpointInput.type = "text";
  endpointInput.id = "aigis-endpoint-input";
  endpointInput.placeholder = "https://aigis.bio/mcp";
  endpointGroup.appendChild(endpointLabel);
  endpointGroup.appendChild(endpointInput);

  const tokenGroup = document.createElement("div");
  tokenGroup.className = "form-group";
  const tokenLabel = document.createElement("label");
  tokenLabel.className = "form-label";
  tokenLabel.htmlFor = "aigis-token-input";
  tokenLabel.textContent = "Auth token";
  const tokenInput = document.createElement("input");
  tokenInput.className = "form-input";
  tokenInput.type = "password";
  tokenInput.id = "aigis-token-input";
  tokenGroup.appendChild(tokenLabel);
  tokenGroup.appendChild(tokenInput);

  const enabledGroup = document.createElement("div");
  enabledGroup.className = "form-group form-group-checkbox";
  const enabledLabel = document.createElement("label");
  enabledLabel.className = "form-label";
  enabledLabel.htmlFor = "aigis-enabled-toggle";
  const enabledCheckbox = document.createElement("input");
  enabledCheckbox.type = "checkbox";
  enabledCheckbox.id = "aigis-enabled-toggle";
  enabledLabel.appendChild(enabledCheckbox);
  enabledLabel.appendChild(document.createTextNode(" Enabled"));
  enabledGroup.appendChild(enabledLabel);

  const aigisActionsRow = document.createElement("div");
  aigisActionsRow.className = "actions-row";
  const aigisSaveBtn = document.createElement("button");
  aigisSaveBtn.className = "btn btn-primary";
  aigisSaveBtn.id = "btn-aigis-save";
  aigisSaveBtn.textContent = "Save";
  const aigisTestBtn = document.createElement("button");
  aigisTestBtn.className = "btn btn-secondary";
  aigisTestBtn.id = "btn-aigis-test";
  aigisTestBtn.textContent = "Test connection";
  const aigisStatus = document.createElement("span");
  aigisStatus.className = "validate-status";
  aigisStatus.id = "aigis-status";
  aigisActionsRow.appendChild(aigisSaveBtn);
  aigisActionsRow.appendChild(aigisTestBtn);
  aigisActionsRow.appendChild(aigisStatus);

  // Last submission outcome — from vault/aigis/submissions.jsonl (see
  // task-17 brief §B: "show the last submission outcome + timestamp").
  const aigisLastSubmission = document.createElement("p");
  aigisLastSubmission.className = "form-help";
  aigisLastSubmission.id = "aigis-last-submission";
  aigisLastSubmission.style.display = "none";

  aigisSection.appendChild(endpointGroup);
  aigisSection.appendChild(tokenGroup);
  aigisSection.appendChild(enabledGroup);
  aigisSection.appendChild(aigisActionsRow);
  aigisSection.appendChild(aigisLastSubmission);
  aigisCard.appendChild(aigisSection);

  // Mount everything
  container.textContent = "";
  container.appendChild(pageHeader);
  container.appendChild(providerCardEl);
  container.appendChild(credentialsCard);
  container.appendChild(modelCard);
  container.appendChild(connectionsCard);
  container.appendChild(aigisCard);
  container.appendChild(vaultCard);

  // Load vault path
  try {
    const vaultPathStr = await getVaultPath();
    vaultPath.textContent = vaultPathStr;
  } catch { /* ignore */ }

  // Load Claude Desktop connection status
  await renderClaudeDesktopConnection();

  // Load Aigis connection settings
  await renderAigisCard();
  aigisSaveBtn.addEventListener("click", handleAigisSave);
  aigisTestBtn.addEventListener("click", handleAigisTest);

  // Render credentials for initial provider
  renderCredentials(currentProvider, currentModel, currentApiKey, currentBaseUrl, hasStoredKey, keyHint);

  // Show model card with the given models and wire the save button
  function showModelCard(models: ModelInfo[], selectedModel: string) {
    populateModelDropdown(models, selectedModel);
    const mc = document.getElementById("model-card");
    if (mc) mc.style.display = "";
    const btn = document.getElementById("btn-save");
    if (btn) {
      btn.onclick = async () => {
        await handleSave(currentProvider);
      };
    }
  }

  // Auto-validate on load to populate the full model list. On the web path we have
  // no raw key, but the server validates with its stored key when we send none.
  if (currentApiKey || hasStoredKey || currentProvider === "ollama") {
    try {
      const key = currentProvider === "ollama" ? undefined : (currentApiKey || undefined);
      const result = await validateAndListModels(currentProvider, key, currentBaseUrl);
      if (result.valid && result.models.length > 0) {
        showModelCard(result.models, currentModel);
      } else if (currentModel) {
        showModelCard([{ id: currentModel, name: currentModel }], currentModel);
      }
    } catch {
      if (currentModel) {
        showModelCard([{ id: currentModel, name: currentModel }], currentModel);
      }
    }
  }
}

function renderCredentials(provider: string, currentModel: string, currentApiKey: string, currentBaseUrl: string, hasStoredKey = false, keyHint = ""): void {
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
    input.placeholder = hasStoredKey ? `Saved (${keyHint}) — leave blank to keep` : "Enter your API key";
    // Only the Tauri desktop path supplies a raw key; the web path never pre-fills the secret.
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
      await handleSave(provider);
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

/** Read current credentials from the DOM so we never save stale closure values */
function readCredentialsFromDOM(): { apiKey?: string; baseUrl?: string } {
  const keyEl = document.getElementById("apikey-input") as HTMLInputElement | null;
  const urlEl = document.getElementById("baseurl-input") as HTMLInputElement | null;
  return {
    apiKey: keyEl?.value || undefined,
    baseUrl: urlEl?.value || undefined,
  };
}

async function handleSave(provider: string): Promise<void> {
  const saveBtn = document.getElementById("btn-save") as HTMLButtonElement;
  const saveStatus = document.getElementById("save-status")!;
  const select = document.getElementById("model-select") as HTMLSelectElement;
  const model = select.value;
  const { apiKey, baseUrl } = readCredentialsFromDOM();

  saveBtn.classList.add("loading");
  saveBtn.disabled = true;

  try {
    await saveLlmSettings(provider, model, apiKey, baseUrl);
    log("info", `Settings saved`, `${provider} / ${model}`);
    saveStatus.textContent = "Saved";
    saveStatus.className = "save-status success";

    // Show test button
    const testBtn = document.getElementById("btn-test") as HTMLButtonElement;
    testBtn.style.display = "";
    testBtn.onclick = () => handleTest(provider, model);

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

async function handleTest(provider: string, model: string): Promise<void> {
  const { apiKey, baseUrl } = readCredentialsFromDOM();
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

async function renderAigisCard(): Promise<void> {
  const endpointInput = document.getElementById("aigis-endpoint-input") as HTMLInputElement;
  const tokenInput = document.getElementById("aigis-token-input") as HTMLInputElement;
  const enabledToggle = document.getElementById("aigis-enabled-toggle") as HTMLInputElement;

  try {
    const config = await getAigisConfig();
    endpointInput.value = config.endpoint;
    tokenInput.placeholder = config.hasToken ? `Saved (${config.tokenHint}) — leave blank to keep` : "Enter your Aigis auth token";
    enabledToggle.checked = config.enabled;
  } catch { /* use defaults */ }

  await renderAigisLastSubmission();
}

/** Populates the "last submission" line from vault/aigis/submissions.jsonl —
 *  the most recent Aigis rollup submission attempt, any outcome. */
async function renderAigisLastSubmission(): Promise<void> {
  const el = document.getElementById("aigis-last-submission") as HTMLParagraphElement | null;
  if (!el) return;

  try {
    const last = await getAigisLastSubmission();
    if (!last.found) {
      el.style.display = "none";
      return;
    }
    const when = last.submittedAt ? new Date(last.submittedAt).toLocaleString("en-GB", {
      day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit",
    }) : "unknown time";
    const outcome = last.ok ? "succeeded" : `failed (${last.error ?? "unknown error"})`;
    el.textContent = `Last Aigis submission: ${outcome} — ${when}${last.theme ? ` (${last.theme})` : ""}. Retry a failed/skipped submission from the Review tab.`;
    el.style.display = "";
  } catch {
    el.style.display = "none";
  }
}

async function handleAigisSave(): Promise<void> {
  const saveBtn = document.getElementById("btn-aigis-save") as HTMLButtonElement;
  const statusEl = document.getElementById("aigis-status")!;
  const endpointInput = document.getElementById("aigis-endpoint-input") as HTMLInputElement;
  const tokenInput = document.getElementById("aigis-token-input") as HTMLInputElement;
  const enabledToggle = document.getElementById("aigis-enabled-toggle") as HTMLInputElement;

  saveBtn.classList.add("loading");
  saveBtn.disabled = true;
  statusEl.textContent = "";
  statusEl.className = "validate-status";

  try {
    await saveAigisConfig(endpointInput.value.trim(), tokenInput.value || undefined, "aigis_submit_journal", enabledToggle.checked);
    log("info", "Aigis settings saved", endpointInput.value);
    statusEl.textContent = "Saved";
    statusEl.className = "validate-status success";
    tokenInput.value = "";
    await renderAigisCard();
    setTimeout(() => { statusEl.textContent = ""; }, 2500);
  } catch (e: any) {
    log("error", "Failed to save Aigis settings", e?.message ?? String(e));
    statusEl.textContent = `Error: ${e?.message ?? e}`;
    statusEl.className = "validate-status error";
  } finally {
    saveBtn.classList.remove("loading");
    saveBtn.disabled = false;
  }
}

async function handleAigisTest(): Promise<void> {
  const testBtn = document.getElementById("btn-aigis-test") as HTMLButtonElement;
  const statusEl = document.getElementById("aigis-status")!;
  const endpointInput = document.getElementById("aigis-endpoint-input") as HTMLInputElement;
  const tokenInput = document.getElementById("aigis-token-input") as HTMLInputElement;

  testBtn.classList.add("loading");
  testBtn.disabled = true;
  statusEl.textContent = "Testing...";
  statusEl.className = "validate-status";

  try {
    const result = await testAigisConnection(endpointInput.value.trim() || undefined, tokenInput.value || undefined);
    if (result.ok) {
      statusEl.textContent = result.hasSubmitTool
        ? `✓ Connected — ${result.tools.length} tool${result.tools.length === 1 ? "" : "s"} found`
        : `✓ Connected, but the submit tool wasn't found among: ${result.tools.join(", ") || "(none)"}`;
      statusEl.className = "validate-status success";
      log("info", "Aigis connection test passed", `${result.tools.length} tools`);
    } else {
      statusEl.textContent = result.error ?? "Connection failed";
      statusEl.className = "validate-status error";
      log("warn", "Aigis connection test failed", result.error ?? "unknown error");
    }
  } catch (e: any) {
    statusEl.textContent = `Error: ${e?.message ?? e}`;
    statusEl.className = "validate-status error";
  } finally {
    testBtn.classList.remove("loading");
    testBtn.disabled = false;
  }
}
