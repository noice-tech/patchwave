import assert from "node:assert/strict";
import test from "node:test";
import { ControlClock } from "../src/control-clock.js";

test("emits frame zero implicitly and skips missed logical frames without catch-up bursts", () => {
  let now = 100;
  let scheduled: (() => void) | undefined;
  const frames: number[] = [];
  const clock = new ControlClock({
    now: () => now,
    schedule: (callback) => {
      scheduled = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
    onFrame: (frame) => frames.push(frame),
  });
  clock.start();
  assert.equal(clock.frame(), 0);
  now = 151;
  scheduled!();
  assert.deepEqual(frames, [3]);
  assert.equal(clock.frame(), 3);
  scheduled!();
  assert.deepEqual(frames, [3]);
  clock.stop();
});
