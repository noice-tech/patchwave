use crate::dsp::crossfade::{equal_power, DiscreteCrossfade};
use crate::dsp::envelope::Envelope;
use crate::dsp::frame::StereoFrame;
use crate::dsp::oscillator::{poly_blep, OscillatorParameters};
use crate::dsp::parameter::{DbRamp, LinearRamp, LogRamp};
use crate::patch::{FilterMode, LfoShape, SourceSpec, Waveform};
use std::f32::consts::{PI, TAU};

#[derive(Clone, Copy, Debug)]
pub(crate) struct FilterParameters {
    pub active: bool,
    pub mode: FilterMode,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub lfo_active: bool,
    pub lfo_shape: LfoShape,
    pub lfo_rate_hz: f32,
    pub lfo_amount_octaves: f32,
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct SynthParameters {
    pub oscillator_count: u8,
    pub oscillators: [OscillatorParameters; 4],
    pub amp: crate::patch::EnvelopeSpec,
    pub filter: FilterParameters,
    pub gain_db: f32,
}

impl SynthParameters {
    pub(crate) fn from_spec(source: &SourceSpec) -> Self {
        let mut oscillators = [OscillatorParameters::silent(source.frequency_hz); 4];
        for (index, oscillator) in source.oscillators.iter().copied().enumerate() {
            oscillators[index] = OscillatorParameters::from_spec(source.frequency_hz, oscillator);
        }
        let filter = source.filter;
        let lfo = filter.and_then(|value| value.cutoff_lfo);
        Self {
            oscillator_count: source.oscillators.len() as u8,
            oscillators,
            amp: source.amp_envelope,
            filter: FilterParameters {
                active: filter.is_some(),
                mode: filter.map_or(FilterMode::Lowpass, |value| value.mode),
                cutoff_hz: filter.map_or(20_000.0, |value| value.cutoff_hz),
                resonance: filter.map_or(0.0, |value| value.resonance),
                lfo_active: lfo.is_some(),
                lfo_shape: lfo.map_or(LfoShape::Sine, |value| value.shape),
                lfo_rate_hz: lfo.map_or(1.0, |value| value.rate_hz),
                lfo_amount_octaves: lfo.map_or(0.0, |value| value.amount_octaves),
            },
            gain_db: source.gain_db,
        }
    }
}

struct Oscillator {
    phase: f32,
    triangle: f32,
    rng: u32,
    frequency: LogRamp,
    pulse_width: LinearRamp,
    level: LinearRamp,
    waveform: DiscreteCrossfade<Waveform>,
}

#[derive(Clone, Copy)]
struct HeldOscillator {
    frequency: f32,
    pulse_width: f32,
    level: f32,
    waveform: (Waveform, Waveform, f32),
}

impl Oscillator {
    fn new(parameters: OscillatorParameters, seed: u32) -> Self {
        Self {
            phase: 0.0,
            triangle: -1.0,
            rng: seed,
            frequency: LogRamp::new(parameters.frequency_hz),
            pulse_width: LinearRamp::new(parameters.pulse_width),
            level: LinearRamp::new(parameters.level),
            waveform: DiscreteCrossfade::new(parameters.waveform),
        }
    }

    fn update(&mut self, parameters: OscillatorParameters, sample_rate: f32) {
        self.frequency
            .set_target(parameters.frequency_hz, 0.005, sample_rate);
        self.pulse_width
            .set_target(parameters.pulse_width, 0.010, sample_rate);
        self.level.set_target(parameters.level, 0.010, sample_rate);
        self.waveform
            .request(parameters.waveform, 0.010, sample_rate);
    }

    fn hold(&mut self, sample_rate: f32) -> HeldOscillator {
        HeldOscillator {
            frequency: self.frequency.next_exact().clamp(1.0, 0.45 * sample_rate),
            pulse_width: self.pulse_width.next().clamp(0.05, 0.95),
            level: self.level.next().clamp(0.0, 1.0),
            waveform: self.waveform.next(),
        }
    }

