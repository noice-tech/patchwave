import assert from "node:assert/strict";
import test from "node:test";
import { validatePatch } from "@patchwave/schema";
import { applyPatchPreview } from "../src/patch-preview.js";

const patch = validatePatch({
  source: {
    frequencyHz: 110,
    oscillators: [{ waveform: "saw" }],
    filter: { cutoffHz: 1200, resonance: 0.2 },
  },
});

test("applies a validated scalar overlay without mutating its source patch", () => {
  const loaded = applyPatchPreview(patch, {
    gestureId: "g",
    baseRevision: "a",
    path: ["source", "filter", "resonance"],
    value: 0.7,
  });
  assert.equal(loaded.patch.source.filter?.resonance, 0.7);
  assert.equal(patch.source.filter?.resonance, 0.2);
});

test("rejects invalid preview ranges and missing targets", () => {
  assert.throws(
    () =>
      applyPatchPreview(patch, {
        gestureId: "g",
        baseRevision: "a",
        path: ["source", "filter", "resonance"],
        value: 2,
      }),
    /must be <= 1/,
  );
  const withoutFilter = validatePatch({
    source: { frequencyHz: 110, oscillators: [{ waveform: "sine" }] },
  });
  assert.throws(
    () =>
      applyPatchPreview(withoutFilter, {
        gestureId: "g",
        baseRevision: "a",
        path: ["source", "filter", "resonance"],
        value: 0.5,
      }),
    /no longer exists/,
  );
});
