import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@openpulse/core";
import { bucketActivityLog, compactTheme, parseProjectPage } from "../src/compact-cli.js";

describe("bucketActivityLog", () => {
  it("keeps last 14 sections verbatim and groups rest by ISO week", () => {
    const sections = Array.from({ length: 20 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      body: `Entry ${i}`,
    }));
    const { verbatim, grouped } = bucketActivityLog(sections);
    expect(verbatim).toHaveLength(14);
    expect(Object.keys(grouped).length).toBeGreaterThan(0);
  });

  it("returns all sections as verbatim when total <= 14", () => {
    const sections = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      body: `Entry ${i}`,
    }));
    const { verbatim, grouped } = bucketActivityLog(sections);
    expect(verbatim).toHaveLength(10);
    expect(Object.keys(grouped)).toHaveLength(0);
  });
});

describe("parseProjectPage", () => {
  it("extracts Current Status and dated sections from Activity Log", async () => {
    const content = `## Current Status
Work in progress.

## Activity Log

### 2026-04-15
- Commit A

### 2026-04-14
- Commit B`;
    const { currentStatus, sections } = await parseProjectPage(content);
    expect(currentStatus).toContain("Work in progress");
    expect(sections).toHaveLength(2);
    expect(sections[0].date).toBe("2026-04-15"); // sorted descending
    expect(sections[1].date).toBe("2026-04-14");
  });
});

describe("compactTheme — project path", () => {
  it("produces a pending update with compactionType when > 14 sections", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    const vault = new Vault(root);

    // 20 dated sections
    const sections = Array.from({ length: 20 }, (_, i) => {
      const day = String((i % 28) + 1).padStart(2, "0");
      return `### 2026-03-${day}\n- Change ${i}`;
    }).join("\n\n");
    const content = `---
theme: myproj
lastUpdated: 2026-04-16T00:00:00Z
type: project
---

## Current Status
Status here.

## Activity Log

${sections}`;
    await writeFile(join(root, "vault", "warm", "myproj.md"), content, "utf-8");

    const provider = {
      complete: vi.fn().mockResolvedValue('{"current_status":"Compacted status","history":"- Week summary"}'),
    } as any;

    const did = await compactTheme(vault, "myproj", provider, "gpt");
    expect(did).toBe(true);

    const pendingFiles = await readdir(join(root, "vault", "warm", "_pending"));
    expect(pendingFiles.length).toBeGreaterThan(0);
    const update = JSON.parse(await readFile(join(root, "vault", "warm", "_pending", pendingFiles[0]), "utf-8"));
    expect(update.compactionType).toBe("scheduled");
    expect(update.type).toBe("project");
    expect(update.theme).toBe("myproj");
  });

  it("returns false when <= 14 sections (no compaction needed)", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    const vault = new Vault(root);

    const content = `---
theme: small
lastUpdated: 2026-04-16T00:00:00Z
type: project
---

## Current Status
Small.

## Activity Log

### 2026-04-15
- Change`;
    await writeFile(join(root, "vault", "warm", "small.md"), content, "utf-8");

    const provider = { complete: vi.fn() } as any;
    const did = await compactTheme(vault, "small", provider, "gpt");
    expect(did).toBe(false);
    expect(provider.complete).not.toHaveBeenCalled();
  });
});

