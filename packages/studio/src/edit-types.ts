import type { PatchEditorControl } from "@patchwave/schema";

export type PatchFieldPath =
  | readonly ["source", "frequencyHz" | "gainDb"]
  | readonly [
      "source",
      "oscillators",
      number,
      "transposeSemitones" | "detuneCents" | "pulseWidth" | "level",
    ]
  | readonly ["source", "filter", "mode" | "cutoffHz" | "resonance"]
  | readonly ["source", "filter", "cutoffLfo", "shape" | "rateHz" | "amountOctaves"]
  | readonly [
      "source",
      "ampEnvelope",
      "attackSeconds" | "decaySeconds" | "sustain" | "releaseSeconds",
    ]
  | readonly [
      "effects",
      number,
      "driveDb" | "outputGainDb" | "mix" | "timeSeconds" | "feedback" | "damping" | "pingPong",
    ];

export type PatchScalar = number | string | boolean;
export type OscillatorWaveform = "sine" | "triangle" | "saw" | "pulse" | "noise";
export type EffectType = "saturator" | "stereoDelay";

export type PatchEditOperation =
  | Readonly<{ type: "setField"; path: PatchFieldPath; value: PatchScalar }>
  | Readonly<{ type: "resetField"; path: PatchFieldPath }>
  | Readonly<{ type: "addOscillator"; index: number; waveform: OscillatorWaveform }>
  | Readonly<{ type: "removeOscillator"; index: number }>
  | Readonly<{ type: "moveOscillator"; from: number; to: number }>
  | Readonly<{ type: "replaceOscillator"; index: number; waveform: OscillatorWaveform }>
  | Readonly<{ type: "addFilter" }>
  | Readonly<{ type: "removeFilter" }>
  | Readonly<{ type: "addCutoffLfo" }>
  | Readonly<{ type: "removeCutoffLfo" }>
  | Readonly<{ type: "addEffect"; index: number; effectType: EffectType }>
  | Readonly<{ type: "removeEffect"; index: number }>
  | Readonly<{ type: "moveEffect"; from: number; to: number }>
  | Readonly<{ type: "replaceEffect"; index: number; effectType: EffectType }>;

export type ComputedReason =
  | "unsupported-export"
  | "export-indirection"
  | "multiple-returns"
  | "spread-container"
  | "computed-key"
  | "duplicate-key"
  | "expression"
  | "dynamic-discriminant"
  | "dynamic-array";

export type SourceLocation = Readonly<{ fileLabel: string; line: number; column: number }>;

export type SourceForm =
  | Readonly<{ kind: "literal"; value: PatchScalar; explicit: true }>
  | Readonly<{ kind: "default"; value: PatchScalar; explicit: false }>
  | Readonly<{ kind: "computed"; reason: ComputedReason; message: string }>;

export type SourceBinding = Readonly<{
  path: PatchFieldPath;
  sourceForm: SourceForm;
  location: SourceLocation | null;
  control: PatchEditorControl;
}>;

export type StudioDocumentPhase =
  | "ready"
  | "previewing"
  | "writing"
  | "source-written"
  | "reloading"
  | "audio-accepted"
  | "conflict"
  | "error";

export type StudioDocumentSnapshot = Readonly<{
  revision: string;
  mode: "static" | "program" | "unknown";
  writable: boolean;
  fileLabel: string;
  diagnostic: string | null;
  phase: StudioDocumentPhase;
  bindings: readonly SourceBinding[];
  editableStructure: Readonly<{
    oscillators: boolean;
    filter: boolean;
    cutoffLfo: boolean;
    effects: boolean;
  }>;
  canUndo: boolean;
  canRedo: boolean;
}>;
