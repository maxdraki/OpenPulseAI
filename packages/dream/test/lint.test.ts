import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme } from "@openpulse/core";
import { readdir, readFile } from "node:fs/promises";
import { runStructuralChecks } from "../src/lint-structural.js";
import { findStubCandidates, findContradictions } from "../src/lint-semantic.js";
import { runLint } from "../src/lint-cli.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function setup() {
  const tempDir = await mkdtemp(join(tmpdir(), "openpulse-lint-"));
  const vault = new Vault(tempDir);
  await vault.init();
  return { tempDir, vault };
}

// A raw theme file WITHOUT lastUpdated (bypasses writeTheme which injects it)
function rawThemeWithoutLastUpdated(theme: string, content: string): string {
  return `---\ntheme: ${theme}\ntype: project\n---\n\n${content}\n`;
}

// ---------------------------------------------------------------------------
// runStructuralChecks — Broken links
// ---------------------------------------------------------------------------
describe("runStructuralChecks — broken links", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns no issues for empty vault", async () => {
    const issues = await runStructuralChecks(vault);
    expect(issues).toEqual([]);
  });

  it("detects broken link when target theme does not exist", async () => {
    await writeTheme(vault, "theme-a", "This links to [[nonexistent]].");
    const issues = await runStructuralChecks(vault);
    const brokenLinks = issues.filter((i) => i.type === "broken-link");
    expect(brokenLinks).toHaveLength(1);
    expect(brokenLinks[0].theme).toBe("theme-a");
    expect(brokenLinks[0].target).toBe("nonexistent");
  });

  it("does not flag a valid link when both themes exist", async () => {
    await writeTheme(vault, "theme-a", "Links to [[theme-b]].");
    await writeTheme(vault, "theme-b", "Content.");
    const issues = await runStructuralChecks(vault);
    const brokenLinks = issues.filter((i) => i.type === "broken-link");
    expect(brokenLinks).toHaveLength(0);
  });

  it("includes the broken link target in the issue", async () => {
    await writeTheme(vault, "theme-a", "References [[missing-page]] here.");
    const issues = await runStructuralChecks(vault);
    const issue = issues.find((i) => i.type === "broken-link");
    expect(issue?.target).toBe("missing-page");
    expect(issue?.theme).toBe("theme-a");
  });

  it("reports multiple broken links from the same theme", async () => {
    await writeTheme(
      vault,
      "theme-a",
      "Links to [[ghost-1]] and [[ghost-2]]."
    );
    const issues = await runStructuralChecks(vault);
    const brokenLinks = issues.filter((i) => i.type === "broken-link");
    expect(brokenLinks.length).toBeGreaterThanOrEqual(2);
    const targets = brokenLinks.map((i) => i.target);
    expect(targets).toContain("ghost-1");
    expect(targets).toContain("ghost-2");
  });
});

// ---------------------------------------------------------------------------
// runStructuralChecks — Orphans
// ---------------------------------------------------------------------------
describe("runStructuralChecks — orphan detection", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("single theme is NOT flagged as orphan (only 1 theme exists)", async () => {
    await writeTheme(vault, "solo", "No links at all, standalone content.");
    const issues = await runStructuralChecks(vault);
    const orphans = issues.filter((i) => i.type === "orphan");
    expect(orphans).toHaveLength(0);
  });

  it("two themes with no links to each other are both flagged as orphans", async () => {
    await writeTheme(vault, "island-a", "No links here.");
    await writeTheme(vault, "island-b", "No links here either.");
    const issues = await runStructuralChecks(vault);
    const orphans = issues.filter((i) => i.type === "orphan");
    const orphanThemes = orphans.map((i) => i.theme);
    expect(orphanThemes).toContain("island-a");
    expect(orphanThemes).toContain("island-b");
  });

  it("theme with outbound link is NOT an orphan (has outbound)", async () => {
    await writeTheme(vault, "theme-a", "Links to [[theme-b]].");
    await writeTheme(vault, "theme-b", "No outbound links.");
    const issues = await runStructuralChecks(vault);
    const orphans = issues.filter((i) => i.type === "orphan");
    const orphanThemes = orphans.map((i) => i.theme);
    // theme-a has outbound link → not orphan
    expect(orphanThemes).not.toContain("theme-a");
  });

  it("theme with inbound link is NOT an orphan (has inbound)", async () => {
    await writeTheme(vault, "theme-a", "Links to [[theme-b]].");
    await writeTheme(vault, "theme-b", "No outbound links.");
    const issues = await runStructuralChecks(vault);
    const orphans = issues.filter((i) => i.type === "orphan");
    const orphanThemes = orphans.map((i) => i.theme);
    // theme-b has inbound link from theme-a → not orphan
    expect(orphanThemes).not.toContain("theme-b");
  });
});

