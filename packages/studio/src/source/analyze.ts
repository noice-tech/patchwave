import { PATCH_EDITOR, type PatchEditorControl } from "@patchwave/schema";
import type { File } from "@babel/types";
import type { PatchFieldPath, PatchScalar, SourceBinding, SourceLocation } from "../edit-types.js";
import { locatePatchRoot, type LocatedPatchRoot, unwrapExpression } from "./unwrap.js";

export type PropertyLookup =
  | { kind: "property"; property: any; value: any }
  | { kind: "missing" }
  | { kind: "computed"; node: any; reason: string };

export type SourceAnalysis = Readonly<{
  mode: "static" | "program" | "unknown";
  diagnostic: string | null;
  bindings: readonly SourceBinding[];
  editableStructure: Readonly<{
    oscillators: boolean;
    filter: boolean;
    cutoffLfo: boolean;
    effects: boolean;
  }>;
}>;

export type InternalAnalysis = SourceAnalysis & {
  file: File;
  root: LocatedPatchRoot;
  sourceObject: any | null;
  oscillatorArray: any | null;
  filterObject: any | null;
  lfoObject: any | null;
  envelopeObject: any | null;
  effectsArray: any | null;
  bindingNodes: Map<
    string,
    { parent: any | null; property: any | null; value: any | null; editable: boolean }
  >;
};

export function pathKey(path: PatchFieldPath | readonly (string | number)[]): string {
  return JSON.stringify(path);
}

