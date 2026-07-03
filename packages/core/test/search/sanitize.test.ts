import { describe, it, expect } from "vitest";
import { sanitizeFtsQuery } from "../../src/search/sanitize.js";

describe("sanitizeFtsQuery", () => {
  it("returns an empty string for an empty/whitespace query", () => {
    expect(sanitizeFtsQuery("")).toBe("");
    expect(sanitizeFtsQuery("   ")).toBe("");
  });

  it("quotes plain terms so FTS5 operators in user input are treated as literal text", () => {
    const result = sanitizeFtsQuery("auth AND OR NOT");
    expect(result).toBe('"auth" "AND" "OR" "NOT"');
  });

  it("escapes embedded double quotes so a raw quote never throws", () => {
    const result = sanitizeFtsQuery('say "hello" now');
    expect(result).toBe('"say" """hello""" "now"');
  });

  it("handles unicode terms", () => {
    const result = sanitizeFtsQuery("café 日本語");
    expect(result).toBe('"café" "日本語"');
  });

  it("drops FTS5 special characters that aren't part of a term (^ * : ( ) -)", () => {
    const result = sanitizeFtsQuery("foo* (bar) col:baz -qux");
    // every produced token must be double-quoted, so none of it can be
    // interpreted as FTS5 syntax
    expect(result).toMatch(/^(".*?"\s*)+$/);
  });

  it("never produces a string that causes FTS5 MATCH to throw", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE VIRTUAL TABLE t USING fts5(text)");
    db.exec("INSERT INTO t(rowid, text) VALUES (1, 'hello world')");

    const nasty = ['"', "AND", "a OR b", 'weird "quote" (paren) *star* col:val -neg', ""];
    for (const q of nasty) {
      const sanitized = sanitizeFtsQuery(q);
      expect(() => {
        if (sanitized) {
          db.prepare("SELECT rowid FROM t WHERE t MATCH ?").all(sanitized);
        }
      }).not.toThrow();
    }
  });
});
