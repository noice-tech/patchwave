import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
  KeyboardState,
  startStudioServer,
  type StudioInput,
  type StudioServer,
  type StudioServerOptions,
} from "@patchwave/studio";
import chokidar from "chokidar";
import { loadPatchModule, type PatchModule } from "./load-patch.js";
import { NativeDispatcher, type RuntimeAudioEngine } from "./native-dispatcher.js";
import { PatchRuntime } from "./patch-runtime.js";

const RELOAD_DEBOUNCE_MS = 100;
const RUNTIME_ERROR_POLL_MS = 250;

export type CliAudioEngine = RuntimeAudioEngine;

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
  createEngine: () => Promise<CliAudioEngine>;
  load?: (path: string) => Promise<PatchModule>;
  watch?: (path: string) => WatcherLike;
  isFile?: (path: string) => Promise<boolean>;
  startStudio?: (options: StudioServerOptions) => Promise<StudioServer>;
  openUrl?: (url: string) => void;
  signals?: SignalSource;
  logger?: CliLogger;
  setExitCode?: (code: number) => void;
};

export async function runCli(dependencies: RunCliDependencies): Promise<number> {
  const args = dependencies.args ?? process.argv.slice(2);
  const invocationDirectory =
    dependencies.invocationDirectory ?? process.env.INIT_CWD ?? process.cwd();
  const load = dependencies.load ?? loadPatchModule;
  const watch =
    dependencies.watch ??
    ((path: string) =>
      chokidar.watch(path, { atomic: true, ignoreInitial: true }) as unknown as WatcherLike);
  const isFile =
    dependencies.isFile ??
    (async (path: string) => (await stat(path).catch(() => undefined))?.isFile() === true);
  const createStudio = dependencies.startStudio ?? startStudioServer;
  const openUrl = dependencies.openUrl ?? openStudioUrl;
  const signals = dependencies.signals ?? process;
  const logger = dependencies.logger ?? console;
  const setExitCode = dependencies.setExitCode ?? ((code: number) => (process.exitCode = code));

  let engine: CliAudioEngine | undefined;
  let watcher: WatcherLike | undefined;
  let studio: StudioServer | undefined;
  let dispatcher: NativeDispatcher | undefined;
  let runtime: PatchRuntime | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let runtimeErrorTimer: ReturnType<typeof setInterval> | undefined;
  let signalHandlersInstalled = false;
  let shutdownRequested = false;
  let exitCode = 0;
  let reloadRunning = false;
  let reloadQueued = false;
  const keyboard = new KeyboardState();
  let resolveShutdown: () => void = () => undefined;
  const shutdownPromise = new Promise<void>((resolvePromise) => {
    resolveShutdown = resolvePromise;
  });

  const markFailure = (): void => {
    exitCode = 1;
    setExitCode(1);
  };
  const requestShutdown = (code = 0): void => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    exitCode = code;
    setExitCode(code);
    resolveShutdown();
  };
  const handleSigint = (): void => requestShutdown(0);
  const handleSigterm = (): void => requestShutdown(0);
  const state = (): unknown => ({ ...runtime?.snapshot(), keyboard: keyboard.snapshot() });
  const publish = (): void => studio?.publish(state());
  const releaseAll = (): void => {
    keyboard.releaseAll();
    runtime?.releaseVoice();
    publish();
  };

  try {
    if (args.length !== 1) throw new Error("Usage: pnpm patchwave <path-to-patch.ts>");
    const configPath = resolve(invocationDirectory, args[0]);
    if (!(await isFile(configPath))) throw new Error(`Config path is not a file: ${configPath}`);

    let initial: PatchModule;
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
    const activeEngine = engine;
    dispatcher = new NativeDispatcher({
      engine: activeEngine,
      onError: (error) => {
        logger.error(`Native update failed: ${errorMessage(error)}`);
        requestShutdown(1);
      },
      onOverflow: () => {
        logger.error(
          "Voice event queue overflowed; disconnecting the studio and releasing the voice.",
        );
        releaseAll();
        studio?.disconnect();
      },
    });
    runtime = new PatchRuntime({
      initialModule: initial,
      initialVoice: keyboard.snapshot().voice,
      dispatcher,
      onState: publish,
      onProgramError: (message) => logger.error(`Patch program: ${message}`),
    });

    try {
      activeEngine.start();
    } catch (error) {
      throw new Error(`Failed to start audio: ${errorMessage(error)}`);
    }

    studio = await createStudio({
      onInput: (input) => {
        if (shutdownRequested) return;
        const action = applyStudioInput(keyboard, input);
        if (!runtime?.handleKeyboard(action)) {
          logger.error("Studio input could not be applied; releasing the voice.");
          releaseAll();
          studio?.disconnect();
        }
        publish();
      },
      onControllerClosed: releaseAll,
      getState: state,
    });

    const drainReloads = async (): Promise<void> => {
      if (reloadRunning || shutdownRequested) return;
      reloadRunning = true;
      try {
        do {
          reloadQueued = false;
          try {
            const candidate = await load(configPath);
            if (shutdownRequested) return;
            if (await runtime!.stageReload(candidate)) {
              logger.log(`Reloaded ${candidate.kind} patch at frame ${runtime!.snapshot().frame}`);
            } else {
              logger.error("Patch reload was rejected. Keeping the previous patch program.");
            }
          } catch (error) {
            logger.error(
              `Patch reload failed: ${errorMessage(error)}. Keeping the previous patch program.`,
            );
          }
        } while (reloadQueued && !shutdownRequested);
      } finally {
        reloadRunning = false;
      }
    };
    const scheduleReload = (): void => {
      if (shutdownRequested) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        reloadQueued = true;
        void drainReloads();
      }, RELOAD_DEBOUNCE_MS);
    };

    watcher = watch(configPath);
    watcher.on("add", scheduleReload);
    watcher.on("change", scheduleReload);
    watcher.on("unlink", () =>
      logger.error(`Patch file removed: ${configPath}. Keeping the current program.`),
    );
    watcher.on("error", (error: unknown) => {
      logger.error(`File watcher failed: ${errorMessage(error)}`);
      requestShutdown(1);
    });
    await waitForWatcherReady(watcher).catch((error) => {
      throw new Error(`File watcher failed: ${errorMessage(error)}`);
    });

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

    runtime.start();
    logger.log(`Watching ${configPath}`);
    logger.log(`Studio: ${studio.url}`);
    try {
      openUrl(studio.url);
    } catch (error) {
      logger.error(`Could not open the browser automatically: ${errorMessage(error)}`);
    }
    await shutdownPromise;
  } finally {
    if (debounceTimer) clearTimeout(debounceTimer);
    if (runtimeErrorTimer) clearInterval(runtimeErrorTimer);
    releaseAll();
    runtime?.stop();
    if (studio) {
      try {
        await studio.close();
      } catch (error) {
        markFailure();
        logger.error(`Failed to close studio server: ${errorMessage(error)}`);
      }
    }
    dispatcher?.stop();
    if (engine) {
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

function applyStudioInput(keyboard: KeyboardState, input: StudioInput) {
  switch (input.type) {
    case "keyDown":
      return keyboard.keyDown(input.code);
    case "keyUp":
      return keyboard.keyUp(input.code);
    case "releaseAll":
      return keyboard.releaseAll();
  }
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

function openStudioUrl(url: string): void {
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.once("error", () => undefined);
  child.unref();
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
