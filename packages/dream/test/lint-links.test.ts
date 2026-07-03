import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme, rebuildIndex, setEmbedderForTests } from "@openpulse/core";
import { findLinkSuggestions, LINK_SUGGESTION_THRESHOLD } from "../src/lint-links.js";

/** Deterministic fake embedder: every text maps to a fixed-size vector keyed
 *  by which "cluster" keyword it contains, so cosineSimilarity is exactly
 *  1.0 within a cluster and 0 across clusters — no flaky near-threshold math. */
function clusterEmbedder(clusterOf: (text: string) => string) {
  const dims = ["alpha", "beta", "gamma", "other"];
  return async (texts: string[]) =>
    texts.map((t) => {
      const cluster = clusterOf(t);
      const vec = new Float32Array(dims.length);
      const idx = dims.indexOf(cluster);
      vec[idx >= 0 ? idx : dims.length - 1] = 1;
      return vec;
    });
}

async function setup() {
  const tempDir = await mkdtemp(join(tmpdir(), "openpulse-lint-links-"));
  const vault = new Vault(tempDir);
  await vault.init();
  return { tempDir, vault };
}

describe("findLinkSuggestions", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    ({ vault, tempDir } = await setup());
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    setEmbedderForTests(null);
  });

  it("suggests linking two themes whose chunks are highly similar and not yet linked", async () => {
    setEmbedderForTests(
      clusterEmbedder((t) => (t.includes("Widget") ? "alpha" : "other"))
    );
    await writeTheme(vault, "widgets-project", "## Overview\n\nAll about Widget internals and design.");
    await writeTheme(vault, "widget-api", "## API\n\nThe Widget API surface and usage.");
    await rebuildIndex(vault);

    const suggestions = await findLinkSuggestions(vault);
    const forWidgetsProject = suggestions.find((s) => s.theme === "widgets-project");
    expect(forWidgetsProject).toBeDefined();
    expect(forWidgetsProject!.target).toBe("widget-api");
    expect(forWidgetsProject!.similarity).toBeGreaterThanOrEqual(LINK_SUGGESTION_THRESHOLD);
  });

  it("does not suggest a link that already exists", async () => {
    setEmbedderForTests(
      clusterEmbedder((t) => (t.includes("Widget") ? "alpha" : "other"))
    );
    await writeTheme(
      vault,
      "widgets-project",
      "## Overview\n\nAll about Widget internals. See [[widget-api]]."
    );
    await writeTheme(vault, "widget-api", "## API\n\nThe Widget API surface and usage.");
    await rebuildIndex(vault);

    const suggestions = await findLinkSuggestions(vault);
    expect(suggestions.find((s) => s.theme === "widgets-project")).toBeUndefined();
  });

  it("does not suggest a link between dissimilar themes", async () => {
    setEmbedderForTests(
      clusterEmbedder((t) => (t.includes("Widget") ? "alpha" : t.includes("Gadget") ? "beta" : "other"))
    );
    await writeTheme(vault, "widgets-project", "## Overview\n\nAll about Widget internals.");
    await writeTheme(vault, "gadgets-project", "## Overview\n\nAll about Gadget internals.");
    await rebuildIndex(vault);

    const suggestions = await findLinkSuggestions(vault);
    expect(suggestions).toEqual([]);
  });

  it("skips silently (returns []) when embeddings are unavailable", async () => {
    setEmbedderForTests(null);
    await writeTheme(vault, "theme-a", "## Section\n\nSome content about theme A.");
    await writeTheme(vault, "theme-b", "## Section\n\nSome content about theme B.");
    await rebuildIndex(vault);

    const suggestions = await findLinkSuggestions(vault);
    expect(suggestions).toEqual([]);
  });

  it("returns [] for a single-theme vault (nothing to relate)", async () => {
    setEmbedderForTests(clusterEmbedder(() => "alpha"));
    await writeTheme(vault, "solo", "## Section\n\nJust one theme.");
    await rebuildIndex(vault);

    const suggestions = await findLinkSuggestions(vault);
    expect(suggestions).toEqual([]);
  });
});
