# OpenPulse Skills System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the collector's rigid template/auto-discover system with an AgentSkills.io-compatible skill runner that executes SKILL.md files — natural language instructions — using the LLM and shell commands.

**Architecture:** Refactor `@openpulse/collector` into `@openpulse/skills`. Keep the MCP client wrapper, scheduler, and state tracking. Delete templates and auto-discover. Add: skill loader (discover + parse SKILL.md), eligibility checker, skill runner (extract shell commands, pre-execute, send to LLM, capture output). Ship 3 bundled SKILL.md files. Update UI Sources page → Skills page.

**Tech Stack:** TypeScript, Vitest, `cron-parser`, `js-yaml`, existing `@openpulse/core` LLM provider

---

## File Structure

### Delete

```
packages/collector/src/templates/           # All 5 files
packages/collector/src/auto-discover.ts
packages/collector/src/orchestrator.ts
packages/collector/test/templates/           # All test files
packages/collector/test/auto-discover.test.ts
```

### Rename

```
packages/collector/ → packages/skills/
```

### Keep (with modifications)

```
packages/skills/src/mcp-client.ts           # Change SourceConfig → SkillDefinition
packages/skills/src/scheduler.ts            # Change sourceName → skillName in state functions
packages/skills/test/mcp-client.test.ts     # Update imports
packages/skills/test/scheduler.test.ts      # Update imports
```

### Create

```
packages/skills/src/loader.ts               # Discover + parse SKILL.md files
packages/skills/src/eligibility.ts          # Check requires.bins and requires.env
packages/skills/src/runner.ts               # Execute skill: extract commands, run, send to LLM
packages/skills/src/index.ts                # New CLI entry point
packages/skills/test/loader.test.ts
packages/skills/test/eligibility.test.ts
packages/skills/test/runner.test.ts
packages/skills/builtin/
├── google-daily-digest/SKILL.md
├── github-activity/SKILL.md
└── weekly-rollup/SKILL.md
```

### Modify in other packages

```
packages/core/src/types.ts                  # Add SkillDefinition, update CollectorState.sourceName → skillName
packages/core/src/config.ts                 # Remove sources[] parsing
packages/core/src/index.ts                  # Export SkillDefinition, remove SourceConfig
packages/ui/src/pages/sources.ts            # Rename to skills.ts, update content
packages/ui/server.ts                       # Replace source endpoints with skill endpoints
packages/ui/index.html                      # Rename nav: Sources → Skills
packages/ui/src/main.ts                     # Update route name
packages/ui/src/lib/tauri-bridge.ts         # Replace source API functions with skill functions
packages/ui/src/styles.css                  # Rename .source-* → .skill-*
```

---

## Phase 1: Core Types & Package Rename

### Task 1: Update Core Types and Rename Package

**Files:**
- Modify: `packages/core/src/types.ts`
- Modify: `packages/core/src/config.ts`
- Modify: `packages/core/src/index.ts`
- Rename: `packages/collector/` → `packages/skills/`
- Modify: `packages/skills/package.json`

- [ ] **Step 1: Add SkillDefinition type to types.ts**

Add after existing types (keep `SourceConfig` for now — remove in a later step):

```typescript
/** Parsed skill from a SKILL.md file */
export interface SkillDefinition {
  name: string;
  description: string;
  location: string;        // absolute path to SKILL.md
  body: string;            // markdown content after frontmatter
  schedule?: string;       // cron expression (OpenPulse extension)
  lookback: string;        // default "24h" (OpenPulse extension)
  requires: {
    bins: string[];
    env: string[];
  };
}
```

- [ ] **Step 2: Update CollectorState to use skillName**

Change `sourceName` to `skillName` in `CollectorState`:

```typescript
export interface CollectorState {
  skillName: string;        // was: sourceName
  lastRunAt: string | null;
  lastStatus: "success" | "error" | "never";
  lastError?: string;
  entriesCollected: number;
}
```

- [ ] **Step 3: Export SkillDefinition from index.ts**

Add `SkillDefinition` to the barrel export. Keep `SourceConfig` exported for now (mcp-client still uses it).

- [ ] **Step 4: Rename packages/collector → packages/skills**

```bash
mv packages/collector packages/skills
```

- [ ] **Step 5: Update packages/skills/package.json**

Change `name` to `@openpulse/skills`, `bin` to `openpulse-skills`:

```json
{
  "name": "@openpulse/skills",
  "bin": { "openpulse-skills": "dist/index.js" }
}
```

