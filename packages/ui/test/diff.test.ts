import { describe, it, expect } from "vitest";
import { diffLines, renderDiffHtml, type DiffOp } from "../src/lib/diff.js";

function opsToString(ops: DiffOp[]): string {
  return ops.map((op) => `${op.type[0]}:${op.text}`).join("|");
}

describe("diffLines", () => {
  it("returns nothing for two empty strings", () => {
    expect(diffLines("", "")).toEqual([]);
  });

  it("treats identical content as all-equal ops", () => {
    const text = "line1\nline2\nline3";
    const ops = diffLines(text, text);
    expect(ops.every((op) => op.type === "equal")).toBe(true);
    expect(ops.map((op) => op.text)).toEqual(["line1", "line2", "line3"]);
  });

  it("when the left side is empty, every line is an add", () => {
    const ops = diffLines("", "a\nb\nc");
    expect(ops.every((op) => op.type === "add")).toBe(true);
    expect(ops.map((op) => op.text)).toEqual(["a", "b", "c"]);
  });

  it("when the right side is empty, every line is a remove", () => {
    const ops = diffLines("a\nb\nc", "");
    expect(ops.every((op) => op.type === "remove")).toBe(true);
    expect(ops.map((op) => op.text)).toEqual(["a", "b", "c"]);
  });

  it("insert-only: appended lines show up as adds after the shared prefix", () => {
    const ops = diffLines("a\nb", "a\nb\nc\nd");
    expect(opsToString(ops)).toBe("e:a|e:b|a:c|a:d");
  });

  it("delete-only: removed lines show up as removes", () => {
    const ops = diffLines("a\nb\nc\nd", "a\nb");
    expect(opsToString(ops)).toBe("e:a|e:b|r:c|r:d");
  });

  it("mixed: a changed middle line shows as a remove+add pair", () => {
    const ops = diffLines("a\nb\nc", "a\nX\nc");
    expect(opsToString(ops)).toBe("e:a|r:b|a:X|e:c");
  });

  it("interleaved changes across multiple non-adjacent lines", () => {
    const before = "a\nb\nc\nd\ne";
    const after = "a\nX\nc\nY\ne";
    const ops = diffLines(before, after);
    expect(opsToString(ops)).toBe("e:a|r:b|a:X|e:c|r:d|a:Y|e:e");
  });

  it("every input line is accounted for exactly once per side (equal counts as both)", () => {
    const before = "one\ntwo\nthree";
    const after = "one\nTWO\nthree\nfour";
    const ops = diffLines(before, after);
    const removedOrEqual = ops.filter((op) => op.type === "remove" || op.type === "equal").length;
    const addedOrEqual = ops.filter((op) => op.type === "add" || op.type === "equal").length;
    expect(removedOrEqual).toBe(before.split("\n").length);
    expect(addedOrEqual).toBe(after.split("\n").length);
  });
});

describe("renderDiffHtml", () => {
  it("emits a diff-add/diff-remove/diff-equal class per line", () => {
    const html = renderDiffHtml("a\nb\nc", "a\nX\nc");
    expect(html).toContain('class="diff-line diff-equal"');
    expect(html).toContain('class="diff-line diff-remove"');
    expect(html).toContain('class="diff-line diff-add"');
  });

  it("HTML-escapes line content", () => {
    const html = renderDiffHtml("", "<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("treats a null/empty previous side as all-added, for updates with no snapshot", () => {
    const html = renderDiffHtml("", "brand new content");
    expect(html).toContain("diff-add");
    expect(html).not.toContain("diff-remove");
  });
});
