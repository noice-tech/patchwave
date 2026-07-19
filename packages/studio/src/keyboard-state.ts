export const NOTE_CODES = Object.freeze({
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
} satisfies Record<string, number>);

const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
const BASE_MIN = 0;
const BASE_MAX = 108;
const DEFAULT_BASE = 60;

export type VoiceSnapshot = Readonly<{
  frequencyHz: number;
  gate: boolean;
}>;

export type KeyboardSnapshot = Readonly<{
  baseNote: number;
  octaveLabel: string;
  activeCode: string | null;
  activeNoteLabel: string;
  heldCodes: readonly string[];
  voice: VoiceSnapshot;
}>;

export type KeyboardAction = Readonly<{
  type: "none" | "noteOn" | "pitch" | "noteOff";
  snapshot: KeyboardSnapshot;
}>;

type HeldNote = { code: string; note: number };

export class KeyboardState {
  #baseNote = DEFAULT_BASE;
  #held: HeldNote[] = [];
  #controlHeld = new Set<string>();
  #frequencyHz = noteFrequency(DEFAULT_BASE);
  #gate = false;

  keyDown(code: string): KeyboardAction {
    if (code === "KeyZ" || code === "KeyX") {
      if (this.#controlHeld.has(code)) return this.#action("none");
      this.#controlHeld.add(code);
      const delta = code === "KeyZ" ? -12 : 12;
      this.#baseNote = clamp(this.#baseNote + delta, BASE_MIN, BASE_MAX);
      return this.#action("none");
    }
    const offset = NOTE_CODES[code as keyof typeof NOTE_CODES];
    if (offset === undefined || this.#held.some((held) => held.code === code)) {
      return this.#action("none");
    }
    const note = this.#baseNote + offset;
    this.#held.push({ code, note });
    this.#frequencyHz = noteFrequency(note);
    this.#gate = true;
    return this.#action("noteOn");
  }

  keyUp(code: string): KeyboardAction {
    if (code === "KeyZ" || code === "KeyX") {
      this.#controlHeld.delete(code);
      return this.#action("none");
    }
    const index = this.#held.findIndex((held) => held.code === code);
    if (index === -1) return this.#action("none");
    const wasActive = index === this.#held.length - 1;
    this.#held.splice(index, 1);
    if (!wasActive) return this.#action("none");
    const fallback = this.#held.at(-1);
    if (fallback) {
      this.#frequencyHz = noteFrequency(fallback.note);
      return this.#action("pitch");
    }
    this.#gate = false;
    return this.#action("noteOff");
  }

  releaseAll(): KeyboardAction {
    const wasGated = this.#gate;
    this.#held = [];
    this.#controlHeld.clear();
    this.#gate = false;
    return this.#action(wasGated ? "noteOff" : "none");
  }

  snapshot(): KeyboardSnapshot {
    const active = this.#held.at(-1);
    return Object.freeze({
      baseNote: this.#baseNote,
      octaveLabel: noteLabel(this.#baseNote),
      activeCode: active?.code ?? null,
      activeNoteLabel: active ? noteLabel(active.note) : "—",
      heldCodes: Object.freeze(this.#held.map((held) => held.code)),
      voice: Object.freeze({ frequencyHz: this.#frequencyHz, gate: this.#gate }),
    });
  }

  #action(type: KeyboardAction["type"]): KeyboardAction {
    return Object.freeze({ type, snapshot: this.snapshot() });
  }
}

export function noteFrequency(note: number): number {
  return 440 * 2 ** ((note - 69) / 12);
}

export function noteLabel(note: number): string {
  return `${NOTE_NAMES[note % 12]}${Math.floor(note / 12) - 2}`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
