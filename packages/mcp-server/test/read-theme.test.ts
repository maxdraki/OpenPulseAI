import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Vault, writeTheme, rebuildIndex } from "@openpulse/core";
import { handleReadTheme } from "../src/tools/read-theme.js";

describe("read_theme tool", () => {
  let vault: Vault;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-read-theme-"));
    vault = new Vault(tempDir);
    await vault.init();
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns the full markdown for a valid theme", async () => {
    await writeTheme(vault, "project-auth", "## Overview\n\nAuth project details.");

    const result = await handleReadTheme(vault, { theme: "project-auth" });
    expect(result.content[0].text).toContain("Auth project details.");
  });

  it("rejects path traversal attempts", async () => {
    const result = await handleReadTheme(vault, { theme: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/invalid|unsafe/i);
  });

  it("returns a clear not-found error with suggestions when the theme doesn't exist", async () => {
    // FTS5 matches on whole tokens (hyphens are tokenizer separators), so the
    // suggestion query needs a token that literally appears in the target
    // theme's name/heading/body for the "close match" search to surface it.
    await writeTheme(vault, "authentication-project", "## Overview\n\nAuthentication details.");
    await rebuildIndex(vault);

    const result = await handleReadTheme(vault, { theme: "authentication" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
    expect(result.content[0].text).toContain("authentication-project");
  });

  it("returns not-found without suggestions when there are no close matches", async () => {
    const result = await handleReadTheme(vault, { theme: "nonexistent" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not found/i);
  });
});
