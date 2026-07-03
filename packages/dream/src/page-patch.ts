/**
 * Section-level page model for append/patch synthesis (see the Task 11
 * design brief). Instead of asking the LLM to regenerate an entire theme
 * page on every Dream run, `synthesize.ts`'s project/source-summary branch
 * can ask for a small set of structured operations against this model and
 * apply them deterministically — output tokens become proportional to the
 * delta rather than the whole page.
 *
 * `parsePageSections`/`serializeSections` are exact inverses of each other:
 * `serializeSections(parsePageSections(x)) === x` for any input string. This
 * is what makes `applyPatch` safe to use as a drop-in replacement for
 * whole-page rewrites — sections that no op touches survive byte-identical.
 */

export interface PageSection {
  /** Normalized section title (heading text without the leading "## ",
   *  trimmed) — used for op heading-matching. */
  heading: string;
  /** Verbatim heading line as it appears in the source (e.g. "## Current
   *  Status"), used for byte-exact serialization. */
  headingLine: string;
  /** Verbatim text following the heading line — includes the newline that
   *  terminates the heading line and runs up to (not including) the next
   *  heading line or end of document. */
  body: string;
}

export interface PageSections {
  /** Verbatim YAML frontmatter block (including delimiters), or "" if none. */
  frontmatter: string;
  /** Verbatim `<meta>...</meta>` block (see `parseMetaBlock` in
   *  synthesize.ts), or "" if none. Only recognized when it is the very
   *  first thing after frontmatter, matching how synthesis prompts emit it. */
  meta: string;
  /** Verbatim text between frontmatter/meta and the first "##" heading. */
  preamble: string;
  sections: PageSection[];
}

/** Ordered list of patch operations the LLM contract can emit — see the
 *  Task 11 design brief for the exact schema. */
export type PatchOp =
  | { op: "append_to_section"; heading: string; content: string }
  | { op: "replace_section"; heading: string; content: string }
  | { op: "add_section"; heading: string; content: string; after?: string | null }
  | { op: "update_meta"; status?: string; reason?: string };

export interface RejectedOp {
  op: PatchOp;
  reason: string;
}

export interface ApplyPatchResult {
  sections: PageSections;
  rejected: RejectedOp[];
}

/** A section body is considered suspiciously shrunk if a replace_section op
 *  would take it below this fraction of its original (trimmed) length. */
const REPLACE_SHRINK_THRESHOLD = 0.5;

