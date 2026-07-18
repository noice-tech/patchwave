import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import chokidar from "chokidar";
import { setupKeyboard, type KeyboardInput } from "./keyboard.js";
import { loadPatch, type LoadedPatch } from "./load-patch.js";
import { ReloadCoordinator } from "./reload.js";

const RELOAD_DEBOUNCE_MS = 100;
const RUNTIME_ERROR_POLL_MS = 250;

export type CliAudioEngine = {
  applyPatch(serializedPatch: string): void;
  setGate(enabled: boolean): void;
  start(): void;
  stop(): void;
  takeRuntimeError(): boolean;
};

export type WatcherLike = {
  on(event: string, listener: (...args: any[]) => void): WatcherLike;
  once(event: string, listener: (...args: any[]) => void): WatcherLike;
  off(event: string, listener: (...args: any[]) => void): WatcherLike;
  close(): Promise<void>;
};

export type SignalSource = {
  on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
};

export type CliLogger = {
  log(message: string): void;
  error(message: string): void;
};

export type RunCliDependencies = {
  args?: string[];
  invocationDirectory?: string;
  input?: KeyboardInput;
  createEngine: () => Promise<CliAudioEngine>;
  load?: (path: string) => Promise<LoadedPatch>;
  watch?: (path: string) => WatcherLike;
  isFile?: (path: string) => Promise<boolean>;
  signals?: SignalSource;
  logger?: CliLogger;
  setExitCode?: (code: number) => void;
};