    fn process(&mut self, held: HeldOscillator, sample_rate: f32) -> f32 {
        let dt = held.frequency / sample_rate;
        let phase = self.phase;
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let noise = ((self.rng >> 8) as f32) * (1.0 / 8_388_607.5) - 1.0;
        let sine = (TAU * phase).sin();
        let saw = 2.0 * phase - 1.0 - poly_blep(phase, dt);
        let pulse = bandlimited_pulse(phase, held.pulse_width, dt);
        let corrected = bandlimited_pulse(phase, 0.5, dt);
        self.triangle = ((-TAU * 5.0 / sample_rate).exp() * self.triangle + 4.0 * dt * corrected)
            .clamp(-1.0, 1.0);
        let values = [sine, self.triangle, saw, pulse, noise];
        let (a, b, mix) = held.waveform;
        let value = if a == b {
            values[waveform_index(a)]
        } else {
            equal_power(values[waveform_index(a)], values[waveform_index(b)], mix)
        };
        self.phase = (self.phase + dt).fract();
        value * held.level
    }
}

fn waveform_index(waveform: Waveform) -> usize {
    match waveform {
        Waveform::Sine => 0,
        Waveform::Triangle => 1,
        Waveform::Saw => 2,
        Waveform::Pulse => 3,
        Waveform::Noise => 4,
    }
}

fn bandlimited_pulse(phase: f32, width: f32, dt: f32) -> f32 {
    let mut value = if phase < width { 1.0 } else { -1.0 };
    value += poly_blep(phase, dt);
    value - poly_blep((phase - width).rem_euclid(1.0), dt)
}

struct CutoffLfo {
    phase: f32,
    active: LinearRamp,
    shape: DiscreteCrossfade<LfoShape>,
    rate: LogRamp,
    amount: LinearRamp,
}

impl CutoffLfo {
    fn new(parameters: FilterParameters) -> Self {
        Self {
            phase: 0.0,
            active: LinearRamp::new(if parameters.lfo_active { 1.0 } else { 0.0 }),
            shape: DiscreteCrossfade::new(parameters.lfo_shape),
            rate: LogRamp::new(parameters.lfo_rate_hz),
            amount: LinearRamp::new(parameters.lfo_amount_octaves),
        }
    }

    fn update(&mut self, parameters: FilterParameters, sample_rate: f32) {
        self.active.set_target(
            if parameters.lfo_active { 1.0 } else { 0.0 },
            0.010,
            sample_rate,
        );
        self.shape.request(parameters.lfo_shape, 0.010, sample_rate);
        self.rate
            .set_target(parameters.lfo_rate_hz, 0.010, sample_rate);
        self.amount
            .set_target(parameters.lfo_amount_octaves, 0.010, sample_rate);
    }

    fn set_gate(&mut self, gate: bool) {
        if gate {
            self.phase = 0.0;
        }
    }

    fn next_octaves(&mut self, sample_rate: f32) -> f32 {
        let (a, b, mix) = self.shape.next();
        let a = lfo_value(a, self.phase);
        let b = lfo_value(b, self.phase);
        let value = a + (b - a) * mix;
        self.phase = (self.phase + self.rate.next_exact() / sample_rate).fract();
        value * self.amount.next() * self.active.next()
    }
}

fn lfo_value(shape: LfoShape, phase: f32) -> f32 {
    match shape {
        LfoShape::Sine => (TAU * phase).sin(),
        LfoShape::Triangle if phase < 0.25 => 4.0 * phase,
        LfoShape::Triangle if phase < 0.75 => 2.0 - 4.0 * phase,
        LfoShape::Triangle => 4.0 * phase - 4.0,
        LfoShape::SawUp => 2.0 * phase - 1.0,
        LfoShape::SawDown => 1.0 - 2.0 * phase,
        LfoShape::Square => {
            if phase < 0.5 {
                1.0
            } else {
                -1.0
            }
        }
    }
}

#[derive(Default)]
struct FilterState {
    ic1: f32,
    ic2: f32,
}

#[derive(Clone, Copy)]
struct HeldFilter {
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    modes: (FilterMode, FilterMode, f32),
    active: f32,
}

struct Filter {
    sample_rate: f32,
    state: FilterState,
    cutoff: LogRamp,
    resonance: LinearRamp,
    active: LinearRamp,
    mode: DiscreteCrossfade<FilterMode>,
    lfo: CutoffLfo,
}

impl Filter {
    fn new(parameters: FilterParameters, sample_rate: f32) -> Self {
        Self {
            sample_rate,
            state: FilterState::default(),
            cutoff: LogRamp::new(parameters.cutoff_hz),
            resonance: LinearRamp::new(parameters.resonance),
            active: LinearRamp::new(if parameters.active { 1.0 } else { 0.0 }),
            mode: DiscreteCrossfade::new(parameters.mode),
            lfo: CutoffLfo::new(parameters),
        }
    }

