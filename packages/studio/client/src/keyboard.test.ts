// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { PerformanceKeyCapture, type PerformanceKeyEvent } from "./keyboard.js";

const mapped = new Set(["KeyA", "KeyZ"]);
const key = (code = "KeyA", overrides: Partial<PerformanceKeyEvent> = {}): PerformanceKeyEvent => ({
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  repeat: false,
  shiftKey: false,
  ...overrides,
});

describe("performance key ownership", () => {
  it("owns an initial connected mapped key and suppresses later modified repeats", () => {
    const capture = new PerformanceKeyCapture();
    expect(capture.keyDown(key(), mapped, true)).toEqual({ captured: true, send: true });
    expect(capture.owns("KeyA")).toBe(true);
    expect(capture.keyDown(key("KeyA", { ctrlKey: true, repeat: true }), mapped, false)).toEqual({
      captured: true,
      send: false,
    });
    expect(capture.keyUp("KeyA")).toBe(true);
    expect(capture.keyUp("KeyA")).toBe(false);
  });

  it("does not acquire ownership from a first-seen repeat", () => {
    const capture = new PerformanceKeyCapture();
    expect(capture.keyDown(key("KeyA", { repeat: true }), mapped, true)).toEqual({
      captured: false,
      send: false,
    });
    expect(capture.owns("KeyA")).toBe(false);
    expect(capture.keyUp("KeyA")).toBe(false);
  });

  it("leaves offline, unmapped, and command-modified keys unowned", () => {
    const cases: Array<[PerformanceKeyEvent, boolean]> = [
      [key("KeyA"), false],
      [key("KeyQ"), true],
      [key("KeyA", { ctrlKey: true }), true],
      [key("KeyA", { metaKey: true }), true],
      [key("KeyA", { altKey: true }), true],
    ];
    for (const [event, connected] of cases) {
      const capture = new PerformanceKeyCapture();
      expect(capture.keyDown(event, mapped, connected)).toEqual({ captured: false, send: false });
    }
  });

  it("allows Shift and releases ownership independently of keyup modifiers", () => {
    const capture = new PerformanceKeyCapture();
    expect(capture.keyDown(key("KeyZ", { shiftKey: true }), mapped, true)).toEqual({
      captured: true,
      send: true,
    });
    expect(capture.keyUp("KeyZ")).toBe(true);
  });

  it("clears all locally owned keys", () => {
    const capture = new PerformanceKeyCapture();
    capture.keyDown(key("KeyA"), mapped, true);
    capture.keyDown(key("KeyZ"), mapped, true);
    capture.clear();
    expect(capture.owns("KeyA")).toBe(false);
    expect(capture.owns("KeyZ")).toBe(false);
  });
});
