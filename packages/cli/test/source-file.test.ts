import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicReplaceSource,
  readWritableSource,
  SourceConflictError,
} from "../src/source-file.js";

test("atomically replaces only the expected regular TypeScript revision", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "patchwave-source-")));
  const path = join(dir, "sound.ts");
  await writeFile(path, "export default 1;\n", { mode: 0o640 });
  const before = await readWritableSource(path);
  const revision = await atomicReplaceSource(
    path,
    before.revision,
    Buffer.from("export default 2;\n"),
  );
  assert.notEqual(revision, before.revision);
  assert.equal(await readFile(path, "utf8"), "export default 2;\n");
  await assert.rejects(
    () => atomicReplaceSource(path, before.revision, Buffer.from("bad")),
    SourceConflictError,
  );
  assert.equal(await readFile(path, "utf8"), "export default 2;\n");
});

test("symlink and unsupported extension are read-only", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "patchwave-source-")));
  const target = join(dir, "target.ts");
  const link = join(dir, "link.ts");
  await writeFile(target, "export default 1");
  await symlink(target, link);
  await assert.rejects(() => readWritableSource(link), /symbolic/);
  const json = join(dir, "sound.json");
  await writeFile(json, "{}");
  await assert.rejects(() => readWritableSource(json), /.ts and .tsx/);
});

test("ancestor symlink paths are playback-only", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "patchwave-source-")));
  const realDirectory = join(dir, "real");
  const linkedDirectory = join(dir, "linked");
  await mkdir(realDirectory);
  await symlink(realDirectory, linkedDirectory);
  const target = join(realDirectory, "sound.ts");
  await writeFile(target, "export default 1");
  await assert.rejects(
    () => readWritableSource(join(linkedDirectory, "sound.ts")),
    /symbolic-link path components/,
  );
  assert.equal(await readFile(target, "utf8"), "export default 1");
});
