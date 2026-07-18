# Patchwave

Patchwave is a code-first, programmatic monophonic synthesizer. People or agents author TypeScript patches, save them, and hear every valid change immediately through a realtime Rust DSP engine.

```text
TypeScript patch
      │ load + strict validation
      ▼
 Patchwave CLI ── serialized patch ──► napi-rs bridge
                                         │
                                         ▼
                                  realtime Rust DSP
                                         │
                                         ▼
                                      CPAL audio
```

Patchwave keeps one output stream alive while the CLI watches your patch. TypeScript provides a type-safe authoring interface; Rust owns synthesis, modulation, effects, smoothing, transactional updates, and audio rendering.

## Prerequisites

- Node.js 24 or newer
- pnpm 11.1.2
- Rust 1.88 or newer
- macOS: Xcode Command Line Tools (`xcode-select --install`)

macOS is the primary validated target. Linux additionally needs ALSA development files. Windows needs the Rust MSVC toolchain. Linux and Windows support remain experimental and have not received the same end-to-end validation.

## Quick start

```bash
pnpm install
pnpm build
pnpm patchwave ./example/dubstep-bass.ts
```

Startup is silent. Press **Space** to open or close the synth gate, `q` to quit, or Ctrl+C to exit. Keep the process running, edit the patch, and save: accepted changes take effect without restarting the audio stream.

## Authoring patches

A patch is a strict, unversioned object. Its root fields are `tempoBpm`, `modulators`, `modulationRoutes`, and `devices`; there is no root `version` field.

```ts
import type { Patch } from "@patchwave/schema";

export default {
  tempoBpm: 124,
  modulators: [],
  modulationRoutes: [],
  devices: [
    {
      id: "voice",
      type: "subtractiveSynth",
      enabled: true,
      baseFrequencyHz: 110,
      outputGain: 0.25,
      oscillators: [
        {
          id: "saw",
          waveform: "saw",
          octave: 0,
          semitone: 0,
          detuneCents: 0,
          level: 1,
          sends: { filter: 1, insert: 0, direct: 0 },
        },
      ],
      ampEnvelope: {
        attackSeconds: 0.01,
        decaySeconds: 0.15,
        sustain: 0.7,
        releaseSeconds: 0.25,
      },
      filter: {
        enabled: true,
        mode: "lowpass",
        cutoffHz: 900,
        resonance: 0.35,
        sends: { insert: 1, direct: 0 },
      },
      audioRateRoutes: [],
    },
    {
      id: "drive",
      type: "saturator",
      enabled: true,
      driveDb: 10,
      outputGainDb: -5,
      mix: 0.4,
    },
  ],
} satisfies Patch;
```

Validation is recursive and strict. Unknown or missing fields, unsupported devices, invalid IDs or references, wrong types, non-finite numbers, exceeded counts, and out-of-range values reject the complete save. The previously accepted patch continues playing.

## Sound capabilities

- **Oscillators:** 1–4 ID-bearing oscillators using sine, triangle, saw, pulse, or noise waveforms, with tonal tuning, level control, and pulse width where applicable.
- **Routing:** independent oscillator sends to the multimode filter, serial insert bus, and direct bus; filter output can also feed insert and direct. Direct audio bypasses serial processors while retaining source amplitude and gain control.
- **Filter and amplitude:** lowpass, bandpass, or highpass filtering with cutoff and resonance, plus a dedicated amplitude envelope.
- **Modulation:** up to four LFO or envelope modulators and up to eight typed routes targeting filter cutoff, oscillator pitch, pulse width, oscillator level, or source gain.
- **Audio-rate modulation:** at most one sine-to-sine phase-modulation route per patch.
- **Effects:** saturator and stereo ping-pong delay processors in a bounded serial chain of up to eight total devices.

## Hot reload and realtime guarantees

- Parameter-only saves are applied as complete transactions at callback boundaries while retaining oscillator, envelope, filter, modulation, saturator, delay, and effect-tail state.
- Structural edits are fully prepared off the callback, then installed with a short fade-out and fade-in at silence.
- Invalid, queue-full, structurally busy, and runtime-error updates do not replace the accepted patch.
- The callback does not allocate, lock, parse, log, block, invoke JavaScript/N-API, or control the stream.
- Pitch, levels, filter, effects, waveform, mode, bypass, and delay-time changes use bounded smoothing or crossfades.
- Gate-off follows the amplitude release while processor tails continue. Quitting pauses the stream and truncates remaining tails.
- Output is sanitized for non-finite values and bounded by a final safety guard.

## Included examples

| Example                                                                | Focus                                                             |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| [`classic-bass.ts`](./example/classic-bass.ts)                         | Classic subtractive bass voice                                    |
| [`dubstep-bass.ts`](./example/dubstep-bass.ts)                         | Tempo-synced wobble, pulse width, filtering, and phase modulation |
| [`dubstep-growl.ts`](./example/dubstep-growl.ts)                       | Layered saw/sub growl with saturation and delay                   |
| [`filter-pluck.ts`](./example/filter-pluck.ts)                         | Envelope-driven filter pluck                                      |
| [`filtered-effect-bypass.ts`](./example/filtered-effect-bypass.ts)     | Filter and effect-bus routing                                     |
| [`fm-bell.ts`](./example/fm-bell.ts)                                   | Sine phase-modulation bell tone                                   |
| [`pwm-lead.ts`](./example/pwm-lead.ts)                                 | LFO pulse-width modulation                                        |
| [`sound.ts`](./example/sound.ts)                                       | Compact starting patch                                            |
| [`tremolo-drone.ts`](./example/tremolo-drone.ts)                       | Source-gain modulation                                            |
| [`unfiltered-effect-source.ts`](./example/unfiltered-effect-source.ts) | Insert routing without filter coloration                          |

Run any example by replacing the final path in the quick-start command.

## Workspace and development

```bash
pnpm build              # schema, TypeScript, native addon, and CLI
pnpm typecheck          # workspace TypeScript checking
pnpm test               # schema, CLI, native, and shared-fixture tests
pnpm check              # typecheck, Rust formatting check, and clippy
pnpm validate           # complete standard validation
pnpm test:pm-reference  # release-mode phase-modulation reference test
pnpm bench:callback     # release-mode callback work-budget benchmark
```

`pnpm build` regenerates the native loader and TypeScript declarations in [`packages/native`](./packages/native/). Native DSP tests and CLI adapter tests do not open an audio device.

## Experimental scope

Patchwave is an experimental, macOS-first development project rather than a published package or finished instrument. It is monophonic, uses the default output device, and currently has no MIDI input, polyphony, plugin format, sample playback, arbitrary processing graph, or device-selection UI. Audio behavior on Linux and Windows still needs broader validation.

## License

Patchwave is available under the [MIT License](./LICENSE).
