/**
 * SQLite FTS5-backed search index over warm theme chunks (see
 * `search/chunker.ts`). The index lives at `vault/.search-index.sqlite` and
 * is entirely disposable — deleting it just means the next call rebuilds
 * from the warm themes, so there are no migrations, only a schema-version
 * check that drops and recreates the schema on mismatch.
 *
 * Schema: a plain (non-external-content) FTS5 table `chunks_fts(text,
 * heading, theme)` that stores its own copy of the indexed columns, plus a
 * `chunks` table holding the same rowid-aligned metadata (theme, heading,
 * content_hash, tags, raw text) needed to reconstruct results and diff
 * incremental updates. A default (non contentless, non external-content)
 * FTS5 table was chosen over `content=<table>` specifically so
 * `snippet()`/`bm25()` work without extra trigger plumbing — the index is
 * small and disposable, so the duplicated on-disk text is an acceptable
 * trade for simplicity. Rows in `chunks` and `chunks_fts` share the same
 * `rowid`/`id`, kept in sync manually in application code (no DB triggers).
 *
 * Graceful degradation is mandatory: `node:sqlite` may be unavailable
 * (older Node) or the DB file may be corrupt. Every public function here
 * logs a warning at most once per distinct failure message and returns an
 * empty/no-op result — it must never throw and crash a caller. A corrupt
 * DB file is deleted and rebuilt fresh on the next write.
 */
import { mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { vaultLog } from "../logger.js";
import { listThemes } from "../warm.js";
import type { Vault } from "../vault.js";
import { chunkTheme, type Chunk } from "./chunker.js";
import { embedTexts, EMBEDDING_MODEL } from "./embeddings.js";

const SCHEMA_VERSION = 3;

/** How long a connection waits for a lock held by another connection
 *  (same process or another) before SQLite gives up and raises
 *  SQLITE_BUSY/"database is locked". Set on every open so transient
 *  cross-process contention (another writer mid-transaction) just waits
 *  instead of immediately failing the caller. */
const BUSY_TIMEOUT_MS = 3000;

/** Recognizes SQLite's "busy"/"locked" family of errors (SQLITE_BUSY = 5,
 *  SQLITE_LOCKED = 6, plus the string forms node:sqlite surfaces) so they
 *  can be treated as transient contention — never as file corruption, and
 *  never rethrown to a caller. */
function isBusyOrLockedError(e: unknown): boolean {
  const errcode = (e as { errcode?: number } | null)?.errcode;
  if (errcode === 5 || errcode === 6) return true;
  const message = e instanceof Error ? e.message : String(e);
  return /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i.test(message);
}

type NodeSqliteModule = typeof import("node:sqlite");
type DatabaseSyncCtor = NodeSqliteModule["DatabaseSync"];
export type DatabaseSyncInstance = InstanceType<DatabaseSyncCtor>;

const warnedMessages = new Set<string>();

async function warnOnce(message: string, detail?: string): Promise<void> {
  if (warnedMessages.has(message)) return;
  warnedMessages.add(message);
  console.warn(`[search-index] ${message}${detail ? `: ${detail}` : ""}`);
  try {
    await vaultLog("warn", `[search-index] ${message}`, detail);
  } catch {
    // vaultLog never throws, but belt-and-braces: logging must never itself
    // become a fatal error for a search-index caller.
  }
}

/** `null` once confirmed missing — short-circuits every subsequent call in
 *  this process without re-attempting the (relatively expensive) import. */
let sqliteCtor: DatabaseSyncCtor | null | undefined;

async function getDatabaseSyncCtor(): Promise<DatabaseSyncCtor | null> {
  if (sqliteCtor !== undefined) return sqliteCtor;
  try {
    const mod = await import("node:sqlite");
    sqliteCtor = mod.DatabaseSync;
  } catch (e) {
    sqliteCtor = null;
    await warnOnce(
      "node:sqlite unavailable — search index disabled for this process",
      e instanceof Error ? e.message : String(e)
    );
  }
  return sqliteCtor;
}

/** Drops and recreates the schema when the stored version doesn't match
 *  `SCHEMA_VERSION` (including a brand-new, empty DB file). Disposability
 *  means this is simpler than writing a migration path. */
function ensureSchema(db: DatabaseSyncInstance): void {
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);");

  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  if (row && Number(row.value) === SCHEMA_VERSION) return;

  db.exec("DROP TABLE IF EXISTS chunks_fts;");
  db.exec("DROP TABLE IF EXISTS chunks;");
  db.exec("DROP TABLE IF EXISTS embeddings;");
  db.exec(`
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      theme TEXT NOT NULL,
      heading TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      tags TEXT NOT NULL,
      text TEXT NOT NULL
    );
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_chunks_theme ON chunks(theme);");
  db.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(text, heading, theme);");
  db.exec(`
    CREATE TABLE embeddings (
      content_hash TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      model TEXT NOT NULL,
      dim INTEGER NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(String(SCHEMA_VERSION));
}

/** Opens the index DB, deleting and recreating the file once if it turns
 *  out to be corrupt (e.g. `new DatabaseSync()` throws on a non-SQLite
 *  file). Returns `null` (never throws) if `node:sqlite` is unavailable or
 *  the file is unusable even after a fresh start.
 *
 *  Busy/locked errors (another connection — same process or a different
 *  one — mid-transaction) are deliberately NOT treated as corruption: with
 *  `busy_timeout` set, they only surface once the timeout has already been
 *  exhausted, and deleting a perfectly healthy but momentarily-contended
 *  index file would destroy it for no reason. Those errors bubble up to
 *  `withIndexDb`, which degrades gracefully instead. */
async function openIndexDb(vault: Vault): Promise<DatabaseSyncInstance | null> {
  const Ctor = await getDatabaseSyncCtor();
  if (!Ctor) return null;

  await mkdir(dirname(vault.searchIndexPath), { recursive: true });

  try {
    const db = new Ctor(vault.searchIndexPath);
    try {
      ensureSchema(db);
    } catch (e) {
      if (isBusyOrLockedError(e)) {
        db.close();
        throw e;
      }
      throw e;
    }
    return db;
  } catch (e) {
    if (isBusyOrLockedError(e)) {
      await warnOnce(
        "search index busy — another connection holds a lock; degrading for this call",
        e instanceof Error ? e.message : String(e)
      );
      return null;
    }

    await warnOnce(
      "search index file unusable — deleting and rebuilding",
      e instanceof Error ? e.message : String(e)
    );
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      try {
        await unlink(`${vault.searchIndexPath}${suffix}`);
      } catch {
        // fine if it never existed
      }
    }
    try {
      const db = new Ctor(vault.searchIndexPath);
      ensureSchema(db);
      return db;
    } catch (e2) {
      await warnOnce(
        "search index unusable even after rebuild — search disabled for this call",
        e2 instanceof Error ? e2.message : String(e2)
      );
      return null;
    }
  }
}

/** Opens the index DB, runs `fn`, and always closes the handle afterward —
 *  no long-lived global connection (SQLite's own WAL locking handles
 *  cross-process concurrency). Returns `null` (without calling `fn`) when
 *  the index is unavailable, and also catches any error `fn` throws (e.g.
 *  SQLITE_BUSY on a write that outlasted `busy_timeout`) so contention
 *  degrades the same way for every caller: writers no-op, readers see `[]`,
 *  nobody crashes. */
async function withIndexDb<T>(
  vault: Vault,
  fn: (db: DatabaseSyncInstance) => T | Promise<T>
): Promise<T | null> {
  const db = await openIndexDb(vault);
  if (!db) return null;
  try {
    return await fn(db);
  } catch (e) {
    await warnOnce(
      "search index operation failed — degrading for this call",
      e instanceof Error ? e.message : String(e)
    );
    return null;
  } finally {
    try {
      db.close();
    } catch {
      // best-effort close; nothing more we can do if it also fails
    }
  }
}

function insertChunks(db: DatabaseSyncInstance, chunks: Chunk[]): void {
  const insertChunk = db.prepare(
    "INSERT INTO chunks (theme, heading, content_hash, tags, text) VALUES (?, ?, ?, ?, ?)"
  );
  const insertFts = db.prepare(
    "INSERT INTO chunks_fts (rowid, text, heading, theme) VALUES (?, ?, ?, ?)"
  );
  for (const chunk of chunks) {
    const result = insertChunk.run(
      chunk.theme,
      chunk.heading,
      chunk.contentHash,
      JSON.stringify(chunk.tags),
      chunk.text
    );
    insertFts.run(result.lastInsertRowid, chunk.text, chunk.heading, chunk.theme);
  }
}

function deleteChunksByIds(db: DatabaseSyncInstance, ids: (number | bigint)[]): void {
  if (ids.length === 0) return;
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?");
  const deleteFts = db.prepare("DELETE FROM chunks_fts WHERE rowid = ?");
  for (const id of ids) {
    deleteFts.run(id);
    deleteChunk.run(id);
  }
}

/** Converts a `Float32Array` to a copyable `Uint8Array` BLOB for storage. */
function float32ArrayToBuffer(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength).slice();
}

