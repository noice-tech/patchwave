import type { AudioEngine } from "@patchwave/native";
import { errorMessage, runCli, type CliAudioEngine } from "./cli.js";

type AudioEngineConstructor = new () => AudioEngine;

async function createNativeEngine(): Promise<CliAudioEngine> {
  const AudioEngineClass = await loadAudioEngineConstructor();
  return new AudioEngineClass();
}

async function loadAudioEngineConstructor(): Promise<AudioEngineConstructor> {
  try {
    const addon = (await import("@patchwave/native")) as unknown as Record<
      string,
      unknown
    >;
    const defaultExport = isRecord(addon.default) ? addon.default : undefined;
    const audioEngineExport = addon.AudioEngine ?? defaultExport?.AudioEngine;
    if (typeof audioEngineExport !== "function") {
      throw new Error("AudioEngine export is missing");
    }
    return audioEngineExport as AudioEngineConstructor;
  } catch (error) {
    throw new Error(
      `Failed to load native audio addon. Run "pnpm build" first. ${errorMessage(error)}`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

runCli({ createEngine: createNativeEngine }).catch((error: unknown) => {
  process.exitCode = 1;
  console.error(`Error: ${errorMessage(error)}`);
});
