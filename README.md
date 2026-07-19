# Patchwave

Patchwave is a small, code-first monophonic synthesizer. Write a TypeScript patch object or a frame-driven patch program, save it, and hear every valid change immediately through a realtime Rust DSP engine.

> **⚠️ Active development:** Patchwave is experimental and macOS-first. Its schemas, concepts, source-editing model, wire formats, and public APIs may change—including breaking changes—without compatibility guarantees at this stage.

```text
oscillator mix
      │
      ▼
optional source filter
      │
      ▼
source gain × amplitude envelope
      │
      ▼
effects[0] → effects[1] → … → safety guard → audio output
```

The patch structure mirrors the signal path: one source object followed by an optional array of effects. There are no IDs, buses, sends, or route tables.

## Prerequisites

- Node.js 24 or newer
- pnpm 11.1.2
- Rust 1.88 or newer
- macOS: Xcode Command Line Tools (`xcode-select --install`)

macOS is the primary validated target. Linux additionally needs ALSA development files. Windows needs the Rust MSVC toolchain. Linux and Windows support remain experimental.

## Quick start

```bash
pnpm install
pnpm build
pnpm patchwave ./example/sound.ts
```

Patchwave prints and opens a capability-scoped Studio URL. Keep the browser focused and play with the Ableton-style computer keyboard layout below. Press Ctrl+C in the terminal to exit. Keep the process running, edit the patch, and save; invalid saves are rejected while the previous patch keeps playing.

## Smallest patch

```ts
import type { Patch } from "@patchwave/schema";

export default {
  source: {
    frequencyHz: 110,
    oscillators: [{ waveform: "saw" }],
  },
} satisfies Patch;
```

Patchwave supplies safe defaults for omitted details and normalizes the author object before it reaches Rust.

## Frame-driven patch programs

A default export may instead be a synchronous function from an exact 60 fps logical frame and current monophonic voice to the same plain patch object:

```ts
import type { PatchProgram } from "@patchwave/schema";

export default (({ timeSeconds, voice }) => ({
  source: {
    frequencyHz: voice.frequencyHz,
    oscillators: [{ waveform: "saw" }],
    filter: {
      cutoffHz: 1_200 + Math.sin(timeSeconds * Math.PI * 0.5) * 900,
    },
  },
})) satisfies PatchProgram;
```

The readonly context contains `frame`, `fps: 60`, `timeSeconds: frame / 60`, and `voice: { frequencyHz, gate }`. Late control frames are skipped rather than replayed in a burst. The clock begins at frame zero, continues across hot reloads, and resets only when Patchwave restarts.

The first valid result establishes oscillator count and ordered effect kinds. Later frames may animate nonstructural values but cannot animate oscillator count, effect count, or effect kinds. A newly hot-reloaded module may establish a different structure. A bad frame keeps the last valid sound and does not stop future frames.

Patch programs are control-rate automation: JavaScript never runs in the audio callback, and Rust smooths accepted parameter images. The nested cutoff LFO remains the sample-accurate choice for fast filter modulation.

## Studio

Studio binds only to loopback with a random per-process capability URL. Its React interface combines the playable keyboard with an Ableton-style serial device rack, device browser, and inspector. Supported edits are written back to the one TypeScript entry file passed to the CLI; Studio is never a remote hosting surface and the browser cannot choose a path or send source code.

Literal scalar controls preview the sound while you drag. Releasing the pointer, pressing Enter, or leaving the input commits one validated source edit and creates one process-local undo entry. Adding, removing, replacing, or reordering oscillator/filter/LFO/effect blocks commits immediately. Studio formats edited source with `oxfmt` before validating and writing it. Studio compares source content and file identity immediately before an atomic replacement and verifies the result, so ordinary stale edits fail with a visible conflict. Portable filesystems do not provide an indivisible content-hash-and-replace primitive; a truly simultaneous external rename in the final replacement interval can still race, so avoid saving from an editor during the instant Studio commits.

### Editable TypeScript

Studio deliberately understands a small source grammar rather than guessing at arbitrary TypeScript:

