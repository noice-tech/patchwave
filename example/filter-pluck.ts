import type { Patch } from "@patchwave/schema";

export default {
  tempoBpm: 120,
  modulators: [{ id: "pluck", type: "envelope", enabled: true, attackSeconds: 0, decaySeconds: 0.18, sustain: 0, releaseSeconds: 0.1 }],
  modulationRoutes: [{ source: "pluck", target: { type: "filterCutoff", device: "voice" }, amountOctaves: 5 }],
  devices: [{
    id: "voice", type: "subtractiveSynth", enabled: true,
    baseFrequencyHz: 110, outputGain: 0.18,
    oscillators: [{ id: "saw", waveform: "saw", octave: 0, semitone: 0, detuneCents: 0, level: 0.8, sends: { filter: 1, insert: 0, direct: 0 } }],
    ampEnvelope: { attackSeconds: 0.003, decaySeconds: 0.2, sustain: 0.8, releaseSeconds: 0.2 },
    filter: { enabled: true, mode: "lowpass", cutoffHz: 500, resonance: 0.7, sends: { insert: 1, direct: 0 } },
    audioRateRoutes: [],
  }],
} satisfies Patch;
