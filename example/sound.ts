import type { Patch } from "@patchwave/schema";

// The smallest useful Patchwave patch.
export default {
  source: {
    frequencyHz: 110,
    oscillators: [{ waveform: "saw" }],
  },
} satisfies Patch;
