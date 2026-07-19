import assert from "node:assert/strict";
import test from "node:test";
import { StudioHistory } from "../src/studio-history.js";

test("history is transaction-level and clears redo after a new commit", () => {
  const history = new StudioHistory();
  const entry = {
    label: "gain",
    before: Buffer.from("a"),
    beforeRevision: "a",
    after: Buffer.from("b"),
    afterRevision: "b",
  };
  history.push(entry);
  assert.equal(history.canUndo, true);
  history.didUndo();
  assert.equal(history.canRedo, true);
  history.didRedo();
  assert.equal(history.canUndo, true);
  history.didUndo();
  history.push({ ...entry, label: "next" });
  assert.equal(history.canRedo, false);
});
