export const PATCH_JSON_MAX_BYTES = 65_536;
export const OSCILLATOR_COUNT_MAX = 4;
export const EFFECT_COUNT_MAX = 7;

// Public numeric limits are shared by the TypeScript author validator and the
// Rust canonical parser. They bound realtime work, filter stability, delay
// storage, and parameter ramps.
export const LIMITS = {
  frequencyHz: [1, 20_000],
  sourceGainDb: [-60, 0],
  transposeSemitones: [-48, 48],
  detuneCents: [-100, 100],
  normalized: [0, 1],
  pulseWidth: [0.05, 0.95],
  envelopeSeconds: [0, 30],
  cutoffHz: [20, 20_000],
  lfoFrequencyHz: [0.01, 40],
  amountOctaves: [0, 8],
  driveDb: [0, 36],
  outputGainDb: [-36, 12],
  delayTimeSeconds: [0.001, 2],
  feedback: [0, 0.95],
} as const;
