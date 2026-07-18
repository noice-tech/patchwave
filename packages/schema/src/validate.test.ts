import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { validatePatch } from "./validate.js";

const fixtureRoot = resolve(import.meta.dirname, "../../../fixtures/patches");

async function fixtures(kind: "valid" | "invalid"): Promise<Array<[string, unknown]>> {
  const directory = join(fixtureRoot, kind);
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json")).sort();
  return Promise.all(
    names.map(async (name) => [name, JSON.parse(await readFile(join(directory, name), "utf8"))]),
  );
}

test("normalizes author forms to every canonical fixture", async () => {
  for (const [name, value] of await fixtures("valid")) {
    const author = structuredClone(value) as any;
    if (author.source.filter === null) {
      delete author.source.filter;
    } else if (author.source.filter.cutoffLfo === null) {
      delete author.source.filter.cutoffLfo;
    }
    const normalized = validatePatch(author);
    assert.deepEqual(Object.keys(normalized), ["source", "effects"], name);
    assert.notStrictEqual(normalized, author, name);
    assert.notStrictEqual(normalized.source, author.source, name);
    assert.deepEqual(normalized, value, name);
    assert.doesNotThrow(() => JSON.stringify(normalized), name);
  }
});

test("rejects every shared invalid fixture", async () => {
  for (const [name, value] of await fixtures("invalid")) {
    assert.throws(() => validatePatch(value), Error, name);
  }
});

test("normalizes the minimal beginner patch with safe defaults", () => {
  const normalized = validatePatch({
    source: { frequencyHz: 110, oscillators: [{ waveform: "saw" }] },
  });
  assert.deepEqual(normalized, {
    source: {
      frequencyHz: 110,
      gainDb: -12,
      oscillators: [{ waveform: "saw", transposeSemitones: 0, detuneCents: 0, level: 1 }],
      filter: null,
      ampEnvelope: {
        attackSeconds: 0.005,
        decaySeconds: 0,
        sustain: 1,
        releaseSeconds: 0.1,
      },
    },
    effects: [],
  });
  assert.match(
    JSON.stringify(normalized),
    /^\{"source":\{"frequencyHz":110,"gainDb":-12,"oscillators":\[/,
  );
});

test("normalizes nested filter LFO, envelope, and effect defaults", () => {
  const normalized = validatePatch({
    source: {
      frequencyHz: 55,
      oscillators: [{ waveform: "pulse" }],
      filter: {
        cutoffHz: 220,
        cutoffLfo: { rateHz: 2, amountOctaves: 3 },
      },
      ampEnvelope: { sustain: 0.8 },
    },
    effects: [
      { type: "saturator", driveDb: 12 },
      { type: "stereoDelay", timeSeconds: 0.1, mix: 0.2 },
    ],
  });
  assert.deepEqual(normalized.source.oscillators[0], {
    waveform: "pulse",
    transposeSemitones: 0,
    detuneCents: 0,
    pulseWidth: 0.5,
    level: 1,
  });
  assert.deepEqual(normalized.source.filter, {
    mode: "lowpass",
    cutoffHz: 220,
    resonance: 0,
    cutoffLfo: { shape: "sine", rateHz: 2, amountOctaves: 3 },
  });
  assert.deepEqual(normalized.effects, [
    { type: "saturator", driveDb: 12, outputGainDb: 0, mix: 1 },
    {
      type: "stereoDelay",
      timeSeconds: 0.1,
      feedback: 0,
      damping: 0,
      pingPong: false,
      mix: 0.2,
    },
  ]);
});

test("rejects unsafe JavaScript values without invoking accessors", () => {
  const base: any = { source: { frequencyHz: 110, oscillators: [{ waveform: "saw" }] } };
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    const candidate = structuredClone(base);
    candidate.source.frequencyHz = value;
    assert.throws(() => validatePatch(candidate), /finite number/);
  }

  const symbolKey = structuredClone(base);
  symbolKey[Symbol("hidden")] = true;
  assert.throws(() => validatePatch(symbolKey), /symbol keys/);

  let getterCalls = 0;
  const accessor = structuredClone(base);
  Object.defineProperty(accessor.source, "frequencyHz", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 110;
    },
  });
  assert.throws(() => validatePatch(accessor), /data property/);
  assert.equal(getterCalls, 0);

  const oscillatorAccessor = structuredClone(base);
  const oscillator = oscillatorAccessor.source.oscillators[0];
  Object.defineProperty(oscillatorAccessor.source.oscillators, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return oscillator;
    },
  });
  assert.throws(() => validatePatch(oscillatorAccessor), /data property/);
  assert.equal(getterCalls, 0);

  const inherited = Object.create({ inherited: true });
  Object.assign(inherited, structuredClone(base));
  assert.throws(() => validatePatch(inherited), /plain object/);
});

test("enforces counts, integer tuning, ranges, and strict keys", () => {
  const tooMany = {
    source: {
      frequencyHz: 110,
      oscillators: Array.from({ length: 5 }, () => ({ waveform: "sine" })),
    },
  };
  assert.throws(() => validatePatch(tooMany), /1–4 items/);

  assert.throws(
    () =>
      validatePatch({
        source: {
          frequencyHz: 110,
          oscillators: [{ waveform: "saw", transposeSemitones: 0.5 }],
        },
      }),
    /must be an integer/,
  );
  assert.throws(
    () =>
      validatePatch({
        source: {
          frequencyHz: 110,
          oscillators: [{ waveform: "saw" }],
          filter: {
            cutoffHz: 220,
            cutoffLfo: { rateHz: 2, amountOctaves: -0.1 },
          },
        },
      }),
    /amountOctaves must be >= 0/,
  );
  assert.throws(
    () =>
      validatePatch({
        source: { frequencyHz: 110, oscillators: [{ waveform: "noise", detuneCents: 2 }] },
      }),
    /detuneCents is unknown/,
  );
  assert.throws(
    () =>
      validatePatch({
        source: {
          frequencyHz: 110,
          oscillators: [{ waveform: "sine" }],
          filter: null,
        },
      }),
    /filter must be a plain object/,
  );
  assert.throws(
    () =>
      validatePatch({
        source: {
          frequencyHz: 110,
          oscillators: [{ waveform: "sine" }],
          filter: { cutoffHz: 220, cutoffLfo: null },
        },
      }),
    /cutoffLfo must be a plain object/,
  );
  assert.throws(
    () =>
      validatePatch({
        source: { frequencyHz: 110, oscillators: [{ waveform: "sine" }] },
        unexpected: true,
      }),
    /patch\.unexpected is unknown/,
  );
});
