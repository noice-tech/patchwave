import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EffectType,
  OscillatorWaveform,
  PatchEditOperation,
  PatchFieldPath,
  PatchScalar,
  SourceBinding,
  StudioDocumentPhase,
  StudioDocumentSnapshot,
  StudioEditResult,
  StudioServerMessage,
} from "../../src/index.js";
import { PerformanceKeyCapture } from "./keyboard.js";
import {
  cx,
  eyebrowClass,
  panelHelpClass,
  sourceBadgeClass,
  statusPillClass,
  StudioButton,
} from "./ui.js";
import "./studio.css";

type RuntimeState = any;
type Selection = {
  kind: "source" | "oscillator" | "filter" | "lfo" | "envelope" | "effect" | "safety";
  index?: number;
};
type ConnectionState = "connecting" | "online" | "offline";
type StudioTone = "neutral" | "info" | "warning" | "success" | "danger";
type StudioPresentation = Readonly<{
  label: string;
  detail: string;
  tone: StudioTone;
  busy: boolean;
}>;

const toneClasses: Record<StudioTone, string> = {
  neutral: "text-studio-text-phase",
  info: "text-studio-info",
  warning: "text-studio-warning",
  success: "text-studio-success",
  danger: "text-studio-danger",
};
const connectionToneClasses: Record<ConnectionState, string> = {
  connecting: toneClasses.info,
  online: toneClasses.success,
  offline: toneClasses.danger,
};

const phasePresentation: Record<
  StudioDocumentPhase,
  Omit<StudioPresentation, "detail"> & { detail: string }
> = {
  ready: { label: "Ready", detail: "Audio and source are in sync.", tone: "neutral", busy: false },
  writing: {
    label: "Saving",
    detail: "Writing this edit back to source.",
    tone: "info",
    busy: true,
  },
  previewing: {
    label: "Previewing",
    detail: "Listening to a temporary parameter change.",
    tone: "warning",
    busy: false,
  },
  "source-written": {
    label: "Source saved",
    detail: "Source updated; waiting for audio reload.",
    tone: "info",
    busy: true,
  },
  reloading: {
    label: "Reloading",
    detail: "Loading the updated patch into the audio engine.",
    tone: "info",
    busy: true,
  },
  "audio-accepted": {
    label: "Audio updated",
    detail: "The audio engine accepted the latest source.",
    tone: "success",
    busy: false,
  },
  conflict: {
    label: "Source conflict",
    detail: "The file changed outside Studio. Reload before editing again.",
    tone: "danger",
    busy: false,
  },
  error: {
    label: "Update failed",
    detail: "The last update failed; the previous audio remains active.",
    tone: "danger",
    busy: false,
  },
};

const sourceBadgeToneClasses: Record<SourceBinding["sourceForm"]["kind"], string> = {
  literal: "text-studio-text-panel",
  computed: "text-studio-warning-muted",
  default: "text-studio-info-muted",
};

const serialConnectorClass =
  "after:absolute after:top-1/2 after:-right-2.75 after:h-px after:w-2.75 after:bg-studio-connector after:content-['']";

const parameterClass = "block border-b border-studio-border-parameter py-3.75";
const parameterLabelClass = "mb-2.25 flex items-center justify-between text-studio-copy font-bold";
const nativeSelectClass =
  "w-full appearance-auto rounded-studio-input border border-studio-border-input bg-studio-control-deep p-1.5 text-studio-text-strong focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-studio-accent-strong disabled:cursor-not-allowed disabled:opacity-50";
const noteClass =
  "mt-3.5 rounded-studio-note border border-studio-note-border bg-studio-note-bg p-2.5 text-studio-copy leading-[1.5] text-studio-note";

const keyboardKeys = [
  { code: "KeyA", label: "A", raised: false },
  { code: "KeyW", label: "W", raised: true },
  { code: "KeyS", label: "S", raised: false },
  { code: "KeyE", label: "E", raised: true },
  { code: "KeyD", label: "D", raised: false },
  { code: "KeyF", label: "F", raised: false },
  { code: "KeyT", label: "T", raised: true },
  { code: "KeyG", label: "G", raised: false },
  { code: "KeyY", label: "Y", raised: true },
  { code: "KeyH", label: "H", raised: false },
  { code: "KeyU", label: "U", raised: true },
  { code: "KeyJ", label: "J", raised: false },
  { code: "KeyK", label: "K", raised: false },
] as const;
const performanceCodes = new Set([...keyboardKeys.map(({ code }) => code), "KeyZ", "KeyX"]);

