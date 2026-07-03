import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme, rebuildIndex } from "@openpulse/core";
import { handleQueryMemory } from "../src/tools/query-memory.js";

describe("query_memory tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns no results when vault is empty", async () => {
    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("No thematic summaries found");
  });

  it("finds matching themes via ranked chunks, grouped by theme", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    await writeTheme(vault, "project-ui", "## UI\n\nReact components and styling.");

    const result = await handleQueryMemory(vault, { query: "authentication login" });
    expect(result.content[0].text).toContain("project-auth");
    expect(result.content[0].text).not.toContain("project-ui");
  });

  it("returns ranked chunks — heading and snippet, not the whole concatenated theme file", async () => {
    await writeTheme(
      vault,
      "backend",
      "## Auth Flow\n\nNode.js authentication and API routes.\n\n## Unrelated Section\n\nSomething about deployment pipelines that shouldn't match."
    );

    const result = await handleQueryMemory(vault, { query: "authentication" });
    const text = result.content[0].text;
    expect(text).toContain("## backend");
    expect(text).toContain("Auth Flow");
    // Ranked-chunk format, not a dump of the whole page.
    expect(text).not.toContain("deployment pipelines");
  });

  it("returns all themes when query matches multiple", async () => {
    await writeTheme(vault, "backend", "## Backend\n\nNode.js authentication and API routes.");
    await writeTheme(vault, "frontend", "## Frontend\n\nReact components for authentication.");

    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("backend");
    expect(result.content[0].text).toContain("frontend");
  });

  it("ranks more relevant themes first", async () => {
    // Same rough document length, but "widget" repeats in one and appears
    // only once in the other — bm25 should rank the higher-frequency match
    // first. (A single shared term is used deliberately: the index ANDs
    // multi-term queries together — see sanitizeFtsQuery — so this isn't
    // testing recall, just relative ranking of two genuine matches.)
    await writeTheme(vault, "auth-deep", "## Auth\n\nWidget widget widget appear here for testing ranking purposes on this page today.");
    await writeTheme(vault, "misc", "## Misc\n\nWidget appears here once for testing ranking purposes on this page today.");

    const result = await handleQueryMemory(vault, { query: "widget" });
    const text = result.content[0].text;
    expect(text.indexOf("auth-deep")).toBeLessThan(text.indexOf("misc"));
  });

  it("rebuilds the index once and retries when it's empty, then finds results", async () => {
    // Theme written to disk but index never built — first query attempt is empty.
    await writeTheme(vault, "fresh-theme", "## Fresh\n\nBrand new gadget content here.");

    const result = await handleQueryMemory(vault, { query: "gadget" });
    expect(result.content[0].text).toContain("fresh-theme");
  });

  it("works against an already-built index too", async () => {
    await writeTheme(vault, "widgets-theme", "## Widgets\n\nAll about widgets and gizmos.");
    await rebuildIndex(vault);

    const result = await handleQueryMemory(vault, { query: "widgets" });
    expect(result.content[0].text).toContain("widgets-theme");
  });
});

describe("query_memory — query-back (task-14 §B)", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-mcp-queryback-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  async function listPending(): Promise<any[]> {
    try {
      const files = await readdir(vault.pendingDir);
      const results: any[] = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        results.push(JSON.parse(await readFile(join(vault.pendingDir, f), "utf-8")));
      }
      return results;
    } catch {
      return [];
    }
  }

  function judgeYes(name: string) {
    return vi.fn().mockResolvedValue(
      JSON.stringify({
        verdict: "yes",
        proposed_name: name,
        one_line_definition: "A durable concept.",
        refined_content: "## Definition\n\nA durable concept.\n\n## Key Claims\n\n- Claim one\n",
      })
    );
  }

  it("does nothing when no provider is configured (no query-back call, response unaffected)", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const result = await handleQueryMemory(vault, { query: "authentication" });
    expect(result.content[0].text).toContain("project-auth");
    expect(await listPending()).toEqual([]);
  });

  it("files a pending concept page when the judge says the answer is durable", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const provider = { complete: judgeYes("auth-strategy") };

    const result = await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );

    expect(result.content[0].text).toContain("project-auth"); // response unaffected
    const pending = await listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].theme).toBe("auth-strategy");
    expect(pending[0].type).toBe("concept");
    expect(pending[0].querybackSource.question).toBe("authentication");
  });

  it("never files when the query itself matches an existing theme name (feedback-loop guard)", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const provider = { complete: judgeYes("project-auth") };

    await handleQueryMemory(
      vault,
      { query: "project-auth" },
      { provider: provider as any, model: "test-model" }
    );

    expect(await listPending()).toEqual([]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("never files when the judge's proposed name collides with an existing theme", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    await writeTheme(vault, "auth-strategy", "Already exists.");
    const provider = { complete: judgeYes("auth-strategy") };

    await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );

    expect(await listPending()).toEqual([]);
  });

  it("does not file when the judge verdict is 'no'", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const provider = {
      complete: vi.fn().mockResolvedValue(
        JSON.stringify({ verdict: "no", proposed_name: null, one_line_definition: null, refined_content: null })
      ),
    };

    await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );

    expect(await listPending()).toEqual([]);
  });

  it("never files a second pending concept page when one already exists for the same proposed theme (query-back dedup)", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const provider = { complete: judgeYes("auth-strategy") };

    // First identical query files a pending concept page.
    await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );
    expect(await listPending()).toHaveLength(1);

    // Second identical query, judge proposes the same theme again — should
    // file nothing while the first pending update still exists.
    await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );
    expect(await listPending()).toHaveLength(1);
  });

  it("judge failure never affects the query_memory response", async () => {
    await writeTheme(vault, "project-auth", "## Auth\n\nHandles login and authentication flows.");
    const provider = { complete: vi.fn().mockRejectedValue(new Error("LLM timeout")) };

    const result = await handleQueryMemory(
      vault,
      { query: "authentication" },
      { provider: provider as any, model: "test-model" }
    );

    expect(result.content[0].text).toContain("project-auth");
    expect(await listPending()).toEqual([]);
  });
});
