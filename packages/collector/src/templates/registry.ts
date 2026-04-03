import type { CollectionTemplate } from "./types.js";
import { gmailTemplate } from "./gmail.js";
import { calendarTemplate } from "./google-calendar.js";
import { githubTemplate } from "./github.js";

const templates = new Map<string, CollectionTemplate>();
templates.set("gmail", gmailTemplate);
templates.set("google-calendar", calendarTemplate);
templates.set("github", githubTemplate);

export function getTemplate(name: string): CollectionTemplate | undefined {
  return templates.get(name);
}

export function listTemplates(): string[] {
  return [...templates.keys()];
}
