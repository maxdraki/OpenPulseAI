import { describe, it, expect } from "vitest";
import { fuseRankings } from "../../src/search/search.js";

describe("fuseRankings — reciprocal rank fusion (pure)", () => {
  it("a document ranked #1 in both signals outranks one ranked #1 in only one", () => {
    const fts = new Map([
      ["both", 1],
      ["fts-only", 2],
    ]);
    const vector = new Map([
      ["both", 1],
      ["vector-only", 2],
    ]);

    const fused = fuseRankings([fts, vector]);
    const bothScore = fused.get("both")!;
    const ftsOnlyScore = fused.get("fts-only")!;
    const vectorOnlyScore = fused.get("vector-only")!;

    expect(bothScore).toBeGreaterThan(ftsOnlyScore);
    expect(bothScore).toBeGreaterThan(vectorOnlyScore);
  });

  it("matches the k=60 RRF formula exactly for a single-signal ranking", () => {
    const fts = new Map([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);

    const fused = fuseRankings([fts], 60);
    expect(fused.get("a")).toBeCloseTo(1 / 61, 10);
    expect(fused.get("b")).toBeCloseTo(1 / 62, 10);
    expect(fused.get("c")).toBeCloseTo(1 / 63, 10);
  });

  it("sums per-list contributions for a key present in both signals", () => {
    const fts = new Map([["x", 5]]);
    const vector = new Map([["x", 2]]);

    const fused = fuseRankings([fts, vector], 60);
    expect(fused.get("x")).toBeCloseTo(1 / 65 + 1 / 62, 10);
  });

  it("a document present in only the vector signal is still reachable (not dropped)", () => {
    const fts = new Map<string, number>();
    const vector = new Map([["semantic-only", 1]]);

    const fused = fuseRankings([fts, vector]);
    expect(fused.has("semantic-only")).toBe(true);
    expect(fused.get("semantic-only")).toBeGreaterThan(0);
  });

  it("empty rankings produce an empty fused map", () => {
    expect(fuseRankings([]).size).toBe(0);
    expect(fuseRankings([new Map(), new Map()]).size).toBe(0);
  });
});
