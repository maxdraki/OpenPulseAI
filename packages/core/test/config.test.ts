import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, DEFAULT_CONFIG, isValidAigisEndpoint } from "../src/config.js";

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

  it("supports mistral provider", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `llm:\n  provider: mistral\n  model: mistral-large-latest\n  apiKey: test-key\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.llm.provider).toBe("mistral");
    expect(config.llm.model).toBe("mistral-large-latest");
  });

  it("falls back to anthropic for unknown provider", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `llm:\n  provider: invalid-provider\n  model: some-model\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.llm.provider).toBe("anthropic");
  });

});

describe("Aigis config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "openpulse-config-aigis-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true });
  });

  it("is undefined when no aigis section exists", async () => {
    const config = await loadConfig(tempDir);
    expect(config.aigis).toBeUndefined();
  });

  it("loads a fully-specified aigis section", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: https://aigis.bio/mcp\n  authToken: secret-token\n  submitTool: custom_submit\n  enabled: true\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis).toEqual({
      endpoint: "https://aigis.bio/mcp",
      authToken: "secret-token",
      submitTool: "custom_submit",
      enabled: true,
    });
  });

  it("defaults submitTool to aigis_submit_journal when absent", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: https://aigis.bio/mcp\n  enabled: true\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis?.submitTool).toBe("aigis_submit_journal");
  });

  it("defaults enabled to false when absent", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: https://aigis.bio/mcp\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis?.enabled).toBe(false);
  });

  it("leaves authToken undefined when absent", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: https://aigis.bio/mcp\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis?.authToken).toBeUndefined();
  });

  it("forces enabled false when the endpoint is not a valid https URL", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: not-a-url\n  enabled: true\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis?.enabled).toBe(false);
  });

  it("forces enabled false for an http (non-https) endpoint", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  endpoint: http://aigis.bio/mcp\n  enabled: true\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis?.enabled).toBe(false);
  });

  it("is undefined when the aigis section has no endpoint at all", async () => {
    await writeFile(
      join(tempDir, "config.yaml"),
      `aigis:\n  enabled: true\n`,
      "utf-8"
    );

    const config = await loadConfig(tempDir);
    expect(config.aigis).toBeUndefined();
  });
});

describe("isValidAigisEndpoint", () => {
  it("accepts a well-formed https URL", () => {
    expect(isValidAigisEndpoint("https://aigis.bio/mcp")).toBe(true);
  });

  it("rejects an http URL", () => {
    expect(isValidAigisEndpoint("http://aigis.bio/mcp")).toBe(false);
  });

  it("rejects a malformed URL", () => {
    expect(isValidAigisEndpoint("not-a-url")).toBe(false);
  });

  it("rejects an empty string", () => {
    expect(isValidAigisEndpoint("")).toBe(false);
  });
});
