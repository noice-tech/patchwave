export {
  KeyboardState,
  NOTE_CODES,
  noteFrequency,
  noteLabel,
  type KeyboardAction,
  type KeyboardSnapshot,
  type VoiceSnapshot,
} from "./keyboard-state.js";
export type {
  ComputedReason,
  EffectType,
  OscillatorWaveform,
  PatchEditOperation,
  PatchFieldPath,
  PatchScalar,
  SourceBinding,
  SourceForm,
  SourceLocation,
  StudioDocumentPhase,
  StudioDocumentSnapshot,
} from "./edit-types.js";
export {
  STUDIO_PROTOCOL_VERSION,
  type StudioEditInput,
  type StudioEditResult,
  type StudioInput,
  type StudioKeyboardInput,
  type StudioServerMessage,
} from "./protocol.js";
export { parseStudioInput } from "./protocol-validate.js";
export {
  analyzeSource,
  applySourceEdit,
  parseSource,
  pathKey,
  printSource,
  type InternalAnalysis,
  type SourceAnalysis,
} from "./source/index.js";
export { startStudioServer, type StudioServer, type StudioServerOptions } from "./server.js";
