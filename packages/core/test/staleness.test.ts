import { describe, it, expect } from "vitest";
import { checkStaleness, normalizeContentForCompare } from "../src/staleness.js";

describe("normalizeContentForCompare", () => {
  it("strips trailing whitespace per line and at the end", () => {
    expect(normalizeContentForCompare("a  \nb\t\n c \n\n")).toBe("a\nb\n c");
  });

  it("treats null/undefined as empty", () => {
    expect(normalizeContentForCompare(null)).toBe("");
    expect(normalizeContentForCompare(undefined)).toBe("");
  });
});

describe("checkStaleness", () => {
  it("is not stale when previousContent matches current content exactly", () => {
    const result = checkStaleness("## Body\ncontent", "## Body\ncontent");
    expect(result).toEqual({ stale: false, legacy: false });
  });

  it("is stale when current content diverges from previousContent", () => {
    const result = checkStaleness("## Body\nold", "## Body\nnew");
    expect(result.stale).toBe(true);
    expect(result.legacy).toBe(false);
  });

  it("ignores trailing-whitespace-only differences", () => {
    const result = checkStaleness("## Body\ncontent\n", "## Body\ncontent   \n\n");
    expect(result.stale).toBe(false);
  });

  it("treats missing file and empty previousContent as equal for brand-new themes", () => {
    expect(checkStaleness(null, null).stale).toBe(false);
    expect(checkStaleness(null, undefined).stale).toBe(false);
    expect(checkStaleness(null, "").stale).toBe(false);
  });

  it("is stale when previousContent is null but current content now has real content", () => {
    expect(checkStaleness(null, "## Body\nsomething new").stale).toBe(true);
  });

  it("treats an absent (undefined) previousContent as a legacy record — never stale", () => {
    const result = checkStaleness(undefined, "## Body\nanything at all");
    expect(result).toEqual({ stale: false, legacy: true });
  });
});
