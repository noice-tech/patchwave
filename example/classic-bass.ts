import type { Patch } from "@patchwave/schema";

// A detuned saw bass with a steady sine fundamental.
export default {
  source: {
    frequencyHz: 55,
    gainDb: -15,
    oscillators: [
      { waveform: "saw", transposeSemitones: 12, detuneCents: -7, level: 0.38 },
      { waveform: "saw", transposeSemitones: 12, detuneCents: 7, level: 0.38 },
      { waveform: "sine", level: 0.75 },
    ],
    filter: {
      cutoffHz: 700,
      resonance: 0.35,
    },
    ampEnvelope: {
      attackSeconds: 0.005,
      releaseSeconds: 0.18,
    },
  },
  effects: [{ type: "saturator", driveDb: 12, outputGainDb: -5, mix: 0.55 }],
} satisfies Patch;
