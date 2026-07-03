import { describe, it, expect } from "vitest";
import {
  parsePageSections,
  serializeSections,
  applyPatch,
  containsAllOriginalHeadings,
  type PatchOp,
} from "../src/page-patch.js";

describe("parsePageSections / serializeSections round-trip", () => {
  const fixtures: Record<string, string> = {
    "simple project page": "## Current Status\n\nAll good.\n## Activity Log\n### 2026-04-01\n- Did stuff.\n",
    "page with frontmatter": "---\ntheme: foo\ntype: project\n---\n\n## Current Status\n\nBody.\n",
    "page with meta block": "<meta>\nstatus: active\nreason: shipping\n</meta>\n\n## Current Status\n\nBody.\n",
    "page with frontmatter and meta": "---\ntheme: foo\n---\n\n<meta>\nstatus: active\n</meta>\n\n## Current Status\n\nBody.\n",
    "page with --- inside a body (horizontal rule)": "## Current Status\n\nBefore.\n\n---\n\nAfter the rule.\n## Activity Log\n- x\n",
    "page with code fence containing ##": "## Current Status\n\n```\n## not a real heading\n### also not real\n```\n\nStill in this section.\n## Activity Log\n- y\n",
    "page with no headings at all": "Just some preamble text with no sections.\n",
    "page with trailing whitespace": "## Current Status\n\nBody.   \n\n\n## Activity Log\n- z   \n\n",
    "page with only preamble before first heading": "Some intro text.\n\nMore intro.\n## Current Status\nBody.\n",
    "page with level-3 headings inside a section body": "## Current Status\nIntro.\n### Sub-heading\nDetail.\n## Activity Log\n- a\n",
    "empty content": "",
  };

  for (const [name, content] of Object.entries(fixtures)) {
    it(`round-trips byte-identically: ${name}`, () => {
      const sections = parsePageSections(content);
      expect(serializeSections(sections)).toBe(content);
    });
  }
});

describe("parsePageSections structure", () => {
  it("extracts frontmatter, meta, preamble and sections separately", () => {
    const content = "---\ntheme: foo\n---\n\n<meta>\nstatus: active\n</meta>\n\nSome preamble.\n## Current Status\n\nBody one.\n## Activity Log\n\nBody two.\n";
    const sections = parsePageSections(content);
    expect(sections.frontmatter).toBe("---\ntheme: foo\n---\n");
    expect(sections.meta).toContain("<meta>\nstatus: active\n</meta>");
    expect(sections.preamble).toContain("Some preamble.");
    expect(sections.sections.map((s) => s.heading)).toEqual(["Current Status", "Activity Log"]);
    expect(sections.sections[0].body).toContain("Body one.");
    expect(sections.sections[1].body).toContain("Body two.");
  });
});

describe("applyPatch", () => {
  function base(): ReturnType<typeof parsePageSections> {
    return parsePageSections(
      "## Current Status\n\nOriginal status.\n## Activity Log\n\n### 2026-04-01\n- Did stuff.\n## Skills Demonstrated\n- typescript\n"
    );
  }

  it("append_to_section appends content to the end of the named section", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "append_to_section", heading: "Activity Log", content: "### 2026-04-02\n- More stuff.\n" },
    ]);
    expect(rejected).toHaveLength(0);
    const out = serializeSections(sections);
    expect(out).toContain("### 2026-04-01");
    expect(out).toContain("### 2026-04-02");
    expect(out).toContain("- More stuff.");
    // Untouched sections remain byte-identical
    const currentStatus = sections.sections.find((s) => s.heading === "Current Status");
    expect(currentStatus?.body).toBe("\n\nOriginal status.\n");
  });

  it("replace_section replaces the section body", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "replace_section", heading: "Current Status", content: "Updated status with more detail than before." },
    ]);
    expect(rejected).toHaveLength(0);
    const out = serializeSections(sections);
    expect(out).toContain("Updated status with more detail than before.");
    expect(out).not.toContain("Original status.");
  });

  it("add_section inserts a new section after the named heading", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "add_section", heading: "New Section", content: "New content.", after: "Current Status" },
    ]);
    expect(rejected).toHaveLength(0);
    const headings = sections.sections.map((s) => s.heading);
    expect(headings).toEqual(["Current Status", "New Section", "Activity Log", "Skills Demonstrated"]);
  });

  it("add_section with after: null inserts right after the preamble (first section)", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "add_section", heading: "Intro", content: "Intro content.", after: null },
    ]);
    expect(rejected).toHaveLength(0);
    expect(sections.sections[0].heading).toBe("Intro");
  });

  it("add_section with no after inserts at the end", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "add_section", heading: "Trailer", content: "Trailer content." },
    ]);
    expect(rejected).toHaveLength(0);
    expect(sections.sections[sections.sections.length - 1].heading).toBe("Trailer");
  });

  it("update_meta creates a meta block when none existed", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "update_meta", status: "blocked", reason: "waiting on review" },
    ]);
    expect(rejected).toHaveLength(0);
    expect(sections.meta).toContain("status: blocked");
    expect(sections.meta).toContain("reason: waiting on review");
  });

  it("update_meta preserves the previously-set field when only one field is updated", () => {
    const withMeta = parsePageSections("<meta>\nstatus: active\nreason: shipping\n</meta>\n\n## Current Status\nBody.\n");
    const { sections, rejected } = applyPatch(withMeta, [{ op: "update_meta", status: "paused" }]);
    expect(rejected).toHaveLength(0);
    expect(sections.meta).toContain("status: paused");
    expect(sections.meta).toContain("reason: shipping");
  });

  it("matches headings case-insensitively/trimmed as a fallback", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "append_to_section", heading: "  current status  ", content: "Appended." },
    ]);
    expect(rejected).toHaveLength(0);
    expect(serializeSections(sections)).toContain("Appended.");
  });

  it("rejects append_to_section/replace_section for an unknown heading, applies the rest", () => {
    const { sections, rejected } = applyPatch(base(), [
      { op: "append_to_section", heading: "Nonexistent Section", content: "x" },
      { op: "append_to_section", heading: "Current Status", content: "Applied anyway." },
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/not found|unknown/i);
    expect(serializeSections(sections)).toContain("Applied anyway.");
  });

  it("rejects add_section when the 'after' heading doesn't exist", () => {
    const { rejected } = applyPatch(base(), [
      { op: "add_section", heading: "New", content: "x", after: "Nonexistent" },
    ]);
    expect(rejected).toHaveLength(1);
  });

  it("rejects an unknown op type", () => {
    const ops = [{ op: "delete_section", heading: "Current Status" } as unknown as PatchOp];
    const { rejected, sections } = applyPatch(base(), ops);
    expect(rejected).toHaveLength(1);
    // Original content untouched
    expect(sections.sections).toHaveLength(3);
  });

  it("rejects a replace_section that would shrink the section body by more than 50%", () => {
    const big = parsePageSections("## Current Status\n\n" + "x".repeat(1000) + "\n## Activity Log\n- y\n");
    const { rejected, sections } = applyPatch(big, [
      { op: "replace_section", heading: "Current Status", content: "y".repeat(100) },
    ]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatch(/shrink/i);
    // Section untouched since op was rejected
    expect(sections.sections[0].body).toContain("x".repeat(1000));
  });

  it("never deletes a section — output always contains every input section heading", () => {
    const before = base();
    const { sections } = applyPatch(before, [
      { op: "replace_section", heading: "Current Status", content: "Updated." },
      { op: "add_section", heading: "New", content: "New content." },
    ]);
    expect(containsAllOriginalHeadings(before, sections)).toBe(true);
  });
});
