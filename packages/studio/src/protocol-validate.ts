import { EFFECT_COUNT_MAX, OSCILLATOR_COUNT_MAX } from "@patchwave/schema";
import { NOTE_CODES } from "./keyboard-state.js";
import type { PatchEditOperation, PatchFieldPath, PatchScalar } from "./edit-types.js";
import type { StudioInput } from "./protocol.js";

const INPUT_CODES = new Set([...Object.keys(NOTE_CODES), "KeyZ", "KeyX"]);
const WAVEFORMS = new Set(["sine", "triangle", "saw", "pulse", "noise"]);
const EFFECT_TYPES = new Set(["saturator", "stereoDelay"]);
const FIELD_NAMES = new Set([
  "frequencyHz",
  "gainDb",
  "transposeSemitones",
  "detuneCents",
  "pulseWidth",
  "level",
  "mode",
  "cutoffHz",
  "resonance",
  "shape",
  "rateHz",
  "amountOctaves",
  "attackSeconds",
  "decaySeconds",
  "sustain",
  "releaseSeconds",
  "driveDb",
  "outputGainDb",
  "mix",
  "timeSeconds",
  "feedback",
  "damping",
  "pingPong",
]);

export function parseStudioInput(serialized: string): StudioInput | undefined {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "releaseAll" && exact(value, ["type"])) return { type: "releaseAll" };
  if (
    (value.type === "keyDown" || value.type === "keyUp") &&
    exact(value, ["code", "type"]) &&
    typeof value.code === "string" &&
    INPUT_CODES.has(value.code)
  ) {
    return { type: value.type, code: value.code };
  }
  if (!validProtocol(value) || !validRequestId(value.requestId)) return undefined;
  if (value.type === "preview") {
    if (
      !exact(value, [
        "baseRevision",
        "gestureId",
        "path",
        "protocol",
        "requestId",
        "type",
        "value",
      ]) ||
      !validRevision(value.baseRevision) ||
      !validId(value.gestureId) ||
      !isPatchFieldPath(value.path) ||
      !isScalar(value.value)
    )
      return undefined;
    return {
      type: "preview",
      protocol: 1,
      requestId: value.requestId,
      gestureId: value.gestureId,
      baseRevision: value.baseRevision,
      path: value.path,
      value: value.value,
    };
  }
  if (value.type === "cancelPreview") {
    if (!exact(value, ["gestureId", "protocol", "requestId", "type"]) || !validId(value.gestureId))
      return undefined;
    return {
      type: "cancelPreview",
      protocol: 1,
      requestId: value.requestId,
      gestureId: value.gestureId,
    };
  }
  if (value.type === "commit") {
    if (
      !exact(value, ["baseRevision", "gestureId", "operation", "protocol", "requestId", "type"]) ||
      !validRevision(value.baseRevision) ||
      !(value.gestureId === null || validId(value.gestureId))
    )
      return undefined;
    const operation = parseOperation(value.operation);
    if (!operation) return undefined;
    return {
      type: "commit",
      protocol: 1,
      requestId: value.requestId,
      gestureId: value.gestureId,
      baseRevision: value.baseRevision,
      operation,
    };
  }
  if (value.type === "undo" || value.type === "redo") {
    if (
      !exact(value, ["baseRevision", "protocol", "requestId", "type"]) ||
      !validRevision(value.baseRevision)
    )
      return undefined;
    return {
      type: value.type,
      protocol: 1,
      requestId: value.requestId,
      baseRevision: value.baseRevision,
    };
  }
  return undefined;
}

