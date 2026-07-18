import type { Patch } from "@patchwave/schema";

export default {
  tempoBpm: 100,
  modulators: [],
  modulationRoutes: [],
  devices: [
    {
      id: "voice",
      type: "subtractiveSynth",
      enabled: true,
      baseFrequencyHz: 110,
      outputGain: 0.18,
      oscillators: [
        {
          id: "saw",
          waveform: "saw",
          octave: 0,
          semitone: 0,
          detuneCents: 0,
          level: 0.8,
          sends: { filter: 1, insert: 0, direct: 0 },
        },
      ],
      ampEnvelope: {
        attackSeconds: 0.003,
        decaySeconds: 0.2,
        sustain: 0.8,
        releaseSeconds: 0.2,
      },
      filter: {
        enabled: true,
        mode: "lowpass",
        cutoffHz: 500,
        resonance: 0.7,
        sends: { insert: 0, direct: 1 },
      },
      audioRateRoutes: [],
    },
    {
      id: "drive",
      type: "saturator",
      enabled: true,
      driveDb: 30,
      outputGainDb: -12,
      mix: 1,
    },
  ],
} satisfies Patch;
