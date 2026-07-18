import {
  DEVICE_COUNT_MAX,
  DEVICE_COUNT_MIN,
  DEVICE_ID_PATTERN,
  LIMITS,
  V2_MODULATOR_COUNT_MAX,
  V2_OSCILLATOR_COUNT_MAX,
  V2_ROUTE_COUNT_MAX,
} from "./limits.js";
import type {
  AudioProcessor,
  Envelope,
  ModulationRouteV2,
  ModulatorV2,
  OscillatorV2,
  Patch,
  PhaseModulationRouteV2,
  Saturator,
  StereoDelay,
  SubtractiveSynthV2,
  SynthFilterV2,
} from "./types.js";

type DataRecord = Record<string, unknown>;

export function validatePatch(value: unknown): Patch {
  const patch = readObject(value, "patch", [
    "tempoBpm",
    "modulators",
    "modulationRoutes",
    "devices",
  ]);
  const tempoBpm = readNumber(patch, "tempoBpm", "patch", LIMITS.tempoBpm);
  const modValues = readArray(
    readData(patch, "modulators", "modulators"),
    "modulators",
    0,
    V2_MODULATOR_COUNT_MAX,
  );
  const modulators = modValues.map((x, i) => validateModulator(x, `modulators[${i}]`));
  uniqueIds(modulators, "modulators");
  const deviceValues = readArray(
    readData(patch, "devices", "devices"),
    "devices",
    DEVICE_COUNT_MIN,
    DEVICE_COUNT_MAX,
  );
  const source = validateSynthV2(deviceValues[0], "devices[0]");
  const devices: [SubtractiveSynthV2, ...AudioProcessor[]] = [source];
  const ids = new Set([source.id]);
  for (let i = 1; i < deviceValues.length; i++) {
    const device = validateProcessor(deviceValues[i], `devices[${i}]`);
    if (ids.has(device.id)) throw new Error(`devices[${i}].id must be unique`);
    ids.add(device.id);
    devices.push(device);
  }
  const routeValues = readArray(
    readData(patch, "modulationRoutes", "modulationRoutes"),
    "modulationRoutes",
    0,
    V2_ROUTE_COUNT_MAX,
  );
  const routes = routeValues.map((x, i) => validateRoute(x, `modulationRoutes[${i}]`));
  resolveRoutes(routes, modulators, source);
  routes.sort((a, b) => compareAscii(routeKey(a), routeKey(b)));
  resolvePm(source);
  return { tempoBpm, modulators, modulationRoutes: routes, devices };
}

function validateSynthV2(value: unknown, path: string): SubtractiveSynthV2 {
  const object = readObject(value, path, [
    "id",
    "type",
    "enabled",
    "baseFrequencyHz",
    "outputGain",
    "oscillators",
    "ampEnvelope",
    "filter",
    "audioRateRoutes",
  ]);
  expectLiteral(readData(object, "type", `${path}.type`), "subtractiveSynth", `${path}.type`);
  const values = readArray(
    readData(object, "oscillators", `${path}.oscillators`),
    `${path}.oscillators`,
    1,
    V2_OSCILLATOR_COUNT_MAX,
  );
  const oscs = values.map((x, i) => validateOscillatorV2(x, `${path}.oscillators[${i}]`));
  uniqueIds(oscs, `${path}.oscillators`);
  const pmValues = readArray(
    readData(object, "audioRateRoutes", `${path}.audioRateRoutes`),
    `${path}.audioRateRoutes`,
    0,
    1,
  );
  const audioRateRoutes = pmValues.map((x, i) => validatePm(x, `${path}.audioRateRoutes[${i}]`)) as
    | []
    | [PhaseModulationRouteV2];
  return {
    id: readId(object, path),
    type: "subtractiveSynth",
    enabled: readBoolean(object, "enabled", path),
    baseFrequencyHz: readNumber(object, "baseFrequencyHz", path, LIMITS.baseFrequencyHz),
    outputGain: readNumber(object, "outputGain", path, LIMITS.normalized),
    oscillators: oscs as SubtractiveSynthV2["oscillators"],
    ampEnvelope: validateEnvelope(
      readData(object, "ampEnvelope", `${path}.ampEnvelope`),
      `${path}.ampEnvelope`,
    ),
    filter: validateFilterV2(readData(object, "filter", `${path}.filter`), `${path}.filter`),
    audioRateRoutes,
  };
}