Add `js-yaml` dependency:
```bash
pnpm --filter @openpulse/skills add js-yaml && pnpm --filter @openpulse/skills add -D @types/js-yaml
```

- [ ] **Step 6: Update pnpm workspace and install**

```bash
pnpm install
```

- [ ] **Step 7: Update scheduler.ts — sourceName → skillName**

In `packages/skills/src/scheduler.ts`, update `loadCollectorState` and `saveCollectorState` to use `state.skillName` instead of `state.sourceName`:

```typescript
export async function loadCollectorState(vault: Vault, skillName: string): Promise<CollectorState | null> {
  try {
    const raw = await readFile(join(stateDir(vault), `${skillName}.json`), "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function saveCollectorState(vault: Vault, state: CollectorState): Promise<void> {
  const dir = stateDir(vault);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${state.skillName}.json`), JSON.stringify(state, null, 2), "utf-8");
}
```

- [ ] **Step 8: Update scheduler test**

Update `packages/skills/test/scheduler.test.ts` — change `sourceName` to `skillName` in test data:

```typescript
const state = { skillName: "gmail", lastRunAt: new Date().toISOString(), lastStatus: "success" as const, entriesCollected: 5 };
```

- [ ] **Step 9: Run tests, verify they pass**

```bash
pnpm vitest run packages/skills/ packages/core/
```

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "refactor: rename @openpulse/collector to @openpulse/skills, add SkillDefinition type"
```

---

## Phase 2: Skill Loader & Eligibility

### Task 2: Skill Loader — Discover and Parse SKILL.md Files

**Files:**
- Create: `packages/skills/src/loader.ts`
- Create: `packages/skills/test/loader.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/skills/test/loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillsFromDir, loadSkillFromFile, parseFrontmatter } from "../src/loader.js";

describe("Skill Loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-loader-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  describe("parseFrontmatter", () => {
    it("parses standard fields", () => {
      const result = parseFrontmatter("name: my-skill\ndescription: Does stuff");
      expect(result).not.toBeNull();
      expect(result!.name).toBe("my-skill");
      expect(result!.description).toBe("Does stuff");
    });

    it("parses OpenPulse extension fields", () => {
      const yaml = 'name: test\ndescription: Test skill\nschedule: "0 22 * * *"\nlookback: 12h\nrequires:\n  bins: [gog, gh]\n  env: [API_KEY]';
      const result = parseFrontmatter(yaml);
      expect(result!.schedule).toBe("0 22 * * *");
      expect(result!.lookback).toBe("12h");
      expect(result!.requires.bins).toEqual(["gog", "gh"]);
      expect(result!.requires.env).toEqual(["API_KEY"]);
    });

    it("returns null for missing required fields", () => {
      expect(parseFrontmatter("name: test")).toBeNull();
      expect(parseFrontmatter("description: test")).toBeNull();
    });

    it("defaults lookback to 24h and requires to empty", () => {
      const result = parseFrontmatter("name: test\ndescription: Test");
      expect(result!.lookback).toBe("24h");
      expect(result!.requires.bins).toEqual([]);
      expect(result!.requires.env).toEqual([]);
    });
  });

  describe("loadSkillFromFile", () => {
    it("loads a valid SKILL.md", async () => {
      const skillDir = join(tempDir, "my-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), '---\nname: my-skill\ndescription: Does stuff\n---\n\n## Instructions\n\nDo the thing.\n', "utf-8");

      const skill = await loadSkillFromFile(join(skillDir, "SKILL.md"));
      expect(skill).not.toBeNull();
      expect(skill!.name).toBe("my-skill");
      expect(skill!.body).toContain("Do the thing.");
      expect(skill!.location).toBe(join(skillDir, "SKILL.md"));
    });

    it("returns null for file without frontmatter", async () => {
      await writeFile(join(tempDir, "SKILL.md"), "# No frontmatter\n\nJust text.\n", "utf-8");
      const skill = await loadSkillFromFile(join(tempDir, "SKILL.md"));
      expect(skill).toBeNull();
    });
  });

  describe("loadSkillsFromDir", () => {
    it("discovers skills in subdirectories", async () => {
      const skill1 = join(tempDir, "skill-a");
      const skill2 = join(tempDir, "skill-b");
      await mkdir(skill1, { recursive: true });
      await mkdir(skill2, { recursive: true });
      await writeFile(join(skill1, "SKILL.md"), '---\nname: skill-a\ndescription: Skill A\n---\n\nBody A\n', "utf-8");
      await writeFile(join(skill2, "SKILL.md"), '---\nname: skill-b\ndescription: Skill B\n---\n\nBody B\n', "utf-8");

      const skills = await loadSkillsFromDir(tempDir);
      expect(skills).toHaveLength(2);
      expect(skills.map(s => s.name).sort()).toEqual(["skill-a", "skill-b"]);
    });

    it("returns empty array for empty directory", async () => {
      const skills = await loadSkillsFromDir(tempDir);
      expect(skills).toEqual([]);
    });

    it("returns empty array for nonexistent directory", async () => {
      const skills = await loadSkillsFromDir("/tmp/nonexistent-dir-xyz");
      expect(skills).toEqual([]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm vitest run packages/skills/test/loader.test.ts
```

