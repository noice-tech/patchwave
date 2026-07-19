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
import { shouldHandlePerformanceKey } from "./keyboard.js";
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

const phaseToneClasses: Record<StudioDocumentPhase, string> = {
  ready: "text-studio-text-phase",
  writing: "text-studio-text-phase",
  previewing: "text-studio-warning",
  "source-written": "text-studio-info",
  reloading: "text-studio-info",
  "audio-accepted": "text-studio-success",
  conflict: "text-studio-danger",
  error: "text-studio-danger",
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
  "w-full appearance-auto [background-color:revert] [border-radius:revert] [border:revert] [color:revert] [padding:revert]";
const noteClass =
  "mt-3.5 rounded-studio-note border border-studio-note-border bg-studio-note-bg p-2.5 text-studio-copy leading-[1.5] text-studio-note";

const keyboardKeys = [
  { label: "A", raised: false },
  { label: "W", raised: true },
  { label: "S", raised: false },
  { label: "E", raised: true },
  { label: "D", raised: false },
  { label: "F", raised: false },
  { label: "T", raised: true },
  { label: "G", raised: false },
  { label: "Y", raised: true },
  { label: "H", raised: false },
  { label: "U", raised: true },
  { label: "J", raised: false },
  { label: "K", raised: false },
] as const;

function requestId(): string {
  return crypto.randomUUID();
}
function pathEqual(a: PatchFieldPath, b: PatchFieldPath): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function App() {
  const [connected, setConnected] = useState(false);
  const [runtime, setRuntime] = useState<RuntimeState>();
  const [document, setDocument] = useState<StudioDocumentSnapshot>();
  const [selection, setSelection] = useState<Selection>({ kind: "source" });
  const [notice, setNotice] = useState("Connecting…");
  const [pendingRequest, setPendingRequest] = useState<string | undefined>(undefined);
  const pendingRequestRef = useRef<string | undefined>(undefined);
  const socket = useRef<WebSocket | undefined>(undefined);

  const send = useCallback((message: unknown): boolean => {
    if (socket.current?.readyState !== WebSocket.OPEN) return false;
    socket.current.send(JSON.stringify(message));
    return true;
  }, []);
  const edit = useCallback(
    (operation: PatchEditOperation, gestureId: string | null = null): boolean => {
      if (!document || pendingRequestRef.current) return false;
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
      setConnected(true);
      setNotice("Audio running");
    });
    ws.addEventListener("close", () => {
      pendingRequestRef.current = undefined;
      setPendingRequest(undefined);
      setConnected(false);
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
          setNotice(
            result.message ??
              (result.status === "committed" ? "Saved to code; reloading audio…" : result.status),
          );
        }
      } catch {
        ws.close();
      }
    });
    return () => ws.close();
  }, []);

  useEffect(() => {
    const mapped = new Set([
      "KeyA",
      "KeyW",
      "KeyS",
      "KeyE",
      "KeyD",
      "KeyF",
      "KeyT",
      "KeyG",
      "KeyY",
      "KeyH",
      "KeyU",
      "KeyJ",
      "KeyK",
      "KeyZ",
      "KeyX",
    ]);
    const down = (event: KeyboardEvent) => {
      if (!shouldHandlePerformanceKey(event, mapped)) return;
      event.preventDefault();
      if (!event.repeat) send({ type: "keyDown", code: event.code });
    };
    const up = (event: KeyboardEvent) => {
      if (!mapped.has(event.code)) return;
      event.preventDefault();
      send({ type: "keyUp", code: event.code });
    };
    const release = () => {
      window.dispatchEvent(new Event("patchwave-cancel-gestures"));
      send({ type: "releaseAll" });
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", release);
    const visibility = () => {
      if (globalThis.document.hidden) release();
    };
    globalThis.document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pagehide", release);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", release);
      globalThis.document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pagehide", release);
    };
  }, [send]);

  const patch = runtime?.patch;
  const bindings = useMemo(
    () => document?.bindings.filter((binding) => matchesSelection(binding.path, selection)) ?? [],
    [document, selection],
  );
  const phase = document?.phase ?? "ready";
  const busy =
    Boolean(pendingRequest) || ["writing", "source-written", "reloading"].includes(phase);
  const history = (type: "undo" | "redo") => {
    if (!document || pendingRequestRef.current) return;
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
    <main className="isolate grid min-h-dvh min-w-80 grid-rows-[auto_1fr_auto] font-studio text-studio-text antialiased [background:radial-gradient(circle_at_70%_-10%,#183a2d_0,transparent_38%),var(--color-studio-canvas)] [font-synthesis:none] [line-height:normal]">
      <header className="flex h-[4.5rem] items-center justify-between border-b border-studio-border bg-studio-panel/91 px-5 py-[0.8125rem] backdrop-blur-[1.125rem] max-studio-mobile:h-auto">
        <div>
          <p className={eyebrowClass}>PATCHWAVE</p>
          <h1 className="text-studio-title font-bold tracking-[-0.04em]">Studio</h1>
        </div>
        <div className="flex items-center gap-2">
          <StudioButton disabled={!document?.canUndo || busy} onClick={() => history("undo")}>
            Undo
          </StudioButton>
          <StudioButton disabled={!document?.canRedo || busy} onClick={() => history("redo")}>
            Redo
          </StudioButton>
          <span
            className={cx(
              statusPillClass,
              connected ? "text-studio-success" : "text-studio-danger",
              "max-studio-mobile:hidden",
            )}
          >
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      <section className="grid min-h-0 grid-cols-[13.125rem_minmax(18.75rem,1fr)_17.5rem] max-studio-tablet:grid-cols-[10rem_minmax(16.25rem,1fr)] max-studio-mobile:block">
        <aside className="overflow-auto border-r border-studio-border bg-studio-panel p-studio-panel max-studio-tablet:p-3.25 max-studio-mobile:border-r-0 max-studio-mobile:border-b">
          <h2 className="text-studio-section font-bold">Devices</h2>
          <p className={panelHelpClass}>Add devices to the serial signal path.</p>
          <h3 className="mt-studio-rack mb-2 text-studio-meta font-bold tracking-widest text-studio-text-subtle uppercase">
            Oscillator
          </h3>
          <div className="grid gap-1.5 max-studio-mobile:grid-cols-2">
            {["sine", "triangle", "saw", "pulse", "noise"].map((waveform) => (
              <StudioButton
                key={waveform}
                className="text-left capitalize"
                disabled={
                  busy ||
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
                disabled={busy || !document?.editableStructure.filter}
                onClick={() => edit({ type: "addFilter" })}
              >
                + Filter
              </StudioButton>
            ) : !patch.source.filter.cutoffLfo ? (
              <StudioButton
                className="text-left capitalize"
                disabled={busy || !document?.editableStructure.cutoffLfo}
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
                busy || !document?.editableStructure.effects || (patch?.effects?.length ?? 7) >= 7
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
                busy || !document?.editableStructure.effects || (patch?.effects?.length ?? 7) >= 7
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
                {runtime?.summary ?? "Waiting for patch"}
              </h2>
            </div>
            <span
              className={cx(
                statusPillClass,
                "bg-studio-phase",
                phaseToneClasses[phase] ?? "text-studio-text-phase",
              )}
            >
              {phase.replaceAll("-", " ")}
            </span>
          </div>
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
                    document?.editableStructure.oscillators && !busy
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
                        disabled={busy}
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
                        disabled={busy}
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
                        disabled={busy}
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
                        disabled={busy}
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
                  document?.editableStructure.effects && !busy
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
                      disabled={busy}
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
        </section>

        <aside className="overflow-auto border-l border-studio-border bg-studio-panel p-studio-panel max-studio-tablet:col-span-full max-studio-tablet:max-h-77.5 max-studio-tablet:border-t max-studio-tablet:border-l-0">
          <h2 className="text-studio-section font-bold">Inspector</h2>
          <p className={panelHelpClass}>{selectionLabel(selection)}</p>
          {!document?.writable && (
            <div className={noteClass}>
              Read-only
              <br />
              {document?.diagnostic}
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
                disabled={busy}
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
                disabled={busy}
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
          {selection.kind === "safety" ? (
            <p className={noteClass}>
              The safety guard is always active and is not source-editable.
            </p>
          ) : bindings.length === 0 ? (
            <p className={noteClass}>No editable inline fields for this block.</p>
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
                disabled={busy}
                send={send}
                onCommit={edit}
              />
            ))
          )}
        </aside>
      </section>

      <footer className="grid min-h-24 grid-cols-[13.125rem_1fr_17.5rem] items-center gap-studio-panel border-t border-studio-border bg-studio-panel-subtle px-5 py-3.5 max-studio-tablet:grid-cols-[9.375rem_1fr] max-studio-mobile:block">
        <div className="grid gap-1">
          <span className={eyebrowClass}>KEYBOARD</span>
          <strong className="text-studio-value font-bold tabular-nums">
            {runtime?.keyboard?.activeNoteLabel ?? "—"}
          </strong>
          <span className="text-studio-meta text-studio-text-muted tabular-nums">
            {format(runtime?.keyboard?.voice?.frequencyHz)} Hz · gate{" "}
            {runtime?.keyboard?.voice?.gate ? "open" : "closed"}
          </span>
        </div>
        <div
          className="flex justify-center gap-1.25 overflow-auto max-studio-mobile:my-3.5 max-studio-mobile:justify-start"
          aria-label="Computer keyboard mapping"
        >
          {keyboardKeys.map(({ label, raised }) => (
            <kbd
              key={label}
              className={cx(
                "min-w-7.75 rounded-studio-key border border-studio-border-key px-1.75 py-3 text-center font-mono text-studio-meta font-bold",
                raised
                  ? "-translate-y-1.5 bg-studio-key-dark text-studio-key-dark-text shadow-studio-key-dark"
                  : "bg-studio-key text-studio-key-text shadow-studio-key",
              )}
            >
              {label}
            </kbd>
          ))}
        </div>
        <p
          role="status"
          aria-live="polite"
          className={cx(
            "text-studio-meta leading-[1.4] max-studio-tablet:col-span-full max-studio-mobile:mt-2",
            runtime?.error || document?.phase === "error" || document?.phase === "conflict"
              ? "text-studio-danger"
              : "text-studio-text-status",
          )}
        >
          {notice}
        </p>
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
            className="w-full appearance-auto accent-studio-accent"
            name={`${controlName}.slider`}
            aria-labelledby={labelId}
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
              className="w-full rounded-studio-input border border-studio-border-input bg-studio-control-deep p-1.5 text-studio-text-strong tabular-nums"
              name={`${controlName}.number`}
              aria-labelledby={labelId}
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
          className="appearance-auto"
          name={controlName}
          aria-labelledby={labelId}
          type="checkbox"
          disabled={computed || disabled}
          checked={Boolean(draft)}
          onChange={(event) =>
            onCommit({ type: "setField", path: binding.path, value: event.target.checked })
          }
        />
      )}
      {binding.sourceForm.kind === "computed" ? (
        <small className="mt-1.75 block leading-[1.4] text-studio-note">
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