function parseOperation(value: unknown): PatchEditOperation | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "setField") {
    if (
      !exact(value, ["path", "type", "value"]) ||
      !isPatchFieldPath(value.path) ||
      !isScalar(value.value)
    )
      return undefined;
    return { type: value.type, path: value.path, value: value.value };
  }
  if (value.type === "resetField") {
    if (!exact(value, ["path", "type"]) || !isPatchFieldPath(value.path)) return undefined;
    return { type: value.type, path: value.path };
  }
  if (value.type === "addOscillator" || value.type === "replaceOscillator") {
    if (
      !exact(value, ["index", "type", "waveform"]) ||
      !validIndex(value.index, OSCILLATOR_COUNT_MAX) ||
      typeof value.waveform !== "string" ||
      !WAVEFORMS.has(value.waveform)
    )
      return undefined;
    return {
      type: value.type,
      index: value.index,
      waveform: value.waveform as "sine" | "triangle" | "saw" | "pulse" | "noise",
    };
  }
  if (value.type === "removeOscillator") {
    if (!exact(value, ["index", "type"]) || !validIndex(value.index, OSCILLATOR_COUNT_MAX - 1))
      return undefined;
    return { type: value.type, index: value.index };
  }
  if (value.type === "moveOscillator") {
    if (
      !exact(value, ["from", "to", "type"]) ||
      !validIndex(value.from, OSCILLATOR_COUNT_MAX - 1) ||
      !validIndex(value.to, OSCILLATOR_COUNT_MAX - 1)
    )
      return undefined;
    return { type: value.type, from: value.from, to: value.to };
  }
  if (["addFilter", "removeFilter", "addCutoffLfo", "removeCutoffLfo"].includes(value.type)) {
    if (!exact(value, ["type"])) return undefined;
    return { type: value.type } as PatchEditOperation;
  }
  if (value.type === "addEffect" || value.type === "replaceEffect") {
    if (
      !exact(value, ["effectType", "index", "type"]) ||
      !validIndex(value.index, EFFECT_COUNT_MAX) ||
      typeof value.effectType !== "string" ||
      !EFFECT_TYPES.has(value.effectType)
    )
      return undefined;
    return {
      type: value.type,
      index: value.index,
      effectType: value.effectType as "saturator" | "stereoDelay",
    };
  }
  if (value.type === "removeEffect") {
    if (!exact(value, ["index", "type"]) || !validIndex(value.index, EFFECT_COUNT_MAX - 1))
      return undefined;
    return { type: value.type, index: value.index };
  }
  if (value.type === "moveEffect") {
    if (
      !exact(value, ["from", "to", "type"]) ||
      !validIndex(value.from, EFFECT_COUNT_MAX - 1) ||
      !validIndex(value.to, EFFECT_COUNT_MAX - 1)
    )
      return undefined;
    return { type: value.type, from: value.from, to: value.to };
  }
  return undefined;
}

export function isPatchFieldPath(value: unknown): value is PatchFieldPath {
  if (
    !Array.isArray(value) ||
    value.length < 2 ||
    value.length > 4 ||
    value.some((part) => typeof part !== "string" && !Number.isInteger(part))
  )
    return false;
  const last = value.at(-1);
  if (typeof last !== "string" || !FIELD_NAMES.has(last)) return false;
  if (value[0] === "effects")
    return (
      value.length === 3 &&
      validIndex(value[1], EFFECT_COUNT_MAX - 1) &&
      ["driveDb", "outputGainDb", "mix", "timeSeconds", "feedback", "damping", "pingPong"].includes(
        last,
      )
    );
  if (value[0] !== "source") return false;
  if (value.length === 2) return last === "frequencyHz" || last === "gainDb";
  if (value[1] === "oscillators")
    return (
      value.length === 4 &&
      validIndex(value[2], OSCILLATOR_COUNT_MAX - 1) &&
      ["transposeSemitones", "detuneCents", "pulseWidth", "level"].includes(last)
    );
  if (value[1] === "filter") {
    if (value.length === 3) return ["mode", "cutoffHz", "resonance"].includes(last);
    return (
      value.length === 4 &&
      value[2] === "cutoffLfo" &&
      ["shape", "rateHz", "amountOctaves"].includes(last)
    );
  }
  return (
    value[1] === "ampEnvelope" &&
    value.length === 3 &&
    ["attackSeconds", "decaySeconds", "sustain", "releaseSeconds"].includes(last)
  );
}

function isScalar(value: unknown): value is PatchScalar {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.length <= 128)
  );
}
function validProtocol(
  value: Record<string, unknown>,
): value is Record<string, unknown> & { protocol: 1; requestId: string } {
  return value.protocol === 1 && typeof value.requestId === "string";
}
function validRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}
function validRequestId(value: unknown): value is string {
  return validId(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}
function validIndex(value: unknown, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
}
function exact(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
