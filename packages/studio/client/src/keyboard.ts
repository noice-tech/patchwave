export type PerformanceKeyEvent = Pick<
  KeyboardEvent,
  "altKey" | "code" | "ctrlKey" | "metaKey" | "repeat" | "shiftKey"
>;

export type PerformanceKeyDownResult = Readonly<{
  captured: boolean;
  send: boolean;
}>;

export class PerformanceKeyCapture {
  #owned = new Set<string>();

  keyDown(
    event: PerformanceKeyEvent,
    mapped: ReadonlySet<string>,
    connected: boolean,
  ): PerformanceKeyDownResult {
    if (this.#owned.has(event.code)) return { captured: true, send: false };
    if (
      event.repeat ||
      !connected ||
      !mapped.has(event.code) ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    ) {
      return { captured: false, send: false };
    }
    this.#owned.add(event.code);
    return { captured: true, send: true };
  }

  keyUp(code: string): boolean {
    return this.#owned.delete(code);
  }

  clear(): void {
    this.#owned.clear();
  }

  owns(code: string): boolean {
    return this.#owned.has(code);
  }
}
