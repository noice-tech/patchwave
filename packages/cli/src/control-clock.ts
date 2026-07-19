export const CONTROL_FPS = 60 as const;
const CONTROL_INTERVAL_MS = 1_000 / CONTROL_FPS;

export type ControlClockOptions = {
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
  onFrame: (frame: number) => void;
};

export class ControlClock {
  #now: () => number;
  #schedule: NonNullable<ControlClockOptions["schedule"]>;
  #cancel: NonNullable<ControlClockOptions["cancel"]>;
  #onFrame: (frame: number) => void;
  #epochMs = 0;
  #lastEmittedFrame = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #running = false;

  constructor(options: ControlClockOptions) {
    this.#now = options.now ?? performance.now.bind(performance);
    this.#schedule = options.schedule ?? setTimeout;
    this.#cancel = options.cancel ?? clearTimeout;
    this.#onFrame = options.onFrame;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#epochMs = this.#now();
    this.#lastEmittedFrame = 0;
    this.#arm();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== undefined) this.#cancel(this.#timer);
    this.#timer = undefined;
  }

  frame(): number {
    if (!this.#running) return this.#lastEmittedFrame;
    return Math.max(0, Math.floor((this.#now() - this.#epochMs) / CONTROL_INTERVAL_MS));
  }

  pulse(): void {
    if (!this.#running) return;
    const frame = this.frame();
    if (frame > this.#lastEmittedFrame) {
      this.#lastEmittedFrame = frame;
      this.#onFrame(frame);
    }
  }

  #arm(): void {
    if (!this.#running) return;
    const nextFrame = this.#lastEmittedFrame + 1;
    const target = this.#epochMs + nextFrame * CONTROL_INTERVAL_MS;
    const delay = Math.max(0, target - this.#now());
    this.#timer = this.#schedule(() => {
      this.#timer = undefined;
      this.pulse();
      this.#arm();
    }, delay);
  }
}
