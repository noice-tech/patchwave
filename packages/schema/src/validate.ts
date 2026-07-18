import { EFFECT_COUNT_MAX, LIMITS, OSCILLATOR_COUNT_MAX } from "./limits.js";
import type {
  CanonicalCutoffLfo,
  CanonicalEffect,
  CanonicalEnvelope,
  CanonicalOscillator,
  CanonicalPatch,
  CanonicalSourceFilter,
} from "./types.js";

type DataRecord = Record<string, unknown>;
type Limits = readonly [number, number];

const DEFAULT_ENVELOPE: CanonicalEnvelope = {
  attackSeconds: 0.005,
  decaySeconds: 0,
  sustain: 1,
  releaseSeconds: 0.1,
};

export function validatePatch(value: unknown): CanonicalPatch {
  const patch = readObject(value, "patch", ["source", "effects"], ["source"]);
  const source = validateSource(readData(patch, "source", "patch.source"));
  const effects = hasOwn(patch, "effects")
    ? readArray(
        readData(patch, "effects", "patch.effects"),
        "patch.effects",
        0,
        EFFECT_COUNT_MAX,
      ).map((effect, index) => validateEffect(effect, `patch.effects[${index}]`))
    : [];
  return { source, effects };
}

function validateSource(value: unknown): CanonicalPatch["source"] {
  const path = "patch.source";
  const source = readObject(
    value,
    path,
    ["frequencyHz", "gainDb", "oscillators", "filter", "ampEnvelope"],
    ["frequencyHz", "oscillators"],
  );
  const values = readArray(
    readData(source, "oscillators", `${path}.oscillators`),
    `${path}.oscillators`,
    1,
    OSCILLATOR_COUNT_MAX,
  );
  const oscillators = values.map((oscillator, index) =>
    validateOscillator(oscillator, `${path}.oscillators[${index}]`),
  ) as CanonicalPatch["source"]["oscillators"];
  return {
    frequencyHz: readNumber(source, "frequencyHz", path, LIMITS.frequencyHz),
    gainDb: optionalNumber(source, "gainDb", path, LIMITS.sourceGainDb, -12),
    oscillators,
    filter: hasOwn(source, "filter")
      ? validateFilter(readData(source, "filter", `${path}.filter`), `${path}.filter`)
      : null,
    ampEnvelope: hasOwn(source, "ampEnvelope")
      ? validateEnvelope(
          readData(source, "ampEnvelope", `${path}.ampEnvelope`),
          `${path}.ampEnvelope`,
        )
      : { ...DEFAULT_ENVELOPE },
  };
}

function validateOscillator(value: unknown, path: string): CanonicalOscillator {
  const discriminant = readObjectForDiscriminant(value, path);
  const waveform = readData(discriminant, "waveform", `${path}.waveform`);
  if (waveform === "noise") {
    const oscillator = readObject(value, path, ["waveform", "level"], ["waveform"]);
    return {
      waveform,
      level: optionalNumber(oscillator, "level", path, LIMITS.normalized, 1),
    };
  }
  if (
    waveform !== "sine" &&
    waveform !== "triangle" &&
    waveform !== "saw" &&
    waveform !== "pulse"
  ) {
    throw new Error(`${path}.waveform is unsupported`);
  }
  const allowed = [
    "waveform",
    "transposeSemitones",
    "detuneCents",
    ...(waveform === "pulse" ? ["pulseWidth"] : []),
    "level",
  ];
  const oscillator = readObject(value, path, allowed, ["waveform"]);
  const tuning = {
    transposeSemitones: optionalInteger(
      oscillator,
      "transposeSemitones",
      path,
      LIMITS.transposeSemitones,
      0,
    ),
    detuneCents: optionalNumber(oscillator, "detuneCents", path, LIMITS.detuneCents, 0),
  };
  const level = optionalNumber(oscillator, "level", path, LIMITS.normalized, 1);
  return waveform === "pulse"
    ? {
        waveform,
        ...tuning,
        pulseWidth: optionalNumber(oscillator, "pulseWidth", path, LIMITS.pulseWidth, 0.5),
        level,
      }
    : { waveform, ...tuning, level };
}

function validateFilter(value: unknown, path: string): CanonicalSourceFilter {
  const filter = readObject(
    value,
    path,
    ["mode", "cutoffHz", "resonance", "cutoffLfo"],
    ["cutoffHz"],
  );
  return {
    mode: optionalEnum(
      filter,
      "mode",
      path,
      ["lowpass", "bandpass", "highpass"] as const,
      "lowpass",
    ),
    cutoffHz: readNumber(filter, "cutoffHz", path, LIMITS.cutoffHz),
    resonance: optionalNumber(filter, "resonance", path, LIMITS.normalized, 0),
    cutoffLfo: hasOwn(filter, "cutoffLfo")
      ? validateCutoffLfo(readData(filter, "cutoffLfo", `${path}.cutoffLfo`), `${path}.cutoffLfo`)
      : null,
  };
}

function validateCutoffLfo(value: unknown, path: string): CanonicalCutoffLfo {
  const lfo = readObject(
    value,
    path,
    ["shape", "rateHz", "amountOctaves"],
    ["rateHz", "amountOctaves"],
  );
  return {
    shape: optionalEnum(
      lfo,
      "shape",
      path,
      ["sine", "triangle", "sawUp", "sawDown", "square"] as const,
      "sine",
    ),
    rateHz: readNumber(lfo, "rateHz", path, LIMITS.lfoFrequencyHz),
    amountOctaves: readNumber(lfo, "amountOctaves", path, LIMITS.amountOctaves),
  };
}

