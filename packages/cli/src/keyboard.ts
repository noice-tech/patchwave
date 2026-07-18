export type KeyboardHandlers = {
  onToggle: () => void;
  onQuit: () => void;
};

export type KeyboardInput = {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode?: (enabled: boolean) => unknown;
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  resume(): unknown;
  pause(): unknown;
};

export function setupKeyboard(
  { onToggle, onQuit }: KeyboardHandlers,
  input: KeyboardInput = process.stdin,
): () => void {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    throw new Error("Interactive terminal input is required");
  }

  const wasRaw = input.isRaw ?? false;
  let cleanedUp = false;

  const handleData = (chunk: Buffer | string): void => {
    for (const character of chunk.toString()) {
      if (character === " ") {
        onToggle();
      } else if (
        character === "q" ||
        character === "Q" ||
        character === "\u0003"
      ) {
        onQuit();
        return;
      }
    }
  };

  input.setRawMode(true);
  input.on("data", handleData);
  input.resume();

  return () => {
    if (cleanedUp) return;
    cleanedUp = true;
    input.off("data", handleData);
    try {
      input.setRawMode?.(wasRaw);
    } finally {
      input.pause();
    }
  };
}
