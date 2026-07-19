import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { validatePatch } from "@patchwave/schema";
import { StudioDocumentController } from "../src/studio-document.js";
import { formatSource } from "../src/source-format.js";

const text = `export default {source: {frequencyHz: 110, gainDb: -12, oscillators: [{waveform: "saw"}]}} satisfies Patch;\n`;
const canonical = validatePatch({
  source: { frequencyHz: 110, gainDb: -12, oscillators: [{ waveform: "saw" }] },
});

async function setup() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "patchwave-document-")));
  const path = join(dir, "sound.ts");
  await writeFile(path, text);
  const previews: unknown[] = [];
  let cancellations = 0;
  const controller = await StudioDocumentController.create({
    path,
    getCanonical: () => canonical,
    preview: (input) => {
      previews.push(input);
      return true;
    },
    cancelPreview: () => {
      cancellations += 1;
      return true;
    },
    onChange: () => undefined,
  });
  return {
    controller,
    path,
    previews,
    get cancellations() {
      return cancellations;
    },
  };
}

test("preview is disk-free and a commit performs one revisioned source transaction", async () => {
  const { controller, path, previews } = await setup();
  const baseRevision = controller.snapshot().revision;
  const preview = await controller.handle({
    type: "preview",
    protocol: 1,
    requestId: "p",
    gestureId: "g",
    baseRevision,
    path: ["source", "gainDb"],
    value: -18,
  });
  assert.equal(preview.status, "previewed");
  assert.equal(await readFile(path, "utf8"), text);
  assert.equal(previews.length, 1);
  const mismatched = await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "wrong",
    gestureId: "g",
    baseRevision,
    operation: { type: "setField", path: ["source", "frequencyHz"], value: 220 },
  });
  assert.equal(mismatched.status, "rejected");
  const staleCancel = await controller.handle({
    type: "cancelPreview",
    protocol: 1,
    requestId: "stale-cancel",
    gestureId: "other",
  });
  assert.equal(staleCancel.status, "rejected");
  assert.equal(controller.snapshot().phase, "previewing");
  assert.equal(await readFile(path, "utf8"), text);
  const commit = await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "c",
    gestureId: "g",
    baseRevision,
    operation: { type: "setField", path: ["source", "gainDb"], value: -18 },
  });
  assert.equal(commit.status, "committed");
  const written = await readFile(path, "utf8");
  assert.match(written, /gainDb: -18/);
  assert.equal(written, await formatSource(path, written));
  assert.equal(controller.snapshot().canUndo, true);
  await controller.refreshAfterReload(true, controller.snapshot().revision);
  await controller.refreshAfterReload(true, controller.snapshot().revision);
  assert.equal(controller.snapshot().canUndo, true);
});

test("stale revisions and external changes never overwrite source", async () => {
  const { controller, path } = await setup();
  const baseRevision = controller.snapshot().revision;
  await writeFile(path, text.replace("-12", "-20"));
  const result = await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "c",
    gestureId: null,
    baseRevision,
    operation: { type: "setField", path: ["source", "gainDb"], value: -18 },
  });
  assert.equal(result.status, "conflict");
  assert.match(await readFile(path, "utf8"), /-20/);
});

test("undo is revision guarded and restores the complete transaction", async () => {
  const { controller, path } = await setup();
  const before = controller.snapshot().revision;
  await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "c",
    gestureId: null,
    baseRevision: before,
    operation: { type: "setField", path: ["source", "gainDb"], value: -18 },
  });
  const after = controller.snapshot().revision;
  const result = await controller.handle({
    type: "undo",
    protocol: 1,
    requestId: "u",
    baseRevision: after,
  });
  assert.equal(result.status, "committed");
  assert.equal(await readFile(path, "utf8"), text);
});

test("accepted own reload retires the gesture and permits the next edit", async () => {
  const { controller } = await setup();
  const revision = controller.snapshot().revision;
  await controller.handle({
    type: "preview",
    protocol: 1,
    requestId: "p",
    gestureId: "g",
    baseRevision: revision,
    path: ["source", "gainDb"],
    value: -18,
  });
  await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "c",
    gestureId: "g",
    baseRevision: revision,
    operation: { type: "setField", path: ["source", "gainDb"], value: -18 },
  });
  const written = controller.snapshot().revision;
  assert.equal(await controller.refreshAfterReload(true, written), true);
  const next = await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "next",
    gestureId: null,
    baseRevision: written,
    operation: { type: "addFilter" },
  });
  assert.equal(next.status, "committed");
});

test("controller generation rejects queued input after disconnect cleanup", async () => {
  const setupResult = await setup();
  const pending = setupResult.controller.handle({
    type: "preview",
    protocol: 1,
    requestId: "p",
    gestureId: "g",
    baseRevision: setupResult.controller.snapshot().revision,
    path: ["source", "gainDb"],
    value: -18,
  });
  setupResult.controller.cancelAllPreviews();
  assert.equal((await pending).status, "rejected");
  assert.equal(setupResult.previews.length, 0);
  await setupResult.controller.drain();
});

test("reload acknowledgement never labels later source bytes audio-accepted", async () => {
  const { controller, path } = await setup();
  const loadedRevision = controller.snapshot().revision;
  await writeFile(path, text.replace("-12", "-20"));
  assert.equal(await controller.refreshAfterReload(true, loadedRevision), false);
  assert.equal(controller.snapshot().phase, "reloading");
  assert.notEqual(controller.snapshot().revision, loadedRevision);
});

test("reload read failure retires the active preview and history", async () => {
  const setupResult = await setup();
  const loadedRevision = setupResult.controller.snapshot().revision;
  await setupResult.controller.handle({
    type: "preview",
    protocol: 1,
    requestId: "preview-before-delete",
    gestureId: "gesture-before-delete",
    baseRevision: loadedRevision,
    path: ["source", "gainDb"],
    value: -18,
  });
  await rm(setupResult.path);
  assert.equal(await setupResult.controller.refreshAfterReload(true, loadedRevision), false);
  assert.equal(setupResult.controller.snapshot().phase, "error");
  assert.equal(setupResult.controller.snapshot().canUndo, false);
  assert.equal(setupResult.cancellations, 1);
});

test("a no-op source edit is cancelled without history or error phase", async () => {
  const { controller, path } = await setup();
  const before = controller.snapshot().revision;
  const result = await controller.handle({
    type: "commit",
    protocol: 1,
    requestId: "noop",
    gestureId: null,
    baseRevision: before,
    operation: { type: "setField", path: ["source", "gainDb"], value: -12 },
  });
  assert.equal(result.status, "cancelled");
  assert.equal(controller.snapshot().phase, "ready");
  assert.equal(controller.snapshot().canUndo, false);
  assert.equal(await readFile(path, "utf8"), text);
});
