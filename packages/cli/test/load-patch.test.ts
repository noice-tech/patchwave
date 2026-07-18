import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import type { Patch } from "@patchwave/schema";
import { loadPatch, normalizePatchExport } from "../src/load-patch.js";

function patch(frequency = 110): Patch {
  return {
    tempoBpm: 120,
    modulators: [],
    modulationRoutes: [],
    devices: [
      {
        id: "voice",
        type: "subtractiveSynth",
        enabled: true,
        baseFrequencyHz: frequency,
        outputGain: 0.2,
        oscillators: [
          {
            id: "saw",
            waveform: "saw",
            octave: 0,
            semitone: 0,
            detuneCents: 0,
            level: 1,
            sends: { filter: 1, insert: 0, direct: 0 },
          },
        ],
        ampEnvelope: {
          attackSeconds: 0.01,
          decaySeconds: 0.1,
          sustain: 0.6,
          releaseSeconds: 0.2,
        },
        filter: {
          enabled: true,
          mode: "lowpass",
          cutoffHz: 2_000,
          resonance: 0.2,
          sends: { insert: 1, direct: 0 },
        },
        audioRateRoutes: [],
      },
    ],
  };
}

test("normalizes, serializes canonically, summarizes, and reloads ESM uncached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchwave-loader-"));
  const path = join(directory, "sound.ts");
  try {
    await writeFile(path, `export default ${JSON.stringify(patch(110))};\n`);
    const first = await loadPatch(path);
    assert.equal(first.patch.devices[0].baseFrequencyHz, 110);
    assert.equal(first.serialized, JSON.stringify(first.patch));
    assert.equal(first.summary, "120 BPM; 0 modulators; 0 routes; subtractiveSynth#voice");

    await writeFile(path, `export default ${JSON.stringify(patch(220))};\n`);
    const second = await loadPatch(path);
    assert.equal(second.patch.devices[0].baseFrequencyHz, 220);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads a CommonJS default wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchwave-cjs-"));
  const path = join(directory, "sound.cts");
  try {
    await writeFile(
      path,
      `module.exports = { default: ${JSON.stringify(patch(330))} };\n`,
    );
    const loaded = await loadPatch(path);
    assert.equal(loaded.patch.devices[0].baseFrequencyHz, 330);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects legacy and versioned exports", () => {
  assert.throws(
    () => normalizePatchExport({ frequency: 440, gain: 0.1 }),
    /unknown|required/,
  );
  assert.throws(
    () => normalizePatchExport({ version: 2, ...patch() }),
    /patch\.version is unknown/,
  );
});

test("rejects accessors without invoking them", () => {
  let calls = 0;
  const value = patch() as unknown as Record<string, unknown>;
  Object.defineProperty(value, "tempoBpm", {
    enumerable: true,
    get() {
      calls += 1;
      return 120;
    },
  });
  assert.throws(() => normalizePatchExport(value), /data property/);
  assert.equal(calls, 0);
});

test("normalizes and summarizes a current patch", async () => {
  const value = JSON.parse(await readFile(resolve(import.meta.dirname, "../../../fixtures/patches/valid/composable.json"), "utf8"));
  const loaded = normalizePatchExport(value);
  assert.match(loaded.summary, /^140 BPM; 2 modulators; 2 routes;/);
  assert.equal(loaded.serialized, JSON.stringify(loaded.patch));
  assert.deepEqual(loaded.patch.modulationRoutes.map((route) => route.source), ["pluck", "wobble"]);
});