describe("compactTheme — concept path", () => {
  it("reads _facts/<theme>.jsonl and creates pending with compactionType", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
    const vault = new Vault(root);

    await writeFile(join(root, "vault", "warm", "mypattern.md"),
      `---\ntheme: mypattern\nlastUpdated: 2026-04-16T00:00:00Z\ntype: concept\n---\n\n## Definition\nSome pattern.`, "utf-8");
    await writeFile(join(root, "vault", "warm", "_facts", "mypattern.jsonl"),
      '{"claim":"X","sourceId":"s1","confidence":"high","extractedAt":"2026-04-16T00:00:00Z"}\n', "utf-8");

    const provider = {
      complete: vi.fn().mockResolvedValue("## Definition\nRewritten definition. ^[src:s1]"),
    } as any;

    const did = await compactTheme(vault, "mypattern", provider, "gpt");
    expect(did).toBe(true);

    const pendingFiles = await readdir(join(root, "vault", "warm", "_pending"));
    const update = JSON.parse(await readFile(join(root, "vault", "warm", "_pending", pendingFiles[0]), "utf-8"));
    expect(update.compactionType).toBe("scheduled");
    expect(update.theme).toBe("mypattern");
    expect(update.proposedContent).toContain("Rewritten definition");
  });

  it("passes only active facts to the compaction prompt, excluding superseded ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
    const vault = new Vault(root);

    await writeFile(join(root, "vault", "warm", "mypattern.md"),
      `---\ntheme: mypattern\nlastUpdated: 2026-04-16T00:00:00Z\ntype: concept\n---\n\n## Definition\nSome pattern.`, "utf-8");
    await writeFile(join(root, "vault", "warm", "_facts", "mypattern.jsonl"),
      [
        JSON.stringify({ id: "old1", claim: "X uses SQLite", sourceId: "s1", confidence: "high", extractedAt: "2026-04-01T00:00:00Z", supersededBy: "new1", supersededAt: "2026-04-10T00:00:00Z" }),
        JSON.stringify({ id: "new1", claim: "X migrated to Postgres", sourceId: "s2", confidence: "high", extractedAt: "2026-04-10T00:00:00Z" }),
      ].join("\n") + "\n",
      "utf-8"
    );

    const provider = {
      complete: vi.fn().mockResolvedValue("## Definition\nRewritten definition. ^[src:s2]"),
    } as any;

    const did = await compactTheme(vault, "mypattern", provider, "gpt");
    expect(did).toBe(true);

    const promptArg = provider.complete.mock.calls[0][0].prompt as string;
    expect(promptArg).toContain("X migrated to Postgres");
    expect(promptArg).not.toContain("X uses SQLite");
  });

  it("returns false (no compaction) when all facts are superseded and none are active", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
    const vault = new Vault(root);

    await writeFile(join(root, "vault", "warm", "onlysuperseded.md"),
      `---\ntheme: onlysuperseded\nlastUpdated: 2026-04-16T00:00:00Z\ntype: concept\n---\n\n## Definition\nSome pattern.`, "utf-8");
    await writeFile(join(root, "vault", "warm", "_facts", "onlysuperseded.jsonl"),
      JSON.stringify({ id: "old1", claim: "X", sourceId: "s1", confidence: "high", extractedAt: "2026-04-01T00:00:00Z", supersededBy: "new1", supersededAt: "2026-04-02T00:00:00Z" }) + "\n",
      "utf-8"
    );

    const provider = { complete: vi.fn() } as any;
    const did = await compactTheme(vault, "onlysuperseded", provider, "gpt");
    expect(did).toBe(false);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("archives superseded facts to <theme>.archive.jsonl and trims the live file once over threshold", async () => {
    const root = await mkdtemp(join(tmpdir(), "compact-"));
    await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
    await mkdir(join(root, "vault", "warm", "_facts"), { recursive: true });
    const vault = new Vault(root);

    await writeFile(join(root, "vault", "warm", "bigpattern.md"),
      `---\ntheme: bigpattern\nlastUpdated: 2026-04-16T00:00:00Z\ntype: concept\n---\n\n## Definition\nSome pattern.`, "utf-8");

    // 350 lines (over the 300-line default threshold), half superseded.
    const lines: string[] = [];
    for (let i = 0; i < 350; i++) {
      const active = i % 2 === 0;
      lines.push(JSON.stringify({
        id: `f${i}`,
        claim: `Claim ${i}`,
        sourceId: "s1",
        confidence: "high",
        extractedAt: "2026-04-01T00:00:00Z",
        ...(active ? {} : { supersededBy: `f${i - 1}`, supersededAt: "2026-04-02T00:00:00Z" }),
      }));
    }
    const factsPath = join(root, "vault", "warm", "_facts", "bigpattern.jsonl");
    await writeFile(factsPath, lines.join("\n") + "\n", "utf-8");

    const provider = {
      complete: vi.fn().mockResolvedValue("## Definition\nRewritten. ^[src:s1]"),
    } as any;

    const did = await compactTheme(vault, "bigpattern", provider, "gpt");
    expect(did).toBe(true);

    const archivePath = join(root, "vault", "warm", "_facts", "bigpattern.archive.jsonl");
    const archiveText = await readFile(archivePath, "utf-8");
    const archivedCount = archiveText.trim().split("\n").filter(Boolean).length;
    expect(archivedCount).toBe(175);

    const liveText = await readFile(factsPath, "utf-8");
    const liveFacts = liveText.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(liveFacts).toHaveLength(175);
    expect(liveFacts.every((f) => !f.supersededBy)).toBe(true);
  });
});
