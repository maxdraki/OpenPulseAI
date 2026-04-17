import { describe, it, expect, vi } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Vault } from "@openpulse/core";
import { proposeSchemaChanges } from "../src/schema-evolve-cli.js";

async function setupVault(): Promise<{ root: string; vault: Vault }> {
  const root = await mkdtemp(join(tmpdir(), "schema-evolve-"));
  await mkdir(join(root, "vault", "warm", "_pending"), { recursive: true });
  const vault = new Vault(root);
  await writeFile(join(root, "vault", "warm", "_schema.md"), `# Wiki Schema\n\n### project\nStructure: A\nRules: B\n`, "utf-8");
  await writeFile(join(root, "vault", "warm", "p1.md"),
    `---\ntheme: p1\nlastUpdated: 2026-04-15T00:00:00Z\ntype: project\n---\n\nContent 1.`, "utf-8");
  return { root, vault };
}

describe("proposeSchemaChanges", () => {
  it("writes a pending update when LLM returns a non-null proposal", async () => {
    const { root, vault } = await setupVault();
    const provider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        proposed_schema_content: "# Wiki Schema v2\n\n### project\nStructure: X\nRules: Y",
        rationale: [{ change: "added structure X", evidence: "samples show X" }],
        confidence: "medium",
      })),
    } as any;

    const created = await proposeSchemaChanges(vault, provider, "gpt", false);
    expect(created).toBe(true);

    const pendingFiles = await readdir(join(root, "vault", "warm", "_pending"));
    expect(pendingFiles.length).toBe(1);
    const update = JSON.parse(await readFile(join(root, "vault", "warm", "_pending", pendingFiles[0]), "utf-8"));
    expect(update.theme).toBe("_schema");
    expect(update.schemaEvolution).toBeDefined();
    expect(update.schemaEvolution.confidence).toBe("medium");
    expect(update.proposedContent).toContain("v2");
  });

  it("does nothing when LLM returns null proposal", async () => {
    const { root, vault } = await setupVault();
    const provider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        proposed_schema_content: null,
        rationale: [],
        confidence: "low",
      })),
    } as any;

    const created = await proposeSchemaChanges(vault, provider, "gpt", false);
    expect(created).toBe(false);

    const pendingFiles = await readdir(join(root, "vault", "warm", "_pending"));
    expect(pendingFiles.length).toBe(0);
  });

  it("returns early with message on dry-run (writes nothing)", async () => {
    const { root, vault } = await setupVault();
    const provider = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        proposed_schema_content: "new schema",
        rationale: [],
        confidence: "high",
      })),
    } as any;

    const created = await proposeSchemaChanges(vault, provider, "gpt", true); // dryRun=true
    expect(created).toBe(false);

    const pendingFiles = await readdir(join(root, "vault", "warm", "_pending"));
    expect(pendingFiles.length).toBe(0);
  });
});
