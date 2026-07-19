import type { PatchProgram } from "@patchwave/schema";

export default (({ timeSeconds, voice }) => {
  const movement = (Math.sin(timeSeconds * Math.PI * 0.5) + 1) / 2;

  return {
    source: {
      frequencyHz: voice.frequencyHz,
      gainDb: -15,
      oscillators: [
        { waveform: "saw", detuneCents: -6, level: 0.5 },
        { waveform: "saw", detuneCents: 6, level: 0.5 },
      ],
      filter: {
        cutoffHz: 200 + movement * 2_400,
        resonance: 0.45,
      },
      ampEnvelope: {
        attackSeconds: 0.01,
        releaseSeconds: 0.2,
      },
    },
    effects: [{ type: "saturator", driveDb: 10, outputGainDb: -5, mix: 0.65 }],
  };
}) satisfies PatchProgram;