function validateEnvelope(value: unknown, path: string): Envelope {
  const o = readObject(value, path, ["attackSeconds", "decaySeconds", "sustain", "releaseSeconds"]);
  return {
    attackSeconds: readNumber(o, "attackSeconds", path, LIMITS.envelopeSeconds),
    decaySeconds: readNumber(o, "decaySeconds", path, LIMITS.envelopeSeconds),
    sustain: readNumber(o, "sustain", path, LIMITS.normalized),
    releaseSeconds: readNumber(o, "releaseSeconds", path, LIMITS.envelopeSeconds),
  };
}
function validateFilterV2(value: unknown, path: string): SynthFilterV2 {
  const o = readObject(value, path, ["enabled", "mode", "cutoffHz", "resonance", "sends"]);
  const sends = readObject(readData(o, "sends", `${path}.sends`), `${path}.sends`, [
    "insert",
    "direct",
  ]);
  return {
    enabled: readBoolean(o, "enabled", path),
    mode: readMode(o, path),
    cutoffHz: readNumber(o, "cutoffHz", path, LIMITS.cutoffHz),
    resonance: readNumber(o, "resonance", path, LIMITS.normalized),
    sends: {
      insert: readNumber(sends, "insert", `${path}.sends`, LIMITS.normalized),
      direct: readNumber(sends, "direct", `${path}.sends`, LIMITS.normalized),
    },
  };
}
function readMode(o: DataRecord, path: string): "lowpass" | "bandpass" | "highpass" {
  const m = readData(o, "mode", `${path}.mode`);
  if (m !== "lowpass" && m !== "bandpass" && m !== "highpass")
    throw new Error(`${path}.mode must be lowpass, bandpass, or highpass`);
  return m;
}

function validateOscillatorV2(value: unknown, path: string): OscillatorV2 {
  const o = readObjectForDiscriminant(value, path);
  const w = readData(o, "waveform", `${path}.waveform`);
  const base = ["id", "waveform", "level", "sends"];
  if (w === "noise") {
    const n = readObject(value, path, base);
    return {
      id: readId(n, path),
      waveform: "noise",
      level: readNumber(n, "level", path, LIMITS.normalized),
      sends: validateSends(readData(n, "sends", `${path}.sends`), `${path}.sends`),
    };
  }
  const keys = [
    "id",
    "waveform",
    "octave",
    "semitone",
    "detuneCents",
    ...(w === "pulse" ? ["pulseWidth"] : []),
    "level",
    "sends",
  ];
  if (w !== "sine" && w !== "triangle" && w !== "saw" && w !== "pulse")
    throw new Error(`${path}.waveform is unsupported`);
  const t = readObject(value, path, keys);
  const id = readId(t, path);
  const tuning = readTuning(t, path);
  const level = readNumber(t, "level", path, LIMITS.normalized);
  const sends = validateSends(readData(t, "sends", `${path}.sends`), `${path}.sends`);
  return w === "pulse"
    ? {
        id,
        waveform: "pulse",
        ...tuning,
        pulseWidth: readNumber(t, "pulseWidth", path, LIMITS.pulseWidth),
        level,
        sends,
      }
    : { id, waveform: w, ...tuning, level, sends };
}
function validateSends(value: unknown, path: string) {
  const o = readObject(value, path, ["filter", "insert", "direct"]);
  return {
    filter: readNumber(o, "filter", path, LIMITS.normalized),
    insert: readNumber(o, "insert", path, LIMITS.normalized),
    direct: readNumber(o, "direct", path, LIMITS.normalized),
  };
}

