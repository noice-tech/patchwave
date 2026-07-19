export type Envelope = {
  attackSeconds?: number;
  decaySeconds?: number;
  sustain?: number;
  releaseSeconds?: number;
};

export type CanonicalEnvelope = {
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
};

export type LfoShape = "sine" | "triangle" | "sawUp" | "sawDown" | "square";
export type FilterMode = "lowpass" | "bandpass" | "highpass";
export type TonalWaveform = "sine" | "triangle" | "saw";

export type TonalOscillator = {
  waveform: TonalWaveform;
  transposeSemitones?: number;
  detuneCents?: number;
  level?: number;
};

export type PulseOscillator = {
  waveform: "pulse";
  transposeSemitones?: number;
  detuneCents?: number;
  pulseWidth?: number;
  level?: number;
};

export type NoiseOscillator = {
  waveform: "noise";
  level?: number;
};

export type Oscillator = TonalOscillator | PulseOscillator | NoiseOscillator;

export type CanonicalOscillator =
  | {
      waveform: TonalWaveform;
      transposeSemitones: number;
      detuneCents: number;
      level: number;
    }
  | {
      waveform: "pulse";
      transposeSemitones: number;
      detuneCents: number;
      pulseWidth: number;
      level: number;
    }
  | {
      waveform: "noise";
      level: number;
    };

export type CutoffLfo = {
  shape?: LfoShape;
  rateHz: number;
  amountOctaves: number;
};

export type CanonicalCutoffLfo = {
  shape: LfoShape;
  rateHz: number;
  amountOctaves: number;
};

export type SourceFilter = {
  mode?: FilterMode;
  cutoffHz: number;
  resonance?: number;
  cutoffLfo?: CutoffLfo;
};

export type CanonicalSourceFilter = {
  mode: FilterMode;
  cutoffHz: number;
  resonance: number;
  cutoffLfo: CanonicalCutoffLfo | null;
};

export type Saturator = {
  type: "saturator";
  driveDb: number;
  outputGainDb?: number;
  mix?: number;
};

export type StereoDelay = {
  type: "stereoDelay";
  timeSeconds: number;
  mix: number;
  feedback?: number;
  damping?: number;
  pingPong?: boolean;
};

export type Effect = Saturator | StereoDelay;

export type CanonicalSaturator = {
  type: "saturator";
  driveDb: number;
  outputGainDb: number;
  mix: number;
};

export type CanonicalStereoDelay = {
  type: "stereoDelay";
  timeSeconds: number;
  feedback: number;
  damping: number;
  pingPong: boolean;
  mix: number;
};

export type CanonicalEffect = CanonicalSaturator | CanonicalStereoDelay;

type OscillatorList =
  | [Oscillator]
  | [Oscillator, Oscillator]
  | [Oscillator, Oscillator, Oscillator]
  | [Oscillator, Oscillator, Oscillator, Oscillator];

type CanonicalOscillatorList =
  | [CanonicalOscillator]
  | [CanonicalOscillator, CanonicalOscillator]
  | [CanonicalOscillator, CanonicalOscillator, CanonicalOscillator]
  | [CanonicalOscillator, CanonicalOscillator, CanonicalOscillator, CanonicalOscillator];

export type Patch = {
  source: {
    frequencyHz: number;
    gainDb?: number;
    oscillators: OscillatorList;
    filter?: SourceFilter;
    ampEnvelope?: Envelope;
  };
  effects?: Effect[];
};

export type PatchProgramVoice = Readonly<{
  frequencyHz: number;
  gate: boolean;
}>;

export type PatchProgramContext = Readonly<{
  frame: number;
  fps: 60;
  timeSeconds: number;
  voice: PatchProgramVoice;
}>;

export type PatchProgram = (context: PatchProgramContext) => Patch;

/** Fully explicit canonical patch produced by validatePatch for internal use. */
export type CanonicalPatch = {
  source: {
    frequencyHz: number;
    gainDb: number;
    oscillators: CanonicalOscillatorList;
    filter: CanonicalSourceFilter | null;
    ampEnvelope: CanonicalEnvelope;
  };
  effects: CanonicalEffect[];
};