function validateEnvelope(value: unknown, path: string): CanonicalEnvelope {
  const envelope = readObject(
    value,
    path,
    ["attackSeconds", "decaySeconds", "sustain", "releaseSeconds"],
    [],
  );
  return {
    attackSeconds: optionalNumber(
      envelope,
      "attackSeconds",
      path,
      LIMITS.envelopeSeconds,
      DEFAULT_ENVELOPE.attackSeconds,
    ),
    decaySeconds: optionalNumber(
      envelope,
      "decaySeconds",
      path,
      LIMITS.envelopeSeconds,
      DEFAULT_ENVELOPE.decaySeconds,
    ),
    sustain: optionalNumber(envelope, "sustain", path, LIMITS.normalized, DEFAULT_ENVELOPE.sustain),
    releaseSeconds: optionalNumber(
      envelope,
      "releaseSeconds",
      path,
      LIMITS.envelopeSeconds,
      DEFAULT_ENVELOPE.releaseSeconds,
    ),
  };
}

function validateEffect(value: unknown, path: string): CanonicalEffect {
  const discriminant = readObjectForDiscriminant(value, path);
  const type = readData(discriminant, "type", `${path}.type`);
  if (type === "saturator") {
    const effect = readObject(
      value,
      path,
      ["type", "driveDb", "outputGainDb", "mix"],
      ["type", "driveDb"],
    );
    return {
      type,
      driveDb: readNumber(effect, "driveDb", path, LIMITS.driveDb),
      outputGainDb: optionalNumber(effect, "outputGainDb", path, LIMITS.outputGainDb, 0),
      mix: optionalNumber(effect, "mix", path, LIMITS.normalized, 1),
    };
  }
  if (type === "stereoDelay") {
    const effect = readObject(
      value,
      path,
      ["type", "timeSeconds", "feedback", "damping", "pingPong", "mix"],
      ["type", "timeSeconds", "mix"],
    );
    return {
      type,
      timeSeconds: readNumber(effect, "timeSeconds", path, LIMITS.delayTimeSeconds),
      feedback: optionalNumber(effect, "feedback", path, LIMITS.feedback, 0),
      damping: optionalNumber(effect, "damping", path, LIMITS.normalized, 0),
      pingPong: optionalBoolean(effect, "pingPong", path, false),
      mix: readNumber(effect, "mix", path, LIMITS.normalized),
    };
  }
  throw new Error(`${path}.type is unsupported`);
}

function readObjectForDiscriminant(value: unknown, path: string): DataRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${path} must be a plain object`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must not contain symbol keys`);
  }
  return value as DataRecord;
}

function readObject(
  value: unknown,
  path: string,
  allowed: readonly string[],
  required: readonly string[],
): DataRecord {
  const object = readObjectForDiscriminant(value, path);
  for (const key of Reflect.ownKeys(object)) {
    if (typeof key !== "string" || !allowed.includes(key)) {
      throw new Error(`${path}.${String(key)} is unknown`);
    }
    requireDataProperty(object, key, `${path}.${key}`);
  }
  for (const key of required) {
    if (!hasOwn(object, key)) throw new Error(`${path}.${key} is required`);
  }
  return object;
}

function readArray(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${path} must be an array`);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must not contain symbol keys`);
    if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
      throw new Error(`${path}.${key} is unknown`);
  }
  if (value.length < min || value.length > max) {
    throw new Error(`${path} must contain ${min}–${max} items`);
  }
  const output: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const key = String(index);
    if (!hasOwn(value, key)) throw new Error(`${path}[${index}] is required`);
    requireDataProperty(value, key, `${path}[${index}]`);
    output.push((value as unknown[])[index]);
  }
  return output;
}

function requireDataProperty(object: object, key: PropertyKey, path: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
    throw new Error(`${path} must be an enumerable data property`);
  }
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.hasOwn(object, key);
}

function readData(object: DataRecord, key: string, path: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  if (!descriptor || !("value" in descriptor)) throw new Error(`${path} must be a data property`);
  return descriptor.value;
}

function readNumber(object: DataRecord, key: string, path: string, [min, max]: Limits): number {
  const value = readData(object, key, `${path}.${key}`);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path}.${key} must be a finite number`);
  }
  if (value < min) throw new Error(`${path}.${key} must be >= ${min}`);
  if (value > max) throw new Error(`${path}.${key} must be <= ${max}`);
  return value;
}

function optionalNumber(
  object: DataRecord,
  key: string,
  path: string,
  limits: Limits,
  fallback: number,
): number {
  return hasOwn(object, key) ? readNumber(object, key, path, limits) : fallback;
}

function optionalInteger(
  object: DataRecord,
  key: string,
  path: string,
  limits: Limits,
  fallback: number,
): number {
  const value = optionalNumber(object, key, path, limits, fallback);
  if (!Number.isInteger(value)) throw new Error(`${path}.${key} must be an integer`);
  return value;
}

function optionalBoolean(
  object: DataRecord,
  key: string,
  path: string,
  fallback: boolean,
): boolean {
  if (!hasOwn(object, key)) return fallback;
  const value = readData(object, key, `${path}.${key}`);
  if (typeof value !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
  return value;
}

function optionalEnum<const Values extends readonly string[]>(
  object: DataRecord,
  key: string,
  path: string,
  values: Values,
  fallback: Values[number],
): Values[number] {
  if (!hasOwn(object, key)) return fallback;
  const value = readData(object, key, `${path}.${key}`);
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${path}.${key} is unsupported`);
  }
  return value as Values[number];
}