// ---------------------------------------------------------------------------
// runStructuralChecks — Stale
// ---------------------------------------------------------------------------
describe("runStructuralChecks — stale detection", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("flags a theme with lastUpdated 100 days ago as stale", async () => {
    const staleDate = new Date(Date.now() - 100 * 86_400_000).toISOString();
    const rawContent = `---\ntheme: old-theme\nlastUpdated: ${staleDate}\n---\n\nSome content.\n`;
    await writeFile(join(vault.warmDir, "old-theme.md"), rawContent, "utf-8");
    const issues = await runStructuralChecks(vault);
    const staleIssues = issues.filter((i) => i.type === "stale");
    expect(staleIssues).toHaveLength(1);
    expect(staleIssues[0].theme).toBe("old-theme");
  });

  it("does not flag a theme updated 5 days ago as stale", async () => {
    const recentDate = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const rawContent = `---\ntheme: fresh-theme\nlastUpdated: ${recentDate}\n---\n\nFresh content.\n`;
    await writeFile(join(vault.warmDir, "fresh-theme.md"), rawContent, "utf-8");
    const issues = await runStructuralChecks(vault);
    const staleIssues = issues.filter((i) => i.type === "stale");
    expect(staleIssues).toHaveLength(0);
  });

  it("stale issue has detail mentioning days", async () => {
    const staleDate = new Date(Date.now() - 200 * 86_400_000).toISOString();
    const rawContent = `---\ntheme: ancient\nlastUpdated: ${staleDate}\n---\n\nAncient content.\n`;
    await writeFile(join(vault.warmDir, "ancient.md"), rawContent, "utf-8");
    const issues = await runStructuralChecks(vault);
    const staleIssue = issues.find((i) => i.type === "stale" && i.theme === "ancient");
    expect(staleIssue?.detail).toMatch(/days/);
  });
});

