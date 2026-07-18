use super::modulation::{ModParameters, ModulationBank, PatchModParameters};
use super::saturator::{PreparedSaturator, SaturatorParameters};
use super::stereo_delay::{PreparedStereoDelay, StereoDelayParameters};
use super::synth_v2::{PreparedSynthV2, SynthV2Parameters};
use crate::dsp::frame::StereoFrame;
use crate::dsp::safety::sanitize;
use crate::patch::{
    DeviceKind, DeviceSpec, PatchError, PatchSpec, RouteIdentity, StructuralSignature,
};
use arrayvec::ArrayVec;

#[derive(Clone, Copy, Debug)]
pub(crate) enum ProcessorParameters {
    Saturator(SaturatorParameters),
    StereoDelay(StereoDelayParameters),
}
impl ProcessorParameters {
    fn kind(self) -> DeviceKind {
        match self {
            Self::Saturator(_) => DeviceKind::Saturator,
            Self::StereoDelay(_) => DeviceKind::StereoDelay,
        }
    }
}
#[derive(Clone, Debug)]
pub(crate) struct ParameterSnapshot {
    pub(crate) generation: u64,
    pub(crate) signature: StructuralSignature,
    pub(crate) source: SynthV2Parameters,
    pub(crate) processors: ArrayVec<ProcessorParameters, 7>,
    pub(crate) patch_modulators: PatchModParameters,
}

enum Device {
    Saturator(PreparedSaturator),
    StereoDelay(PreparedStereoDelay),
}
pub(crate) struct PreparedChain {
    signature: StructuralSignature,
    source: Box<PreparedSynthV2>,
    modulators: ModulationBank,
    processors: Vec<Device>,
    frame_index: u64,
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
        let source_params = source_parameters(spec)?;
        let source =
            Box::new(PreparedSynthV2::new(source_params, sample_rate).map_err(PatchError::new)?);
        let signature = spec.structural_signature();
        let mut processors = Vec::new();
        processors
            .try_reserve_exact(spec.devices.len() - 1)
            .map_err(|_| PatchError::new("processor allocation failed"))?;
        for d in &spec.devices[1..] {
            processors.push(match d {
                DeviceSpec::Saturator(s) => {
                    Device::Saturator(PreparedSaturator::new(s.into(), sample_rate))
                }
                DeviceSpec::StereoDelay(s) => Device::StereoDelay(
                    PreparedStereoDelay::new(s.into(), sample_rate).map_err(PatchError::new)?,
                ),
                DeviceSpec::SubtractiveSynthV2(_) => {
                    return Err(PatchError::new("unexpected source"))
                }
            });
        }
        let patch_modulators = PatchModParameters::from_specs(
            spec.tempo_bpm,
            &spec.modulators,
            &spec.modulation_routes,
        );
        Ok(Self {
            signature,
            source,
            modulators: ModulationBank::new(patch_modulators, sample_rate),
            processors,
            frame_index: 0,
            gate: false,
            #[cfg(test)]
            drop_probe: None,
        })
    }
    pub(crate) fn set_gate(&mut self, gate: bool) {
        self.gate = gate;
        self.modulators.set_gate(gate);
        self.source.set_gate(gate);
    }
    pub(crate) fn process(&mut self) -> StereoFrame {
        let control = self.modulators.process();
        let mut signal = self.source.process(control);
        for d in &mut self.processors {
            signal.insert = match d {
                Device::Saturator(x) => x.process(signal.insert),
                Device::StereoDelay(x) => x.process(signal.insert),
            }
        }
        self.frame_index = self.frame_index.wrapping_add(1);
        sanitize(StereoFrame {
            left: signal.insert.left + signal.direct.left,
            right: signal.insert.right + signal.direct.right,
        })
    }
    pub(crate) fn apply(&mut self, s: &ParameterSnapshot) -> Result<(), &'static str> {
        if s.signature != self.signature
            || s.processors.len() != self.processors.len()
            || !payload_matches_signature(
                &s.signature,
                s.source,
                &s.patch_modulators,
                &s.processors,
            )
        {
            return Err("parameter snapshot topology mismatch");
        }
        for (device, parameters) in self.processors.iter().zip(s.processors.iter().copied()) {
            match (device, parameters) {
                (Device::Saturator(_), ProcessorParameters::Saturator(_))
                | (Device::StereoDelay(_), ProcessorParameters::StereoDelay(_)) => {}
                _ => return Err("parameter snapshot processor mismatch"),
            }
        }
        self.source.update(s.source);
        self.modulators.update(s.patch_modulators);
        for (d, p) in self.processors.iter_mut().zip(s.processors.iter().copied()) {
            match (d, p) {
                (Device::Saturator(x), ProcessorParameters::Saturator(p)) => x.update(p),
                (Device::StereoDelay(x), ProcessorParameters::StereoDelay(p)) => x.update(p),
                _ => unreachable!(),
            }
        }
        Ok(())
    }
    #[cfg(test)]
    pub(crate) fn set_drop_probe(&mut self, probe: DropProbe) {
        self.drop_probe = Some(probe)
    }
}
fn payload_matches_signature(
    signature: &StructuralSignature,
    source: SynthV2Parameters,
    modulators: &PatchModParameters,
    processors: &ArrayVec<ProcessorParameters, 7>,
) -> bool {
    if usize::from(signature.device_count) != processors.len() + 1
        || signature.modulator_count != modulators.count
        || signature.route_count != modulators.route_count
    {
        return false;
    }
    let source_matches = signature.devices[0].kind == DeviceKind::SubtractiveSynthV2
        && signature.oscillator_count == source.oscillator_count
        && signature.pm.present == source.pm.present
        && signature.pm.source == source.pm.source
        && signature.pm.target == source.pm.target
        && signature.pm.latency_frames == if source.pm.present { 48 } else { 0 };
    if !source_matches {
        return false;
    }
    for index in 0..usize::from(signature.modulator_count) {
        let kind = match modulators.modulators[index] {
            ModParameters::Lfo { .. } => 1,
            ModParameters::Envelope { .. } => 2,
            ModParameters::Empty => return false,
        };
        if signature.modulators[index].kind != kind {
            return false;
        }
    }
    for index in 0..usize::from(signature.route_count) {
        let route = modulators.routes[index];
        if signature.routes[index] != RouteIdentity::from_parts(route.source, route.target) {
            return false;
        }
    }
    processors
        .iter()
        .copied()
        .enumerate()
        .all(|(index, parameters)| signature.devices[index + 1].kind == parameters.kind())
}

