import { EFFECT_COUNT_MAX, LIMITS, OSCILLATOR_COUNT_MAX } from "./limits.js";

export type PatchEditorControl = Readonly<{
  label: string;
  kind: "number" | "enum" | "boolean";
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  values?: readonly string[];
  defaultValue?: number | string | boolean;
  integer?: boolean;
}>;

const number = (
  label: string,
  limits: readonly [number, number],
  step: number,
  unit: string | undefined,
  defaultValue?: number,
  integer = false,
): PatchEditorControl => ({
  label,
  kind: "number",
  min: limits[0],
  max: limits[1],
  step,
  ...(unit ? { unit } : {}),
  ...(defaultValue === undefined ? {} : { defaultValue }),
  ...(integer ? { integer: true } : {}),
});

export const PATCH_EDITOR = Object.freeze({
  oscillatorCountMax: OSCILLATOR_COUNT_MAX,
  effectCountMax: EFFECT_COUNT_MAX,
  controls: Object.freeze({
    frequencyHz: number("Frequency", LIMITS.frequencyHz, 1, "Hz"),
    gainDb: number("Gain", LIMITS.sourceGainDb, 0.1, "dB", -12),
    waveform: {
      label: "Waveform",
      kind: "enum",
      values: ["sine", "triangle", "saw", "pulse", "noise"],
    },
    transposeSemitones: number("Transpose", LIMITS.transposeSemitones, 1, "semitones", 0, true),
    detuneCents: number("Detune", LIMITS.detuneCents, 1, "cents", 0),
    pulseWidth: number("Pulse width", LIMITS.pulseWidth, 0.01, undefined, 0.5),
    level: number("Level", LIMITS.normalized, 0.01, undefined, 1),
    filterMode: {
      label: "Mode",
      kind: "enum",
      values: ["lowpass", "bandpass", "highpass"],
      defaultValue: "lowpass",
    },
    cutoffHz: number("Cutoff", LIMITS.cutoffHz, 1, "Hz"),
    resonance: number("Resonance", LIMITS.normalized, 0.01, undefined, 0),
    lfoShape: {
      label: "Shape",
      kind: "enum",
      values: ["sine", "triangle", "sawUp", "sawDown", "square"],
      defaultValue: "sine",
    },
    lfoRateHz: number("Rate", LIMITS.lfoFrequencyHz, 0.01, "Hz"),
    amountOctaves: number("Amount", LIMITS.amountOctaves, 0.01, "octaves"),
    attackSeconds: number("Attack", LIMITS.envelopeSeconds, 0.001, "s", 0.005),
    decaySeconds: number("Decay", LIMITS.envelopeSeconds, 0.001, "s", 0),
    sustain: number("Sustain", LIMITS.normalized, 0.01, undefined, 1),
    releaseSeconds: number("Release", LIMITS.envelopeSeconds, 0.001, "s", 0.1),
    driveDb: number("Drive", LIMITS.driveDb, 0.1, "dB"),
    outputGainDb: number("Output", LIMITS.outputGainDb, 0.1, "dB", 0),
    mix: number("Mix", LIMITS.normalized, 0.01, undefined),
    timeSeconds: number("Time", LIMITS.delayTimeSeconds, 0.001, "s"),
    feedback: number("Feedback", LIMITS.feedback, 0.01, undefined, 0),
    damping: number("Damping", LIMITS.normalized, 0.01, undefined, 0),
    pingPong: { label: "Ping-pong", kind: "boolean", defaultValue: false },
  } satisfies Record<string, PatchEditorControl>),
});
