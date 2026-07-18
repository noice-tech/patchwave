export const PATCH_JSON_MAX_BYTES = 65_536;
export const DEVICE_COUNT_MIN = 1;
export const DEVICE_COUNT_MAX = 8;
export const DEVICE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const V2_OSCILLATOR_COUNT_MAX = 4;
export const V2_MODULATOR_COUNT_MAX = 4;
export const V2_ROUTE_COUNT_MAX = 8;

export const LIMITS = {
  baseFrequencyHz: [1, 20_000],
  cutoffHz: [20, 20_000],
  octave: [-4, 4],
  semitone: [-12, 12],
  detuneCents: [-100, 100],
  normalized: [0, 1],
  signedNormalized: [-1, 1],
  pulseWidth: [0.05, 0.95],
  envelopeSeconds: [0, 30],
  envelopeAmountHz: [-20_000, 20_000],
  driveDb: [0, 36],
  outputGainDb: [-36, 12],
  delayTimeMs: [1, 2_000],
  feedback: [0, 0.95],
  tempoBpm: [20, 300],
  lfoFrequencyHz: [0.01, 40],
  amountOctaves: [-8, 8],
  amountSemitones: [-48, 48],
  amountDb: [-60, 24],
  pmIndex: [0, 8],
} as const;
