import assert from "node:assert/strict";
import test from "node:test";
import { parseStudioInput } from "../src/index.js";

const revision = "a".repeat(64);

test("accepts closed semantic edit messages", () => {
  assert.deepEqual(
    parseStudioInput(
      JSON.stringify({
        type: "preview",
        protocol: 1,
        requestId: "r",
        gestureId: "g",
        baseRevision: revision,
        path: ["source", "filter", "resonance"],
        value: 0.5,
      }),
    ),
    {
      type: "preview",
      protocol: 1,
      requestId: "r",
      gestureId: "g",
      baseRevision: revision,
      path: ["source", "filter", "resonance"],
      value: 0.5,
    },
  );
  assert.equal(
    parseStudioInput(
      JSON.stringify({
        type: "commit",
        protocol: 1,
        requestId: "r",
        gestureId: null,
        baseRevision: revision,
        operation: { type: "addEffect", index: 0, effectType: "saturator" },
      }),
    )?.type,
    "commit",
  );
});

test("rejects paths, source text, versions, extra keys, nonfinite and invalid indices", () => {
  const valid = {
    type: "commit",
    protocol: 1,
    requestId: "r",
    gestureId: null,
    baseRevision: revision,
    operation: { type: "setField", path: ["source", "gainDb"], value: -12 },
  };
  assert.equal(parseStudioInput(JSON.stringify({ ...valid, filePath: "/tmp/a.ts" })), undefined);
  assert.equal(parseStudioInput(JSON.stringify({ ...valid, protocol: 2 })), undefined);
  assert.equal(
    parseStudioInput(
      JSON.stringify({ ...valid, operation: { ...valid.operation, source: "evil" } }),
    ),
    undefined,
  );
  assert.equal(
    parseStudioInput(JSON.stringify({ ...valid, operation: { type: "removeEffect", index: 99 } })),
    undefined,
  );
  assert.equal(parseStudioInput('{"type":"preview","value":1e999}'), undefined);
});

test("rejects cross-device field names in semantic paths", () => {
  for (const path of [
    ["source", "oscillators", 0, "gainDb"],
    ["source", "oscillators", 0, "frequencyHz"],
    ["source", "oscillators", 0, "attackSeconds"],
    ["source", "oscillators", 0, "driveDb"],
    ["effects", 0, "detuneCents"],
    ["effects", 0, "cutoffHz"],
  ]) {
    const input = {
      type: "commit",
      protocol: 1,
      requestId: "r",
      gestureId: null,
      baseRevision: revision,
      operation: { type: "setField", path, value: 0 },
    };
    assert.equal(parseStudioInput(JSON.stringify(input)), undefined);
  }
});
