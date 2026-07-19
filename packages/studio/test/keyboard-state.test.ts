import assert from "node:assert/strict";
import test from "node:test";
import { KeyboardState, NOTE_CODES, noteFrequency, noteLabel } from "../src/keyboard-state.js";

test("maps the complete Ableton physical-key layout from A=C3", () => {
  const keyboard = new KeyboardState();
  for (const [code, offset] of Object.entries(NOTE_CODES)) {
    const isolated = new KeyboardState();
    const action = isolated.keyDown(code);
    assert.equal(action.type, "noteOn", code);
    assert.equal(action.snapshot.voice.frequencyHz, noteFrequency(60 + offset), code);
  }
  assert.equal(noteLabel(60), "C3");
  assert.equal(noteLabel(72), "C4");
  assert.equal(keyboard.snapshot().octaveLabel, "C3");
});

test("uses last-pressed priority, ignores repeats, and falls back without retrigger", () => {
  const keyboard = new KeyboardState();
  assert.equal(keyboard.keyDown("KeyA").type, "noteOn");
  assert.equal(keyboard.keyDown("KeyA").type, "none");
  assert.equal(keyboard.keyDown("KeyD").type, "noteOn");
  assert.equal(keyboard.keyUp("KeyA").type, "none");
  assert.equal(keyboard.keyDown("KeyA").type, "noteOn");
  const fallback = keyboard.keyUp("KeyA");
  assert.equal(fallback.type, "pitch");
  assert.equal(fallback.snapshot.activeCode, "KeyD");
  assert.equal(keyboard.keyUp("KeyD").type, "noteOff");
  assert.equal(keyboard.keyUp("KeyD").type, "none");
});

test("octave changes clamp and do not retune already-held physical keys", () => {
  const keyboard = new KeyboardState();
  const held = keyboard.keyDown("KeyA").snapshot.voice.frequencyHz;
  keyboard.keyDown("KeyX");
  keyboard.keyDown("KeyX");
  assert.equal(keyboard.snapshot().baseNote, 72);
  assert.equal(keyboard.snapshot().voice.frequencyHz, held);
  assert.equal(keyboard.keyDown("KeyS").snapshot.voice.frequencyHz, noteFrequency(74));
  keyboard.releaseAll();
  for (let index = 0; index < 20; index += 1) {
    keyboard.keyDown("KeyZ");
    keyboard.keyUp("KeyZ");
  }
  assert.equal(keyboard.snapshot().baseNote, 0);
  for (let index = 0; index < 20; index += 1) {
    keyboard.keyDown("KeyX");
    keyboard.keyUp("KeyX");
  }
  assert.equal(keyboard.snapshot().baseNote, 108);
  assert.equal(keyboard.keyDown("KeyK").snapshot.voice.frequencyHz, noteFrequency(120));
});

test("releaseAll is idempotent and safely closes the voice", () => {
  const keyboard = new KeyboardState();
  keyboard.keyDown("KeyA");
  keyboard.keyDown("KeyS");
  assert.equal(keyboard.releaseAll().type, "noteOff");
  assert.equal(keyboard.releaseAll().type, "none");
  assert.deepEqual(keyboard.snapshot().heldCodes, []);
  assert.equal(keyboard.snapshot().voice.gate, false);
});