function studioPresentation(
  connection: ConnectionState,
  runtime: RuntimeState,
  document: StudioDocumentSnapshot | undefined,
  pendingRequest: string | undefined,
  notice: string,
  rejectedMessage: string | undefined,
): StudioPresentation {
  if (connection === "connecting") {
    return {
      label: "Connecting",
      detail: "Opening the local Studio audio connection.",
      tone: "info",
      busy: true,
    };
  }
  if (connection === "offline") {
    return {
      label: "Offline",
      detail: "Playback and editing are unavailable. Restart Patchwave to reconnect.",
      tone: "danger",
      busy: false,
    };
  }
  if (!runtime || !document) {
    return {
      label: "Loading patch",
      detail: "Connected; waiting for the first patch state.",
      tone: "info",
      busy: true,
    };
  }
  if (runtime.error) {
    return {
      label: "Audio error",
      detail: String(runtime.error),
      tone: "danger",
      busy: false,
    };
  }
  const base = phasePresentation[document.phase];
  if (document.phase === "conflict" || document.phase === "error") {
    return { ...base, detail: document.diagnostic || notice || base.detail };
  }
  if (rejectedMessage) {
    return {
      label: "Edit rejected",
      detail: rejectedMessage,
      tone: "danger",
      busy: false,
    };
  }
  if (pendingRequest && !base.busy) {
    return {
      label: "Applying edit",
      detail: "Waiting for Studio to confirm this source change.",
      tone: "info",
      busy: true,
    };
  }
  return base;
}

