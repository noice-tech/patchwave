// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { StudioDocumentSnapshot } from "../../src/edit-types.js";
import { App } from "./main.js";

class MockWebSocket extends EventTarget {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.CONNECTING;
  sent: unknown[] = [];
  throwOnSend = false;
  constructor(_url: URL) {
    super();
    MockWebSocket.instances.push(this);
  }
  send(value: string) {
    if (this.throwOnSend) throw new Error("send failed");
    this.sent.push(JSON.parse(value));
  }
  open() {
    this.readyState = MockWebSocket.OPEN;
    this.dispatchEvent(new Event("open"));
  }
  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) }));
  }
}

const revision = "a".repeat(64);
const documentSnapshot: StudioDocumentSnapshot = {
  revision,
  mode: "static",
  writable: true,
  fileLabel: "sound.ts",
  diagnostic: null,
  phase: "ready",
  bindings: [
    {
      path: ["source", "frequencyHz"],
      sourceForm: { kind: "literal", value: 110, explicit: true },
      location: { fileLabel: "sound.ts", line: 2, column: 20 },
      control: { label: "Frequency", kind: "number", min: 20, max: 20_000, step: 1, unit: "Hz" },
    },
  ],
  editableStructure: { oscillators: true, filter: true, cutoffLfo: false, effects: true },
  canUndo: false,
  canRedo: false,
};
const state = {
  patch: {
    source: {
      frequencyHz: 261.625,
      gainDb: -12,
      oscillators: [{ waveform: "saw", level: 1 }],
      filter: null,
      ampEnvelope: { attackSeconds: 0.005, decaySeconds: 0, sustain: 1, releaseSeconds: 0.1 },
    },
    effects: [],
  },
  keyboard: {
    baseNote: 60,
    octaveLabel: "C3",
    activeCode: "KeyA",
    activeNoteLabel: "C3",
    heldCodes: ["KeyA"],
    voice: { frequencyHz: 261.625, gate: true },
  },
  summary: "261.63 Hz; 1 oscillator; 0 effects",
  status: "Audio running",
  document: documentSnapshot,
};

