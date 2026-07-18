import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { Patch } from "@patchwave/schema";
import {
  runCli,
  type CliAudioEngine,
  type CliLogger,
  type SignalSource,
  type WatcherLike,
} from "../src/cli.js";
import type { KeyboardInput } from "../src/keyboard.js";
import type { LoadedPatch } from "../src/load-patch.js";

class FakeInput extends EventEmitter {
  isTTY = true;
  isRaw = false;
  rawChanges: boolean[] = [];
  resumed = false;

  setRawMode(enabled: boolean): this {
    this.isRaw = enabled;
    this.rawChanges.push(enabled);
    return this;
  }
  resume(): this {
    this.resumed = true;
    return this;
  }
  pause(): this {
    this.resumed = false;
    return this;
  }
}

class FakeWatcher extends EventEmitter implements WatcherLike {
  closed = false;
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
  override on(event: string, listener: (...args: any[]) => void): this {
    return super.on(event, listener);
  }
  override once(event: string, listener: (...args: any[]) => void): this {
    return super.once(event, listener);
  }
  override off(event: string, listener: (...args: any[]) => void): this {
    return super.off(event, listener);
  }
}

class FakeEngine implements CliAudioEngine {
  applied: string[] = [];
  gates: boolean[] = [];
  starts = 0;
  stops = 0;
  runtimeError = false;

  applyPatch(serialized: string): void {
    this.applied.push(serialized);
  }
  setGate(enabled: boolean): void {
    this.gates.push(enabled);
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
  }
  takeRuntimeError(): boolean {
    const value = this.runtimeError;
    this.runtimeError = false;
    return value;
  }
}

function loaded(): LoadedPatch {
  const patch: Patch = {
    tempoBpm: 120,
    modulators: [],
    modulationRoutes: [],
    devices: [
      {
        id: "voice",
        type: "subtractiveSynth",
        enabled: true,
        baseFrequencyHz: 110,
        outputGain: 0.1,
        oscillators: [
          {
            id: "osc",
            waveform: "sine",
            octave: 0,
            semitone: 0,
            detuneCents: 0,
            level: 1,
            sends: { filter: 1, insert: 0, direct: 0 },
          },
        ],
        ampEnvelope: { attackSeconds: 0, decaySeconds: 0, sustain: 1, releaseSeconds: 0 },
        filter: { enabled: false, mode: "lowpass", cutoffHz: 20_000, resonance: 0, sends: { insert: 1, direct: 0 } },
        audioRateRoutes: [],
      },
    ],
  };
  return {
    patch,
    serialized: JSON.stringify(patch),
    summary: "120 BPM; 0 modulators; 0 routes; subtractiveSynth#voice",
  };
}

function logger(): CliLogger & {
  logs: string[];
  errors: string[];
} {
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    logs,
    errors,
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
  };
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("timed out waiting for fake CLI startup");
}

function startHarness(engine = new FakeEngine()) {
  const input = new FakeInput();
  const watcher = new FakeWatcher();
  const signals = new EventEmitter();
  const output = logger();
  const exitCodes: number[] = [];
  const promise = runCli({
    args: ["sound.ts"],
    invocationDirectory: "/virtual",
    input: input as KeyboardInput,
    createEngine: async () => engine,
    load: async () => loaded(),
    watch: () => {
      queueMicrotask(() => watcher.emit("ready"));
      return watcher;
    },
    isFile: async () => true,
    signals: signals as SignalSource,
    logger: output,
    setExitCode: (code) => exitCodes.push(code),
  });
  return { engine, input, watcher, signals, output, exitCodes, promise };
}

test("fake TTY drives one patch call, gate toggle, q, and cleanup", async () => {
  const harness = startHarness();
  await waitUntil(() => harness.input.listenerCount("data") > 0);
  harness.input.emit("data", Buffer.from(" q"));
  const code = await harness.promise;

  assert.equal(code, 0);
  assert.equal(harness.engine.applied.length, 1);
  assert.equal(harness.engine.starts, 1);
  assert.equal(harness.engine.stops, 1);
  assert.deepEqual(harness.engine.gates, [false, true, false]);
  assert.deepEqual(harness.input.rawChanges, [true, false]);
  assert.equal(harness.input.resumed, false);
  assert.equal(harness.watcher.closed, true);
  assert.match(harness.output.logs.join("\n"), /Chain: 120 BPM; 0 modulators; 0 routes; subtractiveSynth#voice/);
});

test("raw Ctrl+C and SIGTERM both use the normal cleanup path", async () => {
  const ctrl = startHarness();
  await waitUntil(() => ctrl.input.listenerCount("data") > 0);
  ctrl.input.emit("data", Buffer.from("\u0003"));
  assert.equal(await ctrl.promise, 0);
  assert.equal(ctrl.engine.stops, 1);

  const term = startHarness();
  await waitUntil(() => term.input.listenerCount("data") > 0);
  term.signals.emit("SIGTERM");
  assert.equal(await term.promise, 0);
  assert.equal(term.engine.stops, 1);
});

test("runtime-error polling reports failure and shuts down", async () => {
  const engine = new FakeEngine();
  engine.runtimeError = true;
  const harness = startHarness(engine);
  const code = await harness.promise;
  assert.equal(code, 1);
  assert.equal(engine.stops, 1);
  assert.match(harness.output.errors.join("\n"), /runtime error/);
});
