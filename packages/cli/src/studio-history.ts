export type StudioHistoryEntry = Readonly<{
  label: string;
  before: Buffer;
  beforeRevision: string;
  after: Buffer;
  afterRevision: string;
}>;

export class StudioHistory {
  #undo: StudioHistoryEntry[] = [];
  #redo: StudioHistoryEntry[] = [];

  get canUndo(): boolean {
    return this.#undo.length > 0;
  }
  get canRedo(): boolean {
    return this.#redo.length > 0;
  }
  push(entry: StudioHistoryEntry): void {
    this.#undo.push(entry);
    if (this.#undo.length > 100) this.#undo.shift();
    this.#redo = [];
  }
  peekUndo(): StudioHistoryEntry | undefined {
    return this.#undo.at(-1);
  }
  peekRedo(): StudioHistoryEntry | undefined {
    return this.#redo.at(-1);
  }
  didUndo(): void {
    const entry = this.#undo.pop();
    if (entry) this.#redo.push(entry);
  }
  didRedo(): void {
    const entry = this.#redo.pop();
    if (entry) this.#undo.push(entry);
  }
  clear(): void {
    this.#undo = [];
    this.#redo = [];
  }
}