beforeEach(() => {
  MockWebSocket.instances = [];
  vi.stubGlobal("WebSocket", MockWebSocket);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function mountStudio(initialState: unknown = state) {
  const view = render(<App />);
  const socket = MockWebSocket.instances.at(-1)!;
  socket.open();
  socket.message({ type: "state", state: initialState });
  return { ...view, socket };
}

function performanceEvent(
  target: EventTarget,
  type: "keydown" | "keyup",
  code: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    bubbles: true,
    cancelable: true,
    code,
    key: code.startsWith("Key") ? code.slice(3).toLowerCase() : code,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

function performanceMessages(socket: MockWebSocket): unknown[] {
  return socket.sent.filter((message: any) =>
    ["keyDown", "keyUp", "releaseAll"].includes(message.type),
  );
}

test("editable frequency uses authored source instead of performed keyboard pitch", async () => {
  mountStudio();
  const input = await screen.findByRole("spinbutton", { name: /Frequency/ });
  expect((input as HTMLInputElement).value).toBe("110");
  expect(screen.getByText(/261.63 Hz/)).toBeTruthy();
});

test("imperative pending guard prevents back-to-back stale structural commits", async () => {
  const { socket } = mountStudio();
  const addFilter = await screen.findByRole("button", { name: "+ Filter" });
  fireEvent.click(addFilter);
  fireEvent.click(addFilter);
  const commits = socket.sent.filter((message: any) => message.type === "commit");
  expect(commits).toHaveLength(1);
  expect((commits[0] as { baseRevision: string }).baseRevision).toBe(revision);
});

test("selection reconciles when a filter and its attached LFO disappear", async () => {
  const filterState: any = structuredClone(state);
  filterState.patch.source.filter = {
    mode: "lowpass",
    cutoffHz: 1200,
    resonance: 0.2,
    cutoffLfo: { shape: "sine", rateHz: 1, amountOctaves: 1 },
  };
  filterState.document.editableStructure.cutoffLfo = true;
  const { socket } = mountStudio(filterState);
  fireEvent.click(await screen.findByRole("button", { name: "Edit cutoff LFO" }));
  expect(screen.getByText("lfo")).toBeTruthy();
  socket.message({ type: "state", state });
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Edit Oscillator mix" }).getAttribute("aria-pressed"),
    ).toBe("true"),
  );
});

test("rack exposes the real serial stages and keeps the LFO attached to Filter", async () => {
  const filterState: any = structuredClone(state);
  filterState.patch.source.filter = {
    mode: "lowpass",
    cutoffHz: 1200,
    resonance: 0.2,
    cutoffLfo: { shape: "sine", rateHz: 1, amountOctaves: 1 },
  };
  mountStudio(filterState);
  await screen.findByRole("button", { name: "Edit Filter" });
  const stages = ["Oscillator mix", "Filter", "Envelope", "Safety"].map((name) =>
    screen.getByRole("button", { name: `Edit ${name}` }),
  );
  for (let index = 1; index < stages.length; index += 1) {
    expect(
      stages[index - 1].compareDocumentPosition(stages[index]) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  }
  expect(screen.queryByRole("button", { name: "Edit Cutoff LFO" })).toBeNull();
  expect(screen.getByRole("button", { name: "Edit cutoff LFO" })).toBeTruthy();
});

test("pointer cancellation sends one preview cancellation", async () => {
  const { socket } = mountStudio();
  const slider = await screen.findByRole("slider", { name: /Frequency/ });
  fireEvent.change(slider, { target: { value: "220" } });
  fireEvent.pointerCancel(slider);
  expect(socket.sent.filter((message: any) => message.type === "cancelPreview")).toHaveLength(1);
});

test("returning to the authored value cancels instead of committing", async () => {
  const { socket } = mountStudio();
  const slider = await screen.findByRole("slider", { name: /Frequency/ });
  fireEvent.change(slider, { target: { value: "220" } });
  fireEvent.change(slider, { target: { value: "110" } });
  fireEvent.pointerUp(slider);
  expect(socket.sent.filter((message: any) => message.type === "commit")).toHaveLength(0);
  expect(socket.sent.filter((message: any) => message.type === "cancelPreview")).toHaveLength(1);
});

test("window blur cancels an active gesture and releases performance keys", async () => {
  const { socket } = mountStudio();
  const slider = await screen.findByRole("slider", { name: /Frequency/ });
  fireEvent.change(slider, { target: { value: "220" } });
  performanceEvent(slider, "keydown", "KeyA");
  fireEvent.blur(window);
  expect(socket.sent.filter((message: any) => message.type === "cancelPreview")).toHaveLength(1);
  expect(performanceMessages(socket)).toEqual([
    { type: "keyDown", code: "KeyA" },
    { type: "releaseAll" },
  ]);
  const released = performanceEvent(slider, "keyup", "KeyA");
  expect(released.defaultPrevented).toBe(false);
});

test("mapped keys dominate focused number, range, select, button, and document targets", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const range = screen.getByRole("slider", { name: /Frequency/ });
  const button = screen.getByRole("button", { name: "+ Filter" });
  const targets: EventTarget[] = [number, range, button, document.body];
  const codes = ["KeyA", "KeyW", "KeyS", "KeyD", "KeyZ"];

  for (const [index, target] of targets.entries()) {
    const down = performanceEvent(target, "keydown", codes[index]);
    const up = performanceEvent(target, "keyup", codes[index]);
    expect(down.defaultPrevented, `${codes[index]} keydown on ${(target as Node).nodeName}`).toBe(
      true,
    );
    expect(up.defaultPrevented, `${codes[index]} keyup on ${(target as Node).nodeName}`).toBe(true);
  }
  fireEvent.click(screen.getByRole("button", { name: "Edit Oscillator 1" }));
  const select = screen.getByRole("combobox", { name: /Waveform/ });
  const selectDown = performanceEvent(select, "keydown", "KeyZ");
  const selectUp = performanceEvent(select, "keyup", "KeyZ");
  expect(selectDown.defaultPrevented).toBe(true);
  expect(selectUp.defaultPrevented).toBe(true);

  expect(performanceMessages(socket)).toEqual(
    codes.flatMap((code) => [
      { type: "keyDown", code },
      { type: "keyUp", code },
    ]),
  );
});

test("repeats stay captured without duplicate note-on and keyup follows ownership across focus", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const button = screen.getByRole("button", { name: "+ Filter" });
  const down = performanceEvent(number, "keydown", "KeyA");
  const repeat = performanceEvent(number, "keydown", "KeyA", {
    ctrlKey: true,
    repeat: true,
  });
  const up = performanceEvent(button, "keyup", "KeyA", { ctrlKey: true });
  expect([down.defaultPrevented, repeat.defaultPrevented, up.defaultPrevented]).toEqual([
    true,
    true,
    true,
  ]);
  expect(performanceMessages(socket)).toEqual([
    { type: "keyDown", code: "KeyA" },
    { type: "keyUp", code: "KeyA" },
  ]);
});