    fn update(&mut self, parameters: FilterParameters) {
        self.cutoff
            .set_target(parameters.cutoff_hz, 0.010, self.sample_rate);
        self.resonance
            .set_target(parameters.resonance, 0.010, self.sample_rate);
        self.active.set_target(
            if parameters.active { 1.0 } else { 0.0 },
            0.010,
            self.sample_rate,
        );
        self.mode.request(parameters.mode, 0.010, self.sample_rate);
        self.lfo.update(parameters, self.sample_rate);
    }

    fn set_gate(&mut self, gate: bool) {
        self.lfo.set_gate(gate);
    }

    fn hold(&mut self) -> HeldFilter {
        let octaves = self.lfo.next_octaves(self.sample_rate);
        let cutoff = (self.cutoff.next_exact() * 2.0_f32.powf(octaves))
            .clamp(10.0, 20_000.0_f32.min(0.45 * self.sample_rate));
        let q = 0.5 * 40.0_f32.powf(self.resonance.next());
        let k = 1.0 / q;
        let g = (PI * cutoff / self.sample_rate).tan();
        let a1 = 1.0 / (1.0 + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        HeldFilter {
            k,
            a1,
            a2,
            a3,
            modes: self.mode.next(),
            active: self.active.next(),
        }
    }

    fn process(&mut self, input: f32, held: HeldFilter) -> f32 {
        let v3 = input - self.state.ic2;
        let v1 = held.a1 * self.state.ic1 + held.a2 * v3;
        let v2 = self.state.ic2 + held.a2 * self.state.ic1 + held.a3 * v3;
        self.state.ic1 = 2.0 * v1 - self.state.ic1;
        self.state.ic2 = 2.0 * v2 - self.state.ic2;
        if !self.state.ic1.is_finite() || !self.state.ic2.is_finite() {
            self.state = FilterState::default();
            return 0.0;
        }
        let outputs = [v2, v1, input - held.k * v1 - v2];
        let (a, b, mix) = held.modes;
        let wet = if a == b {
            outputs[filter_index(a)]
        } else {
            equal_power(outputs[filter_index(a)], outputs[filter_index(b)], mix)
        };
        equal_power(input, wet, held.active)
    }
}

fn filter_index(mode: FilterMode) -> usize {
    match mode {
        FilterMode::Lowpass => 0,
        FilterMode::Bandpass => 1,
        FilterMode::Highpass => 2,
    }
}

pub(crate) struct PreparedSynth {
    sample_rate: f32,
    count: u8,
    oscillators: [Oscillator; 4],
    filter: Filter,
    amp: Envelope,
    gain: DbRamp,
    gate: bool,
}

impl PreparedSynth {
    pub(crate) fn new(parameters: SynthParameters, sample_rate: f32) -> Self {
        let seeds = [0xA341316C, 0xC8013EA4, 0xAD90777D, 0x7E95761E];
        Self {
            sample_rate,
            count: parameters.oscillator_count,
            oscillators: std::array::from_fn(|index| {
                Oscillator::new(parameters.oscillators[index], seeds[index])
            }),
            filter: Filter::new(parameters.filter, sample_rate),
            amp: Envelope::new(parameters.amp, sample_rate),
            gain: DbRamp::new(parameters.gain_db),
            gate: false,
        }
    }

    pub(crate) fn set_gate(&mut self, gate: bool) {
        if gate != self.gate {
            self.gate = gate;
            self.amp.gate(gate);
            self.filter.set_gate(gate);
        }
    }

    pub(crate) fn retrigger(&mut self) {
        self.gate = true;
        self.amp.gate(true);
        self.filter.set_gate(true);
    }

    pub(crate) fn update(&mut self, parameters: SynthParameters) {
        for index in 0..4 {
            self.oscillators[index].update(parameters.oscillators[index], self.sample_rate);
        }
        self.filter.update(parameters.filter);
        self.amp.update(parameters.amp);
        self.gain
            .set_target(parameters.gain_db, 0.010, self.sample_rate);
    }

