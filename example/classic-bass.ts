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
      mode: "bandpass",
      cutoffHz: 609,
      resonance: 0.31,
    },
    ampEnvelope: {
      attackSeconds: 0.005,
      releaseSeconds: 0.18,
    },
  },
  effects: [
    { type: "saturator", driveDb: 24.6 },
    {
      type: "stereoDelay",
      timeSeconds: 0.906,
      feedback: 0.32,
      damping: 0.16,
      mix: 0.25,
    },
  ],
} satisfies Patch;
