use crate::patch::*;
use serde::Deserialize;
use std::collections::HashSet;

const MAX_DEVICES: usize = 8;

pub(crate) fn parse(serialized: &str) -> Result<PatchSpec, PatchError> {
    let wire: WirePatchV2 = serde_json::from_str(serialized)
        .map_err(|e| PatchError::new(format!("invalid patch JSON: {e}")))?;
    range(wire.tempo_bpm, 20., 300., "tempoBpm")?;
    if wire.devices.is_empty() || wire.devices.len() > MAX_DEVICES {
        return Err(PatchError::new("devices must contain 1–8 items"));
    }
    if wire.modulators.len() > 4 {
        return Err(PatchError::new("modulators must contain 0–4 items"));
    }
    if wire.modulation_routes.len() > 8 {
        return Err(PatchError::new("modulationRoutes must contain 0–8 items"));
    }
    let mut device_ids = HashSet::new();
    let mut devices = Vec::with_capacity(wire.devices.len());
    for (i, d) in wire.devices.into_iter().enumerate() {
        let path = format!("devices[{i}]");
        let spec = match d {
            WireDevice::Synth(s) if i == 0 => {
                DeviceSpec::SubtractiveSynthV2(validate_synth(s, &path)?)
            }
            WireDevice::Synth(_) => {
                return Err(PatchError::new(format!(
                    "{path}.type must be an audio processor"
                )))
            }
            WireDevice::Saturator(s) if i > 0 => DeviceSpec::Saturator(validate_sat(s, &path)?),
            WireDevice::Delay(s) if i > 0 => DeviceSpec::StereoDelay(validate_delay(s, &path)?),
            WireDevice::Saturator(_) | WireDevice::Delay(_) => {
                return Err(PatchError::new("devices[0].type must be subtractiveSynth"))
            }
        };
        let id = match &spec {
            DeviceSpec::SubtractiveSynthV2(x) => &x.id,
            DeviceSpec::Saturator(x) => &x.id,
            DeviceSpec::StereoDelay(x) => &x.id,
        };
        valid_id(id, &format!("{path}.id"))?;
        if !device_ids.insert(id.clone()) {
            return Err(PatchError::new(format!("{path}.id must be unique")));
        }
        devices.push(spec);
    }
    let source = match &devices[0] {
        DeviceSpec::SubtractiveSynthV2(s) => s,
        _ => unreachable!(),
    };
    let mut mod_ids = HashSet::new();
    let mut modulators = Vec::new();
    for (i, m) in wire.modulators.into_iter().enumerate() {
        let path = format!("modulators[{i}]");
        let spec = validate_mod(m, &path)?;
        if !mod_ids.insert(spec.id().to_owned()) {
            return Err(PatchError::new(format!("{path}.id must be unique")));
        }
        modulators.push(spec);
    }
    let mut pending = wire
        .modulation_routes
        .into_iter()
        .enumerate()
        .map(|(i, r)| validate_route(r, &format!("modulationRoutes[{i}]")))
        .collect::<Result<Vec<_>, _>>()?;
    pending.sort_by(|a, b| a.key.cmp(&b.key));
    for pair in pending.windows(2) {
        if pair[0].key == pair[1].key {
            return Err(PatchError::new(
                "modulation routes must have unique source/target identity",
            ));
        }
    }
    let mut routes = Vec::new();
    for r in pending {
        let source_index = modulators
            .iter()
            .position(|m| m.id() == r.source)
            .ok_or_else(|| {
                PatchError::new(format!("modulation route source {} is unknown", r.source))
            })? as u8;
        if r.device != source.id {
            return Err(PatchError::new(format!(
                "modulation route device {} is unknown",
                r.device
            )));
        }
        let target = match r.target {
            PendingTarget::Filter => RouteTarget::FilterCutoff,
            PendingTarget::Gain => RouteTarget::SourceGain,
            PendingTarget::Pitch(id) => {
                let (n, o) = find_osc(source, &id)?;
                if o.oscillator.waveform == Waveform::Noise {
                    return Err(PatchError::new("oscillatorPitch target must be tonal"));
                }
                RouteTarget::OscillatorPitch(n)
            }
            PendingTarget::Pw(id) => {
                let (n, o) = find_osc(source, &id)?;
                if o.oscillator.waveform != Waveform::Pulse {
                    return Err(PatchError::new("pulseWidth target must be pulse"));
                }
                RouteTarget::PulseWidth(n)
            }
            PendingTarget::Level(id) => RouteTarget::OscillatorLevel(find_osc(source, &id)?.0),
        };
        routes.push(ModulationRouteSpec {
            source: source_index,
            target,
            amount: r.amount,
        });
    }
    Ok(PatchSpec {
        tempo_bpm: wire.tempo_bpm as f32,
        modulators,
        modulation_routes: routes,
        devices,
    })
}
fn find_osc<'a>(
    s: &'a SubtractiveSynthV2Spec,
    id: &str,
) -> Result<(u8, &'a OscillatorV2Spec), PatchError> {
    s.oscillators
        .iter()
        .enumerate()
        .find(|(_, o)| o.id == id)
        .map(|(i, o)| (i as u8, o))
        .ok_or_else(|| PatchError::new(format!("modulation route oscillator {id} is unknown")))
}

