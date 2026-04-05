import { describe, it, expect } from "vitest";
import { scheduleToCron, getLocalDate, defaultState } from "../src/orchestrator.js";

describe("scheduleToCron", () => {
  it("converts weekday schedule to cron", () => {
    expect(scheduleToCron({ time: "19:00", days: ["mon", "tue", "wed", "thu", "fri"] }))
      .toBe("00 19 * * 1,2,3,4,5");
  });

  it("converts weekend schedule to cron", () => {
    expect(scheduleToCron({ time: "22:00", days: ["sat", "sun"] }))
      .toBe("00 22 * * 0,6");
  });

  it("converts every day to * cron", () => {
    expect(scheduleToCron({ time: "08:00", days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] }))
      .toBe("00 08 * * *");
  });

  it("handles single day", () => {
    expect(scheduleToCron({ time: "09:30", days: ["mon"] }))
      .toBe("30 09 * * 1");
  });
});

describe("getLocalDate", () => {
  it("returns YYYY-MM-DD format", () => {
    const date = getLocalDate();
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("defaultState", () => {
  it("returns valid default state", () => {
    const state = defaultState();
    expect(state.collectors).toEqual({});
    expect(state.dreamPipeline.autoTrigger).toBe(true);
    expect(state.dreamPipeline.collectorsCompletedToday).toEqual([]);
  });
});
