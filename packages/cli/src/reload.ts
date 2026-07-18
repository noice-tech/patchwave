import type { LoadedPatch } from "./load-patch.js";

export type PatchEngine = {
  applyPatch(serializedPatch: string): void;
};

export type ReloadCoordinatorOptions = {
  initial: LoadedPatch;
  load: () => Promise<LoadedPatch>;
  engine: PatchEngine;
  onApplied: (patch: LoadedPatch) => void;
  onError: (error: unknown, retained: LoadedPatch) => void;
};

export class ReloadCoordinator {
  #current: LoadedPatch;
  #load: () => Promise<LoadedPatch>;
  #engine: PatchEngine;
  #onApplied: (patch: LoadedPatch) => void;
  #onError: (error: unknown, retained: LoadedPatch) => void;
  #running = false;
  #queued = false;
  #stopped = false;
  #idleWaiters: Array<() => void> = [];

  constructor(options: ReloadCoordinatorOptions) {
    this.#current = options.initial;
    this.#load = options.load;
    this.#engine = options.engine;
    this.#onApplied = options.onApplied;
    this.#onError = options.onError;
  }

  get current(): LoadedPatch {
    return this.#current;
  }

  queue(): void {
    if (this.#stopped) return;
    this.#queued = true;
    if (!this.#running) void this.#drain();
  }

  stop(): void {
    this.#stopped = true;
    this.#queued = false;
    if (!this.#running) this.#resolveIdle();
  }

  waitForIdle(): Promise<void> {
    if (!this.#running && !this.#queued) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.push(resolve));
  }

  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (this.#queued && !this.#stopped) {
        this.#queued = false;
        try {
          const candidate = await this.#load();
          if (this.#stopped) return;
          this.#engine.applyPatch(candidate.serialized);
          this.#current = candidate;
          this.#onApplied(candidate);
        } catch (error) {
          this.#onError(error, this.#current);
        }
      }
    } finally {
      this.#running = false;
      if (this.#queued && !this.#stopped) {
        void this.#drain();
      } else {
        this.#resolveIdle();
      }
    }
  }

  #resolveIdle(): void {
    const waiters = this.#idleWaiters;
    this.#idleWaiters = [];
    for (const resolve of waiters) resolve();
  }
}