function validateModulator(value: unknown, path: string): ModulatorV2 {
  const d = readObjectForDiscriminant(value, path);
  const type = readData(d, "type", `${path}.type`);
  if (type === "envelope") {
    const o = readObject(value, path, [
      "id",
      "type",
      "enabled",
      "attackSeconds",
      "decaySeconds",
      "sustain",
      "releaseSeconds",
    ]);
    const e = validateEnvelopeFields(o, path);
    return { id: readId(o, path), type, enabled: readBoolean(o, "enabled", path), ...e };
  }
  if (type !== "lfo") throw new Error(`${path}.type is unsupported`);
  const o = readObject(value, path, [
    "id",
    "type",
    "enabled",
    "shape",
    "polarity",
    "rate",
    "phaseMode",
    "phaseOffset",
  ]);
  const shape = readEnum(o, "shape", path, [
    "sine",
    "triangle",
    "sawUp",
    "sawDown",
    "square",
  ] as const);
  const polarity = readEnum(o, "polarity", path, ["unipolar", "bipolar"] as const);
  const phaseMode = readEnum(o, "phaseMode", path, ["free", "gateReset"] as const);
  const phaseOffset = readNumber(o, "phaseOffset", path, [0, 1]);
  if (phaseOffset >= 1) throw new Error(`${path}.phaseOffset must be < 1`);
  const rateAny = readObjectForDiscriminant(readData(o, "rate", `${path}.rate`), `${path}.rate`);
  const mode = readData(rateAny, "mode", `${path}.rate.mode`);
  const rate =
    mode === "hz"
      ? (() => {
          const r = readObject(rateAny, `${path}.rate`, ["mode", "frequencyHz"]);
          return {
            mode: "hz" as const,
            frequencyHz: readNumber(r, "frequencyHz", `${path}.rate`, LIMITS.lfoFrequencyHz),
          };
        })()
      : mode === "sync"
        ? (() => {
            const r = readObject(rateAny, `${path}.rate`, ["mode", "division"]);
            return {
              mode: "sync" as const,
              division: readEnum(r, "division", `${path}.rate`, [
                "1/1",
                "1/2",
                "1/4",
                "1/8",
                "1/16",
              ] as const),
            };
          })()
        : (() => {
            throw new Error(`${path}.rate.mode is unsupported`);
          })();
  return {
    id: readId(o, path),
    type,
    enabled: readBoolean(o, "enabled", path),
    shape,
    polarity,
    rate,
    phaseMode,
    phaseOffset,
  };
}
function validateEnvelopeFields(o: DataRecord, path: string) {
  return {
    attackSeconds: readNumber(o, "attackSeconds", path, LIMITS.envelopeSeconds),
    decaySeconds: readNumber(o, "decaySeconds", path, LIMITS.envelopeSeconds),
    sustain: readNumber(o, "sustain", path, LIMITS.normalized),
    releaseSeconds: readNumber(o, "releaseSeconds", path, LIMITS.envelopeSeconds),
  };
}

