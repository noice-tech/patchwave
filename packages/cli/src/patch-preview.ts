import { validatePatch } from "@patchwave/schema";
import type { PatchFieldPath, PatchScalar } from "@patchwave/studio";
import type { CanonicalPatch, LoadedPatch } from "./load-patch.js";
import { loadedPatch } from "./load-patch.js";

export type PatchPreview = Readonly<{
  gestureId: string;
  baseRevision: string;
  path: PatchFieldPath;
  value: PatchScalar;
}>;

export function applyPatchPreview(
  patch: CanonicalPatch,
  preview: PatchPreview | undefined,
): LoadedPatch {
  if (!preview) return loadedPatch(patch);
  const candidate: any = structuredClone(patch);
  let target: any = candidate;
  for (const segment of preview.path.slice(0, -1)) {
    target = target?.[segment as any];
    if (target === null || target === undefined || typeof target !== "object") {
      throw new Error("Preview target no longer exists in the patch");
    }
  }
  target[preview.path.at(-1) as any] = preview.value;
  return loadedPatch(validatePatch(authorFromCanonical(candidate)));
}

function authorFromCanonical(patch: any): any {
  // validatePatch rejects canonical null optionals, so remove only those absence markers.
  const clone = structuredClone(patch);
  if (clone.source.filter === null) delete clone.source.filter;
  else if (clone.source.filter?.cutoffLfo === null) delete clone.source.filter.cutoffLfo;
  return clone;
}
