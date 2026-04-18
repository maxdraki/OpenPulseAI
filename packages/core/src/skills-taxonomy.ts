/**
 * Seed taxonomy of skill tags that the classifier can confidently attach to an entry.
 *
 * Kept deliberately short and evidence-oriented — a skill tag should describe *something
 * the user actually did*, not a general area of knowledge. The classifier is allowed to
 * propose new tags; new tags go through the same review loop as new themes.
 *
 * Tags are lowercase-kebab-case.
 */

const LANGUAGE = [
  "typescript",
  "javascript",
  "python",
  "rust",
  "go",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "sql",
  "bash",
] as const;

const FRAMEWORK_PLATFORM = [
  "react",
  "nextjs",
  "vite",
  "node",
  "tauri",
  "docker",
  "kubernetes",
  "terraform",
  "aws",
  "gcp",
  "azure",
] as const;

const ACTIVITY = [
  "pr-review",         // reviewing someone else's PR
  "code-review",       // giving review feedback
  "pair-programming",
  "incident-debugging",
  "performance-tuning",
  "refactoring",
  "testing",           // writing/maintaining tests
  "technical-writing", // specs, docs, RFCs
  "system-design",
  "api-design",
  "data-modelling",
  "database-migration",
  "release-management",
  "ops",               // running production systems
] as const;

const DOMAIN = [
  "ml",
  "data-pipeline",
  "observability",
  "security",
  "accessibility",
  "developer-experience",
  "product-strategy",
  "project-planning",
  "stakeholder-comms",
] as const;

export const SEED_SKILLS: readonly string[] = [
  ...LANGUAGE,
  ...FRAMEWORK_PLATFORM,
  ...ACTIVITY,
  ...DOMAIN,
];

const SKILL_SET = new Set<string>(SEED_SKILLS);

/**
 * Strict format check — tag must already be lowercase-kebab-case.
 * To accept messier inputs from the LLM, normalise via `normaliseSkill` first.
 */
export function isValidSkillTag(tag: string): boolean {
  if (typeof tag !== "string") return false;
  if (tag.length < 2 || tag.length > 40) return false;
  return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(tag);
}

/** True if the skill is in the built-in taxonomy; false for classifier-proposed new tags. */
export function isKnownSkill(tag: string): boolean {
  return SKILL_SET.has(tag.trim().toLowerCase());
}

/**
 * Normalise a raw LLM-emitted skill tag: lowercase, trim, collapse whitespace to
 * hyphens, strip leading/trailing hyphens. Returns null when the result still
 * doesn't look like a valid tag.
 */
export function normaliseSkill(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const t = raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return isValidSkillTag(t) ? t : null;
}
