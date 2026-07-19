import { pathToFileURL } from "node:url";
import {
  PATCH_JSON_MAX_BYTES,
  validatePatch,
  type PatchProgram,
  type PatchProgramContext,
} from "@patchwave/schema";
import { tsImport } from "tsx/esm/api";

export type CanonicalPatch = ReturnType<typeof validatePatch>;

export type PatchModule =
  | Readonly<{ kind: "static"; patch: CanonicalPatch }>
  | Readonly<{ kind: "program"; program: PatchProgram }>;

export type LoadedPatch = {
  patch: CanonicalPatch;
  serialized: string;
  summary: string;
};

export async function loadPatchModule(configPath: string): Promise<PatchModule> {
  const moduleNamespace: unknown = await tsImport(pathToFileURL(configPath).href, import.meta.url);
  return normalizePatchModuleExport(readDefaultExport(moduleNamespace));
}

export function normalizePatchModuleExport(exported: unknown): PatchModule {
  if (typeof exported === "function") {
    return Object.freeze({ kind: "program", program: exported as PatchProgram });
  }
  return Object.freeze({ kind: "static", patch: validatePatch(exported) });
}

export function evaluatePatchModule(
  module: PatchModule,
  context: PatchProgramContext,
): LoadedPatch {
  const patch = module.kind === "static" ? module.patch : validatePatch(module.program(context));
  return loadedPatch(patch);
}

export function loadedPatch(patch: CanonicalPatch): LoadedPatch {
  const serialized = JSON.stringify(patch);
  const byteLength = Buffer.byteLength(serialized, "utf8");
  if (byteLength > PATCH_JSON_MAX_BYTES) {
    throw new Error(`Serialized patch must be at most ${PATCH_JSON_MAX_BYTES} UTF-8 bytes`);
  }
  return {
    patch,
    serialized,
    summary: `${Number(patch.source.frequencyHz.toFixed(2))} Hz; ${patch.source.oscillators.length} oscillator${patch.source.oscillators.length === 1 ? "" : "s"}; ${patch.effects.length} effect${patch.effects.length === 1 ? "" : "s"}`,
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