fn source_parameters(spec: &PatchSpec) -> Result<SynthV2Parameters, PatchError> {
    match spec.devices.first() {
        Some(DeviceSpec::SubtractiveSynthV2(s)) => Ok(SynthV2Parameters::from_spec(s)),
        _ => Err(PatchError::new("first device must be synth")),
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
        let mut processors = ArrayVec::new();
        for d in &self.devices[1..] {
            let p = match d {
                DeviceSpec::Saturator(x) => ProcessorParameters::Saturator(x.into()),
                DeviceSpec::StereoDelay(x) => ProcessorParameters::StereoDelay(x.into()),
                _ => return Err(PatchError::new("unexpected source")),
            };
            processors
                .try_push(p)
                .map_err(|_| PatchError::new("processor image exceeds fixed capacity"))?;
        }
        Ok(ParameterSnapshot {
            generation,
            signature: self.structural_signature(),
            source: source_parameters(self)?,
            processors,
            patch_modulators: PatchModParameters::from_specs(
                self.tempo_bpm,
                &self.modulators,
                &self.modulation_routes,
            ),
        })
    }
}

const _: () = {
    assert!(std::mem::size_of::<ParameterSnapshot>() <= 2048);
};
#[cfg(test)]
mod tests {
    use super::*;
    use crate::patch::{parse_patch, RouteTarget, SaturatorSpec};

