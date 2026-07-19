const connection = document.querySelector("#connection");
const mode = document.querySelector("#mode");
const gate = document.querySelector("#gate");
const octave = document.querySelector("#octave");
const time = document.querySelector("#time");
const frame = document.querySelector("#frame");
const note = document.querySelector("#note");
const frequency = document.querySelector("#frequency");
const summary = document.querySelector("#summary");
const chain = document.querySelector("#chain");
const keyboard = document.querySelector("#keyboard");
const statusPanel = document.querySelector("#status-panel");
const status = document.querySelector("#status");
const CHAIN_RENDER_INTERVAL_MS = 100;
let chainTimer;
let pendingChainPatch;
let renderedChainKey;

const keys = [
  ["KeyA", "A", false],
  ["KeyW", "W", true],
  ["KeyS", "S", false],
  ["KeyE", "E", true],
  ["KeyD", "D", false],
  ["KeyF", "F", false],
  ["KeyT", "T", true],
  ["KeyG", "G", false],
  ["KeyY", "Y", true],
  ["KeyH", "H", false],
  ["KeyU", "U", true],
  ["KeyJ", "J", false],
  ["KeyK", "K", false],
];
const keyElements = new Map();
for (const [code, label, black] of keys) {
  const element = document.createElement("div");
  element.className = `key${black ? " black" : ""}`;
  element.dataset.code = code;
  const text = document.createElement("span");
  text.textContent = label;
  element.append(text);
  keyboard.append(element);
  keyElements.set(code, element);
}

const socketUrl = new URL("./socket", window.location.href);
socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(socketUrl);

socket.addEventListener("open", () => {
  document.body.classList.add("connected");
  document.body.classList.remove("disconnected");
  connection.textContent = "Connected";
});
socket.addEventListener("close", () => {
  stopChainUpdates();
  document.body.classList.remove("connected");
  document.body.classList.add("disconnected");
  connection.textContent = "Disconnected";
  statusPanel.classList.add("error");
  status.textContent = "Studio connection closed. Restart Patchwave to reconnect.";
});
socket.addEventListener("message", (event) => {
  try {
    const message = JSON.parse(event.data);
    if (message?.type === "state") render(message.state);
  } catch {
    socket.close();
  }
});

const mappedCodes = new Set([...keys.map(([code]) => code), "KeyZ", "KeyX"]);
window.addEventListener("keydown", (event) => {
  if (!mappedCodes.has(event.code) || event.ctrlKey || event.metaKey || event.altKey) return;
  event.preventDefault();
  if (!event.repeat) send({ type: "keyDown", code: event.code });
});
window.addEventListener("keyup", (event) => {
  if (!mappedCodes.has(event.code)) return;
  event.preventDefault();
  send({ type: "keyUp", code: event.code });
});
window.addEventListener("blur", releaseAll);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) releaseAll();
});
window.addEventListener("pagehide", () => {
  releaseAll();
  stopChainUpdates();
});

