import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("React Studio preserves keyboard safety and gesture-end source commits", async () => {
  const source = await readFile(new URL("../client/src/main.tsx", import.meta.url), "utf8");
  assert.match(source, /PerformanceKeyCapture/);
  assert.match(source, /addEventListener\("keydown", down, true\)/);
  assert.match(source, /type: "keyUp"/);
  assert.match(source, /visibilitychange/);
  assert.match(source, /pagehide/);
  assert.match(source, /type: "preview"/);
  assert.match(source, /onPointerUp=\{commit\}/);
  assert.match(source, /application\/x-patchwave-block/);
  assert.match(source, /type: "setField"/);
  assert.match(source, /type: "cancelPreview"/);
});

test("Vite emits a capability-relative production shell without inline application code", async () => {
  const html = await readFile(new URL("../dist/client/index.html", import.meta.url), "utf8");
  assert.match(html, /Patchwave Studio/);
  assert.match(html, /\.\/assets\/index-/);
  assert.doesNotMatch(html, /src\/main\.tsx/);
});
