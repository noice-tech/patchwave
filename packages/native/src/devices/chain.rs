use super::saturator::{PreparedSaturator, SaturatorParameters};
use super::stereo_delay::{PreparedStereoDelay, StereoDelayParameters};
use super::synth::{PreparedSynth, SynthParameters};
use crate::dsp::frame::StereoFrame;
use crate::dsp::safety::sanitize;
use crate::patch::{EffectKind, EffectSpec, PatchError, PatchSpec, StructuralSignature};
use arrayvec::ArrayVec;

#[derive(Clone, Copy, Debug)]
pub(crate) enum EffectParameters {
    Saturator(SaturatorParameters),
    StereoDelay(StereoDelayParameters),
}

impl EffectParameters {
    fn kind(self) -> EffectKind {
        match self {
            Self::Saturator(_) => EffectKind::Saturator,
            Self::StereoDelay(_) => EffectKind::StereoDelay,
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct ParameterSnapshot {
    pub(crate) generation: u64,
    pub(crate) signature: StructuralSignature,
    pub(crate) source: SynthParameters,
    pub(crate) effects: ArrayVec<EffectParameters, 7>,
}

enum Effect {
    Saturator(PreparedSaturator),
    StereoDelay(PreparedStereoDelay),
}

pub(crate) struct PreparedChain {
    signature: StructuralSignature,
    source: Box<PreparedSynth>,
    effects: Vec<Effect>,
    gate: bool,
    #[cfg(test)]
    drop_probe: Option<DropProbe>,
}

#[cfg(test)]
pub(crate) struct DropProbe {
    log: std::sync::Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>,
}

#[cfg(test)]
impl DropProbe {
    pub(crate) fn new(log: std::sync::Arc<std::sync::Mutex<Vec<std::thread::ThreadId>>>) -> Self {
        Self { log }
    }
}

#[cfg(test)]
impl Drop for DropProbe {
    fn drop(&mut self) {
        self.log
            .lock()
            .expect("drop-probe log")
            .push(std::thread::current().id());
    }
}

impl PreparedChain {
    pub(crate) fn prepare_at(spec: &PatchSpec, sample_rate: f32) -> Result<Self, PatchError> {
        if !sample_rate.is_finite() || !(100.0..=768_000.0).contains(&sample_rate) {
            return Err(PatchError::new(
                "sample rate must be finite and within 100–768000 Hz",
            ));
        }
        let source = Box::new(PreparedSynth::new(
            SynthParameters::from_spec(&spec.source),
            sample_rate,
        ));
        let mut effects = Vec::new();
        effects
            .try_reserve_exact(spec.effects.len())
            .map_err(|_| PatchError::new("effect allocation failed"))?;
        for effect in &spec.effects {
            effects.push(match effect {
                EffectSpec::Saturator(spec) => Effect::Saturator(PreparedSaturator::new(
                    SaturatorParameters::from(spec),
                    sample_rate,
                )),
                EffectSpec::StereoDelay(spec) => Effect::StereoDelay(
                    PreparedStereoDelay::new(StereoDelayParameters::from(spec), sample_rate)
                        .map_err(PatchError::new)?,
                ),
            });
        }
        Ok(Self {
            signature: spec.structural_signature(),
            source,
            effects,
            gate: false,
            #[cfg(test)]
            drop_probe: None,
        })
    }

    pub(crate) fn set_gate(&mut self, gate: bool) {
        self.gate = gate;
        self.source.set_gate(gate);
    }

    pub(crate) fn retrigger(&mut self) {
        self.gate = true;
        self.source.retrigger();
    }

    pub(crate) fn process(&mut self) -> StereoFrame {
        let mut signal = self.source.process();
        for effect in &mut self.effects {
            signal = match effect {
                Effect::Saturator(effect) => effect.process(signal),
                Effect::StereoDelay(effect) => effect.process(signal),
            };
        }
        sanitize(signal)
    }

    pub(crate) fn apply(&mut self, snapshot: &ParameterSnapshot) -> Result<(), &'static str> {
        if snapshot.signature != self.signature
            || snapshot.effects.len() != self.effects.len()
            || snapshot.source.oscillator_count != self.signature.oscillator_count
        {
            return Err("parameter snapshot topology mismatch");
        }
        for (effect, parameters) in self.effects.iter().zip(snapshot.effects.iter().copied()) {
            match (effect, parameters) {
                (Effect::Saturator(_), EffectParameters::Saturator(_))
                | (Effect::StereoDelay(_), EffectParameters::StereoDelay(_)) => {}
                _ => return Err("parameter snapshot effect mismatch"),
            }
        }
        if snapshot
            .effects
            .iter()
            .copied()
            .enumerate()
            .any(|(index, parameters)| self.signature.effects[index] != parameters.kind())
        {
            return Err("parameter snapshot signature mismatch");
        }
        self.source.update(snapshot.source);
        for (effect, parameters) in self
            .effects
            .iter_mut()
            .zip(snapshot.effects.iter().copied())
        {
            match (effect, parameters) {
                (Effect::Saturator(effect), EffectParameters::Saturator(parameters)) => {
                    effect.update(parameters)
                }
                (Effect::StereoDelay(effect), EffectParameters::StereoDelay(parameters)) => {
                    effect.update(parameters)
                }
                _ => unreachable!(),
            }
        }
        Ok(())
    }

    #[cfg(test)]
    pub(crate) fn set_drop_probe(&mut self, probe: DropProbe) {
        self.drop_probe = Some(probe);
    }
}

impl PatchSpec {
    pub(crate) fn prepare_chain(&self, sample_rate: f32) -> Result<PreparedChain, PatchError> {
        PreparedChain::prepare_at(self, sample_rate)
    }

    pub(crate) fn parameter_snapshot(
        &self,
        generation: u64,
    ) -> Result<ParameterSnapshot, PatchError> {
        let mut effects = ArrayVec::new();
        for effect in &self.effects {
            let parameters = match effect {
                EffectSpec::Saturator(spec) => {
                    EffectParameters::Saturator(SaturatorParameters::from(spec))
                }
                EffectSpec::StereoDelay(spec) => {
                    EffectParameters::StereoDelay(StereoDelayParameters::from(spec))
                }
            };
            effects
                .try_push(parameters)
                .map_err(|_| PatchError::new("parameter image exceeds fixed capacity"))?;
        }
        Ok(ParameterSnapshot {
            generation,
            signature: self.structural_signature(),
            source: SynthParameters::from_spec(&self.source),
            effects,
        })
    }
}

const _: () = {
    assert!(std::mem::size_of::<ParameterSnapshot>() <= 2_048);
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::{parse_patch, EffectSpec, LfoShape, SaturatorSpec};

    fn minimal() -> PatchSpec {
        parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/minimal.json"
        )))
        .unwrap()
    }

    fn wobble() -> PatchSpec {
        parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/wobble.json"
        )))
        .unwrap()
    }

    #[test]
    fn parameter_snapshot_budget_and_identity() {
        assert!(std::mem::size_of::<ParameterSnapshot>() <= 2_048);
        let spec = wobble();
        let mut candidate = spec.prepare_chain(4_000.0).unwrap();
        let mut control = spec.prepare_chain(4_000.0).unwrap();
        candidate.set_gate(true);
        control.set_gate(true);
        for _ in 0..31 {
            assert_eq!(candidate.process(), control.process());
        }
        candidate
            .apply(&spec.parameter_snapshot(2).unwrap())
            .unwrap();
        for _ in 0..64 {
            assert_eq!(candidate.process(), control.process());
        }
    }

    #[test]
    fn changed_parameter_snapshot_is_applied_without_replacing_topology() {
        let spec = wobble();
        let mut updated = spec.clone();
        updated.source.frequency_hz = 82.0;
        updated.source.gain_db = -20.0;
        let filter = updated.source.filter.as_mut().unwrap();
        filter.cutoff_hz = 640.0;
        let lfo = filter.cutoff_lfo.as_mut().unwrap();
        lfo.shape = LfoShape::SawDown;
        lfo.rate_hz = 4.0;
        lfo.amount_octaves = 1.0;
        let EffectSpec::Saturator(saturator) = &mut updated.effects[0] else {
            panic!("saturator")
        };
        saturator.drive_db = 3.0;
        let EffectSpec::StereoDelay(delay) = &mut updated.effects[1] else {
            panic!("stereo delay")
        };
        delay.feedback = 0.6;

        assert_eq!(spec.structural_signature(), updated.structural_signature());
        let snapshot = updated.parameter_snapshot(3).unwrap();
        assert_eq!(snapshot.source.filter.cutoff_hz, 640.0);
        assert_eq!(snapshot.source.filter.lfo_shape, LfoShape::SawDown);
        assert_eq!(snapshot.source.filter.lfo_rate_hz, 4.0);
        let EffectParameters::Saturator(parameters) = snapshot.effects[0] else {
            panic!("saturator parameters")
        };
        assert_eq!(parameters.drive_db, 3.0);
        let EffectParameters::StereoDelay(parameters) = snapshot.effects[1] else {
            panic!("delay parameters")
        };
        assert_eq!(parameters.feedback, 0.6);

        let mut candidate = spec.prepare_chain(4_000.0).unwrap();
        let mut control = spec.prepare_chain(4_000.0).unwrap();
        candidate.set_gate(true);
        control.set_gate(true);
        for _ in 0..64 {
            assert_eq!(candidate.process(), control.process());
        }
        candidate.apply(&snapshot).unwrap();
        assert!((0..128).any(|_| candidate.process() != control.process()));
    }

    #[test]
    fn topology_mismatch_rejects_before_mutation() {
        let spec = minimal();
        let mut candidate = spec.prepare_chain(4_000.0).unwrap();
        let mut control = spec.prepare_chain(4_000.0).unwrap();
        candidate.set_gate(true);
        control.set_gate(true);
        for _ in 0..17 {
            assert_eq!(candidate.process(), control.process());
        }
        let mut incompatible = spec.clone();
        incompatible
            .effects
            .push(EffectSpec::Saturator(SaturatorSpec {
                drive_db: 12.0,
                output_gain_db: -6.0,
                mix: 1.0,
            }));
        assert!(candidate
            .apply(&incompatible.parameter_snapshot(3).unwrap())
            .is_err());
        for _ in 0..31 {
            assert_eq!(candidate.process(), control.process());
        }
    }

    #[test]
    fn effects_continue_after_source_release() {
        let mut spec = minimal();
        spec.source.amp_envelope.release_seconds = 0.0;
        spec.effects
            .push(EffectSpec::StereoDelay(crate::patch::StereoDelaySpec {
                time_seconds: 0.01,
                feedback: 0.0,
                damping: 0.0,
                ping_pong: false,
                mix: 1.0,
            }));
        let mut chain = spec.prepare_chain(1_000.0).unwrap();
        chain.set_gate(true);
        for _ in 0..5 {
            chain.process();
        }
        let mut updated = spec.clone();
        updated.source.frequency_hz = 220.0;
        let EffectSpec::StereoDelay(delay) = &mut updated.effects[0] else {
            panic!("stereo delay")
        };
        delay.feedback = 0.5;
        chain
            .apply(&updated.parameter_snapshot(4).unwrap())
            .unwrap();
        chain.set_gate(false);
        let tail: Vec<_> = (0..16).map(|_| chain.process()).collect();
        assert!(tail.iter().any(|frame| frame.left.abs() > 0.0));
        assert_eq!(tail[15], StereoFrame::default());
    }
}
