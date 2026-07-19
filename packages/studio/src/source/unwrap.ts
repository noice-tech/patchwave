import type { File } from "@babel/types";

export type LocatedPatchRoot =
  | { mode: "static" | "program"; object: any; diagnostic: null }
  | { mode: "unknown"; object: null; diagnostic: string };

export function unwrapExpression(node: any): any {
  let current = node;
  while (
    current &&
    [
      "TSAsExpression",
      "TSSatisfiesExpression",
      "TypeCastExpression",
      "ParenthesizedExpression",
      "TSNonNullExpression",
    ].includes(current.type)
  ) {
    current = current.expression;
  }
  return current;
}

export function locatePatchRoot(file: File): LocatedPatchRoot {
  const exports = file.program.body.filter(
    (statement: any) => statement.type === "ExportDefaultDeclaration",
  ) as any[];
  if (exports.length !== 1)
    return {
      mode: "unknown",
      object: null,
      diagnostic: "Studio requires one direct default export.",
    };
  const exported = unwrapExpression(exports[0].declaration);
  if (exported?.type === "ObjectExpression")
    return { mode: "static", object: exported, diagnostic: null };
  if (
    exported?.type !== "ArrowFunctionExpression" &&
    exported?.type !== "FunctionExpression" &&
    exported?.type !== "FunctionDeclaration"
  ) {
    return {
      mode: "unknown",
      object: null,
      diagnostic:
        "The default export is indirect or computed; playback works, but Studio will not rewrite it.",
    };
  }
  if (exported.body.type !== "BlockStatement") {
    const object = unwrapExpression(exported.body);
    return object?.type === "ObjectExpression"
      ? { mode: "program", object, diagnostic: null }
      : { mode: "unknown", object: null, diagnostic: "The PatchProgram return value is computed." };
  }
  const returns: any[] = [];
  collectReturns(exported.body, returns);
  if (returns.length !== 1 || !exported.body.body.includes(returns[0])) {
    return {
      mode: "unknown",
      object: null,
      diagnostic: "The PatchProgram must have one direct function-scope return to be editable.",
    };
  }
  const object = unwrapExpression(returns[0].argument);
  return object?.type === "ObjectExpression"
    ? { mode: "program", object, diagnostic: null }
    : {
        mode: "unknown",
        object: null,
        diagnostic: "The PatchProgram return object is indirect or computed.",
      };
}

function collectReturns(node: any, output: any[]): void {
  if (!node || typeof node !== "object") return;
  if (node.type === "ReturnStatement") {
    output.push(node);
    return;
  }
  if (
    ["ArrowFunctionExpression", "FunctionExpression", "FunctionDeclaration"].includes(node.type)
  ) {
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (["loc", "tokens", "comments", "extra"].includes(key)) continue;
    if (Array.isArray(value)) {
      for (const child of value) collectReturns(child, output);
    } else {
      collectReturns(value, output);
    }
  }
}
