import type { Patch } from "@patchwave/schema";

export default {
  tempoBpm: 128,
  modulators: [
    {
      id: "motion",
      type: "lfo",
      enabled: true,
      shape: "sine",
      polarity: "bipolar",
      rate: { mode: "sync", division: "1/4" },
      phaseMode: "gateReset",
      phaseOffset: 0,
    },
  ],
  modulationRoutes: [
    {
      source: "motion",
      target: { type: "pulseWidth", device: "voice", oscillator: "pulse" },
      amount: 0.35,
    },
  ],
  devices: [
    {
      id: "voice",
      type: "subtractiveSynth",
      enabled: true,
      baseFrequencyHz: 110,
      outputGain: 0.18,
      oscillators: [
        {
          id: "pulse",
          waveform: "pulse",
          octave: 0,
          semitone: 0,
          detuneCents: 0,
          pulseWidth: 0.5,
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
        sends: { insert: 1, direct: 0 },
      },
      audioRateRoutes: [],
    },
  ],
} satisfies Patch;