function requestId(): string {
  return crypto.randomUUID();
}
function pathEqual(a: PatchFieldPath, b: PatchFieldPath): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function App() {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [runtime, setRuntime] = useState<RuntimeState>();
  const [document, setDocument] = useState<StudioDocumentSnapshot>();
  const [selection, setSelection] = useState<Selection>({ kind: "source" });
  const [notice, setNotice] = useState("Connecting…");
  const [rejectedMessage, setRejectedMessage] = useState<string | undefined>(undefined);
  const [pendingRequest, setPendingRequest] = useState<string | undefined>(undefined);
  const pendingRequestRef = useRef<string | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);
  const performanceCapture = useRef(new PerformanceKeyCapture());

  const send = useCallback((message: unknown): boolean => {
    const current = socket.current;
    if (current?.readyState !== WebSocket.OPEN) return false;
    try {
      current.send(JSON.stringify(message));
      return true;
    } catch {
      try {
        current.close();
      } catch {
        // The transport is already unusable; server disconnect cleanup remains authoritative.
      }
      return false;
    }
  }, []);
  const edit = useCallback(
    (operation: PatchEditOperation, gestureId: string | null = null): boolean => {
      if (
        !document ||
        !document.writable ||
        document.phase === "conflict" ||
        pendingRequestRef.current
      )
        return false;
      setRejectedMessage(undefined);
      const id = requestId();
      pendingRequestRef.current = id;
      setPendingRequest(id);
      if (
        send({
          type: "commit",
          protocol: 1,
          requestId: id,
          gestureId,
          baseRevision: document.revision,
          operation,
        })
      )
        return true;
      pendingRequestRef.current = undefined;
      setPendingRequest(undefined);
      return false;
    },
    [document, send],
  );

  useEffect(() => {
    const url = new URL("./socket", window.location.href);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(url);
    socket.current = ws;
    ws.addEventListener("open", () => {
      performanceCapture.current.clear();
      setRejectedMessage(undefined);
      setConnection("online");
      setNotice("Audio running.");
    });
    ws.addEventListener("close", () => {
      performanceCapture.current.clear();
      pendingRequestRef.current = undefined;
      setPendingRequest(undefined);
      setConnection("offline");
      setNotice("Studio disconnected. Restart Patchwave to reconnect.");
    });
    ws.addEventListener("message", (event) => {
      try {
        const message = JSON.parse(String(event.data)) as StudioServerMessage;
        if (message.type === "state") {
          const state = message.state as RuntimeState;
          setRuntime(state);
          if (state?.document) setDocument(state.document);
          setNotice(
            state?.error || state?.document?.diagnostic || state?.status || "Audio running",
          );
        } else if (message.type === "document") setDocument(message.document);
        else {
          const result = message as StudioEditResult;
          if (pendingRequestRef.current === result.requestId) {
            pendingRequestRef.current = undefined;
            setPendingRequest(undefined);
          }
          if (result.document) setDocument(result.document);
          setRejectedMessage(
            result.status === "rejected"
              ? (result.message ?? "Studio could not apply this edit.")
              : undefined,
          );
          setNotice(
            result.message ??
              (result.status === "committed" ? "Saved to code; reloading audio…" : result.status),
          );
        }
      } catch {
        ws.close();
      }
    });
    return () => {
      performanceCapture.current.clear();
      window.dispatchEvent(new Event("patchwave-cancel-gestures"));
      try {
        if (ws.readyState === WebSocket.OPEN) send({ type: "releaseAll" });
      } finally {
        try {
          ws.close();
        } catch {
          // The transport is already unusable.
        }
      }
    };
  }, [send]);

  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      const result = performanceCapture.current.keyDown(
        event,
        performanceCodes,
        socket.current?.readyState === WebSocket.OPEN,
      );
      if (!result.captured) return;
      if (result.send && !send({ type: "keyDown", code: event.code })) {
        performanceCapture.current.keyUp(event.code);
        return;
      }
      event.preventDefault();
    };
    const up = (event: KeyboardEvent) => {
      if (!performanceCapture.current.keyUp(event.code)) return;
      event.preventDefault();
      send({ type: "keyUp", code: event.code });
    };
    const release = () => {
      performanceCapture.current.clear();
      window.dispatchEvent(new Event("patchwave-cancel-gestures"));
      send({ type: "releaseAll" });
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    window.addEventListener("blur", release);
    const visibility = () => {
      if (globalThis.document.hidden) release();
    };
    globalThis.document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
      window.removeEventListener("blur", release);
      globalThis.document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", release);
      performanceCapture.current.clear();
      window.dispatchEvent(new Event("patchwave-cancel-gestures"));
    };
  }, [send]);

  const patch = runtime?.patch;
  const bindings = useMemo(
    () => document?.bindings.filter((binding) => matchesSelection(binding.path, selection)) ?? [],
    [document, selection],
  );
  const presentation = studioPresentation(
    connection,
    runtime,
    document,
    pendingRequest,
    notice,
    rejectedMessage,
  );
  const busy = presentation.busy;
  const controlsDisabled =
    busy || connection !== "online" || !document?.writable || document.phase === "conflict";
  const keyboard = connection === "online" ? runtime?.keyboard : undefined;
  const heldCodes = new Set<string>(keyboard?.heldCodes ?? []);
  const history = (type: "undo" | "redo") => {
    if (controlsDisabled || !document || pendingRequestRef.current) return;
    setRejectedMessage(undefined);
    const id = requestId();
    pendingRequestRef.current = id;
    setPendingRequest(id);
    if (!send({ type, protocol: 1, requestId: id, baseRevision: document.revision })) {
      pendingRequestRef.current = undefined;
      setPendingRequest(undefined);
    }
  };

  useEffect(() => {
    if (!patch) return;
    setSelection((current) => {
      if (current.kind === "oscillator" && current.index! >= patch.source.oscillators.length)
        return { kind: "source" };
      if (current.kind === "effect" && current.index! >= patch.effects.length)
        return { kind: "source" };
      if (current.kind === "filter" && !patch.source.filter) return { kind: "source" };
      if (current.kind === "lfo" && !patch.source.filter?.cutoffLfo)
        return patch.source.filter ? { kind: "filter" } : { kind: "source" };
      return current;
    });
  }, [patch?.source?.oscillators?.length, patch?.source?.filter, patch?.effects?.length]);

  return (
    <main className="isolate grid h-dvh min-w-80 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden font-studio text-studio-text antialiased [background:radial-gradient(circle_at_70%_-10%,#183a2d_0,transparent_38%),var(--color-studio-canvas)] [font-synthesis:none] [line-height:normal] max-studio-mobile:h-auto max-studio-mobile:min-h-dvh max-studio-mobile:overflow-visible">
      <header className="flex h-[4.5rem] items-center justify-between border-b border-studio-border bg-studio-panel/91 px-5 py-[0.8125rem] backdrop-blur-[1.125rem] max-studio-mobile:h-auto">
        <div>
          <p className={eyebrowClass}>PATCHWAVE</p>
          <h1 className="text-studio-title font-bold tracking-[-0.04em]">Studio</h1>
        </div>
        <div className="flex items-center gap-2">
          <StudioButton
            disabled={!document?.canUndo || controlsDisabled}
            onClick={() => history("undo")}
          >
            Undo
          </StudioButton>
          <StudioButton
            disabled={!document?.canRedo || controlsDisabled}
            onClick={() => history("redo")}
          >
            Redo
          </StudioButton>
          <span
            className={cx(
              statusPillClass,
              connectionToneClasses[connection],
              "max-studio-mobile:hidden",
            )}
          >
            {connection === "online"
              ? "Connected"
              : connection === "connecting"
                ? "Connecting"
                : "Disconnected"}
          </span>
        </div>
      </header>

      <section
        className="grid min-h-0 grid-cols-[13.125rem_minmax(18.75rem,1fr)_17.5rem] overflow-hidden max-studio-tablet:grid-cols-[10rem_minmax(16.25rem,1fr)] max-studio-mobile:block max-studio-mobile:overflow-visible"
        aria-busy={busy}
      >
        <aside className="overflow-auto border-r border-studio-border bg-studio-panel p-studio-panel max-studio-tablet:p-3.25 max-studio-mobile:border-r-0 max-studio-mobile:border-b">
          <h2 className="text-studio-section font-bold">Devices</h2>
          <p className={panelHelpClass}>Add devices to the serial signal path.</p>
          {!document && (
            <p className="mt-3 text-studio-meta leading-4 text-studio-text-status">
              {connection === "offline"
                ? "Device controls are unavailable while Studio is offline."
                : "Device controls unlock after the patch loads."}
            </p>
          )}
          <h3 className="mt-studio-rack mb-2 text-studio-meta font-bold tracking-widest text-studio-text-subtle uppercase">
            Oscillator
          </h3>
          <div className="grid gap-1.5 max-studio-mobile:grid-cols-2">
            {["sine", "triangle", "saw", "pulse", "noise"].map((waveform) => (
              <StudioButton
                key={waveform}
                className="text-left capitalize"
                disabled={
                  controlsDisabled ||
                  !document?.editableStructure.oscillators ||
                  (patch?.source?.oscillators?.length ?? 4) >= 4
                }
                onClick={() =>
                  edit({
                    type: "addOscillator",
                    index: patch.source.oscillators.length,
                    waveform: waveform as OscillatorWaveform,
                  })
                }
              >
                + {waveform}
              </StudioButton>
            ))}
          </div>
          <h3 className="mt-studio-rack mb-2 text-studio-meta font-bold tracking-widest text-studio-text-subtle uppercase">
            Source
          </h3>
          <div className="grid gap-1.5 max-studio-mobile:grid-cols-2">
            {!patch?.source?.filter ? (
              <StudioButton
                className="text-left capitalize"
                disabled={controlsDisabled || !document?.editableStructure.filter}
                onClick={() => edit({ type: "addFilter" })}
              >
                + Filter
              </StudioButton>
            ) : !patch.source.filter.cutoffLfo ? (
              <StudioButton
                className="text-left capitalize"
                disabled={controlsDisabled || !document?.editableStructure.cutoffLfo}
                onClick={() => edit({ type: "addCutoffLfo" })}
              >
                + Cutoff LFO
              </StudioButton>
            ) : null}
          </div>
          <h3 className="mt-studio-rack mb-2 text-studio-meta font-bold tracking-widest text-studio-text-subtle uppercase">
            Effects
          </h3>
          <div className="grid gap-1.5 max-studio-mobile:grid-cols-2">
            <StudioButton
              className="text-left capitalize"
              disabled={
                controlsDisabled ||
                !document?.editableStructure.effects ||
                (patch?.effects?.length ?? 7) >= 7
              }
              onClick={() =>
                edit({ type: "addEffect", index: patch.effects.length, effectType: "saturator" })
              }
            >
              + Saturator
            </StudioButton>
            <StudioButton
              className="text-left capitalize"
              disabled={
                controlsDisabled ||
                !document?.editableStructure.effects ||
                (patch?.effects?.length ?? 7) >= 7
              }
              onClick={() =>
                edit({ type: "addEffect", index: patch.effects.length, effectType: "stereoDelay" })
              }
            >
              + Stereo delay
            </StudioButton>
          </div>
        </aside>

        <section className="overflow-hidden bg-[linear-gradient(var(--color-studio-grid)_1px,transparent_1px),linear-gradient(90deg,var(--color-studio-grid)_1px,transparent_1px)] bg-size-[1.5rem_1.5rem] p-studio-rack max-studio-mobile:p-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className={eyebrowClass}>SIGNAL PATH</p>
              <h2 className="mt-1 text-studio-control-size font-medium text-studio-text-panel">
                {runtime?.summary ??
                  (connection === "offline" ? "Patch unavailable" : "Waiting for patch")}
              </h2>
            </div>
            <span
              className={cx(statusPillClass, "bg-studio-phase", toneClasses[presentation.tone])}
            >
              {presentation.label}
            </span>
          </div>
          {!patch ? (
            <div className="mt-9 flex min-h-62.5 items-center justify-center rounded-studio-mix border border-dashed border-studio-border-mix bg-studio-panel/40 p-8 text-center">
              <div className="grid max-w-xs gap-2">
                <strong className="text-studio-control-size">{presentation.label}</strong>
                <p className="text-studio-copy leading-5 text-studio-text-status">
                  {presentation.detail}
                </p>
              </div>
            </div>
          ) : (
            <div
              className="flex min-h-62.5 items-stretch gap-2.5 overflow-x-auto px-1.5 pt-9 pb-6"
              aria-label="Serial signal chain"
            >
              <div
                className={cx(
                  "relative flex gap-2 rounded-studio-mix border border-studio-border-mix bg-studio-mix p-2",
                  serialConnectorClass,
                )}
                role="group"
                aria-label="Source oscillator mix"
              >
                <Device
                  compact
                  title="Oscillator mix"
                  detail={`${patch?.source?.oscillators?.length ?? 0} oscillators · ${format(patch?.source?.frequencyHz)} Hz`}
                  selected={selection.kind === "source"}
                  onClick={() => setSelection({ kind: "source" })}
                />
                {(patch?.source?.oscillators ?? []).map((osc: any, index: number) => (
                  <Device
                    compact
                    key={`osc-${index}`}
                    title={`Oscillator ${index + 1}`}
                    detail={osc.waveform}
                    selected={selection.kind === "oscillator" && selection.index === index}
                    onClick={() => setSelection({ kind: "oscillator", index })}
                    drag={
                      document?.editableStructure.oscillators && !controlsDisabled
                        ? {
                            group: "oscillator",
                            index,
                            onMove: (from, to) => edit({ type: "moveOscillator", from, to }),
                          }
                        : undefined
                    }
                    actions={
                      document?.editableStructure.oscillators ? (
                        <BlockActions
                          label={`Oscillator ${index + 1}`}
                          disabled={controlsDisabled}
                          canRemove={patch.source.oscillators.length > 1}
                          index={index}
                          count={patch.source.oscillators.length}
                          onMove={(to) => edit({ type: "moveOscillator", from: index, to })}
                          onRemove={() => edit({ type: "removeOscillator", index })}
                        />
                      ) : null
                    }
                  />
                ))}
              </div>
              {patch?.source?.filter && (
                <Device
                  connector
                  title="Filter"
                  detail={`${patch.source.filter.mode}${
                    patch.source.filter.cutoffLfo
                      ? ` · modulated by ${patch.source.filter.cutoffLfo.shape} LFO`
                      : ""
                  }`}
                  selected={selection.kind === "filter" || selection.kind === "lfo"}
                  onClick={() => setSelection({ kind: "filter" })}
                  actions={
                    <>
                      {patch.source.filter.cutoffLfo && (
                        <StudioButton
                          size="block"
                          aria-label="Edit cutoff LFO"
                          disabled={controlsDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            setSelection({ kind: "lfo" });
                          }}
                        >
                          LFO
                        </StudioButton>
                      )}
                      {patch.source.filter.cutoffLfo && document?.editableStructure.cutoffLfo && (
                        <StudioButton
                          size="block"
                          aria-label="Remove cutoff LFO"
                          disabled={controlsDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            edit({ type: "removeCutoffLfo" });
                          }}
                        >
                          − LFO
                        </StudioButton>
                      )}
                      {document?.editableStructure.filter && (
                        <StudioButton
                          size="block"
                          aria-label="Remove filter"
                          disabled={controlsDisabled}
                          onClick={(event) => {
                            event.stopPropagation();
                            edit({ type: "removeFilter" });
                          }}
                        >
                          Remove
                        </StudioButton>
                      )}
                    </>
                  }
                />
              )}
              <Device
                connector
                title="Envelope"
                detail="Amplitude"
                selected={selection.kind === "envelope"}
                onClick={() => setSelection({ kind: "envelope" })}
              />
              {(patch?.effects ?? []).map((effect: any, index: number) => (
                <Device
                  connector
                  key={`effect-${index}`}
                  title={effect.type === "saturator" ? "Saturator" : "Stereo delay"}
                  detail={`Effect ${index + 1}`}
                  selected={selection.kind === "effect" && selection.index === index}
                  onClick={() => setSelection({ kind: "effect", index })}
                  drag={
                    document?.editableStructure.effects && !controlsDisabled
                      ? {
                          group: "effect",
                          index,
                          onMove: (from, to) => edit({ type: "moveEffect", from, to }),
                        }
                      : undefined
                  }
                  actions={
                    document?.editableStructure.effects ? (
                      <BlockActions
                        label={`Effect ${index + 1}`}
                        disabled={controlsDisabled}
                        canRemove
                        index={index}
                        count={patch.effects.length}
                        onMove={(to) => edit({ type: "moveEffect", from: index, to })}
                        onRemove={() => edit({ type: "removeEffect", index })}
                      />
                    ) : null
                  }
                />
              ))}
              <Device
                title="Safety"
                detail="Finite · bounded · stereo"
                selected={selection.kind === "safety"}
                onClick={() => setSelection({ kind: "safety" })}
              />
            </div>
          )}
        </section>

        <aside className="overflow-auto border-l border-studio-border bg-studio-panel p-studio-panel max-studio-tablet:col-span-full max-studio-tablet:max-h-77.5 max-studio-tablet:border-t max-studio-tablet:border-l-0 max-studio-mobile:max-h-none">
          <h2 className="text-studio-section font-bold">Inspector</h2>
          <p className={panelHelpClass}>{selectionLabel(selection)}</p>
          {busy && (
            <p className="mt-3 rounded-studio-note border border-studio-border bg-studio-phase p-2.5 text-studio-copy text-studio-info">
              {presentation.detail}
            </p>
          )}
          {document && !document.writable && (
            <div className={noteClass}>
              <strong>Read-only source.</strong>
              <p className="mt-1">
                {document.diagnostic ?? "This patch cannot be edited in Studio."}
              </p>
            </div>
          )}
          {selection.kind === "oscillator" && document?.editableStructure.oscillators && (
            <label className={parameterClass}>
              <span className={parameterLabelClass}>
                <span>Waveform</span>
                <span className={cx(sourceBadgeClass, sourceBadgeToneClasses.literal)}>
                  structure
                </span>
              </span>
              <select
                className={nativeSelectClass}
                name="oscillator.waveform"
                disabled={controlsDisabled}
                value={patch?.source?.oscillators?.[selection.index!]?.waveform ?? "sine"}
                onChange={(event) =>
                  edit({
                    type: "replaceOscillator",
                    index: selection.index!,
                    waveform: event.target.value as OscillatorWaveform,
                  })
                }
              >
                {["sine", "triangle", "saw", "pulse", "noise"].map((waveform) => (
                  <option key={waveform}>{waveform}</option>
                ))}
              </select>
            </label>
          )}
          {selection.kind === "effect" && document?.editableStructure.effects && (
            <label className={parameterClass}>
              <span className={parameterLabelClass}>
                <span>Effect kind</span>
                <span className={cx(sourceBadgeClass, sourceBadgeToneClasses.literal)}>
                  structure
                </span>
              </span>
              <select
                className={nativeSelectClass}
                name="effect.kind"
                disabled={controlsDisabled}
                value={patch?.effects?.[selection.index!]?.type ?? "saturator"}
                onChange={(event) =>
                  edit({
                    type: "replaceEffect",
                    index: selection.index!,
                    effectType: event.target.value as EffectType,
                  })
                }
              >
                <option value="saturator">saturator</option>
                <option value="stereoDelay">stereo delay</option>
              </select>
            </label>
          )}
          {!document ? (
            <p className={noteClass}>
              {connection === "offline"
                ? "Inspector unavailable while Studio is offline."
                : "Inspector controls will appear after the patch loads."}
            </p>
          ) : selection.kind === "safety" ? (
            <p className={noteClass}>
              The safety guard is always active and is not source-editable.
            </p>
          ) : bindings.length === 0 ? (
            <p className={noteClass}>
              No editable parameters are available for this block. Select another device or edit its
              source directly.
            </p>
          ) : (
            bindings.map((binding) => (
              <Parameter
                key={JSON.stringify(binding.path)}
                binding={binding}
                value={
                  binding.sourceForm.kind === "computed"
                    ? valueAt(patch, binding.path)
                    : binding.sourceForm.value
                }
                revision={document!.revision}
                disabled={controlsDisabled}
                send={send}
                onCommit={edit}
              />
            ))
          )}
        </aside>
      </section>

      <footer className="grid min-h-28 grid-cols-[13.125rem_minmax(0,1fr)_17.5rem] items-center gap-studio-panel border-t border-studio-border bg-studio-panel-subtle px-5 py-3 max-studio-tablet:grid-cols-[9.375rem_1fr] max-studio-mobile:block">
        <div className="grid gap-1">
          <p className={eyebrowClass}>PERFORMANCE</p>
          <p className="text-studio-value font-bold tabular-nums">
            {keyboard?.activeNoteLabel ?? "—"}
          </p>
          <p className="text-studio-meta text-studio-text-muted tabular-nums">
            Octave {keyboard?.octaveLabel ?? "—"} · {format(keyboard?.voice?.frequencyHz)} Hz · gate{" "}
            {keyboard?.voice?.gate ? "open" : "closed"}
          </p>
        </div>
        <div className="grid min-w-0 gap-2">
          <div className="overflow-x-auto px-1 py-2" aria-label="Note keys A through K">
            <div className="flex w-max min-w-full items-end justify-center gap-1.25">
              {keyboardKeys.map(({ code, label, raised }) => {
                const held = heldCodes.has(code);
                const active = keyboard?.activeCode === code;
                return (
                  <kbd
                    key={code}
                    data-held={held || undefined}
                    aria-label={`${label} note key${held ? ", held" : ""}`}
                    className={cx(
                      "min-w-7 rounded-studio-key border px-1.75 py-3 text-center font-mono text-studio-meta font-bold",
                      raised
                        ? "-translate-y-1.5 bg-studio-key-dark text-studio-key-dark-text shadow-studio-key-dark"
                        : "bg-studio-key text-studio-key-text shadow-studio-key",
                      held
                        ? "border-studio-accent-strong ring-2 ring-studio-accent-strong/40"
                        : "border-studio-border-key",
                      active &&
                        "-translate-y-1 bg-studio-accent text-studio-key-text shadow-studio-key",
                    )}
                  >
                    {label}
                  </kbd>
                );
              })}
            </div>
          </div>
          <p className="text-center text-studio-meta leading-4 text-studio-text-status max-studio-mobile:text-left">
            Play A–K · octave down Z · octave up X · Cmd/Ctrl/Alt shortcuts stay native.
          </p>
        </div>
        <div className="grid gap-2 max-studio-tablet:col-span-full">
          <div className="flex items-center gap-2" aria-label="Octave controls">
            <kbd className="rounded-studio-key border border-studio-border-key bg-studio-control px-2 py-1 font-mono text-studio-meta font-bold">
              Z
            </kbd>
            <span aria-hidden="true" className="text-studio-text-muted">
              ←
            </span>
            <span className="text-studio-meta text-studio-text-status">Octave</span>
            <span aria-hidden="true" className="text-studio-text-muted">
              →
            </span>
            <kbd className="rounded-studio-key border border-studio-border-key bg-studio-control px-2 py-1 font-mono text-studio-meta font-bold">
              X
            </kbd>
          </div>
          <p
            role="status"
            aria-live="polite"
            className={cx("text-studio-meta leading-4", toneClasses[presentation.tone])}
          >
            <strong>{presentation.label}.</strong> {presentation.detail}
          </p>
        </div>
      </footer>
    </main>
  );
}

