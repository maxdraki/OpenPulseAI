import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG } from "../src/config.js";

describe("Config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-config-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("returns defaults when no config file exists", async () => {
    const config = await loadConfig(tempDir);
    expect(config.themes).toEqual([]);
    expect(config.llm.provider).toBe("anthropic");
  });

  it("loads config from config.yaml", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `themes:\n  - project-auth\n  - hiring\nllm:\n  provider: anthropic\n  model: claude-sonnet-4-5-20250929\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.themes).toEqual(["project-auth", "hiring"]);
    expect(config.llm.model).toBe("claude-sonnet-4-5-20250929");
  });

  it("supports openai provider", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `llm:\n  provider: openai\n  model: gpt-4o\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.llm.provider).toBe("openai");
    expect(config.llm.model).toBe("gpt-4o");
  });

  it("supports gemini provider", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `llm:\n  provider: gemini\n  model: gemini-2.0-flash\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.llm.provider).toBe("gemini");
    expect(config.llm.model).toBe("gemini-2.0-flash");
  });
});
