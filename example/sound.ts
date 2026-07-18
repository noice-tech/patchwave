import type { Patch } from "@patchwave/schema";

export default {
  tempoBpm: 120,
  modulators: [],
  modulationRoutes: [],
  devices: [
    {
      id: "bass",
      type: "subtractiveSynth",
      enabled: true,
      baseFrequencyHz: 70,
      outputGain: 0.1,
      oscillators: [
        {
          id: "saw",
          waveform: "saw",
          octave: 0,
          semitone: 0,
          detuneCents: -5,
          level: 0.7,
          sends: { filter: 1, insert: 0, direct: 0 },
        },
        {
          id: "pulse",
          waveform: "pulse",
          octave: 0,
          semitone: 0,
          detuneCents: 5,
          pulseWidth: 0.45,
          level: 0.3,
          sends: { filter: 1, insert: 0, direct: 0 },
        },
      ],
      ampEnvelope: {
        attackSeconds: 0.01,
        decaySeconds: 0.2,
        sustain: 0.7,
        releaseSeconds: 0.35,
      },
      filter: {
        enabled: true,
        mode: "lowpass",
        cutoffHz: 900,
        resonance: 0.3,
        sends: { insert: 1, direct: 0 },
      },
      audioRateRoutes: [],
    },
    {
      id: "drive",
      type: "saturator",
      enabled: true,
      driveDb: 8,
      outputGainDb: -5,
      mix: 0.35,
    },
    {
      id: "echo",
      type: "stereoDelay",
      enabled: true,
      timeMs: 280,
      feedback: 0.35,
      damping: 0.5,
      pingPong: true,
      mix: 0.2,
    },
  ],
} satisfies Patch;
