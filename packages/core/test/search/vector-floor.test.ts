import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import { writeTheme } from "../../src/warm.js";
import { rebuildIndex } from "../../src/search/index-db.js";
import { searchIndex } from "../../src/search/search.js";
import { setEmbedderForTests } from "../../src/search/embeddings.js";

/**
 * I1: the hybrid vector signal must have a similarity floor. Without one,
 * every stored embedding gets *some* rank in the vector ranking no matter
 * how dissimilar to the query, so a query with zero real matches (no FTS
 * hits, near-orthogonal embedding) would still surface results via RRF.
 *
 * These vectors are hand-picked (not derived from any real model) so the
 * cosine similarity to the one stored chunk is exactly known:
 *   - stored chunk embeds to (1, 0, 0)
 *   - "belowfloorquery" embeds to (0.2, sqrt(1 - 0.04), 0) -> cos = 0.2 (< 0.30 floor)
 *   - "abovefloorquery" embeds to (0.5, sqrt(1 - 0.25), 0) -> cos = 0.5 (>= 0.30 floor)
 * Neither query word appears in the stored content, so FTS contributes
 * nothing either way — any result is entirely attributable to the vector
 * signal (and the floor gating it).
 */
function vectorFor(text: string): Float32Array {
  const lower = text.toLowerCase();
  if (lower.includes("belowfloorquery")) return new Float32Array([0.2, Math.sqrt(1 - 0.2 * 0.2), 0]);
  if (lower.includes("abovefloorquery")) return new Float32Array([0.5, Math.sqrt(1 - 0.5 * 0.5), 0]);
  return new Float32Array([1, 0, 0]);
}

describe("searchIndex — vector similarity floor (I1)", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-vector-floor-"));
    vault = new Vault(tempDir);
    await vault.init();
    setEmbedderForTests(async (texts) => texts.map(vectorFor));
    await writeTheme(vault, "marker-theme", "## Marker\n\nSome content about widgets and gadgets.");
    await rebuildIndex(vault);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    setEmbedderForTests(null);
  });

  it("returns [] when there are no FTS hits and the best vector similarity is below the floor", async () => {
    const results = await searchIndex(vault, "belowfloorquery");
    expect(results).toEqual([]);
  });

  it("still surfaces a result when the vector similarity is above the floor (no FTS overlap)", async () => {
    const results = await searchIndex(vault, "abovefloorquery");
    expect(results.find((r) => r.theme === "marker-theme")).toBeDefined();
  });
});
