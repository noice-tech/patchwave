import type { Patch } from "@patchwave/schema";

// A mid-heavy growl paired with a clean sine sub oscillator.
export default {
  tempoBpm: 140,
  modulators: [],
  modulationRoutes: [],
  devices: [
    {
      id: "growl",
      type: "subtractiveSynth",
      enabled: true,
      baseFrequencyHz: 70,
      outputGain: 0.18,
      oscillators: [
        {
          // The octave-up saw feeds the growl's midrange.
          id: "growl-saw",
          waveform: "saw",
          octave: 1,
          semitone: 0,
          detuneCents: 0,
          level: 0.72,
          sends: { filter: 1, insert: 0, direct: 0 },
        },
        {
          // Fundamental sine supplies a stable 55 Hz sub layer.
          id: "sub",
          waveform: "sine",
          octave: 0,
          semitone: 0,
          detuneCents: 0,
          level: 0.78,
          sends: { filter: 0, insert: 0, direct: 1 },
        },
      ],
      ampEnvelope: {
        attackSeconds: 0.004,
        decaySeconds: 0.3,
        sustain: 0.82,
        releaseSeconds: 0.18,
      },
      filter: {
        enabled: true,
        mode: "lowpass",
        cutoffHz: 360,
        resonance: 0.68,
        sends: { insert: 1, direct: 0 },
      },
      audioRateRoutes: [],
    },
    {
      id: "snarl",
      type: "saturator",
      enabled: true,
      driveDb: 17,
      outputGainDb: -8,
      mix: 0.66,
    },
    {
      id: "weight",
      type: "saturator",
      enabled: true,
      driveDb: 7,
      outputGainDb: -4,
      mix: 0.32,
    },
    {
      id: "space",
      type: "stereoDelay",
      enabled: true,
      timeMs: 95,
      feedback: 0.2,
      damping: 0.72,
      pingPong: true,
      mix: 0.1,
    },
  ],
} satisfies Patch;
