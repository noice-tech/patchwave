import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  EffectType,
  OscillatorWaveform,
  PatchEditOperation,
  PatchFieldPath,
  PatchScalar,
  SourceBinding,
  StudioDocumentSnapshot,
  StudioEditResult,
  StudioServerMessage,
} from "../../src/index.js";
import { shouldHandlePerformanceKey } from "./keyboard.js";
import "./studio.css";

type RuntimeState = any;
type Selection = {
  kind: "source" | "oscillator" | "filter" | "lfo" | "envelope" | "effect" | "safety";
  index?: number;
};

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
    <main className="studio-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PATCHWAVE</p>
          <h1>Studio</h1>
        </div>
        <div className="topbar-actions">
          <button disabled={!document?.canUndo || busy} onClick={() => history("undo")}>
            Undo
          </button>
          <button disabled={!document?.canRedo || busy} onClick={() => history("redo")}>
            Redo
          </button>
          <span className={`connection ${connected ? "online" : "offline"}`}>
            {connected ? "Connected" : "Disconnected"}
          </span>
        </div>
      </header>

      <section className="workspace">
        <aside className="browser-panel">
          <h2>Devices</h2>
          <p className="panel-help">Add devices to the serial signal path.</p>
          <h3>Oscillator</h3>
          <div className="device-actions">
            {["sine", "triangle", "saw", "pulse", "noise"].map((waveform) => (
              <button
                key={waveform}
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
              </button>
            ))}
          </div>
          <h3>Source</h3>
          <div className="device-actions">
            {!patch?.source?.filter ? (
              <button
                disabled={busy || !document?.editableStructure.filter}
                onClick={() => edit({ type: "addFilter" })}
              >
                + Filter
              </button>
            ) : !patch.source.filter.cutoffLfo ? (
              <button
                disabled={busy || !document?.editableStructure.cutoffLfo}
                onClick={() => edit({ type: "addCutoffLfo" })}
              >
                + Cutoff LFO
              </button>
            ) : null}
          </div>
          <h3>Effects</h3>
          <div className="device-actions">
            <button
              disabled={
                busy || !document?.editableStructure.effects || (patch?.effects?.length ?? 7) >= 7
              }
              onClick={() =>
                edit({ type: "addEffect", index: patch.effects.length, effectType: "saturator" })
              }
            >
              + Saturator
            </button>
            <button
              disabled={
                busy || !document?.editableStructure.effects || (patch?.effects?.length ?? 7) >= 7
              }
              onClick={() =>
                edit({ type: "addEffect", index: patch.effects.length, effectType: "stereoDelay" })
              }
            >
              + Stereo delay
            </button>
          </div>
        </aside>

        <section className="rack-panel">
          <div className="rack-heading">
            <div>
              <p className="eyebrow">SIGNAL PATH</p>
              <h2>{runtime?.summary ?? "Waiting for patch"}</h2>
            </div>
            <span className={`phase phase-${phase}`}>{phase.replaceAll("-", " ")}</span>
          </div>
          <div className="rack" aria-label="Serial signal chain">
            <div className="oscillator-mix" role="group" aria-label="Source oscillator mix">
              <Device
                title="Oscillator mix"
                detail={`${patch?.source?.oscillators?.length ?? 0} oscillators · ${format(patch?.source?.frequencyHz)} Hz`}
                selected={selection.kind === "source"}
                onClick={() => setSelection({ kind: "source" })}
              />
              {(patch?.source?.oscillators ?? []).map((osc: any, index: number) => (
                <Device
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
                      <button
                        aria-label="Edit cutoff LFO"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          setSelection({ kind: "lfo" });
                        }}
                      >
                        LFO
                      </button>
                    )}
                    {patch.source.filter.cutoffLfo && document?.editableStructure.cutoffLfo && (
                      <button
                        aria-label="Remove cutoff LFO"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          edit({ type: "removeCutoffLfo" });
                        }}
                      >
                        − LFO
                      </button>
                    )}
                    {document?.editableStructure.filter && (
                      <button
                        aria-label="Remove filter"
                        disabled={busy}
                        onClick={(event) => {
                          event.stopPropagation();
                          edit({ type: "removeFilter" });
                        }}
                      >
                        Remove
                      </button>
                    )}
                  </>
                }
              />
            )}
            <Device
              title="Envelope"
              detail="Amplitude"
              selected={selection.kind === "envelope"}
              onClick={() => setSelection({ kind: "envelope" })}
            />
            {(patch?.effects ?? []).map((effect: any, index: number) => (
              <Device
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

        <aside className="inspector-panel">
          <h2>Inspector</h2>
          <p className="panel-help">{selectionLabel(selection)}</p>
          {!document?.writable && (
            <div className="diagnostic">
              Read-only
              <br />
              {document?.diagnostic}
            </div>
          )}
          {selection.kind === "oscillator" && document?.editableStructure.oscillators && (
            <label className="parameter">
              <span className="parameter-label">
                <span>Waveform</span>
                <span className="source-badge literal">structure</span>
              </span>
              <select
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
            <label className="parameter">
              <span className="parameter-label">
                <span>Effect kind</span>
                <span className="source-badge literal">structure</span>
              </span>
              <select
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
            <p className="computed-note">
              The safety guard is always active and is not source-editable.
            </p>
          ) : bindings.length === 0 ? (
            <p className="computed-note">No editable inline fields for this block.</p>
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

      <footer className="performance">
        <div>
          <span className="eyebrow">KEYBOARD</span>
          <strong>{runtime?.keyboard?.activeNoteLabel ?? "—"}</strong>
          <span>
            {format(runtime?.keyboard?.voice?.frequencyHz)} Hz · gate{" "}
            {runtime?.keyboard?.voice?.gate ? "open" : "closed"}
          </span>
        </div>
        <div className="keys" aria-label="Computer keyboard mapping">
          {["A", "W", "S", "E", "D", "F", "T", "G", "Y", "H", "U", "J", "K"].map((key) => (
            <kbd key={key}>{key}</kbd>
          ))}
        </div>
        <p
          role="status"
          aria-live="polite"
          className={
            runtime?.error || document?.phase === "error" || document?.phase === "conflict"
              ? "error-status"
              : ""
          }
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
}) {
  return (
    <article
      className={`device ${selected ? "selected" : ""}`}
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
        className="device-select"
        aria-pressed={selected}
        aria-label={`Edit ${title}`}
        onClick={onClick}
      >
        <span className="device-led" />
        <span className="device-title">{title}</span>
        <span className="device-detail">{detail}</span>
      </button>
      {actions && <div className="block-actions">{actions}</div>}
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
      <button
        aria-label={`Move ${label} left`}
        disabled={disabled || index === 0}
        onClick={(e) => {
          e.stopPropagation();
          onMove(index - 1);
        }}
      >
        ←
      </button>
      <button
        aria-label={`Move ${label} right`}
        disabled={disabled || index === count - 1}
        onClick={(e) => {
          e.stopPropagation();
          onMove(index + 1);
        }}
      >
        →
      </button>
      <button
        aria-label={`Remove ${label}`}
        disabled={disabled || !canRemove}
        onClick={(e) => {
          e.stopPropagation();
          onRemove();
        }}
      >
        Remove
      </button>
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
    <div className={`parameter ${computed ? "computed" : ""}`}>
      <div className="parameter-label" id={labelId}>
        <span>{binding.control.label}</span>
        <span className={`source-badge ${binding.sourceForm.kind}`}>{binding.sourceForm.kind}</span>
      </div>
      {binding.control.kind === "number" ? (
        <>
          <input
            id={`${labelId}-slider`}
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
          <span className="number-row">
            <input
              id={`${labelId}-number`}
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
            <span>{binding.control.unit}</span>
          </span>
        </>
      ) : binding.control.kind === "enum" ? (
        <select
          id={`${labelId}-select`}
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
        <small>
          {binding.sourceForm.message}
          {binding.location
            ? ` · ${binding.location.fileLabel}:${binding.location.line}:${binding.location.column}`
            : ""}
        </small>
      ) : binding.control.defaultValue !== undefined && binding.sourceForm.kind === "literal" ? (
        <button
          className="reset"
          disabled={disabled}
          onClick={() => onCommit({ type: "resetField", path: binding.path })}
        >
          Reset to default
        </button>
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