- [ ] **Step 3: Implement loader**

```typescript
// packages/skills/src/loader.ts
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { load } from "js-yaml";
import type { SkillDefinition } from "@openpulse/core";

const FRONTMATTER_REGEX = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?/;

export function parseFrontmatter(
  content: string
): Omit<SkillDefinition, "location" | "body"> | null {
  try {
    const parsed = load(content) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return null;

    const name = parsed.name;
    const description = parsed.description;
    if (typeof name !== "string" || typeof description !== "string") return null;

    const requires = parsed.requires as Record<string, unknown> | undefined;

    return {
      name: name.replace(/[:\\/<>*?"|]/g, "-"),
      description,
      schedule: typeof parsed.schedule === "string" ? parsed.schedule : undefined,
      lookback: typeof parsed.lookback === "string" ? parsed.lookback : "24h",
      requires: {
        bins: Array.isArray(requires?.bins) ? requires.bins.filter((b): b is string => typeof b === "string") : [],
        env: Array.isArray(requires?.env) ? requires.env.filter((e): e is string => typeof e === "string") : [],
      },
    };
  } catch {
    return null;
  }
}

export async function loadSkillFromFile(
  filePath: string
): Promise<SkillDefinition | null> {
  try {
    const content = await readFile(filePath, "utf-8");
    const match = content.match(FRONTMATTER_REGEX);
    if (!match) return null;

    const frontmatter = parseFrontmatter(match[1]);
    if (!frontmatter) return null;

    return {
      ...frontmatter,
      location: filePath,
      body: match[2]?.trim() ?? "",
    };
  } catch {
    return null;
  }
}

export async function loadSkillsFromDir(
  dir: string
): Promise<SkillDefinition[]> {
  const skills: SkillDefinition[] = [];

  try {
    const dirStat = await stat(dir).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) return [];

    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(dir, entry.name, "SKILL.md");
      const skill = await loadSkillFromFile(skillFile);
      if (skill) skills.push(skill);
    }
  } catch {
    return [];
  }

  return skills;
}

/**
 * Discover all skills from multiple directories.
 * Later directories override earlier ones by name.
 */
export async function discoverSkills(
  dirs: string[]
): Promise<SkillDefinition[]> {
  const skillMap = new Map<string, SkillDefinition>();
  for (const dir of dirs) {
    const skills = await loadSkillsFromDir(dir);
    for (const skill of skills) {
      skillMap.set(skill.name, skill);
    }
  }
  return Array.from(skillMap.values());
}
```

- [ ] **Step 4: Run tests to verify they pass**

- [ ] **Step 5: Commit**

```bash
git add packages/skills/src/loader.ts packages/skills/test/loader.test.ts
git commit -m "feat(skills): skill loader — discover and parse SKILL.md files"
```

---

### Task 3: Eligibility Checker