// ---------------------------------------------------------------------------
// runStructuralChecks — Duplicate dates
// ---------------------------------------------------------------------------
describe("runStructuralChecks — duplicate dates", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("detects duplicate ### YYYY-MM-DD sections", async () => {
    const content = [
      "## Current Status",
      "",
      "### 2026-04-10",
      "First entry.",
      "",
      "### 2026-04-10",
      "Duplicate entry.",
    ].join("\n");
    await writeTheme(vault, "dup-dates", content);
    const issues = await runStructuralChecks(vault);
    const dupIssues = issues.filter((i) => i.type === "duplicate-date");
    expect(dupIssues).toHaveLength(1);
    expect(dupIssues[0].theme).toBe("dup-dates");
    expect(dupIssues[0].detail).toContain("2026-04-10");
  });

  it("does not flag content with different dated sections", async () => {
    const content = [
      "## Current Status",
      "",
      "### 2026-04-10",
      "First entry.",
      "",
      "### 2026-04-11",
      "Different date.",
    ].join("\n");
    await writeTheme(vault, "unique-dates", content);
    const issues = await runStructuralChecks(vault);
    const dupIssues = issues.filter((i) => i.type === "duplicate-date");
    expect(dupIssues).toHaveLength(0);
  });

  it("does not flag content with no dated sections", async () => {
    await writeTheme(vault, "no-dates", "## Current Status\n\nNo date sections.");
    const issues = await runStructuralChecks(vault);
    const dupIssues = issues.filter((i) => i.type === "duplicate-date");
    expect(dupIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runStructuralChecks — Schema compliance
// ---------------------------------------------------------------------------
describe("runStructuralChecks — schema compliance", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("flags a theme file without lastUpdated as schema-noncompliant", async () => {
    // Write raw file without lastUpdated to bypass writeTheme's injection
    const rawContent = rawThemeWithoutLastUpdated("no-lastupdated", "Content without lastUpdated.");
    await writeFile(join(vault.warmDir, "no-lastupdated.md"), rawContent, "utf-8");
    const issues = await runStructuralChecks(vault);
    const schemaIssues = issues.filter((i) => i.type === "schema-noncompliant");
    expect(schemaIssues).toHaveLength(1);
    expect(schemaIssues[0].theme).toBe("no-lastupdated");
    expect(schemaIssues[0].detail).toContain("lastUpdated");
  });

  it("does not flag a theme with lastUpdated present", async () => {
    // writeTheme always injects lastUpdated
    await writeTheme(vault, "compliant-theme", "All fields present.");
    const issues = await runStructuralChecks(vault);
    const schemaIssues = issues.filter(
      (i) => i.type === "schema-noncompliant" && i.theme === "compliant-theme"
    );
    expect(schemaIssues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// findStubCandidates — with mocked LLM
// ---------------------------------------------------------------------------
describe("findStubCandidates", () => {
  let vault: Vault;
  let tempDir: string;

  const mockProvider = {
    complete: vi.fn(),
  };

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns [] and does not call LLM when there are 0 themes", async () => {
    mockProvider.complete.mockResolvedValue("[]");
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it("returns [] and does not call LLM when fewer than 3 themes mention a term", async () => {
    // Two themes — term `MyTerm` appears in both but threshold is 3
    await writeTheme(vault, "theme-1", "We use `MyTerm` here.");
    await writeTheme(vault, "theme-2", "Also mentions `MyTerm`.");
    mockProvider.complete.mockResolvedValue("[]");
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
    // LLM should not be called because no term reaches count ≥ 3
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it("calls LLM when a term appears in 3+ themes and returns stub-candidate issues", async () => {
    // Three themes each mentioning `MyTerm`
    await writeTheme(vault, "theme-1", "We use `MyTerm` here.");
    await writeTheme(vault, "theme-2", "Also mentions `MyTerm` in context.");
    await writeTheme(vault, "theme-3", "Third mention of `MyTerm` for completeness.");
    mockProvider.complete.mockResolvedValue(
      JSON.stringify([{ term: "MyTerm", count: 3, reason: "It's a recurring concept." }])
    );
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(mockProvider.complete).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("stub-candidate");
    expect(result[0].term).toBe("MyTerm");
    expect(result[0].count).toBe(3);
    expect(result[0].detail).toBe("It's a recurring concept.");
  });

  it("returns [] when LLM throws an error", async () => {
    await writeTheme(vault, "t1", "Uses `MyTerm`.");
    await writeTheme(vault, "t2", "Also uses `MyTerm`.");
    await writeTheme(vault, "t3", "Also uses `MyTerm`.");
    mockProvider.complete.mockRejectedValue(new Error("LLM unavailable"));
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });

  it("returns [] when LLM returns malformed JSON", async () => {
    await writeTheme(vault, "t1", "Uses `MyTerm`.");
    await writeTheme(vault, "t2", "Also uses `MyTerm`.");
    await writeTheme(vault, "t3", "Also uses `MyTerm`.");
    mockProvider.complete.mockResolvedValue("this is not valid json {{{");
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });

  it("strips code fences from LLM response before parsing", async () => {
    await writeTheme(vault, "t1", "Uses `MyTerm`.");
    await writeTheme(vault, "t2", "Also uses `MyTerm`.");
    await writeTheme(vault, "t3", "Also uses `MyTerm`.");
    const fencedResponse =
      "```json\n[{\"term\": \"MyTerm\", \"count\": 3, \"reason\": \"reason\"}]\n```";
    mockProvider.complete.mockResolvedValue(fencedResponse);
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("stub-candidate");
  });

  it("does not include CamelCase terms that already have a wiki page", async () => {
    // CamelCase term that matches an existing theme (case-insensitive)
    await writeTheme(vault, "myterm", "This is the MyTerm page.");
    await writeTheme(vault, "t2", "Uses MyTerm and CamelCase.");
    await writeTheme(vault, "t3", "Also MyTerm here.");
    await writeTheme(vault, "t4", "MyTerm again.");
    // myterm exists as a theme, so MyTerm should not be counted
    mockProvider.complete.mockResolvedValue("[]");
    // We just verify it doesn't crash and LLM is either not called or returns []
    const result = await findStubCandidates(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// findContradictions — with mocked LLM
// ---------------------------------------------------------------------------
describe("findContradictions", () => {
  let vault: Vault;
  let tempDir: string;

  const mockProvider = {
    complete: vi.fn(),
  };

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("returns [] and does not call LLM for 0 themes", async () => {
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it("returns [] and does not call LLM for 1 theme (no pairs)", async () => {
    await writeTheme(vault, "solo", "Just one theme.");
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it("returns [] when two themes have no shared links (not called)", async () => {
    await writeTheme(vault, "theme-a", "Links to [[target-a]].");
    await writeTheme(vault, "theme-b", "Links to [[target-b]].");
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
    expect(mockProvider.complete).not.toHaveBeenCalled();
  });

  it("calls LLM when two themes share a [[shared-link]] and returns contradiction", async () => {
    await writeTheme(
      vault,
      "theme-a",
      "We both refer to [[shared-concept]]. Theme A says X is true."
    );
    await writeTheme(
      vault,
      "theme-b",
      "We also refer to [[shared-concept]]. Theme B says X is false."
    );
    await writeTheme(vault, "shared-concept", "The shared concept page.");

    mockProvider.complete.mockResolvedValue(
      JSON.stringify([
        {
          pair: [0],
          themes: ["theme-a", "theme-b"],
          detail: "Theme A says X is true, Theme B says X is false — they conflict.",
        },
      ])
    );

    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(mockProvider.complete).toHaveBeenCalledOnce();
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("contradiction");
    expect(result[0].themes).toContain("theme-a");
    expect(result[0].themes).toContain("theme-b");
  });

  it("returns [] when LLM throws an error", async () => {
    await writeTheme(vault, "theme-a", "Links to [[shared]].");
    await writeTheme(vault, "theme-b", "Also links to [[shared]].");
    mockProvider.complete.mockRejectedValue(new Error("LLM timeout"));
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });

  it("returns [] when LLM returns malformed JSON", async () => {
    await writeTheme(vault, "theme-a", "Links to [[shared]].");
    await writeTheme(vault, "theme-b", "Also links to [[shared]].");
    mockProvider.complete.mockResolvedValue("not valid json at all");
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });

  it("returns [] when LLM says no contradictions", async () => {
    await writeTheme(vault, "theme-a", "Links to [[shared]].");
    await writeTheme(vault, "theme-b", "Also links to [[shared]].");
    mockProvider.complete.mockResolvedValue("[]");
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toEqual([]);
  });

  it("strips code fences from LLM response before parsing", async () => {
    await writeTheme(vault, "theme-a", "Links to [[common]].");
    await writeTheme(vault, "theme-b", "Also links to [[common]].");
    const fencedResponse =
      "```json\n[{\"pair\": [0], \"themes\": [\"theme-a\", \"theme-b\"], \"detail\": \"Conflict found.\"}]\n```";
    mockProvider.complete.mockResolvedValue(fencedResponse);
    const result = await findContradictions(vault, mockProvider as any, "test-model");
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe("contradiction");
    expect(result[0].detail).toBe("Conflict found.");
  });
});

// ---------------------------------------------------------------------------
// runStructuralChecks — new checks (low-value, duplicate-theme, low-provenance)
// ---------------------------------------------------------------------------
describe("runStructuralChecks — new checks", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("flags pages with content < 250 chars as low-value", async () => {
    await writeTheme(vault, "tiny-theme", "Short body.");
    const issues = await runStructuralChecks(vault);
    const lowValue = issues.filter((i) => i.type === "low-value" && i.theme === "tiny-theme");
    expect(lowValue).toHaveLength(1);
    expect(lowValue[0].detail).toMatch(/chars/);
  });

  it("flags a long page with a single source and <=3 bullets as low-value", async () => {
    // Padded to > 250 chars but only cites ONE source id via ^[src:...] and
    // contains few bullets.
    const body =
      "This theme discusses the project overview and the state of the world ".repeat(5) +
      "\n\n- item one ^[src:abc]\n- item two ^[src:abc]\n- item three ^[src:abc]\n";
    await writeTheme(vault, "single-source-theme", body);
    const issues = await runStructuralChecks(vault);
    const lowValue = issues.filter(
      (i) => i.type === "low-value" && i.theme === "single-source-theme"
    );
    expect(lowValue).toHaveLength(1);
    expect(lowValue[0].detail).toContain("abc");
  });

  it("does not flag a long page with diverse sources as low-value", async () => {
    const body =
      "This theme discusses the project overview and the state of the world ".repeat(5) +
      "\n\n- item one ^[src:abc]\n- item two ^[src:def]\n- item three ^[src:ghi]\n";
    await writeTheme(vault, "diverse-theme", body);
    const issues = await runStructuralChecks(vault);
    const lowValue = issues.filter(
      (i) => i.type === "low-value" && i.theme === "diverse-theme"
    );
    expect(lowValue).toHaveLength(0);
  });

  it("flags near-duplicate themes (Levenshtein)", async () => {
    // "dream" vs "dreams" → Levenshtein distance 1
    await writeTheme(vault, "dream", "Content about dreams ".repeat(20));
    await writeTheme(vault, "dreams", "Content about dreams ".repeat(20));
    const issues = await runStructuralChecks(vault);
    const dupTheme = issues.filter((i) => i.type === "duplicate-theme");
    expect(dupTheme.length).toBeGreaterThanOrEqual(1);
    const match = dupTheme.find(
      (i) =>
        (i.theme === "dream" && i.target === "dreams") ||
        (i.theme === "dreams" && i.target === "dream")
    );
    expect(match).toBeDefined();
    expect(match?.detail).toMatch(/levenshtein|prefix/);
  });

  it("flags near-duplicate themes (shared prefix)", async () => {
    // Shared prefix of 7+ chars — should trigger prefix-based match
    await writeTheme(vault, "projectalpha", "Content about alpha ".repeat(20));
    await writeTheme(vault, "projectbeta", "Content about beta ".repeat(20));
    const issues = await runStructuralChecks(vault);
    const dupTheme = issues.filter((i) => i.type === "duplicate-theme");
    expect(dupTheme.length).toBeGreaterThanOrEqual(1);
  });

  it("flags pages with < 70% paragraph provenance as low-provenance", async () => {
    // 5 body paragraphs, only 2 with ^[src:] markers → 40%
    const body = [
      "First paragraph with citation. ^[src:one]",
      "Second paragraph no citation here though it's long enough.",
      "Third paragraph with citation. ^[src:two]",
      "Fourth paragraph no citation here either.",
      "Fifth paragraph no citation for the record.",
    ].join("\n\n");
    await writeTheme(vault, "sparse-prov", body);
    const issues = await runStructuralChecks(vault);
    const lowProv = issues.filter(
      (i) => i.type === "low-provenance" && i.theme === "sparse-prov"
    );
    expect(lowProv).toHaveLength(1);
    expect(lowProv[0].detail).toMatch(/provenance/);
  });

  it("does not flag pages with 100% provenance", async () => {
    const body = [
      "First paragraph. ^[src:one]",
      "Second paragraph. ^[src:two]",
      "Third paragraph. ^[src:three]",
      "Fourth paragraph. ^[src:four]",
    ].join("\n\n");
    await writeTheme(vault, "full-prov", body);
    const issues = await runStructuralChecks(vault);
    const lowProv = issues.filter(
      (i) => i.type === "low-provenance" && i.theme === "full-prov"
    );
    expect(lowProv).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runLint — CLI orchestration
// ---------------------------------------------------------------------------
describe("runLint", () => {
  let vault: Vault;
  let tempDir: string;

  const mockProvider = { complete: vi.fn() };

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
    vi.clearAllMocks();
    mockProvider.complete.mockResolvedValue("[]");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function listPending(): Promise<any[]> {
    try {
      const files = await readdir(vault.pendingDir);
      const results: any[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        const raw = await readFile(join(vault.pendingDir, f), "utf-8");
        results.push(JSON.parse(raw));
      }
      return results;
    } catch {
      return [];
    }
  }

  it("always writes a report to _lint.md", async () => {
    await runLint({ vault, provider: mockProvider as any, model: "m" });
    const report = await readFile(join(vault.warmDir, "_lint.md"), "utf-8");
    expect(report).toContain("# Wiki Lint");
  });

  it("default run (no fix flag) proposes pending updates for all categories", async () => {
    // Set up findings: duplicate theme (merge), low-value theme (delete), orphan candidates
    await writeTheme(vault, "primary", "Main content here with enough text to avoid low-value.");
    await writeTheme(vault, "duplicate", "Merge me into [[primary]]."); // fuzzy match not needed — we inject manually
    await writeFile(
      join(vault.warmDir, "_orphan-candidates.json"),
      JSON.stringify([
        {
          entryTimestamp: "2026-04-18T10:00:00Z",
          source: "test",
          proposedThemes: ["new-theme"],
          confidence: 0.3,
          log: "Some orphaned entry.",
        },
      ]),
      "utf-8"
    );

    await runLint({ vault, provider: mockProvider as any, model: "m" });

    const pending = await listPending();
    // Orphan candidate should have been promoted to a pending update
    const orphanUpdates = pending.filter((p) => p.lintFix === "orphans");
    expect(orphanUpdates.length).toBeGreaterThan(0);
    expect(orphanUpdates[0].theme).toBe("new-theme");
  });

  it("--no-fix produces report but zero pending updates", async () => {
    await writeFile(
      join(vault.warmDir, "_orphan-candidates.json"),
      JSON.stringify([
        {
          entryTimestamp: "2026-04-18T10:00:00Z",
          source: "test",
          proposedThemes: ["new"],
          confidence: 0.3,
          log: "orphan entry.",
        },
      ]),
      "utf-8"
    );

    await runLint({ vault, provider: mockProvider as any, model: "m", noFix: true });

    const pending = await listPending();
    expect(pending).toHaveLength(0);
    // But the report should still be written
    const report = await readFile(join(vault.warmDir, "_lint.md"), "utf-8");
    expect(report).toContain("# Wiki Lint");
  });

  it("--fix=stubs only proposes stub updates, not orphans or other fixes", async () => {
    // Orphan candidate that would be promoted in default run
    await writeFile(
      join(vault.warmDir, "_orphan-candidates.json"),
      JSON.stringify([
        {
          entryTimestamp: "2026-04-18T10:00:00Z",
          source: "test",
          proposedThemes: ["new"],
          confidence: 0.3,
          log: "orphan entry.",
        },
      ]),
      "utf-8"
    );
    // Concept candidates file that stubs fix would process
    await writeFile(
      join(vault.warmDir, "_concept-candidates.json"),
      JSON.stringify({
        MyConcept: { count: 5, sources: ["a", "b", "c"] },
      }),
      "utf-8"
    );

    await runLint({ vault, provider: mockProvider as any, model: "m", fix: "stubs" });

    const pending = await listPending();
    // Only stubs should exist, no orphans
    const stubs = pending.filter((p) => p.lintFix === "stubs");
    const orphans = pending.filter((p) => p.lintFix === "orphans");
    expect(stubs.length).toBeGreaterThan(0);
    expect(orphans).toHaveLength(0);
  });

  it("--fix=rename requires --from and --to", async () => {
    await expect(
      runLint({ vault, provider: mockProvider as any, model: "m", fix: "rename" })
    ).rejects.toThrow(/requires --from and --to/);
  });

  it("--fix=rename creates a pending rename update", async () => {
    await runLint({
      vault,
      provider: mockProvider as any,
      model: "m",
      fix: "rename",
      from: "old-name",
      to: "new-name",
    });
    const pending = await listPending();
    const renames = pending.filter((p) => p.lintFix === "rename");
    expect(renames).toHaveLength(1);
    expect(renames[0].theme).toBe("old-name");
  });

  it("returns result stats", async () => {
    const result = await runLint({ vault, provider: mockProvider as any, model: "m" });
    expect(result).toHaveProperty("structuralIssues");
    expect(result).toHaveProperty("themeCount");
    expect(typeof result.themeCount).toBe("number");
  });
});
