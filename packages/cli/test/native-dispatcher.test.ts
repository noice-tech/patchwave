import assert from "node:assert/strict";
import test from "node:test";
import { NativeDispatcher, type RuntimeAudioEngine } from "../src/native-dispatcher.js";

class FakeEngine implements RuntimeAudioEngine {
  accept = false;
  calls: string[] = [];
  tryApplyPatch(value: string): boolean {
    this.calls.push(`update:${value}`);
    return this.accept;
  }
  tryApplyPatchAndNoteOn(value: string): boolean {
    this.calls.push(`on:${value}`);
    return this.accept;
  }
  tryNoteOff(): boolean {
    this.calls.push("off");
    return this.accept;
  }
  start(): void {}
  stop(): void {}
  takeRuntimeError(): boolean {
    return false;
  }
}

test("semantic voice work supersedes an older steady frame while preserving voice FIFO", () => {
  const engine = new FakeEngine();
  let retry: (() => void) | undefined;
  const accepted: string[] = [];
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: assert.fail,
    schedule: (callback) => {
      retry = callback;
      return 1 as unknown as ReturnType<typeof setTimeout>;
    },
    cancel: () => undefined,
  });
  dispatcher.setSteadyPatch("old");
  dispatcher.setSteadyPatch("latest");
  dispatcher.enqueueNoteOn("a", () => accepted.push("a"));
  dispatcher.enqueueUpdate("b", () => accepted.push("b"));
  dispatcher.enqueueNoteOff(() => accepted.push("off"));
  engine.accept = true;
  retry!();
  assert.deepEqual(accepted, ["a", "b", "off"]);
  assert.deepEqual(engine.calls.slice(-3), ["on:a", "update:b", "off"]);
  assert.equal(engine.calls.filter((call) => call === "update:latest").length, 1);
});

test("a later steady frame may follow accepted semantic voice work", () => {
  const engine = new FakeEngine();
  engine.accept = true;
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: assert.fail,
  });
  dispatcher.enqueueNoteOn("voice");
  dispatcher.setSteadyPatch("new-voice-frame");
  assert.deepEqual(engine.calls, ["on:voice", "update:new-voice-frame"]);
});

test("targeted cancellation removes only the selected operation and preserves FIFO", () => {
  const engine = new FakeEngine();
  const accepted: string[] = [];
  const cancelled: string[] = [];
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: assert.fail,
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => undefined,
  });
  dispatcher.enqueueNoteOnOperation("first", () => accepted.push("first"));
  const reload = dispatcher.enqueueUpdateOperation(
    "reload",
    () => accepted.push("reload"),
    () => cancelled.push("reload"),
  );
  dispatcher.enqueueNoteOffOperation(() => accepted.push("off"));

  assert.ok(reload?.cancel());
  engine.accept = true;
  dispatcher.pump();

  assert.deepEqual(cancelled, ["reload"]);
  assert.deepEqual(accepted, ["first", "off"]);
  assert.deepEqual(engine.calls.slice(-2), ["on:first", "off"]);
});

test("bounded semantic queue reports overflow without coalescing voice events", () => {
  const engine = new FakeEngine();
  let overflows = 0;
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: () => {
      overflows += 1;
    },
    schedule: () => 1 as unknown as ReturnType<typeof setTimeout>,
    cancel: () => undefined,
  });
  for (let index = 0; index < 64; index += 1) assert.equal(dispatcher.enqueueNoteOff(), true);
  assert.equal(dispatcher.enqueueNoteOff(), false);
  assert.equal(overflows, 1);
});