export function analyzeSource(file: File, canonical: any, fileLabel: string): InternalAnalysis {
  const root = locatePatchRoot(file);
  const bindings: SourceBinding[] = [];
  const bindingNodes = new Map<
    string,
    { parent: any | null; property: any | null; value: any | null; editable: boolean }
  >();
  if (!root.object) {
    return {
      file,
      root,
      mode: "unknown",
      diagnostic: root.diagnostic,
      bindings,
      editableStructure: { oscillators: false, filter: false, cutoffLfo: false, effects: false },
      sourceObject: null,
      oscillatorArray: null,
      filterObject: null,
      lfoObject: null,
      envelopeObject: null,
      effectsArray: null,
      bindingNodes,
    };
  }

  const sourceLookup = propertyFor(root.object, "source");
  const sourceObject = directObject(sourceLookup);
  const oscLookup = sourceObject
    ? propertyFor(sourceObject, "oscillators")
    : computedLookup(sourceLookup);
  const oscillatorArray = directArray(oscLookup);
  const filterLookup = sourceObject
    ? propertyFor(sourceObject, "filter")
    : computedLookup(sourceLookup);
  const filterObject = directObject(filterLookup);
  const lfoLookup = filterObject
    ? propertyFor(filterObject, "cutoffLfo")
    : filterLookup.kind === "missing"
      ? { kind: "missing" as const }
      : computedLookup(filterLookup);
  const lfoObject = directObject(lfoLookup);
  const envelopeLookup = sourceObject
    ? propertyFor(sourceObject, "ampEnvelope")
    : computedLookup(sourceLookup);
  const envelopeObject = directObject(envelopeLookup);
  const effectsLookup = propertyFor(root.object, "effects");
  const effectsArray = directArray(effectsLookup);

  const add = (
    path: PatchFieldPath,
    parent: any | null,
    key: string,
    control: PatchEditorControl,
    runtimeValue: PatchScalar,
    fallback?: PatchScalar,
    inherited?: PropertyLookup,
  ) => {
    const lookup =
      inherited ??
      (parent
        ? propertyFor(parent, key)
        : ({ kind: "computed", node: null, reason: "container is computed" } as const));
    const sourceForm = scalarSourceForm(lookup, runtimeValue, fallback);
    const node =
      lookup.kind === "property" ? lookup.value : lookup.kind === "computed" ? lookup.node : parent;
    const binding: SourceBinding = {
      path,
      sourceForm,
      location: location(node, fileLabel),
      control,
    };
    bindings.push(binding);
    bindingNodes.set(pathKey(path), {
      parent,
      property: lookup.kind === "property" ? lookup.property : null,
      value: lookup.kind === "property" ? lookup.value : null,
      editable: sourceForm.kind !== "computed",
    });
  };

  add(
    ["source", "frequencyHz"],
    sourceObject,
    "frequencyHz",
    PATCH_EDITOR.controls.frequencyHz,
    canonical.source.frequencyHz,
    undefined,
    sourceObject ? undefined : computedLookup(sourceLookup),
  );
  add(
    ["source", "gainDb"],
    sourceObject,
    "gainDb",
    PATCH_EDITOR.controls.gainDb,
    canonical.source.gainDb,
    -12,
    sourceObject ? undefined : computedLookup(sourceLookup),
  );

  const oscillatorElements = oscillatorArray?.elements ?? [];
  canonical.source.oscillators.forEach((oscillator: any, index: number) => {
    const element = unwrapExpression(oscillatorElements[index]);
    const object =
      element?.type === "ObjectExpression" &&
      objectIsDirect(element) &&
      discriminantValue(element, "waveform") === oscillator.waveform
        ? element
        : null;
    const inherited: PropertyLookup | undefined = object
      ? undefined
      : {
          kind: "computed",
          node: element ?? oscillatorArray,
          reason: "oscillator is not a direct object literal",
        };
    if (oscillator.waveform !== "noise") {
      add(
        ["source", "oscillators", index, "transposeSemitones"],
        object,
        "transposeSemitones",
        PATCH_EDITOR.controls.transposeSemitones,
        oscillator.transposeSemitones,
        0,
        inherited,
      );
      add(
        ["source", "oscillators", index, "detuneCents"],
        object,
        "detuneCents",
        PATCH_EDITOR.controls.detuneCents,
        oscillator.detuneCents,
        0,
        inherited,
      );
    }
    if (oscillator.waveform === "pulse")
      add(
        ["source", "oscillators", index, "pulseWidth"],
        object,
        "pulseWidth",
        PATCH_EDITOR.controls.pulseWidth,
        oscillator.pulseWidth,
        0.5,
        inherited,
      );
    add(
      ["source", "oscillators", index, "level"],
      object,
      "level",
      PATCH_EDITOR.controls.level,
      oscillator.level,
      1,
      inherited,
    );
  });

  if (canonical.source.filter) {
    const inherited = filterObject ? undefined : computedLookup(filterLookup);
    add(
      ["source", "filter", "mode"],
      filterObject,
      "mode",
      PATCH_EDITOR.controls.filterMode,
      canonical.source.filter.mode,
      "lowpass",
      inherited,
    );
    add(
      ["source", "filter", "cutoffHz"],
      filterObject,
      "cutoffHz",
      PATCH_EDITOR.controls.cutoffHz,
      canonical.source.filter.cutoffHz,
      undefined,
      inherited,
    );
    add(
      ["source", "filter", "resonance"],
      filterObject,
      "resonance",
      PATCH_EDITOR.controls.resonance,
      canonical.source.filter.resonance,
      0,
      inherited,
    );
    if (canonical.source.filter.cutoffLfo) {
      const lfoInherited = lfoObject ? undefined : computedLookup(lfoLookup);
      add(
        ["source", "filter", "cutoffLfo", "shape"],
        lfoObject,
        "shape",
        PATCH_EDITOR.controls.lfoShape,
        canonical.source.filter.cutoffLfo.shape,
        "sine",
        lfoInherited,
      );
      add(
        ["source", "filter", "cutoffLfo", "rateHz"],
        lfoObject,
        "rateHz",
        PATCH_EDITOR.controls.lfoRateHz,
        canonical.source.filter.cutoffLfo.rateHz,
        undefined,
        lfoInherited,
      );
      add(
        ["source", "filter", "cutoffLfo", "amountOctaves"],
        lfoObject,
        "amountOctaves",
        PATCH_EDITOR.controls.amountOctaves,
        canonical.source.filter.cutoffLfo.amountOctaves,
        undefined,
        lfoInherited,
      );
    }
  }

  const envelopeInherited = envelopeObject
    ? undefined
    : envelopeLookup.kind === "missing" && sourceObject
      ? undefined
      : computedLookup(envelopeLookup);
  add(
    ["source", "ampEnvelope", "attackSeconds"],
    envelopeObject,
    "attackSeconds",
    PATCH_EDITOR.controls.attackSeconds,
    canonical.source.ampEnvelope.attackSeconds,
    0.005,
    envelopeInherited,
  );
  add(
    ["source", "ampEnvelope", "decaySeconds"],
    envelopeObject,
    "decaySeconds",
    PATCH_EDITOR.controls.decaySeconds,
    canonical.source.ampEnvelope.decaySeconds,
    0,
    envelopeInherited,
  );
  add(
    ["source", "ampEnvelope", "sustain"],
    envelopeObject,
    "sustain",
    PATCH_EDITOR.controls.sustain,
    canonical.source.ampEnvelope.sustain,
    1,
    envelopeInherited,
  );
  add(
    ["source", "ampEnvelope", "releaseSeconds"],
    envelopeObject,
    "releaseSeconds",
    PATCH_EDITOR.controls.releaseSeconds,
    canonical.source.ampEnvelope.releaseSeconds,
    0.1,
    envelopeInherited,
  );

  const effectElements = effectsArray?.elements ?? [];
  canonical.effects.forEach((effect: any, index: number) => {
    const element = unwrapExpression(effectElements[index]);
    const object =
      element?.type === "ObjectExpression" &&
      objectIsDirect(element) &&
      discriminantValue(element, "type") === effect.type
        ? element
        : null;
    const inherited: PropertyLookup | undefined = object
      ? undefined
      : {
          kind: "computed",
          node: element ?? effectsArray,
          reason: "effect is not a direct object literal",
        };
    if (effect.type === "saturator") {
      add(
        ["effects", index, "driveDb"],
        object,
        "driveDb",
        PATCH_EDITOR.controls.driveDb,
        effect.driveDb,
        undefined,
        inherited,
      );
      add(
        ["effects", index, "outputGainDb"],
        object,
        "outputGainDb",
        PATCH_EDITOR.controls.outputGainDb,
        effect.outputGainDb,
        0,
        inherited,
      );
      add(
        ["effects", index, "mix"],
        object,
        "mix",
        { ...PATCH_EDITOR.controls.mix, defaultValue: 1 },
        effect.mix,
        1,
        inherited,
      );
    } else {
      add(
        ["effects", index, "timeSeconds"],
        object,
        "timeSeconds",
        PATCH_EDITOR.controls.timeSeconds,
        effect.timeSeconds,
        undefined,
        inherited,
      );
      add(
        ["effects", index, "feedback"],
        object,
        "feedback",
        PATCH_EDITOR.controls.feedback,
        effect.feedback,
        0,
        inherited,
      );
      add(
        ["effects", index, "damping"],
        object,
        "damping",
        PATCH_EDITOR.controls.damping,
        effect.damping,
        0,
        inherited,
      );
      add(
        ["effects", index, "pingPong"],
        object,
        "pingPong",
        PATCH_EDITOR.controls.pingPong,
        effect.pingPong,
        false,
        inherited,
      );
      add(
        ["effects", index, "mix"],
        object,
        "mix",
        PATCH_EDITOR.controls.mix,
        effect.mix,
        undefined,
        inherited,
      );
    }
  });

  return {
    file,
    root,
    mode: root.mode,
    diagnostic: root.diagnostic,
    bindings,
    editableStructure: {
      oscillators: Boolean(
        oscillatorArray &&
        oscillatorElements.every((element: any) => {
          const object = unwrapExpression(element);
          return (
            object?.type === "ObjectExpression" &&
            objectIsDirect(object) &&
            ["sine", "triangle", "saw", "pulse", "noise"].includes(
              discriminantValue(object, "waveform") ?? "",
            )
          );
        }),
      ),
      filter: Boolean(sourceObject && (filterLookup.kind === "missing" || filterObject)),
      cutoffLfo: Boolean(filterObject && (lfoLookup.kind === "missing" || lfoObject)),
      effects:
        effectsLookup.kind === "missing" ||
        Boolean(
          effectsArray &&
          effectElements.every((element: any) => {
            const object = unwrapExpression(element);
            return (
              object?.type === "ObjectExpression" &&
              objectIsDirect(object) &&
              ["saturator", "stereoDelay"].includes(discriminantValue(object, "type") ?? "")
            );
          }),
        ),
    },
    sourceObject,
    oscillatorArray,
    filterObject,
    lfoObject,
    envelopeObject,
    effectsArray,
    bindingNodes,
  };
}

