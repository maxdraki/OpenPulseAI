import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import { writeTheme } from "../../src/warm.js";
import { rebuildIndex, updateThemeInIndex, removeThemeFromIndex, getAllEmbeddings } from "../../src/search/index-db.js";
import { setEmbedderForTests } from "../../src/search/embeddings.js";

/** Deterministic fake embedder: every distinct text gets a stable
 *  1-hot-ish vector derived from its length + char codes, so equality of
 *  vectors between calls is a reliable proxy for "was this text re-embedded
 *  with the same content". */
function fakeEmbedder(dim = 8) {
  const calls: string[] = [];
  const embedder = async (texts: string[]) => {
    calls.push(...texts);
    return texts.map((t) => {
      const v = new Float32Array(dim);
      for (let i = 0; i < t.length; i++) {
        v[i % dim] += t.charCodeAt(i);
      }
      return v;
    });
  };
  return { embedder, calls };
}

async function rowsFor(vault: Vault, theme: string) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(vault.searchIndexPath);
  try {
    return db.prepare("SELECT id, content_hash FROM chunks WHERE theme = ?").all(theme) as {
      id: number;
      content_hash: string;
    }[];
  } finally {
    db.close();
  }
}

async function embeddingCount(vault: Vault) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(vault.searchIndexPath);
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM embeddings").get() as { n: number };
    return row.n;
  } finally {
    db.close();
  }
}

describe("search index-db — embeddings integration", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-search-embed-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
    setEmbedderForTests(null);
  });

  it("rebuildIndex still succeeds and is FTS-only when embeddings are unavailable", async () => {
    setEmbedderForTests(null);
    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");

    await expect(rebuildIndex(vault)).resolves.toBeUndefined();
    expect((await rowsFor(vault, "a")).length).toBeGreaterThan(0);
    expect(await embeddingCount(vault)).toBe(0);
  });

  it("rebuildIndex computes and stores an embedding per unique chunk content", async () => {
    const { embedder } = fakeEmbedder();
    setEmbedderForTests(embedder);

    await writeTheme(vault, "a", "## Section\n\nSome content about widgets.");
    await rebuildIndex(vault);

    const embeddings = await getAllEmbeddings(vault);
    expect(embeddings.length).toBeGreaterThan(0);
    expect(embeddings[0].vector).toBeInstanceOf(Float32Array);
    expect(embeddings[0].vector.length).toBe(8);
  });

  it("unchanged chunks are not re-embedded on a later rebuild", async () => {
    const { embedder, calls } = fakeEmbedder();
    setEmbedderForTests(embedder);

    await writeTheme(vault, "a", "## Section\n\nStable content that will not change.");
    await rebuildIndex(vault);
    const callsAfterFirst = calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    await rebuildIndex(vault);
    expect(calls.length).toBe(callsAfterFirst); // no new embed calls for identical content
  });

  it("a changed chunk is re-embedded (new content_hash gets a new embedding)", async () => {
    const { embedder } = fakeEmbedder();
    setEmbedderForTests(embedder);

    await writeTheme(vault, "changing", "## Original\n\nThe original section content for this theme.");
    await rebuildIndex(vault);
    const before = await getAllEmbeddings(vault);

    await writeTheme(vault, "changing", "## Original\n\nA completely different section body now.");
    await updateThemeInIndex(vault, "changing");
    const after = await getAllEmbeddings(vault);

    const beforeHashes = new Set(before.map((e) => e.contentHash));
    expect(after.some((e) => !beforeHashes.has(e.contentHash))).toBe(true);
  });

  it("deleting a theme removes its embedding rows (no orphans left behind)", async () => {
    const { embedder } = fakeEmbedder();
    setEmbedderForTests(embedder);

    await writeTheme(vault, "removable", "## Section\n\nUnique content for the removable theme.");
    await rebuildIndex(vault);
    expect(await embeddingCount(vault)).toBeGreaterThan(0);

    await removeThemeFromIndex(vault, "removable");
    expect(await embeddingCount(vault)).toBe(0);
  });

  it("shared content across themes keeps its embedding until every referencing chunk is gone", async () => {
    const { embedder } = fakeEmbedder();
    setEmbedderForTests(embedder);

    const sharedBody = "## Shared\n\nThis exact section text appears in two themes.";
    await writeTheme(vault, "theme-one", sharedBody);
    await writeTheme(vault, "theme-two", sharedBody);
    await rebuildIndex(vault);
    const countAfterBoth = await embeddingCount(vault);
    expect(countAfterBoth).toBeGreaterThan(0);

    await removeThemeFromIndex(vault, "theme-one");
    // theme-two still references the same content_hash, so its embedding
    // row must survive.
    expect(await embeddingCount(vault)).toBe(countAfterBoth);

    await removeThemeFromIndex(vault, "theme-two");
    expect(await embeddingCount(vault)).toBe(0);
  });

  it("bumping the schema version triggers a drop-and-rebuild that includes the embeddings table", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(vault.searchIndexPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '2');");
    db.exec(
      "CREATE TABLE chunks (id INTEGER PRIMARY KEY, theme TEXT, heading TEXT, content_hash TEXT, tags TEXT, text TEXT);"
    );
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading, theme);");
    db.close();

    const { embedder } = fakeEmbedder();
    setEmbedderForTests(embedder);

    await writeTheme(vault, "fresh", "## Section\n\nContent indexed after the schema-version bump.");
    await expect(rebuildIndex(vault)).resolves.toBeUndefined();

    const embeddings = await getAllEmbeddings(vault);
    expect(embeddings.some((e) => e.theme === "fresh")).toBe(true);
  });
});
