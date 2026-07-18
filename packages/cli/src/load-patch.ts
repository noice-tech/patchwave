import { pathToFileURL } from "node:url";
import { PATCH_JSON_MAX_BYTES, validatePatch } from "@patchwave/schema";
import { tsImport } from "tsx/esm/api";

export type LoadedPatch = {
  patch: ReturnType<typeof validatePatch>;
  serialized: string;
  summary: string;
};

export async function loadPatch(configPath: string): Promise<LoadedPatch> {
  const moduleNamespace: unknown = await tsImport(pathToFileURL(configPath).href, import.meta.url);
  return normalizePatchExport(readDefaultExport(moduleNamespace));
}

export function normalizePatchExport(exported: unknown): LoadedPatch {
  const patch = validatePatch(exported);
  const serialized = JSON.stringify(patch);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > PATCH_JSON_MAX_BYTES) {
    throw new Error(`Serialized patch must be at most ${PATCH_JSON_MAX_BYTES} UTF-8 bytes`);
  }
  return {
    patch,
    serialized,
    summary: `${patch.source.frequencyHz} Hz; ${patch.source.oscillators.length} oscillator${patch.source.oscillators.length === 1 ? "" : "s"}; ${patch.effects.length} effect${patch.effects.length === 1 ? "" : "s"}`,
  };
}

function readDefaultExport(moduleNamespace: unknown): unknown {
  if (!isRecord(moduleNamespace) || !("default" in moduleNamespace)) {
    throw new Error("Config module must have a default export");
  }

  const exported = moduleNamespace.default;
  const isCommonJsWrapper =
    "module.exports" in moduleNamespace && isRecord(exported) && Object.hasOwn(exported, "default");

  return isCommonJsWrapper ? exported.default : exported;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
