use crate::patch::*;
use serde::Deserialize;

const MAX_EFFECTS: usize = 7;
const MAX_OSCILLATORS: usize = 4;

pub(crate) fn parse(serialized: &str) -> Result<PatchSpec, PatchError> {
    let wire: WirePatch = serde_json::from_str(serialized)
        .map_err(|error| PatchError::new(format!("invalid patch JSON: {error}")))?;
    let source = validate_source(wire.source)?;
    if wire.effects.len() > MAX_EFFECTS {
        return Err(PatchError::new("effects must contain 0–7 items"));
    }
    let effects = wire
        .effects
        .into_iter()
        .enumerate()
        .map(|(index, effect)| validate_effect(effect, &format!("effects[{index}]")))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(PatchSpec { source, effects })
}

fn validate_source(wire: WireSource) -> Result<SourceSpec, PatchError> {
    range(wire.frequency_hz, 1.0, 20_000.0, "source.frequencyHz")?;
    range(wire.gain_db, -60.0, 0.0, "source.gainDb")?;
    if wire.oscillators.is_empty() || wire.oscillators.len() > MAX_OSCILLATORS {
        return Err(PatchError::new("source.oscillators must contain 1–4 items"));
    }
    let oscillators = wire
        .oscillators
        .into_iter()
        .enumerate()
        .map(|(index, oscillator)| {
            validate_oscillator(oscillator, &format!("source.oscillators[{index}]"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let filter = wire.filter.map(validate_filter).transpose()?;
    let amp_envelope = validate_envelope(wire.amp_envelope, "source.ampEnvelope")?;
    Ok(SourceSpec {
        frequency_hz: wire.frequency_hz as f32,
        gain_db: wire.gain_db as f32,
        oscillators,
        filter,
        amp_envelope,
    })
}

fn validate_oscillator(wire: WireOscillator, path: &str) -> Result<OscillatorSpec, PatchError> {
    let (waveform, transpose, detune, pulse_width, level) = match wire {
        WireOscillator::Sine {
            transpose_semitones,
            detune_cents,
            level,
        } => (
            Waveform::Sine,
            transpose_semitones,
            detune_cents,
            0.5,
            level,
        ),
        WireOscillator::Triangle {
            transpose_semitones,
            detune_cents,
            level,
        } => (
            Waveform::Triangle,
            transpose_semitones,
            detune_cents,
            0.5,
            level,
        ),
        WireOscillator::Saw {
            transpose_semitones,
            detune_cents,
            level,
        } => (Waveform::Saw, transpose_semitones, detune_cents, 0.5, level),
        WireOscillator::Pulse {
            transpose_semitones,
            detune_cents,
            pulse_width,
            level,
        } => (
            Waveform::Pulse,
            transpose_semitones,
            detune_cents,
            pulse_width,
            level,
        ),
        WireOscillator::Noise { level } => (Waveform::Noise, 0, 0.0, 0.5, level),
    };
    integer(transpose, -48, 48, &format!("{path}.transposeSemitones"))?;
    range(detune, -100.0, 100.0, &format!("{path}.detuneCents"))?;
    range(pulse_width, 0.05, 0.95, &format!("{path}.pulseWidth"))?;
    range(level, 0.0, 1.0, &format!("{path}.level"))?;
    Ok(OscillatorSpec {
        waveform,
        transpose_semitones: transpose as i8,
        detune_cents: detune as f32,
        pulse_width: pulse_width as f32,
        level: level as f32,
    })
}

fn validate_filter(wire: WireFilter) -> Result<FilterSpec, PatchError> {
    range(wire.cutoff_hz, 20.0, 20_000.0, "source.filter.cutoffHz")?;
    range(wire.resonance, 0.0, 1.0, "source.filter.resonance")?;
    let cutoff_lfo = wire
        .cutoff_lfo
        .map(|lfo| {
            range(lfo.rate_hz, 0.01, 40.0, "source.filter.cutoffLfo.rateHz")?;
            range(
                lfo.amount_octaves,
                0.0,
                8.0,
                "source.filter.cutoffLfo.amountOctaves",
            )?;
            Ok(CutoffLfoSpec {
                shape: lfo.shape.into(),
                rate_hz: lfo.rate_hz as f32,
                amount_octaves: lfo.amount_octaves as f32,
            })
        })
        .transpose()?;
    Ok(FilterSpec {
        mode: wire.mode.into(),
        cutoff_hz: wire.cutoff_hz as f32,
        resonance: wire.resonance as f32,
        cutoff_lfo,
    })
}

fn validate_envelope(wire: WireEnvelope, path: &str) -> Result<EnvelopeSpec, PatchError> {
    range(
        wire.attack_seconds,
        0.0,
        30.0,
        &format!("{path}.attackSeconds"),
    )?;
    range(
        wire.decay_seconds,
        0.0,
        30.0,
        &format!("{path}.decaySeconds"),
    )?;
    range(wire.sustain, 0.0, 1.0, &format!("{path}.sustain"))?;
    range(
        wire.release_seconds,
        0.0,
        30.0,
        &format!("{path}.releaseSeconds"),
    )?;
    Ok(EnvelopeSpec {
        attack_seconds: wire.attack_seconds as f32,
        decay_seconds: wire.decay_seconds as f32,
        sustain: wire.sustain as f32,
        release_seconds: wire.release_seconds as f32,
    })
}

fn validate_effect(wire: WireEffect, path: &str) -> Result<EffectSpec, PatchError> {
    match wire {
        WireEffect::Saturator {
            drive_db,
            output_gain_db,
            mix,
        } => {
            range(drive_db, 0.0, 36.0, &format!("{path}.driveDb"))?;
            range(output_gain_db, -36.0, 12.0, &format!("{path}.outputGainDb"))?;
            range(mix, 0.0, 1.0, &format!("{path}.mix"))?;
            Ok(EffectSpec::Saturator(SaturatorSpec {
                drive_db: drive_db as f32,
                output_gain_db: output_gain_db as f32,
                mix: mix as f32,
            }))
        }
        WireEffect::StereoDelay {
            time_seconds,
            feedback,
            damping,
            ping_pong,
            mix,
        } => {
            range(time_seconds, 0.001, 2.0, &format!("{path}.timeSeconds"))?;
            range(feedback, 0.0, 0.95, &format!("{path}.feedback"))?;
            range(damping, 0.0, 1.0, &format!("{path}.damping"))?;
            range(mix, 0.0, 1.0, &format!("{path}.mix"))?;
            Ok(EffectSpec::StereoDelay(StereoDelaySpec {
                time_seconds: time_seconds as f32,
                feedback: feedback as f32,
                damping: damping as f32,
                ping_pong,
                mix: mix as f32,
            }))
        }
    }
}

fn range(value: f64, min: f64, max: f64, path: &str) -> Result<(), PatchError> {
    if !value.is_finite() {
        return Err(PatchError::new(format!("{path} must be finite")));
    }
    if value < min || value > max {
        return Err(PatchError::new(format!(
            "{path} must be within {min}–{max}"
        )));
    }
    Ok(())
}

fn integer(value: i64, min: i64, max: i64, path: &str) -> Result<(), PatchError> {
    if value < min || value > max {
        return Err(PatchError::new(format!(
            "{path} must be within {min}–{max}"
        )));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePatch {
    source: WireSource,
    effects: Vec<WireEffect>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSource {
    frequency_hz: f64,
    gain_db: f64,
    oscillators: Vec<WireOscillator>,
    filter: Option<WireFilter>,
    amp_envelope: WireEnvelope,
}

#[derive(Deserialize)]
#[serde(
    tag = "waveform",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum WireOscillator {
    Sine {
        transpose_semitones: i64,
        detune_cents: f64,
        level: f64,
    },
    Triangle {
        transpose_semitones: i64,
        detune_cents: f64,
        level: f64,
    },
    Saw {
        transpose_semitones: i64,
        detune_cents: f64,
        level: f64,
    },
    Pulse {
        transpose_semitones: i64,
        detune_cents: f64,
        pulse_width: f64,
        level: f64,
    },
    Noise {
        level: f64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFilter {
    mode: WireFilterMode,
    cutoff_hz: f64,
    resonance: f64,
    cutoff_lfo: Option<WireCutoffLfo>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireCutoffLfo {
    shape: WireLfoShape,
    rate_hz: f64,
    amount_octaves: f64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireEnvelope {
    attack_seconds: f64,
    decay_seconds: f64,
    sustain: f64,
    release_seconds: f64,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum WireEffect {
    Saturator {
        drive_db: f64,
        output_gain_db: f64,
        mix: f64,
    },
    StereoDelay {
        time_seconds: f64,
        feedback: f64,
        damping: f64,
        ping_pong: bool,
        mix: f64,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WireFilterMode {
    Lowpass,
    Bandpass,
    Highpass,
}

impl From<WireFilterMode> for FilterMode {
    fn from(value: WireFilterMode) -> Self {
        match value {
            WireFilterMode::Lowpass => Self::Lowpass,
            WireFilterMode::Bandpass => Self::Bandpass,
            WireFilterMode::Highpass => Self::Highpass,
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
enum WireLfoShape {
    Sine,
    Triangle,
    SawUp,
    SawDown,
    Square,
}

impl From<WireLfoShape> for LfoShape {
    fn from(value: WireLfoShape) -> Self {
        match value {
            WireLfoShape::Sine => Self::Sine,
            WireLfoShape::Triangle => Self::Triangle,
            WireLfoShape::SawUp => Self::SawUp,
            WireLfoShape::SawDown => Self::SawDown,
            WireLfoShape::Square => Self::Square,
        }
    }
}