**Files:**
- Create: `packages/skills/src/eligibility.ts`
- Create: `packages/skills/test/eligibility.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/skills/test/eligibility.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkEligibility, type EligibilityResult } from "../src/eligibility.js";
import type { SkillDefinition } from "@openpulse/core";

function makeSkill(overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "Test",
    location: "/tmp/test/SKILL.md",
    body: "Do stuff",
    lookback: "24h",
    requires: { bins: [], env: [] },
    ...overrides,
  };
}

describe("Eligibility", () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it("returns eligible when no requirements", async () => {
    const result = await checkEligibility(makeSkill());
    expect(result.eligible).toBe(true);
    expect(result.missing).toEqual([]);
  });

  it("returns ineligible when required binary is missing", async () => {
    const result = await checkEligibility(makeSkill({
      requires: { bins: ["nonexistent-binary-xyz"], env: [] },
    }));
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("bin: nonexistent-binary-xyz");
  });

  it("returns eligible when required binary exists", async () => {
    const result = await checkEligibility(makeSkill({
      requires: { bins: ["node"], env: [] },
    }));
    expect(result.eligible).toBe(true);
  });

  it("returns ineligible when required env var is missing", async () => {
    process.env = { ...originalEnv };
    delete process.env.NONEXISTENT_VAR;
    const result = await checkEligibility(makeSkill({
      requires: { bins: [], env: ["NONEXISTENT_VAR"] },
    }));
    expect(result.eligible).toBe(false);
    expect(result.missing).toContain("env: NONEXISTENT_VAR");
  });

  it("returns eligible when required env var is set", async () => {
    process.env = { ...originalEnv, TEST_KEY: "value" };
    const result = await checkEligibility(makeSkill({
      requires: { bins: [], env: ["TEST_KEY"] },
    }));
    expect(result.eligible).toBe(true);
  });
});
```

- [ ] **Step 2: Implement eligibility checker**

```typescript
// packages/skills/src/eligibility.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SkillDefinition } from "@openpulse/core";

const execFileAsync = promisify(execFile);

export interface EligibilityResult {
  eligible: boolean;
  missing: string[];
}

export async function checkEligibility(
  skill: SkillDefinition
): Promise<EligibilityResult> {
  const missing: string[] = [];

  // Check required binaries
  for (const bin of skill.requires.bins) {
    try {
      await execFileAsync("which", [bin], { timeout: 3000 });
    } catch {
      missing.push(`bin: ${bin}`);
    }
  }

  // Check required environment variables
  for (const env of skill.requires.env) {
    if (!process.env[env]) {
      missing.push(`env: ${env}`);
    }
  }

  return { eligible: missing.length === 0, missing };
}
```

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/eligibility.ts packages/skills/test/eligibility.test.ts
git commit -m "feat(skills): eligibility checker — verify bins on PATH and env vars"
```

---

## Phase 3: Skill Runner

### Task 4: Skill Runner — Extract Commands, Execute, Send to LLM

**Files:**
- Create: `packages/skills/src/runner.ts`
- Create: `packages/skills/test/runner.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/skills/test/runner.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "@openpulse/core";
import type { LlmProvider, SkillDefinition } from "@openpulse/core";
import { runSkill, extractShellCommands } from "../src/runner.js";

function mockProvider(response: string): LlmProvider {
  return { complete: vi.fn().mockResolvedValue(response) };
}

function makeSkill(body: string, overrides: Partial<SkillDefinition> = {}): SkillDefinition {
  return {
    name: "test-skill",
    description: "Test skill",
    location: "/tmp/test/SKILL.md",
    body,
    lookback: "24h",
    requires: { bins: [], env: [] },
    ...overrides,
  };
}

describe("extractShellCommands", () => {
  it("extracts backtick commands from numbered steps", () => {
    const body = "## Instructions\n\n1. Run `echo hello` to test\n2. Run `ls -la` for listing\n3. Review the output";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("echo hello");
    expect(cmds).toContain("ls -la");
    expect(cmds).toHaveLength(2);
  });

  it("extracts commands from code blocks", () => {
    const body = "## Instructions\n\n```bash\necho hello\n```\n\nDo stuff.";
    const cmds = extractShellCommands(body);
    expect(cmds).toContain("echo hello");
  });

  it("returns empty for body with no commands", () => {
    const cmds = extractShellCommands("Just plain text instructions.");
    expect(cmds).toEqual([]);
  });
});

