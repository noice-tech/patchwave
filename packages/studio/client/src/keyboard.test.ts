// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { isEditingTarget, shouldHandlePerformanceKey } from "./keyboard.js";

describe("performance keyboard focus safety", () => {
  it("ignores form controls and modifier shortcuts", () => {
    const mapped = new Set(["KeyA"]);
    const input = document.createElement("input");
    expect(isEditingTarget(input)).toBe(true);
    expect(
      shouldHandlePerformanceKey(
        { code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, target: input },
        mapped,
      ),
    ).toBe(false);
    expect(
      shouldHandlePerformanceKey(
        { code: "KeyA", ctrlKey: true, metaKey: false, altKey: false, target: document.body },
        mapped,
      ),
    ).toBe(false);
    expect(
      shouldHandlePerformanceKey(
        { code: "KeyA", ctrlKey: false, metaKey: false, altKey: false, target: document.body },
        mapped,
      ),
    ).toBe(true);
  });
});
