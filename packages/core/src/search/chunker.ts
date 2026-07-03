/**
 * Splits a warm theme markdown file into section-level chunks for the
 * search index (see `search/index-db.ts`). Reuses the frontmatter parser
 * from `warm.ts` — this is the one place a warm file's YAML block gets
 * parsed for tags; the frontmatter itself is never indexed as text.
 */
import { createHash } from "node:crypto";
import { parseFrontmatterBlock } from "../warm.js";

const MAX_CHUNK_CHARS = 2000;
const MIN_CHUNK_CHARS = 40;

export interface Chunk {
  theme: string;
  heading: string;
  text: string;
  tags: string[];
  contentHash: string;
}

/** Stable content hash (sha256, first 16 hex chars) — mirrors the idiom in
 *  `packages/dream/src/ledger.ts` (not imported: core must not depend on
 *  the dream package, which itself depends on core). */
function hashChunkText(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex").slice(0, 16);
}

function asStringArray(x: unknown): string[] {
  if (!Array.isArray(x)) return [];
  return x.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean);
}

interface RawSection {
  heading: string;
  text: string;
}

/** Splits the (frontmatter-stripped) body into `##`-heading sections. Content
 *  before the first `##` heading becomes a preamble section with heading `""`. */
function splitIntoSections(body: string): RawSection[] {
  const headingRegex = /^##[ \t]+(.+)$/gm;
  const matches: { heading: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRegex.exec(body)) !== null) {
    matches.push({ heading: m[1].trim(), start: m.index, end: m.index + m[0].length });
  }

  const sections: RawSection[] = [];

  const preambleEnd = matches.length > 0 ? matches[0].start : body.length;
  const preambleText = body.slice(0, preambleEnd).trim();
  if (preambleText.length > 0) {
    sections.push({ heading: "", text: preambleText });
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].end;
    const end = i + 1 < matches.length ? matches[i + 1].start : body.length;
    const text = body.slice(start, end).trim();
    if (text.length > 0) {
      sections.push({ heading: matches[i].heading, text });
    }
  }

  return sections;
}

/** Splits an oversized section's text at paragraph boundaries so no single
 *  chunk grows unbounded, while keeping the section's heading on each piece. */
function splitOversized(section: RawSection): RawSection[] {
  if (section.text.length <= MAX_CHUNK_CHARS) return [section];

  const paragraphs = section.text.split(/\n\s*\n/).filter((p) => p.trim().length > 0);
  const pieces: string[] = [];
  let current = "";
  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length > MAX_CHUNK_CHARS && current) {
      pieces.push(current);
      current = para;
    } else {
      current = candidate;
    }
  }
  if (current) pieces.push(current);

  return pieces.length > 0
    ? pieces.map((text) => ({ heading: section.heading, text }))
    : [section];
}

/** Merges any fragment shorter than `MIN_CHUNK_CHARS` into the immediately
 *  preceding chunk (first chunk is kept as-is if it's the only one, since
 *  there's nothing to merge into). */
function mergeTinyFragments(sections: RawSection[]): RawSection[] {
  const merged: RawSection[] = [];
  for (const section of sections) {
    if (section.text.length < MIN_CHUNK_CHARS && merged.length > 0) {
      const prev = merged[merged.length - 1];
      prev.text = `${prev.text}\n\n${section.text}`;
    } else {
      merged.push({ ...section });
    }
  }
  return merged;
}

export function chunkTheme(theme: string, content: string): Chunk[] {
  const { frontmatter, body } = parseFrontmatterBlock(content);
  const tags = asStringArray(frontmatter.skills);

  const sections = splitIntoSections(body);
  const withSplits = sections.flatMap(splitOversized);
  const finalSections = mergeTinyFragments(withSplits);

  return finalSections.map((section) => ({
    theme,
    heading: section.heading,
    text: section.text,
    tags,
    contentHash: hashChunkText(section.text),
  }));
}
