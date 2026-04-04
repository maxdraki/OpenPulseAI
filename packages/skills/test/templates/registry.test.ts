import { describe, it, expect } from "vitest";
import { getTemplate, listTemplates } from "../../src/templates/registry.js";

describe("Template Registry", () => {
  it("lists all templates", () => {
    expect(listTemplates().sort()).toEqual(["github", "gmail", "google-calendar"]);
  });

  it("returns gmail template", () => {
    expect(getTemplate("gmail")).toBeDefined();
    expect(getTemplate("gmail")!.name).toBe("gmail");
  });

  it("returns undefined for unknown template", () => {
    expect(getTemplate("unknown")).toBeUndefined();
  });
});
