export function isEditingTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLSelectElement ||
    target instanceof HTMLButtonElement ||
    target instanceof HTMLTextAreaElement
  );
}

export function shouldHandlePerformanceKey(
  event: Pick<KeyboardEvent, "code" | "ctrlKey" | "metaKey" | "altKey" | "target">,
  mapped: ReadonlySet<string>,
): boolean {
  return (
    mapped.has(event.code) &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !isEditingTarget(event.target)
  );
}
