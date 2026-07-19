import type { KeyboardAction, PatchFieldPath, PatchScalar } from "@patchwave/studio";
import type { PatchProgramContext, PatchProgramVoice } from "@patchwave/schema";
import { CONTROL_FPS, ControlClock, type ControlClockOptions } from "./control-clock.js";
import {
  evaluatePatchModule,
  loadedPatch,
  type CanonicalPatch,
  type LoadedPatch,
  type PatchModule,
} from "./load-patch.js";
import { NativeDispatcher, type NativeOperationHandle } from "./native-dispatcher.js";
import { applyPatchPreview, type PatchPreview } from "./patch-preview.js";

export type PatchRuntimeSnapshot = Readonly<{
  mode: "static" | "program";
  frame: number;
  timeSeconds: number;
  patch: CanonicalPatch;
  summary: string;
  status: string;
  error: string | null;
  backpressure: number;
}>;

export type PatchRuntimeOptions = {
  initialModule: PatchModule;
  initialVoice: PatchProgramVoice;
  dispatcher: NativeDispatcher;
  onState: () => void;
  onProgramError: (message: string) => void;
  clock?: Omit<ControlClockOptions, "onFrame">;
};

export class PatchRuntime {
  #module: PatchModule;
  #voice: PatchProgramVoice;
  #dispatcher: NativeDispatcher;
  #onState: () => void;
  #onProgramError: (message: string) => void;
  #clock: ControlClock;
  #loaded: LoadedPatch;
  #topology: string;
  #error: string | null = null;
  #staging = false;
  #stagedActions: KeyboardAction[] = [];
  #pendingReload:
    | { resolve: (accepted: boolean) => void; operation?: NativeOperationHandle }
    | undefined;
  #voiceOperations = new Set<NativeOperationHandle>();
  #preview: PatchPreview | undefined;
  #stopped = false;

