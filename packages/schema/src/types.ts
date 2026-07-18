export type Envelope = {
  attackSeconds: number;
  decaySeconds: number;
  sustain: number;
  releaseSeconds: number;
};

export type Saturator = {
  id: string;
  type: "saturator";
  enabled: boolean;
  driveDb: number;
  outputGainDb: number;
  mix: number;
};

export type StereoDelay = {
  id: string;
  type: "stereoDelay";
  enabled: boolean;
  timeMs: number;
  feedback: number;
  damping: number;
  pingPong: boolean;
  mix: number;
};

export type AudioProcessor = Saturator | StereoDelay;
export type AudioProcessorV2 = AudioProcessor;
export type TonalWaveform = "sine" | "triangle" | "saw";
export type FilterMode = "lowpass" | "bandpass" | "highpass";

export type Sends = { filter: number; insert: number; direct: number };
export type OscillatorV2 =
  | {
      id: string;
      waveform: TonalWaveform;
      octave: number;
      semitone: number;
      detuneCents: number;
      level: number;
      sends: Sends;
    }
  | {
      id: string;
      waveform: "pulse";
      octave: number;
      semitone: number;
      detuneCents: number;
      pulseWidth: number;
      level: number;
      sends: Sends;
    }
  | { id: string; waveform: "noise"; level: number; sends: Sends };

export type SynthFilterV2 = {
  enabled: boolean;
  mode: FilterMode;
  cutoffHz: number;
  resonance: number;
  sends: { insert: number; direct: number };
};

export type SubtractiveSynthV2 = {
  id: string;
  type: "subtractiveSynth";
  enabled: boolean;
  baseFrequencyHz: number;
  outputGain: number;
  oscillators:
    | [OscillatorV2]
    | [OscillatorV2, OscillatorV2]
    | [OscillatorV2, OscillatorV2, OscillatorV2]
    | [OscillatorV2, OscillatorV2, OscillatorV2, OscillatorV2];
  ampEnvelope: Envelope;
  filter: SynthFilterV2;
  audioRateRoutes: [] | [PhaseModulationRouteV2];
};

export type LfoModulatorV2 = {
  id: string;
  type: "lfo";
  enabled: boolean;
  shape: "sine" | "triangle" | "sawUp" | "sawDown" | "square";
  polarity: "unipolar" | "bipolar";
  rate:
    | { mode: "hz"; frequencyHz: number }
    | { mode: "sync"; division: "1/1" | "1/2" | "1/4" | "1/8" | "1/16" };
  phaseMode: "free" | "gateReset";
  phaseOffset: number;
};

export type EnvelopeModulatorV2 = { id: string; type: "envelope"; enabled: boolean } & Envelope;
export type ModulatorV2 = LfoModulatorV2 | EnvelopeModulatorV2;

export type ModulationRouteV2 =
  | { source: string; target: { type: "filterCutoff"; device: string }; amountOctaves: number }
  | {
      source: string;
      target: { type: "oscillatorPitch"; device: string; oscillator: string };
      amountSemitones: number;
    }
  | {
      source: string;
      target: { type: "pulseWidth"; device: string; oscillator: string };
      amount: number;
    }
  | {
      source: string;
      target: { type: "oscillatorLevel"; device: string; oscillator: string };
      amount: number;
    }
  | { source: string; target: { type: "sourceGain"; device: string }; amountDb: number };

export type PhaseModulationRouteV2 = {
  type: "phaseModulation";
  source: string;
  target: string;
  indexRadians: number;
};

export type PatchV2 = {
  tempoBpm: number;
  modulators: ModulatorV2[];
  modulationRoutes: ModulationRouteV2[];
  devices: [SubtractiveSynthV2, ...AudioProcessorV2[]];
};

export type Patch = PatchV2;