fn validate_synth(w: WireSynth, path: &str) -> Result<SubtractiveSynthV2Spec, PatchError> {
    valid_id(&w.id, &format!("{path}.id"))?;
    range(
        w.base_frequency_hz,
        1.,
        20_000.,
        &format!("{path}.baseFrequencyHz"),
    )?;
    range(w.output_gain, 0., 1., &format!("{path}.outputGain"))?;
    if w.oscillators.is_empty() || w.oscillators.len() > 4 {
        return Err(PatchError::new(format!(
            "{path}.oscillators must contain 1–4 items"
        )));
    }
    if w.audio_rate_routes.len() > 1 {
        return Err(PatchError::new(format!(
            "{path}.audioRateRoutes must contain 0–1 items"
        )));
    }
    let mut ids = HashSet::new();
    let mut oscs = Vec::new();
    for (i, o) in w.oscillators.into_iter().enumerate() {
        let p = format!("{path}.oscillators[{i}]");
        let x = validate_osc(o, &p)?;
        if !ids.insert(x.id.clone()) {
            return Err(PatchError::new(format!("{p}.id must be unique")));
        }
        oscs.push(x);
    }
    let pm = if let Some(p) = w.audio_rate_routes.into_iter().next() {
        range(
            p.index_radians,
            0.,
            8.,
            &format!("{path}.audioRateRoutes[0].indexRadians"),
        )?;
        let a = oscs
            .iter()
            .position(|o| o.id == p.source)
            .ok_or_else(|| PatchError::new("phase modulation source is unknown"))?;
        let b = oscs
            .iter()
            .position(|o| o.id == p.target)
            .ok_or_else(|| PatchError::new("phase modulation target is unknown"))?;
        if a == b {
            return Err(PatchError::new(
                "phase modulation source and target must differ",
            ));
        }
        if oscs[a].oscillator.waveform != Waveform::Sine
            || oscs[b].oscillator.waveform != Waveform::Sine
        {
            return Err(PatchError::new("phase modulation endpoints must be sine"));
        }
        Some(PhaseModulationSpec {
            source: a as u8,
            target: b as u8,
            index_radians: p.index_radians as f32,
        })
    } else {
        None
    };
    Ok(SubtractiveSynthV2Spec {
        id: w.id,
        enabled: w.enabled,
        base_frequency_hz: w.base_frequency_hz as f32,
        output_gain: w.output_gain as f32,
        oscillators: oscs,
        amp_envelope: env(w.amp_envelope, &format!("{path}.ampEnvelope"))?,
        filter: filter(w.filter, &format!("{path}.filter"))?,
        audio_rate_route: pm,
    })
}
fn validate_osc(w: WireOsc, path: &str) -> Result<OscillatorV2Spec, PatchError> {
    match w {
        WireOsc::Sine(x) => tonal(x, Waveform::Sine, path),
        WireOsc::Triangle(x) => tonal(x, Waveform::Triangle, path),
        WireOsc::Saw(x) => tonal(x, Waveform::Saw, path),
        WireOsc::Pulse(x) => {
            let mut o = tonal(x.base, Waveform::Pulse, path)?;
            range(x.pulse_width, 0.05, 0.95, &format!("{path}.pulseWidth"))?;
            o.oscillator.pulse_width = x.pulse_width as f32;
            Ok(o)
        }
        WireOsc::Noise(x) => {
            valid_id(&x.id, &format!("{path}.id"))?;
            range(x.level, 0., 1., &format!("{path}.level"))?;
            Ok(OscillatorV2Spec {
                id: x.id,
                oscillator: OscillatorSpec {
                    waveform: Waveform::Noise,
                    octave: 0,
                    semitone: 0,
                    detune_cents: 0.,
                    pulse_width: 0.5,
                    level: x.level as f32,
                },
                sends: sends(x.sends, path)?,
            })
        }
    }
}
fn tonal(w: WireTonal, waveform: Waveform, path: &str) -> Result<OscillatorV2Spec, PatchError> {
    valid_id(&w.id, &format!("{path}.id"))?;
    integer(w.octave, -4., 4., &format!("{path}.octave"))?;
    integer(w.semitone, -12., 12., &format!("{path}.semitone"))?;
    range(w.detune_cents, -100., 100., &format!("{path}.detuneCents"))?;
    range(w.level, 0., 1., &format!("{path}.level"))?;
    Ok(OscillatorV2Spec {
        id: w.id,
        oscillator: OscillatorSpec {
            waveform,
            octave: w.octave as i8,
            semitone: w.semitone as i8,
            detune_cents: w.detune_cents as f32,
            pulse_width: 0.5,
            level: w.level as f32,
        },
        sends: sends(w.sends, path)?,
    })
}
fn sends(s: WireSends, path: &str) -> Result<SendsSpec, PatchError> {
    range(s.filter, 0., 1., &format!("{path}.sends.filter"))?;
    range(s.insert, 0., 1., &format!("{path}.sends.insert"))?;
    range(s.direct, 0., 1., &format!("{path}.sends.direct"))?;
    Ok(SendsSpec {
        filter: s.filter as f32,
        insert: s.insert as f32,
        direct: s.direct as f32,
    })
}
fn filter(w: WireFilter, path: &str) -> Result<FilterV2Spec, PatchError> {
    range(w.cutoff_hz, 20., 20_000., &format!("{path}.cutoffHz"))?;
    range(w.resonance, 0., 1., &format!("{path}.resonance"))?;
    range(w.sends.insert, 0., 1., &format!("{path}.sends.insert"))?;
    range(w.sends.direct, 0., 1., &format!("{path}.sends.direct"))?;
    Ok(FilterV2Spec {
        enabled: w.enabled,
        mode: w.mode.into(),
        cutoff_hz: w.cutoff_hz as f32,
        resonance: w.resonance as f32,
        insert_send: w.sends.insert as f32,
        direct_send: w.sends.direct as f32,
    })
}
fn env(w: WireEnvelope, path: &str) -> Result<EnvelopeSpec, PatchError> {
    range(w.attack_seconds, 0., 30., &format!("{path}.attackSeconds"))?;
    range(w.decay_seconds, 0., 30., &format!("{path}.decaySeconds"))?;
    range(w.sustain, 0., 1., &format!("{path}.sustain"))?;
    range(
        w.release_seconds,
        0.,
        30.,
        &format!("{path}.releaseSeconds"),
    )?;
    Ok(EnvelopeSpec {
        attack_seconds: w.attack_seconds as f32,
        decay_seconds: w.decay_seconds as f32,
        sustain: w.sustain as f32,
        release_seconds: w.release_seconds as f32,
    })
}
fn validate_mod(w: WireMod, path: &str) -> Result<ModulatorSpec, PatchError> {
    match w {
        WireMod::Lfo(x) => {
            valid_id(&x.id, &format!("{path}.id"))?;
            range(x.phase_offset, 0., 1., &format!("{path}.phaseOffset"))?;
            if x.phase_offset >= 1. {
                return Err(PatchError::new(format!("{path}.phaseOffset must be < 1")));
            }
            let rate = match x.rate {
                WireRate::Hz { frequency_hz } => {
                    range(frequency_hz, 0.01, 40., &format!("{path}.rate.frequencyHz"))?;
                    LfoRate::Hz(frequency_hz as f32)
                }
                WireRate::Sync { division } => LfoRate::Sync(division.value()),
            };
            Ok(ModulatorSpec::Lfo {
                id: x.id,
                enabled: x.enabled,
                shape: x.shape.into(),
                polarity: x.polarity.into(),
                rate,
                phase_mode: x.phase_mode.into(),
                phase_offset: x.phase_offset as f32,
            })
        }
        WireMod::Envelope(x) => {
            valid_id(&x.id, &format!("{path}.id"))?;
            Ok(ModulatorSpec::Envelope {
                id: x.id,
                enabled: x.enabled,
                envelope: env(x.envelope, path)?,
            })
        }
    }
}
struct PendingRoute {
    source: String,
    device: String,
    target: PendingTarget,
    amount: f32,
    key: String,
}
enum PendingTarget {
    Filter,
    Gain,
    Pitch(String),
    Pw(String),
    Level(String),
}
fn validate_route(w: WireRoute, path: &str) -> Result<PendingRoute, PatchError> {
    valid_id(&w.source, &format!("{path}.source"))?;
    let count = [w.amount_octaves, w.amount_semitones, w.amount, w.amount_db]
        .iter()
        .filter(|x| x.is_some())
        .count();
    if count != 1 {
        return Err(PatchError::new(format!(
            "{path} must contain exactly one amount field"
        )));
    }
    let (target, device, amount, kind, osc) = match w.target {
        WireTarget::FilterCutoff { device } => (
            PendingTarget::Filter,
            device,
            checked_amount(w.amount_octaves, -8., 8., path)?,
            "filterCutoff",
            String::new(),
        ),
        WireTarget::SourceGain { device } => (
            PendingTarget::Gain,
            device,
            checked_amount(w.amount_db, -60., 24., path)?,
            "sourceGain",
            String::new(),
        ),
        WireTarget::OscillatorPitch { device, oscillator } => (
            PendingTarget::Pitch(oscillator.clone()),
            device,
            checked_amount(w.amount_semitones, -48., 48., path)?,
            "oscillatorPitch",
            oscillator,
        ),
        WireTarget::PulseWidth { device, oscillator } => (
            PendingTarget::Pw(oscillator.clone()),
            device,
            checked_amount(w.amount, -1., 1., path)?,
            "pulseWidth",
            oscillator,
        ),
        WireTarget::OscillatorLevel { device, oscillator } => (
            PendingTarget::Level(oscillator.clone()),
            device,
            checked_amount(w.amount, -1., 1., path)?,
            "oscillatorLevel",
            oscillator,
        ),
    };
    valid_id(&device, &format!("{path}.target.device"))?;
    if !osc.is_empty() {
        valid_id(&osc, &format!("{path}.target.oscillator"))?;
    }
    let key = format!("{}\0{}\0{}\0{}", w.source, kind, device, osc);
    Ok(PendingRoute {
        source: w.source,
        device,
        target,
        amount,
        key,
    })
}

