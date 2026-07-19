// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { StudioDocumentSnapshot } from "../../src/edit-types.js";
import { App } from "./main.js";

class MockWebSocket extends EventTarget {
  static OPEN = 1;
  static instances: MockWebSocket[] = [];
  readyState = MockWebSocket.OPEN;
  sent: unknown[] = [];
  constructor(_url: URL) {
    super();
    MockWebSocket.instances.push(this);
  }
  send(value: string) {
    this.sent.push(JSON.parse(value));
  }
  close() {
    this.readyState = 3;
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
  keyboard: { voice: { frequencyHz: 261.625, gate: true }, activeNoteLabel: "C3" },
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
  vi.unstubAllGlobals();
});

function mountStudio(initialState: unknown = state) {
  const view = render(<App />);
  const socket = MockWebSocket.instances[0];
  socket.dispatchEvent(new Event("open"));
  socket.message({ type: "state", state: initialState });
  return { ...view, socket };
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
  fireEvent.blur(window);
  expect(socket.sent.filter((message: any) => message.type === "cancelPreview")).toHaveLength(1);
  expect(socket.sent.filter((message: any) => message.type === "releaseAll")).toHaveLength(1);
});
