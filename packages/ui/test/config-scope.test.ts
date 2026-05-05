import { describe, it, expect } from "vitest";
import { configAddsNewScope } from "../server.js";

describe("configAddsNewScope", () => {
  it("returns false when prev and next are identical", () => {
    const prev = { github_repo_urls: "https://github.com/a/b,https://github.com/c/d" };
    expect(configAddsNewScope(prev, prev)).toBe(false);
  });

  it("returns true when a comma-separated field gains an entry", () => {
    const prev = { github_repo_urls: "https://github.com/a/b" };
    const next = { github_repo_urls: "https://github.com/a/b,https://github.com/c/d" };
    expect(configAddsNewScope(prev, next)).toBe(true);
  });

  it("returns true when a newline-separated field gains an entry", () => {
    const prev = { watch_paths: "/Users/me/Projects" };
    const next = { watch_paths: "/Users/me/Projects\n/Users/me/Notes" };
    expect(configAddsNewScope(prev, next)).toBe(true);
  });

  it("returns false when a list shrinks (removed entry, no additions)", () => {
    const prev = { github_repo_urls: "https://github.com/a/b,https://github.com/c/d" };
    const next = { github_repo_urls: "https://github.com/a/b" };
    expect(configAddsNewScope(prev, next)).toBe(false);
  });

  it("returns false when a single-value field changes (token, domain, etc.)", () => {
    const prev = { jira_api_token: "old-token" };
    const next = { jira_api_token: "new-token" };
    expect(configAddsNewScope(prev, next)).toBe(false);
  });

  it("returns false when a single-value field changes alongside an unchanged list", () => {
    const prev = { jira_api_token: "old-token", jira_project_key: "VDP,SND" };
    const next = { jira_api_token: "new-token", jira_project_key: "VDP,SND" };
    expect(configAddsNewScope(prev, next)).toBe(false);
  });

  it("returns true when a list-style field is introduced for the first time", () => {
    const prev = { confluence_space_keys: "" };
    const next = { confluence_space_keys: "ENG,DOCS" };
    expect(configAddsNewScope(prev, next)).toBe(true);
  });

  it("ignores whitespace differences in list items", () => {
    const prev = { repos: "a/b, c/d" };
    const next = { repos: "a/b,c/d" }; // same set, just no spaces
    expect(configAddsNewScope(prev, next)).toBe(false);
  });

  it("returns true when a brand-new list field is added (e.g., new collector with default list)", () => {
    const prev = {};
    const next = { obsidian_vault_filter: "RWS\nmax_personal" };
    expect(configAddsNewScope(prev, next)).toBe(true);
  });
});
