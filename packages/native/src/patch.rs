use std::fmt::{Display, Formatter};

pub const PATCH_JSON_MAX_BYTES: usize = 65_536;

#[derive(Debug, Clone, PartialEq)]
pub struct PatchSpec {
    pub tempo_bpm: f32,
    pub modulators: Vec<ModulatorSpec>,
    pub modulation_routes: Vec<ModulationRouteSpec>,
    pub devices: Vec<DeviceSpec>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DeviceSpec {
    SubtractiveSynthV2(SubtractiveSynthV2Spec),
    Saturator(SaturatorSpec),
    StereoDelay(StereoDelaySpec),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub(crate) enum DeviceKind {
    SubtractiveSynthV2,
    Saturator,
    StereoDelay,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BoundedId {
    length: u8,
    bytes: [u8; 64],
}
impl BoundedId {
    const EMPTY: Self = Self {
        length: 0,
        bytes: [0; 64],
    };
    fn from_valid(value: &str) -> Self {
        debug_assert!(value.len() <= 64 && value.is_ascii());
        let mut result = Self::EMPTY;
        result.length = value.len() as u8;
        result.bytes[..value.len()].copy_from_slice(value.as_bytes());
        result
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct DeviceIdentity {
    pub(crate) id: BoundedId,
    pub(crate) kind: DeviceKind,
}
impl DeviceIdentity {
    const EMPTY: Self = Self {
        id: BoundedId::EMPTY,
        kind: DeviceKind::Saturator,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ModulatorIdentity {
    pub(crate) id: BoundedId,
    pub(crate) kind: u8,
}
impl ModulatorIdentity {
    const EMPTY: Self = Self {
        id: BoundedId::EMPTY,
        kind: 0,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RouteIdentity {
    pub(crate) source: u8,
    pub(crate) target_kind: u8,
    pub(crate) target_slot: u8,
}
impl RouteIdentity {
    const EMPTY: Self = Self {
        source: 0,
        target_kind: 0,
        target_slot: 0,
    };
    pub(crate) fn from_route(route: &ModulationRouteSpec) -> Self {
        Self::from_parts(route.source, route.target)
    }
    pub(crate) fn from_parts(source: u8, target: RouteTarget) -> Self {
        let (target_kind, target_slot) = match target {
            RouteTarget::FilterCutoff => (1, 0),
            RouteTarget::OscillatorPitch(slot) => (2, slot),
            RouteTarget::PulseWidth(slot) => (3, slot),
            RouteTarget::OscillatorLevel(slot) => (4, slot),
            RouteTarget::SourceGain => (5, 0),
        };
        Self {
            source,
            target_kind,
            target_slot,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct PmIdentity {
    pub(crate) present: bool,
    pub(crate) source: u8,
    pub(crate) target: u8,
    pub(crate) latency_frames: u8,
}
impl PmIdentity {
    const EMPTY: Self = Self {
        present: false,
        source: 0,
        target: 0,
        latency_frames: 0,
    };
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct StructuralSignature {
    pub(crate) device_count: u8,
    pub(crate) devices: [DeviceIdentity; 8],
    pub(crate) oscillator_count: u8,
    pub(crate) oscillators: [BoundedId; 4],
    pub(crate) modulator_count: u8,
    pub(crate) modulators: [ModulatorIdentity; 4],
    pub(crate) route_count: u8,
    pub(crate) routes: [RouteIdentity; 8],
    pub(crate) pm: PmIdentity,
}
impl StructuralSignature {
    const EMPTY: Self = Self {
        device_count: 0,
        devices: [DeviceIdentity::EMPTY; 8],
        oscillator_count: 0,
        oscillators: [BoundedId::EMPTY; 4],
        modulator_count: 0,
        modulators: [ModulatorIdentity::EMPTY; 4],
        route_count: 0,
        routes: [RouteIdentity::EMPTY; 8],
        pm: PmIdentity::EMPTY,
    };
}

impl DeviceSpec {
    pub(crate) fn kind(&self) -> DeviceKind {
        match self {
            Self::SubtractiveSynthV2(_) => DeviceKind::SubtractiveSynthV2,
            Self::Saturator(_) => DeviceKind::Saturator,
            Self::StereoDelay(_) => DeviceKind::StereoDelay,
        }
    }

    fn id(&self) -> &str {
        match self {
            Self::SubtractiveSynthV2(device) => &device.id,
            Self::Saturator(device) => &device.id,
            Self::StereoDelay(device) => &device.id,
        }
    }
}

impl PatchSpec {
    pub(crate) fn structural_signature(&self) -> StructuralSignature {
        let mut signature = StructuralSignature::EMPTY;
        signature.device_count = self.devices.len() as u8;
        for (index, device) in self.devices.iter().enumerate() {
            signature.devices[index] = DeviceIdentity {
                id: BoundedId::from_valid(device.id()),
                kind: device.kind(),
            };
        }
        if let Some(DeviceSpec::SubtractiveSynthV2(synth)) = self.devices.first() {
            signature.oscillator_count = synth.oscillators.len() as u8;
            for (index, oscillator) in synth.oscillators.iter().enumerate() {
                signature.oscillators[index] = BoundedId::from_valid(&oscillator.id);
            }
            if let Some(pm) = synth.audio_rate_route {
                signature.pm = PmIdentity {
                    present: true,
                    source: pm.source,
                    target: pm.target,
                    latency_frames: 48,
                };
            }
        }
        signature.modulator_count = self.modulators.len() as u8;
        for (index, modulator) in self.modulators.iter().enumerate() {
            signature.modulators[index] = ModulatorIdentity {
                id: BoundedId::from_valid(modulator.id()),
                kind: match modulator {
                    ModulatorSpec::Lfo { .. } => 1,
                    ModulatorSpec::Envelope { .. } => 2,
                },
            };
        }
        signature.route_count = self.modulation_routes.len() as u8;
        for (index, route) in self.modulation_routes.iter().enumerate() {
            signature.routes[index] = RouteIdentity::from_route(route);
        }
        signature
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct SendsSpec {
    pub filter: f32,
    pub insert: f32,
    pub direct: f32,
}
#[derive(Debug, Clone, PartialEq)]
pub struct OscillatorV2Spec {
    pub id: String,
    pub oscillator: OscillatorSpec,
    pub sends: SendsSpec,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FilterV2Spec {
    pub enabled: bool,
    pub mode: FilterMode,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub insert_send: f32,
    pub direct_send: f32,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PhaseModulationSpec {
    pub source: u8,
    pub target: u8,
    pub index_radians: f32,
}
#[derive(Debug, Clone, PartialEq)]
pub struct SubtractiveSynthV2Spec {
    pub id: String,
    pub enabled: bool,
    pub base_frequency_hz: f32,
    pub output_gain: f32,
    pub oscillators: Vec<OscillatorV2Spec>,
    pub amp_envelope: EnvelopeSpec,
    pub filter: FilterV2Spec,
    pub audio_rate_route: Option<PhaseModulationSpec>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoShape {
    Sine,
    Triangle,
    SawUp,
    SawDown,
    Square,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoPolarity {
    Unipolar,
    Bipolar,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LfoPhaseMode {
    Free,
    GateReset,
}
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoRate {
    Hz(f32),
    Sync(u8),
}
#[derive(Debug, Clone, PartialEq)]
pub enum ModulatorSpec {
    Lfo {
        id: String,
        enabled: bool,
        shape: LfoShape,
        polarity: LfoPolarity,
        rate: LfoRate,
        phase_mode: LfoPhaseMode,
        phase_offset: f32,
    },
    Envelope {
        id: String,
        enabled: bool,
        envelope: EnvelopeSpec,
    },
}
impl ModulatorSpec {
    pub(crate) fn id(&self) -> &str {
        match self {
            Self::Lfo { id, .. } | Self::Envelope { id, .. } => id,
        }
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteTarget {
    FilterCutoff,
    OscillatorPitch(u8),
    PulseWidth(u8),
    OscillatorLevel(u8),
    SourceGain,
}
#[derive(Debug, Clone, PartialEq)]
pub struct ModulationRouteSpec {
    pub source: u8,
    pub target: RouteTarget,
    pub amount: f32,
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

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct OscillatorSpec {
    pub waveform: Waveform,
    pub octave: i8,
    pub semitone: i8,
    pub detune_cents: f32,
    pub pulse_width: f32,
    pub level: f32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterMode {
    Lowpass,
    Bandpass,
    Highpass,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SaturatorSpec {
    pub id: String,
    pub enabled: bool,
    pub drive_db: f32,
    pub output_gain_db: f32,
    pub mix: f32,
}

#[derive(Debug, Clone, PartialEq)]
pub struct StereoDelaySpec {
    pub id: String,
    pub enabled: bool,
    pub time_ms: f32,
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
    crate::patch_v2::parse(serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn composable() -> &'static str {
        include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/composable.json"
        ))
    }

    #[test]
    fn route_order_is_canonical_and_parameter_edits_retain_signature() {
        let base = parse_patch(composable()).unwrap();
        let mut value: serde_json::Value = serde_json::from_str(composable()).unwrap();
        value["modulationRoutes"].as_array_mut().unwrap().reverse();
        let reordered = parse_patch(&serde_json::to_string(&value).unwrap()).unwrap();
        assert_eq!(base, reordered);
        assert_eq!(
            base.structural_signature(),
            reordered.structural_signature()
        );

        let mut parameters = base.clone();
        parameters.tempo_bpm = 200.0;
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut parameters.devices[0] else {
            panic!("synth")
        };
        synth.output_gain = 0.7;
        synth.oscillators[0].oscillator.level = 0.2;
        synth.audio_rate_route.as_mut().unwrap().index_radians = 0.0;
        parameters.modulation_routes[0].amount = -2.0;
        assert_eq!(
            base.structural_signature(),
            parameters.structural_signature()
        );
    }

    #[test]
    fn nested_identity_is_structural() {
        let base = parse_patch(composable()).unwrap();
        let mut renamed = base.clone();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut renamed.devices[0] else {
            panic!("synth")
        };
        synth.oscillators[0].id = "renamed".to_owned();
        assert_ne!(base.structural_signature(), renamed.structural_signature());
    }
}
