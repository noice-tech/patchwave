import { basename } from "node:path";
import {
  analyzeSource,
  applySourceEdit,
  parseSource,
  pathKey,
  type PatchEditOperation,
  type StudioDocumentPhase,
  type StudioDocumentSnapshot,
  type StudioEditInput,
  type StudioEditResult,
} from "@patchwave/studio";
import type { CanonicalPatch } from "./load-patch.js";
import {
  atomicReplaceSource,
  readWritableSource,
  sourceRevision,
  SourceConflictError,
} from "./source-file.js";
import { StudioHistory } from "./studio-history.js";

export type StudioDocumentControllerOptions = {
  path: string;
  getCanonical: () => CanonicalPatch;
  preview: (input: Extract<StudioEditInput, { type: "preview" }>) => boolean;
  cancelPreview: (gestureId?: string) => boolean;
  onChange: () => void;
};

export class StudioDocumentController {
  readonly #path: string;
  readonly #fileLabel: string;
  readonly #getCanonical: () => CanonicalPatch;
  readonly #preview: StudioDocumentControllerOptions["preview"];
  readonly #cancelPreview: StudioDocumentControllerOptions["cancelPreview"];
  readonly #onChange: () => void;
  readonly #history = new StudioHistory();
  #snapshot: StudioDocumentSnapshot;
  #queue: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #expectedOwnRevision: string | undefined;
  #activeGesture: string | undefined;
  #activePreviewPath: string | undefined;

  private constructor(options: StudioDocumentControllerOptions, snapshot: StudioDocumentSnapshot) {
    this.#path = options.path;
    this.#fileLabel = basename(options.path);
    this.#getCanonical = options.getCanonical;
    this.#preview = options.preview;
    this.#cancelPreview = options.cancelPreview;
    this.#onChange = options.onChange;
    this.#snapshot = snapshot;
  }

  static async create(options: StudioDocumentControllerOptions): Promise<StudioDocumentController> {
    let snapshot: StudioDocumentSnapshot;
    try {
      const source = await readWritableSource(options.path);
      const analysis = analyzeSource(
        parseSource(source.bytes.toString("utf8")),
        options.getCanonical(),
        basename(options.path),
      );
      snapshot = documentSnapshot(
        source.revision,
        analysis,
        basename(options.path),
        "ready",
        true,
        null,
        false,
        false,
      );
    } catch (error) {
      snapshot = {
        revision: sourceRevision(Buffer.alloc(0)),
        mode: "unknown",
        writable: false,
        fileLabel: basename(options.path),
        diagnostic: errorMessage(error),
        phase: "error",
        bindings: [],
        editableStructure: { oscillators: false, filter: false, cutoffLfo: false, effects: false },
        canUndo: false,
        canRedo: false,
      };
    }
    return new StudioDocumentController(options, snapshot);
  }

  snapshot(): StudioDocumentSnapshot {
    return this.#snapshot;
  }

