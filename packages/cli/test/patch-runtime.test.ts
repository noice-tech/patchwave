import assert from "node:assert/strict";
import test from "node:test";
import { KeyboardState } from "@patchwave/studio";
import type { PatchProgramContext } from "@patchwave/schema";
import { NativeDispatcher, type RuntimeAudioEngine } from "../src/native-dispatcher.js";
import { PatchRuntime } from "../src/patch-runtime.js";
import { normalizePatchModuleExport } from "../src/load-patch.js";

class FakeEngine implements RuntimeAudioEngine {
  accept = true;
  updates: string[] = [];
  noteOns: string[] = [];
  acceptedCalls: string[] = [];
  offs = 0;
  tryApplyPatch(value: string): boolean {
    this.updates.push(value);
    if (this.accept) this.acceptedCalls.push(`update:${value}`);
    return this.accept;
  }
  tryApplyPatchAndNoteOn(value: string): boolean {
    this.noteOns.push(value);
    if (this.accept) this.acceptedCalls.push(`on:${value}`);
    return this.accept;
  }
  tryNoteOff(): boolean {
    this.offs += 1;
    if (this.accept) this.acceptedCalls.push("off");
    return this.accept;
  }
  start(): void {}
  stop(): void {}
  takeRuntimeError(): boolean {
    return false;
  }
}

function harness(program: (context: PatchProgramContext) => any) {
  const engine = new FakeEngine();
  const errors: string[] = [];
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: assert.fail,
  });
  let now = 0;
  let scheduled: (() => void) | undefined;
  const runtime = new PatchRuntime({
    initialModule: normalizePatchModuleExport(program),
    initialVoice: { frequencyHz: 261.625565, gate: false },
    dispatcher,
    onState: () => undefined,
    onProgramError: (message) => errors.push(message),
    clock: {
      now: () => now,
      schedule: (callback) => {
        scheduled = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      },
      cancel: () => undefined,
    },
  });
  return {
    dispatcher,
    engine,
    errors,
    runtime,
    setNow(value: number) {
      now = value;
    },
    pulse() {
      scheduled!();
    },
  };
}

const patch = (frequencyHz: number, cutoffHz = 200) => ({
  source: {
    frequencyHz,
    oscillators: [{ waveform: "saw" as const }],
    filter: { cutoffHz },
  },
});

test("evaluates exact logical frames, reacts immediately to voice input, and keeps time across reload", async () => {
  const contexts: PatchProgramContext[] = [];
  const run = harness((context) => {
    contexts.push(context);
    return patch(context.voice.frequencyHz, 200 + context.frame);
  });
  run.runtime.start();
  run.setNow(51);
  run.pulse();
  assert.deepEqual(
    contexts.map((context) => context.frame),
    [0, 3],
  );

  const keyboard = new KeyboardState();
  assert.equal(run.runtime.handleKeyboard(keyboard.keyDown("KeyA")), true);
  assert.equal(run.engine.noteOns.length, 1);
  assert.equal(
    JSON.parse(run.engine.noteOns[0]).source.frequencyHz,
    keyboard.snapshot().voice.frequencyHz,
  );

  const reloadedFrames: number[] = [];
  const accepted = await run.runtime.stageReload(
    normalizePatchModuleExport((context: PatchProgramContext) => {
      reloadedFrames.push(context.frame);
      return patch(context.voice.frequencyHz, 800);
    }),
  );
  assert.equal(accepted, true);
  assert.deepEqual(reloadedFrames, [3]);
  assert.equal(run.runtime.snapshot().frame, 3);
  run.runtime.stop();
});

