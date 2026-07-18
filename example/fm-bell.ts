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
      baseFrequencyHz: 50,
      outputGain: 0.18,
      oscillators: [
        {
          id: "carrier",
          waveform: "sine",
          octave: 1,
          semitone: 0,
          detuneCents: 0,
          level: 1,
          sends: { filter: 0, insert: 1, direct: 0 },
        },
        {
          id: "mod",
          waveform: "sine",
          octave: 3,
          semitone: 0,
          detuneCents: 0,
          level: 0,
          sends: { filter: 0, insert: 0, direct: 0 },
        },
      ],
      ampEnvelope: {
        attackSeconds: 0.003,
        decaySeconds: 5,
        sustain: 0.8,
        releaseSeconds: 0.2,
      },
      filter: {
        enabled: true,
        mode: "lowpass",
        cutoffHz: 20,
        resonance: 1,
        sends: { insert: 1, direct: 0 },
      },
      audioRateRoutes: [
        {
          type: "phaseModulation",
          source: "mod",
          target: "carrier",
          indexRadians: 3.5,
        },
      ],
    },
  ],
} satisfies Patch;
