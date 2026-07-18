use crate::dsp::crossfade::{equal_power, DiscreteCrossfade};
use crate::dsp::decimator::Decimator4;
use crate::dsp::envelope::Envelope;
use crate::dsp::frame::StereoFrame;
use crate::dsp::oscillator::{poly_blep, OscillatorParameters};
use crate::dsp::parameter::{LinearRamp, LogRamp};
use crate::patch::{
    EnvelopeSpec, FilterMode, PhaseModulationSpec, SendsSpec, SubtractiveSynthV2Spec, Waveform,
};
use std::f32::consts::{PI, TAU};

#[derive(Clone, Copy, Debug, Default)]
pub(crate) struct ControlFrame {
    pub filter_octaves: f32,
    pub pitch_semitones: [f32; 4],
    pub pulse_width: [f32; 4],
    pub level: [f32; 4],
    pub source_gain_db: f32,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct OscillatorV2Parameters {
    pub oscillator: OscillatorParameters,
    pub sends: SendsSpec,
}
impl OscillatorV2Parameters {
    fn silent(base: f32) -> Self {
        Self {
            oscillator: OscillatorParameters::silent(base),
            sends: SendsSpec::default(),
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct FilterV2Parameters {
    pub enabled: bool,
    pub mode: FilterMode,
    pub cutoff_hz: f32,
    pub resonance: f32,
    pub insert_send: f32,
    pub direct_send: f32,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct PmParameters {
    pub present: bool,
    pub source: u8,
    pub target: u8,
    pub index: f32,
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct SynthV2Parameters {
    pub enabled: bool,
    pub oscillator_count: u8,
    pub oscillators: [OscillatorV2Parameters; 4],
    pub amp: EnvelopeSpec,
    pub filter: FilterV2Parameters,
    pub output_gain: f32,
    pub pm: PmParameters,
}
impl SynthV2Parameters {
    pub(crate) fn from_spec(s: &SubtractiveSynthV2Spec) -> Self {
        let mut oscs = [OscillatorV2Parameters::silent(s.base_frequency_hz); 4];
        for (i, o) in s.oscillators.iter().enumerate() {
            oscs[i] = OscillatorV2Parameters {
                oscillator: OscillatorParameters::from_spec(s.base_frequency_hz, o.oscillator),
                sends: o.sends,
            };
        }
        let pm = s
            .audio_rate_route
            .map(|x| PmParameters {
                present: true,
                source: x.source,
                target: x.target,
                index: x.index_radians,
            })
            .unwrap_or(PmParameters {
                present: false,
                source: 0,
                target: 0,
                index: 0.,
            });
        Self {
            enabled: s.enabled,
            oscillator_count: s.oscillators.len() as u8,
            oscillators: oscs,
            amp: s.amp_envelope,
            filter: FilterV2Parameters {
                enabled: s.filter.enabled,
                mode: s.filter.mode,
                cutoff_hz: s.filter.cutoff_hz,
                resonance: s.filter.resonance,
                insert_send: s.filter.insert_send,
                direct_send: s.filter.direct_send,
            },
            output_gain: s.output_gain,
            pm,
        }
    }
}

#[derive(Clone, Copy)]
struct HeldOsc {
    frequency: f32,
    pulse_width: f32,
    level: f32,
    sends: SendsSpec,
    waveform: (Waveform, Waveform, f32),
}
struct OscillatorV2 {
    phase: f32,
    triangle: f32,
    rng: u32,
    frequency: LogRamp,
    pulse_width: LinearRamp,
    level: LinearRamp,
    filter_send: LinearRamp,
    insert_send: LinearRamp,
    direct_send: LinearRamp,
    waveform: DiscreteCrossfade<Waveform>,
}
impl OscillatorV2 {
    fn new(p: OscillatorV2Parameters, seed: u32) -> Self {
        Self {
            phase: 0.,
            triangle: -1.,
            rng: seed,
            frequency: LogRamp::new(p.oscillator.frequency_hz),
            pulse_width: LinearRamp::new(p.oscillator.pulse_width),
            level: LinearRamp::new(p.oscillator.level),
            filter_send: LinearRamp::new(p.sends.filter),
            insert_send: LinearRamp::new(p.sends.insert),
            direct_send: LinearRamp::new(p.sends.direct),
            waveform: DiscreteCrossfade::new(p.oscillator.waveform),
        }
    }
    fn update(&mut self, p: OscillatorV2Parameters, rate: f32) {
        self.frequency
            .set_target(p.oscillator.frequency_hz, 0.005, rate);
        self.pulse_width
            .set_target(p.oscillator.pulse_width, 0.01, rate);
        self.level.set_target(p.oscillator.level, 0.01, rate);
        self.filter_send.set_target(p.sends.filter, 0.01, rate);
        self.insert_send.set_target(p.sends.insert, 0.01, rate);
        self.direct_send.set_target(p.sends.direct, 0.01, rate);
        self.waveform.request(p.oscillator.waveform, 0.01, rate)
    }
    fn hold(&mut self, pitch: f32, pw: f32, level: f32, processing_rate: f32) -> HeldOsc {
        HeldOsc {
            frequency: (self.frequency.next_exact() * 2f32.powf(pitch.clamp(-96., 96.) / 12.))
                .clamp(1., 0.45 * processing_rate),
            pulse_width: (self.pulse_width.next() + pw.clamp(-1., 1.)).clamp(0.05, 0.95),
            level: (self.level.next() + level.clamp(-1., 1.)).clamp(0., 1.),
            sends: SendsSpec {
                filter: self.filter_send.next(),
                insert: self.insert_send.next(),
                direct: self.direct_send.next(),
            },
            waveform: self.waveform.next(),
        }
    }
    fn render(&mut self, h: HeldOsc, rate: f32, phase_offset: f32, force_sine: bool) -> f32 {
        let dt = h.frequency / rate;
        let t = self.phase;
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 17;
        self.rng ^= self.rng << 5;
        let noise = ((self.rng >> 8) as f32) * (1. / 8_388_607.5) - 1.;
        let sine = (TAU * (t + phase_offset)).sin();
        let saw = 2. * t - 1. - poly_blep(t, dt);
        let pulse = bandlimited_pulse(t, h.pulse_width, dt);
        let corrected = bandlimited_pulse(t, 0.5, dt);
        self.triangle =
            ((-TAU * 5. / rate).exp() * self.triangle + 4. * dt * corrected).clamp(-1., 1.);
        let values = [sine, self.triangle, saw, pulse, noise];
        let value = if force_sine {
            sine
        } else {
            let (a, b, m) = h.waveform;
            if a == b {
                values[idx(a)]
            } else {
                equal_power(values[idx(a)], values[idx(b)], m)
            }
        };
        self.phase = (self.phase + dt).fract();
        value
    }
}
fn idx(w: Waveform) -> usize {
    match w {
        Waveform::Sine => 0,
        Waveform::Triangle => 1,
        Waveform::Saw => 2,
        Waveform::Pulse => 3,
        Waveform::Noise => 4,
    }
}
fn bandlimited_pulse(t: f32, width: f32, dt: f32) -> f32 {
    let mut y = if t < width { 1. } else { -1. };
    y += poly_blep(t, dt);
    y - poly_blep((t - width).rem_euclid(1.), dt)
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
    enabled: f32,
    insert: f32,
    direct: f32,
}
struct FilterV2 {
    processing_rate: f32,
    output_rate: f32,
    state: FilterState,
    cutoff: LogRamp,
    resonance: LinearRamp,
    enabled: LinearRamp,
    insert: LinearRamp,
    direct: LinearRamp,
    mode: DiscreteCrossfade<FilterMode>,
}
impl FilterV2 {
    fn new(p: FilterV2Parameters, processing_rate: f32, output_rate: f32) -> Self {
        Self {
            processing_rate,
            output_rate,
            state: FilterState::default(),
            cutoff: LogRamp::new(p.cutoff_hz),
            resonance: LinearRamp::new(p.resonance),
            enabled: LinearRamp::new(if p.enabled { 1. } else { 0. }),
            insert: LinearRamp::new(p.insert_send),
            direct: LinearRamp::new(p.direct_send),
            mode: DiscreteCrossfade::new(p.mode),
        }
    }
    fn update(&mut self, p: FilterV2Parameters, base_rate: f32) {
        self.cutoff.set_target(p.cutoff_hz, 0.01, base_rate);
        self.resonance.set_target(p.resonance, 0.01, base_rate);
        self.enabled
            .set_target(if p.enabled { 1. } else { 0. }, 0.01, base_rate);
        self.insert.set_target(p.insert_send, 0.01, base_rate);
        self.direct.set_target(p.direct_send, 0.01, base_rate);
        self.mode.request(p.mode, 0.01, base_rate)
    }
    fn hold(&mut self, oct: f32) -> HeldFilter {
        let fc = (self.cutoff.next_exact() * 2f32.powf(oct.clamp(-12., 12.)))
            .clamp(10., 20_000f32.min(0.45 * self.output_rate));
        let q = 0.5 * 40f32.powf(self.resonance.next());
        let k = 1. / q;
        let g = (PI * fc / self.processing_rate).tan();
        let a1 = 1. / (1. + g * (g + k));
        let a2 = g * a1;
        let a3 = g * a2;
        HeldFilter {
            k,
            a1,
            a2,
            a3,
            modes: self.mode.next(),
            enabled: self.enabled.next(),
            insert: self.insert.next(),
            direct: self.direct.next(),
        }
    }
    fn process(&mut self, input: f32, h: HeldFilter) -> f32 {
        let v3 = input - self.state.ic2;
        let v1 = h.a1 * self.state.ic1 + h.a2 * v3;
        let v2 = self.state.ic2 + h.a2 * self.state.ic1 + h.a3 * v3;
        self.state.ic1 = 2. * v1 - self.state.ic1;
        self.state.ic2 = 2. * v2 - self.state.ic2;
        if !self.state.ic1.is_finite() || !self.state.ic2.is_finite() {
            self.state = FilterState::default();
            return 0.;
        }
        let outs = [v2, v1, input - h.k * v1 - v2];
        let (a, b, m) = h.modes;
        let wet = if a == b {
            outs[fidx(a)]
        } else {
            equal_power(outs[fidx(a)], outs[fidx(b)], m)
        };
        equal_power(input, wet, h.enabled)
    }
}
fn fidx(m: FilterMode) -> usize {
    match m {
        FilterMode::Lowpass => 0,
        FilterMode::Bandpass => 1,
        FilterMode::Highpass => 2,
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub(crate) struct SignalFrame {
    pub insert: StereoFrame,
    pub direct: StereoFrame,
}

fn effective_source_gain(authored_zero: bool, base_gain: f32, accumulator_db: f32) -> f32 {
    if authored_zero {
        0.0
    } else {
        let combined_db =
            (20.0 * base_gain.max(f32::MIN_POSITIVE).log10() + accumulator_db).clamp(-120.0, 24.0);
        10.0_f32.powf(combined_db / 20.0)
    }
}

pub(crate) struct PreparedSynthV2 {
    base_rate: f32,
    processing_rate: f32,
    count: u8,
    oscillators: [OscillatorV2; 4],
    amp: Envelope,
    filter: FilterV2,
    output_gain: LinearRamp,
    output_gain_authored_zero: bool,
    enabled: LinearRamp,
    pm: PmParameters,
    pm_index: LinearRamp,
    insert_decim: Decimator4,
    direct_decim: Decimator4,
    gate: bool,
}
impl PreparedSynthV2 {
    pub(crate) fn new(p: SynthV2Parameters, base_rate: f32) -> Result<Self, &'static str> {
        if p.pm.present && base_rate * 4. > 768_000. {
            return Err("PM processing sample rate exceeds 768000 Hz");
        }
        let processing = if p.pm.present {
            base_rate * 4.
        } else {
            base_rate
        };
        let seeds = [0xA341316C, 0xC8013EA4, 0xAD90777D, 0x7E95761E];
        let oscillators = std::array::from_fn(|i| OscillatorV2::new(p.oscillators[i], seeds[i]));
        Ok(Self {
            base_rate,
            processing_rate: processing,
            count: p.oscillator_count,
            oscillators,
            amp: Envelope::new(p.amp, base_rate),
            filter: FilterV2::new(p.filter, processing, base_rate),
            output_gain: LinearRamp::new(p.output_gain),
            output_gain_authored_zero: p.output_gain == 0.0,
            enabled: LinearRamp::new(if p.enabled { 1. } else { 0. }),
            pm: p.pm,
            pm_index: LinearRamp::new(p.pm.index),
            insert_decim: Decimator4::new(),
            direct_decim: Decimator4::new(),
            gate: false,
        })
    }
    pub(crate) fn set_gate(&mut self, gate: bool) {
        if gate != self.gate {
            self.gate = gate;
            self.amp.gate(gate)
        }
    }
    pub(crate) fn update(&mut self, p: SynthV2Parameters) {
        for i in 0..4 {
            self.oscillators[i].update(p.oscillators[i], self.base_rate)
        }
        self.amp.update(p.amp);
        self.filter.update(p.filter, self.base_rate);
        self.output_gain_authored_zero = p.output_gain == 0.0;
        self.output_gain
            .set_target(p.output_gain, 0.01, self.base_rate);
        self.enabled
            .set_target(if p.enabled { 1. } else { 0. }, 0.01, self.base_rate);
        self.pm_index.set_target(p.pm.index, 0.01, self.base_rate)
    }
    pub(crate) fn process(&mut self, c: ControlFrame) -> SignalFrame {
        let mut held = [HeldOsc {
            frequency: 1.,
            pulse_width: 0.5,
            level: 0.,
            sends: SendsSpec::default(),
            waveform: (Waveform::Sine, Waveform::Sine, 0.),
        }; 4];
        for (i, h) in held.iter_mut().enumerate() {
            *h = self.oscillators[i].hold(
                c.pitch_semitones[i],
                c.pulse_width[i],
                c.level[i],
                self.processing_rate,
            );
        }
        let filter = self.filter.hold(c.filter_octaves);
        let amp = self.amp.next();
        let base_gain = self.output_gain.next();
        let gain =
            effective_source_gain(self.output_gain_authored_zero, base_gain, c.source_gain_db);
        let total = amp * gain * self.enabled.next();
        let index = self.pm_index.next();
        if self.pm.present {
            let mut ins = [0.; 4];
            let mut dir = [0.; 4];
            for sub in 0..4 {
                let mut raw = [0.; 4];
                let s = self.pm.source as usize;
                let t = self.pm.target as usize;
                raw[s] = self.oscillators[s].render(held[s], self.processing_rate, 0., true);
                raw[t] = self.oscillators[t].render(
                    held[t],
                    self.processing_rate,
                    index * raw[s] / TAU,
                    true,
                );
                for i in 0..self.count as usize {
                    if i != s && i != t {
                        raw[i] =
                            self.oscillators[i].render(held[i], self.processing_rate, 0., false)
                    }
                }
                let (a, b) = self.route(raw, held, filter, total);
                ins[sub] = a;
                dir[sub] = b;
            }
            let i = self.insert_decim.process(ins);
            let d = self.direct_decim.process(dir);
            SignalFrame {
                insert: StereoFrame { left: i, right: i },
                direct: StereoFrame { left: d, right: d },
            }
        } else {
            let mut raw = [0.; 4];
            for i in 0..self.count as usize {
                raw[i] = self.oscillators[i].render(held[i], self.processing_rate, 0., false)
            }
            let (i, d) = self.route(raw, held, filter, total);
            SignalFrame {
                insert: StereoFrame { left: i, right: i },
                direct: StereoFrame { left: d, right: d },
            }
        }
    }
    fn route(
        &mut self,
        raw: [f32; 4],
        held: [HeldOsc; 4],
        filter: HeldFilter,
        total: f32,
    ) -> (f32, f32) {
        let (mut fi, mut ins, mut dir) = (0., 0., 0.);
        for i in 0..self.count as usize {
            let audible = raw[i] * held[i].level;
            fi += audible * held[i].sends.filter;
            ins += audible * held[i].sends.insert;
            dir += audible * held[i].sends.direct;
        }
        let filtered = self.filter.process(fi, filter);
        (
            (ins + filtered * filter.insert) * total,
            (dir + filtered * filter.direct) * total,
        )
    }
}

impl From<PhaseModulationSpec> for PmParameters {
    fn from(x: PhaseModulationSpec) -> Self {
        Self {
            present: true,
            source: x.source,
            target: x.target,
            index: x.index_radians,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dsp::decimator::HALF_BAND_TAPS;

    struct HalfBand64 {
        history: [f64; 129],
        write: usize,
        index: u64,
    }
    impl HalfBand64 {
        fn new() -> Self {
            Self {
                history: [0.0; 129],
                write: 0,
                index: 0,
            }
        }
        fn push(&mut self, sample: f64) -> Option<f64> {
            self.history[self.write] = sample;
            let emit = self.index & 1 == 0;
            self.index += 1;
            if !emit {
                self.write = (self.write + 1) % 129;
                return None;
            }
            let mut result = 0.0;
            let mut position = self.write;
            for &tap in &HALF_BAND_TAPS {
                if tap != 0.0 {
                    result += f64::from(tap) * self.history[position];
                }
                position = if position == 0 { 128 } else { position - 1 };
            }
            self.write = (self.write + 1) % 129;
            Some(result)
        }
    }

    fn parameters(pm_index: f32) -> SynthV2Parameters {
        let silent = OscillatorV2Parameters::silent(750.0);
        let mut oscillators = [silent; 4];
        oscillators[0] = OscillatorV2Parameters {
            oscillator: OscillatorParameters {
                waveform: Waveform::Sine,
                frequency_hz: 750.0,
                pulse_width: 0.5,
                level: 0.0,
            },
            sends: SendsSpec::default(),
        };
        oscillators[1] = OscillatorV2Parameters {
            oscillator: OscillatorParameters {
                waveform: Waveform::Sine,
                frequency_hz: 6_000.0,
                pulse_width: 0.5,
                level: 1.0,
            },
            sends: SendsSpec {
                filter: 0.0,
                insert: 1.0,
                direct: 0.0,
            },
        };
        SynthV2Parameters {
            enabled: true,
            oscillator_count: 2,
            oscillators,
            amp: EnvelopeSpec {
                attack_seconds: 0.0,
                decay_seconds: 0.0,
                sustain: 1.0,
                release_seconds: 0.0,
            },
            filter: FilterV2Parameters {
                enabled: false,
                mode: FilterMode::Lowpass,
                cutoff_hz: 1_000.0,
                resonance: 0.0,
                insert_send: 0.0,
                direct_send: 0.0,
            },
            output_gain: 1.0,
            pm: PmParameters {
                present: true,
                source: 0,
                target: 1,
                index: pm_index,
            },
        }
    }

    fn reference(sample_rate: f64, base_frames: usize, multiplier: usize) -> Vec<f64> {
        let mut stages: Vec<HalfBand64> =
            (0..multiplier.ilog2()).map(|_| HalfBand64::new()).collect();
        let mut source_phase = 0.0f64;
        let mut target_phase = 0.0f64;
        let source_step = 750.0 / (sample_rate * multiplier as f64);
        let target_step = 6_000.0 / (sample_rate * multiplier as f64);
        let mut output = Vec::with_capacity(base_frames);
        for _ in 0..base_frames * multiplier {
            let source = (std::f64::consts::TAU * source_phase).sin();
            let mut value = (std::f64::consts::TAU * target_phase + 4.0 * source).sin();
            source_phase = (source_phase + source_step).fract();
            target_phase = (target_phase + target_step).fract();
            let mut available = true;
            for stage in &mut stages {
                if let Some(next) = stage.push(value) {
                    value = next;
                } else {
                    available = false;
                    break;
                }
            }
            if available {
                output.push(value);
            }
        }
        output
    }

    fn spectrum(samples: &[f64]) -> Vec<f64> {
        assert!(samples.len().is_power_of_two());
        let mut data: Vec<(f64, f64)> = samples.iter().map(|sample| (*sample, 0.0)).collect();
        let mut reversed = 0usize;
        for index in 1..data.len() {
            let mut bit = data.len() >> 1;
            while reversed & bit != 0 {
                reversed ^= bit;
                bit >>= 1;
            }
            reversed ^= bit;
            if index < reversed {
                data.swap(index, reversed);
            }
        }
        let mut size = 2;
        while size <= data.len() {
            let angle = -std::f64::consts::TAU / size as f64;
            let step = (angle.cos(), angle.sin());
            for start in (0..data.len()).step_by(size) {
                let mut twiddle = (1.0, 0.0);
                for offset in 0..size / 2 {
                    let even = data[start + offset];
                    let odd = data[start + offset + size / 2];
                    let rotated = (
                        odd.0 * twiddle.0 - odd.1 * twiddle.1,
                        odd.0 * twiddle.1 + odd.1 * twiddle.0,
                    );
                    data[start + offset] = (even.0 + rotated.0, even.1 + rotated.1);
                    data[start + offset + size / 2] = (even.0 - rotated.0, even.1 - rotated.1);
                    twiddle = (
                        twiddle.0 * step.0 - twiddle.1 * step.1,
                        twiddle.0 * step.1 + twiddle.1 * step.0,
                    );
                }
            }
            size *= 2;
        }
        data[..=data.len() / 2]
            .iter()
            .enumerate()
            .map(|(index, value)| {
                let scale = if index == 0 || index == samples.len() / 2 {
                    1.0
                } else {
                    2.0
                };
                scale * value.0.hypot(value.1) / samples.len() as f64
            })
            .collect()
    }

    #[test]
    #[ignore = "normative full-length PM reference gate; run in release validation"]
    fn sine_pm_matches_normative_64x_reference() {
        const DISCARD: usize = 4_096;
        const MEASURE: usize = 65_536;
        for sample_rate in [48_000.0f32, 96_000.0] {
            let mut synth = PreparedSynthV2::new(parameters(4.0), sample_rate).unwrap();
            synth.set_gate(true);
            let candidate: Vec<f64> = (0..DISCARD + MEASURE)
                .map(|_| f64::from(synth.process(ControlFrame::default()).insert.left))
                .collect();
            let reference64 = reference(f64::from(sample_rate), DISCARD + MEASURE + 30, 64);
            let reference4 = reference(f64::from(sample_rate), DISCARD + MEASURE, 4);
            let four_x_rms = candidate[DISCARD..]
                .iter()
                .zip(&reference4[DISCARD..])
                .map(|(a, b)| (a - b) * (a - b))
                .sum::<f64>()
                / MEASURE as f64;
            assert!(
                20.0 * four_x_rms.sqrt().log10() <= -80.0,
                "4x implementation diverged from analytic reference"
            );
            let (best_lag, best_residual_db) = (0..=30)
                .map(|lag| {
                    let mean_square = candidate[DISCARD..]
                        .iter()
                        .zip(&reference64[DISCARD + lag..DISCARD + lag + MEASURE])
                        .map(|(a, b)| (a - b) * (a - b))
                        .sum::<f64>()
                        / MEASURE as f64;
                    (lag, 20.0 * mean_square.sqrt().log10())
                })
                .min_by(|a, b| a.1.total_cmp(&b.1))
                .unwrap();
            assert_eq!(best_lag, 15, "normative latency alignment changed");
            assert!(
                best_residual_db <= -80.0,
                "{sample_rate} Hz residual {best_residual_db} dBFS"
            );

            let candidate_spectrum = spectrum(&candidate[DISCARD..DISCARD + MEASURE]);
            let reference_spectrum = spectrum(&reference64[DISCARD + 15..DISCARD + 15 + MEASURE]);
            let mut unpredicted_power = 0.0;
            for (bin, (candidate_amplitude, reference_amplitude)) in candidate_spectrum
                .iter()
                .zip(&reference_spectrum)
                .enumerate()
            {
                let candidate_db = 20.0 * candidate_amplitude.max(1e-300).log10();
                let reference_db = 20.0 * reference_amplitude.max(1e-300).log10();
                if reference_db > -100.0 {
                    assert!(
                        (candidate_db - reference_db).abs() <= 0.25,
                        "{sample_rate} Hz bin {bin}: candidate {candidate_db} dBFS, reference {reference_db} dBFS"
                    );
                }
                if reference_db < -120.0 {
                    unpredicted_power += candidate_amplitude * candidate_amplitude;
                }
            }
            let unpredicted_db = 10.0 * unpredicted_power.max(1e-300).log10();
            assert!(
                unpredicted_db <= -80.0,
                "{sample_rate} Hz unpredicted energy {unpredicted_db} dBFS"
            );
        }
    }

    #[test]
    fn source_gain_zero_and_combined_db_clamps_are_exact() {
        assert_eq!(effective_source_gain(true, 1.0, 24.0), 0.0);
        assert!((effective_source_gain(false, 0.5, -120.0) - 1.0e-6).abs() < 1.0e-12);
        let upper = 10.0_f32.powf(24.0 / 20.0);
        assert!((effective_source_gain(false, 1.0, 24.0) - upper).abs() < 1.0e-6);
        assert!((effective_source_gain(false, 1.0, 100.0) - upper).abs() < 1.0e-6);

        let mut zero_parameters = parameters(0.0);
        zero_parameters.pm.present = false;
        zero_parameters.output_gain = 0.0;
        let mut synth = PreparedSynthV2::new(zero_parameters, 48_000.0).unwrap();
        synth.set_gate(true);
        let boosted = ControlFrame {
            source_gain_db: 24.0,
            ..ControlFrame::default()
        };
        for _ in 0..128 {
            assert_eq!(synth.process(boosted), SignalFrame::default());
        }
    }

    #[test]
    fn pm_index_changes_timbre_and_remains_finite() {
        let mut zero = PreparedSynthV2::new(parameters(0.0), 48_000.0).unwrap();
        let mut modulated = PreparedSynthV2::new(parameters(4.0), 48_000.0).unwrap();
        zero.set_gate(true);
        modulated.set_gate(true);
        let mut differs = false;
        for _ in 0..512 {
            let a = zero.process(ControlFrame::default()).insert.left;
            let b = modulated.process(ControlFrame::default()).insert.left;
            assert!(a.is_finite() && b.is_finite());
            differs |= a != b;
        }
        assert!(differs);
    }
}