/** Converts a BLOB read back from SQLite into a `Float32Array`, copying
 *  into a freshly allocated, correctly aligned buffer first — the bytes
 *  handed back by `node:sqlite` are not guaranteed to start at a 4-byte
 *  aligned offset within their backing `ArrayBuffer`. */
function bufferToFloat32Array(buf: Uint8Array): Float32Array {
  const copy = new Uint8Array(buf.byteLength);
  copy.set(buf);
  return new Float32Array(copy.buffer);
}

/** Computes and stores embeddings for every content_hash present in
 *  `chunks` that isn't already in the `embeddings` table — unchanged
 *  chunks (same content_hash as before) are never re-embedded. No-ops
 *  silently (index stays FTS-only) when embeddings are unavailable; never
 *  throws — a failure here must never fail the caller's rebuild/update. */
async function syncEmbeddings(db: DatabaseSyncInstance, chunks: Chunk[]): Promise<void> {
  try {
    const uniqueHashes = Array.from(new Set(chunks.map((c) => c.contentHash)));
    if (uniqueHashes.length === 0) return;

    const placeholders = uniqueHashes.map(() => "?").join(",");
    const existing = new Set(
      (
        db
          .prepare(`SELECT content_hash FROM embeddings WHERE content_hash IN (${placeholders})`)
          .all(...uniqueHashes) as { content_hash: string }[]
      ).map((r) => r.content_hash)
    );

    const missingHashes = uniqueHashes.filter((h) => !existing.has(h));
    if (missingHashes.length === 0) return;

    const textByHash = new Map<string, string>();
    for (const c of chunks) {
      if (!textByHash.has(c.contentHash)) textByHash.set(c.contentHash, `${c.heading}\n\n${c.text}`);
    }

    const texts = missingHashes.map((h) => textByHash.get(h) ?? "");
    const vectors = await embedTexts(texts);
    if (!vectors) return; // embeddings unavailable — index stays FTS-only

    const insert = db.prepare(
      "INSERT INTO embeddings (content_hash, vector, model, dim) VALUES (?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING"
    );
    for (let i = 0; i < missingHashes.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      insert.run(missingHashes[i], float32ArrayToBuffer(vec), EMBEDDING_MODEL, vec.length);
    }
  } catch (e) {
    await warnOnce(
      "embeddings sync failed — index stays FTS-only for this call",
      e instanceof Error ? e.message : String(e)
    );
  }
}

/** Deletes any embedding row whose content_hash is no longer referenced by
 *  any row in `chunks` — run after any delete so removed/renamed chunks
 *  don't leave orphaned vectors behind. Content shared verbatim across
 *  multiple chunks (same content_hash) keeps its embedding until every
 *  referencing chunk is gone. */
function pruneOrphanedEmbeddings(db: DatabaseSyncInstance): void {
  db.exec("DELETE FROM embeddings WHERE content_hash NOT IN (SELECT DISTINCT content_hash FROM chunks)");
}

/** Reads a warm theme's raw file (frontmatter included — `chunkTheme` strips
 *  it) and chunks it. Returns `[]` if the file can't be read (e.g. it was
 *  deleted between listing and reading). */
async function readAndChunkTheme(vault: Vault, theme: string): Promise<Chunk[]> {
  try {
    const raw = await readFile(vault.themeFilePath(theme), "utf-8");
    return chunkTheme(theme, raw);
  } catch {
    return [];
  }
}

/** Full rebuild from every warm theme (skips `_`-prefixed files, `index.md`,
 *  `log.md` — same filtering as `listThemes`). No-ops silently if the index
 *  is unavailable. */
