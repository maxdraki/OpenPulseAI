import { describe, it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "../src/vault.js";
import { mergeThemes } from "../src/merge-themes.js";

async function makeVault() {
  const root = await mkdtemp(join(tmpdir(), "merge-"));
  await mkdir(join(root, "vault", "warm"), { recursive: true });
  await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
  return { root, vault: new Vault(root) };
}

describe("mergeThemes", () => {
  it("rewrites [[source]] references to [[canonical]] across all warm files", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "foo.md"), "---\ntheme: foo\nlastUpdated: 2026-01-01T00:00:00Z\n---\nContent about foo.");
    await writeFile(join(root, "vault", "warm", "bar.md"), "---\ntheme: bar\nlastUpdated: 2026-01-01T00:00:00Z\n---\nSee [[foo]] and [[baz]].");
    await writeFile(join(root, "vault", "warm", "quux.md"), "---\ntheme: quux\nlastUpdated: 2026-01-01T00:00:00Z\n---\nAlso [[foo]].");

    await mergeThemes(vault, "foo", "fooling");

    const bar = await readFile(join(root, "vault", "warm", "bar.md"), "utf-8");
    const quux = await readFile(join(root, "vault", "warm", "quux.md"), "utf-8");
    expect(bar).toContain("[[fooling]]");
    expect(bar).not.toContain("[[foo]]");
    expect(quux).toContain("[[fooling]]");
  });

  it("appends source content to canonical (prepended as dated section for projects)", async () => {
    const { root, vault } = await makeVault();
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\nlastUpdated: 2026-01-01T00:00:00Z\n---\nCanonical content.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\nlastUpdated: 2026-01-02T00:00:00Z\n---\nSource content.");

    await mergeThemes(vault, "b", "a");

    const a = await readFile(join(root, "vault", "warm", "a.md"), "utf-8");
    expect(a).toContain(`### Merged from [[b]] on ${today}`);
    expect(a).toContain("Source content.");
  });

  it("deletes source .md and _facts/source.jsonl", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "_facts", "b.jsonl"), '{"claim":"x","sourceId":"s1"}\n');

    await mergeThemes(vault, "b", "a");

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("b.md");
    const facts = await readdir(join(root, "vault", "warm", "_facts"));
    expect(facts).not.toContain("b.jsonl");
  });

  it("merges _facts/source.jsonl into _facts/canonical.jsonl", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "_facts", "a.jsonl"), '{"claim":"a1","sourceId":"s1"}\n');
    await writeFile(join(root, "vault", "warm", "_facts", "b.jsonl"), '{"claim":"b1","sourceId":"s2"}\n');

    await mergeThemes(vault, "b", "a");

    const aFacts = await readFile(join(root, "vault", "warm", "_facts", "a.jsonl"), "utf-8");
    expect(aFacts).toContain('"claim":"a1"');
    expect(aFacts).toContain('"claim":"b1"');
  });

  it("with canonical=null deletes source and rewrites broken [[source]] references to plain text", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "c.md"), "---\ntheme: c\n---\nSee [[b]].");

    await mergeThemes(vault, "b", null);

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("b.md");
    const c = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");
    expect(c).not.toContain("[[b]]");
    expect(c).toContain("b");
  });

  it("rename mode replaces the file at canonical without content merge", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "old.md"), "---\ntheme: old\nlastUpdated: 2026-01-01T00:00:00Z\n---\nOriginal content.");
    await writeFile(join(root, "vault", "warm", "x.md"), "---\ntheme: x\n---\nReference [[old]].");

    await mergeThemes(vault, "old", "new", { rename: true });

    const newFile = await readFile(join(root, "vault", "warm", "new.md"), "utf-8");
    expect(newFile).toContain("Original content.");
    expect(newFile).toContain("theme: new");

    const files = await readdir(join(root, "vault", "warm"));
    expect(files).not.toContain("old.md");

    const x = await readFile(join(root, "vault", "warm", "x.md"), "utf-8");
    expect(x).toContain("[[new]]");
  });

  it("rename mode with pre-existing canonical falls back to merge-prepend (no data loss)", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "old.md"), "---\ntheme: old\n---\nOld content.");
    await writeFile(join(root, "vault", "warm", "new.md"), "---\ntheme: new\n---\nExisting canonical content.");

    await mergeThemes(vault, "old", "new", { rename: true });

    const newFile = await readFile(join(root, "vault", "warm", "new.md"), "utf-8");
    expect(newFile).toContain("Existing canonical content");  // preserved
    expect(newFile).toContain("Old content");                 // merged in
    expect(newFile).toContain("Renamed from [[old]]");
  });

  it("is idempotent: running twice leaves the same state", async () => {
    const { root, vault } = await makeVault();
    await writeFile(join(root, "vault", "warm", "a.md"), "---\ntheme: a\n---\nA.");
    await writeFile(join(root, "vault", "warm", "b.md"), "---\ntheme: b\n---\nB.");
    await writeFile(join(root, "vault", "warm", "c.md"), "---\ntheme: c\n---\n[[b]] and [[a]].");

    await mergeThemes(vault, "b", "a");
    const after1 = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");
    await mergeThemes(vault, "b", "a");
    const after2 = await readFile(join(root, "vault", "warm", "c.md"), "utf-8");

    expect(after1).toBe(after2);
  });
});