export async function runCli(dependencies: RunCliDependencies): Promise<number> {
  const args = dependencies.args ?? process.argv.slice(2);
  const invocationDirectory =
    dependencies.invocationDirectory ?? process.env.INIT_CWD ?? process.cwd();
  const input = dependencies.input ?? process.stdin;
  const load = dependencies.load ?? loadPatch;
  const watch =
    dependencies.watch ??
    ((path: string) =>
      chokidar.watch(path, {
        atomic: true,
        ignoreInitial: true,
      }) as unknown as WatcherLike);
  const isFile =
    dependencies.isFile ??
    (async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true);
  const signals = dependencies.signals ?? process;
  const logger = dependencies.logger ?? console;
  const setExitCode = dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));

  let engine: CliAudioEngine | undefined;
  let watcher: WatcherLike | undefined;
  let coordinator: ReloadCoordinator | undefined;
  let cleanupKeyboard: (() => void) | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeErrorTimer: ReturnType<typeof setInterval> | undefined;
  let signalHandlersInstalled = false;
  let shutdownRequested = false;
  let exitCode = 0;
  let resolveShutdown: () => void = () => undefined;
  const shutdownPromise = new Promise<void>((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });

  const markFailure = (): void => {
    exitCode = 1;
    setExitCode(1);
  };

  const restoreKeyboard = (): void => {
    const cleanup = cleanupKeyboard;
    cleanupKeyboard = undefined;
    if (!cleanup) return;
    try {
      cleanup();
    } catch (error) {
      markFailure();
      logger.error(`Failed to restore terminal input: ${errorMessage(error)}`);
    }
  };

  const requestShutdown = (code = 0): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    exitCode = code;
    setExitCode(code);
    restoreKeyboard();
    resolveShutdown();
  };

  const handleSigint = (): void => requestShutdown(0);
  const handleSigterm = (): void => requestShutdown(0);

  try {
    if (args.length !== 1) {
      throw new Error("Usage: pnpm patchwave <path-to-patch.ts>");
    }
    if (!input.isTTY || typeof input.setRawMode !== "function") {
      throw new Error("Interactive terminal input is required");
    }

    const configPath = resolve(invocationDirectory, args[0]);
    if (!(await isFile(configPath))) {
      throw new Error(`Config path is not a file: ${configPath}`);
    }

    let initial: LoadedPatch;
    try {
      initial = await load(configPath);
    } catch (error) {
      throw new Error(`Failed to load initial patch: ${errorMessage(error)}`);
    }

    try {
      engine = await dependencies.createEngine();
    } catch (error) {
      throw new Error(`Failed to open system audio output: ${errorMessage(error)}`);
    }

    try {
      engine.applyPatch(initial.serialized);
      engine.setGate(false);
      engine.start();
    } catch (error) {
      throw new Error(`Failed to start audio: ${errorMessage(error)}`);
    }
    const activeEngine = engine;

    coordinator = new ReloadCoordinator({
      initial,
      load: () => load(configPath),
      engine: activeEngine,
      onApplied: (loaded) => printPatch(loaded, logger),
      onError: (error, retained) => {
        logger.error(`Patch reload failed: ${errorMessage(error)}. Keeping ${retained.summary}.`);
      },
    });

    const scheduleReload = (): void => {
      if (shutdownRequested) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        if (!shutdownRequested) coordinator?.queue();
      }, RELOAD_DEBOUNCE_MS);
    };

    watcher = watch(configPath);
    watcher.on("add", scheduleReload);
    watcher.on("change", scheduleReload);
    watcher.on("unlink", () => {
      logger.error(
        `Patch file removed: ${configPath}. Keeping ${coordinator?.current.summary ?? initial.summary}.`,
      );
    });
    watcher.on("error", (error: unknown) => {
      logger.error(`File watcher failed: ${errorMessage(error)}`);
      requestShutdown(1);
    });
    try {
      await waitForWatcherReady(watcher);
    } catch (error) {
      throw new Error(`File watcher failed: ${errorMessage(error)}`);
    }

    let gateEnabled = false;
    cleanupKeyboard = setupKeyboard(
      {
        onToggle: () => {
          if (shutdownRequested) return;
          try {
            gateEnabled = !gateEnabled;
            activeEngine.setGate(gateEnabled);
            logger.log(`Gate: ${gateEnabled ? "on" : "off"}`);
          } catch (error) {
            logger.error(`Failed to update sound gate: ${errorMessage(error)}`);
            requestShutdown(1);
          }
        },
        onQuit: () => requestShutdown(0),
      },
      input,
    );

    signals.on("SIGINT", handleSigint);
    signals.on("SIGTERM", handleSigterm);
    signalHandlersInstalled = true;

    runtimeErrorTimer = setInterval(() => {
      if (shutdownRequested) return;
      try {
        if (activeEngine.takeRuntimeError()) {
          logger.error("Audio stream reported a runtime error.");
          requestShutdown(1);
        }
      } catch (error) {
        logger.error(`Failed to poll audio runtime status: ${errorMessage(error)}`);
        requestShutdown(1);
      }
    }, RUNTIME_ERROR_POLL_MS);

    logger.log(`Watching ${configPath}`);
    printPatch(initial, logger);
    logger.log("Press Space to gate the synth on or off");
    logger.log("Press q or Ctrl+C to quit");

    await shutdownPromise;
  } finally {
    coordinator?.stop();
    restoreKeyboard();

    if (debounceTimer) clearTimeout(debounceTimer);
    if (runtimeErrorTimer) clearInterval(runtimeErrorTimer);

    if (engine) {
      try {
        engine.setGate(false);
      } catch (error) {
        markFailure();
        logger.error(`Failed to disable sound gate: ${errorMessage(error)}`);
      }
      try {
        engine.stop();
      } catch (error) {
        markFailure();
        logger.error(`Failed to stop audio: ${errorMessage(error)}`);
      }
    }

    if (watcher) {
      try {
        await watcher.close();
      } catch (error) {
        markFailure();
        logger.error(`Failed to close file watcher: ${errorMessage(error)}`);
      }
    }

    if (signalHandlersInstalled) {
      signals.off("SIGINT", handleSigint);
      signals.off("SIGTERM", handleSigterm);
    }
  }

  return exitCode;
}

export function waitForWatcherReady(watcher: WatcherLike): Promise<void> {
  return new Promise((resolveReady, rejectReady) => {
    const handleReady = (): void => {
      watcher.off("error", handleError);
      resolveReady();
    };
    const handleError = (error: unknown): void => {
      watcher.off("ready", handleReady);
      rejectReady(error);
    };
    watcher.once("ready", handleReady);
    watcher.once("error", handleError);
  });
}

function printPatch(loaded: LoadedPatch, logger: CliLogger): void {
  logger.log(`Chain: ${loaded.summary}`);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
