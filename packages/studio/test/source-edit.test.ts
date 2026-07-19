import assert from "node:assert/strict";
import test from "node:test";
import { validatePatch } from "@patchwave/schema";
import { applySourceEdit, parseSource } from "../src/index.js";

const source = `import type {Patch} from "@patchwave/schema";
// Keep this comment.
export default {
  source: {
    frequencyHz: 110,
    gainDb: -12,
    oscillators: [{waveform: "saw", level: 0.5}],
  },
  effects: [{type: "saturator", driveDb: 8}],
} satisfies Patch;
`;
const canonical = validatePatch({
  source: { frequencyHz: 110, gainDb: -12, oscillators: [{ waveform: "saw", level: 0.5 }] },
  effects: [{ type: "saturator", driveDb: 8 }],
});

test("changes one literal and preserves surrounding source", () => {
  const output = applySourceEdit(source, canonical, "sound.ts", {
    type: "setField",
    path: ["source", "gainDb"],
    value: -18,
  });
  assert.match(output, /gainDb: -18/);
  assert.match(output, /Keep this comment/);
  assert.match(output, /frequencyHz: 110/);
  parseSource(output);
});

test("reset removes optional author property instead of writing canonical absence", () => {
  const output = applySourceEdit(source, canonical, "sound.ts", {
    type: "resetField",
    path: ["source", "gainDb"],
  });
  assert.doesNotMatch(output, /gainDb/);
  assert.doesNotMatch(output, /null/);
});

test("adds, moves, replaces, and removes direct blocks", () => {
  const withOsc = applySourceEdit(source, canonical, "sound.ts", {
    type: "addOscillator",
    index: 1,
    waveform: "pulse",
  });
  assert.match(withOsc, /waveform: "pulse"/);
  const withFilter = applySourceEdit(source, canonical, "sound.ts", { type: "addFilter" });
  assert.match(withFilter, /filter:/);
  assert.match(withFilter, /cutoffHz: 1200/);
  const withDelay = applySourceEdit(source, canonical, "sound.ts", {
    type: "addEffect",
    index: 1,
    effectType: "stereoDelay",
  });
  assert.match(withDelay, /type: "stereoDelay"/);
  assert.match(withDelay, /timeSeconds: 0.25/);
  assert.match(withDelay, /mix: 0.25 },\n\s*]/);
  assert.doesNotMatch(withDelay, /}, \{\n/);
});

test("cannot replace a computed expression", () => {
  const computedSource = source.replace("gainDb: -12", "gainDb: baseGain - 2");
  assert.throws(
    () =>
      applySourceEdit(computedSource, canonical, "sound.ts", {
        type: "setField",
        path: ["source", "gainDb"],
        value: -20,
      }),
    /computed/,
  );
});

test("cannot structurally replace a dynamic discriminant", () => {
  const computedSource = source.replace('waveform: "saw"', "waveform");
  assert.throws(
    () =>
      applySourceEdit(computedSource, canonical, "sound.ts", {
        type: "replaceOscillator",
        index: 0,
        waveform: "pulse",
      }),
    /computed/,
  );
});

test("rejects out-of-range scalar values", () => {
  assert.throws(
    () =>
      applySourceEdit(source, canonical, "sound.ts", {
        type: "setField",
        path: ["source", "gainDb"],
        value: 3,
      }),
    /range/,
  );
  assert.throws(
    () =>
      applySourceEdit(source, canonical, "sound.ts", {
        type: "setField",
        path: ["source", "oscillators", 0, "transposeSemitones"],
        value: 1.5,
      }),
    /range/,
  );
});