- A static patch must be a directly default-exported object literal, optionally wrapped in `satisfies`, `as`, or parentheses.
- A `PatchProgram` may return one direct object literal, either as a concise arrow body or one function-scope `return`. Local statements before that return are allowed.
- Direct literal numbers, strings, booleans, objects, and dense arrays are editable. Missing optional literal fields appear as defaults and materialize only when changed.
- Variables, calls, arithmetic, conditional values, spreads, computed keys, imported patch objects, and indirect exports remain audible and visible but are marked **Computed** and read-only with a source location.
- Studio only rewrites the entry file. Symbolic links and non-`.ts`/`.tsx` entry files are playback-only.

For example, `resonance` is editable while the authored cutoff animation remains code-only:

```ts
filter: {
  cutoffHz: 200 + movement * 2_400, // Computed in code
  resonance: 0.45,                  // Editable literal
}
```

Undo and redo exist only for Studio transactions in the current process. An external file change clears affected Studio history rather than risking a snapshot overwrite. Disconnect invalidates queued browser edits; an atomic commit that has already begun is allowed to finish and shutdown drains it. Invalid external saves continue to retain the previous valid sound through the normal hot-reload behavior.

Use physical computer-key positions:

```text
      W E     T Y U
      ♯ ♯     ♯ ♯ ♯
    A S D F G H J K
    C D E F G A B C

    Z: octave down    X: octave up
```

`A` begins at Ableton's displayed `C3`. New notes retrigger the envelope and filter LFO. Patchwave uses last-pressed priority: releasing the active key falls back to the most recently held key without retriggering, and releasing the final key starts the amplitude release. Leaving, hiding, or disconnecting the studio safely releases all notes. Velocity is not yet modeled.

Keyboard performance never rewrites pitch into source: static patches use a transient runtime frequency copy. Patch programs control their returned pitch directly, so use `voice.frequencyHz` when keyboard pitch should drive the source. Studio parameter edits are a separate, explicit source transaction; a held keyboard note is never persisted as the authored `frequencyHz`.

## Source

A source contains one to four oscillators, an optional filter, and an optional amplitude envelope.

```ts
source: {
  frequencyHz: 55,
  gainDb: -14,
  oscillators: [
    { waveform: "saw", transposeSemitones: 12, detuneCents: -7, level: 0.35 },
    { waveform: "saw", transposeSemitones: 12, detuneCents: 7, level: 0.35 },
    { waveform: "sine", level: 0.8 },
  ],
  filter: {
    mode: "lowpass",
    cutoffHz: 220,
    resonance: 0.7,
    cutoffLfo: {
      rateHz: 2.5,
      amountOctaves: 2.5,
    },
  },
  ampEnvelope: {
    attackSeconds: 0.005,
    decaySeconds: 0.1,
    sustain: 0.9,
    releaseSeconds: 0.15,
  },
}
```

### Oscillators

Available waveforms are `sine`, `triangle`, `saw`, `pulse`, and deterministic `noise`. Tonal oscillators use `transposeSemitones` and `detuneCents`. Pulse additionally supports `pulseWidth`.

Oscillators are summed automatically. Their array position is their realtime identity.

### Filter and cutoff LFO

The source filter supports `lowpass`, `bandpass`, and `highpass` modes. It sits after the oscillator mix and before the amplitude envelope.

`cutoffLfo` is deliberately local to the filter. It is bipolar, resets on gate-on, and modulates cutoff exponentially:

```text
effective cutoff = cutoffHz × 2^(lfo × amountOctaves)
```

The sine shape starts at zero and rises. LFO rates are authored directly in hertz; Patchwave has no tempo or transport model.

### Defaults

| Field                   |         Default |
| ----------------------- | --------------: |
| source gain             |        `-12 dB` |
| transpose / detune      |             `0` |
| oscillator level        |             `1` |
| pulse width             |           `0.5` |
| envelope attack         |       `0.005 s` |
| envelope decay          |           `0 s` |
| envelope sustain        |             `1` |
| envelope release        |         `0.1 s` |
| filter mode / resonance | `lowpass` / `0` |
| cutoff LFO shape        |          `sine` |

### Important limits