describe("runSkill", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-runner-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("executes a skill and writes output to hot layer", async () => {
    const skill = makeSkill("## Instructions\n\n1. Run `echo hello world` to get data\n2. Summarize the output");
    const provider = mockProvider("## Summary\n\nHello world was echoed successfully.");

    const state = await runSkill(skill, vault, provider, "test-model");

    expect(state.lastStatus).toBe("success");
    expect(state.entriesCollected).toBe(1);

    // Check the provider was called with command output injected
    const callArgs = (provider.complete as any).mock.calls[0][0];
    expect(callArgs.prompt).toContain("hello world");

    // Check hot layer has the entry
    const today = new Date().toISOString().slice(0, 10);
    const hotContent = await readFile(vault.dailyLogPath(today), "utf-8");
    expect(hotContent).toContain("test-skill");
  });

  it("handles command failures gracefully", async () => {
    const skill = makeSkill("1. Run `nonexistent-command-xyz` to get data\n2. Summarize");
    const provider = mockProvider("No data available.");

    const state = await runSkill(skill, vault, provider, "test-model");

    // Should still complete — error is passed to LLM as context
    expect(state.lastStatus).toBe("success");
  });

  it("saves error state when LLM fails", async () => {
    const skill = makeSkill("1. Run `echo test` and summarize");
    const provider: LlmProvider = {
      complete: vi.fn().mockRejectedValue(new Error("API key invalid")),
    };

    const state = await runSkill(skill, vault, provider, "test-model");
    expect(state.lastStatus).toBe("error");
    expect(state.lastError).toContain("API key invalid");
  });
});
```

- [ ] **Step 2: Implement runner**

```typescript
// packages/skills/src/runner.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  appendActivity,
  type Vault,
  type LlmProvider,
  type SkillDefinition,
  type CollectorState,
} from "@openpulse/core";
import { saveCollectorState } from "./scheduler.js";

const execFileAsync = promisify(execFile);

/**
 * Extract shell commands from a SKILL.md body.
 * Looks for inline backtick commands in numbered steps and fenced code blocks.
 */
export function extractShellCommands(body: string): string[] {
  const commands: string[] = [];

  // Match inline backtick commands: `command args`
  const inlineRegex = /`([^`]+)`/g;
  let match;
  while ((match = inlineRegex.exec(body)) !== null) {
    const cmd = match[1].trim();
    // Filter out non-command backticks (short words, markdown formatting)
    if (cmd.includes(" ") || cmd.startsWith("/") || cmd.startsWith("$")) {
      commands.push(cmd);
    }
  }

  // Match fenced code blocks: ```bash\ncommand\n```
  const fencedRegex = /```(?:bash|sh|shell)?\n([\s\S]*?)```/g;
  while ((match = fencedRegex.exec(body)) !== null) {
    const blockCommands = match[1].trim().split("\n").filter((l) => l.trim() && !l.startsWith("#"));
    commands.push(...blockCommands);
  }

  return commands;
}

/**
 * Execute a skill: extract shell commands, pre-run them, send to LLM, write to hot.
 */
export async function runSkill(
  skill: SkillDefinition,
  vault: Vault,
  provider: LlmProvider,
  model: string
): Promise<CollectorState> {
  const now = new Date();

  try {
    // 1. Extract and pre-execute shell commands
    const commands = extractShellCommands(skill.body);
    const commandOutputs: Array<{ command: string; output: string; error?: string }> = [];

    for (const cmd of commands) {
      try {
        const { stdout, stderr } = await execFileAsync("bash", ["-c", cmd], {
          timeout: 30000,
          env: process.env,
        });
        commandOutputs.push({
          command: cmd,
          output: stdout.trim() || stderr.trim() || "(no output)",
        });
      } catch (e: any) {
        commandOutputs.push({
          command: cmd,
          output: e.stdout?.trim() || "",
          error: e.stderr?.trim() || e.message,
        });
      }
    }

    // 2. Build prompt with command outputs
    const commandContext = commandOutputs.length > 0
      ? commandOutputs
          .map((c) => `### Command: \`${c.command}\`\n${c.error ? `**Error:** ${c.error}\n` : ""}**Output:**\n${c.output}`)
          .join("\n\n")
      : "(No shell commands were executed)";

    const since = new Date(now.getTime() - parseLookback(skill.lookback));

    const systemPrompt = [
      `You are OpenPulse executing the skill "${skill.name}".`,
      `Today's date: ${now.toISOString().slice(0, 10)}`,
      `Lookback period: ${skill.lookback} (since ${since.toISOString().slice(0, 10)})`,
      "",
      "Follow the skill instructions below. The shell commands referenced in the instructions",
      "have already been executed and their outputs are provided. Synthesize these outputs into",
      "a clear, concise Markdown summary. Focus on what's actionable or status-relevant.",
    ].join("\n");

    const prompt = [
      "## Skill Instructions\n",
      skill.body,
      "\n\n## Command Outputs\n",
      commandContext,
    ].join("\n");

    // 3. Send to LLM
    const response = await provider.complete({ model, prompt, systemPrompt });

    // 4. Write to hot layer
    if (response.trim()) {
      await appendActivity(vault, {
        timestamp: now.toISOString(),
        log: response.trim(),
        theme: "auto",
        source: skill.name,
      });
    }

    // 5. Save state
    const state: CollectorState = {
      skillName: skill.name,
      lastRunAt: now.toISOString(),
      lastStatus: "success",
      entriesCollected: response.trim() ? 1 : 0,
    };
    await saveCollectorState(vault, state);
    return state;
  } catch (e: any) {
    const state: CollectorState = {
      skillName: skill.name,
      lastRunAt: now.toISOString(),
      lastStatus: "error",
      lastError: e.message,
      entriesCollected: 0,
    };
    await saveCollectorState(vault, state);
    return state;
  }
}

