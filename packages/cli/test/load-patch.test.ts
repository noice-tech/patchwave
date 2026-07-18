import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Patch } from "@patchwave/schema";
import { loadPatch, normalizePatchExport } from "../src/load-patch.js";

function patch(frequencyHz = 110): Patch {
  return { source: { frequencyHz, oscillators: [{ waveform: "saw" }] } };
}

test("normalizes, serializes canonically, summarizes, and reloads ESM uncached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchwave-loader-"));
  const path = join(directory, "sound.ts");
  try {
    await writeFile(path, `export default ${JSON.stringify(patch(110))};\n`);
    const first = await loadPatch(path);
    assert.equal(first.patch.source.frequencyHz, 110);
    assert.equal(first.patch.source.gainDb, -12);
    assert.equal(first.serialized, JSON.stringify(first.patch));
    assert.equal(first.summary, "110 Hz; 1 oscillator; 0 effects");

    await writeFile(path, `export default ${JSON.stringify(patch(220))};\n`);
    const second = await loadPatch(path);
    assert.equal(second.patch.source.frequencyHz, 220);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads a CommonJS default wrapper", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchwave-cjs-"));
  const path = join(directory, "sound.cts");
  try {
    await writeFile(path, `module.exports = { default: ${JSON.stringify(patch(330))} };\n`);
    assert.equal((await loadPatch(path)).patch.source.frequencyHz, 330);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects old, versioned, and accessor exports", () => {
  assert.throws(() => normalizePatchExport({ frequency: 440, gain: 0.1 }), /unknown|required/);
  assert.throws(
    () => normalizePatchExport({ version: 1, ...patch() }),
    /patch\.version is unknown/,
  );

  let calls = 0;
  const value = patch() as unknown as Record<string, any>;
  Object.defineProperty(value.source, "frequencyHz", {
    enumerable: true,
    get() {
      calls += 1;
      return 110;
    },
  });
  assert.throws(() => normalizePatchExport(value), /data property/);
  assert.equal(calls, 0);
});

test("summarizes oscillator and effect counts", () => {
  const loaded = normalizePatchExport({
    source: {
      frequencyHz: 55,
      oscillators: [{ waveform: "saw" }, { waveform: "sine" }],
    },
    effects: [{ type: "saturator", driveDb: 12 }],
  });
  assert.equal(loaded.summary, "55 Hz; 2 oscillators; 1 effect");
  assert.equal(loaded.serialized, JSON.stringify(loaded.patch));
});