test("a first-seen repeat remains native and never sends a release", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const repeat = performanceEvent(number, "keydown", "KeyA", { repeat: true });
  const up = performanceEvent(number, "keyup", "KeyA");
  expect(repeat.defaultPrevented).toBe(false);
  expect(up.defaultPrevented).toBe(false);
  expect(performanceMessages(socket)).toEqual([]);
});

test("a failed initial keydown rolls back ownership and stays native", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  socket.throwOnSend = true;
  const down = performanceEvent(number, "keydown", "KeyA");
  const up = performanceEvent(number, "keyup", "KeyA");
  expect(down.defaultPrevented).toBe(false);
  expect(up.defaultPrevented).toBe(false);
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(performanceMessages(socket)).toEqual([]);
});

test("Ctrl, Meta, and Alt remain native while Shift still captures", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  for (const modifier of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
    const down = performanceEvent(number, "keydown", "KeyA", modifier);
    const up = performanceEvent(number, "keyup", "KeyA");
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
  }
  const shiftedDown = performanceEvent(number, "keydown", "KeyA", { shiftKey: true });
  const shiftedUp = performanceEvent(number, "keyup", "KeyA", { shiftKey: true });
  expect(shiftedDown.defaultPrevented).toBe(true);
  expect(shiftedUp.defaultPrevented).toBe(true);
  expect(performanceMessages(socket)).toEqual([
    { type: "keyDown", code: "KeyA" },
    { type: "keyUp", code: "KeyA" },
  ]);
});

test("non-performance editing keys and ordinary control blur stay native", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  for (const code of ["Digit1", "ArrowUp", "Enter", "Escape", "Tab"]) {
    const down = performanceEvent(number, "keydown", code);
    const up = performanceEvent(number, "keyup", code);
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
  }
  fireEvent.blur(number);
  expect(performanceMessages(socket)).toEqual([]);
});

test("visibility and pagehide release owned performance keys", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  performanceEvent(number, "keydown", "KeyA");
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  document.dispatchEvent(new Event("visibilitychange"));
  performanceEvent(number, "keydown", "KeyS");
  window.dispatchEvent(new Event("pagehide"));
  expect(performanceMessages(socket)).toEqual([
    { type: "keyDown", code: "KeyA" },
    { type: "releaseAll" },
    { type: "keyDown", code: "KeyS" },
    { type: "releaseAll" },
  ]);
});

test("socket close clears ownership and offline keys retain native behavior", async () => {
  const { socket } = mountStudio();
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  performanceEvent(number, "keydown", "KeyA");
  socket.close();
  const up = performanceEvent(number, "keyup", "KeyA");
  const offlineDown = performanceEvent(number, "keydown", "KeyS");
  expect(up.defaultPrevented).toBe(false);
  expect(offlineDown.defaultPrevented).toBe(false);
  expect(performanceMessages(socket)).toEqual([{ type: "keyDown", code: "KeyA" }]);
  expect(await screen.findByText("Offline", { exact: true })).toBeTruthy();
  await waitFor(() => expect(number.hasAttribute("disabled")).toBe(true));
  expect(screen.queryByLabelText("A note key, held")).toBeNull();
  expect(screen.getByLabelText("A note key").hasAttribute("data-held")).toBe(false);
  expect(screen.queryByText("C3", { exact: true })).toBeNull();
  expect(screen.getByText(/Octave — · — Hz · gate closed/)).toBeTruthy();
});

test("unmount best-effort releases before closing an open socket", () => {
  const { socket, unmount } = mountStudio();
  performanceEvent(document.body, "keydown", "KeyA");
  unmount();
  expect(performanceMessages(socket)).toEqual([
    { type: "keyDown", code: "KeyA" },
    { type: "releaseAll" },
  ]);
});

test("unmount still closes the socket when release transport throws", () => {
  const { socket, unmount } = mountStudio();
  socket.throwOnSend = true;
  expect(() => unmount()).not.toThrow();
  expect(socket.readyState).toBe(MockWebSocket.CLOSED);
  expect(performanceMessages(socket)).toEqual([]);
});

test("performance guidance exposes octave, modifiers, and held-key state", async () => {
  mountStudio();
  expect(await screen.findByText(/octave down Z/i)).toBeTruthy();
  expect(screen.getByText(/Cmd\/Ctrl\/Alt shortcuts stay native/i)).toBeTruthy();
  expect(screen.getByLabelText("A note key, held").getAttribute("data-held")).toBe("true");
  expect(screen.getByText(/Octave C3/)).toBeTruthy();
});

