import { describe, it, expect, afterEach } from "vitest";
import { embedTexts, cosineSimilarity, setEmbedderForTests, EMBEDDING_DIM } from "../../src/search/embeddings.js";

describe("embeddings — embedTexts", () => {
  afterEach(() => {
    setEmbedderForTests(null);
  });

  it("returns [] for an empty batch without calling the embedder", async () => {
    let called = false;
    setEmbedderForTests(async (texts) => {
      called = true;
      return texts.map(() => new Float32Array(EMBEDDING_DIM));
    });

    expect(await embedTexts([])).toEqual([]);
    expect(called).toBe(false);
  });

  it("returns null when the injected test embedder is null (simulated unavailable)", async () => {
    setEmbedderForTests(null);
    expect(await embedTexts(["hello"])).toBeNull();
  });

  it("delegates to the injected test embedder and returns its vectors", async () => {
    setEmbedderForTests(async (texts) => texts.map((t) => new Float32Array([t.length])));

    const result = await embedTexts(["a", "bb", "ccc"]);
    expect(result).not.toBeNull();
    expect(result!.map((v) => v[0])).toEqual([1, 2, 3]);
  });

  it("degrades to null (never throws) when the injected test embedder itself throws", async () => {
    setEmbedderForTests(async () => {
      throw new Error("boom");
    });

    await expect(embedTexts(["hello"])).resolves.toBeNull();
  });
});

describe("embeddings — cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 6);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0]);
    const b = new Float32Array([0, 1]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0, 6);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([-1, -2, -3]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 6);
  });

  it("returns 0 for a zero vector rather than NaN/throwing", () => {
    const a = new Float32Array([0, 0, 0]);
    const b = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(a, b)).toBe(0);
  });
});

/**
 * Real end-to-end smoke test with the actual `Xenova/all-MiniLM-L6-v2`
 * model — downloads/loads real weights and runs real inference, so it is
 * network-dependent and slow. Skipped by default; run explicitly with:
 *
 *   OPENPULSE_EMBED_SMOKE=1 npx --yes pnpm vitest run test/search/embeddings.test.ts
 *
 * from `packages/core`.
 */
describe.skipIf(!process.env.OPENPULSE_EMBED_SMOKE)("embeddings — real model smoke test", () => {
  it(
    "embeds real text with the real transformers.js pipeline",
    async () => {
      setEmbedderForTests(undefined); // restore production (real) path
      const vectors = await embedTexts(["hello world", "a second sentence"]);
      expect(vectors).not.toBeNull();
      expect(vectors).toHaveLength(2);
      expect(vectors![0]).toHaveLength(EMBEDDING_DIM);
      // A sentence should be far closer to itself than to an unrelated one.
      const selfSim = cosineSimilarity(vectors![0], vectors![0]);
      expect(selfSim).toBeCloseTo(1, 3);
    },
    180_000
  );
});