fn checked_amount(v: Option<f64>, min: f64, max: f64, path: &str) -> Result<f32, PatchError> {
    let v = v.ok_or_else(|| PatchError::new(format!("{path} amount field is invalid")))?;
    range(v, min, max, &format!("{path}.amount"))?;
    Ok(v as f32)
}
fn validate_sat(w: WireSat, path: &str) -> Result<SaturatorSpec, PatchError> {
    range(w.drive_db, 0., 36., &format!("{path}.driveDb"))?;
    range(w.output_gain_db, -36., 12., &format!("{path}.outputGainDb"))?;
    range(w.mix, 0., 1., &format!("{path}.mix"))?;
    Ok(SaturatorSpec {
        id: w.id,
        enabled: w.enabled,
        drive_db: w.drive_db as f32,
        output_gain_db: w.output_gain_db as f32,
        mix: w.mix as f32,
    })
}
fn validate_delay(w: WireDelay, path: &str) -> Result<StereoDelaySpec, PatchError> {
    range(w.time_ms, 1., 2000., &format!("{path}.timeMs"))?;
    range(w.feedback, 0., 0.95, &format!("{path}.feedback"))?;
    range(w.damping, 0., 1., &format!("{path}.damping"))?;
    range(w.mix, 0., 1., &format!("{path}.mix"))?;
    Ok(StereoDelaySpec {
        id: w.id,
        enabled: w.enabled,
        time_ms: w.time_ms as f32,
        feedback: w.feedback as f32,
        damping: w.damping as f32,
        ping_pong: w.ping_pong,
        mix: w.mix as f32,
    })
}
fn range(v: f64, min: f64, max: f64, path: &str) -> Result<(), PatchError> {
    if !v.is_finite() {
        return Err(PatchError::new(format!("{path} must be finite")));
    }
    if v < min {
        return Err(PatchError::new(format!("{path} must be >= {min}")));
    }
    if v > max {
        return Err(PatchError::new(format!("{path} must be <= {max}")));
    }
    Ok(())
}
fn integer(v: f64, min: f64, max: f64, path: &str) -> Result<(), PatchError> {
    range(v, min, max, path)?;
    if v.fract() != 0. {
        return Err(PatchError::new(format!("{path} must be an integer")));
    }
    Ok(())
}
fn valid_id(id: &str, path: &str) -> Result<(), PatchError> {
    if id.is_empty() || id.len() > 64 || !id.is_ascii() {
        return Err(PatchError::new(format!("{path} is invalid")));
    }
    let mut b = id.bytes();
    let f = b.next().unwrap();
    if !f.is_ascii_alphanumeric() || !b.all(|x| x.is_ascii_alphanumeric() || x == b'_' || x == b'-')
    {
        return Err(PatchError::new(format!("{path} is invalid")));
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePatchV2 {
    tempo_bpm: f64,
    modulators: Vec<WireMod>,
    modulation_routes: Vec<WireRoute>,
    devices: Vec<WireDevice>,
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum WireDevice {
    #[serde(rename = "subtractiveSynth")]
    Synth(WireSynth),
    #[serde(rename = "saturator")]
    Saturator(WireSat),
    #[serde(rename = "stereoDelay")]
    Delay(WireDelay),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSynth {
    id: String,
    enabled: bool,
    base_frequency_hz: f64,
    output_gain: f64,
    oscillators: Vec<WireOsc>,
    amp_envelope: WireEnvelope,
    filter: WireFilter,
    audio_rate_routes: Vec<WirePm>,
}
#[derive(Deserialize)]
#[serde(tag = "waveform", deny_unknown_fields)]
enum WireOsc {
    #[serde(rename = "sine")]
    Sine(WireTonal),
    #[serde(rename = "triangle")]
    Triangle(WireTonal),
    #[serde(rename = "saw")]
    Saw(WireTonal),
    #[serde(rename = "pulse")]
    Pulse(WirePulse),
    #[serde(rename = "noise")]
    Noise(WireNoise),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireTonal {
    id: String,
    octave: f64,
    semitone: f64,
    detune_cents: f64,
    level: f64,
    sends: WireSends,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePulse {
    #[serde(flatten)]
    base: WireTonal,
    pulse_width: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireNoise {
    id: String,
    level: f64,
    sends: WireSends,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSends {
    filter: f64,
    insert: f64,
    direct: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFilter {
    enabled: bool,
    mode: WireFilterMode,
    cutoff_hz: f64,
    resonance: f64,
    sends: WireFilterSends,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireFilterSends {
    insert: f64,
    direct: f64,
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
#[serde(rename_all = "lowercase")]
enum WireFilterMode {
    Lowpass,
    Bandpass,
    Highpass,
}
impl From<WireFilterMode> for FilterMode {
    fn from(x: WireFilterMode) -> Self {
        match x {
            WireFilterMode::Lowpass => Self::Lowpass,
            WireFilterMode::Bandpass => Self::Bandpass,
            WireFilterMode::Highpass => Self::Highpass,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WirePm {
    #[serde(rename = "type")]
    _type: PmType,
    source: String,
    target: String,
    index_radians: f64,
}
#[derive(Deserialize)]
enum PmType {
    #[serde(rename = "phaseModulation")]
    PhaseModulation,
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum WireMod {
    #[serde(rename = "lfo")]
    Lfo(WireLfo),
    #[serde(rename = "envelope")]
    Envelope(WireEnvMod),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireLfo {
    id: String,
    enabled: bool,
    shape: WireLfoShape,
    polarity: WirePolarity,
    rate: WireRate,
    phase_mode: WirePhaseMode,
    phase_offset: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireEnvMod {
    id: String,
    enabled: bool,
    #[serde(flatten)]
    envelope: WireEnvelope,
}
#[derive(Deserialize)]
enum WireLfoShape {
    #[serde(rename = "sine")]
    Sine,
    #[serde(rename = "triangle")]
    Triangle,
    #[serde(rename = "sawUp")]
    SawUp,
    #[serde(rename = "sawDown")]
    SawDown,
    #[serde(rename = "square")]
    Square,
}
impl From<WireLfoShape> for LfoShape {
    fn from(x: WireLfoShape) -> Self {
        match x {
            WireLfoShape::Sine => Self::Sine,
            WireLfoShape::Triangle => Self::Triangle,
            WireLfoShape::SawUp => Self::SawUp,
            WireLfoShape::SawDown => Self::SawDown,
            WireLfoShape::Square => Self::Square,
        }
    }
}
#[derive(Deserialize)]
enum WirePolarity {
    #[serde(rename = "unipolar")]
    Unipolar,
    #[serde(rename = "bipolar")]
    Bipolar,
}
impl From<WirePolarity> for LfoPolarity {
    fn from(x: WirePolarity) -> Self {
        match x {
            WirePolarity::Unipolar => Self::Unipolar,
            WirePolarity::Bipolar => Self::Bipolar,
        }
    }
}
#[derive(Deserialize)]
enum WirePhaseMode {
    #[serde(rename = "free")]
    Free,
    #[serde(rename = "gateReset")]
    GateReset,
}
impl From<WirePhaseMode> for LfoPhaseMode {
    fn from(x: WirePhaseMode) -> Self {
        match x {
            WirePhaseMode::Free => Self::Free,
            WirePhaseMode::GateReset => Self::GateReset,
        }
    }
}
#[derive(Deserialize)]
#[serde(tag = "mode", deny_unknown_fields)]
enum WireRate {
    #[serde(rename = "hz", rename_all = "camelCase")]
    Hz { frequency_hz: f64 },
    #[serde(rename = "sync")]
    Sync { division: WireDivision },
}
#[derive(Deserialize)]
enum WireDivision {
    #[serde(rename = "1/1")]
    D1,
    #[serde(rename = "1/2")]
    D2,
    #[serde(rename = "1/4")]
    D4,
    #[serde(rename = "1/8")]
    D8,
    #[serde(rename = "1/16")]
    D16,
}
impl WireDivision {
    fn value(self) -> u8 {
        match self {
            Self::D1 => 1,
            Self::D2 => 2,
            Self::D4 => 4,
            Self::D8 => 8,
            Self::D16 => 16,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireRoute {
    source: String,
    target: WireTarget,
    amount_octaves: Option<f64>,
    amount_semitones: Option<f64>,
    amount: Option<f64>,
    amount_db: Option<f64>,
}
#[derive(Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
enum WireTarget {
    #[serde(rename = "filterCutoff")]
    FilterCutoff { device: String },
    #[serde(rename = "oscillatorPitch")]
    OscillatorPitch { device: String, oscillator: String },
    #[serde(rename = "pulseWidth")]
    PulseWidth { device: String, oscillator: String },
    #[serde(rename = "oscillatorLevel")]
    OscillatorLevel { device: String, oscillator: String },
    #[serde(rename = "sourceGain")]
    SourceGain { device: String },
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireSat {
    id: String,
    enabled: bool,
    drive_db: f64,
    output_gain_db: f64,
    mix: f64,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireDelay {
    id: String,
    enabled: bool,
    time_ms: f64,
    feedback: f64,
    damping: f64,
    ping_pong: bool,
    mix: f64,
}
