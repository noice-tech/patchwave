import { createHash, randomBytes } from "node:crypto";
import { chmod, lstat, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";

export const STUDIO_SOURCE_MAX_BYTES = 1_048_576;

export function sourceRevision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type SourceFileSnapshot = Readonly<{
  bytes: Buffer;
  revision: string;
  mode: number;
  device: bigint;
  inode: bigint;
  parentRealPath: string;
}>;

export async function readWritableSource(path: string): Promise<SourceFileSnapshot> {
  const lexicalPath = resolve(path);
  const resolvedPath = await realpath(path);
  if (resolvedPath !== lexicalPath)
    throw new Error("Studio write-back is disabled for symbolic-link path components");
  const parentRealPath = await realpath(dirname(path));
  if (parentRealPath !== resolve(dirname(path)))
    throw new Error("Studio write-back is disabled for symbolic-link path components");
  const info = await lstat(path, { bigint: true });
  if (info.isSymbolicLink()) throw new Error("Studio write-back is disabled for symbolic links");
  if (!info.isFile()) throw new Error("Studio write-back requires a regular file");
  if (![".ts", ".tsx"].includes(extname(path)))
    throw new Error("Studio write-back supports .ts and .tsx entry files");
  if (info.size > BigInt(STUDIO_SOURCE_MAX_BYTES))
    throw new Error("Patch source is too large for Studio write-back");
  const bytes = await readFile(path);
  if (bytes.byteLength > STUDIO_SOURCE_MAX_BYTES)
    throw new Error("Patch source is too large for Studio write-back");
  const afterRead = await lstat(path, { bigint: true });
  if (afterRead.dev !== info.dev || afterRead.ino !== info.ino) throw new SourceConflictError();
  return {
    bytes,
    revision: sourceRevision(bytes),
    mode: Number(info.mode & 0o777n),
    device: info.dev,
    inode: info.ino,
    parentRealPath,
  };
}

export async function atomicReplaceSource(
  path: string,
  expectedRevision: string,
  bytes: Buffer,
): Promise<string> {
  if (bytes.byteLength > STUDIO_SOURCE_MAX_BYTES)
    throw new Error("Patch source is too large for Studio write-back");
  const current = await readWritableSource(path);
  if (current.revision !== expectedRevision) throw new SourceConflictError();
  const temporary = join(
    dirname(path),
    `.patchwave-${process.pid}-${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", current.mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, current.mode);
    const beforeRename = await readWritableSource(path);
    if (
      beforeRename.revision !== expectedRevision ||
      beforeRename.device !== current.device ||
      beforeRename.inode !== current.inode ||
      beforeRename.parentRealPath !== current.parentRealPath
    )
      throw new SourceConflictError();
    await rename(temporary, path);
    const written = await readWritableSource(path);
    const revision = sourceRevision(bytes);
    if (written.revision !== revision)
      throw new Error("Studio could not verify the completed source replacement");
    return revision;
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

export class SourceConflictError extends Error {
  constructor() {
    super("The patch changed outside Studio; no source was written");
  }
}
