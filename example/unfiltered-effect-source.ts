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
          id: "noise",
          waveform: "noise",
          level: 0.5,
          sends: { filter: 0, insert: 1, direct: 0 },
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
        sends: { insert: 0, direct: 0 },
      },
      audioRateRoutes: [],
    },
    {
      id: "delay",
      type: "stereoDelay",
      enabled: true,
      timeMs: 180,
      feedback: 0.4,
      damping: 0.5,
      pingPong: true,
      mix: 0.4,
    },
  ],
} satisfies Patch;
