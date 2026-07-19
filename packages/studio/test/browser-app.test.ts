import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

class FakeElement {
  textContent = "";
  className = "";
  dataset: Record<string, string> = {};
  children: FakeElement[] = [];
  classList = {
    add: (..._names: string[]) => undefined,
    remove: (..._names: string[]) => undefined,
    toggle: (..._values: unknown[]) => false,
  };
  append(...children: FakeElement[]): void {
    this.children.push(...children);
  }
  replaceChildren(...children: FakeElement[]): void {
    this.children = children;
  }
}

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: unknown[] = [];
  listeners = new Map<string, (event?: any) => void>();

  constructor(_url: URL) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: (event?: any) => void): void {
    this.listeners.set(type, listener);
  }
  send(serialized: string): void {
    this.sent.push(JSON.parse(serialized));
  }
  close(): void {}
  emit(type: string, event?: any): void {
    this.listeners.get(type)?.(event);
  }
}

test("browser shortcuts do not play mapped notes while keyup and pagehide still release", async () => {
  FakeWebSocket.instances = [];
  const elements = new Map<string, FakeElement>();
  const windowListeners = new Map<string, (event: any) => void>();
  const documentListeners = new Map<string, (event: any) => void>();
  const timers = new Map<number, () => void>();
  const clearedTimers: number[] = [];
  let nextTimer = 1;
  const body = new FakeElement();
  const document = {
    body,
    hidden: false,
    querySelector(selector: string) {
      let element = elements.get(selector);
      if (!element) {
        element = new FakeElement();
        elements.set(selector, element);
      }
      return element;
    },
    createElement: () => new FakeElement(),
    addEventListener(type: string, listener: (event: any) => void) {
      documentListeners.set(type, listener);
    },
  };
  const window = {
    location: { href: "http://127.0.0.1:1234/session/token/" },
    addEventListener(type: string, listener: (event: any) => void) {
      windowListeners.set(type, listener);
    },
  };
  const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
  runInNewContext(source, {
    URL,
    WebSocket: FakeWebSocket,
    clearTimeout(timer: number) {
      timers.delete(timer);
      clearedTimers.push(timer);
    },
    console,
    document,
    setTimeout(callback: () => void) {
      const timer = nextTimer++;
      timers.set(timer, callback);
      return timer;
    },
    window,
  });

  const socket = FakeWebSocket.instances[0];
  let prevented = 0;
  windowListeners.get("keydown")!({
    code: "KeyA",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    repeat: false,
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.deepEqual(socket.sent, []);
  assert.equal(prevented, 0);

  windowListeners.get("keydown")!({
    code: "KeyA",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    preventDefault: () => {
      prevented += 1;
    },
  });
  windowListeners.get("keyup")!({
    code: "KeyA",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    preventDefault: () => {
      prevented += 1;
    },
  });
  assert.deepEqual(socket.sent, [
    { type: "keyDown", code: "KeyA" },
    { type: "keyUp", code: "KeyA" },
  ]);

  const stateMessage = {
    data: JSON.stringify({
      type: "state",
      state: {
        patch: {
          source: {
            frequencyHz: 440,
            gainDb: -12,
            oscillators: [{ waveform: "saw", transposeSemitones: 0, detuneCents: 0, level: 1 }],
            ampEnvelope: {
              attackSeconds: 0.01,
              decaySeconds: 0.1,
              sustain: 0.8,
              releaseSeconds: 0.2,
            },
          },
          effects: [],
        },
      },
    }),
  };
  socket.emit("message", stateMessage);
  assert.equal(timers.size, 1);
  const [chainTimerId, renderChain] = timers.entries().next().value!;
  timers.delete(chainTimerId);
  renderChain();
  const sourceValues = elements.get("#chain")!.children[0].children[2].textContent;
  assert.match(sourceValues, /440 Hz source frequency/);

  socket.emit("message", stateMessage);
  assert.equal(timers.size, 1);
  windowListeners.get("pagehide")!({});
  assert.deepEqual(socket.sent.at(-1), { type: "releaseAll" });
  assert.equal(timers.size, 0);
  assert.equal(clearedTimers.length, 1);
  assert.ok(documentListeners.has("visibilitychange"));

  const html = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
  assert.match(html, /Keyboard \/ controller input/);
});
