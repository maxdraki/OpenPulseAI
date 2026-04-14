# Confluence Space Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the `confluence_space_keys` plain-text input with a searchable checkbox picker that discovers spaces from the user's Confluence instance.

**Architecture:** A new server endpoint proxies to the Confluence spaces API using credentials from the request body. A bridge function wraps it. The UI replaces the text input for `confluence_space_keys` with a button + searchable checkbox list; a hidden `<input>` stores the result so the existing save logic works unchanged.

**Tech Stack:** Node.js fetch (server), vanilla TypeScript (UI), existing `apiPost` bridge pattern

---

## File Map

| File | Change |
|------|--------|
| `packages/ui/server.ts` | Add `POST /api/confluence-activity/spaces` |
| `packages/ui/src/lib/tauri-bridge.ts` | Add `fetchConfluenceSpaces()` |
| `packages/ui/src/pages/data-sources.ts` | Replace `confluence_space_keys` input with picker |

---

### Task 1: Server endpoint

**Files:**
- Modify: `packages/ui/server.ts` (after the `POST /api/skill-config/:name` block, around line 716)

- [ ] **Step 1: Add the endpoint**

Insert after the `POST /api/skill-config/:name` block (after line 716):

```typescript
// --- Confluence space discovery ---

app.post("/api/confluence-activity/spaces", async (req, res) => {
  const { domain, email, token } = req.body as { domain?: string; email?: string; token?: string };
  if (!domain || !email || !token) {
    return res.status(400).json({ error: "domain, email, and token are required" });
  }
  try {
    const resp = await fetch(
      `https://${domain}/wiki/rest/api/space?limit=250&type=global`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    if (!resp.ok) {
      return res.status(resp.status).json({ error: `Confluence returned ${resp.status}` });
    }
    const data = await resp.json() as { results: Array<{ key: string; name: string }> };
    const spaces = (data.results ?? [])
      .map((s) => ({ key: s.key, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json(spaces);
  } catch (e: any) {
    const msg = e.name === "TimeoutError" ? "Connection timed out" : e.message;
    res.status(500).json({ error: msg });
  }
});
```

- [ ] **Step 2: Manual smoke test**

With the server running (`npx tsx server.ts`), run:

```bash
curl -s -X POST http://localhost:3001/api/confluence-activity/spaces \
  -H "Content-Type: application/json" \
  -d '{"domain":"rws-dev.atlassian.net","email":"millis@rws.com","token":"ATATT3x..."}' \
  | python3 -c "import json,sys; d=json.load(sys.stdin); [print(r['key'],'|',r['name']) for r in d[:5]]"
```

Expected: 5 space entries printed (key | name format).

- [ ] **Step 3: Test missing params**

```bash
curl -s -X POST http://localhost:3001/api/confluence-activity/spaces \
  -H "Content-Type: application/json" \
  -d '{"domain":"x.atlassian.net"}' | python3 -m json.tool
```

Expected: `{"error": "domain, email, and token are required"}` with status 400.

- [ ] **Step 4: Commit**

```bash
git add packages/ui/server.ts
git commit -m "feat(server): add Confluence space discovery endpoint"
```

---

### Task 2: Bridge function

**Files:**
- Modify: `packages/ui/src/lib/tauri-bridge.ts` (add near the end, before the last export)

- [ ] **Step 1: Add the type and function**

Add after `saveSkillConfig` (find it with `grep -n saveSkillConfig packages/ui/src/lib/tauri-bridge.ts`):

```typescript
export async function fetchConfluenceSpaces(
  domain: string,
  email: string,
  token: string
): Promise<Array<{ key: string; name: string }>> {
  return apiPost("/confluence-activity/spaces", { domain, email, token });
}
```

- [ ] **Step 2: Verify it compiles**

```bash
cd packages/ui && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/ui/src/lib/tauri-bridge.ts
git commit -m "feat(bridge): add fetchConfluenceSpaces function"
```

---

### Task 3: Space picker UI

**Files:**
- Modify: `packages/ui/src/pages/data-sources.ts`

The config panel is built inside `getSkillConfig(skill.name).then((savedConfig) => { ... })` in `renderSkillCard`. The loop builds one `row` per config field. We intercept the `confluence_space_keys` field.

- [ ] **Step 1: Add the import at the top of data-sources.ts**

Find the existing import line:
```typescript
import { getSkills, installSkill, installDependency, removeSkill, runSkillNow, getSkillConfig, saveSkillConfig, apiGet, type SkillData } from "../lib/tauri-bridge.js";
```

Replace with:
```typescript
import { getSkills, installSkill, installDependency, removeSkill, runSkillNow, getSkillConfig, saveSkillConfig, apiGet, fetchConfluenceSpaces, type SkillData } from "../lib/tauri-bridge.js";
```

- [ ] **Step 2: Add the picker branch in the config field loop**

Find this block in `renderSkillCard` (around the `} else {` that renders a plain text input for non-paths fields):

```typescript
        } else {
          // Single text/path input
          const input = document.createElement("input");
          input.className = "form-input";
          input.style.fontSize = "0.82rem";
          input.type = "text";
          input.placeholder = field.default ?? "";
          input.value = savedConfig[field.key] ?? field.default ?? "";
          input.dataset.configKey = field.key;
          row.appendChild(input);
        }