function Device({
  title,
  detail,
  selected,
  onClick,
  actions,
  drag,
  compact = false,
  connector = false,
}: {
  title: string;
  detail: string;
  selected: boolean;
  onClick: () => void;
  actions?: React.ReactNode;
  drag?: {
    group: "oscillator" | "effect";
    index: number;
    onMove: (from: number, to: number) => void;
  };
  compact?: boolean;
  connector?: boolean;
}) {
  return (
    <article
      className={cx(
        "relative min-h-41.25 rounded-studio-device border bg-[linear-gradient(145deg,var(--color-studio-card),var(--color-studio-card-deep))] p-4 outline-none",
        compact ? "flex-[0_0_8.25rem]" : "flex-[0_0_9.75rem]",
        selected
          ? "border-studio-accent-strong shadow-studio-device-selected hover:border-studio-accent-strong [&:has([data-device-select]:focus-visible)]:border-studio-accent-strong"
          : "border-studio-border-card shadow-studio-device hover:border-studio-border-card-hover [&:has([data-device-select]:focus-visible)]:border-studio-border-card-hover",
        connector && serialConnectorClass,
      )}
      draggable={Boolean(drag)}
      onDragStart={(event) => {
        if (!drag) return;
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(
          "application/x-patchwave-block",
          JSON.stringify({ group: drag.group, index: drag.index }),
        );
      }}
      onDragOver={(event) => {
        if (drag) event.preventDefault();
      }}
      onDrop={(event) => {
        if (!drag) return;
        event.preventDefault();
        try {
          const source = JSON.parse(event.dataTransfer.getData("application/x-patchwave-block"));
          if (
            source.group === drag.group &&
            Number.isInteger(source.index) &&
            source.index !== drag.index
          ) {
            drag.onMove(source.index, drag.index);
          }
        } catch {
          // Ignore unrelated drag payloads.
        }
      }}
    >
      <button
        type="button"
        data-device-select
        className="block w-full cursor-pointer border-0 bg-transparent p-0 text-left text-inherit focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-studio-accent-strong"
        aria-pressed={selected}
        aria-label={`Edit ${title}`}
        onClick={onClick}
      >
        <span className="mb-11.25 block size-1.75 rounded-full bg-studio-accent shadow-studio-led" />
        <span className="block text-studio-control-size font-bold">{title}</span>
        <span className="mt-1.25 block text-studio-meta leading-[1.4] text-studio-text-muted">
          {detail}
        </span>
      </button>
      {actions && <div className="absolute inset-x-2.25 bottom-2.25 flex gap-1">{actions}</div>}
    </article>
  );
}
function BlockActions({
  label,
  disabled,
  canRemove,
  index,
  count,
  onMove,
  onRemove,
}: {
  label: string;
  disabled: boolean;
  canRemove: boolean;
  index: number;
  count: number;
  onMove: (to: number) => void;
  onRemove: () => void;
}) {
  return (
    <>
      <StudioButton
        size="block"
        aria-label={`Move ${label} left`}
        disabled={disabled || index === 0}
        onClick={(e) => {
          e.stopPropagation();
          onMove(index - 1);
        }}
      >
        ←
      </StudioButton>
      <StudioButton
        size="block"
        aria-label={`Move ${label} right`}
        disabled={disabled || index === count - 1}
        onClick={(e) => {
          e.stopPropagation();
          onMove(index + 1);
        }}
      >
        →
      </StudioButton>
      <StudioButton
        size="block"
        aria-label={`Remove ${label}`}
        disabled={disabled || !canRemove}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        Remove
      </StudioButton>
    </>
  );
}
function Parameter({
  binding,
  value,
  revision,
  disabled,
  send,
  onCommit,
}: {
  binding: SourceBinding;
  value: PatchScalar;
  revision: string;
  disabled: boolean;
  send: (message: unknown) => boolean;
  onCommit: (operation: PatchEditOperation, gesture?: string | null) => boolean;
}) {
  const labelId = useId();
  const computedHelpId = `${labelId}-computed-help`;
  const controlName = binding.path.map(String).join(".");
  const [draft, setDraft] = useState<PatchScalar>(value);
  const draftRef = useRef<PatchScalar>(value);
  const initialRef = useRef<PatchScalar>(value);
  const gesture = useRef<string | undefined>(undefined);
  const pendingPreview = useRef<PatchScalar | undefined>(undefined);
  const previewFrame = useRef<number | undefined>(undefined);
  const cancelRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    if (gesture.current) return;
    initialRef.current = value;
    draftRef.current = value;
    setDraft(value);
  }, [value]);
  const computed = binding.sourceForm.kind === "computed";
  const begin = () => {
    if (!gesture.current) {
      gesture.current = requestId();
      initialRef.current = value;
    }
    return gesture.current;
  };
  const sendPreview = (id: string, next: PatchScalar) =>
    send({
      type: "preview",
      protocol: 1,
      requestId: requestId(),
      gestureId: id,
      baseRevision: revision,
      path: binding.path,
      value: next,
    });
  const preview = (next: PatchScalar) => {
    const id = begin();
    draftRef.current = next;
    setDraft(next);
    pendingPreview.current = next;
    if (previewFrame.current !== undefined) return;
    previewFrame.current = requestAnimationFrame(() => {
      previewFrame.current = undefined;
      const latest = pendingPreview.current;
      pendingPreview.current = undefined;
      if (latest !== undefined && gesture.current === id) sendPreview(id, latest);
    });
  };
  const cancel = () => {
    const id = gesture.current;
    if (!id) return;
    if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = undefined;
    pendingPreview.current = undefined;
    send({ type: "cancelPreview", protocol: 1, requestId: requestId(), gestureId: id });
    gesture.current = undefined;
    draftRef.current = initialRef.current;
    setDraft(initialRef.current);
  };
  cancelRef.current = cancel;
  useEffect(() => {
    const cancelActive = () => cancelRef.current();
    window.addEventListener("patchwave-cancel-gestures", cancelActive);
    return () => {
      window.removeEventListener("patchwave-cancel-gestures", cancelActive);
      cancelActive();
    };
  }, []);
  const commit = () => {
    const id = gesture.current;
    if (!id) return;
    if (previewFrame.current !== undefined) cancelAnimationFrame(previewFrame.current);
    previewFrame.current = undefined;
    const latest = pendingPreview.current;
    pendingPreview.current = undefined;
    if (latest !== undefined) sendPreview(id, latest);
    if (Object.is(draftRef.current, initialRef.current)) {
      cancel();
      return;
    }
    if (onCommit({ type: "setField", path: binding.path, value: draftRef.current }, id))
      gesture.current = undefined;
  };
  return (
    <div className={parameterClass}>
      <div className={parameterLabelClass} id={labelId}>
        <span>{binding.control.label}</span>
        <span className={cx(sourceBadgeClass, sourceBadgeToneClasses[binding.sourceForm.kind])}>
          {binding.sourceForm.kind}
        </span>
      </div>
      {binding.control.kind === "number" ? (
        <>
          <input
            id={`${labelId}-slider`}
            className="w-full appearance-auto accent-studio-accent focus-visible:outline-2 focus-visible:outline-studio-accent-strong"
            name={`${controlName}.slider`}
            aria-labelledby={labelId}
            aria-describedby={computed ? computedHelpId : undefined}
            type="range"
            disabled={computed || disabled}
            min={binding.control.min}
            max={binding.control.max}
            step={binding.control.step}
            value={Number(draft)}
            onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
            onChange={(event) => preview(Number(event.target.value))}
            onPointerUp={commit}
            onPointerCancel={cancel}
            onLostPointerCapture={commit}
            onKeyUp={(event) => {
              if (
                [
                  "ArrowLeft",
                  "ArrowRight",
                  "ArrowUp",
                  "ArrowDown",
                  "PageUp",
                  "PageDown",
                  "Home",
                  "End",
                ].includes(event.key)
              )
                commit();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") cancel();
            }}
          />
          <div className="mt-1.5 grid grid-cols-[1fr_auto] items-center gap-2">
            <input
              id={`${labelId}-number`}
              className="w-full rounded-studio-input border border-studio-border-input bg-studio-control-deep p-1.5 text-studio-text-strong tabular-nums focus-visible:-outline-offset-1 focus-visible:outline-2 focus-visible:outline-studio-accent-strong disabled:cursor-not-allowed disabled:opacity-50"
              name={`${controlName}.number`}
              aria-labelledby={labelId}
              aria-describedby={computed ? computedHelpId : undefined}
              type="number"
              disabled={computed || disabled}
              min={binding.control.min}
              max={binding.control.max}
              step={binding.control.step}
              value={Number(draft)}
              onChange={(event) => preview(Number(event.target.value))}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                if (event.key === "Escape") cancel();
              }}
            />
            <p className="text-studio-caption text-studio-text-subtle">{binding.control.unit}</p>
          </div>
        </>
      ) : binding.control.kind === "enum" ? (
        <select
          id={`${labelId}-select`}
          className={nativeSelectClass}
          name={controlName}
          aria-labelledby={labelId}
          aria-describedby={computed ? computedHelpId : undefined}
          disabled={computed || disabled}
          value={String(draft)}
          onChange={(event) =>
            onCommit({ type: "setField", path: binding.path, value: event.target.value })
          }
        >
          {binding.control.values?.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      ) : (
        <input
          id={`${labelId}-checkbox`}
          className="appearance-auto accent-studio-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-studio-accent-strong"
          name={controlName}
          aria-labelledby={labelId}
          aria-describedby={computed ? computedHelpId : undefined}
          type="checkbox"
          disabled={computed || disabled}
          checked={Boolean(draft)}
          onChange={(event) =>
            onCommit({ type: "setField", path: binding.path, value: event.target.checked })
          }
        />
      )}
      {binding.sourceForm.kind === "computed" ? (
        <small id={computedHelpId} className="mt-1.75 block leading-[1.4] text-studio-note">
          {binding.sourceForm.message}
          {binding.location
            ? ` · ${binding.location.fileLabel}:${binding.location.line}:${binding.location.column}`
            : ""}
        </small>
      ) : binding.control.defaultValue !== undefined && binding.sourceForm.kind === "literal" ? (
        <StudioButton
          size="reset"
          disabled={disabled}
          onClick={() => onCommit({ type: "resetField", path: binding.path })}
        >
          Reset to default
        </StudioButton>
      ) : null}
    </div>
  );
}
function matchesSelection(path: PatchFieldPath, selection: Selection): boolean {
  if (selection.kind === "source") return path[0] === "source" && path.length === 2;
  if (selection.kind === "oscillator")
    return path[0] === "source" && path[1] === "oscillators" && path[2] === selection.index;
  if (selection.kind === "filter")
    return path[0] === "source" && path[1] === "filter" && path.length === 3;
  if (selection.kind === "lfo")
    return path[0] === "source" && path[1] === "filter" && path[2] === "cutoffLfo";
  if (selection.kind === "envelope") return path[0] === "source" && path[1] === "ampEnvelope";
  if (selection.kind === "effect") return path[0] === "effects" && path[1] === selection.index;
  return false;
}
function valueAt(patch: any, path: PatchFieldPath): PatchScalar {
  let value = patch;
  for (const part of path) value = value?.[part as any];
  return value as PatchScalar;
}
function selectionLabel(selection: Selection): string {
  return selection.index === undefined
    ? selection.kind
    : `${selection.kind} ${selection.index + 1}`;
}
function format(value: unknown): string {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(number < 10 ? 2 : 0) : "—";
}

const root = document.getElementById("root");
if (root)
  createRoot(root).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
