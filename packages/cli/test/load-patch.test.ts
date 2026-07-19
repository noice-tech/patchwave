import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Patch } from "@patchwave/schema";
import {
  evaluatePatchModule,
  loadPatchModule,
  normalizePatchModuleExport,
} from "../src/load-patch.js";

function patch(frequencyHz = 110): Patch {
  return { source: { frequencyHz, oscillators: [{ waveform: "saw" }] } };
}

const context = Object.freeze({
  frame: 0,
  fps: 60 as const,
  timeSeconds: 0,
  voice: Object.freeze({ frequencyHz: 261.625565, gate: false }),
});

test("normalizes, serializes canonically, summarizes, and reloads ESM uncached", async () => {
  const directory = await mkdtemp(join(tmpdir(), "patchwave-loader-"));
  const path = join(directory, "sound.ts");
  try {
    await writeFile(path, `export default ${JSON.stringify(patch(110))};\n`);
    const first = evaluatePatchModule(await loadPatchModule(path), context);
    assert.equal(first.patch.source.frequencyHz, 110);
    assert.equal(first.patch.source.gainDb, -12);
    assert.equal(first.serialized, JSON.stringify(first.patch));
    assert.equal(first.summary, "110 Hz; 1 oscillator; 0 effects");

    await writeFile(path, `export default ${JSON.stringify(patch(220))};\n`);
    const second = evaluatePatchModule(await loadPatchModule(path), context);
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
    const module = await loadPatchModule(path);
    assert.equal(module.kind, "static");
    assert.equal(module.kind === "static" ? module.patch.source.frequencyHz : 0, 330);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects old, versioned, and accessor exports", () => {
  assert.throws(
    () => normalizePatchModuleExport({ frequency: 440, gain: 0.1 }),
    /unknown|required/,
  );
  assert.throws(
    () => normalizePatchModuleExport({ version: 1, ...patch() }),
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
  assert.throws(() => normalizePatchModuleExport(value), /data property/);
  assert.equal(calls, 0);
});

test("evaluates synchronous whole-patch programs with an exact context", () => {
  const contexts: unknown[] = [];
  const module = normalizePatchModuleExport((context: any) => {
    contexts.push(context);
    return patch(context.voice.frequencyHz);
  });
  const programContext = Object.freeze({
    frame: 30,
    fps: 60 as const,
    timeSeconds: 0.5,
    voice: Object.freeze({ frequencyHz: 220, gate: true }),
  });
  const evaluated = evaluatePatchModule(module, programContext);
  assert.equal(evaluated.patch.source.frequencyHz, 220);
  assert.deepEqual(contexts, [programContext]);
  assert.throws(
    () =>
      evaluatePatchModule(
        normalizePatchModuleExport(async () => patch()),
        programContext,
      ),
    /plain object/,
  );
});

test("summarizes oscillator and effect counts", () => {
  const loaded = evaluatePatchModule(
    normalizePatchModuleExport({
      source: {
        frequencyHz: 55,
        oscillators: [{ waveform: "saw" }, { waveform: "sine" }],
      },
      effects: [{ type: "saturator", driveDb: 12 }],
    }),
    context,
  );
  assert.equal(loaded.summary, "55 Hz; 2 oscillators; 1 effect");
  assert.equal(loaded.serialized, JSON.stringify(loaded.patch));
});
