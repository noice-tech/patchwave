import type { File } from "@babel/types";
import * as recast from "recast";
import * as babelTsParser from "recast/parsers/babel-ts.js";

export function parseSource(source: string): File {
  return recast.parse(source, { parser: babelTsParser }) as File;
}

export function printSource(file: File): string {
  return recast.print(file, { parser: babelTsParser, trailingComma: true }).code;
}
