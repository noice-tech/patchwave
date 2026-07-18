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

test("accepts every shared valid fixture and reconstructs canonical data", async () => {
  for (const [name, value] of await fixtures("valid")) {
    const normalized = validatePatch(value);
    assert.deepEqual(
      Object.keys(normalized),
      ["tempoBpm", "modulators", "modulationRoutes", "devices"],
      name,
    );
    assert.notStrictEqual(normalized, value, name);
    assert.notStrictEqual(normalized.devices, (value as { devices: unknown }).devices, name);
    assert.doesNotThrow(() => JSON.stringify(normalized), name);
  }
});

test("rejects every shared invalid fixture", async () => {
  for (const [name, value] of await fixtures("invalid")) {
    assert.throws(() => validatePatch(value), Error, name);
  }
});

test("canonical serialization follows schema key order", async () => {
  const [, value] = (await fixtures("valid")).find(([name]) => name === "minimal.json")!;
  const serialized = JSON.stringify(validatePatch(value));
  assert.match(
    serialized,
    /^\{"tempoBpm":120,"modulators":\[\],"modulationRoutes":\[\],"devices":\[/,
  );
  assert.match(serialized, /\{"id":"[^"]+","type":"subtractiveSynth","enabled":/);
});

test("rejects JavaScript-only unsafe values", async () => {
  const [, base] = (await fixtures("valid")).find(([name]) => name === "minimal.json")!;
  const nonFinite = structuredClone(base) as any;
  nonFinite.devices[0].baseFrequencyHz = Number.NaN;
  assert.throws(() => validatePatch(nonFinite), /finite number/);
  nonFinite.devices[0].baseFrequencyHz = Number.POSITIVE_INFINITY;
  assert.throws(() => validatePatch(nonFinite), /finite number/);
  nonFinite.devices[0].baseFrequencyHz = Number.NEGATIVE_INFINITY;
  assert.throws(() => validatePatch(nonFinite), /finite number/);

  const functionValue = structuredClone(base) as any;
  functionValue.devices[0].enabled = () => true;
  assert.throws(() => validatePatch(functionValue), /boolean/);

  const symbolKey = structuredClone(base) as any;
  symbolKey[Symbol("hidden")] = true;
  assert.throws(() => validatePatch(symbolKey), /symbol keys/);

  let getterCalls = 0;
  const accessor = structuredClone(base) as any;
  Object.defineProperty(accessor.devices[0], "outputGain", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 0.5;
    },
  });
  assert.throws(() => validatePatch(accessor), /data property/);
  assert.equal(getterCalls, 0);

  const deviceAccessor = structuredClone(base) as any;
  const firstDevice = deviceAccessor.devices[0];
  Object.defineProperty(deviceAccessor.devices, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return firstDevice;
    },
  });
  assert.throws(() => validatePatch(deviceAccessor), /data property/);
  assert.equal(getterCalls, 0);

  const oscillatorAccessor = structuredClone(base) as any;
  const firstOscillator = oscillatorAccessor.devices[0].oscillators[0];
  Object.defineProperty(oscillatorAccessor.devices[0].oscillators, "0", {
    enumerable: true,
    get() {
      getterCalls += 1;
      return firstOscillator;
    },
  });
  assert.throws(() => validatePatch(oscillatorAccessor), /data property/);
  assert.equal(getterCalls, 0);

  const inherited = Object.create({ inherited: true });
  Object.assign(inherited, structuredClone(base));
  assert.throws(() => validatePatch(inherited), /plain object/);
});

test("enforces count, integer, type, and precise paths", async () => {
  const [, base] = (await fixtures("valid")).find(([name]) => name === "minimal.json")!;
  const tooMany = structuredClone(base) as any;
  const processor = {
    id: "fx",
    type: "saturator",
    enabled: true,
    driveDb: 0,
    outputGainDb: 0,
    mix: 0,
  };
  tooMany.devices = [
    tooMany.devices[0],
    ...Array.from({ length: 8 }, (_, index) => ({ ...processor, id: `fx${index}` })),
  ];
  assert.throws(() => validatePatch(tooMany), /1–8 items/);

  const fractional = structuredClone(base) as any;
  fractional.devices[0].oscillators[0].octave = 0.25;
  assert.throws(() => validatePatch(fractional), /octave must be an integer/);

  const wrongType = structuredClone(base) as any;
  wrongType.devices[0].enabled = 1;
  assert.throws(() => validatePatch(wrongType), /enabled must be a boolean/);

  const feedback = structuredClone(base) as any;
  feedback.devices = [
    feedback.devices[0],
    {
      id: "delay",
      type: "stereoDelay",
      enabled: true,
      timeMs: 10,
      feedback: 0.96,
      damping: 0,
      pingPong: false,
      mix: 0,
    },
  ];
  assert.throws(() => validatePatch(feedback), /devices\[1\]\.feedback must be <= 0\.95/);
});

test("normalizes routes without mutating caller data", async () => {
  const [, value] = (await fixtures("valid")).find(([name]) => name === "composable.json")!;
  const input = structuredClone(value) as any;
  assert.equal(input.modulationRoutes[0].source, "wobble");
  const normalized = validatePatch(input);
  assert.deepEqual(
    normalized.modulationRoutes.map((route) => route.source),
    ["pluck", "wobble"],
  );
  assert.equal(input.modulationRoutes[0].source, "wobble");
  assert.notStrictEqual(normalized.modulators, input.modulators);
  assert.notStrictEqual(normalized.devices[0].oscillators, input.devices[0].oscillators);
  assert.match(JSON.stringify(normalized), /^\{"tempoBpm":140,"modulators":/);
  assert.match(
    JSON.stringify(normalized.devices[0].oscillators[0]),
    /^\{"id":"carrier","waveform":"sine"/,
  );
});

test("rejects unsafe and half-open current values", async () => {
  const [, value] = (await fixtures("valid")).find(([name]) => name === "composable.json")!;
  const phase = structuredClone(value) as any;
  phase.modulators[0].phaseOffset = 1;
  assert.throws(() => validatePatch(phase), /phaseOffset must be < 1/);

  const nonFinite = structuredClone(value) as any;
  nonFinite.modulationRoutes[0].amount = Number.NaN;
  assert.throws(() => validatePatch(nonFinite), /finite number/);

  let calls = 0;
  const accessor = structuredClone(value) as any;
  Object.defineProperty(accessor.devices[0].oscillators[0].sends, "direct", {
    enumerable: true,
    get() {
      calls += 1;
      return 0;
    },
  });
  assert.throws(() => validatePatch(accessor), /data property/);
  assert.equal(calls, 0);
});

test("rejects root version fields and the legacy patch shape", async () => {
  const [, base] = (await fixtures("valid")).find(([name]) => name === "minimal.json")!;
  assert.throws(
    () => validatePatch({ version: 1, ...(base as object) }),
    /patch\.version is unknown/,
  );
  assert.throws(
    () => validatePatch({ version: 2, ...(base as object) }),
    /patch\.version is unknown/,
  );
  assert.throws(() => validatePatch({ frequency: 440, gain: 0.1 }), /patch\.frequency is unknown/);
});