test("connecting, loading, and document phases use explanatory presentation", async () => {
  render(<App />);
  const socket = MockWebSocket.instances[0];
  expect(screen.getAllByText("Connecting", { exact: true }).length).toBeGreaterThan(0);
  socket.open();
  expect((await screen.findAllByText("Loading patch", { exact: true })).length).toBeGreaterThan(0);
  socket.message({ type: "state", state });

  const phases: Array<[StudioDocumentSnapshot["phase"], string]> = [
    ["ready", "Ready"],
    ["writing", "Saving"],
    ["previewing", "Previewing"],
    ["source-written", "Source saved"],
    ["reloading", "Reloading"],
    ["audio-accepted", "Audio updated"],
    ["conflict", "Source conflict"],
    ["error", "Update failed"],
  ];
  for (const [phase, label] of phases) {
    socket.message({
      type: "document",
      protocol: 1,
      document: { ...documentSnapshot, phase },
    });
    expect(await screen.findByText(label, { exact: true })).toBeTruthy();
  }
  expect(screen.queryByText("audio-accepted", { exact: true })).toBeNull();
});

test("a rejected edit remains visible while the document is ready", async () => {
  const { socket } = mountStudio();
  socket.message({
    type: "editResult",
    protocol: 1,
    requestId: "rejected-edit",
    status: "rejected",
    revision,
    message: "That value cannot be represented in source.",
    document: { ...documentSnapshot, phase: "ready" },
  });
  expect(await screen.findByText("Edit rejected", { exact: true })).toBeTruthy();
  expect(screen.getByText(/cannot be represented in source/i)).toBeTruthy();

  socket.message({
    type: "editResult",
    protocol: 1,
    requestId: "successful-preview",
    status: "previewed",
    revision,
    document: { ...documentSnapshot, phase: "ready" },
  });
  await waitFor(() => expect(screen.queryByText("Edit rejected", { exact: true })).toBeNull());
  expect(screen.getByText("Ready", { exact: true })).toBeTruthy();
});

test("computed controls reference their explanation", async () => {
  const computedState: any = structuredClone(state);
  computedState.document.bindings[0] = {
    ...computedState.document.bindings[0],
    sourceForm: {
      kind: "computed",
      reason: "expression",
      message: "Frequency comes from an expression.",
    },
  };
  mountStudio(computedState);
  const number = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const slider = screen.getByRole("slider", { name: /Frequency/ });
  expect(number.hasAttribute("disabled")).toBe(true);
  const helpId = number.getAttribute("aria-describedby");
  expect(helpId).toBeTruthy();
  expect(slider.getAttribute("aria-describedby")).toBe(helpId);
  expect(document.getElementById(helpId!)?.textContent).toContain(
    "Frequency comes from an expression.",
  );
});

test("read-only and conflict documents disable literal and structural edits", async () => {
  const readOnlyState: any = structuredClone(state);
  readOnlyState.document.writable = false;
  readOnlyState.document.diagnostic = "This source shape cannot be safely rewritten.";
  const readOnly = mountStudio(readOnlyState);
  const readOnlyNumber = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const readOnlyFilter = screen.getByRole("button", { name: "+ Filter" });
  expect(readOnlyNumber.hasAttribute("disabled")).toBe(true);
  expect(readOnlyFilter.hasAttribute("disabled")).toBe(true);
  fireEvent.click(readOnlyFilter);
  expect(readOnly.socket.sent.filter((message: any) => message.type === "commit")).toHaveLength(0);
  expect(await screen.findByText("Read-only source.", { exact: true })).toBeTruthy();
  expect(screen.getByText(/cannot be safely rewritten/i)).toBeTruthy();
  readOnly.unmount();

  const conflictState: any = structuredClone(state);
  conflictState.document.phase = "conflict";
  conflictState.document.diagnostic = "The patch changed outside Studio.";
  const conflict = mountStudio(conflictState);
  const conflictNumber = await screen.findByRole("spinbutton", { name: /Frequency/ });
  const conflictFilter = screen.getByRole("button", { name: "+ Filter" });
  expect(conflictNumber.hasAttribute("disabled")).toBe(true);
  expect(conflictFilter.hasAttribute("disabled")).toBe(true);
  fireEvent.click(conflictFilter);
  expect(conflict.socket.sent.filter((message: any) => message.type === "commit")).toHaveLength(0);
  expect(await screen.findByText("Source conflict", { exact: true })).toBeTruthy();
});
