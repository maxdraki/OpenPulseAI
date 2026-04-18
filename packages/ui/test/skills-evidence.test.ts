import { describe, it, expect } from "vitest";
import { aggregateSkills } from "../src/pages/skills-evidence.js";
import type { WarmTheme } from "../src/lib/tauri-bridge.js";

function theme(overrides: Partial<WarmTheme>): WarmTheme {
  return {
    theme: overrides.theme ?? "x",
    content: "",
    lastUpdated: overrides.lastUpdated ?? "2026-04-01T00:00:00Z",
    type: "project",
    skills: overrides.skills,
    status: overrides.status,
    statusReason: overrides.statusReason,
  };
}

describe("aggregateSkills", () => {
  it("returns empty array when no themes have skills", () => {
    expect(aggregateSkills([])).toEqual([]);
    expect(aggregateSkills([theme({ theme: "a" })])).toEqual([]);
  });

  it("aggregates themes per skill and tracks last-demonstrated", () => {
    const themes: WarmTheme[] = [
      theme({ theme: "openpulse", lastUpdated: "2026-04-18T10:00:00Z", skills: ["typescript", "system-design"] }),
      theme({ theme: "aigis",     lastUpdated: "2026-04-12T10:00:00Z", skills: ["typescript", "pr-review"] }),
      theme({ theme: "dream",     lastUpdated: "2026-04-05T10:00:00Z", skills: ["typescript"] }),
    ];

    const result = aggregateSkills(themes);

    const ts = result.find((s) => s.skill === "typescript");
    expect(ts?.themes).toHaveLength(3);
    expect(ts?.lastDemonstrated).toBe("2026-04-18T10:00:00Z");

    const review = result.find((s) => s.skill === "pr-review");
    expect(review?.themes).toHaveLength(1);
    expect(review?.lastDemonstrated).toBe("2026-04-12T10:00:00Z");
  });

  it("sorts most-evidenced skills first, then by recency", () => {
    const themes: WarmTheme[] = [
      theme({ theme: "old-project",  lastUpdated: "2025-01-01T00:00:00Z", skills: ["ops", "docker"] }),
      theme({ theme: "new-project",  lastUpdated: "2026-04-18T00:00:00Z", skills: ["typescript"] }),
      theme({ theme: "other-new",    lastUpdated: "2026-04-17T00:00:00Z", skills: ["typescript"] }),
    ];

    const result = aggregateSkills(themes);
    // typescript has count 2, ops/docker each count 1 — typescript leads
    expect(result[0].skill).toBe("typescript");
    expect(result[0].themes).toHaveLength(2);
  });

  it("ignores themes with missing or non-array skills field", () => {
    const themes: WarmTheme[] = [
      theme({ theme: "a", skills: undefined }),
      theme({ theme: "b", skills: ["typescript"] }),
      theme({ theme: "c", skills: ["invalid" as any] as any }),
    ];
    const result = aggregateSkills(themes);
    expect(result.map((r) => r.skill).sort()).toEqual(["invalid", "typescript"]);
  });

  it("keeps skill list stable when lastUpdated ties", () => {
    const themes: WarmTheme[] = [
      theme({ theme: "first",  lastUpdated: "2026-04-10T00:00:00Z", skills: ["observability"] }),
      theme({ theme: "second", lastUpdated: "2026-04-10T00:00:00Z", skills: ["observability"] }),
    ];
    const result = aggregateSkills(themes);
    expect(result[0].themes).toHaveLength(2);
  });
});