function releaseAll() {
  send({ type: "releaseAll" });
}
function send(message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function render(state) {
  if (!state || typeof state !== "object") return;
  mode.textContent = state.mode ?? "static";
  gate.textContent = state.keyboard?.voice?.gate ? "open" : "closed";
  octave.textContent = state.keyboard?.octaveLabel ?? "C3";
  time.textContent = `${Number(state.timeSeconds ?? 0).toFixed(2)} s`;
  frame.textContent = String(state.frame ?? 0);
  note.textContent = state.keyboard?.activeNoteLabel ?? "—";
  frequency.textContent = `${Number(state.keyboard?.voice?.frequencyHz ?? 0).toFixed(2)} Hz`;
  summary.textContent = state.summary ?? "";
  const held = new Set(state.keyboard?.heldCodes ?? []);
  for (const [code, element] of keyElements) element.classList.toggle("active", held.has(code));
  statusPanel.classList.toggle("error", Boolean(state.error));
  status.textContent = state.error || state.status || "Audio running";
  scheduleChainRender(state.patch);
}

function scheduleChainRender(patch) {
  pendingChainPatch = patch;
  if (chainTimer !== undefined) return;
  chainTimer = setTimeout(() => {
    chainTimer = undefined;
    const nextPatch = pendingChainPatch;
    pendingChainPatch = undefined;
    const nextKey = JSON.stringify(nextPatch ?? null);
    if (nextKey === renderedChainKey) return;
    renderedChainKey = nextKey;
    renderChain(nextPatch);
  }, CHAIN_RENDER_INTERVAL_MS);
}

function stopChainUpdates() {
  if (chainTimer !== undefined) clearTimeout(chainTimer);
  chainTimer = undefined;
  pendingChainPatch = undefined;
}

function renderChain(patch) {
  chain.replaceChildren();
  if (!patch?.source) return;
  addDevice("Source", "Oscillator mix", [
    `${format(patch.source.frequencyHz)} Hz source frequency`,
    `${patch.source.oscillators.length} oscillator${patch.source.oscillators.length === 1 ? "" : "s"}`,
    `${format(patch.source.gainDb)} dB gain`,
  ]);
  patch.source.oscillators.forEach((oscillator, index) => {
    const values = [`${format(oscillator.level)} level`];
    if (oscillator.waveform !== "noise") {
      values.unshift(
        `${format(oscillator.transposeSemitones)} semitones`,
        `${format(oscillator.detuneCents)} cents detune`,
      );
    }
    if (oscillator.waveform === "pulse") {
      values.push(`${format(oscillator.pulseWidth)} pulse width`);
    }
    addDevice("Oscillator", `${index + 1} · ${oscillator.waveform}`, values);
  });
  if (patch.source.filter) {
    addDevice("Filter", patch.source.filter.mode, [
      `${format(patch.source.filter.cutoffHz)} Hz cutoff`,
      `${format(patch.source.filter.resonance)} resonance`,
      patch.source.filter.cutoffLfo
        ? `${patch.source.filter.cutoffLfo.shape} · ${format(patch.source.filter.cutoffLfo.rateHz)} Hz · ${format(patch.source.filter.cutoffLfo.amountOctaves)} octaves`
        : "No cutoff LFO",
    ]);
  }
  const envelope = patch.source.ampEnvelope;
  addDevice("Envelope", "Amplitude", [
    `${format(envelope.attackSeconds)} s attack`,
    `${format(envelope.decaySeconds)} s decay`,
    `${format(envelope.sustain)} sustain`,
    `${format(envelope.releaseSeconds)} s release`,
  ]);
  for (const effect of patch.effects ?? []) {
    if (effect.type === "saturator") {
      addDevice("Effect", "Saturator", [
        `${format(effect.driveDb)} dB drive`,
        `${format(effect.outputGainDb)} dB output`,
        `${format(effect.mix)} mix`,
      ]);
    } else {
      addDevice("Effect", "Stereo delay", [
        `${format(effect.timeSeconds)} s`,
        `${format(effect.feedback)} feedback`,
        `${format(effect.damping)} damping`,
        effect.pingPong ? "Ping-pong on" : "Ping-pong off",
        `${format(effect.mix)} mix`,
      ]);
    }
  }
  addDevice("Output", "Safety guard", ["Finite", "Bounded", "Stereo"]);
}

function addDevice(kind, name, values) {
  const element = document.createElement("article");
  element.className = "device";
  const kindElement = document.createElement("p");
  kindElement.className = "device-kind";
  kindElement.textContent = kind;
  const nameElement = document.createElement("p");
  nameElement.className = "device-name";
  nameElement.textContent = name;
  const valuesElement = document.createElement("p");
  valuesElement.className = "device-values";
  valuesElement.textContent = values.join("\n");
  element.append(kindElement, nameElement, valuesElement);
  chain.append(element);
}
function format(value) {
  return Number(value).toFixed(Number(value) < 10 ? 2 : 0);
}
