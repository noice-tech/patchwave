# Patchwave

Patchwave is a small, code-first monophonic synthesizer. Write a TypeScript object, save it, and hear every valid change immediately through a realtime Rust DSP engine.

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

Startup is silent. Press **Space** to open or close the gate, `q` to quit, or Ctrl+C to exit. Keep the process running, edit the patch, and save. Invalid saves are rejected while the previous patch keeps playing.

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

## Development

```bash
pnpm build              # schema, TypeScript, native addon, and CLI
pnpm typecheck          # workspace TypeScript checking
pnpm test               # schema, CLI, native, and shared-fixture tests
pnpm check              # typecheck, formatting check, and Clippy
pnpm validate           # complete standard validation
pnpm bench:callback     # release callback work-budget benchmark
pnpm validate:release   # standard validation plus callback benchmark
```

The callback does not allocate, lock, parse, log, block, invoke JavaScript/N-API, or control the stream. Output is sanitized for non-finite values and bounded by a final safety guard.

## Experimental scope

Patchwave is an experimental, macOS-first project rather than a published package or finished instrument. It is monophonic, uses the default output device, and currently has no MIDI input, polyphony, plugin format, sample playback, arbitrary routing, or device-selection UI.

## License

Patchwave is available under the [MIT License](./LICENSE).
