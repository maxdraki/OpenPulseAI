import { describe, it, expect } from "vitest";
import {
  extractSources,
  entryId,
  updateSourcesFrontmatter,
} from "../src/provenance.js";

// ---------------------------------------------------------------------------
// extractSources
// ---------------------------------------------------------------------------
describe("extractSources", () => {
  it("returns empty array when no markers present", () => {
    expect(extractSources("No markers here.")).toEqual([]);
  });

  it("returns empty array for empty string", () => {
    expect(extractSources("")).toEqual([]);
  });

  it("extracts a single ^[src:entry-id] marker correctly", () => {
    const content = "Some fact. ^[src:2026-04-01-github-activity]";
    expect(extractSources(content)).toEqual(["2026-04-01-github-activity"]);
  });

  it("extracts multiple markers in order of first occurrence", () => {
    const content =
      "Fact one ^[src:2026-04-01-github] and fact two ^[src:2026-04-02-folder-watcher].";
    expect(extractSources(content)).toEqual([
      "2026-04-01-github",
      "2026-04-02-folder-watcher",
    ]);
  });

  it("deduplicates repeated markers", () => {
    const content =
      "First ^[src:abc-123] then again ^[src:abc-123] and also ^[src:xyz-456].";
    expect(extractSources(content)).toEqual(["abc-123", "xyz-456"]);
  });

  it("handles marker IDs with hyphens and numbers", () => {
    const content = "Data ^[src:2026-04-10-my-source-42].";
    expect(extractSources(content)).toEqual(["2026-04-10-my-source-42"]);
  });

  it("handles ^[src:] with special chars in the ID (colons in ID not supported — dash/nums only)", () => {
    const content = "Something ^[src:folder-watcher-2] and ^[src:github-3].";
    const result = extractSources(content);
    expect(result).toContain("folder-watcher-2");
    expect(result).toContain("github-3");
  });

  it("preserves order of first occurrence when deduplicating", () => {
    const content =
      "^[src:b] then ^[src:a] then ^[src:b] again.";
    expect(extractSources(content)).toEqual(["b", "a"]);
  });

  it("extracts markers across multiple lines", () => {
    const content = "Line 1 ^[src:source-a]\nLine 2 ^[src:source-b]\nLine 3.";
    expect(extractSources(content)).toEqual(["source-a", "source-b"]);
  });
});

// ---------------------------------------------------------------------------
// entryId
// ---------------------------------------------------------------------------
describe("entryId", () => {
  it("returns YYYY-MM-DD-sourcename format", () => {
    expect(entryId("2026-04-01T08:30:00Z", "github-activity")).toBe(
      "2026-04-01-github-activity"
    );
  });

  it("uses 'unknown' when source is undefined", () => {
    expect(entryId("2026-04-01T08:30:00Z")).toBe("2026-04-01-unknown");
  });

  it("uses 'unknown' when source is explicitly undefined", () => {
    expect(entryId("2026-04-01T00:00:00Z", undefined)).toBe(
      "2026-04-01-unknown"
    );
  });

  it("extracts date from full ISO timestamp", () => {
    expect(entryId("2026-04-15T23:59:59.999Z", "folder-watcher")).toBe(
      "2026-04-15-folder-watcher"
    );
  });

  it("handles date-only string (no time component)", () => {
    expect(entryId("2026-01-01", "weekly-rollup")).toBe(
      "2026-01-01-weekly-rollup"
    );
  });

  it("correctly slices the first 10 characters for the date", () => {
    const result = entryId("2026-12-31T12:00:00Z", "test-source");
    expect(result).toBe("2026-12-31-test-source");
  });
});

// ---------------------------------------------------------------------------
// updateSourcesFrontmatter
// ---------------------------------------------------------------------------
describe("updateSourcesFrontmatter", () => {
  it("returns unchanged when no frontmatter block", () => {
    const md = "# No frontmatter\n\nSome content.";
    expect(updateSourcesFrontmatter(md, ["some-id"])).toBe(md);
  });

  it("inserts sources field when absent from frontmatter", () => {
    const md =
      "---\ntheme: MyTheme\nlastUpdated: 2026-04-01T00:00:00Z\n---\n\nContent";
    const result = updateSourcesFrontmatter(md, ["2026-04-01-github"]);
    expect(result).toContain("sources: [2026-04-01-github]");
    expect(result).toContain("theme: MyTheme");
    expect(result).toContain("lastUpdated: 2026-04-01T00:00:00Z");
  });

  it("merges newSources with existing sources", () => {
    const md =
      "---\ntheme: MyTheme\nsources: [old-id]\n---\n\nContent";
    const result = updateSourcesFrontmatter(md, ["new-id"]);
    expect(result).toContain("sources: [old-id, new-id]");
  });

  it("deduplicates during merge (existing + newSources overlap)", () => {
    const md =
      "---\ntheme: MyTheme\nsources: [old-id]\n---\n\nContent";
    const result = updateSourcesFrontmatter(md, ["new-id", "old-id"]);
    // old-id should appear only once
    const sourcesMatch = result.match(/sources:\s*\[([^\]]*)\]/);
    expect(sourcesMatch).not.toBeNull();
    const sourcesList = sourcesMatch![1].split(",").map((s) => s.trim());
    expect(sourcesList.filter((s) => s === "old-id")).toHaveLength(1);
    expect(sourcesList).toContain("new-id");
  });

  it("returns unchanged when both existing and newSources are empty", () => {
    const md = "---\ntheme: MyTheme\nlastUpdated: 2026-04-01T00:00:00Z\n---\n\nContent";
    expect(updateSourcesFrontmatter(md, [])).toBe(md);
  });

  it("returns unchanged when existing sources is empty array and newSources is empty", () => {
    const md = "---\ntheme: MyTheme\nsources: []\n---\n\nContent";
    expect(updateSourcesFrontmatter(md, [])).toBe(md);
  });

  it("inserts sources before closing --- when field is absent", () => {
    const md = "---\ntheme: MyTheme\n---\n\nContent";
    const result = updateSourcesFrontmatter(md, ["abc"]);
    // The sources line should appear inside the frontmatter block (before ---)
    const fmMatch = result.match(/^---\n([\s\S]*?)\n---\n/);
    expect(fmMatch).not.toBeNull();
    expect(fmMatch![1]).toContain("sources: [abc]");
  });

  it("handles frontmatter that ends exactly with ---\\n", () => {
    const md = "---\ntheme: Test\nlastUpdated: 2026-04-01T00:00:00Z\n---\n";
    const result = updateSourcesFrontmatter(md, ["new-id"]);
    expect(result).toContain("sources: [new-id]");
  });

  it("replaces existing sources line in-place (preserves other frontmatter fields)", () => {
    const md =
      "---\ntheme: MyTheme\nlastUpdated: 2026-04-01T00:00:00Z\nsources: [id-a, id-b]\ntype: project\n---\n\nContent here.";
    const result = updateSourcesFrontmatter(md, ["id-c"]);
    expect(result).toContain("sources: [id-a, id-b, id-c]");
    expect(result).toContain("theme: MyTheme");
    expect(result).toContain("type: project");
  });

  it("returns correct structure — frontmatter still surrounded by ---", () => {
    const md = "---\ntheme: X\n---\n\nBody.";
    const result = updateSourcesFrontmatter(md, ["src-1"]);
    expect(result.startsWith("---\n")).toBe(true);
    expect(result).toMatch(/\n---\n/);
  });
});
