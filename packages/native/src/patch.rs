use std::fmt::{Display, Formatter};

pub const PATCH_JSON_MAX_BYTES: usize = 65_536;

#[derive(Debug, Clone, PartialEq)]
pub struct PatchSpec {
    pub source: SourceSpec,
    pub effects: Vec<EffectSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EffectSpec {
    Saturator(SaturatorSpec),
    StereoDelay(StereoDelaySpec),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum EffectKind {
    Saturator,
    StereoDelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StructuralSignature {
    pub(crate) oscillator_count: u8,
    pub(crate) effect_count: u8,
    pub(crate) effects: [EffectKind; 7],
}

impl PatchSpec {
    pub(crate) fn structural_signature(&self) -> StructuralSignature {
        let mut effects = [EffectKind::Saturator; 7];
        for (index, effect) in self.effects.iter().enumerate() {
            effects[index] = effect.kind();
        }
        StructuralSignature {
            oscillator_count: self.source.oscillators.len() as u8,
            effect_count: self.effects.len() as u8,
            effects,
        }
    }
}

impl EffectSpec {
    pub(crate) fn kind(self) -> EffectKind {
        match self {
            Self::Saturator(_) => EffectKind::Saturator,
            Self::StereoDelay(_) => EffectKind::StereoDelay,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SourceSpec {
    pub frequency_hz: f32,
    pub gain_db: f32,
    pub oscillators: Vec<OscillatorSpec>,
    pub filter: Option<FilterSpec>,
    pub amp_envelope: EnvelopeSpec,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OscillatorSpec {
    pub waveform: Waveform,
    pub transpose_semitones: i8,
    pub detune_cents: f32,
    pub pulse_width: f32,
    pub level: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterSpec {
    pub mode: FilterMode,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub cutoff_lfo: Option<CutoffLfoSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CutoffLfoSpec {
    pub shape: LfoShape,
    pub rate_hz: f32,
    pub amount_octaves: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct EnvelopeSpec {
    pub attack_seconds: f32,
    pub decay_seconds: f32,
    pub sustain: f32,
    pub release_seconds: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Waveform {
    Sine,
    Triangle,
    Saw,
    Pulse,
    Noise,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Lowpass,
    Bandpass,
    Highpass,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoShape {
    Sine,
    Triangle,
    SawUp,
    SawDown,
    Square,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SaturatorSpec {
    pub drive_db: f32,
    pub output_gain_db: f32,
    pub mix: f32,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct StereoDelaySpec {
    pub time_seconds: f32,
    pub feedback: f32,
    pub damping: f32,
    pub ping_pong: bool,
    pub mix: f32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PatchError(String);

impl PatchError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl Display for PatchError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for PatchError {}

pub fn parse_patch(serialized: &str) -> Result<PatchSpec, PatchError> {
    if serialized.len() > PATCH_JSON_MAX_BYTES {
        return Err(PatchError::new(format!(
            "patch must be at most {PATCH_JSON_MAX_BYTES} UTF-8 bytes"
        )));
    }
    crate::patch_wire::parse(serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wobble() -> PatchSpec {
        parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/wobble.json"
        )))
        .unwrap()
    }

    #[test]
    fn ordinary_edits_retain_structural_signature() {
        let base = wobble();
        let mut parameters = base.clone();
        parameters.source.frequency_hz = 220.0;
        parameters.source.oscillators[0].waveform = Waveform::Pulse;
        parameters.source.filter.as_mut().unwrap().mode = FilterMode::Highpass;
        parameters.source.filter.as_mut().unwrap().cutoff_lfo = None;
        let EffectSpec::Saturator(effect) = &mut parameters.effects[0] else {
            panic!("saturator")
        };
        effect.drive_db = 3.0;
        assert_eq!(
            base.structural_signature(),
            parameters.structural_signature()
        );
    }

    #[test]
    fn counts_and_effect_kinds_are_structural() {
        let base = wobble();
        let mut oscillator_count = base.clone();
        oscillator_count.source.oscillators.pop();
        assert_ne!(
            base.structural_signature(),
            oscillator_count.structural_signature()
        );

        let mut effect_kind = base.clone();
        effect_kind.effects.swap(0, 1);
        assert_ne!(
            base.structural_signature(),
            effect_kind.structural_signature()
        );
    }
}