function isFenceDelimiter(line: string): boolean {
  return /^```/.test(line);
}

function isLevel2Heading(line: string): boolean {
  return /^## [^#]/.test(line) || /^##\s*$/.test(line);
}

/** Byte offsets (into `text`) where each fence-outside "##"-level heading
 *  line begins, in document order. */
function findHeadingStarts(text: string): number[] {
  const starts: number[] = [];
  let inFence = false;
  let idx = 0;
  while (idx <= text.length) {
    const nlIdx = text.indexOf("\n", idx);
    const lineEnd = nlIdx === -1 ? text.length : nlIdx;
    const line = text.slice(idx, lineEnd);
    if (isFenceDelimiter(line)) {
      inFence = !inFence;
    } else if (!inFence && isLevel2Heading(line)) {
      starts.push(idx);
    }
    if (nlIdx === -1) break;
    idx = nlIdx + 1;
  }
  return starts;
}

/** Split a theme page into an ordered model: frontmatter (verbatim),
 *  optional `<meta>` status block (verbatim), preamble, and `##`-heading
 *  sections (heading + verbatim body). Round-trips byte-identically via
 *  `serializeSections`. */
export function parsePageSections(content: string): PageSections {
  const fmMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  const frontmatter = fmMatch ? fmMatch[0] : "";
  const afterFrontmatter = content.slice(frontmatter.length);

  const headingStarts = findHeadingStarts(afterFrontmatter);
  const head = headingStarts.length > 0 ? afterFrontmatter.slice(0, headingStarts[0]) : afterFrontmatter;
  const sectionsText = headingStarts.length > 0 ? afterFrontmatter.slice(headingStarts[0]) : "";

  const metaMatch = head.match(/^\s*<meta>[\s\S]*?<\/meta>/i);
  const meta = metaMatch ? metaMatch[0] : "";
  const preamble = metaMatch ? head.slice(meta.length) : head;

  const sections: PageSection[] = [];
  for (let i = 0; i < headingStarts.length; i++) {
    const start = headingStarts[i] - headingStarts[0];
    const end = i + 1 < headingStarts.length ? headingStarts[i + 1] - headingStarts[0] : sectionsText.length;
    const chunk = sectionsText.slice(start, end);
    const nlIdx = chunk.indexOf("\n");
    const headingLine = nlIdx === -1 ? chunk : chunk.slice(0, nlIdx);
    const body = nlIdx === -1 ? "" : chunk.slice(nlIdx);
    const heading = headingLine.replace(/^##\s*/, "").trim();
    sections.push({ heading, headingLine, body });
  }

  return { frontmatter, meta, preamble, sections };
}

/** Inverse of `parsePageSections`. */
export function serializeSections(sections: PageSections): string {
  return (
    sections.frontmatter +
    sections.meta +
    sections.preamble +
    sections.sections.map((s) => s.headingLine + s.body).join("")
  );
}

function findSectionIndex(sections: PageSection[], heading: string): number {
  const exact = sections.findIndex((s) => s.heading === heading);
  if (exact !== -1) return exact;
  const normalized = heading.trim().toLowerCase();
  return sections.findIndex((s) => s.heading.trim().toLowerCase() === normalized);
}

function parseMetaFields(meta: string): { status?: string; reason?: string } {
  const statusMatch = meta.match(/status:\s*([^\n]+)/i);
  const reasonMatch = meta.match(/reason:\s*([^\n]+)/i);
  return {
    status: statusMatch?.[1]?.trim(),
    reason: reasonMatch?.[1]?.trim(),
  };
}

function buildMetaBlock(status?: string, reason?: string): string {
  const lines = ["<meta>"];
  if (status) lines.push(`status: ${status}`);
  if (reason) lines.push(`reason: ${reason}`);
  lines.push("</meta>\n\n");
  return lines.join("\n");
}

/**
 * Apply an ordered list of patch operations to a page model. Pure: does not
 * mutate `sections`. Never deletes a section — the result always contains
 * every input section (compaction owns shrinking pages, not patch
 * synthesis). Unknown ops, ops targeting a missing heading, and
 * `replace_section` ops that would shrink a section by more than 50% are
 * rejected (collected in `rejected`); the rest are still applied.
 */
export function applyPatch(sections: PageSections, ops: PatchOp[]): ApplyPatchResult {
  let working: PageSections = {
    frontmatter: sections.frontmatter,
    meta: sections.meta,
    preamble: sections.preamble,
    sections: sections.sections.map((s) => ({ ...s })),
  };
  const rejected: RejectedOp[] = [];

  for (const op of ops) {
    switch (op.op) {
      case "append_to_section": {
        const idx = findSectionIndex(working.sections, op.heading);
        if (idx === -1) {
          rejected.push({ op, reason: `section not found: ${op.heading}` });
          break;
        }
        const target = working.sections[idx];
        const body = target.body.endsWith("\n") || target.body.length === 0
          ? target.body
          : target.body + "\n";
        const content = op.content.endsWith("\n") ? op.content : op.content + "\n";
        working.sections[idx] = { ...target, body: body + content };
        break;
      }
      case "replace_section": {
        const idx = findSectionIndex(working.sections, op.heading);
        if (idx === -1) {
          rejected.push({ op, reason: `section not found: ${op.heading}` });
          break;
        }
        const target = working.sections[idx];
        const originalLen = target.body.trim().length;
        const newLen = op.content.trim().length;
        if (originalLen > 0 && newLen < originalLen * REPLACE_SHRINK_THRESHOLD) {
          rejected.push({ op, reason: `replace_section would shrink "${op.heading}" by more than 50%` });
          break;
        }
        const content = op.content.endsWith("\n") ? op.content : op.content + "\n";
        working.sections[idx] = { ...target, body: `\n${content}` };
        break;
      }
      case "add_section": {
        let insertIdx: number;
        if (op.after === undefined) {
          insertIdx = working.sections.length;
        } else if (op.after === null) {
          insertIdx = 0;
        } else {
          const idx = findSectionIndex(working.sections, op.after);
          if (idx === -1) {
            rejected.push({ op, reason: `add_section "after" heading not found: ${op.after}` });
            break;
          }
          insertIdx = idx + 1;
        }
        const heading = op.heading.trim();
        const content = op.content.endsWith("\n") ? op.content : op.content + "\n";
        const newSection: PageSection = {
          heading,
          headingLine: `## ${heading}`,
          body: `\n${content}`,
        };
        working.sections.splice(insertIdx, 0, newSection);
        break;
      }
      case "update_meta": {
        if (op.status === undefined && op.reason === undefined) {
          rejected.push({ op, reason: "update_meta has no fields to apply" });
          break;
        }
        const existing = parseMetaFields(working.meta);
        const status = op.status ?? existing.status;
        const reason = op.reason ?? existing.reason;
        working.meta = buildMetaBlock(status, reason);
        break;
      }
      default: {
        rejected.push({ op, reason: `unknown op: ${(op as { op?: string }).op ?? "(missing)"}` });
        break;
      }
    }
  }

  return { sections: working, rejected };
}

/** Guard used by callers after `applyPatch`: every heading present before
 *  patching must still be present after (patch ops only add/replace, never
 *  delete). */
export function containsAllOriginalHeadings(before: PageSections, after: PageSections): boolean {
  const afterHeadings = new Set(after.sections.map((s) => s.heading.trim().toLowerCase()));
  return before.sections.every((s) => afterHeadings.has(s.heading.trim().toLowerCase()));
}