    pub(crate) fn process(&mut self) -> StereoFrame {
        let mut mixed = 0.0;
        for index in 0..usize::from(self.count) {
            let held = self.oscillators[index].hold(self.sample_rate);
            mixed += self.oscillators[index].process(held, self.sample_rate);
        }
        let held_filter = self.filter.hold();
        let filtered = self.filter.process(mixed, held_filter);
        let mono = filtered * self.amp.next() * self.gain.next_gain();
        StereoFrame {
            left: mono,
            right: mono,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::{parse_patch, EffectSpec, FilterSpec};

    fn synth(path: &str, rate: f32) -> PreparedSynth {
        let serialized = std::fs::read_to_string(path).unwrap();
        let patch = parse_patch(&serialized).unwrap();
        assert!(patch.effects.iter().all(|effect| matches!(
            effect,
            EffectSpec::Saturator(_) | EffectSpec::StereoDelay(_)
        )));
        PreparedSynth::new(SynthParameters::from_spec(&patch.source), rate)
    }

    #[test]
    fn output_is_finite_and_gate_release_reaches_silence() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/wobble.json"
        );
        let mut synth = synth(path, 48_000.0);
        synth.set_gate(true);
        for _ in 0..48_000 {
            let frame = synth.process();
            assert!(frame.left.is_finite() && frame.right.is_finite());
        }
        synth.set_gate(false);
        for _ in 0..48_000 {
            synth.process();
        }
        assert_eq!(synth.process(), StereoFrame::default());
    }

    #[test]
    fn every_lfo_shape_spans_both_sides_and_stays_bounded() {
        for shape in [
            LfoShape::Sine,
            LfoShape::Triangle,
            LfoShape::SawUp,
            LfoShape::SawDown,
            LfoShape::Square,
        ] {
            let mut minimum = 1.0_f32;
            let mut maximum = -1.0_f32;
            for index in 0..1_000 {
                let value = lfo_value(shape, index as f32 / 1_000.0);
                assert!((-1.0..=1.0).contains(&value), "{shape:?}: {value}");
                minimum = minimum.min(value);
                maximum = maximum.max(value);
            }
            assert!(minimum < -0.9, "{shape:?} minimum was {minimum}");
            assert!(maximum > 0.9, "{shape:?} maximum was {maximum}");
        }
    }

    #[test]
    fn lowpass_filter_is_active_and_attenuates_a_tone_above_cutoff() {
        let serialized = include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/minimal.json"
        ));
        let patch = parse_patch(serialized).unwrap();
        let mut filtered_source = patch.source.clone();
        filtered_source.filter = Some(FilterSpec {
            mode: FilterMode::Lowpass,
            cutoff_hz: 20.0,
            resonance: 0.0,
            cutoff_lfo: None,
        });
        let mut bypass = PreparedSynth::new(SynthParameters::from_spec(&patch.source), 4_000.0);
        let mut filtered =
            PreparedSynth::new(SynthParameters::from_spec(&filtered_source), 4_000.0);
        bypass.set_gate(true);
        filtered.set_gate(true);
        for _ in 0..256 {
            bypass.process();
            filtered.process();
        }
        let mut bypass_energy = 0.0_f64;
        let mut filtered_energy = 0.0_f64;
        for _ in 0..1_024 {
            bypass_energy += f64::from(bypass.process().left).powi(2);
            filtered_energy += f64::from(filtered.process().left).powi(2);
        }
        assert!(bypass_energy > 0.001);
        assert!(filtered_energy > 1e-9);
        assert!(filtered_energy < bypass_energy * 0.1);
    }

    #[test]
    fn retrigger_restarts_envelope_and_lfo_without_resetting_oscillator_phase() {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/wobble.json"
        );
        let mut synth = synth(path, 4_000.0);
        synth.set_gate(true);
        for _ in 0..137 {
            synth.process();
        }
        let oscillator_phase = synth.oscillators[0].phase;
        assert_eq!(
            synth.amp.stage(),
            crate::dsp::envelope::EnvelopeStage::Decay
        );
        assert_ne!(synth.filter.lfo.phase, 0.0);

        synth.retrigger();

        assert_eq!(synth.oscillators[0].phase, oscillator_phase);
        assert_eq!(synth.filter.lfo.phase, 0.0);
        assert_eq!(
            synth.amp.stage(),
            crate::dsp::envelope::EnvelopeStage::Attack
        );
    }

    #[test]
    fn gate_reset_restarts_sine_lfo_at_zero() {
        let parameters = FilterParameters {
            active: true,
            mode: FilterMode::Lowpass,
            cutoff_hz: 200.0,
            resonance: 0.0,
            lfo_active: true,
            lfo_shape: LfoShape::Sine,
            lfo_rate_hz: 1.0,
            lfo_amount_octaves: 2.0,
        };
        let mut lfo = CutoffLfo::new(parameters);
        lfo.set_gate(true);
        assert_eq!(lfo.next_octaves(4.0), 0.0);
        assert!((lfo.next_octaves(4.0) - 2.0).abs() < 1e-6);
        lfo.set_gate(true);
        assert_eq!(lfo.next_octaves(4.0), 0.0);
    }
}