  constructor(options: PatchRuntimeOptions) {
    this.#module = options.initialModule;
    this.#voice = frozenVoice(options.initialVoice);
    this.#dispatcher = options.dispatcher;
    this.#onState = options.onState;
    this.#onProgramError = options.onProgramError;
    this.#loaded = evaluatePatchModule(this.#module, context(0, this.#voice));
    this.#topology = topologyKey(this.#loaded.patch);
    this.#clock = new ControlClock({
      ...options.clock,
      onFrame: (frame) => this.#onFrame(frame),
    });
    this.#dispatcher.setSteadyPatch(this.#loaded.serialized);
  }

  start(): void {
    this.#clock.start();
    this.#onState();
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#clock.stop();
    this.#dispatcher.clearSteadyPatch();
    this.#preview = undefined;
    this.#cancelPendingReload();
    this.#dispatcher.cancelOperations(this.#voiceOperations);
    this.#voiceOperations.clear();
    this.#staging = false;
    this.#stagedActions = [];
  }

  snapshot(): PatchRuntimeSnapshot {
    const frame = this.#clock.frame();
    return Object.freeze({
      mode: this.#module.kind,
      frame,
      timeSeconds: frame / CONTROL_FPS,
      patch: this.#loaded.patch,
      summary: this.#loaded.summary,
      status: this.#staging ? "Applying hot reload…" : "Audio running",
      error: this.#error,
      backpressure: this.#dispatcher.pendingVoiceOperations,
    });
  }

  previewField(
    gestureId: string,
    baseRevision: string,
    path: PatchFieldPath,
    value: PatchScalar,
  ): boolean {
    if (this.#stopped || this.#staging) return false;
    const previous = this.#preview;
    this.#preview = Object.freeze({ gestureId, baseRevision, path, value });
    const candidate = this.#currentCandidate(this.#clock.frame());
    if (!candidate) {
      this.#preview = previous;
      return false;
    }
    this.#dispatcher.setSteadyPatch(candidate.serialized, () => this.#accept(candidate));
    this.#onState();
    return true;
  }

  cancelPreview(gestureId?: string): boolean {
    if (!this.#preview || (gestureId && this.#preview.gestureId !== gestureId)) return true;
    this.#preview = undefined;
    if (this.#stopped || this.#staging) return true;
    const candidate = this.#currentCandidate(this.#clock.frame());
    if (!candidate) return false;
    this.#dispatcher.setSteadyPatch(candidate.serialized, () => this.#accept(candidate));
    this.#onState();
    return true;
  }

  handleKeyboard(action: KeyboardAction): boolean {
    if (this.#stopped) return false;
    if (this.#staging) {
      if (this.#stagedActions.length >= 64) return false;
      this.#stagedActions.push(action);
      return true;
    }
    this.#voice = frozenVoice(action.snapshot.voice);
    if (action.type === "none") {
      this.#onState();
      return true;
    }
    if (action.type === "noteOff") {
      if (this.#module.kind === "program") {
        const candidate = this.#evaluate(this.#clock.frame(), this.#module, this.#topology);
        if (
          candidate &&
          !this.#enqueueUpdate(candidate.serialized, () => this.#accept(candidate))
        ) {
          return false;
        }
      }
      const accepted = this.#enqueueNoteOff(() => this.#onState());
      if (!accepted) return false;
      this.#onState();
      return true;
    }

    const candidate = this.#currentCandidate(this.#clock.frame());
    if (!candidate) return false;
    const accepted =
      action.type === "noteOn"
        ? this.#enqueueNoteOn(candidate.serialized, () => this.#accept(candidate))
        : this.#enqueueUpdate(candidate.serialized, () => this.#accept(candidate));
    if (!accepted) return false;
    this.#onState();
    return true;
  }

  releaseVoice(): void {
    if (this.#stopped) return;
    this.#voice = frozenVoice({ frequencyHz: this.#voice.frequencyHz, gate: false });
    this.#dispatcher.clearSteadyPatch();
    this.#preview = undefined;

    const reload = this.#pendingReload;
    this.#pendingReload = undefined;
    this.#staging = false;
    this.#stagedActions = [];
    const cancelled = [...this.#voiceOperations];
    if (reload?.operation) cancelled.push(reload.operation);
    this.#dispatcher.cancelOperations(cancelled);
    this.#voiceOperations.clear();
    reload?.resolve(false);

    // Safety release always remains first. The source-derived parameter image follows it
    // without reopening the gate, so a disconnected static preview cannot linger.
    this.#enqueueNoteOff(() => this.#onState());
    const source = this.#currentCandidate(this.#clock.frame());
    if (source) this.#dispatcher.setSteadyPatch(source.serialized, () => this.#accept(source));
    this.#onState();
  }

  stageReload(module: PatchModule): Promise<boolean> {
    if (this.#stopped || this.#staging) return Promise.resolve(false);
    let candidate: LoadedPatch;
    try {
      candidate = evaluatePatchModule(module, context(this.#clock.frame(), this.#voice));
    } catch (error) {
      this.#fail(error);
      return Promise.resolve(false);
    }
    try {
      candidate = applyPatchPreview(candidate.patch, this.#preview);
    } catch (error) {
      if (!this.#preview) {
        this.#fail(error);
        return Promise.resolve(false);
      }
      // The source may validly remove the field currently being previewed. A stale
      // authoring overlay must never veto that otherwise valid reload.
      this.#preview = undefined;
      candidate = evaluatePatchModule(module, context(this.#clock.frame(), this.#voice));
    }
    if (module.kind === "static" && this.#voice.gate) {
      candidate = staticAtFrequency(candidate.patch, this.#voice.frequencyHz);
    }
    this.#staging = true;
    this.#dispatcher.clearSteadyPatch();
    return new Promise((resolve) => {
      const pending: { resolve: (accepted: boolean) => void; operation?: NativeOperationHandle } = {
        resolve,
      };
      this.#pendingReload = pending;
      const operation = this.#dispatcher.enqueueUpdateOperation(
        candidate.serialized,
        () => {
          if (this.#stopped || this.#pendingReload !== pending) return;
          this.#pendingReload = undefined;
          this.#module = module;
          this.#topology = topologyKey(candidate.patch);
          this.#loaded = candidate;
          this.#staging = false;
          this.#clearError();
          const stagedActions = this.#stagedActions;
          this.#stagedActions = [];
          for (const action of stagedActions) {
            if (!this.handleKeyboard(action)) {
              this.#fail(new Error("Voice event queue overflowed after hot reload"));
              break;
            }
          }
          this.#onState();
          resolve(true);
        },
        () => {
          if (this.#pendingReload !== pending) return;
          this.#pendingReload = undefined;
          this.#staging = false;
          this.#stagedActions = [];
          this.#onState();
          resolve(false);
        },
      );
      if (this.#pendingReload === pending) pending.operation = operation;
      if (!operation && this.#pendingReload === pending) {
        this.#pendingReload = undefined;
        this.#staging = false;
        const stagedActions = this.#stagedActions;
        this.#stagedActions = [];
        for (const action of stagedActions) this.handleKeyboard(action);
        this.#fail(new Error("Voice event queue overflowed during hot reload"));
        resolve(false);
      }
      this.#onState();
    });
  }

  #cancelPendingReload(): void {
    const pending = this.#pendingReload;
    if (!pending) return;
    this.#pendingReload = undefined;
    if (pending.operation) this.#dispatcher.cancelOperations([pending.operation]);
    pending.resolve(false);
  }

  #enqueueUpdate(serialized: string, onAccepted?: () => void): boolean {
    return this.#trackVoiceOperation(
      (accepted, cancelled) =>
        this.#dispatcher.enqueueUpdateOperation(serialized, accepted, cancelled),
      onAccepted,
    );
  }

  #enqueueNoteOn(serialized: string, onAccepted?: () => void): boolean {
    return this.#trackVoiceOperation(
      (accepted, cancelled) =>
        this.#dispatcher.enqueueNoteOnOperation(serialized, accepted, cancelled),
      onAccepted,
    );
  }

  #enqueueNoteOff(onAccepted?: () => void): boolean {
    return this.#trackVoiceOperation(
      (accepted, cancelled) => this.#dispatcher.enqueueNoteOffOperation(accepted, cancelled),
      onAccepted,
    );
  }

  #trackVoiceOperation(
    enqueue: (accepted: () => void, cancelled: () => void) => NativeOperationHandle | undefined,
    onAccepted?: () => void,
  ): boolean {
    let operation: NativeOperationHandle | undefined;
    const forget = (): void => {
      if (operation) this.#voiceOperations.delete(operation);
    };
    operation = enqueue(() => {
      forget();
      onAccepted?.();
    }, forget);
    if (!operation) return false;
    if (operation.pending) this.#voiceOperations.add(operation);
    return true;
  }

  #onFrame(frame: number): void {
    if (this.#stopped || this.#staging) return;
    if (this.#module.kind === "program") {
      const candidate = this.#evaluate(frame, this.#module, this.#topology);
      if (candidate) {
        this.#dispatcher.setSteadyPatch(candidate.serialized, () => this.#accept(candidate));
      }
    }
    this.#onState();
  }

  #evaluate(frame: number, module: PatchModule, expectedTopology: string): LoadedPatch | undefined {
    try {
      let candidate = evaluatePatchModule(module, context(frame, this.#voice));
      if (topologyKey(candidate.patch) !== expectedTopology) {
        throw new Error(
          "PatchProgram changed structure; oscillator count, effect count, and ordered effect kinds must remain stable",
        );
      }
      candidate = applyPatchPreview(candidate.patch, this.#preview);
      this.#clearError();
      return candidate;
    } catch (error) {
      this.#fail(error);
      return undefined;
    }
  }

  #currentCandidate(frame: number): LoadedPatch | undefined {
    if (this.#module.kind === "program") return this.#evaluate(frame, this.#module, this.#topology);
    try {
      let candidate = applyPatchPreview(this.#module.patch, this.#preview);
      if (this.#voice.gate) candidate = staticAtFrequency(candidate.patch, this.#voice.frequencyHz);
      this.#clearError();
      return candidate;
    } catch (error) {
      this.#fail(error);
      return undefined;
    }
  }

  #accept(candidate: LoadedPatch): void {
    this.#loaded = candidate;
    this.#clearError();
    this.#onState();
  }

  #fail(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    if (message !== this.#error) this.#onProgramError(message);
    this.#error = message;
    this.#onState();
  }

  #clearError(): void {
    this.#error = null;
  }
}

function context(frame: number, voice: PatchProgramVoice): PatchProgramContext {
  return Object.freeze({
    frame,
    fps: CONTROL_FPS,
    timeSeconds: frame / CONTROL_FPS,
    voice: frozenVoice(voice),
  });
}

function frozenVoice(voice: PatchProgramVoice): PatchProgramVoice {
  return Object.freeze({ frequencyHz: voice.frequencyHz, gate: voice.gate });
}

function topologyKey(patch: CanonicalPatch): string {
  return `${patch.source.oscillators.length}|${patch.effects.map((effect) => effect.type).join("|")}`;
}

function staticAtFrequency(patch: CanonicalPatch, frequencyHz: number): LoadedPatch {
  const performed = structuredClone(patch);
  performed.source.frequencyHz = frequencyHz;
  return loadedPatch(performed);
}