    fn minimal() -> PatchSpec {
        parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/minimal.json"
        )))
        .unwrap()
    }

    fn composable() -> PatchSpec {
        parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/composable.json"
        )))
        .unwrap()
    }

    fn assert_rejected_without_mutation(spec: &PatchSpec, snapshot: ParameterSnapshot) {
        let mut candidate = spec.prepare_chain(4_000.0).unwrap();
        let mut control = spec.prepare_chain(4_000.0).unwrap();
        candidate.set_gate(true);
        control.set_gate(true);
        for _ in 0..31 {
            assert_eq!(candidate.process(), control.process());
        }
        assert!(candidate.apply(&snapshot).is_err());
        for _ in 0..31 {
            assert_eq!(candidate.process(), control.process());
        }
    }

    fn route_source(spec: &mut PatchSpec, insert: f32, direct: f32) {
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut spec.devices[0] else {
            panic!("synth source")
        };
        synth.oscillators[0].sends = crate::patch::SendsSpec {
            filter: 0.0,
            insert,
            direct,
        };
        synth.filter.insert_send = 0.0;
        synth.filter.direct_send = 0.0;
    }

    fn render(spec: PatchSpec, frames: usize) -> Vec<StereoFrame> {
        let mut chain = spec.prepare_chain(4_000.0).unwrap();
        chain.set_gate(true);
        (0..frames).map(|_| chain.process()).collect()
    }

    #[test]
    fn snapshot_budget() {
        assert!(std::mem::size_of::<ParameterSnapshot>() <= 2048);
    }
    #[test]
    fn direct_bypasses_processors_but_insert_does_not() {
        let mut direct = minimal();
        route_source(&mut direct, 0.0, 1.0);
        let direct_control = render(direct.clone(), 64);
        direct.devices.push(DeviceSpec::Saturator(SaturatorSpec {
            id: "drive".to_owned(),
            enabled: true,
            drive_db: 36.0,
            output_gain_db: 0.0,
            mix: 1.0,
        }));
        assert_eq!(render(direct, 64), direct_control);

        let mut insert = minimal();
        route_source(&mut insert, 1.0, 0.0);
        let insert_control = render(insert.clone(), 64);
        insert.devices.push(DeviceSpec::Saturator(SaturatorSpec {
            id: "drive".to_owned(),
            enabled: true,
            drive_db: 36.0,
            output_gain_db: 0.0,
            mix: 1.0,
        }));
        assert_ne!(render(insert, 64), insert_control);
    }

    #[test]
    fn complete_identity_mismatches_reject_before_mutation() {
        let base = minimal();

        let mut renamed_device = base.clone();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut renamed_device.devices[0] else {
            panic!("synth source")
        };
        synth.id = "renamedVoice".to_owned();
        assert_rejected_without_mutation(&base, renamed_device.parameter_snapshot(1).unwrap());

        let mut renamed_oscillator = base.clone();
        let DeviceSpec::SubtractiveSynthV2(synth) = &mut renamed_oscillator.devices[0] else {
            panic!("synth source")
        };
        synth.oscillators[0].id = "renamedOsc".to_owned();
        assert_rejected_without_mutation(&base, renamed_oscillator.parameter_snapshot(2).unwrap());

        let modulated = composable();
        let mut renamed_modulator = modulated.clone();
        match &mut renamed_modulator.modulators[0] {
            crate::patch::ModulatorSpec::Lfo { id, .. }
            | crate::patch::ModulatorSpec::Envelope { id, .. } => *id = "renamedMod".to_owned(),
        }
        assert_rejected_without_mutation(
            &modulated,
            renamed_modulator.parameter_snapshot(3).unwrap(),
        );
    }

    #[test]
    fn duplicated_parameter_topology_fields_are_preflighted() {
        let base = minimal();
        let mut oscillator_count = base.parameter_snapshot(4).unwrap();
        oscillator_count.source.oscillator_count = 2;
        assert_rejected_without_mutation(&base, oscillator_count);

        let modulated = composable();
        let mut route_count = modulated.parameter_snapshot(5).unwrap();
        route_count.patch_modulators.route_count -= 1;
        assert_rejected_without_mutation(&modulated, route_count);

        let mut route_target = modulated.parameter_snapshot(6).unwrap();
        route_target.patch_modulators.routes[0].target = RouteTarget::SourceGain;
        assert_rejected_without_mutation(&modulated, route_target);

        let mut pm_target = modulated.parameter_snapshot(7).unwrap();
        pm_target.source.pm.target = pm_target.source.pm.source;
        assert_rejected_without_mutation(&modulated, pm_target);
    }

    #[test]
    fn identical_snapshot_preserves_all_source_state() {
        let spec = minimal();
        let mut candidate = spec.prepare_chain(4_000.0).unwrap();
        let mut control = spec.prepare_chain(4_000.0).unwrap();
        candidate.set_gate(true);
        control.set_gate(true);
        for _ in 0..17 {
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
    fn pm_preparation_obeys_internal_rate_ceiling() {
        let spec = parse_patch(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/patches/valid/composable.json"
        )))
        .unwrap();
        assert!(spec.prepare_chain(192_000.0).is_ok());
        assert!(spec.prepare_chain(192_001.0).is_err());
    }
}
