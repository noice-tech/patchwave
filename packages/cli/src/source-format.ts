import { format } from "oxfmt";

export async function formatSource(fileName: string, source: string): Promise<string> {
  const result = await format(fileName, source);
  if (result.errors.length > 0) {
    const detail = result.errors.map((error) => error.message).join("; ");
    throw new Error(`Could not format the edited source: ${detail}`);
  }
  return result.code;
}
