import assert from "node:assert/strict";
import test from "node:test";
import { validatePatch } from "@patchwave/schema";
import { analyzeSource, parseSource } from "../src/index.js";

const canonical = validatePatch({
  source: {
    frequencyHz: 110,
    oscillators: [{ waveform: "saw", level: 0.5 }],
    filter: { cutoffHz: 1200, resonance: 0.45 },
  },
  effects: [{ type: "saturator", driveDb: 8 }],
});

function binding(analysis: ReturnType<typeof analyzeSource>, suffix: string) {
  return analysis.bindings.find((item) => item.path.join(".").endsWith(suffix));
}

test("classifies static literals and omitted defaults", () => {
  const analysis = analyzeSource(
    parseSource(`export default {
    source: {frequencyHz: 110, oscillators: [{waveform: "saw", level: 0.5}], filter: {cutoffHz: 1200, resonance: 0.45}},
    effects: [{type: "saturator", driveDb: 8}],
  } satisfies Patch;`),
    canonical,
    "sound.ts",
  );
  assert.equal(analysis.mode, "static");
  assert.equal(binding(analysis, "source.frequencyHz")?.sourceForm.kind, "literal");
  assert.equal(binding(analysis, "source.gainDb")?.sourceForm.kind, "default");
  assert.equal(binding(analysis, "source.filter.resonance")?.sourceForm.kind, "literal");
  assert.equal(analysis.editableStructure.effects, true);
});

test("edits inline program literals while expressions remain computed", () => {
  const analysis = analyzeSource(
    parseSource(`export default (({voice, timeSeconds}) => {
    const movement = Math.sin(timeSeconds);
    return {source: {frequencyHz: voice.frequencyHz, oscillators: [{waveform: "saw", level: 0.5}], filter: {cutoffHz: 200 + movement * 2400, resonance: 0.45}}, effects: [{type: "saturator", driveDb: 8}]};
  }) satisfies PatchProgram;`),
    canonical,
    "program.ts",
  );
  assert.equal(analysis.mode, "program");
  assert.equal(binding(analysis, "source.frequencyHz")?.sourceForm.kind, "computed");
  assert.equal(binding(analysis, "source.filter.cutoffHz")?.sourceForm.kind, "computed");
  assert.equal(binding(analysis, "source.filter.resonance")?.sourceForm.kind, "literal");
});

test("unsupported export and spread containers fail closed", () => {
  const indirect = analyzeSource(
    parseSource(`const patch = {}; export default patch;`),
    canonical,
    "sound.ts",
  );
  assert.equal(indirect.mode, "unknown");
  assert.equal(indirect.bindings.length, 0);
  const spread = analyzeSource(
    parseSource(
      `export default {source: {...base, frequencyHz: 110, oscillators: [{waveform: "saw"}]}};`,
    ),
    canonical,
    "sound.ts",
  );
  assert.equal(binding(spread, "source.frequencyHz")?.sourceForm.kind, "computed");
  assert.equal(spread.editableStructure.oscillators, false);
  const conditional = analyzeSource(
    parseSource(
      `export default (() => { if (flag) return other; return {source: {frequencyHz: 110, oscillators: [{waveform: "saw"}]}}; });`,
    ),
    canonical,
    "sound.ts",
  );
  assert.equal(conditional.mode, "unknown");
  const dynamicDiscriminant = analyzeSource(
    parseSource(
      `export default {source: {frequencyHz: 110, oscillators: [{waveform, level: 0.5}]}};`,
    ),
    canonical,
    "sound.ts",
  );
  assert.equal(binding(dynamicDiscriminant, "oscillators.0.level")?.sourceForm.kind, "computed");
  assert.equal(dynamicDiscriminant.editableStructure.oscillators, false);
});

test("accepts named and anonymous direct default function PatchPrograms", () => {
  for (const declaration of ["export default function program()", "export default function ()"]) {
    const analysis = analyzeSource(
      parseSource(
        `${declaration} { return {source: {frequencyHz: 110, oscillators: [{waveform: \"saw\", level: 0.5}], filter: {cutoffHz: 1200, resonance: 0.45}}, effects: [{type: \"saturator\", driveDb: 8}]}; }`,
      ),
      canonical,
      "program.ts",
    );
    assert.equal(analysis.mode, "program");
    assert.equal(binding(analysis, "source.filter.resonance")?.sourceForm.kind, "literal");
  }
});