```

Replace with:

```typescript
        } else if (field.key === "confluence_space_keys") {
          renderSpacePicker(row, configFields, savedConfig[field.key] ?? "");
        } else {
          // Single text/path input
          const input = document.createElement("input");
          input.className = "form-input";
          input.style.fontSize = "0.82rem";
          input.type = "text";
          input.placeholder = field.default ?? "";
          input.value = savedConfig[field.key] ?? field.default ?? "";
          input.dataset.configKey = field.key;
          row.appendChild(input);
        }
```

- [ ] **Step 3: Add the renderSpacePicker function**

Add this function just before `renderDataSources` (at module level, around line 70):

```typescript
function renderSpacePicker(row: HTMLElement, configFields: HTMLElement, savedKeys: string): void {
  const selectedKeys = new Set(savedKeys.split(",").map((k) => k.trim()).filter(Boolean));

  // Hidden input — picked up by existing save logic
  const hidden = document.createElement("input");
  hidden.type = "hidden";
  hidden.dataset.configKey = "confluence_space_keys";
  hidden.value = savedKeys;
  row.appendChild(hidden);

  function updateHidden() {
    hidden.value = Array.from(selectedKeys).join(",");
  }

  // Discover button
  const discoverBtn = document.createElement("button");
  discoverBtn.className = "btn btn-sm";
  discoverBtn.style.marginBottom = "0.4rem";
  discoverBtn.textContent = "Discover Spaces";
  row.appendChild(discoverBtn);

  // Status message
  const status = document.createElement("p");
  status.style.cssText = "font-size: 0.78rem; color: var(--text-tertiary); margin: 0.25rem 0;";
  if (savedKeys) status.textContent = `${selectedKeys.size} space(s) selected — click Discover to refresh`;
  row.appendChild(status);

  // Search input (hidden until spaces loaded)
  const searchInput = document.createElement("input");
  searchInput.className = "form-input";
  searchInput.style.cssText = "font-size: 0.82rem; margin-bottom: 0.25rem; display: none;";
  searchInput.placeholder = "Search spaces…";
  row.appendChild(searchInput);

  // Space list container
  const listContainer = document.createElement("div");
  listContainer.style.cssText = "display: none; max-height: 200px; overflow-y: auto; border: 1px solid var(--border); border-radius: 6px; background: var(--surface);";
  row.appendChild(listContainer);

  let allSpaces: Array<{ key: string; name: string }> = [];

  function renderList(filter: string) {
    listContainer.textContent = "";
    const lower = filter.toLowerCase();
    const filtered = filter
      ? allSpaces.filter((s) => s.key.toLowerCase().includes(lower) || s.name.toLowerCase().includes(lower))
      : allSpaces;

    for (const space of filtered) {
      const item = document.createElement("label");
      item.style.cssText = "display: flex; align-items: center; gap: 0.5rem; padding: 0.35rem 0.6rem; cursor: pointer; font-size: 0.82rem;";
      item.style.borderBottom = "1px solid var(--border)";

      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = selectedKeys.has(space.key);
      cb.addEventListener("change", () => {
        if (cb.checked) selectedKeys.add(space.key);
        else selectedKeys.delete(space.key);
        updateHidden();
        status.textContent = `${selectedKeys.size} space(s) selected`;
      });

      const keySpan = document.createElement("code");
      keySpan.style.cssText = "font-size: 0.75rem; color: var(--text-tertiary); min-width: 4rem;";
      keySpan.textContent = space.key;

      const nameSpan = document.createElement("span");
      nameSpan.textContent = space.name;

      item.appendChild(cb);
      item.appendChild(keySpan);
      item.appendChild(nameSpan);
      listContainer.appendChild(item);
    }

    if (filtered.length === 0) {
      const empty = document.createElement("p");
      empty.style.cssText = "padding: 0.5rem; color: var(--text-tertiary); font-size: 0.82rem; margin: 0;";
      empty.textContent = filter ? "No matching spaces" : "No spaces found";
      listContainer.appendChild(empty);
    }
  }

  searchInput.addEventListener("input", () => renderList(searchInput.value));

  discoverBtn.addEventListener("click", async () => {
    // Read current credential field values from the config panel
    const domainInput = configFields.querySelector<HTMLInputElement>('input[data-config-key="confluence_domain"]');
    const emailInput = configFields.querySelector<HTMLInputElement>('input[data-config-key="confluence_email"]');
    const tokenInput = configFields.querySelector<HTMLInputElement>('input[data-config-key="confluence_api_token"]');

    const domain = domainInput?.value.trim() ?? "";
    const email = emailInput?.value.trim() ?? "";
    const token = tokenInput?.value.trim() ?? "";

    if (!domain || !email || !token) {
      status.textContent = "Enter domain, email, and token first, then click Discover.";
      status.style.color = "var(--warning, orange)";
      return;
    }

    discoverBtn.classList.add("loading");
    discoverBtn.disabled = true;
    status.textContent = "Loading spaces…";
    status.style.color = "var(--text-tertiary)";
    listContainer.style.display = "none";
    searchInput.style.display = "none";

    try {
      allSpaces = await fetchConfluenceSpaces(domain, email, token);
      searchInput.value = "";
      renderList("");
      searchInput.style.display = "";
      listContainer.style.display = "";
      status.textContent = `${selectedKeys.size} space(s) selected — ${allSpaces.length} available`;
      status.style.color = "var(--text-tertiary)";
    } catch (e: any) {
      const msg = e.message?.includes("401") ? "Authentication failed — check credentials"
        : e.message?.includes("timed out") ? "Connection timed out"
        : "Could not reach Confluence";
      status.textContent = msg;
      status.style.color = "var(--danger)";
    } finally {
      discoverBtn.classList.remove("loading");
      discoverBtn.disabled = false;
    }
  });
}
```

- [ ] **Step 4: Verify it compiles**

```bash
cd packages/ui && npx tsc --noEmit 2>&1 | head -20
```

Expected: no errors (or only pre-existing errors unrelated to data-sources.ts).

- [ ] **Step 5: Run in browser and test the golden path**

```bash
cd packages/ui
npx tsx server.ts &
npx vite --port 1420 &
```

Open http://localhost:1420, go to Data Sources, find the Confluence card under "Your Data Sources", click ⚙ Configure, enter domain/email/token, click "Discover Spaces". Verify:
- List renders with checkboxes
- Searching filters the list
- Checking boxes updates the hidden input (inspect in DevTools: `document.querySelector('[data-config-key="confluence_space_keys"]').value`)
- Saving config persists the keys

- [ ] **Step 6: Test error state**

Enter a wrong token, click Discover. Verify "Authentication failed — check credentials" appears in red.

- [ ] **Step 7: Test pre-selection**

If `confluence_space_keys` already has a value saved (e.g. `ATWG`), open the config panel and click Discover. Verify `ATWG` is pre-ticked.

- [ ] **Step 8: Commit**

```bash
git add packages/ui/src/lib/tauri-bridge.ts packages/ui/src/pages/data-sources.ts packages/ui/server.ts
git commit -m "feat(ui): Confluence space picker with searchable checkbox list"
```
