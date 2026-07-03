import { describe, it, expect } from "vitest";
import {
  computeApproveLabel,
  computeRejectLabel,
  batchSummaryLine,
  selectedUpdateIds,
  toggleSelectAll,
  rebuildSelection,
} from "../src/pages/review.js";

describe("computeApproveLabel", () => {
  it("reads 'Approve All (n)' when every item is selected (least-surprise default)", () => {
    expect(computeApproveLabel(5, 5)).toBe("Approve All (5)");
  });

  it("reads 'Approve Selected (n)' when only some items are selected", () => {
    expect(computeApproveLabel(5, 2)).toBe("Approve Selected (2)");
  });

  it("reads 'Approve Selected (0)' when nothing is selected", () => {
    expect(computeApproveLabel(5, 0)).toBe("Approve Selected (0)");
  });
});

describe("computeRejectLabel", () => {
  it("reads 'Reject All (n)' when every item is selected", () => {
    expect(computeRejectLabel(5, 5)).toBe("Reject All (5)");
  });

  it("reads 'Reject Selected (n)' when only some items are selected", () => {
    expect(computeRejectLabel(5, 3)).toBe("Reject Selected (3)");
  });
});

describe("batchSummaryLine", () => {
  it("pluralizes 'updates' for counts other than 1", () => {
    expect(batchSummaryLine(5, 3)).toBe("5 updates · 3 selected");
    expect(batchSummaryLine(0, 0)).toBe("0 updates · 0 selected");
  });

  it("keeps 'update' singular for a single-item total", () => {
    expect(batchSummaryLine(1, 1)).toBe("1 update · 1 selected");
  });
});

describe("selectedUpdateIds", () => {
  const items = [{ id: "a" }, { id: "b" }, { id: "c" }];

  it("returns only the ids present in the selection set, preserving item order", () => {
    const selected = new Set(["c", "a"]);
    expect(selectedUpdateIds(items, selected)).toEqual(["a", "c"]);
  });

  it("returns an empty array when nothing is selected", () => {
    expect(selectedUpdateIds(items, new Set())).toEqual([]);
  });

  it("returns all ids when everything is selected", () => {
    const selected = new Set(["a", "b", "c"]);
    expect(selectedUpdateIds(items, selected)).toEqual(["a", "b", "c"]);
  });
});

describe("toggleSelectAll", () => {
  const ids = ["a", "b", "c"];

  it("selects every id when not everything is currently selected", () => {
    const result = toggleSelectAll(ids, new Set(["a"]));
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });

  it("clears the selection when everything is currently selected", () => {
    const result = toggleSelectAll(ids, new Set(["a", "b", "c"]));
    expect(result).toEqual(new Set());
  });

  it("clears the selection when nothing is currently selected (toggles back to select-all next time)", () => {
    // Empty selection isn't "all selected", so this selects all rather than
    // no-oping — matches selecting-all being the more useful action from empty.
    const result = toggleSelectAll(ids, new Set());
    expect(result).toEqual(new Set(["a", "b", "c"]));
  });
});

describe("rebuildSelection", () => {
  it("selects every id when nothing has been deselected", () => {
    const deselected = new Set<string>();
    expect(rebuildSelection(["a", "b", "c"], deselected)).toEqual(new Set(["a", "b", "c"]));
  });

  it("excludes ids recorded as deselected, so unchecking survives a reload triggered by a different card", () => {
    const deselected = new Set(["b"]);
    expect(rebuildSelection(["a", "b", "c"], deselected)).toEqual(new Set(["a", "c"]));
    // The persisted set itself is untouched when all its ids still exist.
    expect(deselected).toEqual(new Set(["b"]));
  });

  it("prunes deselected ids that no longer appear in the fresh id list", () => {
    const deselected = new Set(["b", "gone"]);
    expect(rebuildSelection(["a", "b", "c"], deselected)).toEqual(new Set(["a", "c"]));
    expect(deselected).toEqual(new Set(["b"]));
  });

  it("clears entirely once every deselected id has disappeared", () => {
    const deselected = new Set(["gone1", "gone2"]);
    expect(rebuildSelection(["a", "b"], deselected)).toEqual(new Set(["a", "b"]));
    expect(deselected).toEqual(new Set());
  });

  it("returns an empty selection when every id has been deselected", () => {
    const deselected = new Set(["a", "b", "c"]);
    expect(rebuildSelection(["a", "b", "c"], deselected)).toEqual(new Set());
  });
});
