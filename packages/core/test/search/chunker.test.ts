import { describe, it, expect } from "vitest";
import { chunkTheme } from "../../src/search/chunker.js";

describe("chunkTheme", () => {
  it("splits sections by ## headings", () => {
    const raw = [
      "---",
      "theme: project-auth",
      "---",
      "",
      "## Overview",
      "",
      "This project handles authentication for the app.",
      "",
      "## Recent Activity",
      "",
      "Refactored the login page this week, cleaning up the session handling.",
      "",
    ].join("\n");

    const chunks = chunkTheme("project-auth", raw);
    expect(chunks.map((c) => c.heading)).toEqual(["Overview", "Recent Activity"]);
    expect(chunks[0].text).toContain("authentication for the app");
    expect(chunks[1].text).toContain("Refactored the login page this week");
    for (const c of chunks) {
      expect(c.theme).toBe("project-auth");
    }
  });

  it("content before the first ## heading becomes a preamble chunk with heading ''", () => {
    const raw = [
      "---",
      "theme: hiring",
      "---",
      "",
      "Hiring pipeline for the eng team.",
      "",
      "## Candidates",
      "",
      "Several candidates are currently in progress through the pipeline.",
      "",
    ].join("\n");

    const chunks = chunkTheme("hiring", raw);
    expect(chunks[0].heading).toBe("");
    expect(chunks[0].text).toContain("Hiring pipeline for the eng team");
    expect(chunks[1].heading).toBe("Candidates");
  });

  it("does not index frontmatter as text", () => {
    const raw = [
      "---",
      "theme: hiring",
      "skills: [recruiting, interviewing]",
      "---",
      "",
      "## Candidates",
      "",
      "Several candidates in progress.",
      "",
    ].join("\n");

    const chunks = chunkTheme("hiring", raw);
    for (const c of chunks) {
      expect(c.text).not.toContain("skills:");
      expect(c.text).not.toContain("theme: hiring");
    }
  });

  it("extracts tags from YAML frontmatter (skills)", () => {
    const raw = [
      "---",
      "theme: hiring",
      "skills: [recruiting, interviewing]",
      "---",
      "",
      "## Candidates",
      "",
      "Several candidates in progress.",
      "",
    ].join("\n");

    const chunks = chunkTheme("hiring", raw);
    expect(chunks[0].tags).toEqual(["recruiting", "interviewing"]);
  });

  it("returns empty tags when frontmatter has no skills", () => {
    const raw = ["---", "theme: hiring", "---", "", "## Candidates", "", "Text.", ""].join("\n");
    const chunks = chunkTheme("hiring", raw);
    expect(chunks[0].tags).toEqual([]);
  });

  it("splits oversized sections (> ~2000 chars) at paragraph boundaries, keeping the same heading", () => {
    const paragraphs = Array.from({ length: 40 }, (_, i) => `Paragraph number ${i} with some filler text to pad it out a bit more.`);
    const raw = ["---", "theme: big", "---", "", "## Log", "", paragraphs.join("\n\n"), ""].join("\n");

    const chunks = chunkTheme("big", raw);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.heading).toBe("Log");
      expect(c.text.length).toBeLessThanOrEqual(2200); // some slack for paragraph boundaries
    }
    // reassembled text should still contain all paragraphs somewhere
    const joined = chunks.map((c) => c.text).join("\n\n");
    expect(joined).toContain("Paragraph number 0 ");
    expect(joined).toContain("Paragraph number 39 ");
  });

  it("merges tiny fragments (<40 chars) into the previous chunk", () => {
    const raw = [
      "---",
      "theme: tiny",
      "---",
      "",
      "## First",
      "",
      "This is a reasonably long first section with real content.",
      "",
      "## Short",
      "",
      "ok",
      "",
    ].join("\n");

    const chunks = chunkTheme("tiny", raw);
    // "ok" section is <40 chars and should have merged into the previous chunk
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("First");
    expect(chunks[0].text).toContain("reasonably long first section");
    expect(chunks[0].text).toContain("ok");
  });

  it("computes a stable 16-hex-char contentHash per chunk", () => {
    const raw = ["---", "theme: t", "---", "", "## A", "", "Some content here.", ""].join("\n");
    const chunks = chunkTheme("t", raw);
    expect(chunks[0].contentHash).toMatch(/^[0-9a-f]{16}$/);

    const chunksAgain = chunkTheme("t", raw);
    expect(chunksAgain[0].contentHash).toBe(chunks[0].contentHash);
  });

  it("gives different chunks different hashes when text differs", () => {
    const raw = [
      "---",
      "theme: t",
      "---",
      "",
      "## A",
      "",
      "This is the content for section A, long enough to not be merged.",
      "",
      "## B",
      "",
      "This is different content for section B, also long enough to survive.",
      "",
    ].join("\n");
    const chunks = chunkTheme("t", raw);
    expect(chunks[0].contentHash).not.toBe(chunks[1].contentHash);
  });

  it("handles a file with no ## headings at all as a single preamble chunk", () => {
    const raw = ["---", "theme: nosec", "---", "", "Just some plain content with no sections.", ""].join("\n");
    const chunks = chunkTheme("nosec", raw);
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading).toBe("");
  });

  it("handles empty content gracefully", () => {
    const raw = ["---", "theme: empty", "---", "", ""].join("\n");
    const chunks = chunkTheme("empty", raw);
    expect(chunks).toEqual([]);
  });
});