test("queues keyboard transitions behind a transactional reload", async () => {
  const run = harness(({ voice }) => patch(voice.frequencyHz, 200));
  run.runtime.start();
  run.engine.accept = false;
  const reload = run.runtime.stageReload(
    normalizePatchModuleExport(({ voice }: PatchProgramContext) => patch(voice.frequencyHz, 900)),
  );
  const keyboard = new KeyboardState();
  assert.equal(run.runtime.handleKeyboard(keyboard.keyDown("KeyA")), true);
  assert.equal(run.engine.noteOns.length, 0);
  run.engine.accept = true;
  assert.equal(await reload, true);
  for (let attempt = 0; attempt < 20 && run.engine.noteOns.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.equal(run.engine.noteOns.length, 1);
  assert.equal(JSON.parse(run.engine.noteOns[0]).source.filter.cutoffHz, 900);
  run.runtime.stop();
});

test("backpressured pre-input frame cannot roll back a newer note-on", async () => {
  const run = harness(({ frame, voice }) => patch(voice.frequencyHz, 200 + frame));
  run.runtime.start();
  run.engine.acceptedCalls = [];
  run.engine.accept = false;
  run.setNow(17);
  run.pulse();

  const keyboard = new KeyboardState();
  const note = keyboard.keyDown("KeyD");
  assert.equal(run.runtime.handleKeyboard(note), true);
  run.engine.accept = true;
  for (let attempt = 0; attempt < 20 && run.engine.acceptedCalls.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  assert.equal(run.engine.acceptedCalls.length, 1);
  assert.match(run.engine.acceptedCalls[0], /^on:/);
  const accepted = JSON.parse(run.engine.acceptedCalls[0].slice(3));
  assert.equal(accepted.source.frequencyHz, note.snapshot.voice.frequencyHz);
  assert.equal(accepted.source.filter.cutoffHz, 201);
  run.runtime.stop();
  run.dispatcher.stop();
});

test("pending backpressured reload resolves false on dispatcher shutdown and cannot activate later", async () => {
  const run = harness(({ voice }) => patch(voice.frequencyHz, 200));
  run.runtime.start();
  run.engine.accept = false;
  const before = run.runtime.snapshot().patch.source.filter?.cutoffHz;
  const reload = run.runtime.stageReload(
    normalizePatchModuleExport(({ voice }: PatchProgramContext) => patch(voice.frequencyHz, 900)),
  );

  run.dispatcher.stop();
  assert.equal(await reload, false);
  run.engine.accept = true;
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(run.runtime.snapshot().patch.source.filter?.cutoffHz, before);
  run.runtime.stop();
});

test("runtime stop cancels its backpressured reload so pumping cannot accept it later", async () => {
  const run = harness(({ voice }) => patch(voice.frequencyHz, 200));
  run.runtime.start();
  run.engine.acceptedCalls = [];
  run.engine.accept = false;
  const reload = run.runtime.stageReload(
    normalizePatchModuleExport(({ voice }: PatchProgramContext) => patch(voice.frequencyHz, 900)),
  );

  run.runtime.stop();
  assert.equal(await reload, false);
  run.engine.accept = true;
  run.dispatcher.pump();
  assert.deepEqual(run.engine.acceptedCalls, []);
  assert.equal(run.runtime.snapshot().patch.source.filter?.cutoffHz, 200);
  run.dispatcher.stop();
});

test("safety release cancels a staged reload and note-on before ordered note-off", async () => {
  const run = harness(({ voice }) => patch(voice.frequencyHz, 200));
  run.runtime.start();
  run.engine.acceptedCalls = [];
  run.engine.accept = false;
  const reload = run.runtime.stageReload(
    normalizePatchModuleExport(({ voice }: PatchProgramContext) => patch(voice.frequencyHz, 900)),
  );
  const keyboard = new KeyboardState();
  assert.equal(run.runtime.handleKeyboard(keyboard.keyDown("KeyA")), true);

  run.runtime.releaseVoice();
  assert.equal(await reload, false);
  run.engine.accept = true;
  run.dispatcher.pump();

  assert.equal(run.engine.acceptedCalls[0], "off");
  assert.match(run.engine.acceptedCalls[1] ?? "", /^update:/);
  assert.equal(run.engine.noteOns.length, 0);
  assert.equal(run.runtime.snapshot().patch.source.filter?.cutoffHz, 200);
  run.runtime.stop();
  run.dispatcher.stop();
});

test("rejects time-varying topology, retains the last patch, and evaluates future frames", () => {
  const frames: number[] = [];
  const run = harness((context) => {
    frames.push(context.frame);
    return {
      ...patch(110),
      effects: context.frame === 1 ? [{ type: "saturator" as const, driveDb: 3 }] : [],
    };
  });
  run.runtime.start();
  const initial = run.runtime.snapshot().patch;
  run.setNow(17);
  run.pulse();
  assert.match(run.errors.at(-1) ?? "", /changed structure/);
  assert.deepEqual(run.runtime.snapshot().patch, initial);
  run.setNow(34);
  run.pulse();
  assert.deepEqual(frames, [0, 1, 2]);
  assert.equal(run.runtime.snapshot().error, null);
  run.runtime.stop();
});

test("program scalar preview persists across frames and cancel restores source evaluation", () => {
  const run = harness(({ voice, frame }) => ({
    source: {
      frequencyHz: voice.frequencyHz,
      oscillators: [{ waveform: "saw" as const }],
      filter: { cutoffHz: 200 + frame, resonance: 0.2 },
    },
  }));
  run.runtime.start();
  assert.equal(
    run.runtime.previewField("gesture", "a".repeat(64), ["source", "filter", "resonance"], 0.8),
    true,
  );
  assert.equal(JSON.parse(run.engine.updates.at(-1)!).source.filter.resonance, 0.8);
  run.setNow(34);
  run.pulse();
  assert.equal(JSON.parse(run.engine.updates.at(-1)!).source.filter.resonance, 0.8);
  assert.equal(run.runtime.cancelPreview("gesture"), true);
  assert.equal(JSON.parse(run.engine.updates.at(-1)!).source.filter.resonance, 0.2);
  run.runtime.stop();
});

test("rapid previews coalesce outside the ordered voice queue", () => {
  const run = harness(({ voice }) => ({
    source: {
      frequencyHz: voice.frequencyHz,
      oscillators: [{ waveform: "saw" as const }],
      filter: { cutoffHz: 500, resonance: 0 },
    },
  }));
  run.runtime.start();
  run.engine.accept = false;
  for (let index = 0; index < 100; index += 1) {
    assert.equal(
      run.runtime.previewField("g", "a".repeat(64), ["source", "filter", "resonance"], index / 100),
      true,
    );
  }
  assert.equal(run.dispatcher.pendingVoiceOperations, 0);
  run.engine.accept = true;
  run.dispatcher.pump();
  assert.equal(
    JSON.parse(run.engine.acceptedCalls.at(-1)!.slice("update:".length)).source.filter.resonance,
    0.99,
  );
  run.runtime.stop();
});

test("static base-frequency preview never overrides or persists a held keyboard note", () => {
  const engine = new FakeEngine();
  const dispatcher = new NativeDispatcher({
    engine,
    onError: (error) => assert.fail(String(error)),
    onOverflow: assert.fail,
  });
  const runtime = new PatchRuntime({
    initialModule: normalizePatchModuleExport({
      source: { frequencyHz: 110, oscillators: [{ waveform: "sine" }] },
    }),
    initialVoice: { frequencyHz: 261.625565, gate: false },
    dispatcher,
    onState: () => undefined,
    onProgramError: (message) => assert.fail(message),
  });
  const keyboard = new KeyboardState();
  const action = keyboard.keyDown("KeyA");
  assert.equal(runtime.handleKeyboard(action), true);
  const played = keyboard.snapshot().voice.frequencyHz;
  assert.equal(runtime.previewField("g", "a".repeat(64), ["source", "frequencyHz"], 220), true);
  assert.equal(JSON.parse(engine.updates.at(-1)!).source.frequencyHz, played);
  assert.equal(runtime.cancelPreview("g"), true);
  assert.equal(JSON.parse(engine.updates.at(-1)!).source.frequencyHz, played);
  runtime.releaseVoice();
  dispatcher.stop();
});

test("stale preview target is dropped instead of rejecting a valid reload", async () => {
  const run = harness(({ voice }) => ({
    source: {
      frequencyHz: voice.frequencyHz,
      oscillators: [{ waveform: "saw" as const }],
      filter: { cutoffHz: 500, resonance: 0.2 },
    },
  }));
  assert.equal(
    run.runtime.previewField("g", "a".repeat(64), ["source", "filter", "resonance"], 0.8),
    true,
  );
  const accepted = await run.runtime.stageReload(
    normalizePatchModuleExport(({ voice }: PatchProgramContext) => ({
      source: { frequencyHz: voice.frequencyHz, oscillators: [{ waveform: "sine" as const }] },
    })),
  );
  assert.equal(accepted, true);
  assert.equal(run.runtime.snapshot().patch.source.filter, null);
  run.runtime.stop();
});

test("stop cancels a pending note-on so pumping cannot reopen the gate", () => {
  const run = harness(({ voice }) => patch(voice.frequencyHz));
  run.engine.accept = false;
  const keyboard = new KeyboardState();
  assert.equal(run.runtime.handleKeyboard(keyboard.keyDown("KeyA")), true);
  run.runtime.stop();
  run.engine.accept = true;
  run.dispatcher.pump();
  assert.equal(
    run.engine.acceptedCalls.some((call) => call.startsWith("on:")),
    false,
  );
  run.dispatcher.stop();
});

test("safety release orders note-off before restoring source parameters", () => {
  const run = harness(({ voice }) => ({
    source: {
      frequencyHz: voice.frequencyHz,
      oscillators: [{ waveform: "saw" as const }],
      filter: { cutoffHz: 500, resonance: 0.2 },
    },
  }));
  assert.equal(
    run.runtime.previewField("g", "a".repeat(64), ["source", "filter", "resonance"], 0.8),
    true,
  );
  run.engine.acceptedCalls = [];
  run.runtime.releaseVoice();
  assert.equal(run.engine.acceptedCalls[0], "off");
  const restored = JSON.parse(run.engine.acceptedCalls[1].slice("update:".length));
  assert.equal(restored.source.filter.resonance, 0.2);
  run.runtime.stop();
  run.dispatcher.stop();
});