| Parameter                      | Authored range                    |
| ------------------------------ | --------------------------------- |
| source frequency / gain        | `1–20000 Hz` / `-60–0 dB`         |
| transpose / detune             | `-48–48` semitones / `±100` cents |
| oscillator level / pulse width | `0–1` / `0.05–0.95`               |
| filter cutoff / resonance      | `20–20000 Hz` / `0–1`             |
| cutoff LFO rate / amount       | `0.01–40 Hz` / `0–8` octaves      |
| envelope times / sustain       | `0–30 s` / `0–1`                  |
| delay time / feedback          | `0.001–2 s` / `0–0.95`            |

A patch may contain one to four oscillators and up to seven ordered effects. Mix and damping values use the `0–1` range; saturator drive uses `0–36 dB` and output gain uses `-36–12 dB`.

## Ordered effects

Effects run from left to right:

```ts
effects: [
  { type: "saturator", driveDb: 18, outputGainDb: -8, mix: 0.8 },
  {
    type: "stereoDelay",
    timeSeconds: 0.095,
    feedback: 0.2,
    damping: 0.72,
    pingPong: true,
    mix: 0.1,
  },
];
```

Saturator defaults are `outputGainDb: 0` and `mix: 1`. Delay defaults are `feedback: 0`, `damping: 0`, and `pingPong: false`; `timeSeconds` and `mix` are required.

Removing an effect removes it from the chain. There is no separate bypass flag.

## Gate, release, and tails

- Gate-on retriggers the amplitude envelope and resets the cutoff LFO.
- Oscillators remain free-running across gate changes.
- Gate-off starts the amplitude release.
- Effects keep processing after the source reaches silence, so delay tails continue.
- Parameter-only saves preserve oscillator, envelope, filter, LFO, and effect state.
- Oscillator-count or effect-topology changes use a short fade around a prepared chain replacement.

Waveform, filter, LFO, tuning, gain, envelope, and same-position effect parameter edits are parameter-only. Oscillator count, effect count, and effect kind at an array position are structural.

## Examples

| Example                                        | Focus                                                 |
| ---------------------------------------------- | ----------------------------------------------------- |
| [`sound.ts`](./example/sound.ts)               | Minimal beginner patch                                |
| [`classic-bass.ts`](./example/classic-bass.ts) | Detuned saws, sine foundation, filter, and saturation |
| [`dubstep-bass.ts`](./example/dubstep-bass.ts) | Gate-reset cutoff wobble and an ordered effect chain  |
| [`program.ts`](./example/program.ts)           | Keyboard pitch and frame-driven filter automation     |

## Development

```bash
pnpm build              # schema, TypeScript, native addon, and CLI
pnpm typecheck          # workspace TypeScript checking
pnpm test               # schema, studio, CLI, native, and shared-fixture tests
pnpm check              # typecheck, formatting check, and Clippy
pnpm validate           # complete standard validation
pnpm bench:callback     # release callback work-budget benchmark
pnpm validate:release   # standard validation plus callback benchmark
```

### Studio styling

Studio uses Tailwind CSS v4 through the official Vite plugin. `packages/studio/client/src/studio.css` is configuration-only: it imports Tailwind, registers the React TSX source tree, and defines semantic `studio-*` theme tokens and the existing responsive breakpoints. All UI styling belongs in complete, statically detectable utility strings in `packages/studio/client/src/**/*.tsx`; shared utility-only primitives live in `ui.tsx`.

Do not add authored selectors, `@apply`, `@layer`, `@media`, or `@utility` rules to `studio.css`, and do not assemble utility names with string interpolation. Map dynamic UI states to complete class strings instead. Tailwind Preflight is enabled, so form controls must also carry their intentional utility styling. Validate changes with `pnpm --filter @patchwave/studio build` and `pnpm --filter @patchwave/studio test`.

The callback does not allocate, lock, parse, log, block, invoke JavaScript/N-API, or control the stream. Output is sanitized for non-finite values and bounded by a final safety guard.

## Experimental scope

Patchwave is an experimental, macOS-first project rather than a published package or finished instrument. It is monophonic, uses the default output device, and currently has no hardware MIDI input, velocity, sustain, transport, named controls, polyphony, plugin format, sample playback, arbitrary routing, or device-selection UI.

## License

Patchwave is available under the [MIT License](./LICENSE).
