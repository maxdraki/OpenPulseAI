import { describe, it, expect } from "vitest";
import { sanitizeThemeSlug } from "../src/theme-slug.js";

describe("sanitizeThemeSlug", () => {
  it("converts PascalCase to kebab-case", () => {
    expect(sanitizeThemeSlug("TypeDecorators")).toBe("type-decorators");
    expect(sanitizeThemeSlug("ChatSession")).toBe("chat-session");
    expect(sanitizeThemeSlug("SourceConfig")).toBe("source-config");
  });

  it("converts camelCase to kebab-case", () => {
    expect(sanitizeThemeSlug("fooBar")).toBe("foo-bar");
    expect(sanitizeThemeSlug("myLongName")).toBe("my-long-name");
  });

  it("handles consecutive uppercase (acronyms)", () => {
    expect(sanitizeThemeSlug("HTMLParser")).toBe("html-parser");
    expect(sanitizeThemeSlug("URLHandler")).toBe("url-handler");
    expect(sanitizeThemeSlug("APIKey")).toBe("api-key");
  });

  it("handles digits adjacent to letters", () => {
    expect(sanitizeThemeSlug("version2Update")).toBe("version2-update");
  });

  it("lowercases and replaces whitespace with dashes", () => {
    expect(sanitizeThemeSlug("Hello World")).toBe("hello-world");
    expect(sanitizeThemeSlug("  spaced   out  ")).toBe("spaced-out");
  });

  it("replaces underscores with dashes", () => {
    expect(sanitizeThemeSlug("snake_case_name")).toBe("snake-case-name");
  });

  it("collapses consecutive dashes", () => {
    expect(sanitizeThemeSlug("foo--bar___baz")).toBe("foo-bar-baz");
  });

  it("strips path separators", () => {
    expect(sanitizeThemeSlug("foo/bar")).toBe("foobar");
    expect(sanitizeThemeSlug("foo\\bar")).toBe("foobar");
  });

  it("strips traversal sequences", () => {
    expect(sanitizeThemeSlug("../etc/passwd")).toBe("etcpasswd");
  });

  it("trims leading and trailing dashes/dots/underscores", () => {
    expect(sanitizeThemeSlug("--foo--")).toBe("foo");
    expect(sanitizeThemeSlug("..name..")).toBe("name");
  });

  it("caps length at 100 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizeThemeSlug(long).length).toBeLessThanOrEqual(100);
  });

  it("leaves already-kebab slugs alone", () => {
    expect(sanitizeThemeSlug("dream-pipeline")).toBe("dream-pipeline");
    expect(sanitizeThemeSlug("chat-interface")).toBe("chat-interface");
  });

  it("handles empty / whitespace input", () => {
    expect(sanitizeThemeSlug("")).toBe("");
    expect(sanitizeThemeSlug("   ")).toBe("");
  });
});
