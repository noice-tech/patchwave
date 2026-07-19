import { EFFECT_COUNT_MAX, OSCILLATOR_COUNT_MAX } from "@patchwave/schema";
import * as recast from "recast";
import type { PatchEditOperation, PatchFieldPath, PatchScalar } from "../edit-types.js";
import { analyzeSource, pathKey, propertyFor, type InternalAnalysis } from "./analyze.js";
import { parseSource, printSource } from "./parse.js";

const b = recast.types.builders;
const PROPERTY_ORDER = [
  "source",
  "effects",
  "frequencyHz",
  "gainDb",
  "oscillators",
  "filter",
  "ampEnvelope",
  "waveform",
  "transposeSemitones",
  "detuneCents",
  "pulseWidth",
  "level",
  "mode",
  "cutoffHz",
  "resonance",
  "cutoffLfo",
  "shape",
  "rateHz",
  "amountOctaves",
  "attackSeconds",
  "decaySeconds",
  "sustain",
  "releaseSeconds",
  "type",
  "driveDb",
  "outputGainDb",
  "timeSeconds",
  "feedback",
  "damping",
  "pingPong",
  "mix",
] as const;

export function applySourceEdit(
  source: string,
  canonical: any,
  fileLabel: string,
  operation: PatchEditOperation,
): string {
  const file = parseSource(source);
  const analysis = analyzeSource(file, canonical, fileLabel);
  if (!analysis.root.object)
    throw new Error(analysis.diagnostic ?? "Source is read-only in Studio");
  applyOperation(analysis, operation);
  const output = printSource(file);
  parseSource(output);
  if (output === source) throw new Error("Edit did not change the source file");
  return output;
}