  handle(input: StudioEditInput): Promise<StudioEditResult> {
    const generation = this.#generation;
    const run = async () => {
      if (generation !== this.#generation)
        return this.#result(input.requestId, "rejected", "Studio controller session ended");
      return this.#handle(input, generation);
    };
    const next = this.#queue.then(run, run);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async currentRevision(): Promise<string> {
    return (await readWritableSource(this.#path)).revision;
  }

  async drain(): Promise<void> {
    await this.#queue;
  }

  async refreshAfterReload(accepted: boolean, loadedRevision: string): Promise<boolean> {
    let matchesLoadedRevision = false;
    await this.#enqueue(async () => {
      try {
        const source = await readWritableSource(this.#path);
        matchesLoadedRevision = source.revision === loadedRevision;
        if (!matchesLoadedRevision) {
          const laterOwn = source.revision === this.#expectedOwnRevision;
          if (!laterOwn) {
            this.#history.clear();
            this.#expectedOwnRevision = undefined;
          }
          this.#activeGesture = undefined;
          this.#activePreviewPath = undefined;
          this.#cancelPreview();
          this.#snapshot = {
            ...this.#snapshot,
            revision: source.revision,
            phase: "reloading",
            diagnostic: "Source changed while audio was reloading; loading the newer revision.",
            canUndo: this.#history.canUndo,
            canRedo: this.#history.canRedo,
          };
          this.#onChange();
          return;
        }

        const own =
          source.revision === this.#expectedOwnRevision ||
          source.revision === this.#snapshot.revision;
        if (!own || !accepted) {
          if (!own) this.#history.clear();
        }
        this.#activeGesture = undefined;
        this.#activePreviewPath = undefined;
        this.#cancelPreview();
        this.#expectedOwnRevision = undefined;
        const analysis = analyzeSource(
          parseSource(source.bytes.toString("utf8")),
          this.#getCanonical(),
          this.#fileLabel,
        );
        this.#snapshot = documentSnapshot(
          source.revision,
          analysis,
          this.#fileLabel,
          accepted ? "audio-accepted" : "error",
          true,
          accepted ? null : "Source was saved, but audio rejected the reload.",
          this.#history.canUndo,
          this.#history.canRedo,
        );
      } catch (error) {
        this.#activeGesture = undefined;
        this.#activePreviewPath = undefined;
        this.#expectedOwnRevision = undefined;
        this.#history.clear();
        this.#cancelPreview();
        this.#snapshot = {
          ...this.#snapshot,
          writable: false,
          phase: "error",
          diagnostic: errorMessage(error),
          canUndo: false,
          canRedo: false,
        };
      }
      this.#onChange();
    });
    return matchesLoadedRevision;
  }

  markReloading(): void {
    this.#snapshot = { ...this.#snapshot, phase: "reloading" };
    this.#onChange();
  }

  cancelAllPreviews(): void {
    this.#generation += 1;
    this.#activeGesture = undefined;
    this.#activePreviewPath = undefined;
    this.#cancelPreview();
    if (this.#snapshot.phase === "previewing") {
      this.#snapshot = { ...this.#snapshot, phase: "ready" };
      this.#onChange();
    }
  }

  async #handle(input: StudioEditInput, generation: number): Promise<StudioEditResult> {
    try {
      if (input.type === "preview") return this.#previewInput(input);
      if (input.type === "cancelPreview") return this.#cancelInput(input);
      if (!this.#snapshot.writable)
        return this.#result(
          input.requestId,
          "rejected",
          this.#snapshot.diagnostic ?? "Source is read-only",
        );
      if (input.baseRevision !== this.#snapshot.revision) return this.#conflict(input.requestId);
      if (input.type === "commit") return await this.#commit(input, generation);
      return await this.#historyEdit(input, generation);
    } catch (error) {
      if (error instanceof SourceConflictError) return this.#conflict(input.requestId);
      this.#cancelPreview();
      this.#activeGesture = undefined;
      this.#activePreviewPath = undefined;
      this.#snapshot = { ...this.#snapshot, phase: "error", diagnostic: errorMessage(error) };
      this.#onChange();
      return this.#result(input.requestId, "rejected", errorMessage(error));
    }
  }

  #previewInput(input: Extract<StudioEditInput, { type: "preview" }>): StudioEditResult {
    if (!this.#snapshot.writable || input.baseRevision !== this.#snapshot.revision)
      return this.#conflict(input.requestId);
    const binding = this.#snapshot.bindings.find(
      (item) => pathKey(item.path) === pathKey(input.path),
    );
    if (!binding || binding.sourceForm.kind === "computed")
      return this.#result(input.requestId, "rejected", "This field is computed in code");
    if (this.#activeGesture && this.#activeGesture !== input.gestureId) {
      this.#cancelPreview(this.#activeGesture);
      this.#activeGesture = undefined;
      this.#activePreviewPath = undefined;
      this.#snapshot = { ...this.#snapshot, phase: "ready" };
    }
    if (!this.#preview(input)) {
      this.#onChange();
      return this.#result(input.requestId, "rejected", "Audio preview queue is busy");
    }
    this.#activeGesture = input.gestureId;
    this.#activePreviewPath = pathKey(input.path);
    this.#snapshot = { ...this.#snapshot, phase: "previewing" };
    this.#onChange();
    return this.#result(input.requestId, "previewed");
  }

  #cancelInput(input: Extract<StudioEditInput, { type: "cancelPreview" }>): StudioEditResult {
    if (this.#activeGesture !== input.gestureId) {
      return this.#result(input.requestId, "rejected", "That preview gesture is no longer active");
    }
    this.#cancelPreview(input.gestureId);
    this.#activeGesture = undefined;
    this.#activePreviewPath = undefined;
    this.#snapshot = { ...this.#snapshot, phase: "ready" };
    this.#onChange();
    return this.#result(input.requestId, "cancelled");
  }

  async #commit(
    input: Extract<StudioEditInput, { type: "commit" }>,
    generation: number,
  ): Promise<StudioEditResult> {
    if (
      this.#activeGesture &&
      (input.gestureId !== this.#activeGesture ||
        input.operation.type !== "setField" ||
        pathKey(input.operation.path) !== this.#activePreviewPath)
    ) {
      return this.#result(
        input.requestId,
        "rejected",
        "Finish or cancel the active parameter gesture first",
      );
    }
    this.#snapshot = { ...this.#snapshot, phase: "writing", diagnostic: null };
    this.#onChange();
    const before = await readWritableSource(this.#path);
    if (before.revision !== input.baseRevision) return this.#conflict(input.requestId);
    let output: string;
    try {
      output = applySourceEdit(
        before.bytes.toString("utf8"),
        this.#getCanonical(),
        this.#fileLabel,
        input.operation,
      );
    } catch (error) {
      if (errorMessage(error) !== "Edit did not change the source file") throw error;
      this.#cancelPreview(input.gestureId ?? undefined);
      this.#activeGesture = undefined;
      this.#activePreviewPath = undefined;
      this.#snapshot = { ...this.#snapshot, phase: "ready" };
      this.#onChange();
      return this.#result(input.requestId, "cancelled", "No source change was needed");
    }
    const afterBytes = Buffer.from(output);
    if (generation !== this.#generation) {
      this.#snapshot = { ...this.#snapshot, phase: "ready" };
      this.#onChange();
      return this.#result(input.requestId, "rejected", "Studio controller session ended");
    }
    const afterRevision = await atomicReplaceSource(this.#path, before.revision, afterBytes);
    this.#history.push({
      label: operationLabel(input.operation),
      before: before.bytes,
      beforeRevision: before.revision,
      after: afterBytes,
      afterRevision,
    });
    this.#expectedOwnRevision = afterRevision;
    this.#activeGesture = input.gestureId ?? undefined;
    this.#activePreviewPath =
      input.operation.type === "setField" ? pathKey(input.operation.path) : undefined;
    const analysis = analyzeSource(parseSource(output), this.#getCanonical(), this.#fileLabel);
    this.#snapshot = documentSnapshot(
      afterRevision,
      analysis,
      this.#fileLabel,
      "source-written",
      true,
      null,
      this.#history.canUndo,
      this.#history.canRedo,
    );
    this.#onChange();
    return this.#result(input.requestId, "committed");
  }

  async #historyEdit(
    input: Extract<StudioEditInput, { type: "undo" | "redo" }>,
    generation: number,
  ): Promise<StudioEditResult> {
    const undo = input.type === "undo";
    const entry = undo ? this.#history.peekUndo() : this.#history.peekRedo();
    if (!entry) return this.#result(input.requestId, "rejected", `Nothing to ${input.type}`);
    const expected = undo ? entry.afterRevision : entry.beforeRevision;
    const bytes = undo ? entry.before : entry.after;
    const current = await readWritableSource(this.#path);
    if (current.revision !== expected || input.baseRevision !== expected)
      return this.#conflict(input.requestId);
    if (generation !== this.#generation)
      return this.#result(input.requestId, "rejected", "Studio controller session ended");
    const revision = await atomicReplaceSource(this.#path, expected, bytes);
    if (undo) this.#history.didUndo();
    else this.#history.didRedo();
    this.#expectedOwnRevision = revision;
    this.#cancelPreview();
    this.#activeGesture = undefined;
    this.#activePreviewPath = undefined;
    const analysis = analyzeSource(
      parseSource(bytes.toString("utf8")),
      this.#getCanonical(),
      this.#fileLabel,
    );
    this.#snapshot = documentSnapshot(
      revision,
      analysis,
      this.#fileLabel,
      "source-written",
      true,
      null,
      this.#history.canUndo,
      this.#history.canRedo,
    );
    this.#onChange();
    return this.#result(input.requestId, "committed");
  }

  #conflict(requestId: string): StudioEditResult {
    this.#cancelPreview();
    this.#activeGesture = undefined;
    this.#activePreviewPath = undefined;
    this.#history.clear();
    this.#snapshot = {
      ...this.#snapshot,
      phase: "conflict",
      canUndo: false,
      canRedo: false,
      diagnostic: "The patch changed outside Studio. Refreshing from source.",
    };
    this.#onChange();
    return this.#result(requestId, "conflict", this.#snapshot.diagnostic ?? undefined);
  }

  #result(
    requestId: string,
    status: StudioEditResult["status"],
    message?: string,
  ): StudioEditResult {
    return {
      type: "editResult",
      protocol: 1,
      requestId,
      status,
      revision: this.#snapshot.revision,
      ...(message ? { message } : {}),
      document: this.#snapshot,
    };
  }

  #enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.#queue.then(task, task);
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function documentSnapshot(
  revision: string,
  analysis: ReturnType<typeof analyzeSource>,
  fileLabel: string,
  phase: StudioDocumentPhase,
  writable: boolean,
  diagnostic: string | null,
  canUndo: boolean,
  canRedo: boolean,
): StudioDocumentSnapshot {
  return {
    revision,
    mode: analysis.mode,
    writable: writable && analysis.mode !== "unknown",
    fileLabel,
    diagnostic: diagnostic ?? analysis.diagnostic,
    phase,
    bindings: analysis.bindings,
    editableStructure: analysis.editableStructure,
    canUndo,
    canRedo,
  };
}
function operationLabel(operation: PatchEditOperation): string {
  if (operation.type === "setField") return `Set ${operation.path.join(".")}`;
  if (operation.type === "resetField") return `Reset ${operation.path.join(".")}`;
  return operation.type.replace(/([A-Z])/g, " $1").toLowerCase();
}
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
