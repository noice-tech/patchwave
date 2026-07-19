import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { validatePatch } from "@patchwave/schema";
import {
  runCli,
  type CliAudioEngine,
  type CliLogger,
  type SignalSource,
  type WatcherLike,
} from "../src/cli.js";
import type { PatchModule } from "../src/load-patch.js";
import type { StudioServer, StudioServerOptions } from "@patchwave/studio";

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
  updates: string[] = [];
  noteOns: string[] = [];
  noteOffs = 0;
  starts = 0;
  stops = 0;
  runtimeError = false;
  accept = true;
  accepted: string[] = [];
  events: string[] = [];

  tryApplyPatch(serialized: string): boolean {
    this.updates.push(serialized);
    if (this.accept) this.accepted.push(`update:${serialized}`);
    return this.accept;
  }
  tryApplyPatchAndNoteOn(serialized: string): boolean {
    this.noteOns.push(serialized);
    if (this.accept) this.accepted.push(`on:${serialized}`);
    return this.accept;
  }
  tryNoteOff(): boolean {
    this.noteOffs += 1;
    if (this.accept) {
      this.accepted.push("off");
      this.events.push("off");
    }
    return this.accept;
  }
  start(): void {
    this.starts += 1;
  }
  stop(): void {
    this.stops += 1;
    this.events.push("stop");
  }
  takeRuntimeError(): boolean {
    const value = this.runtimeError;
    this.runtimeError = false;
    return value;
  }
}

class FakeStudio implements StudioServer {
  url = "http://127.0.0.1:1234/session/test/";
  states: unknown[] = [];
  closed = false;
  disconnected = false;
  publish(state: unknown): void {
    this.states.push(state);
  }
  disconnect(): void {
    this.disconnected = true;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

function patchModule(frequencyHz = 110): PatchModule {
  return {
    kind: "static",
    patch: validatePatch({ source: { frequencyHz, oscillators: [{ waveform: "sine" }] } }),
  };
}

function logger(): CliLogger & { logs: string[]; errors: string[] } {
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

function startHarness(
  engine = new FakeEngine(),
  load: (path: string) => Promise<PatchModule> = async () => patchModule(),
) {
  const watcher = new FakeWatcher();
  const signals = new EventEmitter();
  const output = logger();
  const studio = new FakeStudio();
  let studioOptions: StudioServerOptions | undefined;
  const opened: string[] = [];
  const promise = runCli({
    args: ["sound.ts"],
    invocationDirectory: "/virtual",
    createEngine: async () => engine,
    load,
    watch: () => {
      queueMicrotask(() => watcher.emit("ready"));
      return watcher;
    },
    isFile: async () => true,
    startStudio: async (options) => {
      studioOptions = options;
      return studio;
    },
    openUrl: (url) => opened.push(url),
    signals: signals as SignalSource,
    logger: output,
    setExitCode: () => undefined,
  });
  return {
    engine,
    watcher,
    signals,
    output,
    studio,
    opened,
    promise,
    get studioOptions() {
      return studioOptions;
    },
  };
}

test("browser input drives ordered notes and normal cleanup without a TTY", async () => {
  const harness = startHarness();
  await waitUntil(() => harness.studioOptions !== undefined);
  harness.studioOptions!.onInput({ type: "keyDown", code: "KeyA" });
  harness.studioOptions!.onInput({ type: "keyDown", code: "KeyD" });
  harness.studioOptions!.onInput({ type: "keyUp", code: "KeyD" });
  harness.studioOptions!.onInput({ type: "keyUp", code: "KeyA" });
  harness.studioOptions!.onInput({ type: "keyDown", code: "KeyF" });
  harness.signals.emit("SIGTERM");
  const code = await harness.promise;

  assert.equal(code, 0);
  assert.equal(harness.engine.starts, 1);
  assert.equal(harness.engine.stops, 1);
  assert.equal(harness.engine.noteOns.length, 3);
  assert.ok(harness.engine.updates.length >= 2);
  assert.ok(harness.engine.noteOffs >= 1);
  assert.ok(harness.engine.events.indexOf("off") < harness.engine.events.indexOf("stop"));
  assert.equal(harness.studio.closed, true);
  assert.deepEqual(harness.opened, [harness.studio.url]);
  assert.match(harness.output.logs.join("\n"), /Studio: http:\/\/127\.0\.0\.1/);
});

test("SIGINT releases a held key before stopping audio", async () => {
  const harness = startHarness();
  await waitUntil(() => harness.studioOptions !== undefined);
  harness.studioOptions!.onInput({ type: "keyDown", code: "KeyA" });
  harness.signals.emit("SIGINT");
  assert.equal(await harness.promise, 0);
  assert.equal(harness.engine.stops, 1);
  assert.ok(harness.engine.events.indexOf("off") < harness.engine.events.indexOf("stop"));
  assert.equal(harness.watcher.closed, true);
});

test("controller close cancels a backpressured reload and staged note before safety off", async () => {
  const engine = new FakeEngine();
  let loads = 0;
  const harness = startHarness(engine, async () => patchModule(++loads === 1 ? 110 : 220));
  await waitUntil(() => harness.studioOptions !== undefined);
  engine.accept = false;
  harness.watcher.emit("change");
  await new Promise((resolve) => setTimeout(resolve, 120));
  await waitUntil(() =>
    engine.updates.some((serialized) => JSON.parse(serialized).source.frequencyHz === 220),
  );

  harness.studioOptions!.onInput({ type: "keyDown", code: "KeyA" });
  harness.studioOptions!.onControllerClosed();
  engine.accept = true;
  await waitUntil(() => engine.accepted.includes("off"));

  assert.equal(engine.noteOns.length, 0);
  assert.equal(
    engine.accepted.some(
      (call) =>
        call.startsWith("update:") &&
        JSON.parse(call.slice("update:".length)).source.frequencyHz === 220,
    ),
    false,
  );
  assert.equal(engine.accepted.at(-1), "off");

  harness.signals.emit("SIGTERM");
  assert.equal(await harness.promise, 0);
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
