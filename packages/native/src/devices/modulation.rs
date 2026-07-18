use crate::devices::synth_v2::ControlFrame;
use crate::dsp::crossfade::{equal_power, DiscreteCrossfade};
use crate::dsp::envelope::Envelope;
use crate::dsp::parameter::{LinearRamp, LogRamp};
use crate::patch::{
    EnvelopeSpec, LfoPhaseMode, LfoPolarity, LfoRate, LfoShape, ModulationRouteSpec, ModulatorSpec,
    RouteTarget,
};
use std::f32::consts::TAU;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Presentation {
    shape: LfoShape,
    polarity: LfoPolarity,
}
#[derive(Clone, Copy, Debug)]
pub(crate) enum ModParameters {
    Empty,
    Lfo {
        enabled: bool,
        presentation: Presentation,
        rate: LfoRate,
        phase_mode: LfoPhaseMode,
        phase_offset: f32,
    },
    Envelope {
        enabled: bool,
        envelope: EnvelopeSpec,
    },
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct RouteParameters {
    pub source: u8,
    pub target: RouteTarget,
    pub amount: f32,
}
impl Default for RouteParameters {
    fn default() -> Self {
        Self {
            source: 0,
            target: RouteTarget::SourceGain,
            amount: 0.,
        }
    }
}
#[derive(Clone, Copy, Debug)]
pub(crate) struct PatchModParameters {
    pub tempo: f32,
    pub count: u8,
    pub modulators: [ModParameters; 4],
    pub route_count: u8,
    pub routes: [RouteParameters; 8],
}
impl PatchModParameters {
    pub(crate) fn from_specs(
        tempo: f32,
        mods: &[ModulatorSpec],
        routes: &[ModulationRouteSpec],
    ) -> Self {
        let mut m = [ModParameters::Empty; 4];
        for (i, x) in mods.iter().enumerate() {
            m[i] = match x {
                ModulatorSpec::Lfo {
                    enabled,
                    shape,
                    polarity,
                    rate,
                    phase_mode,
                    phase_offset,
                    ..
                } => ModParameters::Lfo {
                    enabled: *enabled,
                    presentation: Presentation {
                        shape: *shape,
                        polarity: *polarity,
                    },
                    rate: *rate,
                    phase_mode: *phase_mode,
                    phase_offset: *phase_offset,
                },
                ModulatorSpec::Envelope {
                    enabled, envelope, ..
                } => ModParameters::Envelope {
                    enabled: *enabled,
                    envelope: *envelope,
                },
            };
        }
        let mut r = [RouteParameters::default(); 8];
        for (i, x) in routes.iter().enumerate() {
            r[i] = RouteParameters {
                source: x.source,
                target: x.target,
                amount: x.amount,
            };
        }
        Self {
            tempo,
            count: mods.len() as u8,
            modulators: m,
            route_count: routes.len() as u8,
            routes: r,
        }
    }
}

struct Lfo {
    phase: f32,
    rate: LogRamp,
    enabled: LinearRamp,
    presentation: DiscreteCrossfade<Presentation>,
    phase_mode: LfoPhaseMode,
    phase_offset: f32,
}
impl Lfo {
    fn hz(rate: LfoRate, tempo: f32) -> f32 {
        match rate {
            LfoRate::Hz(x) => x,
            LfoRate::Sync(d) => tempo / 60. * d as f32 / 4.,
        }
    }
    fn new(
        enabled: bool,
        p: Presentation,
        rate: LfoRate,
        mode: LfoPhaseMode,
        offset: f32,
        tempo: f32,
    ) -> Self {
        Self {
            phase: offset,
            rate: LogRamp::new(Self::hz(rate, tempo)),
            enabled: LinearRamp::new(if enabled { 1. } else { 0. }),
            presentation: DiscreteCrossfade::new(p),
            phase_mode: mode,
            phase_offset: offset,
        }
    }
    fn update(
        &mut self,
        parameters: (bool, Presentation, LfoRate, LfoPhaseMode, f32),
        tempo: f32,
        sr: f32,
    ) {
        let (enabled, p, rate, mode, offset) = parameters;
        self.rate.set_target(Self::hz(rate, tempo), 0.01, sr);
        self.enabled
            .set_target(if enabled { 1. } else { 0. }, 0.01, sr);
        self.presentation.request(p, 0.01, sr);
        self.phase_mode = mode;
        self.phase_offset = offset
    }
    fn gate(&mut self, on: bool) {
        if on && self.phase_mode == LfoPhaseMode::GateReset {
            self.phase = self.phase_offset
        }
    }
    fn next(&mut self, sr: f32) -> f32 {
        let (a, b, m) = self.presentation.next();
        let value = if a == b {
            shape(a, self.phase)
        } else {
            equal_power(shape(a, self.phase), shape(b, self.phase), m)
        } * self.enabled.next();
        self.phase = (self.phase + self.rate.next_exact() / sr).fract();
        value
    }
}
fn shape(p: Presentation, phase: f32) -> f32 {
    let u = match p.shape {
        LfoShape::Sine => 0.5 - 0.5 * (TAU * phase).cos(),
        LfoShape::Triangle => 1. - (2. * phase - 1.).abs(),
        LfoShape::SawUp => phase,
        LfoShape::SawDown => 1. - phase,
        LfoShape::Square => {
            if phase < 0.5 {
                0.
            } else {
                1.
            }
        }
    };
    if p.polarity == LfoPolarity::Bipolar {
        2. * u - 1.
    } else {
        u
    }
}
struct Env {
    envelope: Envelope,
    enabled: LinearRamp,
}
impl Env {
    fn new(e: EnvelopeSpec, enabled: bool, sr: f32) -> Self {
        Self {
            envelope: Envelope::new(e, sr),
            enabled: LinearRamp::new(if enabled { 1. } else { 0. }),
        }
    }
    fn update(&mut self, e: EnvelopeSpec, enabled: bool, sr: f32) {
        self.envelope.update(e);
        self.enabled
            .set_target(if enabled { 1. } else { 0. }, 0.01, sr)
    }
    fn next(&mut self) -> f32 {
        self.envelope.next() * self.enabled.next()
    }
}
enum Slot {
    Empty,
    Lfo(Lfo),
    Envelope(Env),
}
struct Route {
    source: u8,
    target: RouteTarget,
    amount: LinearRamp,
}
pub(crate) struct ModulationBank {
    sample_rate: f32,
    tempo: f32,
    slots: [Slot; 4],
    count: u8,
    routes: [Option<Route>; 8],
    route_count: u8,
}
impl ModulationBank {
    pub(crate) fn new(p: PatchModParameters, sr: f32) -> Self {
        let slots = std::array::from_fn(|i| match p.modulators[i] {
            ModParameters::Empty => Slot::Empty,
            ModParameters::Lfo {
                enabled,
                presentation,
                rate,
                phase_mode,
                phase_offset,
            } => Slot::Lfo(Lfo::new(
                enabled,
                presentation,
                rate,
                phase_mode,
                phase_offset,
                p.tempo,
            )),
            ModParameters::Envelope { enabled, envelope } => {
                Slot::Envelope(Env::new(envelope, enabled, sr))
            }
        });
        let routes = std::array::from_fn(|i| {
            if i < p.route_count as usize {
                let r = p.routes[i];
                Some(Route {
                    source: r.source,
                    target: r.target,
                    amount: LinearRamp::new(r.amount),
                })
            } else {
                None
            }
        });
        Self {
            sample_rate: sr,
            tempo: p.tempo,
            slots,
            count: p.count,
            routes,
            route_count: p.route_count,
        }
    }
    pub(crate) fn set_gate(&mut self, gate: bool) {
        for s in &mut self.slots[..self.count as usize] {
            match s {
                Slot::Lfo(x) => x.gate(gate),
                Slot::Envelope(x) => x.envelope.gate(gate),
                Slot::Empty => {}
            }
        }
    }
    pub(crate) fn update(&mut self, p: PatchModParameters) {
        self.tempo = p.tempo;
        for i in 0..self.count as usize {
            match (&mut self.slots[i], p.modulators[i]) {
                (
                    Slot::Lfo(x),
                    ModParameters::Lfo {
                        enabled,
                        presentation,
                        rate,
                        phase_mode,
                        phase_offset,
                    },
                ) => x.update(
                    (enabled, presentation, rate, phase_mode, phase_offset),
                    p.tempo,
                    self.sample_rate,
                ),
                (Slot::Envelope(x), ModParameters::Envelope { enabled, envelope }) => {
                    x.update(envelope, enabled, self.sample_rate)
                }
                _ => {}
            }
        }
        for i in 0..self.route_count as usize {
            if let Some(route) = &mut self.routes[i] {
                route
                    .amount
                    .set_target(p.routes[i].amount, 0.01, self.sample_rate)
            }
        }
    }
    pub(crate) fn process(&mut self) -> ControlFrame {
        let mut values = [0.; 4];
        for (i, s) in self.slots[..self.count as usize].iter_mut().enumerate() {
            values[i] = match s {
                Slot::Lfo(x) => x.next(self.sample_rate),
                Slot::Envelope(x) => x.next(),
                Slot::Empty => 0.,
            };
        }
        let mut out = ControlFrame::default();
        for r in self.routes[..self.route_count as usize]
            .iter_mut()
            .flatten()
        {
            let v = values[r.source as usize] * r.amount.next();
            match r.target {
                RouteTarget::FilterCutoff => out.filter_octaves += v,
                RouteTarget::OscillatorPitch(i) => out.pitch_semitones[i as usize] += v,
                RouteTarget::PulseWidth(i) => out.pulse_width[i as usize] += v,
                RouteTarget::OscillatorLevel(i) => out.level[i as usize] += v,
                RouteTarget::SourceGain => out.source_gain_db += v,
            }
        }
        out.filter_octaves = out.filter_octaves.clamp(-12., 12.);
        out.source_gain_db = out.source_gain_db.clamp(-120., 24.);
        for x in &mut out.pitch_semitones {
            *x = x.clamp(-96., 96.)
        }
        for x in &mut out.pulse_width {
            *x = x.clamp(-1., 1.)
        }
        for x in &mut out.level {
            *x = x.clamp(-1., 1.)
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lfo_shapes_are_exact() {
        let p = Presentation {
            shape: LfoShape::Sine,
            polarity: LfoPolarity::Unipolar,
        };
        assert_eq!(shape(p, 0.), 0.);
        assert!((shape(p, 0.5) - 1.).abs() < 1e-6);
        let q = Presentation {
            shape: LfoShape::SawUp,
            polarity: LfoPolarity::Bipolar,
        };
        assert_eq!(shape(q, 0.25), -0.5);
    }

    #[test]
    fn lfo_outputs_before_one_base_rate_advance() {
        let presentation = Presentation {
            shape: LfoShape::Sine,
            polarity: LfoPolarity::Unipolar,
        };
        let mut lfo = Lfo::new(
            true,
            presentation,
            LfoRate::Hz(1.0),
            LfoPhaseMode::GateReset,
            0.0,
            120.0,
        );
        let actual = [lfo.next(4.0), lfo.next(4.0), lfo.next(4.0), lfo.next(4.0)];
        let expected = [0.0, 0.5, 1.0, 0.5];
        for (actual, expected) in actual.into_iter().zip(expected) {
            assert!((actual - expected).abs() < 1e-6);
        }
        lfo.gate(true);
        assert_eq!(lfo.next(4.0), 0.0);
    }
}
