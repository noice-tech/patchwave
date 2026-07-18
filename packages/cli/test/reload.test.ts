import assert from "node:assert/strict";
import test from "node:test";
import type { Patch } from "@patchwave/schema";
import type { LoadedPatch } from "../src/load-patch.js";
import { ReloadCoordinator } from "../src/reload.js";

function loaded(label: string, frequency: number): LoadedPatch {
  const patch: Patch = {
    tempoBpm: 120,
    modulators: [],
    modulationRoutes: [],
    devices: [
      {
        id: label,
        type: "subtractiveSynth",
        enabled: true,
        baseFrequencyHz: frequency,
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
        filter: {
          enabled: false,
          mode: "lowpass",
          cutoffHz: 20_000,
          resonance: 0,
          sends: { insert: 1, direct: 0 },
        },
        audioRateRoutes: [],
      },
    ],
  };
  return {
    patch,
    serialized: JSON.stringify(patch),
    summary: `120 BPM; 0 modulators; 0 routes; subtractiveSynth#${label}`,
  };
}

test("serializes reloads and coalesces duplicate events", async () => {
  const initial = loaded("initial", 100);
  const candidates = [loaded("first", 200), loaded("latest", 300)];
  let releaseFirst: (() => void) | undefined;
  let loadCalls = 0;
  const applied: string[] = [];
  const coordinator = new ReloadCoordinator({
    initial,
    load: async () => {
      const index = loadCalls++;
      if (index === 0) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return candidates[Math.min(index, candidates.length - 1)];
    },
    engine: { applyPatch: (serialized) => applied.push(serialized) },
    onApplied: () => undefined,
    onError: (error) => assert.fail(String(error)),
  });

  coordinator.queue();
  coordinator.queue();
  coordinator.queue();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(loadCalls, 1);
  releaseFirst?.();
  await coordinator.waitForIdle();
  assert.equal(loadCalls, 2);
  assert.deepEqual(applied, [candidates[0].serialized, candidates[1].serialized]);
  assert.equal(coordinator.current.summary, candidates[1].summary);
});

test("load and native failures retain the last accepted summary", async () => {
  const initial = loaded("initial", 100);
  const candidate = loaded("candidate", 200);
  const errors: Array<{ error: unknown; retained: LoadedPatch }> = [];
  let failLoad = true;
  const coordinator = new ReloadCoordinator({
    initial,
    load: async () => {
      if (failLoad) throw new Error("invalid file");
      return candidate;
    },
    engine: {
      applyPatch: () => {
        throw new Error("queue full");
      },
    },
    onApplied: () => assert.fail("must not apply"),
    onError: (error, retained) => errors.push({ error, retained }),
  });

  coordinator.queue();
  await coordinator.waitForIdle();
  failLoad = false;
  coordinator.queue();
  await coordinator.waitForIdle();

  assert.equal(errors.length, 2);
  assert.equal(errors[0].retained, initial);
  assert.equal(errors[1].retained, initial);
  assert.equal(coordinator.current, initial);
});

test("stop prevents a pending load from reaching native code", async () => {
  const initial = loaded("initial", 100);
  let release: (() => void) | undefined;
  let applyCalls = 0;
  const coordinator = new ReloadCoordinator({
    initial,
    load: () =>
      new Promise((resolve) => {
        release = () => resolve(loaded("late", 200));
      }),
    engine: { applyPatch: () => (applyCalls += 1) },
    onApplied: () => undefined,
    onError: () => undefined,
  });
  coordinator.queue();
  await new Promise((resolve) => setImmediate(resolve));
  coordinator.stop();
  release?.();
  await coordinator.waitForIdle();
  assert.equal(applyCalls, 0);
  assert.equal(coordinator.current, initial);
});