export async function rebuildIndex(vault: Vault): Promise<void> {
  const themes = await listThemes(vault);
  const allChunks: Chunk[] = [];
  for (const theme of themes) {
    allChunks.push(...(await readAndChunkTheme(vault, theme)));
  }

  await withIndexDb(vault, async (db) => {
    db.exec("BEGIN");
    try {
      db.exec("DELETE FROM chunks");
      db.exec("DELETE FROM chunks_fts");
      insertChunks(db, allChunks);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    await syncEmbeddings(db, allChunks);
    pruneOrphanedEmbeddings(db);
  });
}

/** Incremental re-index of a single theme: re-chunks it, diffs by
 *  `contentHash` against what's already stored for that theme, and applies
 *  only the delta (unchanged chunks are left alone — no delete+reinsert). */
export async function updateThemeInIndex(vault: Vault, theme: string): Promise<void> {
  const newChunks = await readAndChunkTheme(vault, theme);

  await withIndexDb(vault, async (db) => {
    const existing = db
      .prepare("SELECT id, content_hash FROM chunks WHERE theme = ?")
      .all(theme) as { id: number; content_hash: string }[];

    // Multiset diff by contentHash: match one existing row per new chunk
    // with the same hash (keep = no-op), delete leftover existing rows,
    // insert leftover new chunks.
    const existingByHash = new Map<string, number[]>();
    for (const row of existing) {
      const list = existingByHash.get(row.content_hash) ?? [];
      list.push(row.id);
      existingByHash.set(row.content_hash, list);
    }

    const toInsert: Chunk[] = [];
    for (const chunk of newChunks) {
      const candidates = existingByHash.get(chunk.contentHash);
      if (candidates && candidates.length > 0) {
        candidates.shift(); // this existing row satisfies this new chunk — keep it
      } else {
        toInsert.push(chunk);
      }
    }

    const toDeleteIds = Array.from(existingByHash.values()).flat();

    db.exec("BEGIN");
    try {
      deleteChunksByIds(db, toDeleteIds);
      insertChunks(db, toInsert);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    await syncEmbeddings(db, newChunks);
    pruneOrphanedEmbeddings(db);
  });
}

/** Removes every chunk belonging to `theme` — for deletes/renames. */
export async function removeThemeFromIndex(vault: Vault, theme: string): Promise<void> {
  await withIndexDb(vault, (db) => {
    const ids = (db.prepare("SELECT id FROM chunks WHERE theme = ?").all(theme) as { id: number }[]).map(
      (r) => r.id
    );
    db.exec("BEGIN");
    try {
      deleteChunksByIds(db, ids);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    pruneOrphanedEmbeddings(db);
  });
}

export interface RawSearchRow {
  theme: string;
  heading: string;
  snippet: string;
  score: number;
  contentHash: string;
}

/** Runs a sanitized FTS5 MATCH query and returns raw ranked rows (ranking
 *  logic — weighting, sanitization — lives in `search.ts`; this is just the
 *  SQL). Returns `[]` if the index is unavailable or the query is empty. */
export async function queryIndex(
  vault: Vault,
  sanitizedQuery: string,
  limit: number
): Promise<RawSearchRow[]> {
  if (!sanitizedQuery) return [];

  const rows = await withIndexDb(vault, (db) => {
    return db
      .prepare(
        `SELECT c.theme AS theme, c.heading AS heading, c.content_hash AS contentHash,
                snippet(chunks_fts, 0, '[', ']', '...', 12) AS snippet,
                bm25(chunks_fts, 1.0, 5.0, 5.0) AS score
         FROM chunks_fts
         JOIN chunks c ON c.id = chunks_fts.rowid
         WHERE chunks_fts MATCH ?
         ORDER BY score ASC
         LIMIT ?`
      )
      .all(sanitizedQuery, limit) as unknown as RawSearchRow[];
  });

  return rows ?? [];
}

export interface EmbeddingRow {
  theme: string;
  heading: string;
  text: string;
  contentHash: string;
  vector: Float32Array;
}

/** Loads every stored embedding joined with its owning chunk(s) —
 *  content_hash + vector only from the `embeddings` table, joined against
 *  `chunks` for the theme/heading/text needed to build a `SearchResult`.
 *  One row per (chunk, embedding) pair, so content shared verbatim across
 *  multiple chunks yields one row per chunk, each with its own
 *  theme/heading. Returns `[]` if the index is unavailable. */
export async function getAllEmbeddings(vault: Vault): Promise<EmbeddingRow[]> {
  const rows = await withIndexDb(vault, (db) => {
    return db
      .prepare(
        `SELECT c.theme AS theme, c.heading AS heading, c.text AS text, c.content_hash AS contentHash, e.vector AS vector
         FROM chunks c
         JOIN embeddings e ON e.content_hash = c.content_hash`
      )
      .all() as unknown as {
      theme: string;
      heading: string;
      text: string;
      contentHash: string;
      vector: Uint8Array;
    }[];
  });

  if (!rows) return [];
  return rows.map((r) => ({
    theme: r.theme,
    heading: r.heading,
    text: r.text,
    contentHash: r.contentHash,
    vector: bufferToFloat32Array(r.vector),
  }));
}