function applyOperation(analysis: InternalAnalysis, operation: PatchEditOperation): void {
  if (operation.type.endsWith("Oscillator") && !analysis.editableStructure.oscillators) {
    throw new Error("Oscillator structure is computed in code");
  }
  if (
    ["addFilter", "removeFilter"].includes(operation.type) &&
    !analysis.editableStructure.filter
  ) {
    throw new Error("Filter structure is computed in code");
  }
  if (
    ["addCutoffLfo", "removeCutoffLfo"].includes(operation.type) &&
    !analysis.editableStructure.cutoffLfo
  ) {
    throw new Error("Cutoff LFO structure is computed in code");
  }
  if (operation.type.endsWith("Effect") && !analysis.editableStructure.effects) {
    throw new Error("Effect structure is computed in code");
  }
  switch (operation.type) {
    case "setField":
      setField(analysis, operation.path, operation.value);
      return;
    case "resetField":
      resetField(analysis, operation.path);
      return;
    case "addOscillator": {
      const array = requireArray(analysis.oscillatorArray, "Oscillator array is computed");
      if (array.elements.length >= OSCILLATOR_COUNT_MAX)
        throw new Error("Patch already has four oscillators");
      if (operation.index > array.elements.length)
        throw new Error("Oscillator insertion index is out of range");
      array.elements.splice(operation.index, 0, oscillatorTemplate(operation.waveform));
      return;
    }
    case "removeOscillator": {
      const array = requireArray(analysis.oscillatorArray, "Oscillator array is computed");
      if (array.elements.length <= 1) throw new Error("A patch must keep at least one oscillator");
      requireExisting(array.elements, operation.index, "oscillator");
      array.elements.splice(operation.index, 1);
      return;
    }
    case "moveOscillator":
      moveInArray(
        requireArray(analysis.oscillatorArray, "Oscillator array is computed"),
        operation.from,
        operation.to,
        "oscillator",
      );
      return;
    case "replaceOscillator": {
      const array = requireArray(analysis.oscillatorArray, "Oscillator array is computed");
      const old = requireExisting(array.elements, operation.index, "oscillator");
      const replacement = oscillatorTemplate(operation.waveform);
      retainProperties(
        old,
        replacement,
        operation.waveform === "noise" ? ["level"] : ["transposeSemitones", "detuneCents", "level"],
      );
      array.elements[operation.index] = replacement;
      return;
    }
    case "addFilter": {
      const source = requireObject(analysis.sourceObject, "Source object is computed");
      if (propertyFor(source, "filter").kind !== "missing")
        throw new Error("Filter already exists or is computed");
      addProperty(source, "filter", objectTemplate("{ cutoffHz: 1200 }"));
      return;
    }
    case "removeFilter":
      removeProperty(
        requireObject(analysis.sourceObject, "Source object is computed"),
        "filter",
        true,
      );
      return;
    case "addCutoffLfo": {
      const filter = requireObject(
        analysis.filterObject,
        "Add a direct filter before adding its LFO",
      );
      if (propertyFor(filter, "cutoffLfo").kind !== "missing")
        throw new Error("Cutoff LFO already exists or is computed");
      addProperty(filter, "cutoffLfo", objectTemplate("{ rateHz: 1, amountOctaves: 1 }"));
      return;
    }
    case "removeCutoffLfo":
      removeProperty(
        requireObject(analysis.filterObject, "Filter object is computed"),
        "cutoffLfo",
        true,
      );
      return;
    case "addEffect": {
      let array = analysis.effectsArray;
      if (!array) {
        if (propertyFor(analysis.root.object, "effects").kind !== "missing")
          throw new Error("Effects are computed");
        array = b.arrayExpression([]);
        addProperty(analysis.root.object, "effects", array);
      }
      if (array.elements.length >= EFFECT_COUNT_MAX)
        throw new Error("Patch already has seven effects");
      if (operation.index > array.elements.length)
        throw new Error("Effect insertion index is out of range");
      array.elements.splice(operation.index, 0, effectTemplate(operation.effectType));
      return;
    }
    case "removeEffect": {
      const array = requireArray(analysis.effectsArray, "Effects are computed or absent");
      requireExisting(array.elements, operation.index, "effect");
      array.elements.splice(operation.index, 1);
      if (array.elements.length === 0) removeProperty(analysis.root.object, "effects", true);
      return;
    }
    case "moveEffect":
      moveInArray(
        requireArray(analysis.effectsArray, "Effects are computed"),
        operation.from,
        operation.to,
        "effect",
      );
      return;
    case "replaceEffect": {
      const array = requireArray(analysis.effectsArray, "Effects are computed");
      requireExisting(array.elements, operation.index, "effect");
      array.elements[operation.index] = effectTemplate(operation.effectType);
      return;
    }
  }
}

function setField(analysis: InternalAnalysis, path: PatchFieldPath, value: PatchScalar): void {
  const binding = analysis.bindings.find((item) => pathKey(item.path) === pathKey(path));
  if (!binding || binding.sourceForm.kind === "computed")
    throw new Error("This field is computed in code and cannot be edited");
  validateControlValue(binding.control, value);
  let node = analysis.bindingNodes.get(pathKey(path));
  if (!node) throw new Error("Field binding is unavailable");
  let parent = node.parent;
  if (!parent && path[0] === "source" && path[1] === "ampEnvelope") {
    const source = requireObject(analysis.sourceObject, "Source object is computed");
    const envelope = b.objectExpression([]);
    addProperty(source, "ampEnvelope", envelope);
    parent = envelope;
  }
  parent = requireObject(parent, "Containing object is computed");
  const key = String(path.at(-1));
  const literal = scalarNode(value);
  if (node.property) node.property.value = literal;
  else addProperty(parent, key, literal);
}

function resetField(analysis: InternalAnalysis, path: PatchFieldPath): void {
  const binding = analysis.bindings.find((item) => pathKey(item.path) === pathKey(path));
  if (!binding || binding.sourceForm.kind === "computed")
    throw new Error("This field is computed in code and cannot be reset");
  if (binding.control.defaultValue === undefined)
    throw new Error("This required field has no default");
  const node = analysis.bindingNodes.get(pathKey(path));
  if (!node?.property || !node.parent) throw new Error("Field already uses its default");
  removeProperty(node.parent, String(path.at(-1)), true);
  if (path[0] === "source" && path[1] === "ampEnvelope" && node.parent.properties.length === 0) {
    removeProperty(
      requireObject(analysis.sourceObject, "Source object is computed"),
      "ampEnvelope",
      true,
    );
  }
}