function validateRoute(value: unknown, path: string): ModulationRouteV2 {
  const o = readObjectForDiscriminant(value, path);
  const targetAny = readObjectForDiscriminant(
    readData(o, "target", `${path}.target`),
    `${path}.target`,
  );
  const type = readData(targetAny, "type", `${path}.target.type`);
  const source = (() => {
    const v = readData(o, "source", `${path}.source`);
    if (typeof v !== "string" || !DEVICE_ID_PATTERN.test(v))
      throw new Error(`${path}.source is invalid`);
    return v;
  })();
  if (type === "filterCutoff") {
    const full = readObject(value, path, ["source", "target", "amountOctaves"]);
    const t = readObject(targetAny, `${path}.target`, ["type", "device"]);
    return {
      source,
      target: { type: "filterCutoff", device: readRef(t, "device", `${path}.target`) },
      amountOctaves: readNumber(full, "amountOctaves", path, LIMITS.amountOctaves),
    };
  }
  if (type === "sourceGain") {
    const full = readObject(value, path, ["source", "target", "amountDb"]);
    const t = readObject(targetAny, `${path}.target`, ["type", "device"]);
    return {
      source,
      target: { type: "sourceGain", device: readRef(t, "device", `${path}.target`) },
      amountDb: readNumber(full, "amountDb", path, LIMITS.amountDb),
    };
  }
  if (type === "oscillatorPitch" || type === "pulseWidth" || type === "oscillatorLevel") {
    const expected = type === "oscillatorPitch" ? "amountSemitones" : "amount";
    const full = readObject(value, path, ["source", "target", expected]);
    const t = readObject(targetAny, `${path}.target`, ["type", "device", "oscillator"]);
    const device = readRef(t, "device", `${path}.target`);
    const oscillator = readRef(t, "oscillator", `${path}.target`);
    if (type === "oscillatorPitch")
      return {
        source,
        target: { type, device, oscillator },
        amountSemitones: readNumber(full, expected, path, LIMITS.amountSemitones),
      };
    if (type === "pulseWidth")
      return {
        source,
        target: { type, device, oscillator },
        amount: readNumber(full, expected, path, LIMITS.signedNormalized),
      };
    return {
      source,
      target: { type, device, oscillator },
      amount: readNumber(full, expected, path, LIMITS.signedNormalized),
    };
  }
  throw new Error(`${path}.target.type is unsupported`);
}
function validatePm(value: unknown, path: string): PhaseModulationRouteV2 {
  const o = readObject(value, path, ["type", "source", "target", "indexRadians"]);
  expectLiteral(readData(o, "type", `${path}.type`), "phaseModulation", `${path}.type`);
  return {
    type: "phaseModulation",
    source: readRef(o, "source", path),
    target: readRef(o, "target", path),
    indexRadians: readNumber(o, "indexRadians", path, LIMITS.pmIndex),
  };
}
function resolveRoutes(
  routes: ModulationRouteV2[],
  mods: ModulatorV2[],
  synth: SubtractiveSynthV2,
) {
  const mids = new Set(mods.map((x) => x.id));
  const seen = new Set<string>();
  for (const r of routes) {
    if (!mids.has(r.source)) throw new Error(`modulation route source ${r.source} is unknown`);
    if (r.target.device !== synth.id)
      throw new Error(`modulation route device ${r.target.device} is unknown`);
    const key = routeKey(r);
    if (seen.has(key)) throw new Error("modulation routes must have unique source/target identity");
    seen.add(key);
    if ("oscillator" in r.target) {
      const oscillatorId = r.target.oscillator;
      const osc = synth.oscillators.find((x) => x.id === oscillatorId);
      if (!osc) throw new Error(`modulation route oscillator ${oscillatorId} is unknown`);
      if (r.target.type === "oscillatorPitch" && osc.waveform === "noise")
        throw new Error("oscillatorPitch target must be tonal");
      if (r.target.type === "pulseWidth" && osc.waveform !== "pulse")
        throw new Error("pulseWidth target must be pulse");
    }
  }
}
function resolvePm(synth: SubtractiveSynthV2) {
  const pm = synth.audioRateRoutes[0];
  if (!pm) return;
  const source = synth.oscillators.find((x) => x.id === pm.source);
  const target = synth.oscillators.find((x) => x.id === pm.target);
  if (!source || !target) throw new Error("phase modulation endpoint is unknown");
  if (source.id === target.id) throw new Error("phase modulation source and target must differ");
  if (source.waveform !== "sine" || target.waveform !== "sine")
    throw new Error("phase modulation endpoints must be sine");
}
function routeKey(r: ModulationRouteV2) {
  return `${r.source}\u0000${r.target.type}\u0000${r.target.device}\u0000${"oscillator" in r.target ? r.target.oscillator : ""}`;
}
function compareAscii(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function validateProcessor(value: unknown, path: string): AudioProcessor {
  const o = readObjectForDiscriminant(value, path);
  const t = readData(o, "type", `${path}.type`);
  if (t === "saturator") return validateSaturator(value, path);
  if (t === "stereoDelay") return validateDelay(value, path);
  if (t === "subtractiveSynth") throw new Error(`${path}.type must be an audio processor`);
  throw new Error(`${path}.type is unsupported`);
}
function validateSaturator(value: unknown, path: string): Saturator {
  const o = readObject(value, path, ["id", "type", "enabled", "driveDb", "outputGainDb", "mix"]);
  return {
    id: readId(o, path),
    type: "saturator",
    enabled: readBoolean(o, "enabled", path),
    driveDb: readNumber(o, "driveDb", path, LIMITS.driveDb),
    outputGainDb: readNumber(o, "outputGainDb", path, LIMITS.outputGainDb),
    mix: readNumber(o, "mix", path, LIMITS.normalized),
  };
}
function validateDelay(value: unknown, path: string): StereoDelay {
  const o = readObject(value, path, [
    "id",
    "type",
    "enabled",
    "timeMs",
    "feedback",
    "damping",
    "pingPong",
    "mix",
  ]);
  return {
    id: readId(o, path),
    type: "stereoDelay",
    enabled: readBoolean(o, "enabled", path),
    timeMs: readNumber(o, "timeMs", path, LIMITS.delayTimeMs),
    feedback: readNumber(o, "feedback", path, LIMITS.feedback),
    damping: readNumber(o, "damping", path, LIMITS.normalized),
    pingPong: readBoolean(o, "pingPong", path),
    mix: readNumber(o, "mix", path, LIMITS.normalized),
  };
}

function readTuning(o: DataRecord, path: string) {
  return {
    octave: readInteger(o, "octave", path, LIMITS.octave),
    semitone: readInteger(o, "semitone", path, LIMITS.semitone),
    detuneCents: readNumber(o, "detuneCents", path, LIMITS.detuneCents),
  };
}
function uniqueIds<T extends { id: string }>(xs: T[], path: string) {
  const ids = new Set<string>();
  xs.forEach((x, i) => {
    if (ids.has(x.id)) throw new Error(`${path}[${i}].id must be unique`);
    ids.add(x.id);
  });
}
function readObjectForDiscriminant(value: unknown, path: string): DataRecord {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${path} must be a plain object`);
  for (const key of Reflect.ownKeys(value))
    if (typeof key === "symbol") throw new Error(`${path} must not contain symbol keys`);
  return value as DataRecord;
}
function readObject(value: unknown, path: string, keys: readonly string[]): DataRecord {
  const o = readObjectForDiscriminant(value, path);
  for (const key of Reflect.ownKeys(o))
    if (typeof key !== "string" || !keys.includes(key))
      throw new Error(`${path}.${String(key)} is unknown`);
  for (const key of keys) {
    if (!Object.hasOwn(o, key)) throw new Error(`${path}.${key} is required`);
    const d = Object.getOwnPropertyDescriptor(o, key);
    if (!d || !("value" in d) || !d.enumerable)
      throw new Error(`${path}.${key} must be an enumerable data property`);
  }
  return o;
}
function readArray(value: unknown, path: string, min: number, max: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    throw new Error(`${path} must be an array`);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === "symbol") throw new Error(`${path} must not contain symbol keys`);
    if (key !== "length" && !/^(0|[1-9][0-9]*)$/.test(key))
      throw new Error(`${path}.${key} is unknown`);
  }
  if (value.length < min || value.length > max)
    throw new Error(`${path} must contain ${min}–${max} items`);
  const out: unknown[] = [];
  for (let i = 0; i < value.length; i++) {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d) throw new Error(`${path}[${i}] is required`);
    if (!("value" in d) || !d.enumerable)
      throw new Error(`${path}[${i}] must be an enumerable data property`);
    out.push(d.value);
  }
  return out;
}
function readData(o: DataRecord, key: string, path: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (!d || !("value" in d)) throw new Error(`${path} must be a data property`);
  return d.value;
}
function readId(o: DataRecord, path: string) {
  return readRef(o, "id", path);
}
function readRef(o: DataRecord, key: string, path: string): string {
  const v = readData(o, key, `${path}.${key}`);
  if (typeof v !== "string" || !DEVICE_ID_PATTERN.test(v))
    throw new Error(`${path}.${key} is invalid`);
  return v;
}
function readBoolean(o: DataRecord, key: string, path: string) {
  const v = readData(o, key, `${path}.${key}`);
  if (typeof v !== "boolean") throw new Error(`${path}.${key} must be a boolean`);
  return v;
}
function readNumber(
  o: DataRecord,
  key: string,
  path: string,
  [min, max]: readonly [number, number],
) {
  const v = readData(o, key, `${path}.${key}`);
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`${path}.${key} must be a finite number`);
  if (v < min) throw new Error(`${path}.${key} must be >= ${min}`);
  if (v > max) throw new Error(`${path}.${key} must be <= ${max}`);
  return v;
}
function readInteger(o: DataRecord, key: string, path: string, limits: readonly [number, number]) {
  const v = readNumber(o, key, path, limits);
  if (!Number.isInteger(v)) throw new Error(`${path}.${key} must be an integer`);
  return v;
}
function readEnum<const T extends readonly string[]>(
  o: DataRecord,
  key: string,
  path: string,
  values: T,
): T[number] {
  const v = readData(o, key, `${path}.${key}`);
  if (typeof v !== "string" || !values.includes(v))
    throw new Error(`${path}.${key} is unsupported`);
  return v as T[number];
}
function expectLiteral(value: unknown, expected: string | number, path: string) {
  if (value !== expected) throw new Error(`${path} must be ${expected}`);
}
