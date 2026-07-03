import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  normalizeFactText,
  computeFactId,
  parseFactsText,
  serializeFacts,
  readFactsFile,
  activeFacts,
  writeFactsAtomic,
  formatActiveFactsForPrompt,
  ingestFacts,
  compactFactStore,
  type StoredFact,
} from "../src/facts.js";

describe("normalizeFactText", () => {
  it("lowercases, collapses whitespace, and strips trailing punctuation", () => {
    expect(normalizeFactText("X   uses    SQLite.")).toBe("x uses sqlite");
    expect(normalizeFactText("X uses SQLite")).toBe("x uses sqlite");
    expect(normalizeFactText("  X uses SQLite!!  ")).toBe("x uses sqlite");
  });
});

describe("computeFactId", () => {
  it("produces the same id for case/whitespace/punctuation variants of the same claim + source", () => {
    const a = computeFactId("X uses SQLite.", "2026-04-01-github-activity");
    const b = computeFactId("x   uses sqlite", "2026-04-01-github-activity");
    const c = computeFactId("X uses SQLite!!", "2026-04-01-github-activity");
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it("produces different ids for different sources even with the same claim text", () => {
    const a = computeFactId("X uses SQLite.", "2026-04-01-github-activity");
    const b = computeFactId("X uses SQLite.", "2026-04-02-github-activity");
    expect(a).not.toBe(b);
  });

  it("is a 16-char hex string", () => {
    const id = computeFactId("X uses SQLite.", "src-1");
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("parseFactsText / readFactsFile", () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "facts-parse-"));
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("computes ids on read for legacy lines without an id field", async () => {
    const path = join(tempDir, "theme.jsonl");
    await writeFile(
      path,
      JSON.stringify({ claim: "X uses SQLite.", sourceId: "s1", confidence: "high", extractedAt: "2026-04-01T00:00:00Z" }) + "\n",
      "utf-8"
    );
    const facts = await readFactsFile(path);
    expect(facts).toHaveLength(1);
    expect(facts[0].id).toBe(computeFactId("X uses SQLite.", "s1"));
  });

  it("tolerates blank lines and skips unparsable ones", () => {
    const text = `${JSON.stringify({ id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" })}\n\nnot json\n${JSON.stringify({ id: "b", claim: "B", sourceId: "s1", confidence: "high", extractedAt: "t" })}\n`;
    const facts = parseFactsText(text);
    expect(facts.map((f) => f.id)).toEqual(["a", "b"]);
  });

  it("returns [] when the file does not exist", async () => {
    const facts = await readFactsFile(join(tempDir, "missing.jsonl"));
    expect(facts).toEqual([]);
  });
});

describe("activeFacts", () => {
  it("filters out facts with a supersededBy marker", () => {
    const facts: StoredFact[] = [
      { id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" },
      { id: "b", claim: "B", sourceId: "s1", confidence: "high", extractedAt: "t", supersededBy: "c", supersededAt: "t2" },
    ];
    expect(activeFacts(facts).map((f) => f.id)).toEqual(["a"]);
  });
});

describe("writeFactsAtomic", () => {
  it("writes via a tmp file that no longer exists after rename (atomic by construction)", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "facts-atomic-"));
    try {
      const path = join(tempDir, "theme.jsonl");
      const facts: StoredFact[] = [{ id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" }];
      await writeFactsAtomic(path, facts);
      const text = await readFile(path, "utf-8");
      expect(text).toContain('"claim":"A"');
      // No leftover tmp files in the directory.
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(tempDir);
      expect(entries).toEqual(["theme.jsonl"]);
    } finally {
      await rm(tempDir, { recursive: true });
    }
  });
});

describe("formatActiveFactsForPrompt", () => {
  it("renders active facts as compact id: claim lines", () => {
    const facts: StoredFact[] = [
      { id: "a", claim: "A happened", sourceId: "s1", confidence: "high", extractedAt: "t" },
      { id: "b", claim: "B happened", sourceId: "s1", confidence: "high", extractedAt: "t", supersededBy: "z", supersededAt: "t2" },
    ];
    const text = formatActiveFactsForPrompt(facts);
    expect(text).toContain("a: A happened");
    expect(text).not.toContain("B happened");
  });

  it("renders a placeholder when there are no active facts", () => {
    expect(formatActiveFactsForPrompt([])).toBe("(none yet)");
  });
});

describe("ingestFacts", () => {
  let tempDir: string;
  let path: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "facts-ingest-"));
    path = join(tempDir, "theme.jsonl");
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("appends new facts on first ingest", async () => {
    const result = await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s1", confidence: "high" }]);
    expect(result).toEqual({ added: 1, skipped: 0, superseded: 0, unknownSupersedeIds: [] });
    const facts = await readFactsFile(path);
    expect(facts).toHaveLength(1);
    expect(facts[0].claim).toBe("X uses SQLite.");
  });

  it("skips a duplicate fact re-ingested later (same normalized claim + source)", async () => {
    await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s1", confidence: "high" }]);
    const result = await ingestFacts(path, [{ claim: "x   uses sqlite!!", sourceId: "s1", confidence: "medium" }]);
    expect(result.added).toBe(0);
    expect(result.skipped).toBe(1);
    const facts = await readFactsFile(path);
    expect(facts).toHaveLength(1);
  });

  it("skips duplicates within the same ingest batch", async () => {
    const result = await ingestFacts(path, [
      { claim: "X uses SQLite.", sourceId: "s1", confidence: "high" },
      { claim: "x uses sqlite", sourceId: "s1", confidence: "high" },
    ]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(1);
  });

  it("does not dedupe the same claim text from a different source", async () => {
    await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s1", confidence: "high" }]);
    const result = await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s2", confidence: "high" }]);
    expect(result.added).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("applies supersession when a new fact references an existing active fact id", async () => {
    await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s1", confidence: "high" }]);
    const [existing] = await readFactsFile(path);

    const result = await ingestFacts(path, [
      { claim: "X migrated to Postgres.", sourceId: "s2", confidence: "high", supersedes: [existing.id] },
    ]);
    expect(result.added).toBe(1);
    expect(result.superseded).toBe(1);
    expect(result.unknownSupersedeIds).toEqual([]);

    const facts = await readFactsFile(path);
    const old = facts.find((f) => f.id === existing.id)!;
    const fresh = facts.find((f) => f.claim === "X migrated to Postgres.")!;
    expect(old.supersededBy).toBe(fresh.id);
    expect(old.supersededAt).toBeTruthy();
    // History preserved — never deleted.
    expect(facts).toHaveLength(2);
  });

  it("guards against a fact superseding itself", async () => {
    // A malicious/confused candidate lists its own (not-yet-known) id — since
    // the id is computed only after ingest, this exercises referencing the id
    // that WILL be assigned to it, which must be ignored, not applied.
    const claim = "X uses SQLite.";
    const selfId = computeFactId(claim, "s1");
    const result = await ingestFacts(path, [{ claim, sourceId: "s1", confidence: "high", supersedes: [selfId] }]);
    expect(result.superseded).toBe(0);
    expect(result.unknownSupersedeIds).toContain(selfId);
    const facts = await readFactsFile(path);
    expect(facts[0].supersededBy).toBeUndefined();
  });

  it("ignores unknown supersede ids and logs them without failing ingest", async () => {
    const result = await ingestFacts(path, [
      { claim: "X migrated to Postgres.", sourceId: "s2", confidence: "high", supersedes: ["doesnotexist1234"] },
    ]);
    expect(result.added).toBe(1);
    expect(result.superseded).toBe(0);
    expect(result.unknownSupersedeIds).toEqual(["doesnotexist1234"]);
  });

  it("rewrites the file atomically (via tmp+rename) when supersession is applied", async () => {
    await ingestFacts(path, [{ claim: "X uses SQLite.", sourceId: "s1", confidence: "high" }]);
    const [existing] = await readFactsFile(path);
    await ingestFacts(path, [
      { claim: "X migrated to Postgres.", sourceId: "s2", confidence: "high", supersedes: [existing.id] },
    ]);
    const { readdir } = await import("node:fs/promises");
    const entries = await readdir(tempDir);
    // No leftover .tmp artifacts — confirms the write went through tmp+rename.
    expect(entries).toEqual(["theme.jsonl"]);
  });
});

describe("compactFactStore", () => {
  let tempDir: string;
  let path: string;
  let archivePath: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "facts-compact-"));
    path = join(tempDir, "theme.jsonl");
    archivePath = join(tempDir, "theme.archive.jsonl");
  });
  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns null (no-op) when under the threshold", async () => {
    await writeFactsAtomic(path, [{ id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" }]);
    const result = await compactFactStore(path, archivePath, { maxLines: 300, maxBytes: 100 * 1024 });
    expect(result).toBeNull();
  });

  it("archives superseded facts and keeps only active facts in the live file once over threshold", async () => {
    const facts: StoredFact[] = [
      { id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" },
      { id: "b", claim: "B", sourceId: "s1", confidence: "high", extractedAt: "t", supersededBy: "c", supersededAt: "t2" },
      { id: "c", claim: "C", sourceId: "s1", confidence: "high", extractedAt: "t2" },
    ];
    await writeFactsAtomic(path, facts);

    const result = await compactFactStore(path, archivePath, { maxLines: 2, maxBytes: 100 * 1024 });
    expect(result).toEqual({ archived: 1, kept: 2 });

    const live = await readFactsFile(path);
    expect(live.map((f) => f.id).sort()).toEqual(["a", "c"]);

    const archived = await readFactsFile(archivePath);
    expect(archived.map((f) => f.id)).toEqual(["b"]);
  });

  it("appends to an existing archive rather than overwriting it", async () => {
    await writeFactsAtomic(archivePath, [{ id: "z", claim: "Z", sourceId: "s0", confidence: "high", extractedAt: "t0" }]);
    const facts: StoredFact[] = [
      { id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" },
      { id: "b", claim: "B", sourceId: "s1", confidence: "high", extractedAt: "t", supersededBy: "c", supersededAt: "t2" },
      { id: "c", claim: "C", sourceId: "s1", confidence: "high", extractedAt: "t2" },
    ];
    await writeFactsAtomic(path, facts);

    await compactFactStore(path, archivePath, { maxLines: 2, maxBytes: 100 * 1024 });
    const archived = await readFactsFile(archivePath);
    expect(archived.map((f) => f.id).sort()).toEqual(["b", "z"]);
  });

  it("never drops content — total fact count is preserved across live + archive", async () => {
    const facts: StoredFact[] = [
      { id: "a", claim: "A", sourceId: "s1", confidence: "high", extractedAt: "t" },
      { id: "b", claim: "B", sourceId: "s1", confidence: "high", extractedAt: "t", supersededBy: "c", supersededAt: "t2" },
      { id: "c", claim: "C", sourceId: "s1", confidence: "high", extractedAt: "t2" },
    ];
    await writeFactsAtomic(path, facts);
    await compactFactStore(path, archivePath, { maxLines: 2, maxBytes: 100 * 1024 });

    const live = await readFactsFile(path);
    const archived = await readFactsFile(archivePath);
    expect(live.length + archived.length).toBe(3);
  });

  it("returns null when the file does not exist", async () => {
    const result = await compactFactStore(path, archivePath);
    expect(result).toBeNull();
  });
});