export function propertyFor(object: any, key: string): PropertyLookup {
  if (!object || object.type !== "ObjectExpression")
    return { kind: "computed", node: object, reason: "container is not an object literal" };
  if (!objectIsDirect(object))
    return {
      kind: "computed",
      node: object,
      reason: "container uses a spread, computed key, accessor, or duplicate key",
    };
  const matches = object.properties.filter(
    (property: any) => property.type === "ObjectProperty" && propertyName(property) === key,
  );
  if (matches.length === 0) return { kind: "missing" };
  const property = matches[0];
  return { kind: "property", property, value: unwrapExpression(property.value) };
}

export function objectIsDirect(object: any): boolean {
  if (!object || object.type !== "ObjectExpression") return false;
  const names = new Set<string>();
  for (const property of object.properties) {
    if (property.type !== "ObjectProperty" || property.computed || property.method) return false;
    const name = propertyName(property);
    if (name === null || names.has(name)) return false;
    names.add(name);
  }
  return true;
}

function discriminantValue(object: any, key: string): string | null {
  const lookup = propertyFor(object, key);
  return lookup.kind === "property" && lookup.value?.type === "StringLiteral"
    ? lookup.value.value
    : null;
}

function propertyName(property: any): string | null {
  if (property.computed) return null;
  if (property.key?.type === "Identifier") return property.key.name;
  if (property.key?.type === "StringLiteral") return property.key.value;
  return null;
}
function directObject(lookup: PropertyLookup): any | null {
  return lookup.kind === "property" &&
    lookup.value?.type === "ObjectExpression" &&
    objectIsDirect(lookup.value)
    ? lookup.value
    : null;
}
function directArray(lookup: PropertyLookup): any | null {
  if (lookup.kind !== "property" || lookup.value?.type !== "ArrayExpression") return null;
  return lookup.value.elements.every(
    (element: any) => element !== null && element.type !== "SpreadElement",
  )
    ? lookup.value
    : null;
}
function computedLookup(lookup: PropertyLookup): PropertyLookup {
  return lookup.kind === "computed"
    ? lookup
    : {
        kind: "computed",
        node: lookup.kind === "property" ? lookup.value : null,
        reason: "container is not directly editable",
      };
}
function scalarSourceForm(
  lookup: PropertyLookup,
  runtimeValue: PatchScalar,
  fallback?: PatchScalar,
): SourceBinding["sourceForm"] {
  if (lookup.kind === "missing") {
    return fallback === undefined
      ? {
          kind: "computed",
          reason: "expression",
          message: "This required value is not an inline literal.",
        }
      : { kind: "default", value: fallback, explicit: false };
  }
  if (lookup.kind === "computed")
    return { kind: "computed", reason: "expression", message: lookup.reason };
  const literal = readLiteral(lookup.value);
  return literal.ok
    ? { kind: "literal", value: literal.value, explicit: true }
    : {
        kind: "computed",
        reason: "expression",
        message: `Computed in code (${lookup.value?.type ?? "unknown expression"}).`,
      };
}
function readLiteral(node: any): { ok: true; value: PatchScalar } | { ok: false } {
  const current = unwrapExpression(node);
  if (current?.type === "NumericLiteral" && Number.isFinite(current.value))
    return { ok: true, value: current.value };
  if (current?.type === "StringLiteral") return { ok: true, value: current.value };
  if (current?.type === "BooleanLiteral") return { ok: true, value: current.value };
  if (
    current?.type === "UnaryExpression" &&
    ["-", "+"].includes(current.operator) &&
    current.argument?.type === "NumericLiteral"
  ) {
    const value = current.operator === "-" ? -current.argument.value : current.argument.value;
    return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  }
  return { ok: false };
}
function location(node: any, fileLabel: string): SourceLocation | null {
  const start = node?.loc?.start;
  return start ? { fileLabel, line: start.line, column: start.column + 1 } : null;
}
