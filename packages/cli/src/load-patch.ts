import { pathToFileURL } from "node:url";
import {
  PATCH_JSON_MAX_BYTES,
  validatePatch,
  type Patch,
} from "@patchwave/schema";
import { tsImport } from "tsx/esm/api";

export type LoadedPatch = {
  patch: Patch;
  serialized: string;
  summary: string;
};

export async function loadPatch(configPath: string): Promise<LoadedPatch> {
  const moduleNamespace: unknown = await tsImport(
    pathToFileURL(configPath).href,
    import.meta.url,
  );
  return normalizePatchExport(readDefaultExport(moduleNamespace));
}

export function normalizePatchExport(exported: unknown): LoadedPatch {
  const patch = validatePatch(exported);
  const serialized = JSON.stringify(patch);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > PATCH_JSON_MAX_BYTES) {
    throw new Error(
      `Serialized patch must be at most ${PATCH_JSON_MAX_BYTES} UTF-8 bytes`,
    );
  }
  return {
    patch,
    serialized,
    summary: `${patch.tempoBpm} BPM; ${patch.modulators.length} modulators; ${patch.modulationRoutes.length} routes; ${patch.devices.map((device) => `${device.type}#${device.id}`).join(" -> ")}`,
  };
}

function readDefaultExport(moduleNamespace: unknown): unknown {
  if (!isRecord(moduleNamespace) || !("default" in moduleNamespace)) {
    throw new Error("Config module must have a default export");
  }

  const exported = moduleNamespace.default;
  const isCommonJsWrapper =
    "module.exports" in moduleNamespace &&
    isRecord(exported) &&
    Object.hasOwn(exported, "default");

  return isCommonJsWrapper ? exported.default : exported;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