function parseLookback(lookback: string): number {
  const match = lookback.match(/^(\d+)(h|d|w)$/);
  if (!match) return 24 * 60 * 60 * 1000;
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

- [ ] **Step 3: Run tests, verify pass**
- [ ] **Step 4: Commit**

```bash
git add packages/skills/src/runner.ts packages/skills/test/runner.test.ts
git commit -m "feat(skills): skill runner — extract commands, pre-execute, send to LLM, write to hot"
```

---

## Phase 4: CLI, Bundled Skills, Cleanup

### Task 5: CLI Entry Point + Bundled Skills

**Files:**
- Create: `packages/skills/src/index.ts` (rewrite)
- Create: `packages/skills/builtin/google-daily-digest/SKILL.md`
- Create: `packages/skills/builtin/github-activity/SKILL.md`
- Create: `packages/skills/builtin/weekly-rollup/SKILL.md`
- Delete: `packages/skills/src/templates/` (all files)
- Delete: `packages/skills/src/auto-discover.ts`
- Delete: `packages/skills/src/orchestrator.ts`

- [ ] **Step 1: Delete old files**

```bash
rm -rf packages/skills/src/templates packages/skills/src/auto-discover.ts packages/skills/src/orchestrator.ts
rm -rf packages/skills/test/templates packages/skills/test/auto-discover.test.ts
```

- [ ] **Step 2: Create bundled skills directory and SKILL.md files**

`packages/skills/builtin/google-daily-digest/SKILL.md`:
```markdown
---
name: google-daily-digest
description: Summarize today's Gmail and Calendar activity using gogcli
schedule: "0 22 * * *"
lookback: 24h
requires:
  bins: [gog]
---

## Context

You are collecting the user's daily Google Workspace activity to produce a concise summary for the OpenPulse vault.

## Instructions

1. Run `gog gmail search 'newer_than:1d' --max 50 --json` to get today's emails
2. Run `gog calendar events list --from today --to tomorrow --json` to get today's calendar events
3. For each email thread, extract: subject, participants, key decisions or action items
4. For each calendar event, note: title, attendees, whether attended or declined
5. Group findings by theme (project names, people, topics)

## Output Format

Write the summary as a single Markdown document. Start with a date header. Focus on what's actionable or status-relevant. Skip newsletters, automated notifications, and marketing emails.
```

`packages/skills/builtin/github-activity/SKILL.md`:
```markdown
---
name: github-activity
description: Summarize recent GitHub activity — PRs, reviews, commits, and notifications
schedule: "0 18 * * 1-5"
lookback: 24h
requires:
  bins: [gh]
---

## Instructions

1. Run `gh pr list --author @me --state all --json title,state,updatedAt,url --limit 20` for your PRs
2. Run `gh pr list --search "reviewed-by:@me" --state all --json title,state,url --limit 10` for PRs you reviewed
3. Run `gh api notifications --method GET` for recent notifications
4. Summarize: PRs opened, merged, or reviewed. Issues commented on. Repos you were active in.

## Output Format

Write a concise Markdown summary organized by: PRs, Reviews, and Notable Activity.
```

`packages/skills/builtin/weekly-rollup/SKILL.md`:
```markdown
---
name: weekly-rollup
description: Synthesize all warm themes into a stakeholder-friendly weekly status summary
---

## Instructions

1. Run `ls ~/OpenPulseAI/vault/warm/*.md` to find all theme files
2. Run `cat ~/OpenPulseAI/vault/warm/*.md` to read all theme content
3. For each theme, identify key changes and status updates from the past week
4. Organize by priority — what's most important for stakeholders first
5. Write a concise weekly status update

## Output Format

# Weekly Status — [date]

## Highlights
- Top 3-5 things stakeholders should know

## By Theme
### [theme-name]
- Current status
- Key changes this week
```

- [ ] **Step 3: Rewrite CLI entry point**

```typescript
// packages/skills/src/index.ts
#!/usr/bin/env node
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Vault, loadConfig, createProvider } from "@openpulse/core";
import { discoverSkills } from "./loader.js";
import { checkEligibility } from "./eligibility.js";
import { runSkill } from "./runner.js";
import { isDue, loadCollectorState } from "./scheduler.js";

const VAULT_ROOT = process.env.OPENPULSE_VAULT ?? `${process.env.HOME}/OpenPulseAI`;
const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const args = process.argv.slice(2);
  const runName = args.includes("--run") ? args[args.indexOf("--run") + 1] : null;
  const listOnly = args.includes("--list");
  const checkOnly = args.includes("--check");

  const config = await loadConfig(VAULT_ROOT);
  const vault = new Vault(VAULT_ROOT);
  await vault.init();

  // Discover skills from builtin + user directories
  const builtinDir = join(__dirname, "..", "builtin");
  const userDir = join(VAULT_ROOT, "skills");
  const skills = await discoverSkills([builtinDir, userDir]);

  if (listOnly || checkOnly) {
    for (const skill of skills) {
      const state = await loadCollectorState(vault, skill.name);
      const elig = await checkEligibility(skill);
      const status = elig.eligible ? "eligible" : `missing: ${elig.missing.join(", ")}`;
      console.log(`${skill.name}: schedule=${skill.schedule ?? "manual"} lookback=${skill.lookback} ${status} lastRun=${state?.lastRunAt ?? "never"}`);
    }
    return;
  }

  const scheduledSkills = runName
    ? skills.filter((s) => s.name === runName)
    : skills.filter((s) => s.schedule);

  if (scheduledSkills.length === 0) {
    console.error(runName ? `[skills] Skill "${runName}" not found.` : "[skills] No scheduled skills found.");
    return;
  }

  const provider = createProvider(config);
  const now = new Date();

  for (const skill of scheduledSkills) {
    // Check eligibility
    const elig = await checkEligibility(skill);
    if (!elig.eligible) {
      console.error(`[skills] ${skill.name}: ineligible — ${elig.missing.join(", ")}`);
      continue;
    }

    // Check schedule (skip if --run forces it)
    if (!runName && skill.schedule) {
      const state = await loadCollectorState(vault, skill.name);
      if (!isDue(skill.schedule, state?.lastRunAt ?? null, now)) {
        console.error(`[skills] ${skill.name}: not due yet, skipping.`);
        continue;
      }
    }

    console.error(`[skills] Running ${skill.name}...`);
    const result = await runSkill(skill, vault, provider, config.llm.model);
    console.error(`[skills] ${skill.name}: ${result.lastStatus} (${result.entriesCollected} entries)`);
  }

  console.error("[skills] Done.");
}

main().catch((e) => { console.error("[skills] Fatal:", e); process.exit(1); });
```

- [ ] **Step 4: Build and verify**

```bash
pnpm --filter @openpulse/skills build
```

- [ ] **Step 5: Run all skills tests**

```bash
pnpm vitest run packages/skills/
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(skills): CLI entry point, bundled SKILL.md files, delete templates and auto-discover"
```

---

## Phase 5: UI Skills Page

### Task 6: Update UI — Sources → Skills

**Files:**
- Modify: `packages/ui/server.ts` — replace source endpoints with skill endpoints
- Modify: `packages/ui/src/lib/tauri-bridge.ts` — replace source types/functions with skill equivalents
- Rename: `packages/ui/src/pages/sources.ts` → `packages/ui/src/pages/skills.ts`
- Modify: `packages/ui/src/main.ts` — update route
- Modify: `packages/ui/index.html` — rename nav item
- Modify: `packages/ui/src/styles.css` — rename classes

- [ ] **Step 1: Update server.ts**

Replace all `/api/sources*` endpoints with `/api/skills*` endpoints. The key changes:

- `GET /api/skills` — scan skill directories (builtin + user `~/OpenPulseAI/skills/`), parse SKILL.md frontmatter, merge collector state, check eligibility
- `POST /api/skills/install` — run `npx skillsadd <repo>` in vault directory
- `DELETE /api/skills/:name` — remove skill directory from `~/OpenPulseAI/skills/`
- `POST /api/skills/:name/run` — run `node packages/skills/dist/index.js --run <name>`
- `GET /api/skills/:name/check` — check eligibility for a specific skill

Remove all source CRUD endpoints (POST /api/sources, PUT, DELETE) since skills are filesystem-based.

- [ ] **Step 2: Update tauri-bridge.ts**

Replace `SourceData`, `SourceInput`, and source API functions with:

```typescript
export interface SkillData {
  name: string;
  description: string;
  schedule: string | null;
  lookback: string;
  requires: { bins: string[]; env: string[] };
  eligible: boolean;
  missing: string[];
  lastRunAt: string | null;
  lastStatus: string;
  entriesCollected: number;
  lastError?: string;
  isBuiltin: boolean;
}

export async function getSkills(): Promise<SkillData[]> {
  if (isTauri) return tauriInvoke("get_skills");
  return apiGet("/skills");
}

export async function installSkill(repo: string): Promise<string> {
  if (isTauri) return tauriInvoke("install_skill", { repo });
  const result = await apiPost<{ output: string }>("/skills/install", { repo });
  return result.output;
}

export async function removeSkill(name: string): Promise<void> {
  if (isTauri) return tauriInvoke("remove_skill", { name });
  const res = await fetch(`${API_BASE}/skills/${name}`, { method: "DELETE" });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
}

export async function runSkillNow(name: string): Promise<string> {
  if (isTauri) return tauriInvoke("run_skill", { name });
  const result = await apiPost<{ output: string }>(`/skills/${name}/run`, {});
  return result.output;
}
```

Remove all `Source*` types and functions.

- [ ] **Step 3: Rename sources.ts → skills.ts and update content**

Update the page to show skills with:
- Eligibility badges (green check / red X with missing deps)
- Schedule display (human-readable or "Manual only")
- "Run Now" and "Remove" buttons (Remove only for user-installed, not builtin)
- "Install from Registry" input at top with `owner/repo` text field
- Skill cards styled with `.skill-*` classes

- [ ] **Step 4: Update main.ts — change route**

Replace `sources: renderSources` with `skills: renderSkills`, update import.

- [ ] **Step 5: Update index.html — rename nav item**

Change the Sources nav button `data-page="sources"` to `data-page="skills"` and label to "Skills".

- [ ] **Step 6: Update styles.css — rename classes**

Replace all `.source-*` classes with `.skill-*` equivalents.

- [ ] **Step 7: Build and verify**

```bash
pnpm --filter @openpulse/ui build
```

- [ ] **Step 8: Commit**

```bash
git add packages/ui/
git commit -m "feat(ui): Skills page replaces Sources — list, install from registry, run, remove"
```

---

## Phase 6: Cleanup

### Task 7: Remove Dead Code and Old Config

**Files:**
- Modify: `packages/core/src/types.ts` — remove `SourceConfig`
- Modify: `packages/core/src/config.ts` — remove `sources` parsing
- Modify: `packages/core/src/index.ts` — remove `SourceConfig` export
- Modify: `packages/core/test/config.test.ts` — remove source-related tests
- Update: `packages/skills/src/mcp-client.ts` — remove `SourceConfig` dependency (if still used, replace with inline type)

- [ ] **Step 1: Check if mcp-client.ts still needs SourceConfig**

If the MCP client is still used by future skills that connect to MCP servers, keep it but change its constructor to accept a simple `{ name, command, args, env }` object instead of `SourceConfig`.

- [ ] **Step 2: Remove SourceConfig from core types**
- [ ] **Step 3: Remove sources parsing from config.ts**
- [ ] **Step 4: Remove source tests from config.test.ts**
- [ ] **Step 5: Run full test suite**

```bash
pnpm vitest run
```

- [ ] **Step 6: Build all packages**

```bash
pnpm build
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: remove SourceConfig and sources[] config — skills are filesystem-based"
```

---

## Verification Plan

1. **Unit tests pass**: `pnpm vitest run` — all tests green
2. **Build succeeds**: `pnpm build` — all packages compile
3. **Skill discovery**: `node packages/skills/dist/index.js --list` — shows 3 bundled skills
4. **Eligibility check**: `node packages/skills/dist/index.js --check` — shows which deps are missing
5. **Skill execution**: `node packages/skills/dist/index.js --run weekly-rollup` — runs the skill, writes to hot
6. **UI Skills page**: Open Control Center, see installed skills, run one, install from registry
7. **End-to-end**: Run a skill → verify hot entry → run dream → approve → query via chat_with_pulse

---

## Task Dependency Graph

```
Task 1 (rename + types) → Task 2 (loader) → Task 3 (eligibility) → Task 4 (runner) → Task 5 (CLI + bundled) → Task 6 (UI) → Task 7 (cleanup)
```

All tasks are sequential — each builds on the previous one.