function validateControlValue(control: any, value: PatchScalar): void {
  if (control.kind === "number") {
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < control.min ||
      value > control.max ||
      (control.integer && !Number.isInteger(value))
    )
      throw new Error(`${control.label} is outside its supported range`);
    return;
  }
  if (control.kind === "boolean") {
    if (typeof value !== "boolean") throw new Error(`${control.label} must be a boolean`);
    return;
  }
  if (typeof value !== "string" || !control.values.includes(value))
    throw new Error(`${control.label} is unsupported`);
}
function scalarNode(value: PatchScalar): any {
  if (typeof value === "number") return b.numericLiteral(value);
  if (typeof value === "boolean") return b.booleanLiteral(value);
  return b.stringLiteral(value);
}
function oscillatorTemplate(waveform: string): any {
  return objectTemplate(`{ waveform: ${JSON.stringify(waveform)} }`);
}
function effectTemplate(type: "saturator" | "stereoDelay"): any {
  return type === "saturator"
    ? objectTemplate('{ type: "saturator", driveDb: 6 }')
    : objectTemplate('{ type: "stereoDelay", timeSeconds: 0.25, mix: 0.25 }');
}
function objectTemplate(source: string): any {
  const file = parseSource(`const value = ${source};\n`);
  const statement = file.program.body[0] as any;
  const value = statement?.declarations?.[0]?.init;
  if (value?.type !== "ObjectExpression") throw new Error("Invalid Studio object template");
  return value;
}
function retainProperties(oldNode: any, newNode: any, keys: string[]): void {
  if (oldNode?.type !== "ObjectExpression") return;
  for (const key of keys) {
    const lookup = propertyFor(oldNode, key);
    if (lookup.kind === "property") newNode.properties.push(lookup.property);
  }
}
function moveInArray(array: any, from: number, to: number, label: string): void {
  if (from === to) throw new Error(`${label} is already at that position`);
  const item = requireExisting(array.elements, from, label);
  if (to < 0 || to >= array.elements.length)
    throw new Error(`${label} destination is out of range`);
  array.elements.splice(from, 1);
  array.elements.splice(to, 0, item);
}
function addProperty(object: any, key: string, value: any): void {
  const property = b.objectProperty(b.identifier(key), value);
  const rank = PROPERTY_ORDER.indexOf(key as (typeof PROPERTY_ORDER)[number]);
  const index = object.properties.findIndex((candidate: any) => {
    const candidateKey =
      candidate?.key?.type === "Identifier"
        ? candidate.key.name
        : candidate?.key?.type === "StringLiteral"
          ? candidate.key.value
          : "";
    const candidateRank = PROPERTY_ORDER.indexOf(candidateKey as (typeof PROPERTY_ORDER)[number]);
    return rank >= 0 && candidateRank > rank;
  });
  if (index === -1) object.properties.push(property);
  else object.properties.splice(index, 0, property);
}
function removeProperty(object: any, key: string, required: boolean): void {
  const lookup = propertyFor(object, key);
  if (lookup.kind !== "property") {
    if (required) throw new Error(`${key} is absent or computed`);
    return;
  }
  const index = object.properties.indexOf(lookup.property);
  object.properties.splice(index, 1);
}
function requireObject(value: any, message: string): any {
  if (!value || value.type !== "ObjectExpression") throw new Error(message);
  return value;
}
function requireArray(value: any, message: string): any {
  if (!value || value.type !== "ArrayExpression") throw new Error(message);
  return value;
}
function requireExisting(values: any[], index: number, label: string): any {
  const value = values[index];
  if (!value) throw new Error(`${label} index is out of range`);
  return value;
}
