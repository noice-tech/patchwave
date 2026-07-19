const VOICE_QUEUE_MAX = 64;
const RETRY_MS = 2;

export type RuntimeAudioEngine = {
  tryApplyPatch(serializedPatch: string): boolean;
  tryApplyPatchAndNoteOn(serializedPatch: string): boolean;
  tryNoteOff(): boolean;
  start(): void;
  stop(): void;
  takeRuntimeError(): boolean;
};

type VoiceOperation = {
  type: "update" | "noteOn" | "noteOff";
  serialized?: string;
  onAccepted?: () => void;
  onCancelled?: () => void;
  status: "queued" | "accepted" | "cancelled";
};

export type NativeOperationHandle = {
  readonly pending: boolean;
  cancel(): boolean;
};

export type NativeDispatcherOptions = {
  engine: RuntimeAudioEngine;
  onError: (error: unknown) => void;
  onOverflow: () => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

export class NativeDispatcher {
  #engine: RuntimeAudioEngine;
  #onError: (error: unknown) => void;
  #onOverflow: () => void;
  #schedule: NonNullable<NativeDispatcherOptions["schedule"]>;
  #cancel: NonNullable<NativeDispatcherOptions["cancel"]>;
  #voiceQueue: VoiceOperation[] = [];
  #operations = new WeakMap<NativeOperationHandle, VoiceOperation>();
  #steady: VoiceOperation | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #stopped = false;

  constructor(options: NativeDispatcherOptions) {
    this.#engine = options.engine;
    this.#onError = options.onError;
    this.#onOverflow = options.onOverflow;
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancel = options.cancel ?? clearTimeout;
  }

  get pendingVoiceOperations(): number {
    return this.#voiceQueue.length;
  }

  enqueueUpdate(serialized: string, onAccepted?: () => void, onCancelled?: () => void): boolean {
    return this.enqueueUpdateOperation(serialized, onAccepted, onCancelled) !== undefined;
  }

  enqueueUpdateOperation(
    serialized: string,
    onAccepted?: () => void,
    onCancelled?: () => void,
  ): NativeOperationHandle | undefined {
    return this.#enqueue({
      type: "update",
      serialized,
      onAccepted,
      onCancelled,
      status: "queued",
    });
  }

  enqueueNoteOn(serialized: string, onAccepted?: () => void): boolean {
    return this.enqueueNoteOnOperation(serialized, onAccepted) !== undefined;
  }

  enqueueNoteOnOperation(
    serialized: string,
    onAccepted?: () => void,
    onCancelled?: () => void,
  ): NativeOperationHandle | undefined {
    return this.#enqueue({
      type: "noteOn",
      serialized,
      onAccepted,
      onCancelled,
      status: "queued",
    });
  }

  enqueueNoteOff(onAccepted?: () => void): boolean {
    return this.enqueueNoteOffOperation(onAccepted) !== undefined;
  }

  enqueueNoteOffOperation(
    onAccepted?: () => void,
    onCancelled?: () => void,
  ): NativeOperationHandle | undefined {
    return this.#enqueue({ type: "noteOff", onAccepted, onCancelled, status: "queued" });
  }

  cancelOperations(handles: Iterable<NativeOperationHandle>): number {
    const operations = new Set<VoiceOperation>();
    for (const handle of handles) {
      const operation = this.#operations.get(handle);
      if (operation?.status === "queued") operations.add(operation);
    }
    if (operations.size === 0) return 0;
    this.#voiceQueue = this.#voiceQueue.filter((operation) => !operations.has(operation));
    for (const operation of operations) operation.status = "cancelled";
    for (const operation of operations) operation.onCancelled?.();
    this.pump();
    return operations.size;
  }

  setSteadyPatch(serialized: string, onAccepted?: () => void): void {
    if (this.#stopped) return;
    this.#steady = { type: "update", serialized, onAccepted, status: "queued" };
    this.pump();
  }

  clearSteadyPatch(): void {
    this.#steady = undefined;
  }

  pump(): void {
    if (this.#stopped) return;
    if (this.#timer !== undefined) {
      this.#cancel(this.#timer);
      this.#timer = undefined;
    }
    try {
      while (this.#voiceQueue.length > 0) {
        const operation = this.#voiceQueue[0];
        if (!this.#try(operation)) {
          this.#retry();
          return;
        }
        this.#voiceQueue.shift();
        operation.status = "accepted";
        operation.onAccepted?.();
      }
      const steady = this.#steady;
      if (steady) {
        if (!this.#try(steady)) {
          this.#retry();
          return;
        }
        if (this.#steady === steady) this.#steady = undefined;
        steady.status = "accepted";
        steady.onAccepted?.();
      }
    } catch (error) {
      this.#onError(error);
    }
  }

  stop(): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
    const cancelled = this.#voiceQueue;
    this.#voiceQueue = [];
    this.#steady = undefined;
    for (const operation of cancelled) operation.status = "cancelled";
    for (const operation of cancelled) operation.onCancelled?.();
  }

  #enqueue(operation: VoiceOperation): NativeOperationHandle | undefined {
    if (this.#stopped) return undefined;
    this.#steady = undefined;
    if (this.#voiceQueue.length >= VOICE_QUEUE_MAX) {
      const cancelled = this.#voiceQueue;
      this.#voiceQueue = [];
      this.#steady = undefined;
      for (const pending of cancelled) pending.status = "cancelled";
      for (const pending of cancelled) pending.onCancelled?.();
      this.#onOverflow();
      return undefined;
    }
    const handle: NativeOperationHandle = {
      get pending() {
        return operation.status === "queued";
      },
      cancel: () => this.cancelOperations([handle]) === 1,
    };
    this.#operations.set(handle, operation);
    this.#voiceQueue.push(operation);
    this.pump();
    return handle;
  }

  #try(operation: VoiceOperation): boolean {
    switch (operation.type) {
      case "update":
        return this.#engine.tryApplyPatch(operation.serialized!);
      case "noteOn":
        return this.#engine.tryApplyPatchAndNoteOn(operation.serialized!);
      case "noteOff":
        return this.#engine.tryNoteOff();
    }
  }

  #retry(): void {
    if (this.#timer !== undefined || this.#stopped) return;
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.pump();
    }, RETRY_MS);
  }
}
