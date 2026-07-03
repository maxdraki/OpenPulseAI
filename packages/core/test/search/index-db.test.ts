import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault } from "../../src/vault.js";
import { writeTheme } from "../../src/warm.js";
import {
  rebuildIndex,
  updateThemeInIndex,
  removeThemeFromIndex,
  queryIndex,
} from "../../src/search/index-db.js";
import { sanitizeFtsQuery } from "../../src/search/sanitize.js";

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

describe("search index-db", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-search-index-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("rebuildIndex indexes every warm theme, skipping _pending/index/log", async () => {
    await writeTheme(vault, "project-auth", "## Overview\n\nAuthentication work.");
    await writeTheme(vault, "hiring", "## Candidates\n\nSeveral candidates in the pipeline.");

    await rebuildIndex(vault);

    const q = sanitizeFtsQuery("authentication");
    const rows = await queryIndex(vault, q, 10);
    expect(rows.some((r) => r.theme === "project-auth")).toBe(true);
  });

  it("rebuildIndex is a full wipe-and-reindex (stale theme rows disappear if the theme file is gone)", async () => {
    await writeTheme(vault, "gone-theme", "## Section\n\nThis theme will vanish before the next rebuild.");
    await rebuildIndex(vault);
    let rows = await rowsFor(vault, "gone-theme");
    expect(rows.length).toBeGreaterThan(0);

    await rm(vault.themeFilePath("gone-theme"));
    await rebuildIndex(vault);
    rows = await rowsFor(vault, "gone-theme");
    expect(rows).toHaveLength(0);
  });

  it("updateThemeInIndex adds a new theme incrementally", async () => {
    await writeTheme(vault, "a", "## A\n\nFirst theme content goes here for indexing.");
    await rebuildIndex(vault);

    await writeTheme(vault, "b", "## B\n\nSecond theme content added incrementally afterward.");
    await updateThemeInIndex(vault, "b");

    const rows = await rowsFor(vault, "b");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("updateThemeInIndex is a no-op (same row ids) when the theme content hasn't changed", async () => {
    await writeTheme(vault, "stable", "## Stable\n\nContent that will not change between calls.");
    await rebuildIndex(vault);

    const before = await rowsFor(vault, "stable");
    await updateThemeInIndex(vault, "stable");
    const after = await rowsFor(vault, "stable");

    expect(after.map((r) => r.id).sort()).toEqual(before.map((r) => r.id).sort());
    expect(after.map((r) => r.content_hash).sort()).toEqual(before.map((r) => r.content_hash).sort());
  });

  it("updateThemeInIndex applies only the delta when a theme is modified", async () => {
    await writeTheme(vault, "changing", "## Original\n\nThe original section content for this theme.");
    await rebuildIndex(vault);
    const before = await rowsFor(vault, "changing");

    await writeTheme(vault, "changing", "## Original\n\nA completely different section body now.");
    await updateThemeInIndex(vault, "changing");
    const after = await rowsFor(vault, "changing");

    expect(after.length).toBe(1);
    expect(after[0].content_hash).not.toBe(before[0].content_hash);
  });

  it("removeThemeFromIndex deletes all chunks for a theme", async () => {
    await writeTheme(vault, "removable", "## Section\n\nContent that will be removed from the index.");
    await rebuildIndex(vault);
    expect((await rowsFor(vault, "removable")).length).toBeGreaterThan(0);

    await removeThemeFromIndex(vault, "removable");
    expect(await rowsFor(vault, "removable")).toHaveLength(0);
  });

  it("recovers from a corrupt DB file by deleting and rebuilding it", async () => {
    await writeTheme(vault, "recoverable", "## Section\n\nContent for the corrupt-db recovery test.");
    await writeFile(vault.searchIndexPath, "this is not a sqlite database file", "utf-8");

    await expect(rebuildIndex(vault)).resolves.toBeUndefined();

    const rows = await rowsFor(vault, "recoverable");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("schema-version mismatch triggers a drop-and-rebuild instead of throwing", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(vault.searchIndexPath);
    db.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '0');");
    // Old/incompatible shape: no `tags` column at all.
    db.exec("CREATE TABLE chunks (id INTEGER PRIMARY KEY, theme TEXT, heading TEXT, text TEXT);");
    db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading, theme);");
    db.close();

    await writeTheme(vault, "fresh", "## Section\n\nContent indexed after the schema-version bump.");
    await expect(rebuildIndex(vault)).resolves.toBeUndefined();

    const rows = await rowsFor(vault, "fresh");
    expect(rows.length).toBeGreaterThan(0);
  });

  it("queryIndex returns [] for an empty sanitized query without touching the DB", async () => {
    const rows = await queryIndex(vault, "", 10);
    expect(rows).toEqual([]);
  });

  it("degrades instead of throwing when another connection holds an exclusive write lock on the DB", async () => {
    // Establish the schema/file first so the locker connection opens the
    // same on-disk WAL-mode database as the module under test.
    await writeTheme(vault, "locked-theme", "## Section\n\nContent written before the lock is taken.");
    await rebuildIndex(vault);
    const before = await rowsFor(vault, "locked-theme");
    expect(before.length).toBeGreaterThan(0);

    const { DatabaseSync } = await import("node:sqlite");
    const locker = new DatabaseSync(vault.searchIndexPath);
    // Force the OS-level exclusive lock to actually engage (not just the
    // WAL "writer" lock, which does not block readers) by combining
    // EXCLUSIVE locking mode with an in-progress write transaction —
    // this is what makes even plain reads see SQLITE_BUSY/"database is
    // locked", mirroring cross-process contention.
    locker.exec("PRAGMA locking_mode = EXCLUSIVE;");
    locker.exec("BEGIN IMMEDIATE;");
    locker.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("probe", "1");

    try {
      await expect(rebuildIndex(vault)).resolves.toBeUndefined();
      await expect(updateThemeInIndex(vault, "locked-theme")).resolves.toBeUndefined();

      const q = sanitizeFtsQuery("content");
      await expect(queryIndex(vault, q, 10)).resolves.toEqual([]);
    } finally {
      locker.exec("ROLLBACK;");
      locker.close();
    }

    // Once the lock is released, normal operation resumes and the data
    // that existed before contention was never corrupted/wiped.
    const rows = await rowsFor(vault, "locked-theme");
    expect(rows.length).toBeGreaterThan(0);
  }, 20000);

  it("keys the incremental diff on (heading, contentHash) so a heading rename is seen as a change", async () => {
    await writeTheme(vault, "renamed", "## Old Heading\n\nThe body text stays exactly the same.");
    await rebuildIndex(vault);

    await writeTheme(vault, "renamed", "## New Heading\n\nThe body text stays exactly the same.");
    await updateThemeInIndex(vault, "renamed");

    const q = sanitizeFtsQuery("New Heading");
    const rows = await queryIndex(vault, q, 10);
    expect(rows.some((r) => r.heading === "New Heading")).toBe(true);
    expect(rows.some((r) => r.heading === "Old Heading")).toBe(false);
  });
});
